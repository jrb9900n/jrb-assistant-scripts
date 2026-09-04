// tools/impl/claude-code-escalation.js — hands a task the normal runAgent()/
// TOOL_MAP loop can't complete off to a full, real headless Claude Code
// session: genuine Bash/Read/Write/Edit access, its own git worktree, and
// the ability to open a PR -- not the narrow sandbox (--tools "", three MCP
// tools only) this file used to spawn.
//
// 2026-09-03 scope decision (Michael: "I actually want to make the peggy
// leap" -- full Claude Code capability, no upfront approval gate, reachable
// from Teams, voice, and email-from-michael@jrboehlke.com). Two deliberate
// departures from this file's prior design, both worth reading before
// touching this again:
//
// 1. No more "ask Michael first, wait for yes/no" gate. The old version
//    created a pending-approval row and declined to run anything until a
//    Teams reply confirmed it. Removed on purpose: Michael specifically
//    wants voice to be able to say "I'll have Claude Code build that" and
//    move on to the next thing on the same call, not stall on a synchronous
//    approval round-trip. The safety argument this leans on: the actual
//    blast radius of a bad call here is bounded by "opens a PR nobody
//    asked for" -- this repo's own autonomy rules (CLAUDE.md) and this
//    file's worktree/branch/PR discipline below mean nothing reaches main,
//    gets pushed directly, or runs live without Michael's own separate,
//    later PR-merge decision. The approval that matters moved to the END
//    of the process (the PR review), not the start.
// 2. No more requirement for a live Teams `activity.conversation.id` to
//    reply into. The old version declined outright when called with no
//    Teams context (found live 2026-09-02 to crash several real non-Teams
//    call sites instead of declining gracefully -- PR #367). Since this
//    always reports out via sendProactiveMessage (Teams) regardless of
//    where the request originated, it no longer needs conversation context
//    at all -- works identically from Teams, a voice call, or Michael's own
//    email (scheduler/cron.js's email_poller already hard-gates its whole
//    Michael-only branch to `email.from.toLowerCase() === 'michael@jrboehlke.com'`
//    exactly, ~line 2146 there -- this file doesn't need its own separate
//    sender check on top of that).
//
// A real, accepted gap worth understanding, not fixing here: this run's own
// Bash/Write/git access is a real Claude Code session's OWN tools, not
// dispatched through tools/dispatcher.js at all -- so tools/impl/
// code-approval.js's confirm-before-write gate (built specifically because
// "the model will ask first" is advisory, not enforced) simply does not
// apply to anything this escalated session does with a file or a git
// command. The containment this leans on instead: an isolated worktree (so
// it can't touch this live checkout's branch) and "opens a PR, never
// merges" (so nothing it writes reaches main without Michael's own separate
// action). If the escalated session's *task* is a live action against SA/
// QBO/etc. rather than a code change, there is no equivalent PR-review
// backstop -- same as it calling those tools conversationally would be.
//
// A migration (supabase/migrations/20260903180000_claude_code_escalations_
// relax_for_immediate_start.sql) needs to be applied by hand in the
// Supabase SQL editor before this file's inserts/updates will succeed --
// the table's original NOT NULL/CHECK constraints were built for the old
// pending-approval shape and reject this one's rows otherwise. See that
// migration's own header for exactly what it relaxes.
//
// Explicit `git worktree add`/`remove` (not Claude Code's own -w/--worktree
// flag) -- found via /code-review + independent doc verification that -w's
// exact behavior isn't reliably documented, and this repo has an
// explicit, hard-won rule (CLAUDE.md's Worktree Convention) against
// anything switching the live checkout's own branch. Reusing the exact
// `git worktree add ... -b ... origin/main` mechanism already proven
// throughout this same session removes that uncertainty entirely, at the
// cost of one extra step this file owns instead of the CLI.
//
// Also found via the same review: --tools default combined with
// --allowedTools naming only the 3 MCP tool names has an undocumented (and
// plausibly contradictory) interaction -- whether --allowedTools acts as a
// hard allowlist that would silently narrow the session back to those 3
// tools, or merely auto-approves them on top of whatever --tools already
// granted, isn't confirmed anywhere. Dropped --allowedTools entirely, and
// use --dangerously-skip-permissions (not --permission-mode bypassPermissions
// -- functionally equivalent per docs, but bypassPermissions still has
// documented exceptions -- e.g. MCP tools marked requiresUserInteraction --
// that can still prompt and hang an unattended -p run until the timeout;
// --dangerously-skip-permissions is the pattern the docs actually recommend
// for unattended/containerized use, and matches how every other Claude
// Code session on this same machine already runs -- see CLAUDE.md's
// Autonomy Rules).

