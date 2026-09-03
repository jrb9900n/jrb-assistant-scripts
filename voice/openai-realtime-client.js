// voice/openai-realtime-client.js — one OpenAI Realtime API session per call.
//
// Audio format: configured for 24kHz mono PCM on both input and output,
// matching ACS Call Automation's Pcm24KMono media-streaming format exactly
// (see acs-call-handler.js) -- no resampling/transcoding needed, just
// re-wrapping the same base64 payload between ACS's and OpenAI's JSON
// envelopes. See attachAcsMediaSocket() in acs-call-handler.js for the
// defensive sample-rate check on the ACS side of that assumption.
//
// PIN gate: the session starts with NO `tools` key in session.update at all
// -- the model has no vocabulary for calendar/email actions until the
// caller's spoken PIN matches (call-auth.js's matchSpokenPin). Once matched,
// a second session.update swaps in the full system prompt plus the curated
// tool schema. This mirrors this repo's existing TOOL_MAP.employee pattern
// of restricting by omission rather than by instruction alone.
import WebSocket from 'ws';
import { logger } from '../core/logger.js';
import { matchSpokenPin } from './call-auth.js';
import { buildVoiceToolSchema, handleVoiceToolCall } from './tool-bridge.js';
import { loadRecentCallContext } from './call-memory.js';
import { buildContextBlock } from '../tools/impl/feedback.js';

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-realtime';
const PIN_MAX_ATTEMPTS = 3;
const VOICE = 'alloy';

// How long a tool call is allowed to run silently before the assistant says
// something -- see scheduleFillerIfSlow() below. Built in response to
// real feedback (2026-09-02): the assistant goes fully silent on a slow
// tool call (e.g. a wide SA client search, a FleetSharp fetch) with zero
// acknowledgment, which reads as a dead line rather than "still working on
// it." Two tiers so a call that's taking unusually long gets a distinct,
// apologetic second filler rather than repeating the first one verbatim.
const FILLER_FIRST_MS = 1200;
const FILLER_SECOND_MS = 5000;
const FILLER_PHRASES_FIRST = [
  'One moment, let me check that.',
  'Give me just a second.',
  'Okay, let me pull that up.',
];
const FILLER_PHRASES_SECOND = [
  'Sorry, still working on that -- just a few more seconds.',
  "This one's taking a bit longer than usual, bear with me.",
  'Almost there, thanks for your patience.',
];

const PIN_GATE_PROMPT = `You are JRB's executive assistant, answering a live phone call.
Before discussing anything else, greet the caller briefly and ask them to say their PIN.
Do not discuss calendar or email content, and do not attempt any action, until told the PIN was accepted.
If a spoken PIN attempt is wrong, ask them to repeat it -- do not guess or make one up.`;

const VOICE_SYSTEM_PROMPT = `You are JRB's executive assistant (for Michael Reardon, J.R. Boehlke LLC),
speaking with Michael live on the phone. Be concise and conversational -- this is a live voice call,
not a chat window, so keep responses short and natural to say out loud. You can read/update Michael's
calendar, book real meetings, resolve block-schedule conflicts, read/search/triage/draft his email,
look up, dispatch, and create SA (ServiceAutopilot) clients/estimates/jobs and manage their billing
defaults and tags, read the crew/FieldOps scheduling board, look up FleetOps vehicle locations and
mileage, query QuickBooks, pull Google Ads performance, search SharePoint, and -- same as Teams and
Claude Code -- read/write code and scripts on this machine, commit and push to GitHub, open and merge
Pull Requests, and manage Vercel deployments, using the tools available to you. Always check the
calendar before claiming a time is free or busy. Email drafts you create are always placed in
Michael's own mailbox, not the assistant's, so he can review and send them himself.

Before calling a tool that creates, books, or changes something real -- a calendar invite, a new SA
client/estimate/job, a billing or tag change, dispatching a job, running a script, writing or pushing
code, opening or merging a Pull Request, or touching a Vercel deployment -- read back the key details
(name, date/time, amount, client, file/branch/repo, what a script or deploy will actually do) and get
a clear yes from Michael first. This matters even more for code/infra actions than business ones --
they're harder to casually undo. Phone audio is also more error-prone to transcribe than typed text,
so a misheard name or date is more likely here than in a text channel; confirming out loud costs one
sentence and avoids acting on a mistake. Plain lookups/reads don't need this. If asked to do something
outside your available tools, say so plainly rather than pretending to have done it.`;

