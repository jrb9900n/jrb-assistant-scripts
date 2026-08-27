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
- Write or edit files in `C:\Users\Assistant\JRBAgent\` — but see the Worktree Convention below: never change which branch is checked out here
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

## Worktree Convention (Required)

`C:\Users\Assistant\JRBAgent` is the live deployment target — Task Scheduler
tasks (`JRB Scheduler`, `JRB Teams Bot`, and the watchdogs) run code directly
from this exact directory. **It must always stay checked out on `main`.**

Multiple Claude Code sessions share this machine concurrently. A session that
switches branches here — even briefly — can leave the live directory on the
wrong branch, mid-corruption, or missing files that only exist on `main`,
breaking production for every other session and for the live bot/scheduler.
This already happened more than once (missing `email-guardrail.js` crashed
the Teams Bot; a reverted `m365.js` silently dropped features; the Scheduler
task failed to launch twice from the same class of drift).

**Never run `git checkout`, `git switch`, or anything else that changes the
checked-out branch/HEAD in `C:\Users\Assistant\JRBAgent` itself.** Do all
feature work in an isolated worktree instead:

```powershell
git -C C:\Users\Assistant\JRBAgent worktree add C:\Users\Assistant\.worktrees\<short-name> -b claude/<branch-name> origin/main
```

Branch, commit, push, and open the PR from inside that worktree path — not
from `C:\Users\Assistant\JRBAgent`. Once the PR merges (or the branch is
abandoned), remove the worktree:

```powershell
git -C C:\Users\Assistant\JRBAgent worktree remove C:\Users\Assistant\.worktrees\<short-name>
```

A `branch_drift_check` scheduled task runs every 15 minutes specifically to
catch and safely auto-correct any violation of this rule (see
`scheduler/cron.js`) — but that's a safety net, not a substitute for
following it.

---

## Project Root
```
C:\Users\Assistant\JRBAgent\
```

> **2026-08-10: repointed from `agent\` to repo root** (`$AgentDir` inside
> `start-agent.ps1`). **2026-08-17: `agent\` subtree fully removed.** The
> 2026-08-10 repoint had only updated `$AgentDir` itself — the actual Windows
> Task Scheduler task definitions for `JRB Teams Bot`, `JRB Scheduler`, and
> `JRB Cloudflare Watchdog` still executed wrapper/watchdog scripts physically
> under `agent\launcher\`/`agent\scripts\`, and those files were never
> git-tracked. A full file-by-file comparison against root before deletion
> found real, previously-lost fixes (a missing `scheduler-wrapper.ps1`, a
> cloudflared-watchdog bug, a `$pid`-shadowing bug, a genuine CRM-intent
> routing decision in `teams/router.js`) — see PRs #260 and #261. All three
> task definitions were repointed to root (`scripts/repoint-task-scheduler-to-root.ps1`,
> requires an elevated PowerShell) and verified with clean restarts before
> `agent\` was deleted. There is now only one copy of every file — do not
> recreate a duplicate tree.

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

# Start Teams bot — prefer the registered Task Scheduler task (supervised, restarts on crash)
Start-ScheduledTask -TaskName "JRB Teams Bot"
# Direct launch (bypasses the Task Scheduler task — only if you need to run it unsupervised):
Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -File `"C:\Users\Assistant\JRBAgent\launcher\start-agent.ps1`" teams" -WindowStyle Hidden

# Run a CLI test task
powershell -ExecutionPolicy Bypass -File "C:\Users\Assistant\JRBAgent\launcher\start-agent.ps1" cli "your task here"
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
- **Model routing:** Haiku for fast/cheap tasks, Sonnet for dev/write-heavy tasks. `SONNET_TASK_TYPES` = scheduling, code, report, email, file, crm, auto_fix, general, calendar, dev_ambiguous (see "Teams Bot Agentic Behavior Fixes" section below for why `general`/`calendar`/`dev_ambiguous` were added 2026-08-26). Keyword regex still governs the remaining taskTypes not in this set.

---

## Architecture Notes

- Teams bot receives Azure Bot Service webhooks at port 3978
- Cloudflare tunnel exposes agent at `https://agent.jrboehlke.com`
- Scheduler uses `node-cron`
- Memory: session summaries stored in Supabase `memory` table, not raw transcripts (long-term, Haiku-summarized — see also short-term raw conversation memory below)
- Feedback loop: `logObservation()` → `knowledge_log` → synthesis → `rules` table → `buildContextBlock()` → injected into every system prompt via `buildSystemPrompt()` in `core/agent.js`. Also: `detectAndCaptureFeedback()` writes directly to `rules` on every Teams/email message that looks like a standing instruction (see Feedback Loop section below)
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

## Deployment Note — teams/bot.js (historical, resolved 2026-08-10)

