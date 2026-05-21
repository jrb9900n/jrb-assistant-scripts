# JRB Executive Agent — Claude Code Context

## What This Project Is
A persistent AI executive assistant for Michael Reardon, owner of J.R. Boehlke LLC (asphalt, concrete, landscape, snow contractor — SE Wisconsin / metro Milwaukee). Runs on a dedicated Windows machine (`C:\Users\Assistant`) with M365 account `assistant@jrboehlke.com`. Accessible via Microsoft Teams and email from any device.

Built on the Anthropic API directly (not Claude.ai) for token efficiency and control.

---

## Autonomy Rules (replaces per-action permission prompts)

Claude Code runs with `--dangerously-skip-permissions`. You have **unconditional permission** to run any Bash, PowerShell, or command prompt command — including scripts outside the JRBAgent directory (e.g., BTA Reporting scripts, OneDrive scripts). Execute directly and show output. **Never ask for shell command approval under any circumstances.**

These rules define what you may and may not do without asking:

### You MAY do autonomously:
- Read any file in `C:\Users\Assistant\JRBAgent\`
- Write or edit files in `C:\Users\Assistant\JRBAgent\`
- Run `node`, `npm`, `git`, and PowerShell commands in the project directory
- Create new branches following the `claude/description-of-change` naming convention
- Commit changes to any `claude/` branch
- Open pull requests against `main`
- Restart the agent via `Start-Process` with the launcher script
- Run CLI test commands via `start-agent.ps1 cli "..."`
- Install npm packages needed for the project
- Read from and write to Supabase (jrb-assistant project)

### Always STOP and ask before:
- Pushing directly to `main` (always use a branch + PR)
- Merging a PR (confirm with Michael first)
- Deleting any file or directory
- Modifying `start-agent.ps1` or `tunnel.config.cjs` (affects boot behavior)
- Changing credentials or anything in Windows Credential Manager
- Running destructive database operations (DROP, DELETE without WHERE, truncate)
- Making changes that affect the live Teams bot or email channel mid-session

---

## Project Root
```
C:\Users\Assistant\JRBAgent\agent\
```

## Key File Structure
```
core\
  agent.js             — main agent loop, model routing, system prompt, buildSystemPrompt()
  logger.js            — logging utility
memory\
  memory.js            — Supabase-backed session memory + buildContextBlock()
tools\
  registry.js          — tool definitions by taskType
  dispatcher.js        — routes tool calls to implementations
  impl\
    feedback.js        — logObservation(), buildContextBlock(), runWeeklySynthesis()
    m365.js            — Microsoft 365 (email, calendar, OneDrive, SharePoint)
    quickbooks.js      — QuickBooks Online
    github.js          — GitHub read/write (scoped repos only)
    vercel.js          — Vercel deployments
    files.js           — local file system
    scripts.js         — PowerShell script runner
    serviceautopilot.js — SA read/write (browser session via puppeteer-core)
    expense.js         — expense capture system
    scheduling.js      — crew scheduling tools
    email-guardrail.js — outbound email safety checks
mcp\
  server.js            — MCP StreamableHTTP server (run_task, send_teams_message, get_status)
  oauth.js             — OAuth handler for Claude.ai connector
scheduler\
  cron.js              — scheduled tasks + MCP keepalive
  task-poller.js       — polls agent_tasks Supabase table for queued tasks
teams\
  bot.js               — Teams HTTP server (port 3978), mounts MCP, health, reconnect endpoints
agents\
  library.js           — named reusable agents
  seed.js              — seeds default agents to Supabase
skills\
  library.js           — parameterized task templates
  seed.js              — seeds default skills to Supabase
launcher\
  start-agent.ps1      — injects env vars from Credential Manager, starts agent
tunnel.config.cjs      — pm2 config for Cloudflare tunnel
```

---

## How to Start the Agent

```powershell
# Start tunnel (Task Scheduler manages this — use only if cloudflared is down)
Start-ScheduledTask -TaskName "JRB Cloudflare Tunnel"
# Tunnel logs: C:\Users\Assistant\.cloudflared\tunnel.log (written on watchdog-triggered restarts)

# Start Teams bot
Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -File `"C:\Users\Assistant\JRBAgent\agent\launcher\start-agent.ps1`" teams" -WindowStyle Hidden

