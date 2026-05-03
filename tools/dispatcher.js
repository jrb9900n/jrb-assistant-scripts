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
import * as m365    from './impl/m365.js';
import * as qb      from './impl/quickbooks.js';
import * as files   from './impl/files.js';
import * as github  from './impl/github.js';
import * as scripts from './impl/scripts.js';

const HANDLERS = {
  // Email / Calendar
  list_emails:          (i) => m365.listEmails(i),
  get_email:            (i) => m365.getEmail(i),
  draft_email:          (i) => m365.draftEmail(i),
  send_email:           (i) => m365.sendEmail(i),
  create_reminder:      (i) => m365.createReminder(i),
  create_calendar_event:(i) => m365.createCalendarEvent(i),

  // CRM / Finance
  qb_query:             (i) => qb.query(i),

  // Files
  save_to_onedrive:     (i) => m365.saveToOneDrive(i),
  read_from_onedrive:   (i) => m365.readFromOneDrive(i),
  list_onedrive:        (i) => m365.listOneDrive(i),
  write_file:           (i) => files.writeFile(i),

  // Code / Scripts
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
