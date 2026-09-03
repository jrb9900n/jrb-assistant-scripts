// tools/impl/voice-call-review.js -- reads every voice call log and turns
// what actually happened on real calls into (a) durable behavior changes for
// future calls and (b) a flagged list of real bugs/gaps for a human or dev
// session to fix. Built 2026-09-02 on Michael's explicit request: "I want it
// to learn my habits and approach to solving problems together."
//
// Two distinct outputs, on purpose:
//   1. Per-call structured findings (review_findings column on
//      voice_call_log) -- an audit trail, not itself behavior-changing.
//   2. Cross-call synthesized rules, written into the SAME `rules` table
//      Teams' feedback loop already uses (tools/impl/feedback.js), tagged
//      agent: 'voice'. voice/openai-realtime-client.js now loads these via
//      buildContextBlock('voice') into every call's system prompt -- see
//      that file's 2026-09-02 changes. This is the part that actually
//      "learns": a pattern seen once is noise; a pattern seen repeatedly
//      becomes a standing instruction for every future call.
//
// Deliberately does NOT auto-edit code. A genuine bug (a tool erroring, a
// dropped question caused by a real defect) gets named in the Teams summary
// for a human/dev session to act on -- same posture as every other
// diagnostic cron in this repo (e.g. block-schedule-reconciler.js flagging
// PROTECTED-block conflicts instead of silently resolving them). Silently
// rewriting voice/*.js from a nightly cron with no review is a much larger
// blast radius than adding a line to a prompt, and this repo's own Autonomy
// Rules require a branch + PR + Michael's confirmation for anything that
// touches a live channel -- a cron job can't satisfy that on its own.
import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';
import { sendProactiveMessage } from '../../teams/notify.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const REVIEW_MODEL = 'claude-sonnet-4-6'; // matches core/agent.js's SONNET -- this is judgment-heavy analysis, not a cheap classification task
const MAX_CALLS_PER_RUN = 20; // safety ceiling, same spirit as this repo's other capped batch jobs (e.g. sa_client_classification_incremental's 300/run)

async function callClaude({ system, prompt, maxTokens = 4000 }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: REVIEW_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const result = await response.json();
  const rawText = result.content?.find((b) => b.type === 'text')?.text;
  if (!rawText) throw new Error(`No text in Claude response: ${JSON.stringify(result).slice(0, 500)}`);
  return rawText;
}

function parseJsonLoose(rawText) {
  return JSON.parse(rawText.replace(/```json|```/g, '').trim());
}

// Deterministic (non-LLM) latency signals computed straight from the
// transcript's own per-turn timestamps -- these already exist on every
// verified turn (openai-realtime-client.js's handleTranscript /
// response.output_audio_transcript.done), so no new instrumentation was
// needed to get real gap durations, only tool_calls (added alongside this
// file) for WHY a gap happened.
function computeTurnGaps(transcript) {
  const gaps = [];
  for (let i = 1; i < transcript.length; i++) {
    const prev = transcript[i - 1];
    const cur = transcript[i];
    if (!prev?.at || !cur?.at) continue;
    const ms = new Date(cur.at) - new Date(prev.at);
    if (Number.isFinite(ms) && ms > 0) {
      gaps.push({ fromRole: prev.role, toRole: cur.role, ms, atTurnIndex: i });
    }
  }
  return gaps;
}

const REVIEW_SYSTEM_PROMPT = `You are reviewing a real transcript of a live phone call between Michael Reardon
(owner of J.R. Boehlke LLC) and his AI executive assistant, speaking over Azure Communication Services + OpenAI's
Realtime API. You have the full spoken transcript, per-turn timestamps, computed gaps between turns (in ms), and a
log of every tool the assistant actually called during the call (name, success/error, latency).

Identify concrete, specific issues -- quote or closely paraphrase the actual moment, don't generalize. Categories:
- latency: a gap (see turnGapsMs) that likely felt slow or awkward on a live call, especially any gap over ~3000ms
  with no acknowledgment from the assistant before it.
- expectationSetting: a slow tool call (see toolCalls latencyMs) where the assistant said nothing to acknowledge
  the wait, versus one where it did (or should have) say something like "give me a second."
- communicationStyle: tone, verbosity, or phrasing that reads as unnatural for a spoken phone conversation
  (too long, too formal, too much text-chat style hedging, robotic phrasing).
- dataAccess: a toolCalls entry with success:false, or a place in the transcript where the assistant claimed not
  to have access to something, timed out, or gave a vague/evasive answer where a tool should have gotten a real one.
- droppedOrUnansweredQuestions: something Michael asked that the assistant never actually answered, moved past
  without addressing, or answered only partially.
- michaelPreferences: anything this call reveals about HOW Michael likes to work through things -- his pacing,
  how many items he's comfortable being given at once (e.g. "how many emails can be asked about in one go"), whether
  he wants options vs. a single recommendation, how he likes confirmations phrased, what order he wants information
  in, or any other pattern in how he approaches solving a problem with the assistant. This is the most important
  category for the assistant to actually learn from over time -- be specific about what happened, not generic.

Return ONLY a JSON object, no preamble, no markdown fences:
{
  "issues": [
    { "category": "latency|expectationSetting|communicationStyle|dataAccess|droppedOrUnansweredQuestions|michaelPreferences",
      "description": "specific, concrete description of what happened and why it matters",
      "evidence": "the relevant quote(s) or turn/tool reference",
      "isBug": true|false,
      "suggestedFix": "for isBug:true, a short note on what's actually broken in the code/config; for isBug:false, omit or leave empty" }
  ],
  "overallSeverity": "none|minor|moderate|significant"
}
If nothing notable happened in a category, don't include an issue for it -- an empty or short issues array on an
unremarkable call is the correct, honest output, not a failure to find something.`;

