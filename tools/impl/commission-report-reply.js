// tools/impl/commission-report-reply.js — handles replies to commission report drafts
//
// A commission report draft goes out via commission-report.js's sendDraftForApproval,
// tracked in commission_report_drafts keyed by Graph thread_id. When Michael replies
// in that thread, cron.js's email_poller routes here instead of the general/CRM/dev
// classification. This module classifies the reply (approve / change request /
// unclear) using the same cheap-LLM pattern as feedback-capture.js, applies any
// requested changes directly (no further LLM involvement once actions are extracted),
// and either sends a revised draft, the final report, or a clarifying question.
//
// V1 supports exactly three action types — anything else comes back as 'unclear'
// rather than being guessed at:
//   reassign_pm             — pm_job_assignments override (source='manual', naturally
//                              outranks a prior 'sa_signal' row per resolvePM's priority)
//   confirm_renewal         — commission_ledger.renewal_confirmed
//   confirm_subcontracted_line — commission_ledger_lines.confirmed

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';
import { sendDraftForApproval, sendFinalReport } from './commission-report.js';
import { createReplyDraft, sendDraft } from './m365.js';

const HAIKU = 'claude-haiku-4-5-20251001';

const fleetops = createClient(
  process.env.FLEETOPS_SUPABASE_URL,
  process.env.FLEETOPS_SUPABASE_SERVICE_KEY
);

export async function findOpenDraftForThread(threadId) {
  if (!threadId) return null;
  const { data, error } = await fleetops
    .from('commission_report_drafts')
    .select('*')
    .eq('thread_id', threadId)
    .eq('status', 'draft')
    .maybeSingle();
  if (error) { logger.warn('findOpenDraftForThread query failed', { err: error.message, threadId }); return null; }
  return data;
}

// Builds the "known jobs" context the classifier needs to resolve free-text
// references ("Sterling Pharma", "the Celia Shaughnessy line") to concrete
// sa_reference / ledger_line ids.
async function buildDraftContext(quarter) {
  const { data: ledgerRows, error: ledgerError } = await fleetops
    .from('commission_ledger')
    .select('id, sa_reference, client_name, employee_name, category, renewal_flag, renewal_confirmed')
    .eq('quarter', quarter);
  if (ledgerError) throw new Error(`buildDraftContext ledger query failed: ${ledgerError.message}`);

  const ledgerIds = (ledgerRows ?? []).map(r => r.id);
  const { data: lineRows, error: lineError } = ledgerIds.length
    ? await fleetops.from('commission_ledger_lines')
        .select('id, ledger_id, qbo_line_description, qbo_item_name, line_amount, confirmed')
        .in('ledger_id', ledgerIds)
        .eq('category', 'subcontracted_candidate')
    : { data: [] };
  if (lineError) throw new Error(`buildDraftContext lines query failed: ${lineError.message}`);

  const ledgerById = new Map((ledgerRows ?? []).map(r => [r.id, r]));
  const lines = (lineRows ?? []).map(l => ({
    ledger_line_id: l.id,
    client_name: ledgerById.get(l.ledger_id)?.client_name,
    description: l.qbo_line_description || l.qbo_item_name,
    amount: l.line_amount,
    confirmed: l.confirmed,
  }));

  return {
    jobs: (ledgerRows ?? []).map(r => ({
      sa_reference: r.sa_reference, client_name: r.client_name, employee_name: r.employee_name,
      category: r.category, renewal_flag: r.renewal_flag, renewal_confirmed: r.renewal_confirmed,
    })),
    subcontractedLines: lines,
  };
}

