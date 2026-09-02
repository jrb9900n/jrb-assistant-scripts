// voice/tool-bridge.js — tool access for the live voice channel.
//
// History: started deliberately narrow (calendar + email only), then grew
// through two rounds of hand-picked additions as Michael asked for specific
// capabilities on real calls (SA/Dispatch Board, FieldOps/FleetOps,
// QuickBooks, Google Ads, SharePoint, then the higher-risk SA writes and
// book_time_with_michael). That hand-curated-allowlist shape stopped being
// the right one once Michael asked, in so many words, for voice/Teams/Claude
// Code to all have the same tools -- a fixed name list drifts out of sync
// with registry.js by construction (add a tool to SA_TOOLS, forget to also
// add it here, and it's silently missing from voice with no error).
//
// Rebuilt 2026-08-27 as a DENY-list over registry.js's own "business"
// taskType buckets instead: pull every tool from calendar/email/crm/report/
// scheduling/sharepoint (the same buckets Teams' own intent router draws
// from for Michael's conversations), and exclude only what's actually
// broken on this channel, not what merely seemed risky. Currently that's
// just escalate_to_claude_code -- it needs context.activity (a Teams
// conversation to ask Michael's yes/no in), which voice never supplies, so
// it just declines gracefully rather than doing anything useful over a call.
// Everything else Teams' business
// taskTypes can do, voice can now do too, including the write paths
// (SA client/estimate/job creation, billing/tag config, book_time_with_michael)
// -- see VOICE_SYSTEM_PROMPT's explicit "confirm before committing"
// instruction, since phone-line speech-to-text is more error-prone than
// typed input for consequential actions.
//
// Extended again 2026-08-27, on an explicit, separate confirmation from
// Michael (asked directly: business tools only, or also the dev/deploy
// tools Teams' 'general' bucket and Claude Code already have -- he chose
// full parity, understanding a PIN-gated open phone line can now trigger
// real code/infra changes: run_script (arbitrary local script execution),
// write_file, the full github_* set including github_merge_pr, and
// vercel_api (redeploy/set_env/add_domain/etc.). Pulling 'general' in also
// re-adds escalate_to_claude_code and everything already covered by the
// business buckets above, but VOICE_EXCLUDED_TOOL_NAMES and the seen-based
// dedup below handle both cases the same as always.
//
// tools/dispatcher.js itself has no allowlist concept -- it will dispatch
// any registered tool name regardless of caller. Restricting a voice call to
// this subset is enforced here, in the caller, not in the shared dispatcher:
// handleVoiceToolCall() re-checks allowlist membership before ever calling
// dispatchTool(), rather than trusting "the OpenAI session was only given
// this schema" alone -- the caller is an external, unauthenticated-until-PIN
// voice channel, not a trusted in-process caller.
import { getTools } from '../tools/registry.js';
import { logger } from '../core/logger.js';

// Business taskType buckets, matching what Teams' router draws from for
// Michael's own conversations, plus 'general' (dev/deploy tools -- see
// header comment on the 2026-08-27 extension). This deny-list rebuild
// landed the same day a separate session's PR #349 hand-added exactly the
// 4 Teams-read tool names (tools/impl/teams-read.js, TOOL_MAP.general via
// merged PR #348) to the old, now-deleted VOICE_TOOL_NAMES allow-list --
// merging main here conflicted on that basis. Resolved in favor of this
// file's deny-list structure: since it already pulls the entire 'general'
// bucket (see the 2026-08-27 dev-tool-parity extension below), the 4
// Teams-read tools arrive automatically with no separate list to maintain,
// making #349's explicit addition redundant rather than something to
// reconcile line-by-line. Confirmed live after this merge -- see commit.
const BUSINESS_TASK_TYPES = ['calendar', 'email', 'crm', 'report', 'scheduling', 'sharepoint', 'general'];

// Tools that exist in the registry but are structurally incompatible with
// this channel -- not a risk judgment call, a technical one.
const VOICE_EXCLUDED_TOOL_NAMES = new Set([
  'escalate_to_claude_code', // needs context.activity (a Teams conversation to ask approval in); voice never has one, so it would just decline instead of doing anything useful
]);

