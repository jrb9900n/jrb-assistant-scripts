// tools/impl/code-approval.js — the code/repo/infra-write approval state
// machine. Built 2026-08-27 after Michael asked for the Teams bot and voice
// app to require his explicit permission before overwriting code.
//
// Root problem this fixes: 'general' (Teams bot's widest, catch-all taskType)
// already has full write access -- write_file, run_script (arbitrary local
// script execution), the complete github_* set including github_merge_pr,
// and vercel_api's deploy/redeploy/set_env actions -- with the only
// safeguard being prompt text asking the model to confirm with Michael
// first. Confirmed live 2026-08-27: a casual "missing spacing" Teams message
// caused the model to read a file and create a branch on its own, with zero
// confirmation asked, before failing silently partway through (hit
// max_tokens, never replied). "Ask first" as a prompt instruction is
// advisory, not enforced -- this file makes it structural instead, in the
// one place both channels already funnel every tool call through
// (tools/dispatcher.js), following the exact pending-request/yes-reply shape
// privacy-gate.js and claude-code-escalation.js already established.
//
// Scope: gates the tools that can actually change what code runs or what's
// deployed -- write_file, run_script, github_push, github_merge_pr, and
// vercel_api's write-flavored actions (redeploy/add_domain/set_env).
// Deliberately NOT gated: github_read/github_list/github_list_prs (read-only,
// no blast radius) and github_create_branch/github_open_pr (a new branch or
// an open PR changes nothing live -- main is untouched until merge, and PR
// review is itself the existing human checkpoint before that). auto_fix
// (Teams' ops_alert -> auto_fix path, plus the unattended self_heal_watcher
// cron) is deliberately exempt too -- that system exists specifically for
// autonomous incident response; gating it the same way would mean a real
// production outage waits on Michael typing "confirm" before the fix that's
// supposed to resolve it automatically can land.
//
// Voice-specific behavior, per Michael's explicit choice: a gated tool NEVER
// executes live on a call, even with a spoken "yes" -- it's always staged
// here and confirmed later via a real Teams reply, never resolved from
// within the call itself. See requestCodeApproval's channel handling below.
// NOT YET LIVE-VERIFIED: voice/tool-bridge.js's current curated allowlist
// (calendar/email/Teams-read) never includes a gated tool name, so
// handleVoiceToolCall() rejects those calls before dispatchTool -- and
// therefore this file's voice branch -- is ever reached. This branch will
// only actually run once voice's tool set is widened (see the open,
// unmerged PR #345) to include write_file/run_script/github_*/vercel_api;
// worth a real call test at that point, not just this file's own smoke test.

import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';
import { sendProactiveMessage } from '../../teams/notify.js';

function supabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// Tool names that always require confirmation, regardless of input.
// google_ads_pause_keyword/enable_keyword/adjust_campaign_budget added
// 2026-09-03 alongside their own build -- same reasoning as this file's
// header: a tool description telling the model to "always confirm first" is
// advisory, not enforced, and these three are real, immediate, live-money
// changes, not code/infra. NOTE: like every other entry in this set, this
// gate only actually fires when dispatchTool() is called with Teams or voice
// context (see channelOf() below) -- a call site with no context at all
// (e.g. scheduler/cron.js's email general-fallback runAgent() call, which
// passes no `context` param) falls through ungated today. That's a
// pre-existing gap affecting every tool in this set, not something this
// change introduces or fixes -- flagged, not silently patched, since closing
// it means changing this gate's behavior for write_file/github_push/etc.
// too, a bigger decision than this PR's scope.
export const CONFIRM_REQUIRED_TOOL_NAMES = new Set([
  'write_file',
  'run_script',
  'github_push',
  'github_merge_pr',
  'google_ads_pause_keyword',
  'google_ads_enable_keyword',
  'google_ads_adjust_campaign_budget',
]);

// Subset of the set above that must NEVER fall through to executing
// ungated just because dispatchTool() was called with no Teams/voice
// context -- see tools/dispatcher.js's channelOf()/gate for the "no context
// = trusted CLI/MCP caller" assumption this deliberately does NOT extend to.
// Found live via /code-review 2026-09-03: that assumption is already false
// for at least three real call sites -- teams/bot.js's employee
// standing-exception branch (an unverified non-Michael sender), mcp/
// server.js's run_task tool, and scheduler/cron.js's email general-fallback
// -- all pass taskType 'general'/'report' with zero context, which is
// exactly the condition the existing gate treats as exempt. Money-moving
// tools can't accept that risk the way write_file/run_script/github_* have
// been (silently, so far) -- refusing outright here is safer than either
// silently executing or silently pending with no notification. The broader
// question of whether write_file/run_script/github_push/github_merge_pr
// should get the same tightening is real and worth its own follow-up, not
// folded in here since those are established, possibly-relied-upon
// behavior this change doesn't have full visibility into.
export const REFUSE_IF_NO_CHANNEL_TOOL_NAMES = new Set([
  'google_ads_pause_keyword',
  'google_ads_enable_keyword',
  'google_ads_adjust_campaign_budget',
]);

