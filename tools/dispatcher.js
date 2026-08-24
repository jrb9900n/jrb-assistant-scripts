async function webSearch({ query }) {
  try {
    const key = process.env.BRAVE_SEARCH_API_KEY ?? '';
    const url = 'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) + '&count=5';
    const res = await fetch(url, { headers: { 'Accept': 'application/json', 'X-Subscription-Token': key } });
    if (!res.ok) return 'Web search unavailable.';
    const data = await res.json();
    return data.web?.results?.slice(0, 3).map(r => r.title + '\n' + r.url + '\n' + r.description).join('\n\n') ?? 'No results.';
  } catch (err) { return 'Web search error: ' + err.message; }
}

// tools/dispatcher.js — Routes tool calls to implementations
import { logger } from '../core/logger.js';
import * as m365        from './impl/m365.js';
import * as qb          from './impl/quickbooks.js';
import * as expense     from './impl/expense.js';
import * as files       from './impl/files.js';
import * as github      from './impl/github.js';
import * as scripts     from './impl/scripts.js';
import * as vercel      from './impl/vercel.js';
import * as scheduling  from './impl/scheduling.js';
import * as sa          from './impl/serviceautopilot.js';
import { scheduleEstimateVisit } from './impl/scheduling-visits.js';
import { checkMichaelAvailability, bookTimeWithMichael } from './impl/scheduling-booking.js';
import * as fleetsharp  from './impl/fleetsharp.js';
import * as carddav     from './impl/carddav.js';
import * as fuzzyMatch  from './impl/fuzzy-match.js';
import { guardOutbound, classifyInbound, buildFlagEntry } from './impl/email-guardrail.js';
import { requestEmployeeApproval } from './impl/privacy-gate.js';
import { sendProactiveMessage } from '../teams/notify.js';
import { createClient } from '@supabase/supabase-js';

const MICHAEL = 'michael@jrboehlke.com';

// ── Supabase singleton — one client per process, not one per query ────────────
let _supabaseClient = null;
function getSupabaseClient() {
  if (!_supabaseClient) {
    _supabaseClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
    );
  }
  return _supabaseClient;
}

// ── Input validation helpers ──────────────────────────────────────────────────

const VALID_BUCKETS = new Set(['needs_reply', 'fyi', 'marketing']);

/**
 * Clamp hours to a finite, positive integer in [1, 8760] (max 1 year).
 * Returns 24 if the value is missing, NaN, Infinity, or out of range.
 */
function sanitizeHours(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 24;
  return Math.min(Math.max(Math.floor(n), 1), 8760);
}

// ─────────────────────────────────────────────────────────────────────────────

