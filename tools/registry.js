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
    description: 'List recent emails from a Microsoft 365 inbox. Defaults to the ASSISTANT\'s own operational inbox, NOT Michael\'s personal one. When Michael asks about "my"/"his own" email or inbox, you MUST pass userEmail: \'michael@jrboehlke.com\' explicitly — do not assume the default covers this, and never claim you lack access to his inbox.',
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
        email_id:  { type: 'string', description: 'Email ID from list_emails or search_emails' },
        userEmail: { type: 'string', description: 'Mailbox owner the email_id came from. Omit for assistant inbox, use michael@jrboehlke.com for Michael.' },
      },
      required: ['email_id'],
    },
  },
  {
    name: 'list_email_attachments',
    description: 'List attachments on an email (name, content type, size). Use before read_email_attachment to get attachment IDs. Check has_attachments on get_email/search_emails results first.',
    input_schema: {
      type: 'object',
      properties: {
        email_id:  { type: 'string', description: 'Email ID from list_emails, search_emails, or get_email' },
        userEmail: { type: 'string', description: 'Mailbox owner the email_id came from. Omit for assistant inbox, use michael@jrboehlke.com for Michael.' },
      },
      required: ['email_id'],
    },
  },
  {
    name: 'read_email_attachment',
    description: 'Download an email attachment and extract its text content. Supports PDF, plain text, CSV, and JSON -- returns supported:false with a note for other file types (images, Word/Excel docs, etc.). Use list_email_attachments first to get the attachment_id.',
    input_schema: {
      type: 'object',
      properties: {
        email_id:      { type: 'string', description: 'Email ID from list_emails, search_emails, or get_email' },
        attachment_id: { type: 'string', description: 'Attachment ID from list_email_attachments' },
        userEmail:     { type: 'string', description: 'Mailbox owner the email_id came from. Omit for assistant inbox, use michael@jrboehlke.com for Michael.' },
      },
      required: ['email_id', 'attachment_id'],
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
    description: 'Create a draft email in Microsoft 365. Does NOT send — returns draft ID for review. Defaults to the assistant\'s own mailbox; pass userEmail: "michael@jrboehlke.com" to create the draft in Michael\'s mailbox instead (e.g. so he can review/send it himself).',
    input_schema: {
      type: 'object',
      properties: {
        to:        { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses' },
        subject:   { type: 'string' },
        body:      { type: 'string', description: 'Plain text or HTML body' },
        cc:        { type: 'array', items: { type: 'string' } },
        userEmail: { type: 'string', enum: ['assistant@jrboehlke.com', 'michael@jrboehlke.com'], description: 'Mailbox to create the draft in. Omit for the assistant\'s own mailbox, or pass "michael@jrboehlke.com" for Michael\'s.' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'send_email',
    description: 'Send an existing draft or a new email. Use draft_email first for review flows. If sending a draft_id, userEmail must match whichever mailbox that draft was created in.',
    input_schema: {
      type: 'object',
      properties: {
        draft_id:  { type: 'string', description: 'Draft ID to send (from draft_email)' },
        to:        { type: 'array', items: { type: 'string' } },
        subject:   { type: 'string' },
        body:      { type: 'string' },
        userEmail: { type: 'string', enum: ['assistant@jrboehlke.com', 'michael@jrboehlke.com'], description: 'Mailbox to send from. Omit for the assistant\'s own mailbox.' },
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
    name: 'run_inbox_processor',
    description: 'Run the autonomous inbox processor now on michael@jrboehlke.com. Fetches unread emails, classifies each as needs_reply/fyi/marketing, moves to folders, creates draft replies for needs_reply emails, and sends Teams alerts for hot items. Use when Michael asks to "process inbox", "check my email", "triage inbox", or "run the inbox processor".',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_email_triage',
    description: 'Query the email_triage table — shows already-processed emails from michael@jrboehlke.com with bucket (needs_reply/fyi/marketing), category, intent, and draft status. Use to answer "what did I get today", "anything I need to reply to", "what needs a response".',
    input_schema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: 'How many hours back to look (default: 24)', default: 24 },
        bucket: { type: 'string', description: 'Filter to needs_reply, fyi, or marketing' },
      },
      required: [],
    },
  },
  {
    name: 'send_draft_reply',
    description: 'Send a draft reply that was saved by the inbox processor. Use when Michael says "send it", "send the draft to [name]", or "go ahead and send".',
    input_schema: {
      type: 'object',
      properties: {
        draft_id: { type: 'string', description: 'Draft ID from email_triage.draft_id' },
      },
      required: ['draft_id'],
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
    description: 'Create a calendar event, one-off or recurring. Defaults to Michael\'s calendar. Pass userEmail to create on a different calendar (e.g. assistant@jrboehlke.com).',
    input_schema: {
      type: 'object',
      properties: {
        subject:   { type: 'string', description: 'Event title' },
        start:     { type: 'string', description: 'Start datetime ISO 8601, e.g. 2026-07-01T09:00:00. For a recurring event, this is the first occurrence.' },
        end:       { type: 'string', description: 'End datetime ISO 8601, e.g. 2026-07-01T09:30:00' },
        body:      { type: 'string', description: 'Event description/notes' },
        timezone:  { type: 'string', description: 'Timezone, default America/Chicago' },
        userEmail: { type: 'string', description: 'Calendar owner. Omit for Michael\'s calendar (the default), pass assistant@jrboehlke.com for the assistant\'s own calendar.' },
        recurrenceDaysOfWeek: {
          type: 'array', items: { type: 'string', enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] },
          description: 'Omit for a one-off event. If set, creates a weekly recurring series on these days of the week with no end date.',
        },
        recurrenceStartDate: { type: 'string', description: 'YYYY-MM-DD. Only used with recurrenceDaysOfWeek; defaults to the date portion of start.' },
        categories: { type: 'array', items: { type: 'string' }, description: 'Outlook category tags. Use ["JRB Block Schedule"] ONLY for a recurring President-schedule policy block -- never for a real meeting/appointment, since that exact tag makes calendar_change_watch silently treat it as scaffolding rather than a real calendar item.' },
      },
      required: ['subject', 'start', 'end'],
    },
  },
  {
    name: 'list_calendar_events',
    description: 'List calendar events in a date range. Defaults to Michael\'s calendar. Pass userEmail for a different calendar (e.g. assistant@jrboehlke.com). Always check this before claiming a time is free/conflict-free -- do not assume a calendar is clear without calling this first.',
    input_schema: {
      type: 'object',
      properties: {
        userEmail:     { type: 'string', description: 'Calendar owner. Omit for Michael\'s calendar (the default), pass assistant@jrboehlke.com for the assistant\'s own calendar.' },
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
        userEmail: { type: 'string', description: 'Calendar owner. Omit for Michael\'s calendar (the default), pass assistant@jrboehlke.com for the assistant\'s own calendar.' },
        subject:   { type: 'string' },
        start:     { type: 'string', description: 'ISO 8601 datetime' },
        end:       { type: 'string', description: 'ISO 8601 datetime' },
        body:      { type: 'string' },
        timezone:  { type: 'string', default: 'America/Chicago' },
        categories: { type: 'array', items: { type: 'string' }, description: 'Replaces the event\'s Outlook category tags.' },
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
        userEmail: { type: 'string', description: 'Calendar owner. Omit for Michael\'s calendar (the default), pass assistant@jrboehlke.com for the assistant\'s own calendar.' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'list_sent_emails',
    description: 'List recently sent emails (subject, recipients, date, thread ID, snippet — no body). Use to check whether Michael already replied to someone, or to browse recent outbound mail.',
    input_schema: {
      type: 'object',
      properties: {
        userEmail: { type: 'string', description: 'Mailbox to check. Omit for assistant inbox, use michael@jrboehlke.com for Michael.' },
        limit:     { type: 'number', description: 'Max results', default: 30 },
        afterDate: { type: 'string', description: 'ISO 8601 date — only emails sent after this date' },
      },
      required: [],
    },
  },
  {
    name: 'get_sent_emails_to',
    description: 'Fetch full past sent emails (with body) to one specific recipient — use to learn Michael\'s actual writing style/tone toward that person before drafting a new reply, or to confirm exactly what was already said to them.',
    input_schema: {
      type: 'object',
      properties: {
        userEmail:        { type: 'string', description: 'Mailbox to search. Omit for assistant inbox, use michael@jrboehlke.com for Michael.' },
        recipientAddress: { type: 'string', description: 'Recipient email address to filter by' },
        limit:            { type: 'number', description: 'Max results', default: 5 },
      },
      required: ['recipientAddress'],
    },
  },
  {
    name: 'get_thread_emails',
    description: 'List every email in a conversation thread (by thread/conversation ID), newest first. Use to see the full back-and-forth on a topic before answering "what did we discuss on this thread" or "did I already reply to this."',
    input_schema: {
      type: 'object',
      properties: {
        userEmail: { type: 'string', description: 'Mailbox the thread belongs to. Omit for assistant inbox, use michael@jrboehlke.com for Michael.' },
        thread_id: { type: 'string', description: 'conversationId / thread_id, from get_email, search_emails, or list_emails' },
        limit:     { type: 'number', description: 'Max messages to return', default: 10 },
      },
      required: ['thread_id'],
    },
  },
  {
    name: 'create_reply_draft',
    description: 'Create a draft reply to a specific email, preserving the thread (To, Subject, references). Does NOT send — returns a draft_id for review, or pass it to send_draft_reply to send later.',
    input_schema: {
      type: 'object',
      properties: {
        userEmail: { type: 'string', description: 'Mailbox the source email is in. Omit for assistant inbox, use michael@jrboehlke.com for Michael.' },
        email_id:  { type: 'string', description: 'ID of the email being replied to, from list_emails/search_emails/get_email/get_thread_emails' },
        body:      { type: 'string', description: 'HTML body for the reply' },
      },
      required: ['email_id', 'body'],
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
    description: 'Query QuickBooks for invoices, payments, customers, or P&L data. Defaults to J.R. Boehlke, LLC — pass company="transport" for JRB Transport LLC or company="propco" for JRB Granville Propco.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'QBO SQL-like query string e.g. "SELECT * FROM Invoice WHERE Balance > 0"' },
        company: { type: 'string', enum: ['jrb', 'transport', 'propco'], description: 'Which QBO company to query. "jrb" = J.R. Boehlke, LLC (default). "transport" = JRB Transport LLC. "propco" = JRB Granville Propco.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'identify_unknown_card',
    description: 'Register an unknown Chase credit card by linking it to an employee. Updates the credit_cards record with the real last-four digits, routes any pending_identification expense stubs to that employee (sends SMS), and creates a QB CreditCard sub-account under the Chase parent. Call this when Michael says "identify card XXXX as [Employee Name]" after an unknown-card alert.',
    input_schema: {
      type: 'object',
      properties: {
        lastFour:     { type: 'string', description: '4-digit card number (digits only, e.g. "3421")' },
        employeeName: { type: 'string', description: 'Employee name matching the credit_cards table (e.g. "Steffen Jacob")' },
      },
      required: ['lastFour', 'employeeName'],
    },
  },
  {
    name: 'backfill_expenses_from_qbo',
    description: 'Fallback for gaps in Chase-poller coverage (outage, expired session, etc): pulls credit card Purchase transactions from QBO\'s bank feed for a date range and creates expense_reports + sends the SMS receipt link for any not already captured. QBO\'s bank feed lags Chase by 1-3 days, so only use this for dates far enough in the past that QBO has likely caught up (not for "right now"). Safe to re-run over the same range -- dedupes against existing expense_reports by card + date + amount, same rule the live poller uses.',
    input_schema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        endDate:   { type: 'string', description: 'YYYY-MM-DD, inclusive' },
      },
      required: ['startDate', 'endDate'],
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

const CARDDAV_TOOLS = [
  {
    name: 'carddav_provision',
    description: 'Create or rotate a CardDAV credential for an employee, granting them access to the QBO customer/vendor contacts addressbook on their phone. Returns setup instructions (server URL, username, password).',
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Employee email address (used as CardDAV username)' },
        name:  { type: 'string', description: 'Employee display name' },
      },
      required: ['email', 'name'],
    },
  },
  {
    name: 'carddav_revoke',
    description: 'Deactivate an employee\'s CardDAV credential. They lose access to the contacts addressbook on their next sync.',
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Employee email address whose credential should be revoked' },
      },
      required: ['email'],
    },
  },
  {
    name: 'carddav_list',
    description: 'List all CardDAV credentials with active status and last sync time.',
    input_schema: {
      type: 'object',
      properties: {},
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
    name: 'sa_list_tag_categories',
    description: 'List Service Autopilot tag categories (e.g. "Client Type", "General", "GC Information"). Needed to create a brand-new tag via sa_add_tag_to_client — pick the categoryId that best fits, or ask Michael which category to use.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'sa_list_tags',
    description: 'List all defined Service Autopilot client tags (the master tag list — not what\'s applied to any one client). Use to check whether a tag with a given name already exists before creating a duplicate.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'sa_get_client_tags',
    description: 'List the tags currently applied to a Service Autopilot client.',
    input_schema: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: 'SA client GUID from sa_search_clients' },
      },
      required: ['clientId'],
    },
  },
  {
    name: 'sa_add_tag_to_client',
    description: 'Apply a tag to a Service Autopilot client account, by tag name. Reuses an existing tag if one matches the name (case-insensitive); otherwise creates it — pass categoryId from sa_list_tag_categories when the tag is new (required only in that case). Verifies the tag stuck via sa_get_client_tags before returning.',
    input_schema: {
      type: 'object',
      properties: {
        clientId:   { type: 'string', description: 'SA client GUID from sa_search_clients' },
        tagName:    { type: 'string', description: 'Tag name, e.g. "Commercial - HOA"' },
        categoryId: { type: 'string', description: 'Tag category GUID from sa_list_tag_categories — required only if tagName doesn\'t already exist' },
      },
      required: ['clientId', 'tagName'],
    },
  },
  {
    name: 'sa_remove_tag_from_client',
    description: 'Remove a tag from a Service Autopilot client account (the tag definition itself is untouched, only its application to this client is removed). Verifies the removal stuck via sa_get_client_tags before returning.',
    input_schema: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: 'SA client GUID from sa_search_clients' },
        tagId:    { type: 'string', description: 'Tag GUID from sa_list_tags or sa_get_client_tags' },
      },
      required: ['clientId', 'tagId'],
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
  {
    name: 'sa_set_crackfill',
    description: 'Calculate Lbs of Crackfill (= Pavement Size × 0.015, rounded) and write it to the SA custom field. If pavementSf is provided, also writes it to the Pavement Size field — use this at client intake when you have the value. If omitted, reads Pavement Size from SA. Call after sa_set_billing_defaults whenever pavementSf is known. Returns { clientId, pavementSf, lbsCrackfill, savedViaApi } or { skipped, reason } if Pavement Size is missing/invalid.',
    input_schema: {
      type: 'object',
      properties: {
        clientId:   { type: 'string', description: 'SA client GUID' },
        pavementSf: { type: 'number', description: 'Pavement area in sq ft. If supplied, writes this value to the Pavement Size field and calculates crackfill. If omitted, reads Pavement Size from SA.' },
      },
      required: ['clientId'],
    },
  },
  {
    name: 'sa_list_resources',
    description: 'List SA dispatch board resources (crews/employees available for scheduling). Returns [{ id, name }]. Call before sa_dispatch_job to confirm the resource ID for a crew name.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'sa_dispatch_job',
    description: 'Dispatch a waiting-list job to a specific date and crew in Service Autopilot. This moves the job off the waiting list onto the schedule. Use the job_id from sa_waiting_list table (job_id column). Requires a SA resource GUID from sa_list_resources.',
    input_schema: {
      type: 'object',
      properties: {
        wl_item_id:    { type: 'string', description: 'SA waiting list item UUID (sa_waiting_list.job_id)' },
        schedule_date: { type: 'string', description: 'ISO date to schedule the job, e.g. "2026-06-16"' },
        resource_id:   { type: 'string', description: 'SA resource/crew GUID from sa_list_resources' },
      },
      required: ['wl_item_id', 'schedule_date', 'resource_id'],
    },
  },
  {
    name: 'sa_update_route_order',
    description: 'Set the stop sequence order for jobs already dispatched to the SA dispatch board. Pass the same schedule_date used during dispatch and job_ids as an ordered array (index 0 = stop 1). Call this once after all sa_dispatch_job calls complete for the day.',
    input_schema: {
      type: 'object',
      properties: {
        schedule_date: { type: 'string', description: 'ISO date, e.g. "2026-06-19"' },
        job_ids:       { type: 'array', items: { type: 'string' }, description: 'Job UUIDs in stop order — first element = stop 1' },
      },
      required: ['schedule_date', 'job_ids'],
    },
  },
  {
    name: 'sa_fuzzy_match_client',
    description: 'Compare incoming contact form data against a list of SA search results to find duplicate accounts. Handles nicknames (Deborah/Debbie, Robert/Bob, etc.), address abbreviations (St/Street, Dr/Drive), spouse/same-address matches, and normalized phone/email. Returns the best match with a recommendation: USE_EXISTING, USE_EXISTING_VERIFY, or CREATE_NEW.',
    input_schema: {
      type: 'object',
      properties: {
        incoming: {
          type: 'object',
          description: 'Contact data from the web form',
          properties: {
            firstName: { type: 'string' },
            lastName:  { type: 'string' },
            address:   { type: 'string', description: 'Street address only (no city/state/zip)' },
            email:     { type: 'string' },
            phone:     { type: 'string' },
          },
        },
        candidates: {
          type: 'array',
          description: 'SA search results from one or more sa_search_clients calls — merge all results before passing here',
          items: {
            type: 'object',
            properties: {
              clientId:  { type: 'string' },
              name:      { type: 'string', description: 'Full name as stored in SA' },
              firstName: { type: 'string' },
              lastName:  { type: 'string' },
              address:   { type: 'string' },
              email:     { type: 'string' },
              phone:     { type: 'string' },
            },
          },
        },
      },
      required: ['incoming', 'candidates'],
    },
  },
  {
    name: 'sa_get_client_profile',
    description: 'Fetch scheduling-relevant client profile from SA: office notes (gate codes, property access instructions, special crew notes), billing notes, address, and phone. Call this before scheduling a client\'s jobs to get property context. Also returns custom fields if configured in SA (CustomField1-6).',
    input_schema: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: 'SA client GUID from sa_search_clients' },
      },
      required: ['clientId'],
    },
  },
  {
    name: 'sa_get_client_notes',
    description: 'Fetch recent CRM notes and tickets for a client — call history, site visit notes, consultation records, issue logs. Returns newest first. Useful for scheduling context: know what was discussed, what issues exist, what services were requested.',
    input_schema: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: 'SA client GUID' },
        limit:    { type: 'number', description: 'Max notes to return (default 10)' },
      },
      required: ['clientId'],
    },
  },
  {
    name: 'sa_get_audit_trail',
    description: 'Pull the Service Autopilot audit trail (history log of who changed what and when) for a single record — invoice, estimate, job, payment, client, or ticket. Returns an array of history entries with a parsed `when` date. Only estimate and invoice types are confirmed working; job/payment/client/ticket are taken from SA\'s own frontend code but unverified against a live record.',
    input_schema: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'GUID of the record (invoiceId, quoteId, jobId, paymentId, clientId, or ticketId)' },
        type:     { type: 'string', description: 'Record type: estimate, invoice, job, payment, client, or ticket' },
      },
      required: ['entityId', 'type'],
    },
  },
  {
    name: 'schedule_estimate_visit',
    description: 'Schedule an in-person estimate visit with a client: looks up the client in Service Autopilot for address/phone, blocks the time on Michael\'s calendar (no invite sent to the client -- blocked time only), auto-resolves simple conflicts with the recurring block schedule (never touching PROTECTED/DEEP WORK blocks), blocks real drive time before/after the visit via Google Maps (skipped gracefully if unavailable), and adds a to-do note to the next Estimating/Proposal Production block. If the client name is ambiguous or not found in SA, returns candidates to ask Michael about instead of guessing.',
    input_schema: {
      type: 'object',
      properties: {
        clientName:      { type: 'string', description: 'Client name to search for in Service Autopilot, e.g. "John Smith"' },
        date:            { type: 'string', description: 'Visit date, YYYY-MM-DD' },
        startTime:       { type: 'string', description: 'Visit start time, 24h HH:MM, e.g. "10:00"' },
        durationMinutes: { type: 'number', description: 'Visit length in minutes', default: 30 },
        mailbox:         { type: 'string', description: 'Calendar to block time on', default: 'michael@jrboehlke.com' },
      },
      required: ['clientName', 'date', 'startTime'],
    },
  },
  {
    name: 'sa_get_invoice_status',
    description: 'Batch-fetch delivery/payment status for a known list of Service Autopilot invoice IDs. Returns, per invoice: `status` (payment state: Open/Paid/Past Due) and `action` — "Email"/"Print"/"Print & Email" reliably mean still queued/pending, not yet sent. CONFIRMED UNRELIABLE: `action: "Sent"` does NOT reliably mean "was emailed" — it just means nothing is currently pending, which SA\'s "Clear Flags" action produces just as easily as a genuine send. Live-confirmed 2026-08-19: invoice #33968 read `action: "Sent"` despite its audit trail showing only a print + a later flag-clear, zero email events ever. Do not report an invoice as "sent to the client" based on this field alone. For the full historical detail (exact timestamps, delivery/open receipts) and to confirm a genuine send vs. a flag-clear, use sa_get_audit_trail instead — it is the only reliable source for that distinction, per invoice (no known bulk-scale equivalent). Requires invoice IDs already known (e.g. from the sa_invoices Supabase table) — this does not browse/list invoices by date range.',
    input_schema: {
      type: 'object',
      properties: {
        invoiceIds: { type: 'array', items: { type: 'string' }, description: 'SA invoice GUIDs to check' },
      },
      required: ['invoiceIds'],
    },
  },
  {
    name: 'sa_get_clients_by_tag',
    description: 'Bulk-find every Service Autopilot client/lead carrying a given tag, in one paginated call — much faster than checking sa_get_client_tags per client. Useful both for reading the existing "Client Type"/"Service Line" classification tags (Residential, Commercial - Direct, Commercial - HOA, Commercial - Property Mgmt, Municipal/Government, GC Subcontract, Commercial - General Contractor; Snow, Lawn/Landscape, Paving, Concrete) and for checking who currently holds a marketing campaign tag.',
    input_schema: {
      type: 'object',
      properties: {
        tagId: { type: 'string', description: 'Tag GUID from sa_list_tags' },
        max:   { type: 'number', description: 'Max clients to return — defaults to 8000. The underlying default is 5000 and silently truncates rather than erroring, so pass an explicit higher value for any tag that might cover more than that (e.g. "Residential" alone covers 8,700+ clients).', default: 8000 },
      },
      required: ['tagId'],
    },
  },
  {
    name: 'sa_find_or_create_tag',
    description: 'Find an existing Service Autopilot tag by exact name (case-insensitive), or create it if it doesn\'t exist yet. Prefer this over sa_add_tag_to_client\'s built-in find-or-create when you need the tag\'s ID up front (e.g. to check who already holds it via sa_get_clients_by_tag) without also applying it to a client yet.',
    input_schema: {
      type: 'object',
      properties: {
        name:       { type: 'string', description: 'Tag name, e.g. "TEMP 2026 Recoat - Sealcoat Due"' },
        categoryId: { type: 'string', description: 'Tag category GUID from sa_list_tag_categories — required only if the tag doesn\'t already exist' },
      },
      required: ['name'],
    },
  },
  {
    name: 'sa_find_or_create_tag_category',
    description: 'Find an existing Service Autopilot tag category by exact name (case-insensitive), or create it if it doesn\'t exist yet. Use once to establish a new category (e.g. "Marketing Campaign") before creating campaign-specific tags under it via sa_find_or_create_tag.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Category name, e.g. "Marketing Campaign"' },
      },
      required: ['name'],
    },
  },
];