const CLASSIFY_SYSTEM = `You classify a reply to a draft PM commission report email for J.R. Boehlke.

You'll be given the current draft's known jobs (client name, sa_reference, employee, category, renewal status) and any unconfirmed subcontracted line items (ledger_line_id, client name, description, amount) as context, followed by the reply text.

Classify the reply's overall intent:
- "approve" — the reply signals the draft looks correct and should be finalized (e.g. "approved", "looks good", "send it", "go ahead").
- "change_request" — the reply asks for one or more specific corrections.
- "unclear" — the reply doesn't clearly do either (ambiguous, off-topic, or references something not in the provided context).

For change_request, extract a list of actions using ONLY these three types — do not invent other action types, and do not act on anything you can't confidently resolve to a specific sa_reference or ledger_line_id from the provided context:
  { "type": "reassign_pm", "sa_reference": "<from context>", "new_employee": "<name>" }
  { "type": "confirm_renewal", "sa_reference": "<from context>", "is_renewal": true|false }
  { "type": "confirm_subcontracted_line", "ledger_line_id": "<from context>", "confirmed": true|false }

If a request in the reply can't be confidently mapped to a specific job/line in the context (e.g. an ambiguous client name match, or a request type not in the three above), do NOT include an action for it — instead set intent to "unclear" and explain what's ambiguous in "clarification".

Return ONLY JSON: { "intent": "approve"|"change_request"|"unclear", "actions": [...], "clarification": "text if intent is unclear, else empty string" }`;

export async function classifyReply(bodyText, context) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const contextText = `Known jobs:\n${JSON.stringify(context.jobs, null, 2)}\n\nUnconfirmed subcontracted lines:\n${JSON.stringify(context.subcontractedLines, null, 2)}\n\nReply text:\n${bodyText}`;
  const resp = await anthropic.messages.create({
    model: HAIKU,
    max_tokens: 1024,
    system: CLASSIFY_SYSTEM,
    messages: [{ role: 'user', content: contextText }],
  });
  const raw = resp.content[0]?.text ?? '{}';
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { intent: 'unclear', actions: [], clarification: 'Could not parse a response — please rephrase.' };
  try {
    const parsed = JSON.parse(m[0]);
    return {
      intent: ['approve', 'change_request', 'unclear'].includes(parsed.intent) ? parsed.intent : 'unclear',
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      clarification: parsed.clarification ?? '',
    };
  } catch {
    return { intent: 'unclear', actions: [], clarification: 'Could not parse a response — please rephrase.' };
  }
}

// Parses an sa_reference into the pm_job_assignments column/value it should
// write. Handles the 'contract:client:<customerId>' shape used for
// contract-less maintenance jobs (grouped by customer_id in
// commission-engine.js's assembleMaintenanceSnowJobs) — that must write
// sa_client_id with the bare customer id, not sa_contract_id with a garbage
// composite string, or resolvePM's lookup will never find it.
function parseSaReferenceForAssignment(saReference) {
  if (saReference.startsWith('contract:client:')) {
    return ['sa_client_id', saReference.slice('contract:client:'.length)];
  }
  if (saReference.startsWith('contract:')) {
    return ['sa_contract_id', saReference.slice('contract:'.length)];
  }
  if (saReference.startsWith('invoice:')) {
    return ['sa_invoice_sa_id', saReference.slice('invoice:'.length)];
  }
  return [null, null];
}

// Returns { applied, failed } — failed includes both thrown errors AND
// updates that ran without error but matched zero rows (a hallucinated or
// stale reference from the LLM), so a silent no-op is never reported as success.
export async function applyActions(actions) {
  const applied = [];
  const failed = [];
  for (const action of actions) {
    try {
      if (action.type === 'reassign_pm' && action.sa_reference && action.new_employee) {
        const [col, val] = parseSaReferenceForAssignment(action.sa_reference);
        if (!col) { logger.warn('reassign_pm: unrecognized sa_reference shape', { action }); failed.push(action); continue; }
        const { error } = await fleetops.from('pm_job_assignments').insert({
          [col]: val, employee_name: action.new_employee, source: 'manual', assigned_by: 'commission-report-reply',
          notes: `Reassigned via draft report reply`,
        });
        if (error) throw error;
        applied.push(action); // insert always "matches" — nothing to check row-count against
      } else if (action.type === 'confirm_renewal' && action.sa_reference && typeof action.is_renewal === 'boolean') {
        // Updates every historical row for this sa_reference, not just the
        // current quarter's — harmless (even useful for consistency), since
        // the engine looks at either the current-quarter row or the most
        // recent prior row when carrying this forward.
        const { data, error } = await fleetops.from('commission_ledger')
          .update({ renewal_confirmed: action.is_renewal })
          .eq('sa_reference', action.sa_reference)
          .select('id');
        if (error) throw error;
        (data?.length ? applied : failed).push(action);
      } else if (action.type === 'confirm_subcontracted_line' && action.ledger_line_id && typeof action.confirmed === 'boolean') {
        const { data, error } = await fleetops.from('commission_ledger_lines')
          .update({ confirmed: action.confirmed })
          .eq('id', action.ledger_line_id)
          .select('id');
        if (error) throw error;
        (data?.length ? applied : failed).push(action);
      } else {
        logger.warn('applyActions: unrecognized or incomplete action', { action });
        failed.push(action);
      }
    } catch (err) {
      logger.warn('applyActions: failed to apply action', { action, err: err.message });
      failed.push(action);
    }
  }
  return { applied, failed };
}

