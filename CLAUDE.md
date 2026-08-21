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
# 1. Find and kill the node process on port 3978
$p = (netstat -ano | Select-String ":3978 .*LISTENING" | ForEach-Object { ($_ -split '\s+')[-1] })
taskkill /f /pid $p

# 2. Start fresh via launcher (injects all secrets including CLAUDE_EXECUTE_SECRET)
Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -File `"C:\Users\Assistant\JRBAgent\agent\launcher\start-agent.ps1`" teams" -WindowStyle Hidden
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

Michael's long-term goal, agreed as a 5-phase roadmap 2026-08-20: an assistant that learns his habits, manages his calendar proactively, and scans email to keep each block's to-do list current. Phase 1 (foundation) is built; Phase 2 (estimate-visit scheduling via SA + Google Maps drive time) is in progress; phases 3-5 (general auto-displacement, email-driven to-dos, habit learning) are not yet started. Full detail in Claude Code memory `project-jrb-calendar-block-system-2026-08-20`.

### What Phase 1 built
- **The President Weekly Block Schedule is live on `michael@jrboehlke.com`'s calendar** as 25 true Outlook recurring series (no end date), built via `createCalendarEvent`'s new `recurrenceDaysOfWeek`/`recurrenceStartDate` params (see the `calendar-userEmail-fix` PR below).
- **Root cause fixed**: `createCalendarEvent` was the one calendar function in `m365.js` that never accepted `userEmail` at all, even though its own tool schema always told the LLM to pass it — every event silently landed on `assistant@jrboehlke.com`'s own calendar instead. ~245 duplicate junk events from the failed attempts (including one caused by testing from the live repo dir instead of the fix's worktree — always check which checkout has a fix before running a live-data script against it) were cleaned up.
- **`createCalendarEvent`/`updateCalendarEvent` now accept `categories`** — used to tag all 25 block-schedule events with the Outlook category `"JRB Block Schedule"` (applied to the series master; confirmed live that Graph correctly propagates it to every expanded occurrence). This is the reserved sentinel `tools/impl/calendar-watch.js` uses to tell block-schedule scaffolding apart from real meetings — never apply it to an actual appointment.
- **`tools/impl/calendar-watch.js`** (new) — `getCalendarChanges({mailbox})` detects new/changed real (non-block) events via a Microsoft Graph `calendarView/delta` cursor stored in the new `calendar_delta_state` table, proactively re-bootstrapping before the delta window (fixed at bootstrap time, doesn't slide forward) would go stale, and recovering from a Graph-invalidated cursor (410/resyncRequired) with one fresh re-bootstrap instead of dying until a human clears the row. Deliberately not exposed as an agent tool — every call advances the stored cursor as a side effect, so an ad hoc conversational call would corrupt the cron task's own view of "what's new."
- **`calendar_change_watch` cron task** (every 10 min) — Phase 1 stops at detection + a Teams notification; no auto-displacement yet (that's Phase 3). Matches the alert-once-on-failure/recovery pattern used by `sa_connectivity_check`/`ads_health_check`. A dedupe Set guards against Graph's own delta-redelivery behavior (confirmed live) without over-trusting it — notifications are only marked handled after a successful send, not before, so a failed Teams send retries on the next poll instead of being silently dropped forever.

### Decisions locked with Michael for Phase 2+
- Drive-time calculation: **Google Maps (Routes API)** — decision revisited 2026-08-20 after Michael saw the actual pricing; the raw per-call cost is nominally lower than Azure Maps and Michael chose to set up a separate Google Cloud account/billing relationship rather than default to staying in the Microsoft tenant. Credential: `GOOGLE_MAPS_API_KEY`, provisioned via `launcher/save-googlemaps-secrets.ps1`.
- Estimate-visit calendar blocks: **no invite sent to the client** — blocked time only, contact info in the body.
- Auto-displacement autonomy: **follow the President Weekly Block Schedule's own displacement priority order automatically for Standard blocks; never silently touch PROTECTED/DEEP WORK blocks.**

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

## Terminology note: "SA" always means ServiceAutopilot

Confirmed directly by Michael 2026-08-17: "Anytime 'SA' is mentioned you may assume it is serviceautopilot." This applies both to interpreting his messages and to intent-matching code (see `teams/router.js`'s `isCrmActionRequest` - the bare `\bsa\b` token has been added/removed/re-added several times by well-meaning "cleanup"; it must stay). Do not narrow this based on a first-principles false-positive argument - ask Michael before changing it again.

---

## Credentials
All stored in Windows Credential Manager as `JRBAgent:KEY_NAME`. Never hardcode. Access via `start-agent.ps1` which injects them as environment variables.

Key names: `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_SECRET` (expires Jan 2027), `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_REFRESH_TOKEN` (expires ~Aug 28 2026 — calendar reminder set), `QB_REALM_ID` (9130357265584656 — also hardcoded in launcher), `GITHUB_TOKEN` (expires May 3 2027 — calendar reminder set), `BRAVE_SEARCH_API_KEY`, `SA_EMAIL`, `SA_PASSWORD`, `TEAMS_BOT_APP_SECRET`, `FLEETOPS_SUPABASE_SERVICE_KEY`, `QB_WEBHOOK_VERIFIER_TOKEN`, `CLAUDE_EXECUTE_SECRET`, `FLEETSHARP_URL`, `FLEETSHARP_EMAIL`, `FLEETSHARP_PASSWORD`, `GOOGLE_MAPS_API_KEY` (Routes API, drive-time calc for the estimate-visit scheduling feature — see Autonomous Schedule Manager section; set via `launcher/save-googlemaps-secrets.ps1`)

Note: `FLEETOPS_SUPABASE_URL` is hardcoded in `start-agent.ps1` (not a Credential Manager secret).

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