function audioSessionConfig(instructions, tools) {
  const session = {
    type: 'realtime',
    model: 'gpt-realtime',
    output_modalities: ['audio'],
    instructions,
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24000 },
        // Untuned server_vad (bare defaults: threshold 0.5, prefix_padding_ms
        // 300, silence_duration_ms 500) proved far too sensitive on a real
        // phone line -- confirmed live 2026-08-26: every evening call that
        // day logged dozens of "skipping tool calls from a non-completed
        // response" (status cancelled/failed) back-to-back, the assistant's
        // spoken responses barely ever finishing, while the one earlier
        // quieter-environment call that day was fine. Raised threshold
        // (less sensitive to line noise/low-level sound) and
        // silence_duration_ms (requires a longer pause before treating it as
        // end-of-turn, so a brief cough/road noise doesn't trigger a
        // false turn-end mid-response) without disabling barge-in entirely --
        // Michael still needs to be able to interrupt for a real phone-call
        // feel.
        turn_detection: { type: 'server_vad', threshold: 0.6, prefix_padding_ms: 300, silence_duration_ms: 650 },
        // Input transcription is opt-in -- without this, the caller's speech
        // is never transcribed at all, and handleTranscript() below (the
        // entire PIN gate) would never fire on a real call.
        transcription: { model: 'gpt-4o-mini-transcribe' },
      },
      output: { format: { type: 'audio/pcm', rate: 24000 }, voice: VOICE },
    },
  };
  if (tools) session.tools = tools;
  return session;
}

// Centralizes every response.create send so session.responseActive stays
// accurate -- scheduleFillerIfSlow() below relies on it to avoid firing a
// filler on top of an already-active response (the Realtime API is expected
// to reject overlapping responses on one conversation).
function createResponse(ws, session, response) {
  session.responseActive = true;
  const payload = { type: 'response.create' };
  if (response) payload.response = response;
  ws.send(JSON.stringify(payload));
}

// Speaks a short, contextless acknowledgment if a tool call is still
// pending past FILLER_FIRST_MS, and a distinct apologetic one past
// FILLER_SECOND_MS -- see the constants' own comment above for why. Skips
// silently (rather than forcing the filler through) if a response is
// already active when a timer fires, since the two are not expected to be
// safely combinable. Not yet verified against a real call -- if OpenAI's
// Realtime API rejects a response.create sent this soon after the previous
// response.done (e.g. some minimum turnaround requirement), the timer's
// `ws.send` would still fire but produce a logged 'error' event rather than
// audio; the real tool-call flow below is unaffected either way since it
// doesn't wait on these fillers.
function scheduleFillerIfSlow(ws, session, callId) {
  let settled = false;
  const timers = [
    setTimeout(() => {
      if (settled || session.responseActive) return;
      const phrase = FILLER_PHRASES_FIRST[Math.floor(Math.random() * FILLER_PHRASES_FIRST.length)];
      logger.info('Voice bridge: slow tool call, sending first filler', { callId });
      createResponse(ws, session, { instructions: `Say exactly, naturally: "${phrase}" -- nothing else.` });
    }, FILLER_FIRST_MS),
    setTimeout(() => {
      if (settled || session.responseActive) return;
      const phrase = FILLER_PHRASES_SECOND[Math.floor(Math.random() * FILLER_PHRASES_SECOND.length)];
      logger.info('Voice bridge: slow tool call, sending second filler', { callId });
      createResponse(ws, session, { instructions: `Say exactly, naturally: "${phrase}" -- nothing else.` });
    }, FILLER_SECOND_MS),
  ];
  return () => {
    settled = true;
    timers.forEach(clearTimeout);
  };
}

/**
 * @param {object} opts
 * @param {object} opts.session - the call's session-state.js record (mutated in place:
 *   sets .openaiWs, reads/writes .authState/.pinAttempts/.pinDeadline)
 * @param {function} opts.hangUp - async () => void, called to end the call (PIN exhausted)
 */