// The mailbox voice-channel drafts land in. Deliberately NOT sourced from
// M365_USER_EMAIL -- that env var IS the assistant's own mailbox address
// (see USER() in tools/impl/m365.js), so reading it here would silently put
// drafts right back in the assistant's mailbox, exactly the bug this
// override exists to fix (confirmed live 2026-08-26: Michael asked
// repeatedly on real calls for drafts in his own mailbox and never got
// them). An automated review pass on this PR "fixed" this constant to read
// M365_USER_EMAIL for consistency with USER() -- reverted twice now (once
// as an actual bot commit, once as a review-comment suggestion); that's the
// same regression with a plausible-sounding justification each time, not a
// real fix. A dedicated VOICE_DRAFT_USER_EMAIL env var lets Michael repoint
// this without a deploy if it's ever needed -- but the fallback is this
// literal, not M365_USER_EMAIL, so an unset env var still does the right
// thing rather than reintroducing the bug a third time.
const VOICE_DRAFT_USER_EMAIL = process.env.VOICE_DRAFT_USER_EMAIL || 'michael@jrboehlke.com';

const CANDIDATE_TOOLS = BUSINESS_TASK_TYPES.flatMap((t) => getTools(t));
const seen = new Set();
const ANTHROPIC_TOOL_DEFS = CANDIDATE_TOOLS.filter((t) => {
  if (VOICE_EXCLUDED_TOOL_NAMES.has(t.name) || seen.has(t.name)) return false;
  seen.add(t.name);
  return true;
});

export const VOICE_ALLOWED_TOOLS = new Set(ANTHROPIC_TOOL_DEFS.map((t) => t.name));

/**
 * Anthropic tool shape: { name, description, input_schema }
 * OpenAI Realtime function-tool shape: { type: 'function', name, description, parameters }
 * The underlying JSON Schema is identical -- only the wrapper key names differ.
 */
export function buildVoiceToolSchema() {
  return ANTHROPIC_TOOL_DEFS.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));
}

/**
 * @param {string} name
 * @param {string} argsJsonString - raw JSON string of the function call's arguments
 * @param {object} context - trusted side-channel, e.g. { sender, callId, fromNumber }
 */
export async function handleVoiceToolCall(name, argsJsonString, context) {
  if (!VOICE_ALLOWED_TOOLS.has(name)) {
    logger.warn('Voice bridge: rejected tool call outside curated allowlist', { name, context });
    return { error: `Tool "${name}" is not available on this channel.` };
  }

  let input;
  try {
    input = argsJsonString ? JSON.parse(argsJsonString) : {};
  } catch (err) {
    logger.warn('Voice bridge: malformed tool call arguments', { name, err: err.message });
    return { error: 'Malformed tool arguments.' };
  }

  // Michael asked multiple times on live calls for drafts/replies to land in
  // his own mailbox, not the assistant's. draft_email's schema doesn't even
  // expose userEmail to this channel's model (see buildVoiceToolSchema);
  // create_reply_draft does, but forcing it here doesn't depend on the model
  // remembering to set it. send_email is forced too, and specifically MUST
  // match whichever mailbox the draft it's sending was created in (sendEmail
  // now takes userEmail for exactly this -- see tools/impl/m365.js) or
  // sending a voice-created draft 404s as "not found" against the assistant's
  // mailbox instead. See VOICE_DRAFT_USER_EMAIL's own comment above for why
  // this is a literal, not an env var.
  if (name === 'draft_email' || name === 'send_email' || name === 'create_reply_draft') {
    input.userEmail = VOICE_DRAFT_USER_EMAIL;
  }

  const { dispatchTool } = await import('../tools/dispatcher.js');
  try {
    return await dispatchTool(name, input, context);
  } catch (err) {
    logger.error('Voice bridge: tool call failed', { name, err: err.message });
    return { error: err.message };
  }
}
