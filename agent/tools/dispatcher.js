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
import * as files       from './impl/files.js';
import * as github      from './impl/github.js';
import * as scripts     from './impl/scripts.js';
import * as vercel      from './impl/vercel.js';
import * as scheduling  from './impl/scheduling.js';
import * as sa          from './impl/serviceautopilot.js';
import * as fuzzyMatch  from './impl/fuzzy-match.js';
import { guardOutbound, classifyInbound, buildFlagEntry } from './impl/email-guardrail.js';
import { sendProactiveMessage } from '../teams/notify.js';

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
  send_draft_reply:      (i) => m365.sendDraft({ userEmail: 'michael@jrboehlke.com', ...i }),

  // Inbox assistant (on-demand)
  run_inbox_processor: async () => {
    const { processInbox } = await import('./impl/inbox-processor.js');
    return processInbox();
  },
  get_email_triage: async ({ hours = 24, priority } = {}) => {
    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    let q = db.from('email_triage')
      .select('from_name,from_address,subject,priority,category,intent,folder_moved_to,draft_id,hot_trigger,meeting_detected,action_items,processed_at')
      .eq('mailbox', 'michael@jrboehlke.com')
      .gte('processed_at', since)
      .order('priority', { ascending: true })
      .order('processed_at', { ascending: false })
      .limit(50);
    if (priority) q = q.eq('priority', priority);
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
  sa_search_clients:       (i) => sa.searchClients(i),
  sa_create_client:        (i) => sa.createClient(i),
  sa_add_note:             (i) => sa.addNote(i),
  sa_search_service_types: (i) => sa.searchServiceTypes(i),
  sa_create_estimate:      (i) => sa.createEstimate(i),
  sa_create_job:           (i) => sa.createJob(i),
  sa_add_ticket:           ({ notes, ...rest }) => sa.addTicket({ ...rest, body: notes }),
  sa_get_ticket:           (i) => sa.getTicket(i),
  sa_set_billing_defaults: (i) => sa.setClientBillingDefaults(i),
  sa_list_resources:       ()  => sa.listSAResources(),
  sa_dispatch_job:         (i) => sa.dispatchWaitingListJob({ wlItemId: i.wl_item_id, scheduleDate: i.schedule_date, resourceId: i.resource_id }),
  sa_update_route_order:   (i) => sa.updateRouteOrder({ scheduleDate: i.schedule_date, jobIds: i.job_ids }),
  sa_fuzzy_match_client:   (i) => fuzzyMatch.runFuzzyMatchClient(i),
  sa_get_client_profile:   (i) => sa.getClientProfile(i),
  sa_get_client_notes:     (i) => sa.getClientNotes(i),

  // Scheduling
  get_crews:            (i) => scheduling.getCrews(i),
  get_waiting_list:     (i) => scheduling.getWaitingList(i),
  get_treatment_history:(i) => scheduling.getTreatmentHistory(i),
  get_weather_forecast: (i) => scheduling.getWeatherForecast(i),
  save_schedule_draft:  (i) => scheduling.saveScheduleDraft(i),
  get_schedule_draft:   (i) => scheduling.getScheduleDraft(i),
  record_decision:      (i) => scheduling.recordDecision(i),
  sync_pavement_sizes:  (i) => scheduling.syncPavementSizes(i),
};

/**
 * Dispatch a tool call to its implementation.
 * @param {string} toolName
 * @param {object} input
 * @returns {Promise<any>}
 */
export async function dispatchTool(toolName, input) {
  const handler = HANDLERS[toolName];
  if (!handler) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  logger.debug('Dispatching tool', { toolName, input });
  return handler(input);
}
