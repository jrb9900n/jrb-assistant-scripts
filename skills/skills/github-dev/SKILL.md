# github-dev skill
# JRB Assistant — Code Writing, Testing & Deployment

## When to use this skill
Use this skill whenever a task involves:
- Writing new code, scripts, or programs
- Editing or updating existing code in any repo
- Deploying to Vercel or Supabase
- Running or testing code on the local machine
- Any task where files will be committed to GitHub

---

## Repos in scope
All work happens in one of these repos only:

| Repo | Purpose |
|------|---------|
| `jrb9900n/jrb-assistant-scripts` | JRB Assistant agent code, skills, launcher, scheduler |
| `jrb9900n/FleetOps` | Fleet operations application |
| `jrb9900n/FieldOps` | Field operations application |
| `jrb9900n/AuditMatchingEngine` | Audit matching engine |

**Never create files outside `C:\Users\Assistant\JRBAgent\` on the local machine without explicit instruction.**
**Never push to any repo not listed above.**

---

## The dev loop — always follow these steps in order

### Step 1 — Scope the project
Before writing a single line of code:
- Restate the goal in 2-3 sentences
- List the files that will be created or changed
- Identify which repo this belongs in
- Estimate the number of checkpoints needed
- State any assumptions being made
- **Wait for Michael to confirm the scope before proceeding**

Example scope confirmation:
> "I'll build a script that pulls overdue invoices from QuickBooks and emails a summary to michael@jrboehlke.com every Friday at 8am. It will create 2 new files in `jrb-assistant-scripts`: `scripts/invoice-reminder.js` and an update to `scheduler/cron.js`. I'll check in after writing the core logic and again before scheduling. Does this match what you had in mind?"

---

### Step 2 — Create a branch
Never write directly to `main`. Always create a branch named:
claude/[short-task-description]
Examples:
- `claude/invoice-reminder-script`
- `claude/fleetops-login-fix`
- `claude/audit-engine-csv-export`

---

### Step 3 — Write code locally first
Write all files to `C:\Users\Assistant\JRBAgent\` before committing to GitHub.
- Write clean, well-commented code
- Include error handling on every external call (API, file, DB)
- Never hardcode credentials — always use `process.env.VARIABLE_NAME`
- Follow the existing code style of the repo being edited

---

### Step 4 — Checkpoint intervals
Check in with Michael at these points — do not proceed past a checkpoint without a response:

| Checkpoint | When |
|-----------|------|
| After scope | Before writing any code |
| After core logic | Core functionality written, not yet tested |
| After testing | Tests pass, ready to commit |
| Before deployment | Ready to push to Vercel/Supabase prod |

For small tasks (single file, <50 lines), scope + pre-deploy checkpoints only.
For large tasks (multiple files, new features), all four checkpoints.

---

### Step 5 — Multi-agent review (for complex tasks)
For any task that touches more than 2 files or deploys to production:
1. **Writer agent** — writes the code
2. **Reviewer agent** — reads the code and checks for bugs, security issues, missing error handling
3. Writer addresses reviewer feedback before committing

This happens automatically — Michael does not need to manage it.

---

### Step 6 — Commit and open a Pull Request
After Michael approves at the final checkpoint:
git add .
git commit -m "[short description of what was built]"
git push origin claude/[branch-name]
Then open a Pull Request with:
- **Title**: What was built in plain English
- **Description**: What it does, what files changed, how to test it
- **Label**: `claude-written`

**Never merge the PR yourself. Wait for Michael to approve.**

---

### Step 7 — Michael approves the PR
Michael can approve from any channel:
- Claude.ai chat: "looks good, ship it" / "approve" / "merge it"
- Teams message to JRB Assistant bot: same phrases
- Email to assistant@jrboehlke.com from Michael: same phrases

Once approved, Claude merges the PR and `main` is updated.

---

### Step 8 — Deployment (if applicable)
Deployment requires **explicit approval** — never deploy automatically.

| Target | Approval phrase required |
|--------|------------------------|
| Vercel preview | Automatic after PR merge |
| Vercel production | "deploy to prod" / "push to production" |
| Supabase schema change | "apply the migration" |
| Run a script on the machine | "run it" / "execute it" |

---

## What Claude can do without asking
- Read any file in any repo listed above
- Create branches
- Write files locally to `C:\Users\Assistant\JRBAgent\`
- Run tests
- Open Pull Requests

## What always requires explicit approval
- Merging a PR
- Deploying to Vercel production
- Applying Supabase migrations
- Deleting any file from a repo
- Running scripts on the local machine that touch external services

---

## Credential handling
- Never write credentials into code files
- All secrets come from `process.env.*` — they are injected by `start-agent.ps1` at runtime
- If a new credential is needed for a task, tell Michael what it is and where to store it in Credential Manager before writing the code that uses it

---

## If something goes wrong
- Stop immediately and report the error in plain English
- Do not attempt to silently fix a failed deployment
- Do not retry a failed external API call more than once without checking in
- Always preserve the previous working state — never delete or overwrite without a backup commit

---

## Channels
This workflow applies identically regardless of how the task arrives:
- Claude.ai chat (this interface)
- Teams message to the JRB Assistant bot
- Email to assistant@jrboehlke.com from Michael

The same scope → checkpoint → PR → approve → deploy loop runs every time.