export async function connectRealtimeSession({ session, hangUp }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set -- cannot start a voice session.');

  const ws = new WebSocket(REALTIME_URL, { headers: { Authorization: `Bearer ${apiKey}` } });

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  // session.authState can already be 'verified' at connect time -- see
  // call-auth.js's isTrustedNoPinCallerId()/acs-call-handler.js, which skips
  // the PIN challenge entirely for one specific caller ID. Everyone else
  // starts at 'awaiting_pin' as before.
  //
  // Either way, the FIRST session.update is sent synchronously (no await)
  // so the greeting-triggering createResponse below never sits behind a
  // network call. unlockVerifiedSession() awaits Supabase (recent context +
  // rules) before it can attach tools -- caught by /code-review: awaiting it
  // here first would leave the trusted caller listening to dead air for
  // however long that query takes, right at connect time, the same "reads
  // as a dead line" problem FILLER_FIRST_MS exists to solve for mid-call
  // tool latency, just with no equivalent mitigation at session start. So a
  // trusted caller gets a plain, immediate greeting on the bare system
  // prompt (no tools yet), and unlockVerifiedSession() runs after,
  // swapping in the full instructions + tools a moment later -- well before
  // the caller could plausibly ask for anything tool-shaped.
  if (session.authState === 'verified') {
    // Unlike VOICE_SYSTEM_PROMPT's normal use (a follow-up session.update
    // after PIN match, applied mid-conversation), this is the very first
    // thing the model sees this call -- VOICE_SYSTEM_PROMPT alone has no
    // "open with a greeting" instruction the way PIN_GATE_PROMPT does, so
    // one is appended here specifically for this first turn. Found via
    // /code-review.
    ws.send(JSON.stringify({
      type: 'session.update',
      session: audioSessionConfig(`${VOICE_SYSTEM_PROMPT}\n\nThis is the start of the call -- greet the caller now, briefly and naturally. Your tools are still loading in for a moment -- if asked to do something specific before that finishes, say "just a second, still getting set up" rather than claiming you can't do it.`, null),
    }));
  } else {
    ws.send(JSON.stringify({ type: 'session.update', session: audioSessionConfig(PIN_GATE_PROMPT, null) }));
  }

  // unlockVerifiedSession() swaps in the full instructions + tools for a
  // trusted caller, but must not run while the greeting response above is
  // still being generated -- found via /code-review: OpenAI's Realtime API
  // has no documented guarantee about a session.update landing cleanly
  // mid-generation, and the PIN-match path (handleTranscript) never has
  // this problem since it only ever runs after the caller's own utterance
  // already completed its turn. Deferred via session._pendingUnlock,
  // invoked once from the response.done handler below instead of raced in
  // parallel with createResponse().
  if (session.authState === 'verified') {
    session._pendingUnlock = () => runUnlockWithRetry(session, ws);
  }

  // Output only ever happens in response to a turn (VAD-detected end of
  // caller speech) or an explicit response.create -- without this, the
  // model's "greet the caller" instruction would never actually produce
  // audio until the caller spoke first, leaving a silent, confusing line.
  createResponse(ws, session);

  // The `ws.once('error', reject)` registered above for the initial connect
  // race stays attached afterward too (it only unregisters once fired), so
  // a later socket error won't crash the process -- but it silently calls
  // the by-then-inert `reject()` with nothing logged. Add a real listener
  // so a post-connect socket error is at least visible.
  ws.on('error', (err) => {
    logger.error('Voice bridge: OpenAI Realtime socket error', { callId: session.callConnectionId, err: err.message });
  });

  ws.on('message', (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (evt.type === 'response.output_audio.delta' && evt.delta) {
      session.wsToAcs?.sendAudioOut?.(evt.delta);
      return;
    }

    if (evt.type === 'conversation.item.input_audio_transcription.completed') {
      handleTranscript(session, ws, evt.transcript, hangUp);
      return;
    }

    // The model's own spoken-output transcript, for voice/call-memory.js.
    // Named by analogy with response.output_audio.delta (the raw-audio
    // event this file already listens to above) -- output transcription has
    // no separate opt-in the way input transcription does, so this should
    // fire whenever output_modalities includes 'audio', but the exact event
    // name hasn't been confirmed against a real call yet. If it's wrong,
    // this branch just never matches (same silent-no-match fallthrough as
    // any other unrecognized evt.type here) -- assistant-side transcript
    // capture would silently no-op rather than break the call itself.
    if (evt.type === 'response.output_audio_transcript.done' && evt.transcript && session.authState === 'verified') {
      session.transcript?.push({ role: 'assistant', text: evt.transcript, at: new Date().toISOString() });
      return;
    }

    if (evt.type === 'response.done') {
      // Clear before anything else below -- a filler timer racing this
      // event should see the response as no-longer-active as soon as
      // possible, and the function-call handling further down can itself
      // send a new response (the filler-acknowledgment one), which must
      // start from a clean 'not active' state.
      session.responseActive = false;

      // Runs the trusted-caller tool/context unlock deferred from
      // connectRealtimeSession() above, exactly once, only after the opening
      // greeting response has actually finished generating -- never raced
      // against it. Cleared before invoking so a later response.done this
      // same call (e.g. after the caller's first real utterance) can't
      // re-trigger it.
      if (session._pendingUnlock) {
        const runUnlock = session._pendingUnlock;
        session._pendingUnlock = null;
        runUnlock();
      }

      // Per OpenAI's own documented pattern, the function name only
      // reliably appears on the completed response's output items
      // (response.done -> response.output[].name), not on
      // response.function_call_arguments.done -- a response can also
      // contain more than one function_call item, so every matching item
      // is handled, not just the first.
      //
      // A response that was interrupted (barge-in) or otherwise didn't
      // finish cleanly can still emit response.done with a status other
      // than 'completed' -- its output items (including a function_call's
      // `arguments` string) may be truncated mid-generation in that case.
      // Confirmed live: two "malformed tool call arguments" JSON.parse
      // failures during the first real test call, both immediately
      // preceding a successful retry -- consistent with an interrupted
      // response's half-written arguments reaching here. Skipping
      // non-completed responses avoids attempting (and logging a warning
      // for) a tool call that was never going to have valid arguments,
      // rather than relying on the model to notice the error and retry.
      if (evt.response?.status !== 'completed') {
        logger.info('Voice bridge: skipping tool calls from a non-completed response', {
          callId: session.callConnectionId,
          status: evt.response?.status,
        });
        return;
      }

      const items = evt.response?.output ?? [];
      for (const item of items) {
        if (item.type !== 'function_call') continue;
        handleFunctionCall(session, ws, item).catch((err) =>
          logger.error('Voice bridge: unhandled function-call error', { err: err.message })
        );
      }
      return;
    }

    if (evt.type === 'error') {
      logger.error('Voice bridge: OpenAI Realtime session error', { evt });
    }
  });

  ws.on('close', () => {
    if (session) session.openaiClient = null;
  });

  return {
    sendAudioIn: (base64pcm) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64pcm }));
    },
    close: () => ws.close(),
    _ws: ws,
  };
}

