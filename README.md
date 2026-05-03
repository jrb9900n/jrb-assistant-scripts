# JRB Executive Agent

A persistent, token-efficient AI executive assistant for J.R. Boehlke, LLC.
Runs on your dedicated machine with access to M365, HubSpot, QuickBooks, GitHub, and OneDrive.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Fill in .env with your credentials

# 3. Set up Supabase tables
# Paste config/supabase_schema.sql into your Supabase SQL editor and run it

# 4. Run a task interactively
node cli.js "summarise my unread emails"
node cli.js email "draft a follow-up to any deals with no activity this week"
node cli.js crm "what invoices are past due?"

# 5. Start the scheduler (runs in background)
node scheduler/cron.js
```

---

## Architecture

```
agent/
├── core/
│   ├── agent.js       ← Main runner: model routing, agentic loop, token tracking
│   └── logger.js      ← Structured logger + Supabase token persistence
├── memory/
│   └── memory.js      ← Compressed context store + result cache (Supabase-backed)
├── tools/
│   ├── registry.js    ← Tool definitions, filtered by task type
│   ├── dispatcher.js  ← Routes tool calls to implementations
│   └── impl/
│       ├── m365.js        ← Email, Calendar, OneDrive (Microsoft Graph API)
│       ├── quickbooks.js  ← QB Online v3 API (reuses AuditMatchingEngine auth)
│       ├── hubspot.js     ← HubSpot CRM API
│       ├── github.js      ← GitHub REST API (read/push files)
│       ├── files.js       ← Local filesystem writes
│       └── scripts.js     ← Local script runner (Node.js & Python)
├── scheduler/
│   └── cron.js        ← Automated scheduled tasks (cron expressions)
├── config/
│   └── supabase_schema.sql  ← Run once to set up DB tables
├── cli.js             ← Interactive command-line interface
└── .env.example       ← Environment variable template
```

---

## Token Conservation

This agent is designed to stay lean on Anthropic token usage:

| Strategy | Implementation |
|---|---|
| **Model routing** | Haiku for simple/short tasks, Sonnet only for complex reasoning |
| **Compressed memory** | Past sessions stored as 2-4 sentence summaries (Haiku-generated), never full transcripts |
| **Tool filtering** | Only tools relevant to the task type are sent in each API call |
| **Result caching** | QB and HubSpot data cached in Supabase with TTL (1–24h) |
| **Early exit** | Cache hits skip the LLM entirely |
| **Token logging** | Every call logged to `agent_token_log`; view spend via `agent_daily_token_spend` |

To monitor spend:
```sql
SELECT * FROM agent_daily_token_spend ORDER BY day DESC LIMIT 14;
```

---

## Scheduled Tasks (default)

| Task | Schedule | Description |
|---|---|---|
| Daily email digest | 8am Mon–Fri | Triage inbox, draft urgent replies, save summary to OneDrive |
| Weekly CRM report | 7am Monday | HubSpot pipeline + QB invoices → OneDrive |
| Invoice aging check | 9am Wed & Fri | Flag overdue invoices, create draft reminder emails |

Edit `scheduler/cron.js` to add, remove, or reschedule tasks.

---

## Adding New Tools

1. Add the tool definition to `tools/registry.js` under the appropriate task type
2. Add the handler to `tools/dispatcher.js`
3. Implement the function in `tools/impl/your_tool.js`

---

## Running as a Background Service (Windows)

To keep the scheduler running after you close the terminal, run it as a Windows service using `pm2`:

```bash
npm install -g pm2
pm2 start scheduler/cron.js --name jrb-agent-scheduler
pm2 save
pm2 startup  # Follow the printed instructions to auto-start on boot
```

---

## Environment Variables

See `.env.example` for all variables. Key ones:

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `HAIKU_THRESHOLD` | Word count above which Sonnet is used (default: 500) |
| `CACHE_TTL_SECONDS` | How long to cache CRM/QB results (default: 3600) |
| `QB_REALM_ID` | Already set to `9130357265584656` (J.R. Boehlke, LLC) |

---

## M365 App Registration (one-time setup)

The agent uses application-level Graph API access (no user login required for background tasks):

1. Go to [portal.azure.com](https://portal.azure.com) → Azure Active Directory → App registrations → New registration
2. Name it `JRB Executive Agent`
3. Under **API permissions**, add Microsoft Graph → Application permissions:
   - `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `Files.ReadWrite.All`, `Tasks.ReadWrite`
4. Grant admin consent
5. Create a client secret → paste into `.env`