// vercel_api is one tool name covering several actions via an `action`
// field -- only the write-flavored ones actually change something live.
const VERCEL_WRITE_ACTIONS = new Set(['redeploy', 'add_domain', 'set_env']);

// A pending action nobody ever confirmed shouldn't linger forever -- same
// reasoning and window as claude-code-escalation.js's STALE_PENDING_MS.
const STALE_PENDING_MS = 30 * 60 * 1000;

/**
 * Whether a specific tool call needs approval before it can run.
 * @param {string} toolName
 * @param {object} input - the model's tool_use input (untrusted, but only
 *   used here to read vercel_api's `action` field, not to decide identity)
 */
export function requiresApproval(toolName, input) {
  if (toolName === 'vercel_api') {
    return VERCEL_WRITE_ACTIONS.has(input?.action);
  }
  return CONFIRM_REQUIRED_TOOL_NAMES.has(toolName);
}

// Short, human-readable summary of what a gated tool call would do --
// shown to Michael in the confirmation message, and echoed back once
// executed. Falls back to a generic description for anything not
// explicitly listed rather than throwing, so a future gated tool added to
// CONFIRM_REQUIRED_TOOL_NAMES without a matching case here still works.
export function describeAction(toolName, input) {
  switch (toolName) {
    case 'write_file':
      return `Write file: ${input?.path ?? '(unknown path)'}`;
    case 'run_script':
      return `Run script: ${input?.script_path ?? '(unknown script)'}${input?.args?.length ? ' ' + input.args.join(' ') : ''}`;
    case 'github_push':
      return `Push to ${input?.repo ?? 'jrb-assistant-scripts'}/${input?.branch ?? '(unknown branch)'}: ${input?.path ?? '(unknown path)'} -- "${input?.message ?? ''}"`;
    case 'github_merge_pr':
      return `Merge PR #${input?.pr_number ?? '?'} in ${input?.repo ?? 'jrb-assistant-scripts'}`;
    case 'vercel_api':
      return `Vercel ${input?.action ?? '(unknown action)'} on ${input?.project ?? '(unknown project)'}`;
    case 'google_ads_pause_keyword':
      return `Pause Google Ads keyword ${input?.keywordId ?? '(unknown id)'} -- ${input?.reason ?? ''}`;
    case 'google_ads_enable_keyword':
      return `Re-enable Google Ads keyword ${input?.keywordId ?? '(unknown id)'} -- ${input?.reason ?? ''}`;
    case 'google_ads_adjust_campaign_budget':
      return `Set Google Ads campaign ${input?.campaignId ?? '(unknown id)'}'s daily budget to $${input?.newDailyBudgetUsd ?? '?'} -- ${input?.reason ?? ''}`;
    default:
      return `${toolName}(${JSON.stringify(input ?? {}).slice(0, 200)})`;
  }
}

/**
 * Create a pending approval row and notify Michael. Called from
 * tools/dispatcher.js's gate -- never called directly by a tool handler.
 * @param {string} toolName
 * @param {object} input - the model's tool_use input, stored verbatim so
 *   the exact same call can be replayed on confirmation
 * @param {object} context - the trusted context threaded through
 *   dispatchTool (Teams: {sender, activity, sessionId, taskType}; voice:
 *   {sender, callId, fromNumber})
 * @param {'teams'|'voice'} channel
 * @returns {Promise<{pendingApproval: true, message: string}>}
 */
