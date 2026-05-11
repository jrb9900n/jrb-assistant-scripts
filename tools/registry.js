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
    description: 'Write a file to the local filesystem at C:\\Users\\Assistant\\JRBAgent\\. Use for creating scripts, configs, or reports.',
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
  // â”€â”€ GitHub tools â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    name: 'github_read',
    description: 'Read a file from an approved GitHub repo. Approved repos: jrb-assistant-scripts, FleetOps, FieldOps, AuditMatchingEngine.',
    input_schema: {
      type: 'object',
      properties: {
        repo:   { type: 'string', description: 'Repo name (e.g. "jrb-assistant-scripts") or owner/repo format' },
        path:   { type: 'string', description: 'File path in the repo, e.g. "tools/impl/github.js"' },
        branch: { type: 'string', description: 'Branch name', default: 'main' },
      },
      required: ['path'],
    },
  },
  {
    name: 'github_list',
    description: 'List files and directories in a GitHub repo path.',
    input_schema: {
      type: 'object',
      properties: {
        repo:   { type: 'string', description: 'Repo name or owner/repo' },
        path:   { type: 'string', description: 'Directory path (empty string for root)', default: '' },
        branch: { type: 'string', default: 'main' },
      },
      required: [],
    },
  },
  {
    name: 'github_create_branch',
    description: 'Create a new branch in a GitHub repo. Branch name must start with "claude/". Always do this before pushing any code.',
    input_schema: {
      type: 'object',
      properties: {
        repo:        { type: 'string', description: 'Repo name or owner/repo' },
        branch:      { type: 'string', description: 'New branch name, must start with "claude/" e.g. "claude/invoice-export"' },
        from_branch: { type: 'string', description: 'Source branch to create from', default: 'main' },
      },
      required: ['branch'],
    },
  },
  {
    name: 'github_push',
    description: 'Commit and push a file to a GitHub branch. Never push directly to main â€” always push to a claude/ branch.',
    input_schema: {
      type: 'object',
      properties: {
        repo:    { type: 'string', description: 'Repo name or owner/repo' },
        path:    { type: 'string', description: 'File path in the repo' },
        content: { type: 'string', description: 'Full file content' },
        message: { type: 'string', description: 'Commit message' },
        branch:  { type: 'string', description: 'Branch to push to â€” must be a claude/ branch' },
      },
      required: ['path', 'content', 'message', 'branch'],
    },
  },
  {
    name: 'github_open_pr',
    description: 'Open a Pull Request from a claude/ branch into main. Call this when code is ready for Michael to review.',
    input_schema: {
      type: 'object',
      properties: {
        repo:   { type: 'string', description: 'Repo name or owner/repo' },
        title:  { type: 'string', description: 'PR title in plain English' },
        body:   { type: 'string', description: 'PR description â€” what it does, what files changed, how to test' },
        branch: { type: 'string', description: 'The claude/ branch to merge from' },
        base:   { type: 'string', description: 'Base branch to merge into', default: 'main' },
      },
      required: ['title', 'body', 'branch'],
    },
  },
  {
    name: 'github_merge_pr',
    description: 'Merge an approved Pull Request. Only call this after Michael has explicitly approved the PR.',
    input_schema: {
      type: 'object',
      properties: {
        repo:          { type: 'string', description: 'Repo name or owner/repo' },
        pr_number:     { type: 'number', description: 'PR number to merge' },
        merge_message: { type: 'string', description: 'Optional merge commit message' },
      },
      required: ['pr_number'],
    },
  },
  {
    name: 'github_list_prs',
    description: 'List open (or closed) Pull Requests in a repo.',
    input_schema: {
      type: 'object',
      properties: {
        repo:  { type: 'string', description: 'Repo name or owner/repo' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' },
      },
      required: [],
    },
  },
];