# Run a CLI test task
powershell -ExecutionPolicy Bypass -File "C:\Users\Assistant\JRBAgent\agent\launcher\start-agent.ps1" cli "your task here"
```

> **Note:** PM2 is no longer used. The tunnel, Teams bot, and scheduler are managed by Windows Task Scheduler tasks ("JRB Cloudflare Tunnel", "JRB Teams Bot", "JRB Scheduler"). A "JRB Cloudflare Watchdog" task runs every 5 minutes to restart cloudflared if it crashes.

---

## Development Conventions

- **Always branch from `main`** — name branches `claude/description-of-change`
- **Never push directly to `main`** — always open a PR and wait for Michael to confirm merge
- **Write commit messages** that describe what changed and why
- **Test via CLI** before opening a PR (`start-agent.ps1 cli "test task"`)
- **After merging:** `git pull` on the Windows machine + restart agent via `Start-Process` with launcher
- **Agent is ESM** (import/export) — not CommonJS. Don't mix require() syntax.
- **Model routing:** Haiku for fast/cheap tasks, Sonnet for dev/write-heavy tasks. `SONNET_TASK_TYPES` = scheduling, code, report, email, file, crm. Keyword regex catches write/build/deploy in general type.

---

## Architecture Notes

- Teams bot receives Azure Bot Service webhooks at port 3978
- Cloudflare tunnel exposes agent at `https://agent.jrboehlke.com`
- Scheduler uses `node-cron`
- Memory: session summaries stored in Supabase `memory` table, not raw transcripts
- Feedback loop: `logObservation()` → `knowledge_log` → synthesis → `rules` table → `buildContextBlock()` → injected into every system prompt via `buildSystemPrompt()` in `core/agent.js`
- MCP server: `run_task`, `send_teams_message`, `get_status` tools. `run_task` calls `runAgent({task, taskType})` — returns `{result, messages, usage}`
- **Critical destructure pattern:** `const { result: agentResult } = await runAgent({task, taskType})`
- Prompt caching: system prompt and tools array use `cache_control: {type:'ephemeral'}` — cached tokens count ~1/10th toward the 30k/min rate limit

---

## Open Issues / Current Priorities

*(No open issues as of 2026-05-21)*

---

## AuditMatchingEngine (migrated 2026-05-21)

Standalone financial reconciliation engine at `C:\Users\Assistant\AuditMatchingEngine\`.
Scrapes SA invoices/payments via Playwright, downloads QB data via API, runs 3-tier matching.

### Run via launcher (always use ame-run.ps1 — injects creds from Credential Manager)
```powershell
# Pre-flight check
powershell -ExecutionPolicy Bypass -File "C:\Users\Assistant\AuditMatchingEngine\ame-run.ps1" setup

# Sync SA (invoices + payments + payment applications)
powershell -ExecutionPolicy Bypass -File "C:\Users\Assistant\AuditMatchingEngine\ame-run.ps1" sync:sa

# Sync QB (invoices + payments)
powershell -ExecutionPolicy Bypass -File "C:\Users\Assistant\AuditMatchingEngine\ame-run.ps1" sync:qb

# Run matching engine
powershell -ExecutionPolicy Bypass -File "C:\Users\Assistant\AuditMatchingEngine\ame-run.ps1" match