export async function requestCodeApproval(toolName, input, context, channel) {
  const db = supabase();
  const description = describeAction(toolName, input);

  // Same stale-cleanup pattern as claude-code-escalation.js -- a session
  // that never resolved an earlier pending action shouldn't pile up
  // confusing "which one?" prompts on its next real request.
  const staleCutoff = new Date(Date.now() - STALE_PENDING_MS).toISOString();
  const scopeKey = channel === 'teams' ? { session_id: context?.sessionId } : { call_id: context?.callId };
  await db.from('code_action_approvals')
    .update({ status: 'expired' })
    .match({ status: 'pending', channel, ...scopeKey })
    .lt('created_at', staleCutoff)
    .then(({ error }) => {
      if (error) logger.warn('code-approval: stale-pending cleanup failed (non-fatal)', { err: error.message });
    });

  const { data: row, error } = await db
    .from('code_action_approvals')
    .insert({
      channel,
      session_id: channel === 'teams' ? context?.sessionId : null,
      conversation_id: channel === 'teams' ? context?.activity?.conversation?.id : null,
      service_url: channel === 'teams' ? context?.activity?.serviceUrl : null,
      call_id: channel === 'voice' ? context?.callId : null,
      tool_name: toolName,
      tool_input: input ?? {},
      context: context ?? {},
      description,
      requested_by: context?.sender?.name ?? null,
    })
    .select('id')
    .single();

  if (error) {
    logger.error('code-approval: could not create pending request', { err: error.message, toolName });
    return { pendingApproval: true, message: `This action was NOT performed -- and I couldn't even queue it for approval (${error.message}). Something's wrong on my end.` };
  }

  logger.info('code-approval: pending action created', { id: row.id, toolName, channel, description });

  if (channel === 'voice') {
    // Never resolved from within the call itself, per Michael's explicit
    // choice -- fire the Teams message now so he sees it even if he's not
    // looking at Teams mid-call, then tell the model (for the caller's
    // benefit) that this can only be confirmed later, over Teams.
    sendProactiveMessage(
      `📞 A voice call just asked me to: ${description}\n\nI won't run this live on a call. Reply "confirm ${row.id.slice(0, 8)}" here to approve it, "deny ${row.id.slice(0, 8)}" to reject it, or ignore to let it expire in 30 minutes.`
    ).catch(err => logger.error('code-approval: voice pending-notify failed', { err: err.message, id: row.id }));

    return {
      pendingApproval: true,
      message: `This was NOT performed. Code and infrastructure changes never run live on a call -- I've sent Michael a Teams message to confirm, and it'll happen after he replies there, not during this call. Tell the caller that plainly.`,
    };
  }

  return {
    pendingApproval: true,
    message: `This action was NOT performed yet: ${description}\n\nAsk Michael to reply "confirm ${row.id.slice(0, 8)}" in this chat to proceed, "deny ${row.id.slice(0, 8)}" to reject it, or he can ignore this and it expires in 30 minutes.`,
  };
}

/**
 * Look up a pending approval by its short code (first 8 chars of the row's
 * uuid -- unique enough at this table's realistic volume, short enough to
 * type/say back). Returns null if nothing pending matches.
 */
export async function findPendingApproval(code) {
  if (!code) return null;
  const db = supabase();
  // `id` is a uuid column -- Postgres rejects ilike()/`~~*` against it
  // outright ("operator does not exist: uuid ~~* unknown"), and a
  // `column::text` cast passed through supabase-js's .filter() doesn't
  // reach PostgREST intact either (caught live by this file's own smoke
  // test before this ever reached a real Teams message). Pending rows are
  // realistically few at once (same assumption claude-code-escalation.js's
  // resolvePendingEscalationReply already makes), so fetch pending and match
  // the code prefix in JS instead of pushing the cast into SQL.
  const { data, error } = await db
    .from('code_action_approvals')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (error) {
    logger.warn('code-approval: findPendingApproval query failed', { err: error.message, code });
    return null;
  }

  // The code shown to Michael is always a full 8 hex chars (see
  // requestCodeApproval), and teams/bot.js's confirm/deny regexes only ever
  // pass a full 8-char match in here -- a collision at that length is
  // vanishingly unlikely with a handful of rows pending at once, but silently
  // picking the first match on an ambiguous prefix would mean the wrong
  // repo/infra write could execute with zero warning. Refuse instead.
  const matches = data.filter(row => row.id.startsWith(code.toLowerCase()));
  if (matches.length > 1) {
    logger.warn('code-approval: ambiguous code matched multiple pending rows', { code, count: matches.length });
    return null;
  }
  return matches[0] ?? null;
}

/**
 * Actually run a confirmed action and record the outcome. Called only from
 * teams/bot.js's "confirm <code>" intercept, deterministically -- never
 * driven by the model, so a hallucinated "the user confirmed" can't trigger
 * this path. Executes dispatchTool directly with the exact stored input,
 * bypassing the approval gate via the internal-only bypassApproval flag
 * (never settable by a tool_use call, since core/agent.js's tool loop never
 * passes a 4th argument to dispatchTool).
 */
export async function executeApprovedAction(row) {
  const { dispatchTool } = await import('../dispatcher.js');
  const db = supabase();
  let result;
  try {
    result = await dispatchTool(row.tool_name, row.tool_input, row.context, { bypassApproval: true });
    await db.from('code_action_approvals')
      .update({ status: 'executed', resolved_at: new Date().toISOString(), result: typeof result === 'string' ? { text: result } : result })
      .eq('id', row.id);
  } catch (err) {
    logger.error('code-approval: executeApprovedAction failed', { id: row.id, err: err.message });
    await db.from('code_action_approvals')
      .update({ status: 'error', resolved_at: new Date().toISOString(), result: { error: err.message } })
      .eq('id', row.id);
    throw err;
  }
  return result;
}

export async function denyPendingApproval(row) {
  await supabase().from('code_action_approvals')
    .update({ status: 'denied', resolved_at: new Date().toISOString() })
    .eq('id', row.id);
}
