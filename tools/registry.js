// tools/registry.js - Tool definitions (Anthropic tool format)

const SEARCH_TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web for current information, news, sports scores, stock prices, or anything that may have changed recently.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
];

const EMAIL_TOOLS = [
  {
    name: 'list_emails',
    description: 'List recent emails from the Microsoft 365 inbox. Returns sender, subject, date, snippet.',
    input_schema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Folder name (Inbox, Sent, etc.)', default: 'Inbox' },
        limit: { type: 'number', description: 'Max emails to return', default: 20 },
        unread_only: { type: 'boolean', description: 'Filter to unread only', default: false },
      },
      required: [],
    },
  },
  {
    name: 'get_email',
    description: 'Fetch the full body of a specific email by ID.',
    input_schema: {
      type: 'object',
      properties: {
        email_id: { type: 'string', description: 'Email ID from list_emails' },
      },
      required: ['email_id'],
    },
  },
  {
    name: 'draft_email',
    description: 'Create a draft email in Microsoft 365. Does NOT send - returns draft ID for review.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses' },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Plain text or HTML body' },
        cc: { type: 'array', items: { type: 'string' } },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'send_email',
    description: 'Send an existing draft or a new email. Use draft_email first for review flows.',
    input_schema: {
      type: 'object',
      properties: {
        draft_id: { type: 'string', description: 'Draft ID to send (from draft_email)' },
        to: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: [],
    },
  },
  {
    name: 'create_reminder',
    description: 'Create a calendar reminder or task in Microsoft 365.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        due_date: { type: 'string', description: 'ISO 8601 datetime' },
        notes: { type: 'string' },
      },
      required: ['title', 'due_date'],
    },
  },
  {
    name: 'create_calendar_event',
    description: 'Create a calendar event in Microsoft 365 Outlook calendar.',
    input_schema: {
      type: 'object',
      properties: {
        subject:  { type: 'string', description: 'Event title' },
        start:    { type: 'string', description: 'Start datetime ISO 8601, e.g. 2026-07-01T09:00:00' },
        end:      { type: 'string', description: 'End datetime ISO 8601, e.g. 2026-07-01T09:30:00' },
        body:     { type: 'string', description: 'Event description/notes' },
        timezone: { type: 'string', description: 'Timezone, default America/Chicago' },
      },
      required: ['subject', 'start', 'end'],
    },
  },
];

const QB_TOOLS = [
  {
    name: 'qb_query',
    description: 'Query QuickBooks for invoices, payments, customers, or P&L data.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'QBO SQL-like query string e.g. "SELECT * FROM Invoice WHERE Balance > 0"' },
      },
      required: ['query'],
    },
  },
];

const FILE_TOOLS = [
  {
    name: 'save_to_onedrive',
    description: 'Save a file to a specified OneDrive folder. Does NOT overwrite unless overwrite=true.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'OneDrive path, e.g. /Reports/Q2-2025.pdf' },
        content: { type: 'string', description: 'File content (text/base64)' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
        overwrite: { type: 'boolean', default: false },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'read_from_onedrive',
    description: 'Read a file from OneDrive. Returns content as string.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'OneDrive path to the file' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_onedrive',
    description: 'List files in an OneDrive folder.',
    input_schema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Folder path, e.g. /Reports' },
      },
      required: ['folder'],
    },
  },
];

const CODE_TOOLS = [
  {
    name: 'run_script',
    description: 'Run a local script (Node.js or Python) on this machine. Returns stdout/stderr.',
    input_schema: {
      type: 'object',
      properties: {
        script_path: { type: 'string', description: 'Absolute or relative path to script' },
        args: { type: 'array', items: { type: 'string' }, description: 'CLI arguments' },
        timeout_ms: { type: 'number', default: 30000 },
      },
      required: ['script_path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write a file to the local filesystem. Use for creating scripts, configs, or reports.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative file path' },
        content: { type: 'string' },
        overwrite: { type: 'boolean', default: false },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'github_push',
    description: 'Commit and push a file to GitHub.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo name (org/repo format or just name for default org)' },
        path: { type: 'string', description: 'File path in the repo' },
        content: { type: 'string', description: 'File content' },
        message: { type: 'string', description: 'Commit message' },
        branch: { type: 'string', default: 'main' },
      },
      required: ['path', 'content', 'message'],
    },
  },
  {
    name: 'github_read',
    description: 'Read a file from a GitHub repo.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        path: { type: 'string' },
        branch: { type: 'string', default: 'main' },
      },
      required: ['path'],
    },
  },
];

const TOOL_MAP = {
  email:   [...EMAIL_TOOLS],
  crm:     [...QB_TOOLS],
  report:  [...QB_TOOLS, ...FILE_TOOLS],
  code:    [...CODE_TOOLS, ...FILE_TOOLS],
  file:    [...FILE_TOOLS],
  general: [...EMAIL_TOOLS, ...QB_TOOLS, ...FILE_TOOLS, ...CODE_TOOLS, ...SEARCH_TOOLS],
};

export function getTools(taskType) {
  return TOOL_MAP[taskType] ?? TOOL_MAP.general;
}