import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';
import { sendProactiveMessage } from '../../teams/notify.js';

const execFileAsync = promisify(execFile);

// Runs the claude CLI with the prompt piped over stdin instead of as a CLI
// argument -- found via /code-review: shell:true (needed below to resolve
// the claude.cmd npm shim on Windows -- see its own comment) does NOT get
// Node's normal safe per-argument escaping the way a non-shell execFile
// call does; on Windows it joins the argv into one string for cmd.exe,
// which does not safely tolerate the embedded newlines this prompt always
// has (a static multi-paragraph template, not just adversarial input) or
// metacharacters that could appear in row.task/row.reason (Teams/voice/
// email content -- e.g. a pasted URL with an "&"). Piping the prompt via
// stdin removes it from the command line entirely, so cmd.exe's join-and-
// reparse never touches it -- only short, static, developer-controlled
// values (branch/paths/flags/numbers) remain as actual argv entries.
// Matches the CLI's own documented "-p, --print ... useful for pipes"
// framing (an unset positional prompt falling back to stdin is standard
// Unix CLI convention) -- not independently confirmed against a real run in
// this session (see this file's header), worth confirming on first live use.
// opts.timeout is handled manually here, NOT passed through to execFile's own
// timeout option -- found via /code-review: with shell:true, the process
// execFile can actually signal on timeout is just the cmd.exe wrapper, not
// the real claude/git/npm process tree running underneath it on Windows
// (no POSIX process groups there). Node's built-in timeout would report
// "timed out" while that whole tree keeps running, still burning the
// budget and still holding file handles open in the worktree the caller is
// about to force-remove. `taskkill /F /T /PID` (kill the whole tree, not
// just the one PID) is the same fix already used elsewhere in this exact
// codebase for the identical class of problem -- see scheduler/cron.js's
// own stale-scheduler-instance cleanup.
function execClaudeWithStdinPrompt(args, { timeout, ...opts }, promptText) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let timer = null;

    const child = execFile(CLAUDE_BIN, args, opts, (err, stdout, stderr) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        const timeoutErr = new Error(`claude CLI timed out after ${timeout}ms and its process tree was killed`);
        timeoutErr.killed = true;
        return reject(timeoutErr);
      }
      if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
      resolve({ stdout, stderr });
    });
    child.stdin.on('error', () => {}); // a child that exits before stdin is fully written shouldn't crash this process with an unhandled EPIPE
    child.stdin.write(promptText);
    child.stdin.end();

    if (timeout) {
      timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) {
          execFile('taskkill', ['/F', '/T', '/PID', String(child.pid)], (killErr) => {
            if (killErr) logger.warn('claude-code-escalation: taskkill failed', { pid: child.pid, err: killErr.message });
          });
        }
        // Grace-period hard fallback -- found via /code-review: if taskkill
        // itself fails (PID already gone, permission denied, or a surviving
        // process tree despite /T) the child's own exit callback above may
        // never fire, and this promise would otherwise hang past its
        // caller's entire 45-minute budget with nothing to ever resolve it,
        // no cleanup, no report to Michael. Force settlement here regardless
        // of whether the kill actually landed -- forward progress (a
        // possibly-inaccurate "timed out" report, cleanup still running)
        // beats hanging indefinitely.
        setTimeout(() => {
          if (!timedOut) return; // already resolved via the child's real exit in the meantime
          const timeoutErr = new Error(`claude CLI timed out after ${timeout}ms; process-tree kill was attempted but never confirmed exit`);
          timeoutErr.killed = true;
          reject(timeoutErr);
        }, 10_000).unref();
      }, timeout);
    }
  });
}

function supabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

const CLAUDE_BIN = process.env.CLAUDE_CLI_PATH || 'claude';
const MCP_PORT = process.env.TEAMS_PORT ?? '3978';
const MCP_TOKEN = process.env.CLAUDE_MCP_TOKEN || process.env.CLAUDE_EXECUTE_SECRET;
// Real build-plus-review work costs more than the old 3-tool retry sandbox
// ever did. $30/45min chosen 2026-09-03 from Sonnet 5's actual per-token
// pricing ($2/$10 per M input/output) against a comparable real session's
// shape that same night (a moderate build plus several /code-review
// passes landed roughly $5-$20 all in) -- headroom without being unbounded.
const ESCALATION_TIMEOUT_MS = 45 * 60 * 1000;
const ESCALATION_MAX_BUDGET_USD = process.env.ESCALATION_MAX_BUDGET_USD ?? '30';