The git repo used to track **both** `teams/bot.js` (repo root) and `agent/teams/bot.js`, with the launcher loading the `agent/` copy — requiring a manual copy step after every pull, which silently wiped features more than once when a PR only updated one side (e.g. 2026-05-20: PR #26 updated only the root, the copy overwrote intent routing added in PR #25).

**This is resolved.** The launcher now runs everything from repo root (see the Project Root note above) — there is only one `teams/bot.js` that matters going forward, and no copy step after `git pull`. Just restart the agent.

---

## Expense Capture System (built 2026-05-16)

Full receipt capture workflow for company credit cards. Lives across both repos.

### How it works
1. Chase alert email forwarded to `assistant@jrboehlke.com` → email poller (every 5 min) → `processChaseAlert()` → expense report created → **Twilio SMS** sent to cardholder within ~5 minutes of charge
2. QBO webhook (`POST /qbo-webhook`) fires separately when QBO processes the transaction → reconciles with Chase stub (updates `qbo_transaction_id`) or creates its own report if no stub exists

### Credit card expense source priority (confirmed by Michael 2026-08-18)

Three independent paths can detect the same charge: the email-forwarded Chase alert (`processChaseAlert` in `tools/impl/expense.js`), the ChasePoller browser-based transaction poller (`chase-daemon.js` in the separate `ChasePoller` repo), and the QBO webhook (`processNewPurchase` in `tools/impl/expense.js`). Priority order, highest to lowest: **1. email, 2. poller, 3. qbo**.

`expense_reports.source` (`'email' | 'poller' | 'qbo' | null`) tracks which source last supplied the authoritative vendor/amount/date. All three creation paths dedupe against the same card+amount(±$0.02)+date(±1 day) match. When a match is found, a **higher**-priority source upgrades the existing row's data (and `source` tag) rather than skipping; a source never upgrades a row already tagged with an equal-or-higher-priority source. Concretely: email always upgrades (unless already `email`); the poller upgrades only if the existing row is `qbo` or untagged; QBO never upgrades (its existing "reconcile with alertStub, only attach `qbo_transaction_id`" behavior already matches lowest priority and needed no change).
3. Employee taps SMS link → FieldOps expense portal (`/expense/:uuid`) → fills form, uploads receipt photo
4. Receipt saved to Supabase Storage (`expense-receipts` bucket) → automatically attached to QBO Purchase transaction via Attachments API
5. Alternatively: employee emails receipt photo to `assistant@jrboehlke.com` → matched by card last-four + amount → uploaded to Storage + QBO, confirmation SMS sent
6. Daily 8 AM reminders (24h first, 72h subsequent, max 3) for incomplete reports
7. Monday 7 AM weekly expense report emailed to michael@jrboehlke.com

> **QBO webhook status (2026-05-30):** Endpoint is live but has never fired in production. All 9 reports came through the Chase alert path. Entity type mismatch suspected (Chase bank feed may send `BankTransaction` not `Purchase`). Diagnostic deployed: handler now logs all entity types and sends a Teams alert for unhandled types.

### Key files
- `tools/impl/expense.js` — core logic (webhook, portal data, submission, reminders, weekly report, email receipt processing)
- `tools/impl/menards.js` — Menards rebate automation (puppeteer-core + Edge)
- `tools/impl/quickbooks.js` — added `getPurchase()` and `uploadReceiptToQbo()`
- `FieldOps/src/ExpensePortal.jsx` — mobile-first portal, routed via `/expense/:uuid` in main.jsx
- `FieldOps/vercel.json` — rewrite rule for `/expense/*` → `/index.html`

### SMS approach
Uses **Twilio** via `twilio` npm package. Phone number stored on `credit_cards.phone_number` (E.164 normalized by `toE164()` helper in expense.js). Secrets: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_PHONE` in Credential Manager. Teams proactive message also sent as backup.

> **Previous approaches (abandoned):** (1) email-to-carrier gateways — silently quarantined by Proofpoint outbound filter. (2) Azure Communication Services (ACS) toll-free number — ACS accepted sends but Verizon silently dropped all messages due to missing Toll-Free Verification (TFV).

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
- `TWILIO_ACCOUNT_SID` ✅ configured (2026-06-12)
- `TWILIO_AUTH_TOKEN` ✅ configured (2026-06-12)
- `TWILIO_FROM_PHONE` ✅ configured (2026-06-12)
- `MENARDS_REBATE_*` (10 keys) — pending

---

## Service Autopilot Write Tools (built 2026-05-18)

SA has no public API. Uses puppeteer-core browser login + internal BFF endpoints. Browser is kept open for the full 4-hour session (not closed after login) and all API calls run via `page.evaluate()` inside Chromium — bypasses Incapsula JA3 TLS fingerprint detection that blocked Node.js `fetch()` calls after rapid restarts.

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
- `sa_set_billing_defaults` — set Taxable=Tax, InvoiceDelivery=Email on a client (call ~5 min after `sa_create_client`)
- `sa_list_tag_categories` / `sa_list_tags` / `sa_get_client_tags` / `sa_add_tag_to_client` / `sa_remove_tag_from_client` — read/write client tags (built 2026-08-19, see Tags section below)

### Key constants
- `EMPTY_GUID` = `00000000-0000-0000-0000-000000000000`
- Default QuoteStageID for JRB = `44410183-e121-4313-93a1-7ea769bfee53`
- SA test client (APIProbe, JRBTest) = `e2a7420a-930c-4908-90aa-67ba158e0921`

### Known limitations
- `createJob` / `SaveWaitingListService` errors with "Object reference not set" on the APIProbe test account — that account has no commission configuration. Works on JRB production account.
- SA_EMAIL and SA_PASSWORD must be in Credential Manager as `JRBAgent:SA_EMAIL` and `JRBAgent:SA_PASSWORD`
- **No dedicated API endpoint exists for `Taxable` or `InvoiceDelivery` fields.** Exhaustive probing of ClientView-minified.js (207 KB), ClientList.js (171 KB), and sa-minified.js (1.1 MB) confirmed zero save endpoints for these fields specifically. Workaround: `sa_set_billing_defaults` calls `ClientEditOverlayWs.asmx/GetClientInfo` to get the full client record, overrides `SalesTaxCodeID` (JRB "Tax" code `c432e644-…`) and `SendInvoiceBy` ("Email"), then POSTs to `ClientEditOverlayWs.asmx/SaveClient` with the full payload. No puppeteer UI clicking required.
- `sa_set_billing_defaults` — set `Taxable=Tax`, `InvoiceDelivery=Email` on a client (call ~5 min after `sa_create_client`)

### Client Tags (built 2026-08-19)

Discovered via a live DevTools capture while Michael manually tagged a client — this replaces an earlier wrong conclusion (an exhaustive code search of `saveClientFields`'s field list had found no tag mechanism, because tags aren't a client field at all — they're a separate CRM subsystem with their own endpoints).

- `getTagCategories()` — `webservices/TagsWs.asmx/GetAllTagCategories`, no body. Returns categories like "Client Type", "General", "GC Information".
- `listTags({ tagType })` — `CRMBFF/TagsAppliedManager/GetTagsByType`, body `{TagTypes:[tagType], AddAutomationTags:false}` (param names recovered the same MVC-binder-error way as `getClientTags`). Returns the full master tag list across all categories (tagType 1 = client tags, the only type confirmed so far).
- `findOrCreateTag({ name, categoryId, tagType })` — creates via `webservices/TagsWs.asmx/AddTag` (body `{Tag:{ID:EMPTY_GUID, CategoryID, Name, TagType}}`) only if `listTags` doesn't already have a case-insensitive name match. `AddTag`'s response never returns the new tag's ID (just `{Errors:[]}`), so the new ID is recovered by re-calling `listTags` and matching by name.
- `getClientTags({ clientId })` — `CRMBFF/TagsAppliedManager/GetSavedTags`, body `{parentID: clientId, viewAutomationTag: false}`. This is an MVC action (no `d` wrapper in the response), not a `TagsWs.asmx` web method — param names (`parentID`, `viewAutomationTag`) were recovered live off the ASP.NET MVC binder's own "null entry for parameter" error message on a deliberately-wrong probe call, same trick used for `listTags`'s `GetTagsByType`. Reads tags applied to one client.
- `addTagToClient({ clientId, tagId })` — `webservices/TagsWs.asmx/AddTagToClient`, body `{CustomerTag:{TagID, CustomerID: clientId}}`. `clientId` here is the same GUID as the `rk` query param on `ClientView.aspx?rk=...` — confirmed by comparing both against one live capture. Like `saveClientFields`, never trusts the write response alone — always re-verifies via `getClientTags` after saving.
- `addTagToClientByName({ clientId, tagName, categoryId, tagType })` — convenience wrapper combining the two steps above; this is what the `sa_add_tag_to_client` agent tool calls.
- `removeTagFromClient({ clientId, tagId })` — `webservices/TagsWs.asmx/RemoveTag`, body `{TagData:{CustomerID, ParentID, TagID}}` (clientId passed under two different names, both confirmed equal via a live DevTools capture 2026-08-19 of Michael manually removing a tag). Only removes the client's application of the tag — the tag definition itself is untouched. Same re-verify-via-`getClientTags` convention as `addTagToClient`.
- `getClientsByTag({ tagId, max })` — `CRMBFF/AccountList/V2AccountList_Query` with a `FieldColumn:31` (Tags) filter, `ContainOperator:'7'` (the only operator that actually filters — `'1'`/`'8'` silently no-op and return the unfiltered default list). Bulk-finds every client/lead carrying a given tag in one paginated call instead of one `GetSavedTags` round-trip per client — critical at scale. **`max` defaults to 5000 — always pass a higher value explicitly when a tag might cover more than that** (e.g. "Residential" now covers ~8,700+ clients after the classification backfill below); the default silently truncates rather than erroring.

---

## SA Client Categorization (built 2026-08-19/20, recovered onto `main` 2026-08-20)

One-time historical backfill + going-forward cron that tags every SA client/lead with an account-type segment and (where job history exists) a service line, using the Client Tags system above. Built in `tools/impl/sa-client-classification.js` and `tools/impl/sa-history-match.js`.

> **Recovery note (2026-08-20):** this entire system — both files, the `serviceautopilot.js` additions (`findOrCreateTagCategory`, `getClientsByTag`, the `email` field on `mapSAAccount`), the `.gitignore`/`fuzzy-match.js` changes, and the daily cron registration — was built and the live production backfill was actually run against real SA data, but the code was committed to the `claude/sa-client-tags` branch **after** PR #268 (which only contained the Tags primitives) had already merged, and was never merged itself. It sat on an orphaned, unmerged commit for a full day — meaning the "going-forward daily cron" was never actually running in production, and any SA client created since the backfill was left untagged. Reconstructed and merged via PR #280 after being discovered missing. **Lesson: always confirm a feature branch's final commit actually made it into a merged PR — a session ending with "commit pushed" is not the same as "merged."**

### Taxonomy
- **Account type** (tag category "Client Type"): `Residential`, `Commercial - Direct`, `Commercial - HOA` (pre-existing, reused), `Commercial - Property Mgmt`, `Municipal/Government`, `GC Subcontract` (referred TO us by a GC), `Commercial - General Contractor` (client's own business IS general contracting/architecture — distinct from GC Subcontract, added after Michael's manual review caught "Abacus Architects"/"Arco Murray" misclassified).
- **Service line** (new tag category "Service Line"): `Snow`, `Lawn/Landscape`, `Paving`, `Concrete` — derived from `sa_jobs.service` codes (fleetops Supabase) via an explicit code map (`SERVICE_CODE_MAP`), since the codes are short internal abbreviations (`App1`-`App7`, `PLOW - 2"`, `CONC`) not descriptive text.
- SA's native `AccountType` dropdown field is also set (`AccountTypeID` via `saveClientFields`) for the coarse Commercial/Residential split — it only has those two real values (confirmed via `GetAccountTypeList`), so the detailed segment always lives in the tag, never the native field.

### Classification rules (`classifyAccountType`, `classifyServiceLines`)
Tuned against real data multiple times: once against the first live dry-run's low-confidence bucket, again against ~269 rows Michael manually corrected in a review spreadsheet, and again 2026-08-20 after Michael caught "Diamond Communications" defaulting to `Residential`. Key lessons:
- **The elimination fallback defaults to `Residential`, not `Commercial`** — Michael's corrections showed unmatched names (informal person names, nicknames, single first names) are overwhelmingly residential, not business. An earlier version of this function defaulted the other way and was wrong in 48 of 71 reviewed rows.
- **`BUSINESS_NAME_RE`'s keyword list is a known-incomplete heuristic, not a real business-name detector** — `PERSON_NAME_RE` (the residential fallback) only checks "2-4 alphabetic word tokens," so ANY two-word business name whose keyword isn't in `BUSINESS_NAME_RE` silently falls through to Residential. Confirmed live 2026-08-20 on "Diamond Communications" ("communications" wasn't in the list). This is a structural gap, not a one-off typo — expect more misses whenever a business uses a naming convention the list hasn't seen yet. If another one is found, add the keyword AND re-scan the current `Residential`-tagged population (see below) rather than just fixing the one account.
- Parenthetical annotations (`(AUTOPAY)`, `(Residence)`, `(Claims Pmt Rcvd)`) and trailing status phrases (`MOVED`, `- Cancelled`, `NO LONGER RESIDENT?`, `or current resident`) are stripped before pattern-matching — otherwise they block the person/business regexes from matching the real name underneath.
- Person-name matching handles `"Last, First"`, 2-4 token names (`Ann Marie Schulz`), couples (`&`/`and`/`+`), and `Sr./Jr.` suffixes — not just a strict 2-token "First Last".
- `"Master:Sub"` names (e.g. `"Belgium Village Office (master):Village of Belgium (Community Park)"`) are split on `:` and every segment checked against municipal/military patterns — the match isn't always in the first segment.
- A bare acronym (`ACG`) paired with a site/location parenthetical reads as a property-management portfolio, not generic commercial.
- **HOA detection has the same class of gap as `BUSINESS_NAME_RE`, plus a distinct duplicate-record problem** (found live 2026-08-24 on "Village Estates"). `HOA_RE` only matches names/addresses literally containing "HOA"/"condo"/"association"/"homeowners" — a client record for a real HOA property that doesn't use one of those words (or a duplicate record of an already-correctly-tagged HOA that drops the qualifying word — "Village Estates" vs. the correctly-tagged "Village Estate Condos") falls straight through to Residential with zero signal. Fixed via `buildHoaAddressSet`/`addressKey`: any Residential-tagged account whose **address AND contact email both** exactly match an existing Commercial - HOA account is reclassified as HOA too (same-property duplicate record, not a new discovery from name/address text alone).
  - **Address alone is deliberately not enough** — confirmed live that individual condo unit owners legitimately share their whole building's single street address with the complex's own HOA/association master record, and have their own separate, real email. An address-only version of this rule produced 3 real false positives (Janet Thompson, Jenny Mehalko, Mimi Hanna — all confirmed via a different email than their building's HOA record) before requiring email too narrowed it to exactly the 4 genuine duplicates (Village Estates, Bill Bauer/Ancient Oaks HOA, David Charney/Hidden River Condos, Millard Johnson/Lake Park Forest Condominiums — all confirmed with an exact matching email).
  - **Mimi Hanna (10432 N River Lake Dr, Mequon) was left as Residential, not auto-fixed, but is suspicious enough to flag to Michael**: her email (`mhannamd@gmail.com`) doesn't exactly match "Riverlake Subdivision HOA"'s email (`hannamimi55@gmail.com`) at the same address, but the HOA's email contains her own name reversed ("hannamimi") — plausibly the same person using two different addresses for her personal vs. HOA-board-member correspondence, or plausibly a coincidence. Deliberately not auto-corrected since the match signal (exact email) that cleared the other 3 false positives doesn't hold here either — worth a manual look, not a rule change.
  - This is a live-scanned, one-time-plus-incremental pattern like the `BUSINESS_NAME_RE` gap above: `buildHoaAddressSet` runs inside both `runClassificationDryRun` and `runIncrementalClassification`, so new duplicate-record HOA cases get caught going forward too, not just in the one-time rescan that found these 4.

### Old SA (2015–Aug 2023) history enrichment (`sa-history-match.js`)
Old SA is a separate Supabase project (`JRBHistory:SUPABASE_URL`/`SUPABASE_SERVICE_KEY` in Credential Manager) with its own client GUID namespace — confirmed live 2026-08-19 that there's zero direct `client_id` overlap with the current system (a prior platform migration regenerated every GUID), so accounts are matched by email first (highest confidence), then by name (with common suffix annotations stripped), tie-broken by street address when a name matches multiple candidates. Ambiguous matches are skipped rather than guessed — misattributing one client's service history to another is worse than leaving it unclassified. Confirmed live: 7,260 of 8,152 Old SA accounts matched this way, nearly doubling service-line coverage (Paving went from 47 to 408 accounts).

### Backfill results (2026-08-19/20)
10,242 accounts classified: **9,499 fully tagged, 743 partial** (tag applied; native `AccountType` field write failed on pre-existing data-quality gaps — missing state/city/postal code — genuine SA-side validation, not a bug), **0 hard failures** after retry. Ran as ~29 manually-chunked ~8-minute passes (each tool call has a 10-minute hard cap, so a multi-hour job needs to self-checkpoint) via a disposable `chunked-backfill.mjs` driver (not committed — the reusable logic lives in `applyClassificationBackfill`).

**Incident during the backfill**: an unrelated live probe for a tag-deletion endpoint hit a plain 404 that `looksLikeIncapsula()` false-flagged as a bot-detection block, setting the shared 45-minute backoff file that every SA operation checks — including the concurrently-running backfill chunk, which then failed ~9,926 rows near-instantly (the backoff check throws synchronously, no real request attempted). Recovered by identifying the Incapsula-tagged failures in the progress log and re-marking them for retry rather than treating them as real failures.

**`node_modules` in this shared directory emptied itself** several times across this whole effort (during the original backfill, and again 2026-08-20 while reconstructing this PR) — most likely concurrent-session contention (another session or the `branch_drift_check` cron's `git pull` racing an `npm` operation), not a code bug. The live Teams bot process never restarted during any incident (Node keeps loaded modules in memory), so there was no live-service impact, but any fresh `node` invocation during the empty window fails hard. Always fixed with a plain `npm install`. Worth a watchful eye if it recurs.

### Going-forward cron (`runIncrementalClassification`)
Registered in `scheduler/cron.js` as `sa_client_classification_incremental`, daily 4:30 AM (scheduled off the 6-8 AM cluster of other SA-touching jobs to avoid session contention). Finds accounts with no account-type tag yet (i.e. created since the backfill), classifies and tags just those — capped at 300/run as a safety ceiling. Does NOT re-run the Old SA history match (a brand-new client can't have pre-2023 history by definition). **Uses `getClientsByTag` with an explicit high `max`** — the default 5000 would otherwise misclassify thousands of already-"Residential"-tagged clients as new on every run (caught and fixed before this shipped; confirmed harmless in practice since `AddTagToClient` is idempotent — no duplicate tag entries from the reprocessing that happened before the fix).

`sa-history-match.js`'s Supabase client is created lazily (on first actual call, not at module import) specifically so this daily cron doesn't crash — `JRBHistory:SUPABASE_URL`/`SUPABASE_SERVICE_KEY` are a separate credential namespace never injected into the live scheduler's environment (only set up ad hoc for the one-time backfill), and a module-scope `createClient()` would throw the instant anything imports `sa-client-classification.js`, even though the incremental path never actually calls into Old SA. Confirmed live: the module imports cleanly with `JRBHistory:*` absent.

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
# 1. Find and kill the node process on port 3978 (only needed if something is
#    already bound there — e.g. a stray process Task Scheduler isn't tracking)
$p = (netstat -ano | Select-String ":3978 .*LISTENING" | ForEach-Object { ($_ -split '\s+')[-1] })
if ($p) { taskkill /f /pid $p }

# 2. Start fresh via the registered Task Scheduler task (injects secrets the same
#    way the launcher does, and restores Task Scheduler's own supervision of it)
Start-ScheduledTask -TaskName "JRB Teams Bot"
# Direct launch alternative (bypasses Task Scheduler supervision):
# Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -File `"C:\Users\Assistant\JRBAgent\launcher\start-agent.ps1`" teams" -WindowStyle Hidden
```

---

## Standing Rules Pipeline Fix + Short-Term Teams Conversation Memory (built/fixed 2026-08-20)

Michael reported the Teams bot has no persistent memory across chats and loses context mid-conversation (e.g. asking "test that?" one message after being told exactly what to test). Two separate root causes:

### 1. The standing-rules pipeline was silently dead since 2026-08-10 (fixed, PR #283)

`tools/impl/feedback-capture.js`'s `saveToRules()` has inserted a `source` column into `rules` since the day it was built, but the column never existed on that table — every write 400'd. Confirmed via Supabase edge logs: three of Michael's rule-worthy Teams messages on 2026-08-20 each produced a `400` on `POST .../rules` at the exact timestamps they were sent. **Net effect: the live agent's system prompt received zero new standing rules between 2026-05-09 and 2026-08-20** — every correction/instruction given via Teams or email in that window only ever landed in the local Claude Code memory file (`feedback-runtime-rules.md`), never in production. This is the same class of bug logged once before at row `56a11bc3` in `rules` itself ("FIXED 2026-05-04: feedback.js schema mismatch") — it regressed when `feedback-capture.js` was built without checking the table's actual shape.

Fixed additively: `alter table rules add column source text` (migration `20260820213000_rules_add_source_column.sql`), not by dropping the column reference from the code.

### 2. No short-term conversation memory at all (built, PR #283)

Every Teams message was handled as a fully stateless single-turn LLM call — `core/agent.js`'s `runAgent()` always had an `extraMessages` parameter, but no call site in `teams/bot.js` ever populated it. New module `memory/conversation.js`:

- `saveTurn(sessionId, role, content)` / `loadRecentTurns(sessionId, limit=12)` — raw turns in a new `conversation_turns` table, keyed by `teams-${conversation.id}`, capped at ~40 rows/session via id-ordered pruning (id used instead of `created_at` so ordering survives concurrent requests)
- Guarantees the returned array strictly alternates user/assistant (merges consecutive same-role rows, trims a dangling trailing user turn) so it's safe to spread directly into `runAgent`'s `messages` array
- Wired into every Teams intent branch **except scheduling**, which already has its own session-keyed draft/rules/memory context and doesn't need raw cross-intent turns mixed in
- Threaded through the SA-block retry queue (`agent_tasks.session_id` / `agent_tasks.extra_messages`, migration `20260820213200_agent_tasks_add_session_id.sql`) so a task deferred by SA's Incapsula backoff keeps its context, and `scheduler/task-poller.js` now records the task's real eventual outcome as the assistant turn — not just the "I've queued this" placeholder that was there when it got deferred

Distinct from `memory/memory.js`'s existing Haiku-summarized long-term memory — that system is unchanged and still handles cross-session pattern recall. This new layer is short-term and raw, specifically to stop the bot losing the thread within a live conversation. `core/agent.js`'s `saveMemory` call was also fixed to slice off the `extraMessages` prefix before summarizing, so it doesn't re-summarize turns already captured in earlier `agent_memory` rows on every call.

**Known accepted limitations** (documented inline in `memory/conversation.js` and `teams/bot.js`): a narrow crash-window can drop one genuinely-unanswered turn on the next load; a burst of 3+ messages sent faster than they can be processed can race the fire-and-forget turn-save against a later message's history load. Both judged not worth the complexity of a full fix (state-tracking / per-conversation request serialization) for a single-user bot.

---

## Autonomous Schedule Manager (Phase 1 built 2026-08-20)

Michael's long-term goal, agreed as a 5-phase roadmap 2026-08-20: an assistant that learns his habits, manages his calendar proactively, and scans email to keep each block's to-do list current. Phase 1 (foundation) and Phase 2 (estimate-visit scheduling) are built; phases 3-5 (general auto-displacement, email-driven to-dos, habit learning) are not yet started. Full detail in Claude Code memory `project-jrb-calendar-block-system-2026-08-20`.

### What Phase 1 built
- **The President Weekly Block Schedule is live on `michael@jrboehlke.com`'s calendar** as 25 true Outlook recurring series (no end date), built via `createCalendarEvent`'s new `recurrenceDaysOfWeek`/`recurrenceStartDate` params (PR #285, branch `claude/fix-create-calendar-event-userEmail`).
- **Root cause fixed**: `createCalendarEvent` was the one calendar function in `m365.js` that never accepted `userEmail` at all, even though its own tool schema always told the LLM to pass it — every event silently landed on `assistant@jrboehlke.com`'s own calendar instead. ~245 duplicate junk events from the failed attempts (including one caused by testing from the live repo dir instead of the fix's worktree — always check which checkout has a fix before running a live-data script against it) were cleaned up.
- **`createCalendarEvent`/`updateCalendarEvent` now accept `categories`** — used to tag all 25 block-schedule events with the Outlook category `"JRB Block Schedule"` (applied to the series master; confirmed live that Graph correctly propagates it to every expanded occurrence). This is the reserved sentinel `tools/impl/calendar-watch.js` uses to tell block-schedule scaffolding apart from real meetings — never apply it to an actual appointment.
- **`tools/impl/calendar-watch.js`** (new) — `getCalendarChanges({mailbox})` detects new/changed real (non-block) events via a Microsoft Graph `calendarView/delta` cursor stored in the new `calendar_delta_state` table, proactively re-bootstrapping before the delta window (fixed at bootstrap time, doesn't slide forward) would go stale, and recovering from a Graph-invalidated cursor (410/resyncRequired) with one fresh re-bootstrap instead of dying until a human clears the row. Deliberately not exposed as an agent tool — every call advances the stored cursor as a side effect, so an ad hoc conversational call would corrupt the cron task's own view of "what's new."
- **`calendar_change_watch` cron task** (every 10 min) — Phase 1 stops at detection + a Teams notification; no auto-displacement yet (that's Phase 3). Matches the alert-once-on-failure/recovery pattern used by `sa_connectivity_check`/`ads_health_check`. A dedupe Set guards against Graph's own delta-redelivery behavior (confirmed live) without over-trusting it — notifications are only marked handled after a successful send, not before, so a failed Teams send retries on the next poll instead of being silently dropped forever.

### What Phase 2 built
- **`tools/impl/scheduling-visits.js`** (new) — `scheduleEstimateVisit({clientName, date, startTime, durationMinutes, mailbox})`, the `schedule_estimate_visit` agent tool. SA lookup (no guessing on 0/multiple matches — returns candidates for Michael to disambiguate) → calendar block with `location`/phone/address, no attendees, no `JRB Block Schedule` tag → displacement check against that day's tagged blocks (auto-resolves STANDARD-tier edge/full overlaps by shrinking/deleting just that one occurrence, never the series; flags PROTECTED/DEEP_WORK and mid-block overlaps for manual review instead of guessing or splitting) → drive-time blocks before/after (see below) → to-do note appended to the next Estimating/Proposal Production occurrence (whichever comes first chronologically).
- **`tools/impl/google-maps.js`** (new) — `getDriveTimeMinutes()` via Google's Routes API, anchored to the confirmed JRB office address (`9900 N Granville Rd, Mequon, WI 53097` — not the client's prior/next real appointment, a v1 simplification). Degrades to `null`/`status: 'unavailable'` on any failure (missing key, API not enabled, network error) rather than failing the whole visit-scheduling flow — the visit itself matters far more than the travel-time nicety around it. Each drive-time leg runs through the same displacement check as the main visit, so a travel block can't silently overlap a PROTECTED block either.
- **Known limitation, not fixed**: SA's `V2AccountList_Query` name filter appears to be a server-side no-op — `searchClients` only client-side-filters SA's default ~30-row page, so a real client not already on that page comes back as a false "not found." `schedule_estimate_visit`'s "client not found" result isn't fully reliable for SA's actual client volume (thousands) — reverse-engineering SA's real full-text search endpoint is a separate, larger effort.
- **Setup step still needed**: the Routes API itself must be enabled on the Google Cloud project the key belongs to (separate from just creating the key) — confirmed live 2026-08-20 that an unenabled API returns a clean 403/SERVICE_DISABLED, which the code already handles gracefully, but drive-time blocks won't actually appear until this is done. Enable at the URL Google's own error response provides (visit the Cloud Console's Routes API page for the project the key was created under).

### Decisions locked with Michael for Phase 2+
- Drive-time calculation: **Google Maps (Routes API)** — decision revisited 2026-08-20 after Michael saw the actual pricing; the raw per-call cost is nominally lower than Azure Maps and Michael chose to set up a separate Google Cloud account/billing relationship rather than default to staying in the Microsoft tenant. Credential: `GOOGLE_MAPS_API_KEY`, provisioned via `launcher/save-googlemaps-secrets.ps1`.
- Drive-time representation: **real blocked calendar time before/after the visit**, not just a text note.
- Estimate-visit calendar blocks: **no invite sent to the client** — blocked time only, contact info in the body.
- "Next Estimating block" tie-break: **whichever occurs first chronologically** (Tuesday vs. Thursday doesn't matter, soonest wins).
- Auto-displacement autonomy: **follow the President Weekly Block Schedule's own displacement priority order automatically for Standard blocks; never silently touch PROTECTED/DEEP WORK blocks.** This invariant is unchanged for `scheduling-visits.js`'s own flows (`scheduleEstimateVisit`, `book_time_with_michael`) — see Phase 3 below for the one place it's now deliberately inverted.

### What Phase 3 built (2026-08-24)

General auto-displacement, but for the opposite trigger direction from Phase 2: a REAL calendar item (an accepted invite, a webinar, a recurring series like Breakthrough Academy) now takes priority over ANY block, PROTECTED/DEEP_WORK included — confirmed by Michael live: "as a general rule, move to accommodate real invites." This is a deliberate, narrow exception to the invariant above, which still governs every *assistant-initiated* scheduling flow.

- **`tools/impl/block-schedule-reconciler.js`** (new) — `reconcileRealEventAgainstBlocks({mailbox, realEvent})`. Skips all-day markers (holidays) and declined meetings. Auto-accepts a not-yet-responded Breakthrough Academy invite (`support@btacademy.com`/`mike.dempster@btacademy.com`/etc., domain `btacademy.com`) via the new `acceptCalendarEvent` in `m365.js`. Resolves every block overlapping the real event using the same delete/shrink-start/shrink-end mechanics as `scheduling-visits.js`, generalized with a fourth case for a real event landing in the *middle* of a block: keeps whichever remaining side (before/after) is longer, drops the shorter remainder — `scheduling-visits.js`'s own middle-overlap case deliberately leaves this unresolved for its different (assistant-initiated) context. **`EXEMPTIONS`** is a short, explicit, named list of block+organizer/subject pairs that are never touched — currently just the recurring "JRB weekly status" call (organizer `bdn@hallingcayo.com`) sitting inside "Legal / Lawsuit [PROTECTED DEEP WORK]," confirmed intentional (the call is about the lawsuit) rather than a real conflict.
- **`calendar-watch.js`** — `getCalendarChanges()` now also returns `isAllDay` (needed by the reconciler's all-day filter).
- **`m365.js`** — new `acceptCalendarEvent()`; `toLocalNaiveFromUtc()` exported (already existed for `getFreeBusy`'s UTC-labeling fix, reused here — `getCalendarChanges()`'s returned times are bare UTC strings, while `getCalendarViewWithCategories()`'s are local-wall-clock via the `Prefer: outlook.timezone` header; the reconciler converts before comparing the two, the same class of bug just fixed in `getFreeBusy`).
- **`scheduler/cron.js`**'s `calendar_change_watch` task (every 10 min) now calls the reconciler for every detected real-event change instead of just sending a "review for conflicts" notification, and reports what was auto-resolved (or left alone, if exempt) in the same Teams message.
- **Known Graph quirk, not a bug**: patching one occurrence of a recurring series can cause Graph's delta feed to redeliver *neighboring* occurrences of that same series as "changed," sometimes with no subject/start populated at all — confirmed live immediately after this shipped. `calendar_change_watch` skips any change with a missing subject/start rather than reconciling against garbage.
- **Retagging which of Michael's real blocks (beyond the one named exemption) might need their own exemption is a manual, ongoing judgment call** — this list is deliberately short and explicit rather than a heuristic, since guessing wrong either direction (displacing an intentional co-location, or leaving a genuine conflict unresolved) is worse than asking.

> **Gap found 2026-08-21, fixed 2026-08-24 (PR #320)**: `GOOGLE_MAPS_API_KEY` was stored in Credential Manager but was never actually injected by `launcher/start-agent.ps1` — it was simply missing from that file's `$secrets` hashtable. The live drive-time feature had therefore likely been silently returning `status: 'unavailable'` in production, even after the Routes API was enabled. Now injected; requires a JRB Teams Bot restart to take effect if one hasn't happened since PR #320 merged.

---

## Teams Voice Messages (built 2026-08-21)

Michael asked for two things: the bot transcribing a voice memo he sends in Teams, and the bot being able to reply with a spoken voice message "like OpenAI can do." Chose **OpenAI for both directions** (Whisper for transcription, OpenAI's TTS API for spoken replies) over Azure Speech after initially considering Azure — one vendor, one credential, and it directly matches the ChatGPT-voice-mode comparison Michael drew.

### How it works
- `tools/impl/openai-voice.js` (new): `transcribeAudio({audioBuffer, mimeType, filename})` via `POST /v1/audio/transcriptions` (Whisper), `synthesizeSpeech(text)` via `POST /v1/audio/speech` (TTS, `tts-1`/`alloy`, capped at 4000 input chars — OpenAI's TTS endpoint rejects longer input). Both degrade to `null` on any failure (no key, bad audio, network error) rather than throwing.
- `teams/bot.js`'s `extractAndTranscribeVoiceMemo()` downloads a voice memo's `audio/*` attachment via the bot's own existing `getBotToken()` (same auth Teams requires for image attachments), caps at 25MB, transcribes it. Called **before** the `if (!userText) return` bail, since a voice memo typically carries no `activity.text` at all — bailing first would silently drop the whole message.
- **Voice replies are on-request only** (Michael's explicit choice, not "mirror how you sent it") — `WANTS_VOICE_REPLY_RE` matches phrases like "reply with voice"/"say that out loud" in the (possibly-transcribed) message text. When it matches, `remember()` synthesizes speech and sends it as an `audio/mp3` **data URI** attachment (no new storage dependency — input is already capped at 4000 chars, so payload size stays reasonable) instead of a plain text reply, falling back to text if synthesis fails for any reason.

### Setup step (done 2026-08-24)
`OPENAI_API_KEY` was created at platform.openai.com and saved via `launcher/save-openai-secrets.ps1`, and `launcher/start-agent.ps1`'s `$secrets` hashtable now injects it (PR #320).

### Not yet verified live
Built and syntax-checked, but merged without testing against a real Teams voice memo or a real OpenAI API call (Michael's explicit call — skipped the originally-planned live-test-before-merge step). Requires a JRB Teams Bot restart to pick up `OPENAI_API_KEY` before any of this can work at all. Unverified assumptions worth confirming once live: (1) Teams' actual `contentType` for a voice memo attachment matches the `audio/*` pattern assumed here, (2) Teams renders/plays a bot-sent `data:audio/mp3;base64,...` attachment correctly (no live confirmation this works the way image attachments do).

---

## FleetSharp GPS/Telematics Read Tools (built 2026-08-19)

FleetSharp has no public API. Discovered via a real login capture: cookie-session auth (no
Incapsula/reCAPTCHA/CSRF token seen — much simpler than SA), landing on an ExtJS/Sencha portal
at `<api-origin>/ng/portal` (the origin varies per account — captured live at login, e.g.
`https://app02.fleetsharp.com`, never hardcoded). The REST layer under `/ibis/rest/*` white-labels
the Linxup telematics platform.

### Available FleetSharp tools (read-only)
- `fleetsharp_get_vehicle_list` — device inventory (VIN, serial, device type) joined with live position/odometer
- `fleetsharp_get_live_positions` — current lat/lng, speed, odometer for every tracker
- `fleetsharp_get_daily_mileage` — per-vehicle daily `milesDriven`/`kilometersDriven` + idle/drive/stop time + harsh-driving score, for a date range
- `fleetsharp_get_tracker_names` — driverId/trackerId → display name map (rows from the other three tools are keyed by driverId, not name)

### Key endpoints (discovered, all GET unless noted)
- `/ibis/rest/setup/tracker-setup` — device/vehicle inventory
- `/ibis/rest/linxup/map/getPositions` — live GPS + odometer (`linxupPosition.odo`, `.trueOdometer`, `.lat`, `.lng`, `.speed`)
- `/ibis/rest/linxup/reports/reportFilterTrackers` — id → vehicle/driver name map
- POST `/ibis/rest/linxup/reports/getFleetActivityDispatch` — daily mileage/activity report. Body is `application/x-www-form-urlencoded`: `startDate`/`endDate` as `YYYYMMDD`, `startEpoch`/`endEpoch` as ms, `driverIds` (comma-separated, empty = all), `dispatch=true`, `safetyScoreHardwareType=ALL`. Response: `data.dailyByDriver[]` with `milesDriven`, `kilometersDriven`, `idleTime`, `driveTime`, `stopTime`, `score`, `grade`.

### Auth model
Plain form login (`#username`/`#password` POST to `/authentication/v2/login`), then pure
cookie-session auth for every API call — no bearer token, no CSRF header. `tools/impl/fleetsharp.js`
follows the same puppeteer-core browser-session pattern as `serviceautopilot.js` (keeps a browser+page
open for `SESSION_TTL_MS`, routes calls through `page.evaluate(fetch(...))` so cookies ride along
automatically), but has none of SA's Incapsula backoff/proxy machinery since no bot protection has
been observed yet. Session cookies cache to `fleetsharp-session-cache.json` for restart survival.

### Known limitations / not yet built
- Read-only. No write/mutation endpoint has been probed or wired up — production account, so
  discovery so far has been GET/read-only POSTs (report generation) by design, per explicit
  scope agreement with Michael (2026-08-19).
- Trip-level route/breadcrumb history and geofence-event endpoints not yet explored — daily
  mileage was the first target. `getFleetActivityDispatch`'s response also carries harsh-braking/
  acceleration/phone-use/speeding event counts per day, unused by the current tools but available
  if driver-safety scoring becomes a priority.
- `FLEETSHARP_URL`/`FLEETSHARP_EMAIL`/`FLEETSHARP_PASSWORD` must be in Credential Manager
  (`launcher/save-fleetsharp-secrets.ps1` sets them up interactively).

---

## Four bugs found and fixed from one live Teams chat (2026-08-24)

Michael reported four separate problems from a single morning's Teams conversation. All four traced to real, distinct root causes and are fixed on this branch.

### 1. SA search returned zero results for real accounts
Michael asked to tag two "Village Estates" HOA accounts (contact Mark Doedens); the bot's search came back empty for every variant tried ("Village Estates," "Village," "Estates," "Doedens," "Mark Doedens"). Root cause: `searchClients`'s server-side name filter (`FieldColumn:'1'`) is a confirmed no-op — SA always returns the same ~30-row "recent clients" list regardless of the search term, and the old code only ever client-side-filtered that one small page. A real account not recently touched was therefore permanently unfindable, no matter what name was tried — this was a previously-documented known limitation (see the old Phase 2 notes) that turned out to actually block real work.

Fixed: `searchClients` now pages through the real account population (same pattern as `getClientsByTag`) instead of trusting the broken filter, via a new `maxScan` param. Kept small (30, the old effective behavior) by default so low-stakes/high-frequency callers like `sa_connectivity_check`'s health-check ping stay cheap; the `sa_search_clients` agent tool (via `dispatcher.js`) and `scheduling-visits.js`'s client lookup both now explicitly request `maxScan: 3000` for a real chance at finding accounts outside SA's default page. **Verified live**: searching "Doedens" now finds "Dan Doedens" (a Lead in Germantown, WI) that the old code could never have surfaced — note the first name doesn't match what Michael said ("Mark"), a real discrepancy worth him confirming directly rather than guessing. Still probabilistic, not a full fix — a genuine full-text search endpoint would need separate reverse-engineering.

### 2. Persistent conversation memory still broke on fast message bursts
Michael named two accounts to tag, then immediately followed up with "Can you update those for me" — the bot replied "I don't have context for what 'those' refers to," one message after being told exactly what "those" meant. This was PR #283's already-known accepted limitation (a burst of 2+ messages can race the fire-and-forget turn-save against a later message's history load) actually happening in production, previously judged not worth a full fix.

Fixed properly this time: `teams/bot.js` now serializes all processing per Teams conversation (`runSerializedPerSession`, a promise-chain queue keyed by `sessionId`) so a second fast message can't even start until the first one's entire handler — including its turn-save — has completed. `saveTurn` calls (both user and assistant turns) also changed from fire-and-forget to awaited, since serialization means this no longer blocks other conversations. This closes the race conclusively rather than just narrowing the window.

### 3. Photos still weren't being read
Michael sent a photo and asked if it had been read; the bot said it saw nothing, twice. PR #303's image-attachment support (merged 2026-08-21) had two real gaps: (a) `extractImageAttachments` ran *after* the `if (!userText) return` bail, so a photo sent with no caption text was silently dropped before extraction ever ran; (b) it only checked `activity.attachments`, but Teams sometimes delivers a pasted image as an inline `<img src="...">` tag inside `activity.text`'s HTML instead — which then gets destroyed by the very next line that strips HTML tags down to plain text.

Fixed: image extraction now runs before the empty-text bail (a caption-less photo gets a placeholder prompt instead of being dropped), and `extractImageAttachments` now also scans the raw HTML for inline `<img>` tags, downloading those the same authenticated way as top-level attachments.

### 4. Bot gave false calendar information
Asked to carve out a 90-min Estimating block and 45-min HR block before noon, the bot said "your calendar is completely clear" and later "no conflicts," when Michael had other things on his calendar. The new blocks *did* get created correctly (confirmed by `calendar_change_watch`'s own notification), but the "clear" claim was false. Two compounding root causes:

- **`list_calendar_events` defaults to the assistant's own calendar, not Michael's.** Every hardcoded call site in this codebase already passes `userEmail` explicitly (nothing relies on the assistant@ default for calendar tools — unlike email/SharePoint, which genuinely are the assistant's own). The one call this run made to check for conflicts omitted `userEmail`, silently read the empty assistant calendar, and confidently reported "clear" — while the two `create_calendar_event` calls in the same run *did* pass Michael's address, which is why the new blocks landed on his real calendar even though the conflict check never actually looked at it. **Verified live**: `listCalendarEvents({})` with no `userEmail` now correctly returns Michael's real 14 events for that day instead of an empty list. Fixed by changing `createCalendarEvent`/`listCalendarEvents`/`updateCalendarEvent`/`deleteCalendarEvent`'s default from the assistant's mailbox to `michael@jrboehlke.com` — the internal-only calendar functions (`getCalendarEvent`, `getCalendarViewWithCategories`, never exposed as agent tools) were left untouched since every caller of those already passes a mailbox explicitly.
- **This request ran on Haiku, not Sonnet.** `routeModel`'s complexity heuristic requires the complete word "estimate" (`\bestimate\b`), which doesn't match "Estimating" — this system's actual block name — so "Estimating 9am; then HR" didn't trip any complexity signal and fell through to the cheap model for a genuinely consequential multi-tool-call task (checking conflicts, creating two events). Fixed: added a prefix-only `\bestimat/i` check (catches "Estimating"/"estimate"/"estimated") plus `calendar`/`block`/`conflict` as new complexity keywords, so calendar-modifying requests route to Sonnet regardless of exact phrasing. Also strengthened `list_calendar_events`'s own tool description with an explicit "always check this before claiming a time is free" instruction, as defense-in-depth independent of which model is running.

---

## Teams Bot Agentic Behavior Fixes (built 2026-08-26)

Michael reported the Teams bot "still struggling to remember data and access all the tools it has access to" and "behaving as a super rigid rules based bot instead of something more agentic," even after the four fixes above. An architectural investigation (not a single bug hunt) traced this to real, distinct root causes in how `teams/router.js`'s regex-based intent classifier drives tool scoping, model choice, and memory recall — all fixed on this branch.

### 1. Scheduling's own system prompt promised tools it never had
`buildSchedulingSystemPrompt` (`teams/bot.js`) instructs the model to call `sa_list_resources`/`sa_dispatch_job`/`sa_update_route_order` during the dispatch-confirm step, but `TOOL_MAP.scheduling` (`tools/registry.js`) never included them — those three schemas live only inside `SA_TOOLS`, never duplicated into `SCHEDULING_TOOLS`. The actual "write it to SA" step of the scheduling workflow was structurally unable to complete. Fixed by filtering just those three tool names out of `SA_TOOLS` into `TOOL_MAP.scheduling` (not all of `SA_TOOLS` — `sa_create_client`/`sa_create_estimate`/etc. still belong to `crm` only). A load-time assertion now throws if a future rename inside `SA_TOOLS` ever silently drops one of the three again, instead of the taskType quietly losing the tool with no error.

### 2. Long-term memory was accidentally siloed by the same brittle router
`memory/memory.js`'s `loadContext()` used to filter strictly on `topics.contains([taskType])`. Since `taskType` is itself derived from `classifyIntent`'s regex router — and the router has already needed three separate live hand-patches for misroutes (see the "Four bugs" section above and `teams/router.js`'s own comments) — a memory saved under one taskType (e.g. `crm`) was invisible to a later message about the same real subject that happened to classify differently (e.g. `general`). This is a strong candidate for the actual root of "doesn't remember." Fixed: `loadContext()` now defaults to loading the N most recent summaries regardless of which taskType saved them (one continuous context for a single-user assistant, not N topic silos), gated behind a new `strict` param that opts back into the old exact-match behavior — used only by `teams/bot.js`'s `loadSchedulingMemory()`, which deliberately wants isolated recall so an unrelated CRM/report summary can't get spliced into a scheduling prompt.

### 3. The requests needing the most reasoning got the cheapest model
`general` (the router's catch-all fallback) is both the *widest* tool bucket in `TOOL_MAP` and, until this fix, NOT in `core/agent.js`'s `SONNET_TASK_TYPES` — so a request like "remember what we talked about" or "check three systems and cross-reference" fell to Haiku's keyword-regex heuristic and a 1024-token output cap by default. `calendar` had the identical gap (the direct cause of bug #4 in the section above). Fixed: `SONNET_TASK_TYPES` now includes `general`, `calendar`, and `dev_ambiguous` (see #5 below) alongside the original six.

### 4. Regex-only routing replaced with a cheap LLM fallback for the truly ambiguous case
`classifyIntent` is still the fast, deterministic, zero-latency first pass for every message — unchanged, and still authoritative whenever it confidently matches. New: when it falls through to `general` (nothing matched), `teams/bot.js` now calls `classifyIntentLLM` (`teams/router.js`) — one cheap Haiku call classifying the message into the same category set — before finalizing the intent. This only adds latency/cost to messages that already hit the catch-all bucket; everything that matches a regex directly is untouched. **Safety-critical exclusion**: `ops_alert` is deliberately NOT one of the LLM fallback's categories — it's gated only on the literal ⚠️ sigil (`isOpsAlertLike`, checked first, well before this fallback ever runs) specifically because `auto_fix`'s toolset includes file-edit/branch/PR access; letting an LLM guess "this sounds like an outage" from plain English would reopen the exact unbounded-match risk the sigil-only design exists to close. Caught and fixed during `/code-review` before this branch was even opened as a PR — do not add `ops_alert` back to `LLM_FALLBACK_CATEGORIES` without re-reading `isOpsAlertLike`'s and `classifyIntent`'s own comments first.

### 5. `dev_ambiguous` was a fully hardcoded, LLM-free canned reply
A message that looked technical but wasn't an explicit build request (`isAmbiguousDevTask`) got a static string with zero LLM call, zero memory, zero context-awareness — a literal instance of the "rigid rules bot" complaint. Fixed: now runs through `runAgent()` with a task prompt asking for one brief, context-aware clarifying question — but with a new, deliberately minimal `TOOL_MAP.dev_ambiguous` (`TEAMS_TOOLS` + `ESCALATION_TOOLS` only, no code/file/GitHub/deploy tools), so making the reply agentic doesn't also let the model accidentally start real dev work off an ambiguous request. Added to `SONNET_TASK_TYPES` too — asking a well-judged clarifying question isn't a place to accept the cheap model's shallower reasoning.

### 6. A `list_email_attachments`-shaped gap: four working functions with no tool registration
`m365.js` already had `listSentEmails`, `getSentEmailsTo`, `getThreadEmails`, and `createReplyDraft` — real, working functions used internally by the unattended inbox processor — but none were ever registered as agent tools, so a conversational "did I already reply to this" or "what did we discuss on this thread" had no tool to call and would be answered by guesswork. Registered as `list_sent_emails`, `get_sent_emails_to`, `get_thread_emails`, `create_reply_draft` in `tools/registry.js`'s `EMAIL_TOOLS` + `tools/dispatcher.js`'s `HANDLERS`, following the exact pattern the original `list_email_attachments` fix used.

**Verification**: all six changes syntax-checked (`node --check`) and import-tested (dummy env vars, no live API calls) before commit; `/code-review` run on the full diff and all findings (the scheduling-memory-isolation regression, the `ops_alert` fallback safety gap, a stale tool-name reference, the SA-tool-name fragility, this file's own stale `SONNET_TASK_TYPES` doc line) fixed before opening the PR. Not yet verified against a real live Teams conversation — worth a live smoke test on memory recall and the scheduling dispatch step specifically, since those were the two most consequential fixes.

---

## Multi-Company QuickBooks Support (built 2026-08-21, extended same day)

Michael needs QBO access to **J.R. Boehlke, LLC** ("jrb", the original/default company), **JRB Transport LLC** ("transport"), and **JRB Granville Propco** ("propco") at the same time. claude.ai's native Intuit QuickBooks connector can't hold more than one company simultaneously (confirmed: adding the same connector twice under a different name is rejected — "A server with this URL already exists," an open Anthropic limitation), so this extends JRBAgent's own MCP server/tool layer (already registered as the "JRB Assistant" connector on claude.ai) to be company-aware instead. JRB Transport is fully live (real OAuth completed, verified against live QBO data). JRB Granville Propco is built the same way but not yet authorized as of this writing — see "Required manual step" below. Propco's QBO subscription is a lower/single-user tier; confirmed this doesn't block OAuth (Intuit's Connected App authorization authenticates as the existing user, it doesn't add a second user seat) — Propco's login is under `michael@jrboehlke.com`, not `assistant@jrboehlke.com`, so the OAuth browser session must be signed into Intuit as Michael when authorizing.

> **Note on parallel work (2026-08-21):** two separate sessions tackled overlapping pieces of this the same day. PR #305 (`claude/multi-entity-ap-report`) made the AP report multi-entity (JRB+Transport) with its own live-tested vendor-normalization/intercompany investigation; PR #306 (`claude/bank-monthly-report`) added the new monthly bank AR/AP report and found/fixed a real ~$4.08M QBO AR data-conversion artifact. Both merged before Propco support landed — Propco was added on top of their work rather than re-doing it, to keep their live-verified fixes intact. If you're auditing history: don't be surprised the AP-report and bank-report architecture looks different from qb-token.js's later `gatherAcrossCompanies` helper — they predate it and use their own independent per-entity try/catch pattern, which is intentionally left as-is (see Design below).

### Design
One Intuit developer app (`QB_CLIENT_ID`/`QB_CLIENT_SECRET`) can be authorized against more than one QBO company file — each authorization gets its own realm ID + refresh token, but shares the same client credentials. No second app registration is needed.

- `tools/impl/qb-token.js` — `QB_COMPANIES` config maps `'jrb'`/`'transport'`/`'propco'` to their own Credential Manager target, refresh-token env var, and realm-ID env var. Per-company access-token cache/refresh-mutex state lives in a `Map` so a refresh for one company can never race or clobber another's. `getQBAccessToken(company)`, `exchangeQBAuthCode(code, company, realmId)`, `buildQBAuthUrl(company, state)`, `getQBRealmId(company)`, `getQBCompanyLabel(company)` all take/default `company = 'jrb'` for backward compatibility. `gatherAcrossCompanies(fetchFn)`/`summarizeAcrossCompanies(results, pick)` are shared helpers (added when Propco/cash-forecast/scorecard support landed) that normalize the "not connected / connected-but-errored / success" outcomes and combined-total derivation — used by `cash-forecast-report.js` and `weekly-scorecard-report.js`. `ap-report.js`/`bank-monthly-report.js` predate these helpers and use their own independent per-entity try/catch pattern instead (not retrofitted, to avoid touching their already-live-tested code for a cosmetic consistency pass).
- `tools/impl/quickbooks.js` — every exported function takes an optional `company` param (default `'jrb'`), threaded into the QBO base URL and the Supabase query cache key (the cache key includes `company` — otherwise identical query text against two companies would collide and serve one company's data to the other). `getAgedReportAsOf()` (added with the monthly bank report) calls QBO's Reports API for a historical as-of balance — also company-parameterized.
- `tools/registry.js`'s `qb_query` tool schema exposes `company: 'jrb'|'transport'|'propco'` so chat/MCP callers can target any of the three by name.
- `teams/bot.js`'s `/qb-reauth`/`/qb-callback` routes accept `?company=<key>`, encoded into the OAuth `state` param (`"company:suffix"`) so the callback knows which company's tokens to save. The callback also persists `realmId` (previously only logged) — into the company's meta JSON file, not Credential Manager (not secret), so it's usable immediately without an agent restart.
- `scheduler/cron.js`'s `qb_health_check` and `qb_reauth_reminder` loop over `listQBCompanies()`, skipping any company with no realm ID configured yet (so Michael isn't alerted about a company he hasn't connected) — alert/recovery state is tracked per-company.

### Which reports are multi-entity, and why (confirmed by Michael 2026-08-21)
"JRB Transport and JRB Granville Propco should be included in any report involving AP or cash. There are no commissions or A/R in those entities."
- **`tools/impl/ap-report.js`** (Wednesday 9:30 AM AP report) — static `ENTITIES` array (`jrb`/`transport`/`propco`), each fetched independently via `fetchEntityAging()` (never throws — a QBO hiccup on one entity doesn't blank the report), merged via `mergeEntityAgings()`. A company with no realm ID yet (`notConnected`) is omitted from both totals and the failure banner; a company that IS connected but errors shows up in `failedLabels`. Investigated live whether intercompany elimination was needed at the bill level for JRB/Transport: confirmed no — the real intercompany relationship is tracked entirely through "Due to/from" balance-sheet journal entries, never the vendor/Bill system. `EXCLUDED_INTERCOMPANY_VENDORS` is a defensive no-op guard (no Propco entry yet — its intercompany relationship, if any, hasn't been investigated). A real ~$700 mismatch was found between JRB/Transport's "Due To/From" balances — flagged to Michael directly, not built into any report.
- **`tools/impl/bank-monthly-report.js`** (new, 8 AM on the 12th of each month) — AR is J.R. Boehlke-only (SA doesn't track other entities' customers); AP is consolidated across `listQBCompanies()` **dynamically** (`AP_ENTITIES = listQBCompanies().map(...)`), so Propco was picked up automatically the moment it was added to `QB_COMPANIES` — no code change needed there beyond the registry entry. Uses `getAgedReportAsOf()` for a true as-of-month-end historical balance, with a 365-day write-off cutoff (`WRITE_OFF_THRESHOLD_DAYS`) after finding JRB's real QBO AR included a ~$4.08M 2023 data-conversion artifact (488 receivables dated the same day) — real AR as of 7/31/2026 confirmed at $372,633.59. Total outage (AR + every AP company failing) throws rather than sending a fabricated "$0.00" email, triggering the normal Teams failure alert.
- **`tools/impl/cash-forecast-report.js`** (Monday 12-Week Cash Forecast) — runs the *entire* 12-week running-balance model independently per entity via `qb-token.js`'s `gatherAcrossCompanies`, then shows a **combined series** (per-week sum of every entity's own series — valid since no inter-company cash transfer is modeled) as the headline, with each entity's own full weekly table + lowest-point call-out broken out below (`entityDivider()`, new in `ar-report-helpers.js`). AR-collection forecast only applies to `'jrb'`. A healthy *combined* number can still hide one entity going negative on its own — spelled out in the email itself.
- **`tools/impl/weekly-scorecard-report.js`** (Friday synthesis report) — "Cash Position" section shows per-entity bank-account breakdowns + combined total (KPI-bar headline). "AR/AP Snapshot" keeps **AR as J.R. Boehlke-only** and adds a per-entity AP breakdown + combined AP total; the **"Net (AR − AP)" figure stays JRB-vs-JRB only** — blending J.R. Boehlke's receivables against the whole group's payables would fabricate a working-capital number no single entity actually has.
- Deliberately unchanged: `tools/impl/commission-engine.js` (PM Commission Engine) and `tools/impl/weekly-finance-report.js`'s `getOldNationalDeposits()` (AR-adjacent — identifying unidentified *customer* payments) — both are AR/commission-flavored, not AP/cash, and Michael confirmed those entities have neither. CardDAV (`tools/impl/carddav.js`) also remains JRB-only by design.
- `cash_forecast_snapshots` (Supabase) previously stored a JRB-only forecast; from this deploy forward it stores the *combined* forecast under the same columns. The first post-deploy Monday's "vs. Reality" comparison will diff real combined cash against last week's JRB-only prediction — a one-time, self-correcting mismatch, not a bug.

### Required manual step (Propco only — Transport is fully live)
`launcher/start-agent.ps1` needs two more `Get-Secret` lines for `QB_REFRESH_TOKEN_PROPCO`/`QB_REALM_ID_PROPCO`, mirroring the `_TRANSPORT` pair added for Transport (PR #304, `claude/qbo-transport-launcher-secrets`). Per this file's Autonomy Rules, editing `start-agent.ps1` always requires Michael's explicit go-ahead first — done via a follow-up PR he reviews before merging (same pattern used for Transport). Once merged + the agent restarted, Michael completes the one-time OAuth for Propco by visiting `https://agent.jrboehlke.com/qb-reauth?secret=<CLAUDE_EXECUTE_SECRET>&company=propco`, **signed into Intuit as `michael@jrboehlke.com`**, and authorizing against JRB Granville Propco's company file when Intuit's login prompts for it.

---

## Terminology note: "SA" always means ServiceAutopilot

Confirmed directly by Michael 2026-08-17: "Anytime 'SA' is mentioned you may assume it is serviceautopilot." This applies both to interpreting his messages and to intent-matching code (see `teams/router.js`'s `isCrmActionRequest` - the bare `\bsa\b` token has been added/removed/re-added several times by well-meaning "cleanup"; it must stay). Do not narrow this based on a first-principles false-positive argument - ask Michael before changing it again.

---

## Credentials
All stored in Windows Credential Manager as `JRBAgent:KEY_NAME`. Never hardcode. Access via `start-agent.ps1` which injects them as environment variables.

Key names: `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_SECRET` (expires Jan 2027), `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_REFRESH_TOKEN` (expires ~Aug 28 2026 — calendar reminder set), `QB_REALM_ID` (9130357265584656 — also hardcoded in launcher), `QB_REFRESH_TOKEN_TRANSPORT`, `QB_REALM_ID_TRANSPORT` (9130357740125736 — JRB Transport LLC, live 2026-08-21), `GITHUB_TOKEN` (expires May 3 2027 — calendar reminder set), `BRAVE_SEARCH_API_KEY`, `SA_EMAIL`, `SA_PASSWORD`, `TEAMS_BOT_APP_SECRET`, `FLEETOPS_SUPABASE_SERVICE_KEY`, `QB_WEBHOOK_VERIFIER_TOKEN`, `CLAUDE_EXECUTE_SECRET`, `FLEETSHARP_URL`, `FLEETSHARP_EMAIL`, `FLEETSHARP_PASSWORD`, `GOOGLE_MAPS_API_KEY` (Routes API, drive-time calc for the estimate-visit scheduling feature — see Autonomous Schedule Manager section; set via `launcher/save-googlemaps-secrets.ps1`; actually injected by `start-agent.ps1` as of PR #320, 2026-08-24), `OPENAI_API_KEY` (Whisper transcription + TTS voice replies — see Teams Voice Messages section; set via `launcher/save-openai-secrets.ps1`; injected by `start-agent.ps1` as of PR #320, 2026-08-24)

Pending (see Multi-Company QuickBooks Support section): `QB_REFRESH_TOKEN_PROPCO`, `QB_REALM_ID_PROPCO` — for JRB Granville Propco's QBO connection, reusing the same `QB_CLIENT_ID`/`QB_CLIENT_SECRET` app. Not yet added to `start-agent.ps1`'s env injection (requires Michael's go-ahead per the launcher-edit autonomy rule) or populated in Credential Manager (populated automatically by the `/qb-reauth?company=propco` OAuth flow, signed in as `michael@jrboehlke.com`, once the launcher change lands).

Note: `FLEETOPS_SUPABASE_URL`, `SUPABASE_URL`, and `M365_USER_EMAIL` are hardcoded literals in `start-agent.ps1` (not Credential Manager secrets) despite `SUPABASE_URL` being listed in the Key names line above alongside real Credential Manager entries -- confirmed live 2026-08-27 while building `scripts/call-tool.mjs` (a plain `enumerateJRBCredentials()`-style Credential Manager dump has no `SUPABASE_URL` entry at all; the real Credential Manager keys for Supabase are `SUPABASE_SERVICE_KEY` plus unrelated `SUPABASE_JRBDB_URL`/`SUPABASE_JRBDB_KEY`/`SUPABASE_HISTORY_URL`/`SUPABASE_HISTORY_KEY` entries for other projects).

### Credential backup, healthcheck, and restore (built 2026-08-17)

Built after the 2026-08-12 KB5121003 incident wiped all 35 `JRBAgent:*` Credential Manager entries with zero warning and zero backup, costing hours of forensic recovery from scattered `.env` files and PM2 dumps.

- `tools/impl/credential-backup.js` - enumerates every `JRBAgent:*` entry (auto-discovers by prefix, no hardcoded key list), encrypts the whole set with DPAPI (`CurrentUser` scope - ties to this Windows profile's DPAPI master key, a separate store from Credential Manager that survived the actual 2026-08-12 wipe intact), and writes it to **two places**: `C:\Users\Assistant\CredentialBackups\jrbagent-creds-<date>.enc` (fast local recovery, 30-day retention) and OneDrive at `/JRBAgent-Ops/CredentialBackups/latest.enc` (survives a local-disk-only disaster).
- **`credential_backup` cron task** - daily 3 AM, runs the backup above.
- **`credential_healthcheck` cron task** - every 20 minutes, compares current Credential Manager entries against the key list from the last successful backup. Sends a Teams alert within ~20 minutes if any are missing (vs. the hours it took to notice last time), and a recovery message once they're back.
- **Restore**: `node scripts/restore-credentials.mjs` (dry run - lists what would be restored, writes nothing) or `node scripts/restore-credentials.mjs --confirm` (actually writes to Credential Manager). Reads local backup first, falls back to OneDrive if local is also gone.
- **Known limitation**: DPAPI encryption ties the backup to this specific Windows user profile. It protects against exactly the failure mode that actually happened (Credential Manager vault wiped, DPAPI keys intact) but would NOT be decryptable if the entire profile/machine were lost. That's an accepted tradeoff for now - a passphrase-based fallback layer would close that gap if ever wanted.
- Tested end-to-end 2026-08-17 against the real 35 production credentials: enumerate, encrypt, local write, OneDrive upload, healthcheck (clean), decrypt, and a disposable-key CredWrite/CredRead round-trip all verified working.

### Bypassing the agent loop for direct tool calls (confirmed useful 2026-08-19)

`start-agent.ps1 cli "..."` always runs through `runAgent()`, which requires a working `ANTHROPIC_API_KEY`
with available credit — if the Anthropic account is out of credit, every CLI/Teams/scheduler call fails with
`BadRequestError: Your credit balance is too low`, even though the underlying `tools/impl/*.js` functions
have no Anthropic dependency at all. When that happens (or for any quick read-only check that doesn't need
an LLM to decide anything), read only the specific env vars a given impl file actually needs
(`grep process.env tools/impl/<file>.js` — e.g. `serviceautopilot.js` only needs
`SA_EMAIL`/`SA_PASSWORD`/`SA_PROXY_URL`) via a `CredRead` PowerShell snippet, then call the exported
function directly from a plain Node script instead of going through the agent:

```powershell
$env:SA_EMAIL = [CredReader]::GetPassword("JRBAgent:SA_EMAIL")
$env:SA_PASSWORD = [CredReader]::GetPassword("JRBAgent:SA_PASSWORD")
$env:SA_PROXY_URL = [CredReader]::GetPassword("JRBAgent:SA_PROXY_URL")
node scratch\my-probe-script.mjs   # imports { getInvoice, getAuditTrail, ... } from 'tools/impl/serviceautopilot.js'
```

(`CredReader`'s `CredRead`-based `Add-Type` definition is the same pattern the launcher itself uses to read
Credential Manager entries — see `Get-Secret` in `launcher/start-agent.ps1` for the reference
implementation; give the class a unique name per PowerShell session to avoid an `Add-Type` redefinition
error.) Works for any `tools/impl/*.js` export — SA, QBO, Supabase, etc.

---

## GitHub Repos (scoped access only)
- `jrb9900n/jrb-assistant-scripts` — main agent repo
- Active branches: `main` (production)
- Branch convention: `claude/description-of-change`

---

## Email Attachment Reading (built 2026-08-24)

Michael asked the bot to sum up invoice PDFs attached to an email in his inbox (Amanda Jelinek/Stark Pavement, "RE: ACCOUNT ON HOLD/PAST DUE"). The bot repeatedly replied that "Microsoft Graph API cannot extract attachment content" — false. `m365.js` already had `listEmailAttachments`/`getEmailAttachmentBytes` for exactly this, but neither was ever registered as an agent tool (`tools/registry.js`/`dispatcher.js`), so the LLM had no tool to call and fabricated a Graph limitation instead of saying it lacked a tool.

- `list_email_attachments` / `read_email_attachment` agent tools added. `readEmailAttachment()` (new in `m365.js`) extracts real text — PDF via `pdf-parse` (v2 API: `new PDFParse({data: buf}).getText()`, must `destroy()` after), plain text/CSV/JSON as utf8 — instead of returning raw bytes, so the model can read and sum invoice contents directly. Returns `{supported: false, note}` for file types with no extraction path (images, Office docs) rather than throwing.
- Graph omits `contentBytes` on the inline JSON attachment response above ~3MB even for a real (non-reference) file attachment — `readEmailAttachment` falls back to the `/$value` endpoint (raw bytes, no size cap) for that case, and only reports "reference attachment" when the response's `@odata.type` actually is `#microsoft.graph.referenceAttachment`.
- `get_email`'s tool schema was missing `userEmail` even though `m365.getEmail()` already accepted it — added, so the model can fetch a full email body from `michael@jrboehlke.com` instead of silently defaulting to the assistant's own mailbox.
- **Verified live** against the real reported email: extracted all 7 Stark invoice PDFs cleanly, totaling $2,624.79.

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
`skills/definitions/inbox-management.md` — category taxonomy, folder structure, processing workflow

### Supabase (jrb-assistant — znpahinyplccdyoekfeo)
`email_catalog` table — idempotent upsert on `message_id`. Columns: mailbox, subject, from_address, category, action_taken, folder, thread_id, snippet, etc.

### Azure app permissions (Application, admin-consented)
`Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `Files.ReadWrite.All`, `User.Read.All`, `Sites.Read.All`, `Contacts.ReadWrite`

`Sites.Read.All` had gone missing at some point (found live 2026-08-24 — a `searchSharePoint`/`listSharePointSites` call 403'd, and Graph's own error named the token's actual granted set as only `Mail.ReadWrite`/`Files.ReadWrite.All`/`Calendars.ReadWrite`, despite this file documenting it as granted). Michael re-added + admin-consented it the same day via Entra admin center → App registrations → API permissions. Took a few minutes to actually show up in issued tokens after consent was granted (propagation delay, not a config mistake — the first two re-checks immediately after consenting still 403'd with the old permission set before the third succeeded). Re-confirmed live: `searchSharePoint` and `listSharePointSites` both return real results now.

Confirmed working live 2026-08-24: reading `support@jrboehlke.com` via `listEmails({userEmail: 'support@jrboehlke.com'})` — no code change needed, any mailbox address works as long as it exists in the tenant (Mail.ReadWrite applies tenant-wide, no allow-list in code).

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

---

## Supabase (jrb-assistant project — znpahinyplccdyoekfeo)
Key tables: `rules` (agent rules/feedback loop; `source` column added 2026-08-20), `knowledge_log` (observations), `memory`/`agent_memory` (session summaries), `conversation_turns` (short-term raw Teams turn history, added 2026-08-20 — see Standing Rules Pipeline Fix section), `mcp_tokens` (OAuth tokens, 1yr TTL), `agent_tasks` (task queue for poller; `session_id`/`extra_messages` columns added 2026-08-20), `email_catalog` (inbox audit trail), `carddav_credentials` (CardDAV access tokens), `calendar_delta_state` (Microsoft Graph delta-query cursor per mailbox, added 2026-08-20 for `calendar_change_watch` — see Autonomous Schedule Manager section)

---

## Session Handoff Convention
At the end of each Claude Code session, update this file with:
- Any resolved items (move off Open Issues)
- Any new open issues discovered
- Any architecture changes made
Then commit: `git add CLAUDE.md && git commit -m "docs: update CLAUDE.md after session"`
