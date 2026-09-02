// tools/impl/privacy-gate.js — the employee-request approval state machine.
//
// Built 2026-08-24. Michael's explicit standing rule: his inbox/personal/
// business data is only ever shared with him. Anything a non-Michael Teams
// requester asks — beyond genuinely generic info — must be declined vaguely
// to them and escalated to Michael for a case-by-case yes/no. This is the
// "soft judgment" layer of the two-layer design (see teams/identity.js and
// tools/registry.js's TOOL_MAP.employee for the "hard" structural layer —
// the employee taskType's tool list simply never includes anything that can
// return Michael's raw mailbox/calendar/business data, so this file's logic
// is the ONLY path through which an employee request can ever get answered
// with real information).

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';
import { sendProactiveMessage } from '../../teams/notify.js';

const HAIKU = 'claude-haiku-4-5-20251001';

function supabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// A same-requester burst of asks within this window that crosses
// PROBING_THRESHOLD fires a distinct "heads up" alert to Michael, separate
// from the per-request approval message — deliberately topic-agnostic (any 3
// distinct asks in a day, not "3 rephrasings of the same question"), since a
// real semantic-similarity check is more machinery than this needs for a
// single-employee-at-a-time reality.
const PROBING_WINDOW_HOURS = 24;
const PROBING_THRESHOLD = 3;

// The vague decline shown to the employee immediately — never confirms
// private data exists, never explains why. Deliberately generic/identical
// regardless of what was actually asked.
const VAGUE_DECLINE = "That's something I'd need to check with Michael on first — I'll follow up once I hear back from him.";

// ── Called from the request_employee_approval tool handler ──────────────────
// context (sender, activity, requestText) comes from the TRUSTED context
// object threaded through core/agent.js -> tools/dispatcher.js, never from
// LLM-produced tool input — see registry.js's schema for this tool, which
// deliberately takes no LLM-fillable parameters at all.
export async function requestEmployeeApproval({ sender, activity, requestText }) {
  // Same class of gap fixed in tools/impl/claude-code-escalation.js's
  // requestEscalation (2026-09-02): this reads activity.conversation.id
  // unconditionally, same as that file did before the fix. Not currently
  // reachable (the only call site -- teams/bot.js's 'employee' taskType
  // branch -- always has a real Teams activity), but the two flows are
  // explicitly documented as mirroring each other's pattern (see this
  // file's own header and claude-code-escalation.js's), so guard here too
  // rather than leaving a latent crash for whenever that stops being true.
  if (!activity?.conversation?.id) {
    logger.warn('privacy-gate: no Teams conversation context available, declining', { requester: sender?.name });
    return VAGUE_DECLINE;
  }

  const db = supabase();
  const { data: row, error } = await db
    .from('employee_requests')
    .insert({
      requester_aad_id:          sender.aadId,
      requester_name:            sender.name,
      requester_email:           sender.email,
      requester_conversation_id: activity.conversation.id,
      requester_service_url:     activity.serviceUrl,
      request_text:              requestText,
    })
    .select('*')
    .single();

  if (error) {
    logger.error('privacy-gate: could not create pending request', { err: error.message });
    return VAGUE_DECLINE; // fail closed — still decline even if we couldn't persist the row
  }

  logger.info('privacy-gate: pending employee request created', { id: row.id, requester: sender.name, aadId: sender.aadId });

  notifyMichaelOfRequest(row).catch(err =>
    logger.warn('privacy-gate: notifyMichaelOfRequest failed', { err: err.message })
  );

  checkProbing(sender.aadId, row).catch(err =>
    logger.warn('privacy-gate: checkProbing failed', { err: err.message })
  );

  return VAGUE_DECLINE;
}

async function notifyMichaelOfRequest(row) {
  const who = row.requester_name ? `${row.requester_name}${row.requester_email ? ` <${row.requester_email}>` : ''}` : (row.requester_email ?? 'An employee');
  const msg = `👤 ${who} asked: "${row.request_text}"\n\nReply "yes" to answer this once, "yes, and remember this" to make it standing for future asks like it, or "no" to decline.`;
  await sendProactiveMessage(msg);
  await supabase().from('employee_requests').update({ michael_notified_at: new Date().toISOString() }).eq('id', row.id);
}