// Repo root, resolved relative to this file rather than process.cwd() -- the
// process importing this module should already be running from the live
// JRBAgent checkout, but resolving explicitly means a future caller with a
// different cwd still creates the worktree off the real repo, not wherever
// it happened to be launched from.
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WORKTREE_PARENT = fileURLToPath(new URL('../../../.worktrees/', import.meta.url));

// ── Called from the escalate_to_claude_code tool handler (dispatcher.js) ───
// Only reads `task`/`reason` off whatever object dispatcher.js passes --
// the activity/sessionId/taskType fields that call site still includes are
// simply ignored now (harmless; not worth a dispatcher.js edit just to stop
// passing fields this file no longer needs). Fires the real Claude Code run
// immediately and returns before it finishes; the result reaches Michael
// later via a Teams message, never synchronously in this reply.
export async function requestEscalation({ task, reason }) {
  // Concurrency guard -- found via /code-review: the old pending-approval
  // design refused a new escalation while one was already pending
  // (STALE_PENDING_MS cleanup, "you have N pending" disambiguation); this
  // rebuild had dropped that entirely, so nothing stopped every retry/
  // repeated request from stacking up its own $30/45min run in parallel
  // with no cap. A real concurrency queue is more machinery than this
  // needs right now -- simplest safe thing is refusing a second run
  // outright while one is already in flight.
  // Staleness check -- found via /code-review: a "running" row with no
  // expiry is a permanent lockout if the process ever restarts mid-run
  // (a normal, documented operation -- see CLAUDE.md's restart flow) or the
  // final status update fails for any reason, since nothing else in this
  // codebase ever touches this table (no cron/watchdog). A row older than
  // the run's own hard timeout plus a buffer can't still be legitimately
  // running -- treat it as crashed and self-heal instead of blocking every
  // future escalation forever, the same self-healing spirit as the old
  // design's STALE_PENDING_MS.
  const staleCutoff = new Date(Date.now() - (ESCALATION_TIMEOUT_MS + 5 * 60 * 1000)).toISOString();
  const { data: runningRows, error: runningCheckErr } = await supabase()
    .from('claude_code_escalations')
    .select('id, task, created_at')
    .eq('status', 'running')
    .order('created_at', { ascending: false })
    .limit(1)
    .then(r => r, (err) => ({ data: null, error: err }));
  // A genuine PostgREST error resolves fulfilled with {data:null, error:{...}}
  // rather than rejecting -- found via /code-review: the old .catch(() => ...)
  // form only handled a thrown/rejected promise (network failure), silently
  // treating a real query error (e.g. permissions, a broken query -- notably
  // including "column does not exist" if the migration in this file's header
  // hasn't been applied yet) the exact same as "nothing running," with no
  // trace of the check itself having failed.
  if (runningCheckErr) {
    logger.warn('claude-code-escalation: "already running" check failed, proceeding as if nothing is running', { err: runningCheckErr.message });
  }
  const alreadyRunning = runningRows?.[0];
  if (alreadyRunning) {
    if (alreadyRunning.created_at < staleCutoff) {
      logger.warn('claude-code-escalation: clearing a stale "running" row (crashed or lost track of), allowing a new escalation', { staleId: alreadyRunning.id });
      await supabase().from('claude_code_escalations').update({ status: 'error', result: 'Marked stale -- process likely restarted or crashed mid-run without ever reporting back.' }).eq('id', alreadyRunning.id).catch(() => {});
    } else {
      // Not perfectly atomic against a second request arriving in the same
      // instant (a real, if narrow, residual race -- two near-simultaneous
      // calls can both pass this check before either's insert lands) --
      // acceptable for how rarely that coincidence should occur here,
      // versus the added machinery a real distributed lock would need.
      return `A Claude Code escalation is already running ("${alreadyRunning.task}"). I'll wait for that one to finish before starting another -- ask again once you get the Teams message for it.`;
    }
  }

  const runId = randomUUID();

  const { error } = await supabase().from('claude_code_escalations').insert({
    id: runId,
    task,
    reason,
    status: 'running',
  });
  if (error) {
    // Not fatal -- this audit row is nice-to-have history, not load-bearing
    // for the actual run below. (Requires the migration in this file's
    // header comment to be applied, or every insert 400s on the old
    // pending/approved/denied-only CHECK constraint.)
    logger.warn('claude-code-escalation: could not create audit row (non-fatal)', { err: error.message });
  }

  logger.info('claude-code-escalation: starting immediately (no approval gate)', { runId, reason: reason?.slice(0, 120) });

  // Fire-and-forget -- reports its own result via sendProactiveMessage once
  // it finishes. Not awaited: the calling channel (Teams/voice/email)
  // gets its "started" reply back right away instead of blocking on a run
  // that can take tens of minutes.
  runEscalatedClaudeCode({ id: runId, task, reason }).catch(err =>
    logger.error('claude-code-escalation: runEscalatedClaudeCode failed', { runId, err: err.message })
  );

  return `Starting a full Claude Code session on this now: ${reason}\n\nI'll message you here (Teams) when it's done -- usually a few minutes, sometimes longer for a bigger build.`;
}