// Swaps in the full system prompt + tool schema for a now-trusted session --
// shared by handleTranscript() (PIN matched mid-call) and
// connectRealtimeSession() (caller ID pre-verified at answer time, see
// call-auth.js's isTrustedNoPinCallerId()). Assumes session.authState is
// already 'verified' by the time this is called.
// One retry on failure -- for the trusted no-PIN caller, unlockVerifiedSession
// is the ONLY thing that ever attaches tools this call (there's no later PIN
// match to fall back on), so a transient failure here silently strands the
// most-trusted caller with a tool-less session for the whole call otherwise.
// loadRecentCallContext/buildContextBlock already swallow their own errors
// into '' -- a rejection here means the trailing ws.send itself threw
// (e.g. socket already closing), which a brief retry can plausibly recover
// from; a second failure is logged and left alone rather than looping.
async function runUnlockWithRetry(session, ws) {
  try {
    await unlockVerifiedSession(session, ws);
  } catch (err) {
    logger.warn('Voice bridge: unlockVerifiedSession failed for trusted caller, retrying once', { callId: session.callConnectionId, err: err.message });
    try {
      await unlockVerifiedSession(session, ws);
    } catch (err2) {
      logger.error('Voice bridge: unlockVerifiedSession failed twice for trusted caller, tools not attached this call', { callId: session.callConnectionId, err: err2.message });
    }
  }
}

async function unlockVerifiedSession(session, ws) {
  // Recent call/Teams history (memory.js's shared agent_memory, via
  // call-memory.js) so a call picks up where the last conversation left
  // off instead of starting from zero every time. Awaited before the
  // session.update so it's part of the model's instructions from its very
  // first response, not raced in afterward.
  //
  // buildContextBlock('voice') pulls the same standing-rules mechanism
  // Teams already uses (tools/impl/feedback.js) -- added 2026-09-02.
  // Before this, voice-call-review.js's synthesized rules (agent: 'voice')
  // had nowhere to actually take effect: this channel built its system
  // prompt from VOICE_SYSTEM_PROMPT + recentContext only, never touching
  // the `rules` table at all. getRulesForAgent('voice') also picks up any
  // row tagged 'general'/'all', so a correction given on Teams can shape
  // voice behavior too, same as the reverse already worked via
  // loadRecentCallContext's shared agent_memory.
  const [recentContext, rulesContext] = await Promise.all([
    loadRecentCallContext().catch((err) => {
      logger.warn('Voice bridge: loadRecentCallContext failed, continuing without it', { callId: session.callConnectionId, err: err.message });
      return '';
    }),
    buildContextBlock('voice').catch((err) => {
      logger.warn('Voice bridge: buildContextBlock failed, continuing without it', { callId: session.callConnectionId, err: err.message });
      return '';
    }),
  ]);
  const instructions = `${VOICE_SYSTEM_PROMPT}${rulesContext}${recentContext ? `\n\n${recentContext}` : ''}`;
  ws.send(JSON.stringify({
    type: 'session.update',
    session: audioSessionConfig(instructions, buildVoiceToolSchema()),
  }));
}

