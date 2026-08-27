// voice/tool-bridge.js — curated tool subset for the live voice channel.
//
// Originally deliberately narrow per the brief: calendar read/write +
// conflict resolution, plus email list/search/get/triage/draft -- nothing
// more. An earlier version of this file spread whole registry.js taskType
// arrays (TOOL_MAP.calendar/.email) unfiltered, which silently rode along
// with tools well outside that documented scope (book_time_with_michael
// sends a real Outlook invite to an arbitrary address; escalate_to_claude_code
// dereferences context.activity, which this channel never supplies, and
// would throw). Pulling by explicit name from registry.js's tool arrays
// (not re-declaring schemas) keeps this in sync with the real definitions.
//
// Expanded 2026-08-26 per Michael's explicit request after a live call --
// he asked (and the assistant had no tool for): SA/Dispatch Board, FieldOps/
// FleetOps, QuickBooks, Google Ads, SharePoint. Added read-heavy tools from
// each of those areas.
//
// Expanded again same day: Michael explicitly asked for the higher-risk SA
// write paths (client/estimate/job creation, billing defaults, tag config)
// and book_time_with_michael too, after being told they were initially left
// out. Those are now included -- see VOICE_SYSTEM_PROMPT's explicit
// "confirm before committing" instruction, added alongside this expansion
// specifically because these actions are consequential (a real Outlook
// invite, a new SA client/estimate/job) and phone-line speech-to-text is
// more error-prone than typed input, so a name/date/amount misheard by the
// model is more likely here than on Teams/CLI. escalate_to_claude_code
// remains excluded -- not a risk judgment call, it structurally throws on
// this channel (dereferences context.activity, which voice never supplies).
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

// The mailbox voice-channel drafts land in. Deliberately NOT sourced from
// M365_USER_EMAIL -- that env var IS the assistant's own mailbox address
// (see USER() in tools/impl/m365.js), so reading it here would silently put
// drafts right back in the assistant's mailbox, exactly the bug this
// override exists to fix (confirmed live 2026-08-26: Michael asked
// repeatedly on real calls for drafts in his own mailbox and never got
// them). An automated review pass on this PR "fixed" this constant to read
// M365_USER_EMAIL for consistency with USER() -- reverted; that's the same
// regression with a plausible-sounding comment, not a real fix. If JRB's
// domain ever changes, update this literal.
const VOICE_DRAFT_USER_EMAIL = 'michael@jrboehlke.com';

const VOICE_TOOL_NAMES = new Set([
  // Calendar
  'list_calendar_events',
  'create_calendar_event',
  'update_calendar_event',
  'delete_calendar_event',
  'resolve_calendar_conflict',
  // Email
  'list_emails',
  'search_emails',
  'get_email',
  'get_email_triage',
  'draft_email',
  // SA / Dispatch Board -- full set, including the higher-risk write paths
  // (client/estimate/job creation, billing defaults, tag config) Michael
  // explicitly asked to have added
  'sa_search_clients',
  'sa_fuzzy_match_client',
  'sa_get_client_profile',
  'sa_get_client_notes',
  'sa_get_audit_trail',
  'sa_get_invoice_status',
  'sa_get_ticket',
  'sa_get_clients_by_tag',
  'sa_add_note',
  'sa_add_ticket',
  'sa_list_resources',
  'sa_dispatch_job',
  'sa_update_route_order',
  'sa_create_client',
  'sa_search_service_types',
  'sa_create_estimate',
  'sa_create_job',
  'sa_set_billing_defaults',
  'sa_set_crackfill',
  'sa_list_tag_categories',
  'sa_list_tags',
  'sa_get_client_tags',
  'sa_add_tag_to_client',
  'sa_remove_tag_from_client',
  'sa_find_or_create_tag',
  'sa_find_or_create_tag_category',
  // FieldOps (crew scheduling board)
  'get_crews',
  'get_waiting_list',
  'get_treatment_history',
  'get_weather_forecast',
  'save_schedule_draft',
  'get_schedule_draft',
  'sync_pavement_sizes',
  'record_decision',
  // FleetOps (FleetSharp GPS/telematics -- read-only by design)
  'fleetsharp_get_vehicle_list',
  'fleetsharp_get_live_positions',
  'fleetsharp_get_daily_mileage',
  'fleetsharp_get_tracker_names',
  // QuickBooks
  'qb_query',
  // Google Ads (read-only by design)
  'google_ads_list_campaigns',
  'google_ads_get_campaign_metrics',
  'google_ads_get_keyword_performance',
  'google_ads_get_lead_conversions',
  // SharePoint
  'search_sharepoint',
  'read_sharepoint_file',
  'list_sharepoint_folder',
  'list_sharepoint_sites',
  // Booking (real Outlook invite to an arbitrary address)
  'book_time_with_michael',
  'check_michael_availability',
]);

// CANDIDATE_TOOLS must cover every taskType used by any tool in VOICE_TOOL_NAMES.
// If a tool's registry taskType isn't listed here it will be silently absent
// from ANTHROPIC_TOOL_DEFS -- the LLM never sees its schema and calls never
// happen. The startup check below catches this at boot rather than at
// call-time. Note: registry.js's TOOL_MAP has no 'fleet'/'finance'/'ads' keys
// -- getTools() falls back to TOOL_MAP.general for an unknown name, so those
// would silently just re-fetch the same (very wide) general bucket three
// times over, not actually target FleetSharp/QB/Google Ads specifically.
// 'crm' + 'report' already carry those tools' real taskTypes.
const CANDIDATE_TOOLS = [
  ...getTools('calendar'),
  ...getTools('email'),
  ...getTools('crm'),
  ...getTools('report'),
  ...getTools('scheduling'),
  ...getTools('sharepoint'),
];
const seen = new Set();
const ANTHROPIC_TOOL_DEFS = CANDIDATE_TOOLS.filter((t) => {
  if (!VOICE_TOOL_NAMES.has(t.name) || seen.has(t.name)) return false;
  seen.add(t.name);
  return true;
});

// Warn at startup for any VOICE_TOOL_NAMES entry that wasn't matched by any
// candidate tool. This makes the "silently omitted tool" failure mode loud
// and boot-time rather than silent and call-time: if a tool is added to
// VOICE_TOOL_NAMES but its registry taskType isn't in CANDIDATE_TOOLS above,
// the server will log a clear warning the moment it starts.
const matched = new Set(ANTHROPIC_TOOL_DEFS.map((t) => t.name));
for (const name of VOICE_TOOL_NAMES) {
  if (!matched.has(name)) {
    logger.warn(
      'voice/tool-bridge: tool listed in VOICE_TOOL_NAMES has no matching registry entry -- ' +
      'its taskType may not be included in CANDIDATE_TOOLS; the LLM will never see this tool.',
      { tool: name }
    );
  }
}

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

  // Michael asked multiple times on live calls for drafts to land in his own
  // mailbox, not the assistant's -- draft_email's tool schema doesn't expose
  // userEmail to this channel's model at all (see buildVoiceToolSchema), so
  // force it here rather than relying on prompt wording to get an LLM to
  // remember a param it was never shown. See VOICE_DRAFT_USER_EMAIL's own
  // comment above for why this is a literal, not an env var.
  if (name === 'draft_email') {
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