async function runEscalatedClaudeCode(row) {
  if (!MCP_TOKEN) {
    await markFailed(row, `⚠️ Escalation for "${row.task}" couldn't run -- no CLAUDE_MCP_TOKEN/CLAUDE_EXECUTE_SECRET configured, so the escalated session has no way to reach JRBAgent's own tools.`);
    return;
  }
  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) {
    await markFailed(row, `⚠️ Escalation for "${row.task}" couldn't run -- no GITHUB_TOKEN configured, so the escalated session couldn't push a branch or open a PR even if it finished the work.`);
    return;
  }

  const mcpConfig = JSON.stringify({
    mcpServers: {
      'jrb-agent': {
        type: 'http',
        url: `http://localhost:${MCP_PORT}/mcp`,
        headers: { Authorization: `Bearer ${MCP_TOKEN}` },
      },
    },
  });

  const branchName = `claude/escalation-${row.id.slice(0, 8)}`;
  const worktreePath = `${WORKTREE_PARENT}escalation-${row.id.slice(0, 8)}`;

  try {
    await execFileAsync('git', ['-C', REPO_ROOT, 'fetch', 'origin', 'main'], { timeout: 60_000 });
    await execFileAsync('git', ['-C', REPO_ROOT, 'worktree', 'add', worktreePath, '-b', branchName, 'origin/main'], { timeout: 60_000 });
  } catch (err) {
    await markFailed(row, `Escalation couldn't start -- failed to create its isolated worktree: ${err.message}`);
    return;
  }

  const prompt = `Michael's JRB assistant escalated a task it couldn't complete with its normal tools -- you have full Claude Code capability for this: real Bash/Read/Write/Edit/Glob/Grep, plus JRBAgent's own run_task/get_status/save_standing_rule MCP tools.

Task: ${row.task}

Reason it couldn't be completed normally: ${row.reason}

Read this repo's own CLAUDE.md first and follow its Autonomy Rules exactly -- you're already running in an isolated worktree on your own branch, so the Worktree Convention's "never touch main directly" is already satisfied; just build, commit, and push from here. Run /code-review on your own diff and address what it finds before opening anything, then open a PR against main -- never merge it yourself, that decision is Michael's. If genuinely nothing needs a code change (the answer is informational, or the real ask is a live action rather than a build), say so plainly and do that instead of forcing a PR that doesn't need to exist. End with a concise summary of what you did or found, and any PR link -- this is sent to Michael verbatim.`;

  logger.info('claude-code-escalation: launching escalated Claude Code run', { id: row.id, branchName, worktreePath });

  let outcome, isError = false;
  try {
    const { stdout } = await execClaudeWithStdinPrompt([
      '-p',
      '--tools', 'default',
      '--dangerously-skip-permissions',
      '--mcp-config', mcpConfig,
      '--strict-mcp-config',
      '--output-format', 'json',
      '--max-budget-usd', String(ESCALATION_MAX_BUDGET_USD),
      '--no-session-persistence',
    ], {
      cwd: worktreePath,
      timeout: ESCALATION_TIMEOUT_MS,
      // shell: true -- found via /code-review, confirmed against real
      // production log evidence (three prior "spawn claude ENOENT"
      // failures, 2026-08-27/09-02): the claude CLI installs as an npm
      // shim (claude.cmd on Windows, resolved via `where claude`), which
      // Windows' CreateProcess cannot launch directly the way it can a
      // real .exe -- execFile needs the shell to resolve it. This was true
      // of the OLD version of this file too; every real invocation before
      // tonight silently failed this same way. Every remaining argv entry
      // here is short and developer-controlled (no task/reason content --
      // see execClaudeWithStdinPrompt's own comment on why the prompt
      // moved to stdin instead), so shell:true's weaker Windows escaping
      // has nothing user-influenced left to mishandle.
      shell: true,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        APPDATA: process.env.APPDATA,
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        USERPROFILE: process.env.USERPROFILE,
        HOMEDRIVE: process.env.HOMEDRIVE,
        HOMEPATH: process.env.HOMEPATH,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        GH_TOKEN: ghToken,
        // Found via /code-review: the prompt above tells the escalated
        // session to follow CLAUDE.md's Autonomy Rules exactly, which
        // explicitly list "Read from and write to Supabase (jrb-assistant
        // project)" as something it may do -- but nothing in this env block
        // carried Supabase credentials, so any task that genuinely needed a
        // Supabase read/write (a real, common debugging pattern in this
        // codebase) would fail on a missing env var the prompt never warned
        // it about.
        SUPABASE_URL: process.env.SUPABASE_URL,
        SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
      },
      maxBuffer: 10 * 1024 * 1024,
    }, prompt);

    const parsed = JSON.parse(stdout);
    isError = !!parsed.is_error;
    outcome = isError
      ? `Escalation ran but reported an error: ${parsed.result || 'unknown error'}`
      : (parsed.result || '(no result text returned)');
    logger.info('claude-code-escalation: run complete', { id: row.id, costUsd: parsed.total_cost_usd, isError });
  } catch (err) {
    // execFile throws on non-zero exit, on timeout (err.killed), and on a
    // stdout parse failure -- all three are real outcomes worth reporting to
    // Michael rather than swallowing, since this whole flow exists so he's
    // never left wondering whether something quietly failed.
    isError = true;
    outcome = err.killed
      ? `Escalation timed out after ${Math.round(ESCALATION_TIMEOUT_MS / 60000)} minutes without finishing.`
      : `Escalation failed to run: ${err.message}`;
    logger.error('claude-code-escalation: run errored', { id: row.id, err: err.message });
  } finally {
    // Worktree cleanup regardless of outcome -- found via /code-review:
    // the old mkdtemp-based version cleaned up its scratch dir in a finally
    // block, and this rebuild had dropped that (nothing ever removed the
    // worktree -w would have created). CLAUDE.md's Worktree Convention
    // explicitly says to remove a worktree once its branch merges or is
    // abandoned; --force since an escalation that opened a PR leaves real
    // commits behind that a plain `worktree remove` would otherwise refuse.
    try {
      await execFileAsync('git', ['-C', REPO_ROOT, 'worktree', 'remove', worktreePath, '--force'], { timeout: 60_000 });
    } catch (err) {
      logger.warn('claude-code-escalation: worktree cleanup failed (non-fatal)', { id: row.id, worktreePath, err: err.message });
    }
    // `worktree remove` only removes the working directory -- it leaves the
    // local branch pointer behind (found via /code-review: nothing ever
    // deleted it, so every escalation -- success, failure, or timeout --
    // accumulated one more permanent claude/escalation-* local branch in
    // the shared live checkout). The branch's real commits (if any) already
    // live on origin behind an open PR by this point -- deleting the local
    // ref here doesn't touch that, same as this repo's own convention of
    // `gh pr merge --delete-branch` cleaning up after a merge.
    try {
      await execFileAsync('git', ['-C', REPO_ROOT, 'branch', '-D', branchName], { timeout: 30_000 });
    } catch (err) {
      logger.warn('claude-code-escalation: local branch cleanup failed (non-fatal)', { id: row.id, branchName, err: err.message });
    }
  }

  try {
    await supabase().from('claude_code_escalations').update({ status: isError ? 'error' : 'completed', result: outcome }).eq('id', row.id);
  } catch (err) {
    logger.warn('claude-code-escalation: could not update audit row (non-fatal)', { err: err.message });
  }
  await sendProactiveMessage(`Claude Code escalation result for "${row.task}":\n\n${outcome}`);
}

async function markFailed(row, message) {
  try {
    await supabase().from('claude_code_escalations').update({ status: 'error', result: message }).eq('id', row.id);
  } catch (err) {
    logger.warn('claude-code-escalation: could not update audit row (non-fatal)', { err: err.message });
  }
  await sendProactiveMessage(message);
}