const VERCEL_TOOLS = [
  {
    name: 'vercel_api',
    description: 'Manage Vercel deployments, domains, and environment variables. Projects: fleet-ops (FleetOps app), fieldops (FieldOps app). Actions: list_projects, list_deployments, get_deployment, redeploy, add_domain, list_domains, set_env, get_env.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_projects', 'list_deployments', 'get_deployment', 'redeploy', 'add_domain', 'list_domains', 'set_env', 'get_env'],
          description: 'Action to perform',
        },
        project:      { type: 'string', description: 'Project name (fleet-ops, fieldops) or project ID' },
        domain:       { type: 'string', description: 'Domain name for add_domain or list_domains' },
        envKey:       { type: 'string', description: 'Env var key for set_env or get_env' },
        envValue:     { type: 'string', description: 'Env var value for set_env' },
        envTarget:    { type: 'string', description: 'Deployment target: production, preview, or development' },
        deploymentId: { type: 'string', description: 'Deployment UID for get_deployment' },
      },
      required: ['action'],
    },
  },
];
const SCHEDULING_TOOLS = [
  {
    name: 'get_crews',
    description: 'Load active field crews with their capacities and work types.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_waiting_list',
    description: 'Load unscheduled jobs from the SA waiting list. Optionally filter by service keyword.',
    input_schema: {
      type: 'object',
      properties: {
        service_filter: { type: 'string', description: 'Keyword to filter by service type, e.g. "app 3" or "fert"' },
        limit: { type: 'number', description: 'Max records to return', default: 100 },
      },
      required: [],
    },
  },
  {
    name: 'get_treatment_history',
    description: 'Get last completed treatment per keyword for a list of customer IDs. Use before scheduling fertilization/mosquito to enforce the 14-day interval rule.',
    input_schema: {
      type: 'object',
      properties: {
        customer_ids: { type: 'array', items: { type: 'number' }, description: 'List of SA customer IDs' },
        service_keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to match against service name, e.g. ["app 1","app 2","app 3"]' },
      },
      required: ['customer_ids'],
    },
  },
  {
    name: 'get_weather_forecast',
    description: 'Get 14-day weather forecast for SE Wisconsin including safe_for_fert flag per day.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Number of forecast days (1-14)', default: 14 },
      },
      required: [],
    },
  },
  {
    name: 'save_schedule_draft',
    description: 'Persist a schedule draft to Supabase. The FieldOps board reads this in real time. Pass draft_id to update an existing draft.',
    input_schema: {
      type: 'object',
      properties: {
        session_id:     { type: 'string', description: 'Chat session ID' },
        directive:      { type: 'string', description: 'The scheduling instruction from Michael' },
        week_start:     { type: 'string', description: 'ISO date of the Monday for this week' },
        schedule_data:  { type: 'object', description: 'Schedule data: { days: { "YYYY-MM-DD": { "Crew Name": [...jobs] } }, summary: "..." }' },
        draft_id:       { type: 'string', description: 'Existing draft ID to update (omit to create new)' },
      },
      required: ['session_id', 'directive', 'schedule_data'],
    },
  },
  {
    name: 'get_schedule_draft',
    description: 'Load an existing schedule draft by session_id or draft_id.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Chat session ID' },
        draft_id:   { type: 'string', description: 'Specific draft ID' },
      },
      required: [],
    },
  },
];

const TOOL_MAP = {
  email:      [...EMAIL_TOOLS],
  crm:        [...QB_TOOLS],
  report:     [...QB_TOOLS, ...FILE_TOOLS],
  code:       [...CODE_TOOLS, ...FILE_TOOLS],
  file:       [...FILE_TOOLS],
  scheduling: [...SCHEDULING_TOOLS],
  general:    [...EMAIL_TOOLS, ...QB_TOOLS, ...FILE_TOOLS, ...CODE_TOOLS, ...SEARCH_TOOLS, ...VERCEL_TOOLS],
};

export function getTools(taskType) {
  return TOOL_MAP[taskType] ?? TOOL_MAP.general;
}