const HANDLERS = {
  // Email
  list_emails:           (i) => m365.listEmails(i),
  get_email:             (i) => m365.getEmail(i),
  search_emails:         (i) => m365.searchEmails(i),
  draft_email:           (i) => m365.draftEmail(i),
  send_email:            (i) => m365.sendEmail(i),
  list_mail_folders:     (i) => m365.listMailFolders(i),
  create_mail_folder:    (i) => m365.createMailFolder(i),
  move_email:            (i) => m365.moveEmail(i),
  catalog_email:         (i) => m365.catalogEmail(i),
  get_email_catalog:     (i) => m365.getEmailCatalog(i),
  // Fix: spread caller input first, then enforce userEmail so it cannot be overridden
  send_draft_reply:      (i) => m365.sendDraft({ ...i, userEmail: MICHAEL }),

  // Inbox assistant (on-demand)
  run_inbox_processor: async () => {
    const { processInbox } = await import('./impl/inbox-processor.js');
    return processInbox();
  },
  get_email_triage: async ({ hours = 24, bucket } = {}) => {
    // Validate and sanitize inputs before use
    const safeHours = sanitizeHours(hours);
    if (bucket !== undefined && !VALID_BUCKETS.has(bucket)) {
      throw new Error(`Invalid bucket value: "${bucket}". Must be one of: needs_reply, fyi, marketing.`);
    }

    const db = getSupabaseClient();
    const since = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();
    let q = db.from('email_triage')
      .select('from_name,from_address,subject,bucket,category,intent,folder_moved_to,draft_id,hot_trigger,meeting_detected,action_items,processed_at')
      .eq('mailbox', MICHAEL)
      .gte('processed_at', since)
      .order('bucket', { ascending: true })
      .order('processed_at', { ascending: false })
      .limit(50);
    if (bucket) q = q.eq('bucket', bucket);
    const { data, error } = await q;
    if (error) throw new Error(`email_triage query failed: ${error.message}`);
    return data ?? [];
  },

  // Calendar
  create_reminder:        (i) => m365.createReminder(i),
  create_calendar_event:  (i) => m365.createCalendarEvent(i),
  list_calendar_events:   (i) => m365.listCalendarEvents(i),
  update_calendar_event:  (i) => m365.updateCalendarEvent(i),
  delete_calendar_event:  (i) => m365.deleteCalendarEvent(i),

  // CRM / Finance
  qb_query:              (i) => qb.query(i),
  identify_unknown_card: (i) => expense.identifyUnknownCard(i),
  backfill_expenses_from_qbo: (i) => expense.backfillExpensesFromQbo(i),

  // Files / OneDrive
  save_to_onedrive:      (i) => m365.saveToOneDrive(i),
  read_from_onedrive:    (i) => m365.readFromOneDrive(i),
  list_onedrive:         (i) => m365.listOneDrive(i),
  write_file:            (i) => files.writeFile(i),

  // SharePoint
  search_sharepoint:     (i) => m365.searchSharePoint(i),
  read_sharepoint_file:  (i) => m365.readSharePointFile(i),
  list_sharepoint_folder:(i) => m365.listSharePointFolder(i),
  list_sharepoint_sites: (i) => m365.listSharePointSites(i),

  // Code / Scripts
  vercel_api:   (i) => vercel.vercelApi(i),
    run_script:           (i) => scripts.runScript(i),

  // GitHub
  github_read:          (i) => github.readFile(i),
  github_list:          (i) => github.listFiles(i),
  github_create_branch: (i) => github.createBranch(i),
  github_push:          (i) => github.pushFile(i),
  github_open_pr:       (i) => github.openPR(i),
  github_merge_pr:      (i) => github.mergePR(i),
  github_list_prs:      (i) => github.listPRs(i),

  // Search
  web_search:           (i) => webSearch(i),

  // Teams
  send_teams_message:   ({ message }) => sendProactiveMessage(message).then(() => 'Teams message sent.'),

  // Service Autopilot
  // maxScan raised well above searchClients' own conservative default (30) --
  // SA's server-side name filter is a confirmed no-op (see searchClients'
  // own comment), so a real conversational search needs to page through a
  // meaningful chunk of the actual account population to have any real
  // chance of finding an account that isn't in SA's "recent clients" list.
  // Fixed here rather than exposed in the tool schema so every LLM-driven
  // search gets this without depending on the model remembering to ask for it.
  sa_search_clients:       (i) => sa.searchClients({ ...i, maxScan: 3000 }),
  sa_create_client:        (i) => sa.createClient(i),
  sa_add_note:             (i) => sa.addNote(i),
  sa_search_service_types: (i) => sa.searchServiceTypes(i),
  sa_create_estimate:      (i) => sa.createEstimate(i),
  sa_create_job:           (i) => sa.createJob(i),
  sa_add_ticket:           ({ notes, ...rest }) => sa.addTicket({ ...rest, body: notes }),
  sa_get_ticket:           (i) => sa.getTicket(i),
  sa_list_tag_categories:  ()  => sa.getTagCategories(),
  sa_list_tags:            ()  => sa.listTags(),
  sa_get_client_tags:      (i) => sa.getClientTags(i),
  sa_add_tag_to_client:    (i) => sa.addTagToClientByName(i),
  sa_remove_tag_from_client: (i) => sa.removeTagFromClient(i),
  sa_set_billing_defaults: (i) => sa.setClientBillingDefaults(i),
  sa_set_crackfill:        (i) => sa.setClientCrackfill(i),
  sa_list_resources:       ()  => sa.listSAResources(),
  sa_dispatch_job:         (i) => sa.dispatchWaitingListJob({ wlItemId: i.wl_item_id, scheduleDate: i.schedule_date, resourceId: i.resource_id }),
  sa_update_route_order:   (i) => sa.updateRouteOrder({ scheduleDate: i.schedule_date, jobIds: i.job_ids }),
  sa_fuzzy_match_client:   (i) => fuzzyMatch.runFuzzyMatchClient(i),
  sa_get_client_profile:   (i) => sa.getClientProfile(i),
  sa_get_client_notes:     (i) => sa.getClientNotes(i),
  sa_get_audit_trail:      (i) => sa.getAuditTrail(i),
  sa_get_invoice_status:   (i) => sa.getInvoiceStatuses(i),
  schedule_estimate_visit: (i) => scheduleEstimateVisit(i),

  // Read-only, safe for anyone -- only ever surfaces free/busy windows, never
  // subjects/tiers/reasons.
  check_michael_availability: (i) => checkMichaelAvailability(i),
  // Same trusted-context pattern as request_employee_approval above:
  // isEmployeeRequester/requesterIdentity come from context.sender (resolved
  // server-side by teams/identity.js), never from LLM-produced JSON, so an
  // employee requester can't type their way into a different name/email or
  // into skipping the "never reveal the real reason" decline behavior.
  // context is null for non-Teams callers (CLI/MCP) -- those fall back to
  // whatever requesterName/requesterEmail the caller/LLM supplied directly,
  // same as every other tool that doesn't get a context.
  book_time_with_michael: (i, context) => {
    const sender = context?.sender;
    const isEmployee = !!sender && !sender.isMichael;
    return bookTimeWithMichael({
      ...i,
      requesterName:  isEmployee ? (sender.name ?? i.requesterName) : i.requesterName,
      requesterEmail: isEmployee ? (sender.email ?? i.requesterEmail) : i.requesterEmail,
      isEmployeeRequester: isEmployee,
      requesterIdentity: isEmployee ? (sender.email ?? sender.aadId ?? null) : null,
    });
  },

  // FleetSharp
  fleetsharp_get_vehicle_list:    () => fleetsharp.getVehicleList(),
  fleetsharp_get_live_positions:  () => fleetsharp.getLivePositions(),
  fleetsharp_get_daily_mileage:   (i) => fleetsharp.getDailyMileage(i),
  fleetsharp_get_tracker_names:   () => fleetsharp.getTrackerNames(),

  // CardDAV
  carddav_provision:      (i) => carddav.provisionCredential(i),
  carddav_revoke:         ({ email }) => carddav.revokeCredential(email),
  carddav_list:           () => carddav.listCredentials(),

  // Scheduling
  get_crews:            (i) => scheduling.getCrews(i),
  get_waiting_list:     (i) => scheduling.getWaitingList(i),
  get_treatment_history:(i) => scheduling.getTreatmentHistory(i),
  get_weather_forecast: (i) => scheduling.getWeatherForecast(i),
  save_schedule_draft:  (i) => scheduling.saveScheduleDraft(i),
  get_schedule_draft:   (i) => scheduling.getScheduleDraft(i),
  record_decision:      (i) => scheduling.recordDecision(i),
  sync_pavement_sizes:  (i) => scheduling.syncPavementSizes(i),

  // Employee privacy-gate — deliberately takes NOTHING from LLM-produced tool
  // input (registry.js's schema has an empty properties object). Sender/
  // activity/the original request text all come from the trusted `context`
  // object threaded through runAgent() -> dispatchTool(), never from
  // anything the model could fill in itself. See tools/impl/privacy-gate.js.
  request_employee_approval: (i, context) => requestEmployeeApproval({
    sender: context?.sender, activity: context?.activity, requestText: context?.requestText,
  }),
};

/**
 * Dispatch a tool call to its implementation.
 * @param {string} toolName
 * @param {object} input
 * @param {object|null} [context] - Trusted, non-LLM-controlled side-channel
 *   (e.g. resolved Teams sender identity) — see core/agent.js's runAgent()
 *   for where this originates. Most handlers ignore it; only ones that need
 *   to know something the model must never be trusted to state itself
 *   (like "who is actually asking") accept it.
 * @returns {Promise<any>}
 */
export async function dispatchTool(toolName, input, context = null) {
  const handler = HANDLERS[toolName];
  if (!handler) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  logger.debug('Dispatching tool', { toolName, input });
  return handler(input, context);
}