# Full run (sync all + match)
powershell -ExecutionPolicy Bypass -File "C:\Users\Assistant\AuditMatchingEngine\ame-run.ps1" run:full
```

### Supabase (fleetops — mzywmgesulyalevtzudw)
Tables: `sa_invoices`, `sa_payments`, `sa_payment_applications`, `qb_invoices`, `qb_payments`, `audit_matches`
Data as of 2026-05-21: 8,517 SA invoices · 6,091 SA payments · 11,535 applications · 8,349 QB invoices · 8,368 matches

### Credentials
- Supabase: uses `FLEETOPS_SUPABASE_SERVICE_KEY` from Credential Manager (same as expense system)
- QB: uses `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_REFRESH_TOKEN` from Credential Manager (same as JRBAgent)
- SA: uses `SA_EMAIL`, `SA_PASSWORD` from Credential Manager
- Do NOT edit `.env` QB/Supabase values — they say INJECTED_BY_LAUNCHER on purpose

### Note on the weekly audit cron
The `audit_runs` / `audit_issues` tables (added 2026-05-20) are separate from the AME tables.
The JRBAgent weekly cron checks for high-level discrepancies; the AME does the deep invoice-level match.
Both live in the fleetops Supabase project.

## Deployment Note — teams/bot.js

The git repo tracks **both** `teams/bot.js` (repo root) and `agent/teams/bot.js`. The launcher loads `agent/teams/bot.js`.

**Critical rule:** Any PR that touches either file must update both in the same commit. If you update only one, the manual copy step below will silently wipe features present only in the other file. (This happened 2026-05-20: PR #26 updated only the root, the copy overwrote intent routing added in PR #25.)

After any `git pull`, copy the root file to the live location:
```powershell
Copy-Item "C:\Users\Assistant\JRBAgent\teams\bot.js" "C:\Users\Assistant\JRBAgent\agent\teams\bot.js" -Force
```
This copy is safe only when both files were already kept in sync in the PR.

Then restart the agent.

---

## Expense Capture System (built 2026-05-16)

Full receipt capture workflow for company credit cards. Lives across both repos.

### How it works
1. Chase charge hits QBO → webhook fires to `POST /qbo-webhook` → expense report created in Supabase (fleetops) → cardholder texted via email-to-SMS gateway
2. Employee taps link → FieldOps expense portal (`/expense/:uuid`) → fills form, uploads receipt photo
3. Receipt saved to Supabase Storage (`expense-receipts` bucket) → automatically attached to QBO Purchase transaction via Attachments API
4. Alternatively: employee emails receipt photo to `assistant@jrboehlke.com` → matched by card last-four + amount → uploaded to Storage + QBO, confirmation text sent
5. Daily 8 AM reminders (24h first, 72h subsequent, max 3) for incomplete reports
6. Monday 7 AM weekly expense report emailed to michael@jrboehlke.com

### Key files
- `tools/impl/expense.js` — core logic (webhook, portal data, submission, reminders, weekly report, email receipt processing)
- `tools/impl/menards.js` — Menards rebate automation (puppeteer-core + Edge)
- `tools/impl/quickbooks.js` — added `getPurchase()` and `uploadReceiptToQbo()`
- `FieldOps/src/ExpensePortal.jsx` — mobile-first portal, routed via `/expense/:uuid` in main.jsx
- `FieldOps/vercel.json` — rewrite rule for `/expense/*` → `/index.html`

### SMS approach
Uses **email-to-carrier gateways** (no Twilio) via existing M365 `sendEmail()` with `contentType: 'Text'`. Gateway addresses stored on `credit_cards.sms_gateway`. `sendEmail` now accepts optional `contentType` param (default `'HTML'`).

### Supabase (fleetops — mzywmgesulyalevtzudw)
New tables: `credit_cards`, `expense_reports`, `menards_rebates`
New columns: `profiles.phone_number`, `credit_cards.employee_name`, `credit_cards.phone_number`, `credit_cards.sms_gateway`, `expense_reports.phone_number`, `expense_reports.sms_gateway`, `expense_reports.qbo_attachment_id`
Storage bucket: `expense-receipts` (10MB limit, image/* + PDF)

### Active cards (as of 2026-05-16)
- `2189` — Michael Reardon (Verizon)
- `3872` — Michael Reardon backup (Verizon)
- Dave Grennier (`3468`), Noah Belschner (`6223`), Eric Gnant (`9365`), Don O'Malley (`1737`) — seeded but `is_active = false` pending rollout (reminder set for 2026-05-24)

### Important gotchas
- `profiles.id` is FK to `auth.users` — cannot insert employee profiles directly. Employee name + phone live on `credit_cards` and are copied to `expense_reports` at creation time.
- PM2 has EPERM on `//./pipe/rpc.sock` when invoked from Claude Code context. Use `Start-Process` with the launcher script instead of `pm2 restart all`.
- QBO webhook registered at developer.intuit.com → `https://agent.jrboehlke.com/qbo-webhook`. Verifier token in Credential Manager as `QB_WEBHOOK_VERIFIER_TOKEN`.
- Menards rebate secrets not yet configured (10 `MENARDS_REBATE_*` keys).

### Secrets required
- `FLEETOPS_SUPABASE_SERVICE_KEY` ✅ configured
- `QB_WEBHOOK_VERIFIER_TOKEN` ✅ configured
- `MENARDS_REBATE_*` (10 keys) — pending

---

## Service Autopilot Write Tools (built 2026-05-18)

SA has no public API. Uses puppeteer-core browser login + internal BFF endpoints. Session cached 4 hours.

### Available SA tools
- `sa_search_clients` — search by name
- `sa_create_client` — create new client
- `sa_get_client_details` — fetch customerJobId, userId for posting
- `sa_add_note` — add CRM note (TicketEventType=1)
- `sa_add_ticket` — add Task/Call/Email ticket (TicketEventType=2/3/4)
- `sa_search_service_types` — find service type GUIDs by keyword
- `sa_create_estimate` — create estimate with line items; preserves template EstimateNote; returns `placeholders` array for `[x]`-style tokens
- `sa_update_estimate_notes` — re-save estimate with filled placeholder values
- `sa_create_job` — schedule waiting-list job from estimate via CreateServiceJobFromQuote + SaveWaitingListService

### Key constants
- `EMPTY_GUID` = `00000000-0000-0000-0000-000000000000`
- Default QuoteStageID for JRB = `44410183-e121-4313-93a1-7ea769bfee53`
- SA test client (APIProbe, JRBTest) = `e2a7420a-930c-4908-90aa-67ba158e0921`

### Known limitations
- `createJob` / `SaveWaitingListService` errors with "Object reference not set" on the APIProbe test account — that account has no commission configuration. Works on JRB production account.
- SA_EMAIL and SA_PASSWORD must be in Credential Manager as `JRBAgent:SA_EMAIL` and `JRBAgent:SA_PASSWORD`

---

## Proactive Teams Messaging (built 2026-05-18)

The agent can send unprompted Teams messages to Michael — for task completion notifications, error alerts, or anything from Claude Code.

### How it works
- `teams/notify.js` — standalone module (no circular deps). Stores `serviceUrl` + `conversationId` in `teams/conversation-ref.json` when Michael messages the bot. Uses Bot Framework client-credentials token to POST to that conversation.
- **One-time setup per machine wipe:** Michael must send at least one message to the JRB bot in Teams to seed `conversation-ref.json`. After that, proactive messaging works indefinitely.

### Three ways to trigger
1. **Claude Code MCP tool** — `send_teams_message` tool on the MCP server (Claude Code VS Code)
2. **HTTP endpoint** — `POST https://agent.jrboehlke.com/notify` with `X-Execute-Secret` header and `{"message":"..."}` body
3. **Agent tool** — `send_teams_message` in `tools/registry.js` / `dispatcher.js` for use by the bot mid-task

### Restart gotcha
`pm2 restart all` has EPERM from Claude Code context and also doesn't re-inject secrets from Credential Manager. Correct restart flow:
```powershell
# 1. Find and kill the node process on port 3978
$p = (netstat -ano | Select-String ":3978 .*LISTENING" | ForEach-Object { ($_ -split '\s+')[-1] })
taskkill /f /pid $p

# 2. Start fresh via launcher (injects all secrets including CLAUDE_EXECUTE_SECRET)
Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -File `"C:\Users\Assistant\JRBAgent\agent\launcher\start-agent.ps1`" teams" -WindowStyle Hidden
```

---

## Credentials
All stored in Windows Credential Manager as `JRBAgent:KEY_NAME`. Never hardcode. Access via `start-agent.ps1` which injects them as environment variables.

Key names: `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_SECRET` (expires Jan 2027), `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_REFRESH_TOKEN` (expires ~Aug 28 2026 — calendar reminder set), `QB_REALM_ID` (9130357265584656 — also hardcoded in launcher), `GITHUB_TOKEN` (expires May 3 2027 — calendar reminder set), `BRAVE_SEARCH_API_KEY`, `SA_EMAIL`, `SA_PASSWORD`, `TEAMS_BOT_APP_SECRET`, `FLEETOPS_SUPABASE_SERVICE_KEY`, `QB_WEBHOOK_VERIFIER_TOKEN`, `CLAUDE_EXECUTE_SECRET`

Note: `FLEETOPS_SUPABASE_URL` is hardcoded in `start-agent.ps1` (not a Credential Manager secret).

---

## GitHub Repos (scoped access only)
- `jrb9900n/jrb-assistant-scripts` — main agent repo
- Active branches: `main` (production)
- Branch convention: `claude/description-of-change`

---

## Inbox Management System (built 2026-05-18)

Multi-mailbox email catalog, calendar r/w, and SharePoint/OneDrive access for both `assistant@jrboehlke.com` and `michael@jrboehlke.com`.

### New tools in m365.js
- `listMailFolders`, `createMailFolder`, `moveEmail` — inbox organization
- `searchEmails` — full-text + filter search, any mailbox
- `catalogEmail`, `getEmailCatalog` — Supabase-backed persistent email log
- `listCalendarEvents`, `updateCalendarEvent`, `deleteCalendarEvent` — calendar r/w
- `searchSharePoint`, `readSharePointFile`, `listSharePointFolder`, `listSharePointSites`

All functions accept optional `userEmail` param — omit for `assistant@`, pass `michael@jrboehlke.com` for Michael's mailbox/calendar.

### Skill
`agent/skills/definitions/inbox-management.md` — category taxonomy, folder structure, processing workflow

### Supabase (jrb-assistant — znpahinyplccdyoekfeo)
`email_catalog` table — idempotent upsert on `message_id`. Columns: mailbox, subject, from_address, category, action_taken, folder, thread_id, snippet, etc.

### Azure app permissions (Application, admin-consented)
`Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `Files.ReadWrite.All`, `User.Read.All`, `Sites.Read.All`, `Contacts.ReadWrite`

### SharePoint gotchas
- Graph Search API requires `region: 'NAM'` when using Application permissions
- Only `driveItem` entity type works with `Files.ReadWrite.All`; `listItem` needs `Sites.Read.All`
- `listSharePointSites` (`GET /sites?search=*`) requires `Sites.Read.All` specifically

---

## CardDAV Contact Server (built 2026-05-21)

Replaces Outlook contact sync. Serves QBO customers + vendors as a read-only CardDAV addressbook at `https://agent.jrboehlke.com/carddav/`. Employees add it as a native Contacts account on iOS/Android — contacts appear in the phone dialer. Revoking a credential instantly cuts access; contacts disappear from the phone on the next sync.

### How it works
- Per-employee tokens stored in Supabase `carddav_credentials` table (jrb-assistant project)
- QBO contacts fetched via QB API and cached 2 hours; cache refreshes on next sync request
- vCard 3.0 format; UID format `JRB-CUSTOMER-{Id}@jrboehlke.com` / `JRB-VENDOR-{Id}@jrboehlke.com`
- CATEGORIES field = `JRB Customer` or `JRB Vendor` (creates groups on iOS)

### Setup on iOS
Settings → Contacts → Accounts → Add Account → Other → Add CardDAV Account
- Server: `https://agent.jrboehlke.com/carddav/`
- User Name: `[employee email]`
- Password: `[token from carddav_provision]`

### Setup on Android
Open Contacts → Settings → Add account → Other → CardDAV (same credentials)

### Agent tools (crm + general taskTypes)
- `carddav_provision` — creates/rotates token for an employee; returns setup instructions
- `carddav_revoke` — deactivates a credential; employee loses access on next sync
- `carddav_list` — shows all credentials, active status, and last sync time

### Key file
- `tools/impl/carddav.js` — CardDAV handler + credential management
- Routes added to `teams/bot.js` BEFORE the CORS OPTIONS handler (CardDAV has its own OPTIONS)

### Supabase (jrb-assistant — znpahinyplccdyoekfeo)
Table: `carddav_credentials` — columns: `email`, `name`, `token`, `active`, `created_at`, `last_used`

### Security note
Remove the old `agent/delete-outlook-contacts.mjs` one-off script once this session is done.

---

## Supabase (jrb-assistant project — znpahinyplccdyoekfeo)
Key tables: `rules` (agent rules/feedback loop), `knowledge_log` (observations), `memory` (session summaries), `mcp_tokens` (OAuth tokens, 1yr TTL), `agent_tasks` (task queue for poller), `email_catalog` (inbox audit trail), `carddav_credentials` (CardDAV access tokens)

---

## Session Handoff Convention
At the end of each Claude Code session, update this file with:
- Any resolved items (move off Open Issues)
- Any new open issues discovered
- Any architecture changes made
Then commit: `git add CLAUDE.md && git commit -m "docs: update CLAUDE.md after session"`