// Marketing agent tools (built 2026-08-25, create_ads_flag added 2026-08-26) —
// see tools/impl/marketing-segments.js for the segment-identification
// methodology and the three real bugs it encodes fixes for. Deliberately no
// tool here can send an email, create/modify a live campaign, or authorize
// spend directly — see TOOL_MAP.marketing's comment for why that's a hard
// structural guarantee, not just prompt discipline. create_ads_flag CAN write
// into the separate Google Ads agent's own database, but only with a source
// tag that agent's own pipeline refuses to ever auto-execute.
const MARKETING_TOOLS = [
  {
    name: 'identify_marketing_segment',
    description: 'Identify a client re-engagement segment: everyone whose most recent invoiced service in a category is older than a recency threshold (measured from today, not a fixed date), excluding anyone with a matching estimate already in the current calendar year. Read-only — makes no writes. Returns clean candidates ready to tag, a flaggedForReview list (subcontractor/GC-pass-through-looking names, roster collisions, or no live SA match found) that need a human look before inclusion, and an excludedCurrentYearEstimate list showing who was excluded and why. Known service categories: Sealcoat, Crack Fill, Striping — ask before assuming a new category name works; it must be added to SERVICE_CATEGORY_LINE_ITEMS in code first with real, verified SA line-item names.',
    input_schema: {
      type: 'object',
      properties: {
        serviceCategory: { type: 'string', description: 'One of the known service categories, e.g. "Sealcoat"' },
        recencyThresholdDays: { type: 'number', description: 'How many days since last service counts as "due" — default 365', default: 365 },
        excludeCurrentYearEstimates: { type: 'boolean', description: 'Exclude anyone with a matching estimate already this calendar year — default true, keep true unless you have a specific reason not to', default: true },
      },
      required: ['serviceCategory'],
    },
  },
  {
    name: 'create_marketing_campaign',
    description: 'Log a new marketing campaign to the audit trail (marketing_campaigns table) — call this once per campaign, right after tagging its approved client list in SA, not before. Status starts as "proposed"; use update_marketing_campaign_status to move it through approved/applied/completed/removed.',
    input_schema: {
      type: 'object',
      properties: {
        campaignName: { type: 'string', description: 'Short human-readable name, e.g. "Sealcoat Re-engagement Q3 2026"' },
        description:  { type: 'string', description: 'What this campaign targets and why' },
        saTagNames:   { type: 'array', items: { type: 'string' }, description: 'The SA tag name(s) used for this campaign' },
        saTagCategory: { type: 'string', description: 'The SA tag category name these tags live under' },
        clientCount:  { type: 'number', description: 'How many clients were tagged' },
        notes:        { type: 'string', description: 'Any additional context worth recording' },
      },
      required: ['campaignName', 'saTagNames', 'clientCount'],
    },
  },
  {
    name: 'create_ads_flag',
    description: 'Surface a genuinely new Google Ads idea into the SAME daily digest email the separate Google Ads agent already sends Michael — for ideas worth his attention that you cannot and must not act on yourself. This does NOT create or modify a live campaign, and it can never be auto-executed: it lands in that agent\'s flags table tagged with a non-native source, which its own approval pipeline structurally refuses to run (Approve is refused outright; only Reject/dismiss works, and that never executes anything). Use a stable dedupKey so re-surfacing the same idea across weeks updates one entry instead of piling up duplicates — mirrors identify_marketing_segment\'s dedup_key convention.',
    input_schema: {
      type: 'object',
      properties: {
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], description: 'How urgently this deserves Michael\'s attention' },
        subject:  { type: 'string', description: 'Short one-line summary of the idea' },
        details:  { type: 'string', description: 'What you observed and why this idea is worth raising' },
        recommendedAction: { type: 'string', description: 'What Michael (or he, relaying to the Ads agent himself) could do about it — this is informational only, never executed automatically' },
        dedupKey: { type: 'string', description: 'Stable identifier for this underlying idea in lowercase snake_case, e.g. \'retaining_walls:seasonal_budget_bump\' — reuse the identical string if you\'d otherwise re-raise the same idea later' },
      },
      required: ['priority', 'subject', 'details', 'recommendedAction'],
    },
  },
  {
    name: 'update_marketing_campaign_status',
    description: 'Update a marketing campaign\'s status as it moves through its lifecycle: proposed -> approved -> applied -> completed, or removed once its temporary tags have been cleared from SA.',
    input_schema: {
      type: 'object',
      properties: {
        id:        { type: 'string', description: 'Campaign id from create_marketing_campaign or list_marketing_campaigns' },
        status:    { type: 'string', description: 'One of: proposed, approved, applied, completed, removed' },
        notes:     { type: 'string', description: 'Optional note about this status change' },
        appliedAt: { type: 'string', description: 'ISO timestamp — set when moving to "applied"' },
        removedAt: { type: 'string', description: 'ISO timestamp — set when moving to "removed"' },
      },
      required: ['id', 'status'],
    },
  },
  {
    name: 'list_marketing_campaigns',
    description: 'List marketing campaigns from the audit trail, optionally filtered by status. Check this before proposing a new segment/campaign, to avoid re-proposing something already applied or recently removed.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: proposed, approved, applied, completed, or removed' },
        serviceCategory: { type: 'string', description: 'Filter by a keyword in the campaign description' },
      },
      required: [],
    },
  },
  {
    name: 'get_marketing_campaign',
    description: 'Fetch one marketing campaign\'s full record by id.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Campaign id' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_marketing_business_context',
    description: 'Read J.R. Boehlke\'s current marketing business-context document — services, geography, target audience, value props, customer language, competitive landscape, seasonal intelligence, and brand voice. This is the SAME document the separate Google Ads agent uses, kept as one shared source of truth. Always call this before drafting any marketing content or forming a campaign recommendation, rather than relying on assumptions from training data.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

// Website change approval-queue tools (built 2026-08-29 for the seo-advisor
// persona — see tools/impl/website-changes.js's header for the full design
// rationale). Deliberately no tool here ever writes to the live site — every
// proposed change lands in website_change_proposals for Michael to review
// with a before/after view during his Monday marketing review, mirroring
// how MARKETING_TOOLS above can propose a campaign but never send/execute
// one directly. update_website_change_proposal_status intentionally has NO
// tool entry here at all (see that function's own comment in
// tools/impl/website-changes.js) — moving a proposal to approved/applied is
// Michael's call, not something exposed for the propose-only persona to
// invoke on itself.
const WEBSITE_TOOLS = [
  {
    name: 'propose_website_change',
    description: 'Propose a change to a jrboehlke.com page — a new SEO title, meta description, structured-data value, header, or content edit. Writes a row to the website_change_proposals approval queue for Michael\'s Monday marketing review; does NOT touch the live site. Always include a specific rationale and an expected-impact note, and the exact old and new values (leave old_value blank only if genuinely unknown, and say so).',
    input_schema: {
      type: 'object',
      properties: {
        pageUrl:  { type: 'string', description: 'The exact page URL this change applies to, e.g. "https://jrboehlke.com/services/sealcoating"' },
        fieldName: { type: 'string', description: 'What is being changed, e.g. "seo_title", "meta_description", "h1", "structured_data:aggregateRating", "body_content:intro_paragraph", "alt_text"' },
        oldValue: { type: 'string', description: 'The current live value, if known — leave unset and say so in notes if you could not verify it' },
        newValue: { type: 'string', description: 'The exact proposed replacement value' },
        rationale: { type: 'string', description: 'Why this specific change — reference the actual page/business context, not generic SEO advice' },
        expectedImpact: { type: 'string', description: 'What you expect this to improve (search relevance, click-through rate, structured-data eligibility, content freshness) and how confident you are' },
        screenshotBefore: { type: 'string', description: 'Supabase Storage path/URL for a before screenshot, if one was captured — otherwise omit' },
        screenshotAfter:  { type: 'string', description: 'Supabase Storage path/URL for an after/mockup screenshot, if one was captured — otherwise omit' },
        requestedBy: { type: 'string', description: 'Which persona/agent is proposing this — defaults to "seo-advisor"' },
        notes: { type: 'string', description: 'Any additional context, caveats, or ambiguity worth flagging to Michael' },
      },
      required: ['pageUrl', 'fieldName', 'newValue', 'rationale'],
    },
  },
  {
    name: 'list_website_change_proposals',
    description: 'List website change proposals from the approval queue, optionally filtered by status or page URL. Call this before proposing a new change for a page, so you don\'t re-propose something already pending, approved, or recently rejected.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: proposed, approved, rejected, or applied' },
        pageUrl: { type: 'string', description: 'Filter by a substring match on the page URL' },
      },
      required: [],
    },
  },
  {
    name: 'get_website_change_proposal',
    description: 'Fetch one website change proposal\'s full record by id, including its current status and any review notes.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Proposal id from propose_website_change or list_website_change_proposals' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_website_page_content',
    description: 'Read a jrboehlke.com page\'s current live content (title, meta description, structured data, body text) so you can check the actual current state before drafting a proposed change. NOT YET IMPLEMENTED — this tool currently always throws a clear "not implemented" error rather than fabricating page content. If it fails, draft your proposal from whatever information is already available and say plainly that you could not independently verify the live page.',
    input_schema: {
      type: 'object',
      properties: {
        pageUrl: { type: 'string', description: 'The exact page URL to read' },
      },
      required: ['pageUrl'],
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
  {
    name: 'sync_pavement_sizes',
    description: 'Sync the Pavement Size (sq ft) custom field from SA into Supabase for all PMM waiting-list clients. Run this when pavement_sf values are missing from get_waiting_list results. Pass force=true to re-fetch all clients, not just those with null values. Returns { synced, skipped, failed, total }.',
    input_schema: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Re-fetch all PMM clients, even those already having a pavement_sf value (default false)' },
      },
      required: [],
    },
  },
  {
    name: 'record_decision',
    description: 'Persist a confirmed user decision to session memory so it survives across turns. Call this IMMEDIATELY whenever Michael confirms a specific action — a job move, a hold, an inclusion, an exclusion, a date change, or any fact he states as settled. Use plain English with enough detail to reconstruct the decision: client name, job ID if known, action, and reason. Example: "Amy Braeger (job abc123): CONFIRMED move from 6/19 to 6/18 — listing photos". Once recorded, do NOT ask about that decision again.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Current session ID (shown in Session Context)' },
        decision:   { type: 'string', description: 'Plain-English statement of the confirmed decision, e.g. "Schulze 483fd6ae: ON HOLD — 4 patches not yet complete"' },
      },
      required: ['session_id', 'decision'],
    },
  },
];

