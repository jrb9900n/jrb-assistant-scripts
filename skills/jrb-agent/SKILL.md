---
name: jrb-agent
description: Use this skill whenever working on the JRB Executive Agent system for JRB Boehlke LLC. Covers reading/writing agent code via GitHub API, understanding the system architecture, knowing where credentials live, patching agent.js or dispatcher.js, adding scheduled tasks, building new agents, or doing anything that touches C:\Users\Assistant\JRBAgent\ on the Windows machine. Trigger on any mention of: agent, agent.js, dispatcher, scheduler, start-agent, Peggy, feedback loop, knowledge_log, jrb-assistant-scripts, or any reference to the Windows machine running the assistant.
---

# JRB Executive Agent — System Skill

## What This System Is
A persistent AI executive assistant for Michael Reardon, owner of J.R. Boehlke (asphalt, concrete, landscape, snow contractor — SE Wisconsin/metro Milwaukee). Runs on a dedicated Windows machine, accessible remotely. Michael wears every hat: bookkeeping, finance, ops, scheduling, invoicing, project management, marketing, estimating, systems.

---

## Machine & Access

| Item | Value |
|------|-------|
| Machine | Windows laptop (Ryzen 5), always-on, `C:\Users\Assistant\` |
| Agent root | `C:\Users\Assistant\JRBAgent\agent\` |
| Tunnel URL | `agent.jrboehlke.com` |
| M365 account | `assistant@jrboehlke.com` |
| Owner name | Michael Reardon |
| Owner email | `michael@jrboehlke.com` |
| Teams bot | JRBAssistant (Single Tenant, Azure Bot Service F0) |

---

## Claude.ai Connected Integrations (as of 2026-05-03)

These MCP integrations are connected to Michael's Claude.ai account and available natively in chat — use them directly without routing through the agent:

| Integration | Use for |
|-------------|---------|
| **GitHub** | Browse repos, read files, review PRs, check commits in `jrb9900n/*` repos |
| **Microsoft 365** | Calendar, email, contacts directly in chat |
| **Supabase** | Query agent memory, rules, patterns, agent_tasks, token_log tables directly |
| **Vercel** | Check deployments, logs, env vars for fleet-ops and fieldops projects |

**Prefer these direct integrations over routing through the agent** for read/query tasks. Use the agent for tasks that require taking action (sending email, writing code, updating QB, etc.).

### MCP Server (JRB Agent as native tool)
The agent itself is connected as a custom MCP server:
- **URL:** `https://agent.jrboehlke.com/mcp`
- **Auth:** `X-Execute-Secret` header
- **Tools:** `run_task` (any agent task), `get_status`
- **Secret stored in:** Windows Credential Manager as `JRBAgent:CLAUDE_EXECUTE_SECRET`

---

## How to Access GitHub Without Asking Michael

The GitHub token lives in Windows Credential Manager as `JRBAgent:GITHUB_TOKEN`. I cannot read it directly from this chat sandbox. To read/write GitHub files, use the **agent as a proxy**:

### Reading a file
Have Michael run:
```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\Assistant\JRBAgent\agent\launcher\start-agent.ps1" cli "Read the file [path] from the jrb-assistant-scripts GitHub repo and print the full contents here"
```

### Writing/patching files — preferred approach
Generate a self-contained setup script (`.js`) that:
1. Uses `process.env.SUPABASE_URL` / `SUPABASE_SERVICE_KEY` / `GITHUB_TOKEN` (injected by launcher)
2. Does all file writes, API calls, and patches autonomously
3. Prints clear success/failure for each step

Then have Michael run it via the launcher which injects all credentials:
```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\Assistant\JRBAgent\agent\launcher\start-agent.ps1" cli "node C:\Users\Assistant\JRBAgent\agent\[script-name].js"
```
**Important:** The agent intercepts CLI tasks as prompts. For direct node execution, have Michael run `node [path]` directly in PowerShell after setting env vars, OR write the script so the launcher injects creds via env.

### Injecting credentials manually (one session)
```powershell
$env:SUPABASE_URL="https://znpahinyplccdyoekfeo.supabase.co"
$env:SUPABASE_SERVICE_KEY="[from vault file]"
$env:GITHUB_TOKEN="[from vault file]"
node C:\Users\Assistant\JRBAgent\agent\[script].js
```
Vault file location: `C:\Users\Assistant\JRBAgent\vault\`

---

## Credential Map (Windows Credential Manager)

All stored as `JRBAgent:[KEY_NAME]`:

| Key | Purpose | Expires |
|-----|---------|---------|
| ANTHROPIC_API_KEY | Claude API | — |
| SUPABASE_URL | jrb-assistant project | — |
| SUPABASE_SERVICE_KEY | jrb-assistant project | — |
| M365_TENANT_ID | Azure/M365 | — |
| M365_CLIENT_ID | Azure app registration | — |
| M365_CLIENT_SECRET | Azure app registration | Jan 2027 |
| QB_CLIENT_ID | QuickBooks OAuth | — |
| QB_CLIENT_SECRET | QuickBooks OAuth | — |
| QB_REFRESH_TOKEN | QuickBooks OAuth | ~Jul 2026 |
| GITHUB_TOKEN | jrb-assistant-scripts repo | Every 90 days |
| BRAVE_SEARCH_API_KEY | Web search | — |
| SA_EMAIL / SA_PASSWORD | Service Autopilot (new) | — |
| SA_EMAIL_OLD / SA_PASSWORD_OLD | Service Autopilot (old) | — |
| TEAMS_BOT_APP_SECRET | Teams bot | — |
| CLAUDE_EXECUTE_SECRET | MCP /execute and /mcp auth | — |

---

## Codebase Structure

```
C:\Users\Assistant\JRBAgent\agent\
├── core\
│   └── agent.js          — Main agent runner, system prompt, model routing
├── teams\
│   └── bot.js            — Teams HTTP server (port 3978)
├── mcp\
│   └── server.js         — MCP server (SSE at /mcp, messages at /mcp/message)
├── tools\
│   ├── registry.js       — Tool definitions (what Claude can call)
│   ├── dispatcher.js     — Tool handlers (what actually runs)
│   └── impl\
│       ├── feedback.js       — ✅ Feedback loop (knowledge_log, rules, patterns)
│       ├── email-guardrail.js — ✅ Outbound locked to michael@, inbound flagging
│       ├── github.js         — GitHub read/write/PR operations
│       └── ...
├── memory\
│   └── memory.js         — Supabase context load/save
├── scheduler\
│   ├── cron.js           — Scheduled tasks (cron-style)
│   └── task-poller.js    — Polls agent_tasks table every 30s for Claude.ai tasks
├── launcher\
│   └── start-agent.ps1   — Injects secrets, starts agent/teams/scheduler
└── tunnel.config.cjs     — Cloudflare tunnel pm2 config
```

GitHub repo: `jrb9900n/jrb-assistant-scripts` (private)

---

## Supabase Projects

| Project | ID | Purpose |
|---------|-----|---------|
| jrb-assistant | `znpahinyplccdyoekfeo` | Agent memory, feedback loop, token logs, agent_tasks |
| fleetops | (separate) | SA/QB sync tables, audit matching |

### Feedback Loop Tables (jrb-assistant)
- `knowledge_log` — every agent action logged here
- `patterns` — weekly synthesis output (Sundays 8pm)
- `rules` — Michael's direct corrections, immediate effect
- `synthesis_log` — audit trail of synthesis runs

### Other Tables (jrb-assistant)
- `agent_memory` — persistent context per topic
- `agent_cache` — TTL cache for expensive fetches
- `token_log` — API usage tracking
- `agent_tasks` — message bus between Claude.ai and agent (status: pending/running/done/error)

### Supabase Anon Key (safe for browser/artifact use)
`eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpucGFoaW55cGxjY2R5b2VrZmVvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxMjk1MTMsImV4cCI6MjA5MjcwNTUxM30.rWoIZb74OOYbOU-t-eKxko5DXcssN9Hwbhma7-YcGZU`

---

## Agent Architecture

### Model Routing
- **Haiku** (`claude-haiku-4-5-20251001`) — simple/short tasks, < ~500 words
- **Sonnet** (`claude-sonnet-4-6`) — complex analysis, drafting, code writing

### System Prompt Pattern
`buildSystemPrompt(memoryContext, taskType)` in `core/agent.js` — loads memory context + task type. **To wire in feedback loop**: import `buildContextBlock` from `tools/impl/feedback.js` and prepend its output to the system prompt per agent/task type.

### Email Rules
- Outbound: **only** `michael@jrboehlke.com` (enforced by `email-guardrail.js`)
- Inbound non-promotional: flag in briefing, never auto-reply
- Inbound promotional: silently skip

---

## Planned Agents (build order)

1. **Operations Agent** — email triage every 30min, morning briefing 6:30am
2. **Finance Agent** — AR aging, cash flow, QB reports
3. **Estimating & Sales Agent** — SA estimate pipeline, follow-up flags
4. **Scheduling & Crew Agent** — weekly schedule summary, crew assignment gaps
5. **Marketing Agent** — review requests, seasonal campaigns (later)

---

## How to Write Patches for This System

1. **Always read the current file first** (via agent proxy or Michael pasting it)
2. **Write a self-contained `.cjs` patch script** — never ask Michael to edit files manually
3. **Use `.cjs` extension** — the agent directory has `"type": "module"` in package.json, so `.js` files are treated as ES modules. Patch scripts should be `.cjs`.
4. **Test by having Michael run node directly** with env vars set
5. **Confirm success output** before considering done
6. **After patching bot.js or scheduler**: restart via launcher, not just `pm2 restart`

### Restart command (after any core file change)
```powershell
pm2 stop 0
powershell -ExecutionPolicy Bypass -File "C:\Users\Assistant\JRBAgent\agent\launcher\start-agent.ps1" pm2-teams
```
Scheduler:
```powershell
pm2 restart jrb-scheduler
```

---

## Common Pitfalls

- `import 'dotenv/config'` was removed — secrets come from launcher only, never dotenv
- Node.js v24 breaks pm2 — use Node v20.19.0 via scoop for pm2 processes
- **Patch scripts must be `.cjs`** — the project uses ES modules (`"type": "module"`), so plain `.js` scripts fail with `require is not defined`
- Supabase JS client `.rpc().catch()` doesn't work — use try/catch or `.then().catch()` pattern
- Windows Credential Manager retrieval via PowerShell inline commands breaks when chat renders URLs as hyperlinks — always use direct `$env:VAR=` assignment for one-off runs
- The agent CLI interprets tasks as prompts, not shell commands — `node script.js` must be run directly in PowerShell, not via the launcher CLI
- String matching patches on bot.js may fail due to encoded unicode in comment lines — use line-number based splicing instead
- `cmdkey` fails with colons in credential names — use the CredWriter C# approach (see save-secret.ps1 pattern)
- `module.exports` cannot be appended to ES module `.js` files — use `export` syntax instead

---

## Vercel

### Account
- **Team ID:** `team_oquyk1BQkSEyHjqJlHK0aF9E` (Michael Reardon's projects)
- **Token:** stored in Supabase `config` table as `VERCEL_TOKEN`

### Projects
| Name | Project ID | Repo | Framework |
|------|-----------|------|-----------|
| `fleet-ops` | `prj_83cd6Wmn2WWW79uO7N6mFKd1BcFF` | FleetOps (master branch) | create-react-app |
| `fieldops` | `prj_0YjCwD9qpI0uRLMqFz9OGL9aVX6b` | FieldOps | create-react-app |

### Retrieving the token in scripts
```javascript
const { data } = await supabase.from('config').select('value').eq('key', 'VERCEL_TOKEN').single();
const token = data.value;
```

### Trigger a redeployment
```javascript
const resp = await fetch('https://api.vercel.com/v13/deployments', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'fleet-ops',
    projectId: 'prj_83cd6Wmn2WWW79uO7N6mFKd1BcFF',
    teamId: 'team_oquyk1BQkSEyHjqJlHK0aF9E',
    gitSource: { type: 'github', ref: 'master', repoId: 'FleetOps' },
  })
});
```

### Update an env var on a project
```javascript
await fetch('https://api.vercel.com/v9/projects/PROJECT_ID/env?teamId=team_oquyk1BQkSEyHjqJlHK0aF9E', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: 'VAR_NAME', value: 'value', type: 'encrypted', target: ['production'] })
});
```

### Supabase config table (all stored keys)
| key | purpose |
|-----|---------|
| `GITHUB_READONLY_TOKEN` | Read-only, scoped to jrb-assistant-scripts |
| `VERCEL_TOKEN` | Full account Vercel token for deployments |