async function handleTranscript(session, ws, transcript, hangUp) {
  // Once verified, every subsequent transcribed caller utterance is a real
  // conversation turn for voice/call-memory.js, not a PIN attempt -- record
  // it and stop (the PIN logic below never runs again this call). Nothing
  // reaches here pre-verification except spoken PIN attempts, which are
  // deliberately never pushed to session.transcript (see session-state.js).
  if (session.authState === 'verified') {
    session.transcript?.push({ role: 'caller', text: transcript, at: new Date().toISOString() });
    return;
  }

  if (session.authState !== 'awaiting_pin') return;

  if (Date.now() > session.pinDeadline) {
    logger.warn('Voice bridge: PIN challenge timed out, hanging up', { callId: session.callConnectionId });
    hangUp?.();
    return;
  }

  const storedPin = process.env.VOICE_CALL_PIN;
  if (matchSpokenPin(transcript, storedPin)) {
    session.authState = 'verified';
    await unlockVerifiedSession(session, ws);
    logger.info('Voice bridge: caller PIN verified', { callId: session.callConnectionId });
    return;
  }

  session.pinAttempts += 1;
  if (session.pinAttempts >= PIN_MAX_ATTEMPTS) {
    logger.warn('Voice bridge: PIN attempts exhausted, hanging up', { callId: session.callConnectionId });
    hangUp?.();
  }
}

async function handleFunctionCall(session, ws, evt) {
  // Belt-and-suspenders: tools are never attached to the session until
  // authState flips to 'verified' (see handleTranscript above), but a
  // function-call event arriving pre-verification would mean that
  // invariant broke somewhere -- refuse rather than silently execute.
  if (session.authState !== 'verified') {
    logger.warn('Voice bridge: function call received before PIN verification, refusing', {
      callId: session.callConnectionId,
      name: evt.name,
    });
    ws.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: evt.call_id, output: JSON.stringify({ error: 'Not authorized yet.' }) },
    }));
    createResponse(ws, session);
    return;
  }

  // A caller only reaches 'verified' by matching VOICE_CALL_PIN (call-auth.js)
  // -- that's the whole point of the gate, so a verified voice caller IS
  // Michael. context.sender must match teams/identity.js's resolveSender()
  // shape ({isMichael, aadId, name, email, employeeId}), since dispatcher.js
  // handlers like book_time_with_michael read sender.isMichael directly --
  // a bare string here would make sender.isMichael undefined, misclassifying
  // Michael himself as a non-Michael employee requester.
  const startedAt = Date.now();
  const cancelFillers = scheduleFillerIfSlow(ws, session, session.callConnectionId);
  const result = await handleVoiceToolCall(evt.name, evt.arguments, {
    sender: { isMichael: true, aadId: null, name: 'Michael Reardon', email: 'michael@jrboehlke.com', employeeId: null },
    callId: session.callConnectionId,
    fromNumber: session.fromNumber,
  });
  cancelFillers();

  // For voice-call-review.js -- see that file and the migration adding this
  // column for why raw tool outcomes (not just spoken transcript text) are
  // needed to actually diagnose data-access failures and real latency.
  // evt.arguments is the raw JSON string OpenAI sent; kept as-is (not
  // re-parsed) since handleVoiceToolCall already tolerates malformed JSON
  // and a parse failure here shouldn't be able to break call-logging.
  session.toolCalls?.push({
    name: evt.name,
    args: evt.arguments,
    success: !result?.error,
    error: result?.error ?? null,
    latencyMs: Date.now() - startedAt,
    at: new Date().toISOString(),
  });

  ws.send(JSON.stringify({
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: evt.call_id, output: JSON.stringify(result) },
  }));
  createResponse(ws, session);
}