async function checkProbing(requesterAadId, newRow) {
  const since = new Date(Date.now() - PROBING_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const db = supabase();
  const { data: recent, error } = await db
    .from('employee_requests')
    .select('id, probing_alert_sent')
    .eq('requester_aad_id', requesterAadId)
    .gte('created_at', since);

  if (error) {
    logger.warn('privacy-gate: probing check query failed', { err: error.message });
    return;
  }

  const alreadyAlertedThisWindow = recent.some(r => r.probing_alert_sent);
  if (recent.length >= PROBING_THRESHOLD && !alreadyAlertedThisWindow) {
    const name = newRow.requester_name ?? newRow.requester_email ?? 'An employee';
    await sendProactiveMessage(
      `⚠️ Heads up — ${name} has asked ${recent.length} separate things in the last ${PROBING_WINDOW_HOURS}h that needed your approval. Not asking for a decision here, just flagging the pattern in case it's worth a direct conversation.`
    );
    await db.from('employee_requests').update({ probing_alert_sent: true }).eq('id', newRow.id);
  }
}

// ── Standing exception check — called before escalating a NEW request ───────
// Best-effort fuzzy match via Haiku, same class of tool as
// feedback-capture.js's extractRule. Approximate by design (may occasionally
// over/under-match); acceptable given the expected low volume.
export async function checkStandingException(requesterAadId, requestText) {
  const db = supabase();
  const { data: exceptions, error } = await db
    .from('privacy_exceptions')
    .select('id, topic_summary, rule_text')
    .eq('requester_aad_id', requesterAadId)
    .eq('active', true);

  if (error || !exceptions?.length) return null;

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const resp = await anthropic.messages.create({
    model: HAIKU,
    max_tokens: 128,
    system: `You decide whether a new request from an employee is already covered by one of Michael's previously-granted standing exceptions. Return JSON: {"matches": boolean, "exception_id": "id or empty string"}. Only say true if the new request is clearly the same KIND of thing as one of the topics — not just superficially similar wording.`,
    messages: [{
      role: 'user',
      content: `Standing exceptions already granted:\n${exceptions.map(e => `- [${e.id}] ${e.topic_summary}`).join('\n')}\n\nNew request: "${requestText}"`,
    }],
  });

  const raw = resp.content[0]?.text ?? '{}';
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    if (!parsed.matches || !parsed.exception_id) return null;
    return exceptions.find(e => e.id === parsed.exception_id) ?? null;
  } catch {
    return null;
  }
}

async function summarizeTopic(requestText) {
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await anthropic.messages.create({
      model: HAIKU,
      max_tokens: 64,
      system: 'Summarize the KIND of request this is in under 10 words, generic enough to match similar future requests (e.g. "Michael\'s calendar availability", "SA client contact info"). Return only the summary text, nothing else.',
      messages: [{ role: 'user', content: requestText }],
    });
    return (resp.content[0]?.text ?? requestText).trim().slice(0, 200);
  } catch {
    return requestText.slice(0, 200);
  }
}

// ── Called from teams/bot.js for every message FROM MICHAEL, before the
// normal classifyIntent flow — a fast no-op (one Supabase count query) for
// the overwhelming majority of his messages that aren't approval replies. ──
export async function resolvePendingApprovalReply(michaelText) {
  const db = supabase();
  const { data: pending, error } = await db
    .from('employee_requests')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error) {
    logger.warn('privacy-gate: pending-requests query failed', { err: error.message });
    return null;
  }
  if (!pending.length) return null;

  const { isApprovalReply } = await import('../../teams/router.js');

  if (pending.length > 1) {
    const { decision } = isApprovalReply(michaelText);
    if (!decision) return null; // Michael's message isn't decision-shaped — let it flow through normally
    const list = pending.map((r, i) => `${i + 1}. [${(r.requester_name ?? r.requester_email ?? 'unknown')}] "${r.request_text}"`).join('\n');
    return { replyToMichael: `You have ${pending.length} pending approvals — which one?\n\n${list}\n\nReply with the number.` };
  }

  const row = pending[0];
  const { decision } = isApprovalReply(michaelText);
  if (!decision) return null;

  if (decision === 'denied') {
    await db.from('employee_requests').update({ status: 'denied', resolved_at: new Date().toISOString(), resolution_note: michaelText }).eq('id', row.id);
    return { replyToMichael: `Got it — declined ${row.requester_name ?? row.requester_email ?? 'their'} request.` };
  }

  await db.from('employee_requests').update({
    status: decision, resolved_at: new Date().toISOString(), resolution_note: michaelText,
  }).eq('id', row.id);

  if (decision === 'approved_standing') {
    const topic = await summarizeTopic(row.request_text);
    await db.from('privacy_exceptions').insert({
      requester_aad_id: row.requester_aad_id,
      topic_summary:     topic,
      rule_text:          michaelText,
    });
  }

  await fulfillApprovedRequest(row).catch(err =>
    logger.error('privacy-gate: fulfillApprovedRequest failed', { id: row.id, err: err.message })
  );

  return { replyToMichael: `Approved${decision === 'approved_standing' ? ' (standing exception saved)' : ''} — answering ${row.requester_name ?? row.requester_email ?? 'them'} now.` };
}

// Re-runs the original request with full tools (Michael's approval IS the
// authorization for this one answer) and messages the result back to the
// original requester directly.
async function fulfillApprovedRequest(row) {
  const { runAgent } = await import('../../core/agent.js');
  const { result } = await runAgent({ task: row.request_text, taskType: 'general', saveContext: false });
  await sendProactiveMessage(result, { target: row.requester_aad_id });
  logger.info('privacy-gate: approved request fulfilled', { id: row.id, requester: row.requester_name });
}