// Built 2026-08-24 as part of Phase B (calendar tiering + employee booking) —
// shared by Michael's own conversations (general/crm/scheduling) and the
// EMPLOYEE_TOOLS allow-list below. `isEmployeeRequester`/`requesterIdentity`
// are deliberately absent from book_time_with_michael's schema: dispatcher.js
// fills those in from the trusted `context.sender` object, never from
// LLM-produced JSON, so a requester can't type their way into a different
// identity or a "not an employee" claim.
const BOOKING_TOOLS = [
  {
    name: 'check_michael_availability',
    description: 'Check open windows on Michael\'s calendar for a given date and meeting length. Shows genuinely free time plus time covered by displaceable block-schedule entries as available too -- the real conflict/cap check happens at actual booking time via book_time_with_michael, not here. Never reveals subjects, tiers, or reasons for busy time, only start/end windows.',
    input_schema: {
      type: 'object',
      properties: {
        date:            { type: 'string', description: 'Date to check, YYYY-MM-DD' },
        durationMinutes: { type: 'number', description: 'Meeting length in minutes', default: 30 },
      },
      required: ['date'],
    },
  },
  {
    name: 'book_time_with_michael',
    description: 'Book a real meeting on Michael\'s calendar, sending a genuine Outlook invite to the requester. Re-checks for conflicts at the actual moment of booking -- a slot that looked open in check_michael_availability can still be declined here (e.g. an occasional block\'s displacement cap used up by another booking in between). On a decline, only ever say the time doesn\'t work and suggest trying another -- never state the real reason, subject, or block tier.',
    input_schema: {
      type: 'object',
      properties: {
        requesterName:   { type: 'string', description: 'Name of the person meeting with Michael' },
        requesterEmail:  { type: 'string', description: 'Email of the person meeting with Michael -- they will receive a real Outlook invite' },
        date:            { type: 'string', description: 'Meeting date, YYYY-MM-DD' },
        startTime:       { type: 'string', description: 'Meeting start time, 24h HH:MM, e.g. "14:00"' },
        durationMinutes: { type: 'number', description: 'Meeting length in minutes', default: 30 },
        subject:         { type: 'string', description: 'Optional meeting subject/title. Defaults to "Meeting with <requesterName>"' },
      },
      required: ['requesterName', 'requesterEmail', 'date', 'startTime'],
    },
  },
];

