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
    description: 'List recent emails from a Microsoft 365 inbox. Defaults to assistant inbox. Pass userEmail to access another mailbox (e.g. michael@jrboehlke.com).',
    input_schema: {
      type: 'object',
      properties: {
        folder:     { type: 'string', description: 'Folder name (Inbox, Sent, etc.)', default: 'Inbox' },
        limit:      { type: 'number', description: 'Max emails to return', default: 20 },
        unread_only:{ type: 'boolean', description: 'Filter to unread only', default: false },
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
        email_id: { type: 'string', description: 'Email ID from list_emails or search_emails' },
      },
      required: ['email_id'],
    },
  },
  {
    name: 'search_emails',
    description: 'Search emails in any mailbox by keyword, sender, or date range. Pass userEmail for Michael\'s mailbox.',
    input_schema: {
      type: 'object',
      properties: {
        userEmail:  { type: 'string', description: 'Mailbox to search. Omit for assistant inbox, use michael@jrboehlke.com for Michael.' },
        query:      { type: 'string', description: 'Full-text search string' },
        from:       { type: 'string', description: 'Filter by sender email address' },
        subject:    { type: 'string', description: 'Filter by subject keyword' },
        afterDate:  { type: 'string', description: 'ISO 8601 date — only emails after this date' },
        beforeDate: { type: 'string', description: 'ISO 8601 date — only emails before this date' },
        folder:     { type: 'string', description: 'Restrict to a specific folder ID or name' },
        limit:      { type: 'number', description: 'Max results', default: 20 },
      },
      required: [],
    },
  },
  {
    name: 'draft_email',
    description: 'Create a draft email in Microsoft 365. Does NOT send — returns draft ID for review.',
    input_schema: {
      type: 'object',
      properties: {
        to:      { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses' },
        subject: { type: 'string' },
        body:    { type: 'string', description: 'Plain text or HTML body' },
        cc:      { type: 'array', items: { type: 'string' } },
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
        to:       { type: 'array', items: { type: 'string' } },
        subject:  { type: 'string' },
        body:     { type: 'string' },
      },
      required: [],
    },
  },
  {
    name: 'list_mail_folders',
    description: 'List all mail folders in a mailbox. Returns folder IDs, names, and item counts.',
    input_schema: {
      type: 'object',
      properties: {
        userEmail: { type: 'string', description: 'Mailbox owner. Omit for assistant, use michael@jrboehlke.com for Michael.' },
      },
      required: [],
    },
  },
  {
    name: 'create_mail_folder',
    description: 'Create a new mail folder in a mailbox. Optionally nest under a parent folder.',
    input_schema: {
      type: 'object',
      properties: {
        name:           { type: 'string', description: 'Folder display name' },
        userEmail:      { type: 'string', description: 'Mailbox owner. Omit for assistant.' },
        parentFolderId: { type: 'string', description: 'Parent folder ID from list_mail_folders (omit for top-level)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'move_email',
    description: 'Move an email to a different folder. Use list_mail_folders to get destination folder IDs.',
    input_schema: {
      type: 'object',
      properties: {
        email_id:             { type: 'string', description: 'Email ID to move' },
        destination_folder_id:{ type: 'string', description: 'Destination folder ID from list_mail_folders' },
        userEmail:            { type: 'string', description: 'Mailbox owner. Omit for assistant.' },
      },
      required: ['email_id', 'destination_folder_id'],
    },
  },
  {
    name: 'catalog_email',
    description: 'Log an email to the persistent catalog in Supabase with a category and action taken. Use after processing any significant email.',
    input_schema: {
      type: 'object',
      properties: {
        email_id:     { type: 'string', description: 'Email ID to catalog' },
        userEmail:    { type: 'string', description: 'Mailbox owner. Omit for assistant.' },
        category:     { type: 'string', description: 'Category: invoice, quote_request, crew, vendor, customer, admin, personal, spam, other' },
        action_taken: { type: 'string', description: 'Action: none, moved, archived, replied, forwarded, flagged', default: 'none' },
        action_notes: { type: 'string', description: 'Optional notes about what was done' },
        folder_name:  { type: 'string', description: 'Human-readable folder name for reference' },
      },
      required: ['email_id', 'category'],
    },
  },
  {
    name: 'get_email_catalog',
    description: 'Query the persistent email catalog. Filter by mailbox or category.',
    input_schema: {
      type: 'object',
      properties: {
        mailbox:  { type: 'string', description: 'Filter to a specific mailbox email address' },
        category: { type: 'string', description: 'Filter to a specific category' },
        limit:    { type: 'number', default: 50 },
        offset:   { type: 'number', default: 0 },
      },
      required: [],
    },
  },
  {
    name: 'create_reminder',
    description: 'Create a To Do reminder or task in Microsoft 365.',
    input_schema: {
      type: 'object',
      properties: {
        title:    { type: 'string' },
        due_date: { type: 'string', description: 'ISO 8601 datetime' },
        notes:    { type: 'string' },
      },
      required: ['title', 'due_date'],
    },
  },
  {
    name: 'create_calendar_event',
    description: 'Create a calendar event. Defaults to assistant calendar. Pass userEmail to create on Michael\'s calendar.',
    input_schema: {
      type: 'object',
      properties: {
        subject:   { type: 'string', description: 'Event title' },
        start:     { type: 'string', description: 'Start datetime ISO 8601, e.g. 2026-07-01T09:00:00' },
        end:       { type: 'string', description: 'End datetime ISO 8601, e.g. 2026-07-01T09:30:00' },
        body:      { type: 'string', description: 'Event description/notes' },
        timezone:  { type: 'string', description: 'Timezone, default America/Chicago' },
        userEmail: { type: 'string', description: 'Calendar owner. Omit for assistant, use michael@jrboehlke.com for Michael.' },
      },
      required: ['subject', 'start', 'end'],
    },
  },
  {
    name: 'list_calendar_events',
    description: 'List calendar events in a date range. Defaults to assistant calendar. Pass userEmail for Michael\'s calendar.',
    input_schema: {
      type: 'object',
      properties: {
        userEmail:     { type: 'string', description: 'Calendar owner. Omit for assistant, use michael@jrboehlke.com for Michael.' },
        startDateTime: { type: 'string', description: 'ISO 8601 start of range (defaults to now)' },
        endDateTime:   { type: 'string', description: 'ISO 8601 end of range (defaults to 30 days out)' },
        query:         { type: 'string', description: 'Optional keyword search within events' },
        limit:         { type: 'number', default: 20 },
      },
      required: [],
    },
  },
  {
    name: 'update_calendar_event',
    description: 'Update an existing calendar event (subject, time, body). Get event IDs from list_calendar_events.',
    input_schema: {
      type: 'object',
      properties: {
        event_id:  { type: 'string', description: 'Event ID from list_calendar_events' },
        userEmail: { type: 'string', description: 'Calendar owner. Omit for assistant.' },
        subject:   { type: 'string' },
        start:     { type: 'string', description: 'ISO 8601 datetime' },
        end:       { type: 'string', description: 'ISO 8601 datetime' },
        body:      { type: 'string' },
        timezone:  { type: 'string', default: 'America/Chicago' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'delete_calendar_event',
    description: 'Delete a calendar event. Get event IDs from list_calendar_events.',
    input_schema: {
      type: 'object',
      properties: {
        event_id:  { type: 'string', description: 'Event ID from list_calendar_events' },
        userEmail: { type: 'string', description: 'Calendar owner. Omit for assistant.' },
      },
      required: ['event_id'],
    },
  },
];

const TEAMS_TOOLS = [
  {
    name: 'send_teams_message',
    description: 'Send a proactive Teams message to Michael. Use this to notify him when a long-running task finishes, an error occurs mid-task, or any event worth flagging outside of the current reply. Requires that Michael has sent at least one message to the JRB bot in Teams to establish a conversation reference.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message to send to Michael in Teams.' },
      },
      required: ['message'],
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
        path:      { type: 'string', description: 'OneDrive path, e.g. /Reports/Q2-2025.pdf' },
        content:   { type: 'string', description: 'File content (text/base64)' },
        encoding:  { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
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
  {
    name: 'search_sharepoint',
    description: 'Search SharePoint/OneDrive for documents by keyword, file type, or site. Returns file names, URLs, and metadata. Use read_sharepoint_file to get content.',
    input_schema: {
      type: 'object',
      properties: {
        query:    { type: 'string', description: 'Search query string' },
        fileType: { type: 'string', description: 'Optional file type filter, e.g. "pdf", "docx", "xlsx"' },
        siteId:   { type: 'string', description: 'Optional SharePoint site ID to scope the search' },
        limit:    { type: 'number', default: 20 },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_sharepoint_file',
    description: 'Read the content of a SharePoint/OneDrive file. Get site_id, drive_id, item_id from search_sharepoint results.',
    input_schema: {
      type: 'object',
      properties: {
        site_id:  { type: 'string', description: 'SharePoint site ID from search_sharepoint' },
        drive_id: { type: 'string', description: 'Drive ID from search_sharepoint' },
        item_id:  { type: 'string', description: 'Item ID from search_sharepoint' },
      },
      required: ['site_id', 'drive_id', 'item_id'],
    },
  },
  {
    name: 'list_sharepoint_folder',
    description: 'List files and subfolders in a SharePoint site folder.',
    input_schema: {
      type: 'object',
      properties: {
        site_id:     { type: 'string', description: 'SharePoint site ID from list_sharepoint_sites' },
        folder_path: { type: 'string', description: 'Folder path relative to site root, e.g. "/Documents/Contracts". Use "/" for root.', default: '/' },
      },
      required: ['site_id'],
    },
  },
  {
    name: 'list_sharepoint_sites',
    description: 'List available SharePoint sites. Optionally filter by name keyword.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional site name keyword to filter results' },
      },
      required: [],
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
  // ── GitHub tools ─────────────────────────────────────────────────────────────
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
    description: 'Commit and push a file to a GitHub branch. Never push directly to main — always push to a claude/ branch.',
    input_schema: {
      type: 'object',
      properties: {
        repo:    { type: 'string', description: 'Repo name or owner/repo' },
        path:    { type: 'string', description: 'File path in the repo' },
        content: { type: 'string', description: 'Full file content' },
        message: { type: 'string', description: 'Commit message' },
        branch:  { type: 'string', description: 'Branch to push to — must be a claude/ branch' },
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
        body:   { type: 'string', description: 'PR description — what it does, what files changed, how to test' },
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
const SA_TOOLS = [
  {
    name: 'sa_search_clients',
    description: 'Search for clients in Service Autopilot by name. Returns matching client IDs, names, and addresses.',
    input_schema: {
      type: 'object',
      properties: {
        name:  { type: 'string', description: 'Client name or partial name to search for' },
        limit: { type: 'number', description: 'Max results to return', default: 10 },
      },
      required: ['name'],
    },
  },
  {
    name: 'sa_create_client',
    description: 'Create a new client record in Service Autopilot. For business customers, pass companyName (it becomes the SA client name). For individuals, pass firstName + lastName (client name will be "First Last"). Always pass all address fields separately.',
    input_schema: {
      type: 'object',
      properties: {
        firstName:   { type: 'string', description: 'Contact first name' },
        lastName:    { type: 'string', description: 'Contact last name' },
        companyName: { type: 'string', description: 'Company/business name — only pass for business customers. Omit for residential.' },
        address:     { type: 'string', description: 'Street address line 1 (number + street name)' },
        city:        { type: 'string', description: 'City' },
        state:       { type: 'string', description: '2-letter state abbreviation, e.g. WI' },
        zip:         { type: 'string', description: 'ZIP code' },
        email:       { type: 'string', description: 'Email address' },
        phone:       { type: 'string', description: 'Primary phone number' },
      },
      required: ['firstName', 'lastName'],
    },
  },
  {
    name: 'sa_add_note',
    description: 'Add a note to a Service Autopilot client record. Use clientId from sa_search_clients.',
    input_schema: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: 'SA Client ID (GUID) from sa_search_clients' },
        noteText: { type: 'string', description: 'Note body text' },
      },
      required: ['clientId', 'noteText'],
    },
  },
  {
    name: 'sa_search_service_types',
    description: 'Search Service Autopilot service types by name keyword. Returns serviceTypeId, name, fullPath. Use before sa_create_estimate to resolve service type IDs.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword to search, e.g. "sealcoat" or "striping"' },
        limit: { type: 'number', description: 'Max results', default: 20 },
      },
      required: ['query'],
    },
  },
  {
    name: 'sa_create_estimate',
    description: "Create a new estimate (quote) in Service Autopilot with one or more line items. Line items preserve the service type's default description; pass notes to override. Returns quoteId, line item IDs, and any [placeholder] tokens found in descriptions that need PM clarification.",
    input_schema: {
      type: 'object',
      properties: {
        clientId:      { type: 'string', description: 'SA Client ID (GUID) from sa_search_clients' },
        salesPersonId: { type: 'string', description: 'SA resource GUID for the salesperson/PM. Omit to use account default.' },
        title:         { type: 'string', description: 'Estimate title / description shown on the estimate header' },
        jobNotes:      { type: 'string', description: 'Text for the Job Notes tab — use for PM follow-up questions and job-specific notes' },
        lineItems: {
          type: 'array',
          description: 'Services to include in the estimate',
          items: {
            type: 'object',
            properties: {
              serviceTypeId: { type: 'string', description: 'SA service type GUID from sa_search_service_types' },
              rate:          { type: 'number', description: 'Unit rate in dollars' },
              qty:           { type: 'number', description: 'Quantity (default 1)' },
              notes:         { type: 'string', description: "Override the line item description. Omit to keep the service type's default description." },
            },
            required: ['serviceTypeId', 'rate'],
          },
        },
      },
      required: ['clientId', 'lineItems'],
    },
  },
  {
    name: 'sa_create_job',
    description: 'Create a scheduled job from an existing SA estimate. Supports WaitingList (unscheduled), OneTime, and Recurring job types. Returns scheduledServiceId.',
    input_schema: {
      type: 'object',
      properties: {
        quoteId:       { type: 'string', description: 'SA Quote/Estimate ID from sa_create_estimate' },
        lineItemIds:   { type: 'array', items: { type: 'string' }, description: 'Line item IDs to include in this job (from sa_create_estimate lineItems)' },
        jobType:       { type: 'string', enum: ['WaitingList', 'OneTime', 'Recurring'], description: 'Job type', default: 'WaitingList' },
        clientId:      { type: 'string', description: 'SA Client ID (GUID)' },
        customerJobId: { type: 'string', description: 'SA CustomerJobID (GUID) — omit to auto-lookup' },
        resourceIds:   { type: 'array', items: { type: 'string' }, description: 'SA resource GUIDs to assign to the job (crew/PM). Use empty array for unassigned.' },
        salesPersonId: { type: 'string', description: 'SA salesperson/PM resource GUID. Defaults to value from estimate.' },
        startDate:     { type: 'string', description: 'Target start date ISO 8601 (YYYY-MM-DD). Required for WaitingList/OneTime.' },
        completeByDate:{ type: 'string', description: 'Complete-by deadline ISO 8601 (YYYY-MM-DD). Required for WaitingList.' },
      },
      required: ['quoteId', 'lineItemIds', 'clientId'],
    },
  },
  {
    name: 'sa_add_ticket',
    description: 'Add a CRM ticket to a Service Autopilot client record. Ticket appears in the CRM TicketList. For new inbound leads use category="Estimate" (default) so it appears in the Estimate queue.',
    input_schema: {
      type: 'object',
      properties: {
        clientId:  { type: 'string', description: 'SA Client ID (GUID) from sa_search_clients' },
        subject:   { type: 'string', description: 'Ticket subject/title' },
        notes:     { type: 'string', description: 'Ticket body / details' },
        dueDate:   { type: 'string', description: 'Optional due date ISO 8601 (YYYY-MM-DD)' },
        category:  { type: 'string', description: 'Ticket category: Estimate (default), Other, Schedule_Service, Account_Issue' },
      },
      required: ['clientId', 'subject'],
    },
  },
  {
    name: 'sa_get_ticket',
    description: 'Verify a ticket was saved in Service Autopilot. Call immediately after sa_add_ticket with the returned ticketId. Returns { ticketId } if the ID is confirmed valid, or null if missing/invalid.',
    input_schema: {
      type: 'object',
      properties: {
        ticketId: { type: 'string', description: 'Ticket ID (GUID) returned by sa_add_ticket' },
      },
      required: ['ticketId'],
    },
  },
  {
    name: 'sa_set_billing_defaults',
    description: 'Set billing defaults on an existing SA client: Taxable=Tax, InvoiceDelivery=Email. Call as a separate step ~5 minutes after sa_create_client to allow SA indexing to complete. Returns { clientId, sendInvoiceBy, taxable }.',
    input_schema: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: 'SA client GUID returned by sa_create_client' },
      },
      required: ['clientId'],
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
    description: 'Get last completed treatment per keyword for a list of client names. Use before scheduling fertilization/mosquito to enforce the 14-day interval rule. Pass client_name values from get_waiting_list results.',
    input_schema: {
      type: 'object',
      properties: {
        client_names: { type: 'array', items: { type: 'string' }, description: 'List of client names exactly as returned by get_waiting_list (e.g. ["Jim Trubshaw", "Peter Wagner"])' },
        service_keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to match against service name, e.g. ["app 1","app 2","app 3"]' },
      },
      required: ['client_names'],
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
  email:      [...EMAIL_TOOLS, ...TEAMS_TOOLS],
  crm:        [...QB_TOOLS, ...SA_TOOLS],
  report:     [...QB_TOOLS, ...FILE_TOOLS, ...TEAMS_TOOLS],
  code:       [...CODE_TOOLS, ...FILE_TOOLS, ...TEAMS_TOOLS],
  file:       [...FILE_TOOLS, ...TEAMS_TOOLS],
  scheduling: [...SCHEDULING_TOOLS, ...TEAMS_TOOLS],
  calendar:   [...EMAIL_TOOLS.filter(t => t.name.includes('calendar') || t.name.includes('reminder')), ...TEAMS_TOOLS],
  sharepoint: [...FILE_TOOLS.filter(t => t.name.includes('sharepoint')), ...FILE_TOOLS.filter(t => t.name.includes('onedrive')), ...TEAMS_TOOLS],
  general:    [...EMAIL_TOOLS, ...QB_TOOLS, ...SA_TOOLS, ...FILE_TOOLS, ...CODE_TOOLS, ...SEARCH_TOOLS, ...VERCEL_TOOLS, ...TEAMS_TOOLS],
};

export function getTools(taskType) {
  return TOOL_MAP[taskType] ?? TOOL_MAP.general;
}
