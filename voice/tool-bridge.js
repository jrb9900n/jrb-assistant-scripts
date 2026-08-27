// voice/tool-bridge.js — curated tool subset for the live voice channel.
//
// Deliberately narrow per the brief: calendar read/write + conflict
// resolution, plus email list/search/get/triage/draft -- nothing more. An
// earlier version of this file spread whole registry.js taskType arrays
// (TOOL_MAP.calendar/.email) unfiltered, which silently rode along with
// tools well outside that documented scope (book_time_with_michael sends a
// real Outlook invite to an arbitrary address; escalate_to_claude_code
// dereferences context.activity, which this channel never supplies, and
// would throw). Pulling by explicit name from registry.js's tool arrays
// (not re-declaring schemas) keeps this in sync with the real definitions
// while staying exactly as narrow as the brief -- expand VOICE_TOOL_NAMES
// deliberately later based on what Michael actually asks for on real calls,
// per the brief's own explicit non-goal.
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
  'list_calendar_events',
  'create_calendar_event',
  'update_calendar_event',
  'delete_calendar_event',
  'resolve_calendar_conflict',
  'list_emails',
  'search_emails',
  'get_email',
  'get_email_triage',
  'draft_email',
  // Teams read (tools/impl/teams-read.js) -- added 2026-08-27 so Michael can
  // ask about Teams messages on a call, matching the same access he already
  // has via Teams bot and Claude Code. Only these 4 names, not the rest of
  // TOOL_MAP.general -- pulled explicitly via TEAMS_READ_TOOLS below.
  'list_michael_teams_chats',
  'list_michael_teams_channels',
  'get_teams_chat_messages',
  'get_teams_channel_messages',
]);

// Explicit allow-list for the four Teams tools sourced from getTools('general').
// Kept structurally separate from VOICE_TOOL_NAMES so that any future addition
// to either set requires a deliberate, visible decision -- there is no implicit
// path by which a new general tool becomes a voice candidate.
const TEAMS_READ_TOOLS = new Set([
  'list_michael_teams_chats',
  'list_michael_teams_channels',
  'get_teams_chat_messages',
  'get_teams_channel_messages',
]);

// Each bucket is filtered against its own explicit allow-list before
// concatenation, so a name collision across buckets cannot silently promote
// an unintended definition -- the intersection is empty by construction.
const CANDIDATE_TOOLS = [
  // All calendar tools are in scope; no further filtering needed for that bucket.
  ...getTools('calendar'),
  // All email tools are in scope; no further filtering needed for that bucket.
  ...getTools('email'),
  // Only the four Teams read tools from general -- filtered here, not by VOICE_TOOL_NAMES alone.
  ...getTools('general').filter((t) => TEAMS_READ_TOOLS.has(t.name)),
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

  const { dispatchTool } = await import('../tools/dispatcher.js');
  try {
    return await dispatchTool(name, input, context);
  } catch (err) {
    logger.error('Voice bridge: tool call failed', { name, err: err.message });
    return { error: err.message };
  }
}