function clarifyingReplyBody(clarification) {
  return `<p style="font-family:Arial,sans-serif;font-size:13px;color:#333;">I wasn't able to apply that with confidence: ${clarification || 'could you rephrase?'}</p><p style="font-family:Arial,sans-serif;font-size:13px;color:#333;">Reply again with a correction, or "approved" if the draft is otherwise fine as-is.</p>`;
}

function describeAction(action) {
  if (action.type === 'reassign_pm') return `reassign ${action.sa_reference} to ${action.new_employee}`;
  if (action.type === 'confirm_renewal') return `mark ${action.sa_reference} as ${action.is_renewal ? '' : 'not '}a renewal`;
  if (action.type === 'confirm_subcontracted_line') return `mark line ${action.ledger_line_id} as ${action.confirmed ? '' : 'not '}subcontracted`;
  return JSON.stringify(action);
}

function failedActionsNoticeBody(failed) {
  const items = failed.map(a => `<li style="font-size:13px;color:#533f03;margin-bottom:4px;">${describeAction(a)}</li>`).join('');
  return `<p style="font-family:Arial,sans-serif;font-size:13px;color:#533f03;">I couldn't find a matching record for ${failed.length === 1 ? 'this request' : 'these requests'} — nothing was changed for:</p><ul style="margin:0 0 10px;padding-left:18px;">${items}</ul><p style="font-family:Arial,sans-serif;font-size:13px;color:#333;">Anything else below did apply.</p>`;
}

// Main entry point — called by cron.js's email_poller when an incoming email's
// thread_id matches an open commission_report_drafts row.
export async function handleCommissionReportReply(email, draft) {
  const context = await buildDraftContext(draft.quarter);
  const classification = await classifyReply(email.body ?? '', context);

  if (classification.intent === 'unclear') {
    const { draft_id } = await createReplyDraft({ email_id: email.id, body: clarifyingReplyBody(classification.clarification) });
    await sendDraft({ draft_id });
    logger.info('commission-report-reply: sent clarifying question', { quarter: draft.quarter, threadId: draft.thread_id });
    return { action: 'clarify' };
  }

  let failed = [];
  if (classification.actions.length) {
    ({ failed } = await applyActions(classification.actions));
    logger.info('commission-report-reply: applied actions', { quarter: draft.quarter, appliedCount: classification.actions.length - failed.length, failedCount: failed.length });
    if (failed.length) {
      // Surface unmatched requests explicitly rather than letting them silently
      // no-op — sent as a separate reply so it doesn't get buried in the next
      // draft/final email body.
      const { draft_id } = await createReplyDraft({ email_id: email.id, body: failedActionsNoticeBody(failed) });
      await sendDraft({ draft_id });
    }
  }

  if (classification.intent === 'approve') {
    await sendFinalReport({ quarter: draft.quarter, isFinal: draft.is_final, replyToEmailId: email.id });
    logger.info('commission-report-reply: approved, final sent', { quarter: draft.quarter });
    return { action: 'final_sent', failedActions: failed };
  }

  // change_request — regenerate and send a revised draft in the same thread
  await sendDraftForApproval({ quarter: draft.quarter, isFinal: draft.is_final, replyToEmailId: email.id });
  logger.info('commission-report-reply: revised draft sent', { quarter: draft.quarter });
  return { action: 'revised', failedActions: failed };
}