const FLEETSHARP_TOOLS = [
  {
    name: 'fleetsharp_get_vehicle_list',
    description: 'List every vehicle/tracker on the FleetSharp GPS account, joining device inventory (VIN, serial number, device type) with the live position snapshot (lat/lng, odometer, speed, status). Use this to resolve a vehicle name to its driverId/deviceId before calling fleetsharp_get_daily_mileage.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'fleetsharp_get_live_positions',
    description: 'Get current GPS position, speed, and odometer for every FleetSharp tracker, without the device-inventory join. Cheaper than fleetsharp_get_vehicle_list when only current location/odometer is needed.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'fleetsharp_get_daily_mileage',
    description: 'Get daily mileage and drive-activity (idle time, drive time, stop time, harsh-driving score) per vehicle over a date range from FleetSharp. Rows are keyed by driverId, not vehicle name — cross-reference with fleetsharp_get_vehicle_list or fleetsharp_get_tracker_names to label them.',
    input_schema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'Start of the range, YYYY-MM-DD' },
        endDate:   { type: 'string', description: 'End of the range, YYYY-MM-DD' },
        driverIds: { type: 'array', items: { type: 'number' }, description: 'Optional list of driverId/trackerId values to filter to specific vehicles. Omit for all vehicles.' },
      },
      required: ['startDate', 'endDate'],
    },
  },
  {
    name: 'fleetsharp_get_tracker_names',
    description: 'Get the driverId/trackerId -> display name map for all FleetSharp trackers. Use to label rows returned by fleetsharp_get_daily_mileage or fleetsharp_get_live_positions.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

// Google Ads reporting — read-only by design (see tools/impl/google-ads.js
// header). Placed in the same TOOL_MAP slots as FLEETSHARP_TOOLS (report +
// general) and deliberately left out of 'email'/'employee'/'auto_fix' — those
// task types process untrusted inbound content or run unattended, and this
// module touches a live ad-spend account.
const GOOGLE_ADS_TOOLS = [
  {
    name: 'google_ads_list_campaigns',
    description: 'List Google Ads campaigns (id, name, status, channel type, daily budget). Use to find a campaign by name before pulling its metrics, or to check whether a campaign is enabled/paused.',
    input_schema: {
      type: 'object',
      properties: {
        nameContains: { type: 'string', description: 'Optional substring filter on campaign name, e.g. "Retaining Wall".' },
      },
      required: [],
    },
  },
  {
    name: 'google_ads_get_campaign_metrics',
    description: 'Get impressions, clicks, cost, conversions, CTR, and average CPC per campaign over a date range.',
    input_schema: {
      type: 'object',
      properties: {
        nameContains: { type: 'string', description: 'Optional substring filter on campaign name.' },
        startDate: { type: 'string', description: 'Start of the range, YYYY-MM-DD' },
        endDate: { type: 'string', description: 'End of the range, YYYY-MM-DD' },
      },
      required: ['startDate', 'endDate'],
    },
  },
  {
    name: 'google_ads_get_keyword_performance',
    description: 'Get per-keyword impressions, clicks, cost, and conversions over a date range, across ad groups/campaigns.',
    input_schema: {
      type: 'object',
      properties: {
        nameContains: { type: 'string', description: 'Optional substring filter on campaign name.' },
        startDate: { type: 'string', description: 'Start of the range, YYYY-MM-DD' },
        endDate: { type: 'string', description: 'End of the range, YYYY-MM-DD' },
      },
      required: ['startDate', 'endDate'],
    },
  },
  {
    name: 'google_ads_get_lead_conversions',
    description: 'Get recorded conversions (leads) per campaign and conversion action over a date range. Only returns campaign/date rows with at least one conversion.',
    input_schema: {
      type: 'object',
      properties: {
        nameContains: { type: 'string', description: 'Optional substring filter on campaign name.' },
        startDate: { type: 'string', description: 'Start of the range, YYYY-MM-DD' },
        endDate: { type: 'string', description: 'End of the range, YYYY-MM-DD' },
      },
      required: ['startDate', 'endDate'],
    },
  },
];

// Tools available to a non-Michael Teams requester (taskType 'employee',
// added 2026-08-24 — see tools/impl/privacy-gate.js). This list is the HARD
// structural half of the privacy design: it must never include anything that
// can read Michael's mailbox, calendar, SA/QB data, files, or code — no
// prompt could talk the model into fetching that data if the tool to do so
// simply isn't in its vocabulary. Kept deliberately minimal (not even
// SEARCH_TOOLS) rather than guessing what else might be safe.
const EMPLOYEE_TOOLS = [
  {
    name: 'request_employee_approval',
    description: 'Call this whenever the requester asks for ANYTHING beyond genuinely generic, public information (e.g. company hours, phone number) — Michael\'s schedule, inbox, business data, or any judgment call. Takes no parameters. This declines the request to the requester (without confirming any private data exists) and asks Michael for approval. Do not attempt to answer a non-generic question yourself; always call this instead of guessing or refusing in your own words.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

// Escalation path to a full headless Claude Code session, gated on Michael's
// yes/no (built 2026-08-25 -- see tools/impl/claude-code-escalation.js).
// Given to every Michael-initiated taskType EXCEPT employee (privacy
// boundary -- a non-Michael requester must never be able to trigger this)
// and auto_fix (unattended; escalation needs a live Teams round-trip for
// Michael's approval, which self_heal_watcher's cron-triggered runs don't
// have).
const ESCALATION_TOOLS = [
  {
    name: 'escalate_to_claude_code',
    description: "Call this when you genuinely lack a tool to complete Michael's request -- e.g. no tool exists for an action he asked for, or the task needs broader investigation/tool orchestration than your current tool set supports. Do NOT call this for something you simply haven't tried yet, or that a clarifying question to Michael would resolve. This asks Michael for permission before anything runs; if he says no, nothing happens. Do not also explain in your own reply that you can't do this -- this tool's own response IS that explanation, sent to him verbatim.",
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Specifically what tool or capability is missing, in one or two sentences.' },
        task_to_escalate: { type: 'string', description: "A clear, self-contained restatement of the task to hand off if Michael approves -- can be more precise than Michael's original wording, but must not drop or invent scope." },
      },
      required: ['reason', 'task_to_escalate'],
    },
  },
];

// Conversational entry point into the Phase 3 auto-displacement machinery
// (see tools/impl/block-schedule-reconciler.js, built 2026-08-24) -- built
// 2026-08-25 after a live Teams request ("prioritize my BTA meeting over
// the client meeting block") got no useful help: the model had no tool to
// actually run that already-built priority-order resolution logic on
// demand, so it read raw calendar data and just kept asking Michael to
// hand-pick new slots for every displaced block instead.
const CALENDAR_CONFLICT_TOOLS = [
  {
    name: 'resolve_calendar_conflict',
    description: "Use this when Michael asks to prioritize a real meeting/event over one or more President Weekly Block Schedule blocks (e.g. \"move my BTA meeting's conflicts\", \"prioritize X over the client meeting block\"). Finds the real event by a distinctive subject substring + local date, then automatically resolves EVERY block that overlaps it in favor of the real event -- shrinking, splitting, or removing just the conflicting occurrence(s), any tier including PROTECTED/DEEP WORK, per Michael's confirmed rule that real commitments always win over block scaffolding. Do NOT manually read calendar events and ask Michael to pick new slots yourself for this kind of request -- that's exactly what this tool already does. If it reports the event wasn't found or was ambiguous, relay that back and ask Michael to clarify rather than guessing.",
    input_schema: {
      type: 'object',
      properties: {
        event_subject_contains: { type: 'string', description: "A distinctive substring of the real event's subject, e.g. 'BTA' or 'Breakthrough Academy'." },
        date: { type: 'string', description: 'The local (Central Time) date the event falls on, YYYY-MM-DD.' },
      },
      required: ['event_subject_contains', 'date'],
    },
  },
];

// Read-only access to Michael's Teams chats/channels (tools/impl/teams-read.js,
// built 2026-08-27 — Chat.Read.All/ChannelMessage.Read.All/Team.ReadBasic.All/
// Channel.ReadBasic.All admin-consented by Michael the same day). The
// underlying app-only Graph credential is tenant-wide by nature — it COULD
// read any employee's Teams messages — so teams-read.js's own allowlist
// functions (computed fresh per call, never cached) are what actually
// narrows every one of these calls to Michael's own conversations; that
// enforcement lives there, not here. This TOOL_MAP placement is a SEPARATE,
// complementary boundary: added to 'general' ONLY. Do not add it to
// 'employee' (would hand a non-Michael Teams requester a tool that reads
// Michael's private conversations — the exact leak EMPLOYEE_TOOLS/TOOL_MAP.
// employee above exists to prevent) or 'auto_fix' (unattended runs have no
// live Teams round-trip to ask Michael anything about what it finds).
const TEAMS_READ_TOOLS = [
  {
    name: 'list_michael_teams_chats',
    description: "List Michael's 1:1 and group Teams chats (id, topic, chat type, last-updated time). Call this first to find a chatId before calling get_teams_chat_messages — do not guess or invent a chatId.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_michael_teams_channels',
    description: "List the Teams channels Michael belongs to, across every team he's joined (teamId, team name, channelId, channel name). Call this first to find a teamId/channelId before calling get_teams_channel_messages — do not guess or invent these IDs.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_teams_chat_messages',
    description: "Get recent messages from one of Michael's Teams chats. chatId must come from a prior list_michael_teams_chats call — an arbitrary or guessed chatId will be rejected.",
    input_schema: {
      type: 'object',
      properties: {
        chatId: { type: 'string', description: 'A chat id returned by list_michael_teams_chats.' },
        limit: { type: 'number', description: 'Max messages to return, 1-50. Defaults to 20.' },
      },
      required: ['chatId'],
    },
  },
  {
    name: 'get_teams_channel_messages',
    description: "Get recent messages from a Teams channel Michael belongs to. teamId/channelId must come from a prior list_michael_teams_channels call — arbitrary or guessed IDs will be rejected.",
    input_schema: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: 'A team id returned by list_michael_teams_channels.' },
        channelId: { type: 'string', description: 'A channel id returned by list_michael_teams_channels.' },
        limit: { type: 'number', description: 'Max messages to return, 1-50. Defaults to 20.' },
      },
      required: ['teamId', 'channelId'],
    },
  },
];

