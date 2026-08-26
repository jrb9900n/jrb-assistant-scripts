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
// each of those areas, still deliberately excluding the highest-risk write
// paths for an unattended, PIN-only-authenticated phone channel:
// book_time_with_michael (real Outlook invite to an arbitrary address),
// sa_create_client/sa_create_estimate/sa_create_job/sa_set_billing_defaults/
// sa_set_crackfill/tag-write tools (irreversible or higher-blast-radius SA
// writes), and escalate_to_claude_code (still throws on this channel per the
// original note above -- context.activity is never present). If Michael
// wants any of those live on a call too, that's a deliberate follow-up ask,
// not an oversight.
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
  // SA / Dispatch Board (read + dispatch + append-only logging -- not
  // client/estimate/job creation or billing/tag config)
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
]);

const CANDIDATE_TOOLS = [
  ...getTools('calendar'),
  ...getTools('email'),
  ...getTools('crm'),
  ...getTools('report'),
  ...getTools('scheduling'),
];
const seen = new Set();
const ANTHROPIC_TOOL_DEFS = CANDIDATE_TOOLS.filter((t) => {
  if (!VOICE_TOOL_NAMES.has(t.name) || seen.has(t.name)) return false;
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

  // Michael asked multiple times on live calls for drafts to land in his own
  // mailbox, not the assistant's -- draft_email's tool schema doesn't expose
  // userEmail to this channel's model at all (see buildVoiceToolSchema), so
  // force it here rather than relying on prompt wording to get an LLM to
  // remember a param it was never shown.
  if (name === 'draft_email') {
    input.userEmail = 'michael@jrboehlke.com';
  }

  const { dispatchTool } = await import('../tools/dispatcher.js');
  try {
    return await dispatchTool(name, input, context);
  } catch (err) {
    logger.error('Voice bridge: tool call failed', { name, err: err.message });
    return { error: err.message };
  }
}
