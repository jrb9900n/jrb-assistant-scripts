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
# Start tunnel
pm2 start "C:\Users\Assistant\JRBAgent\agent\tunnel.config.cjs"

# Start Teams bot
Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -File `"C:\Users\Assistant\JRBAgent\agent\launcher\start-agent.ps1`" teams" -WindowStyle Hidden

# Run a CLI test task
powershell -ExecutionPolicy Bypass -File "C:\Users\Assistant\JRBAgent\agent\launcher\start-agent.ps1" cli "your task here"

# Note: pm2 restart all has EPERM in Claude Code context — use Start-Process with the launcher script instead
```

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
- MCP server: `run_task` calls `runAgent({task, taskType})` — returns `{result, messages, usage}`
- **Critical destructure pattern:** `const { result: agentResult } = await runAgent({task, taskType})`

---

## Open Issues / Current Priorities

1. **MCP reconnect after pm2 restart** — Claude.ai custom connector requires manual reconnect after agent restart. Workaround URL: `https://agent.jrboehlke.com/mcp-reconnect?secret=a22a678014626325ee6091d844aee5cf2cd668b3d953c953a14d1f6c326bd295`. Server now returns 404 for unknown session IDs (per MCP spec) which triggers Claude.ai auto-reinitialize in most cases.

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

## Credentials
All stored in Windows Credential Manager as `JRBAgent:KEY_NAME`. Never hardcode. Access via `start-agent.ps1` which injects them as environment variables.

Key names: `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_SECRET` (expires Jan 2027), `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_REFRESH_TOKEN` (expires ~July 2026 — calendar reminder set), `GITHUB_TOKEN` (expires every 90 days), `BRAVE_SEARCH_API_KEY`, `SA_EMAIL`, `SA_PASSWORD`, `TEAMS_BOT_APP_SECRET`, `FLEETOPS_SUPABASE_SERVICE_KEY`, `QB_WEBHOOK_VERIFIER_TOKEN`

---

## GitHub Repos (scoped access only)
- `jrb9900n/jrb-assistant-scripts` — main agent repo
- Active branches: `main` (production)
- Branch convention: `claude/description-of-change`

---

## Supabase (jrb-assistant project — znpahinyplccdyoekfeo)
Key tables: `rules` (agent rules/feedback loop), `knowledge_log` (observations), `memory` (session summaries), `mcp_tokens` (OAuth tokens, 1yr TTL), `agent_tasks` (task queue for poller)

---

## Session Handoff Convention
At the end of each Claude Code session, update this file with:
- Any resolved items (move off Open Issues)
- Any new open issues discovered
- Any architecture changes made
Then commit: `git add CLAUDE.md && git commit -m "docs: update CLAUDE.md after session"`