/**
 * Analyzes every not-yet-reviewed call (oldest first, capped at
 * MAX_CALLS_PER_RUN so one run can't run away on a large backfill) and
 * writes each call's structured findings back onto its own row.
 * @param {object} [opts]
 * @param {number} [opts.limit]
 */
export async function reviewUnprocessedCalls({ limit = MAX_CALLS_PER_RUN } = {}) {
  const { data: calls, error } = await supabase
    .from('voice_call_log')
    .select('id, call_connection_id, started_at, ended_at, transcript, tool_calls')
    .is('reviewed_at', null)
    .order('started_at', { ascending: true })
    .limit(limit);

  if (error) throw new Error(`voice_call_log read failed: ${error.message}`);
  if (!calls?.length) return { reviewed: 0, results: [] };

  const results = [];
  for (const call of calls) {
    try {
      const turnGapsMs = computeTurnGaps(call.transcript || []);
      const rawText = await callClaude({
        system: REVIEW_SYSTEM_PROMPT,
        prompt: JSON.stringify({
          callConnectionId: call.call_connection_id,
          startedAt: call.started_at,
          endedAt: call.ended_at,
          transcript: call.transcript,
          turnGapsMs,
          toolCalls: call.tool_calls,
        }),
      });
      const findings = parseJsonLoose(rawText);

      const { error: updateErr } = await supabase
        .from('voice_call_log')
        .update({ reviewed_at: new Date().toISOString(), review_findings: findings })
        .eq('id', call.id);
      if (updateErr) logger.warn('[voice-call-review] failed to save findings', { id: call.id, err: updateErr.message });

      results.push({ id: call.id, callConnectionId: call.call_connection_id, findings });
    } catch (err) {
      // One bad call (malformed JSON back from Claude, a transient API
      // error) shouldn't stop the whole batch -- mark it reviewed anyway
      // with a note, so a persistently-failing call doesn't get retried
      // forever and starve out real, reviewable calls behind it in the
      // oldest-first queue.
      logger.warn('[voice-call-review] call review failed', { id: call.id, err: err.message });
      await supabase
        .from('voice_call_log')
        .update({ reviewed_at: new Date().toISOString(), review_findings: { error: err.message } })
        .eq('id', call.id);
    }
  }

  return { reviewed: results.length, results };
}

const SYNTHESIS_SYSTEM_PROMPT = `You are synthesizing per-call review findings from multiple recent phone calls into a
short list of durable, standing instructions for the AI assistant's voice-channel system prompt. You will be given an
array of per-call findings (each already categorized: latency, expectationSetting, communicationStyle, dataAccess,
droppedOrUnansweredQuestions, michaelPreferences).

Only propose a rule for something that appears as a genuine PATTERN -- the same or a closely related issue showing up
in 2 or more separate calls, or one single call so clear-cut it obviously generalizes (e.g. an explicit, stated
preference like "don't list more than 3 things at once"). A one-off oddity in a single call is noise, not a pattern
-- do not write a rule for it. Prefer specificity: "when listing emails to review, offer at most 3 at a time and ask
before continuing" beats "be more concise."

Write each rule as a plain second-person instruction the assistant should follow on future calls, as if it were a
correction Michael gave directly. Do not restate bugs (isBug:true items) as rules -- those need a code fix, not a
prompt instruction; list them separately under codeIssues instead, deduplicated by root cause.

Return ONLY a JSON object, no preamble, no markdown fences:
{
  "rules": [ "plain instruction text, no more than ~2 sentences" ],
  "codeIssues": [ { "description": "what's broken", "seenInCalls": <count>, "suggestedFix": "short note" } ]
}
Both arrays may be empty -- an empty result on a small/quiet batch of calls is correct, not a failure.`;