const TOOL_MAP = {
  email:      [...EMAIL_TOOLS, ...TEAMS_TOOLS, ...ESCALATION_TOOLS],
  crm:        [...QB_TOOLS, ...SA_TOOLS, ...CARDDAV_TOOLS, ...BOOKING_TOOLS, ...ESCALATION_TOOLS],
  report:     [...QB_TOOLS, ...FILE_TOOLS, ...TEAMS_TOOLS, ...FLEETSHARP_TOOLS, ...GOOGLE_ADS_TOOLS, ...ESCALATION_TOOLS],
  code:       [...CODE_TOOLS, ...FILE_TOOLS, ...TEAMS_TOOLS, ...ESCALATION_TOOLS],
  // Unattended investigate-and-fix pass (self_heal_watcher) -- same tools as
  // 'code' minus github_merge_pr, so it can open a PR for Michael but can
  // never merge one itself, and no TEAMS_TOOLS since nothing should be
  // sending arbitrary Teams messages from an unsupervised run. Without this
  // entry, getTools() falls through to 'general', which grants both.
  auto_fix:   [...CODE_TOOLS.filter(t => t.name !== 'github_merge_pr'), ...FILE_TOOLS],
  // Non-Michael Teams requester (see EMPLOYEE_TOOLS above and
  // tools/impl/privacy-gate.js) — without this explicit entry, getTools()
  // would silently fall through to TOOL_MAP.general below, which grants
  // email/QB/SA/files/code/everything. This entry existing at all is the
  // actual privacy boundary; do not remove it or broaden its tool list
  // without re-reading why it's this narrow. BOOKING_TOOLS is the one
  // explicit carve-out Michael confirmed: an employee may check his
  // availability and book real time with him, nothing else.
  employee:   [...EMPLOYEE_TOOLS, ...BOOKING_TOOLS],
  file:       [...FILE_TOOLS, ...TEAMS_TOOLS],
  // buildSchedulingSystemPrompt (teams/bot.js) explicitly instructs the model
  // to call sa_list_resources/sa_dispatch_job/sa_update_route_order during the
  // confirm step, but those three tool schemas live only inside SA_TOOLS --
  // never duplicated into SCHEDULING_TOOLS -- so this taskType was never
  // actually given the tools its own prompt promised it. Filtered to just
  // those three (not all of SA_TOOLS) since that's the only part of SA
  // scheduling actually needs; sa_create_client/sa_create_estimate/etc.
  // belong to the 'crm' taskType, not here.
  scheduling: [...SCHEDULING_TOOLS, ...SA_TOOLS.filter(t => ['sa_list_resources', 'sa_dispatch_job', 'sa_update_route_order'].includes(t.name)), ...BOOKING_TOOLS, ...TEAMS_TOOLS, ...ESCALATION_TOOLS],
  // A message that LOOKS technical (mentions script/code/github/deploy/etc.)
  // but isn't an explicit build request (see isAmbiguousDevTask in
  // teams/router.js) used to get a fully hardcoded canned reply with no LLM
  // call at all. It now runs through runAgent() so the clarifying question is
  // contextual instead of static -- but deliberately has NO code/file/github/
  // deploy tools (unlike 'general', which does), so the model can't
  // accidentally start real dev work off an ambiguous request; it can only
  // ask a clarifying question (or escalate/notify if something's actually
  // wrong). Same "explicit narrow entry, not a TOOL_MAP.general fallthrough"
  // pattern as the 'employee'/'auto_fix' entries above.
  dev_ambiguous: [...TEAMS_TOOLS, ...ESCALATION_TOOLS],
  calendar:   [...EMAIL_TOOLS.filter(t => t.name.includes('calendar') || t.name.includes('reminder')), ...BOOKING_TOOLS, ...CALENDAR_CONFLICT_TOOLS, ...TEAMS_TOOLS, ...ESCALATION_TOOLS],
  sharepoint: [...FILE_TOOLS.filter(t => t.name.includes('sharepoint')), ...FILE_TOOLS.filter(t => t.name.includes('onedrive')), ...TEAMS_TOOLS, ...ESCALATION_TOOLS],
  // Marketing agent (built 2026-08-25). `send_email` AND `send_draft_reply`
  // are both deliberately excluded from the EMAIL_TOOLS spread — a single
  // `!== 'send_email'` filter (the original version of this line) left
  // `send_draft_reply` in, which routes to the same real Graph send call
  // (m365.sendDraft -> POST /messages/{id}/send) under a different tool
  // name, defeating the "nothing can send" guarantee entirely. This is a
  // hard structural guarantee, not just prompt discipline, matching
  // Michael's explicit requirement that every new campaign/send needs his
  // approval first. draft_email and the calendar tools (also bundled in
  // EMAIL_TOOLS) stay available. SA access is narrowed to just the
  // tag-related tools this taskType's skills actually call (identify/apply
  // only ever create/read/apply/remove tags) — the original `...SA_TOOLS`
  // spread also granted sa_create_client/sa_create_job/sa_create_estimate/
  // sa_dispatch_job/sa_set_billing_defaults/sa_update_route_order/etc,
  // write tools with no use here that directly contradict the "propose and
  // draft only" boundary this taskType's own agent persona asserts. The
  // existing Google Ads Python agent's own tactical autonomy is untouched by
  // this taskType — see tools/impl/marketing-segments.js's header. The one
  // exception is create_ads_flag (in MARKETING_TOOLS, built 2026-08-26): it
  // can WRITE into that agent's own flags table, but only ever with a
  // structurally non-native source that agent's own approval pipeline
  // refuses to execute — see tools/impl/marketing-ads-flags.js's header.
  // It cannot create/modify a campaign or spend directly. WEBSITE_TOOLS
  // (added 2026-08-29 for the seo-advisor persona, which shares this
  // taskType) has the identical structural guarantee -- no tool in it
  // writes to the live site, so there's no reason to exclude it from
  // marketing-advisor's own toolset either; both personas can propose a
  // website change if relevant to what they're working on.
  marketing:  [...SA_TOOLS.filter(t => t.name.includes('tag')), ...EMAIL_TOOLS.filter(t => t.name !== 'send_email' && t.name !== 'send_draft_reply'), ...TEAMS_TOOLS, ...MARKETING_TOOLS, ...WEBSITE_TOOLS, ...ESCALATION_TOOLS],
  general:    [...EMAIL_TOOLS, ...QB_TOOLS, ...SA_TOOLS, ...CARDDAV_TOOLS, ...BOOKING_TOOLS, ...CALENDAR_CONFLICT_TOOLS, ...FILE_TOOLS, ...CODE_TOOLS, ...SEARCH_TOOLS, ...VERCEL_TOOLS, ...TEAMS_TOOLS, ...TEAMS_READ_TOOLS, ...FLEETSHARP_TOOLS, ...GOOGLE_ADS_TOOLS, ...ESCALATION_TOOLS],
};

// Fail loudly at load time, not silently at call time, if a future rename
// inside SA_TOOLS ever drops one of the three names scheduling's toolset is
// filtered down to -- the same "prompt promises a tool the taskType doesn't
// actually have" bug this file's own scheduling comment describes fixing,
// just with a rename as the new trigger instead of an omission.
const REQUIRED_SCHEDULING_SA_TOOLS = ['sa_list_resources', 'sa_dispatch_job', 'sa_update_route_order'];
{
  const found = new Set(TOOL_MAP.scheduling.map(t => t.name));
  const missing = REQUIRED_SCHEDULING_SA_TOOLS.filter(n => !found.has(n));
  if (missing.length) {
    throw new Error(`tools/registry.js: TOOL_MAP.scheduling is missing required SA tool(s): ${missing.join(', ')} -- check SA_TOOLS for a rename.`);
  }
}

export function getTools(taskType) {
  return TOOL_MAP[taskType] ?? TOOL_MAP.general;
}