/**
 * Pulls the most recently reviewed calls' findings and synthesizes durable
 * patterns into the `rules` table (agent: 'voice') plus a short list of real
 * code-level issues for a human/dev session -- see this file's header for
 * why code fixes are deliberately not auto-applied here.
 * @param {object} [opts]
 * @param {number} [opts.lookback] - how many recently-reviewed calls to consider
 */
export async function synthesizeVoiceCallLearnings({ lookback = 50 } = {}) {
  const { data: calls, error } = await supabase
    .from('voice_call_log')
    .select('id, call_connection_id, review_findings')
    .not('reviewed_at', 'is', null)
    .order('started_at', { ascending: false })
    .limit(lookback);

  if (error) throw new Error(`voice_call_log read failed: ${error.message}`);
  const withFindings = (calls || []).filter((c) => c.review_findings?.issues?.length);
  if (!withFindings.length) return { rulesWritten: 0, codeIssues: [] };

  const rawText = await callClaude({
    system: SYNTHESIS_SYSTEM_PROMPT,
    prompt: JSON.stringify(
      withFindings.map((c) => ({ callConnectionId: c.call_connection_id, issues: c.review_findings.issues }))
    ),
    maxTokens: 3000,
  });
  const synthesis = parseJsonLoose(rawText);

  let rulesWritten = 0;
  for (const rule of synthesis.rules || []) {
    const { error: insertErr } = await supabase.from('rules').insert({
      agent: 'voice',
      rule,
      source: 'voice_call_review',
    });
    if (insertErr) logger.warn('[voice-call-review] rule insert failed', { rule, err: insertErr.message });
    else rulesWritten++;
  }

  return { rulesWritten, codeIssues: synthesis.codeIssues || [], callsConsidered: withFindings.length };
}

function formatTeamsSummary({ reviewed, rulesWritten, codeIssues, callsConsidered }) {
  const lines = [`**Voice call quality review**`, `Reviewed ${reviewed} new call(s), synthesized from ${callsConsidered ?? 0} recent reviewed call(s).`];
  if (rulesWritten > 0) {
    lines.push(`\n${rulesWritten} new standing rule(s) added for the voice channel (see the \`rules\` table, agent: 'voice').`);
  } else {
    lines.push('\nNo new durable behavior patterns found this run.');
  }
  if (codeIssues?.length) {
    lines.push(`\n**Flagged for a dev session (not auto-fixed):**`);
    codeIssues.forEach((c) => lines.push(`- ${c.description} (seen in ${c.seenInCalls ?? '?'} call(s)) -- ${c.suggestedFix || 'no suggested fix given'}`));
  }
  return lines.join('\n');
}

/**
 * Entry point for both the per-call trigger (voice/acs-call-handler.js, right
 * after a call ends) and the weekly cron backstop (scheduler/cron.js) --
 * review new calls, synthesize learnings across recent history, notify
 * Michael with what changed and what still needs a human/dev look.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.perCall] - true when called right after a single
 *   call ends rather than on the weekly schedule. Changes notification
 *   behavior only, not what gets reviewed/synthesized: a Teams message after
 *   EVERY call, even an unremarkable one, would be exactly the kind of
 *   notification spam this repo's other crons deliberately avoid (see
 *   calendar_change_watch's alert-once convention) -- Michael can place
 *   several calls a day, so per-call mode only notifies when something
 *   concrete actually surfaced (a new rule or a flagged code issue). The
 *   weekly run keeps sending a summary either way, same as any other
 *   scheduled report, since "reviewed N calls, nothing new" once a week is
 *   expected signal, not noise.
 */
export async function runVoiceCallQualityReview({ perCall = false } = {}) {
  const { reviewed, results } = await reviewUnprocessedCalls();
  if (reviewed === 0) {
    logger.info('[voice-call-review] no unreviewed calls');
    return { reviewed: 0, rulesWritten: 0 };
  }

  const { rulesWritten, codeIssues, callsConsidered } = await synthesizeVoiceCallLearnings();

  logger.info('[voice-call-review] run complete', { reviewed, rulesWritten, codeIssueCount: codeIssues.length, perCall });

  const hasSomethingToReport = rulesWritten > 0 || codeIssues?.length > 0;
  if (!perCall || hasSomethingToReport) {
    await sendProactiveMessage(formatTeamsSummary({ reviewed, rulesWritten, codeIssues, callsConsidered }), {
      target: 'michael',
    }).catch((err) => logger.warn('[voice-call-review] Teams notify failed', { err: err.message }));
  }

  return { reviewed, rulesWritten, codeIssues, results };
}
