// scheduler/cron.js - Automated task scheduler
import 'dotenv/config';
import cron from 'node-cron';
import { spawn, execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runAgent, SONNET } from '../core/agent.js';
import { logger } from '../core/logger.js';
import { sendProactiveMessage } from '../teams/notify.js';

// Kill any previous scheduler instance via PID file (wmic not available; this works cross-session)
const SCHEDULER_PID_FILE = join(tmpdir(), 'jrb-scheduler.pid');
const SCHEDULER_HEARTBEAT_FILE = join(tmpdir(), 'jrb-scheduler-heartbeat.txt');
try {
  if (existsSync(SCHEDULER_PID_FILE)) {
    const oldPid = parseInt(readFileSync(SCHEDULER_PID_FILE, 'utf8').trim(), 10);
    if (oldPid && oldPid !== process.pid) {
      // /t kills the whole process tree, not just the parent — without it, a live SA
      // Chromium session (kept open up to 4h per SESSION_TTL_MS) becomes an orphaned
      // process every time the scheduler self-dedups a stale prior instance, which
      // happens on nearly every restart during active development. Left unchecked
      // this accumulates leaked Chromium instances until the machine OOMs.
      try { execSync(`taskkill /f /t /pid ${oldPid}`, { encoding: 'utf8', timeout: 3000 }); } catch {}
    }
  }
} catch {}
try { writeFileSync(SCHEDULER_PID_FILE, String(process.pid), 'utf8'); } catch {}

// Close any live SA Chromium session before this process exits gracefully (Ctrl+C,
// Stop-ScheduledTask, or a signal from Task Manager) — otherwise it's orphaned the
// same way an unclean taskkill leaves one behind. Best-effort only: SIGKILL / a
// forceful `taskkill /f` (as used above against a prior instance) can't be caught
// by either handler and will still orphan the browser, but /t on that taskkill
// call now takes care of that specific path.
let _shuttingDown = false;
async function gracefulShutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  logger.info(`Scheduler: received ${signal}, closing SA/FleetSharp sessions before exit`);
  try {
    const { closeSaSession } = await import('../tools/impl/serviceautopilot.js');
    await closeSaSession();
  } catch (err) {
    logger.warn('Scheduler: closeSaSession failed during shutdown', { err: err.message });
  }
  try {
    const { closeFleetSharpSession } = await import('../tools/impl/fleetsharp.js');
    await closeFleetSharpSession();
  } catch (err) {
    logger.warn('Scheduler: closeFleetSharpSession failed during shutdown', { err: err.message });
  }
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Was check-then-write (existsSync then writeFileSync) -- a genuine TOCTOU race
// when two scheduler processes are alive at once (a documented recurring risk on
// this machine, e.g. the 2026-08-19 incident where the scheduler ran under a
// stray RDP session outside Task Scheduler's supervision): both could see no
// lock present in the same instant and both proceed, causing duplicate sends
// for tasks like email_poller. `flag: 'wx'` makes the create atomic at the OS
// level -- exactly one concurrent caller wins. The stale-lock-recovery path
// (existing lock past its ttl) still has a narrow window on the retry, but
// that's an unavoidable cold-path tradeoff, not the common case this fixes.
function acquireRunLock(taskName, ttlMs = 60_000) {
  const lockFile = join(tmpdir(), `jrb-scheduler-${taskName}.lock`);
  const tryCreate = () => {
    try {
      writeFileSync(lockFile, String(Date.now()), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      return true; // unexpected FS error -- don't block a task run on a lock we can't reason about
    }
  };
  if (tryCreate()) return true;
  try {
    const ts = Number(readFileSync(lockFile, 'utf8'));
    if (Date.now() - ts < ttlMs) return false; // held and still fresh
    unlinkSync(lockFile); // stale -- clear it and retry once
  } catch { return false; }
  return tryCreate();
}

function releaseRunLock(taskName) {
  const lockFile = join(tmpdir(), `jrb-scheduler-${taskName}.lock`);
  try { unlinkSync(lockFile); } catch { }
}

// Waits briefly for a sibling task's lock file to appear before concluding it isn't
// running this cycle. Two call sites (weekly_finance_report/ame_weekly_sync,
// bta_qb_revenue_report/qb_weekly_sync) previously checked existsSync exactly once —
// a latent TOCTOU gap that mattered little when the two tasks in each pair fired
// several hours/minutes apart on schedule, but is worth closing now that
// recoverMissedExecutions (2026-08-19) means both could in principle recover close
// together. Short grace window by design — the work before a lock file is written in
// both producer tasks is a single synchronous statement, so 10s is ample margin
// without adding meaningful latency to the common (no-catch-up) case.
async function waitForLockToAppear(lockFile, graceMs = 10_000, pollMs = 2000) {
  const start = Date.now();
  while (!existsSync(lockFile) && Date.now() - start < graceMs) {
    await new Promise(r => setTimeout(r, pollMs));
  }
}

// ── Missed-fire watchdog (cron_missed_fire_watchdog, below) ─────────────────
// recoverMissedExecutions (node-cron's own option, used throughout this file)
// catches misses caused by the scheduler process being down at the scheduled
// time, but not a single missed tick on an otherwise-live process (e.g. an
// event-loop stall straddling the target second) -- the actual root cause
// behind transport_accounting_report silently not firing on 2026-09-01 despite
// being scheduled. This is a second, independent layer: every 30 min, checks
// whether each monitored task has actually run since its own most-recently-due
// scheduled time, and if not, alerts Michael via Teams and attempts one
// self-heal run through the same runScheduledTask() path everything else uses.
//
// Only schedule shapes this can confidently reason about are monitored --
// anything else is silently skipped rather than guessed at (a false "overdue"
// alert is worse than no alert). Covers every shape actually used in this file
// as of 2026-09-01: fixed daily/weekly/monthly time-of-day, and fixed-interval
// (*/N minutes or hours).
//
// Known accepted limitation: an exceptionally slow run (well past its grace
// window before completing) can trigger one spurious overdue alert followed
// immediately by a "skipped, already running" self-heal result -- harmless
// (recordTaskRun on eventual success clears the overdue state so it never
// repeats), just occasionally noisy. Not worth per-task expected-duration
// tuning for a monitoring add-on.

const TASK_STATE_FILE = join(tmpdir(), 'jrb-scheduler-task-state.json');

function loadTaskState() {
  try { return JSON.parse(readFileSync(TASK_STATE_FILE, 'utf8')); } catch { return {}; }
}

function recordTaskRun(name) {
  try {
    const state = loadTaskState();
    state[name] = { ...(state[name] || {}), lastRunMs: Date.now() };
    writeFileSync(TASK_STATE_FILE, JSON.stringify(state), 'utf8');
  } catch (err) {
    logger.warn('recordTaskRun: failed to persist task state', { name, err: err.message });
  }
}

function recordTaskAlert(name) {
  try {
    const state = loadTaskState();
    state[name] = { ...(state[name] || {}), lastAlertMs: Date.now() };
    writeFileSync(TASK_STATE_FILE, JSON.stringify(state), 'utf8');
  } catch (err) {
    logger.warn('recordTaskAlert: failed to persist task state', { name, err: err.message });
  }
}

// Parses one 5-field cron field into a shape estimateMonitoring can reason about.
function parseCronField(field) {
  if (field === '*') return { type: 'wildcard' };
  const intervalMatch = field.match(/^\*\/(\d+)$/);
  if (intervalMatch) return { type: 'interval', n: Number(intervalMatch[1]) };
  const values = new Set();
  for (const part of field.split(',')) {
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      for (let v = Number(rangeMatch[1]); v <= Number(rangeMatch[2]); v++) values.add(v);
    } else if (/^\d+$/.test(part)) {
      values.add(Number(part));
    } else {
      return { type: 'unsupported' }; // e.g. named days/months -- not used in this file
    }
  }
  return { type: 'fixed', values };
}

// Returns a monitoring spec, or null if this schedule shape shouldn't be guessed at.
function estimateMonitoring(schedule) {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minF, hourF, domF, monthF, dowF] = parts.map(parseCronField);
  if (monthF.type !== 'wildcard') return null; // month restrictions never used here

  if (minF.type === 'interval' && hourF.type === 'wildcard' && domF.type === 'wildcard' && dowF.type === 'wildcard') {
    const intervalMs = minF.n * 60_000;
    return { kind: 'interval', intervalMs, graceMs: Math.max(intervalMs * 0.5, 10 * 60_000) };
  }
  if (minF.type === 'fixed' && minF.values.size === 1 && hourF.type === 'interval' && domF.type === 'wildcard' && dowF.type === 'wildcard') {
    const intervalMs = hourF.n * 3_600_000;
    return { kind: 'interval', intervalMs, graceMs: Math.max(intervalMs * 0.25, 30 * 60_000) };
  }
  if (minF.type === 'fixed' && minF.values.size === 1 && hourF.type === 'wildcard' && domF.type === 'wildcard' && dowF.type === 'wildcard') {
    return { kind: 'interval', intervalMs: 3_600_000, graceMs: 15 * 60_000 };
  }

  if (minF.type !== 'fixed' || minF.values.size !== 1 || hourF.type !== 'fixed' || hourF.values.size !== 1) return null;
  const minute = [...minF.values][0], hour = [...hourF.values][0];

  if (domF.type === 'wildcard' && dowF.type === 'wildcard') {
    return { kind: 'daily', hour, minute, graceMs: 120 * 60_000 };
  }
  if (domF.type === 'wildcard' && dowF.type === 'fixed') {
    return { kind: 'weekly', hour, minute, days: dowF.values, graceMs: 120 * 60_000 };
  }
  if (domF.type === 'fixed' && domF.values.size === 1 && dowF.type === 'wildcard') {
    return { kind: 'monthly', hour, minute, day: [...domF.values][0], graceMs: 360 * 60_000 };
  }
  return null; // unrecognized combination -- skip rather than guess
}

// Most recent scheduled fire time at or before `now`, for daily/weekly/monthly specs.
function mostRecentExpectedFire(now, spec) {
  if (spec.kind === 'daily') {
    const d = new Date(now); d.setHours(spec.hour, spec.minute, 0, 0);
    if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 1);
    return d.getTime();
  }
  if (spec.kind === 'weekly') {
    for (let back = 0; back < 8; back++) {
      const d = new Date(now); d.setDate(d.getDate() - back); d.setHours(spec.hour, spec.minute, 0, 0);
      if (d.getTime() <= now.getTime() && spec.days.has(d.getDay())) return d.getTime();
    }
    return null;
  }
  if (spec.kind === 'monthly') {
    const d = new Date(now.getFullYear(), now.getMonth(), spec.day, spec.hour, spec.minute, 0, 0);
    if (d.getTime() > now.getTime()) d.setMonth(d.getMonth() - 1);
    return d.getTime();
  }
  return null;
}

// Shared execution path for both a normal scheduled fire and a watchdog self-heal
// attempt -- gives every task a consistent run-lock (distinct from any lock a task
// acquires internally under its own name, e.g. for sibling-task coordination) so
// the two trigger sources can never run the same task concurrently and double-fire
// a side effect like sending a report email twice.
async function runScheduledTask(task, trigger) {
  const wrapLockName = `wrap-${task.name}`;
  if (!acquireRunLock(wrapLockName, 4 * 3_600_000)) {
    logger.info(`Scheduled task skipped (already running): ${task.name}`, { trigger });
    return { skipped: true };
  }
  try {
    logger.info(`Scheduled task starting: ${task.name}`, { trigger });
    await task.run();
    logger.info(`Scheduled task complete: ${task.name}`, { trigger });
    try { writeFileSync(SCHEDULER_HEARTBEAT_FILE, String(Date.now()), 'utf8'); } catch {}
    recordTaskRun(task.name);
    return { success: true };
  } catch (err) {
    logger.error(`Scheduled task failed: ${task.name}`, { err: err.message, trigger });
    return { success: false, error: err.message };
  } finally {
    releaseRunLock(wrapLockName);
  }
}

let saWasDown = false;
const qbWasDown = new Map(); // company -> bool, so a JRB Transport outage/recovery never stomps JRB's own alert state
let adsHealthWasDown = false;
let calendarWatchWasDown = false;
// Best-effort dedupe for calendar_change_watch -- Graph delta queries can
// redeliver the same change across polls (confirmed live during testing).
// Process-lifetime only, not persistent -- a restart can cause one
// duplicate notification, an accepted tradeoff for Phase 1.
const notifiedCalendarChangeIds = new Set();

// branch_drift_check's debounce flag, persisted so a scheduler restart while
// drift is still ongoing doesn't re-fire the "detected" alert unnecessarily
// (an in-memory-only flag would reset to false on every restart).
const BRANCH_DRIFT_STATE_FILE = join(tmpdir(), 'jrb-branch-drift-state.json');
let branchWasDrifted = false;
try { branchWasDrifted = JSON.parse(readFileSync(BRANCH_DRIFT_STATE_FILE, 'utf8')).drifted === true; } catch {}
function saveBranchDriftState(drifted) {
  try { writeFileSync(BRANCH_DRIFT_STATE_FILE, JSON.stringify({ drifted }), 'utf8'); } catch {}
}
// Startup-time sanity check: if the persisted state says "drifted" but the repo
// is actually clean right now (on main, 0 commits behind), clear the stale flag
// immediately rather than waiting up to 15 min for the next cron tick. This
// handles the common case where a scheduler restart itself included a git pull
// or reset that fixed the deployment — without this, the new instance inherits
// branchWasDrifted=true and spends the first cycle needlessly attempting an
// auto-correct git pull that's already a no-op.
if (branchWasDrifted) {
  try {
    const REPO_DIR = 'C:\\Users\\Assistant\\JRBAgent';
    const startupBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: REPO_DIR, encoding: 'utf8', timeout: 10_000 }).trim();
    execSync('git fetch origin main --quiet', { cwd: REPO_DIR, timeout: 20_000 });
    const startupBehind = parseInt(execSync('git rev-list --count HEAD..origin/main', { cwd: REPO_DIR, encoding: 'utf8', timeout: 10_000 }).trim(), 10) || 0;
    if (startupBranch === 'main' && startupBehind === 0) {
      branchWasDrifted = false;
      saveBranchDriftState(false);
      logger.info('branch_drift_check: stale drift state cleared at startup — repo is clean');
    }
  } catch {
    // git not available or fetch failed — leave branchWasDrifted as-is; the
    // first cron tick will re-evaluate and send the appropriate message.
  }
}
// Throttles repeat "still stuck" notifications during an ongoing drift
// episode to once/hour, while the actual auto-correct attempt itself still
// retries silently on every 15-min tick underneath. Separate timers per
// failure reason so a dirty-tree note firing doesn't suppress a *different*
// git-error note (or vice versa) for the rest of that hour if the failure
// mode changes mid-episode. Deliberately NOT persisted to disk like
// branchWasDrifted above — a scheduler restart just resets these to 0,
// causing at most one earlier-than-usual repeat note.
let lastDirtyNoteAt = 0;
let lastFailureNoteAt = 0;

// Every email_poller reply is composed almost verbatim from runAgent()'s raw
// text -- most call sites just do `result.replace(/\n/g, '<br>')`, no markdown
// rendering step. Without an explicit instruction the model defaults to its
// natural Claude-Code register (## headers, **bold**, pipe tables, emoji
// bullets/checkmarks, code fences), which then renders as literal characters
// in Michael's inbox instead of formatted text. Confirmed live 2026-08-24
// against real sent replies. Appended to every reply-generating task prompt
// below rather than passed as a systemPromptOverride, since that param fully
// replaces buildSystemPrompt()'s output (losing the standing-rules/company
// context injection) instead of layering on top of it.
const EA_REPLY_STYLE = `
Format this reply the way a competent human executive assistant would write an email -- not as a
chat/status report. Follow these rules exactly:
- Output clean HTML only: <p>, <ul>/<li>, <table> only if genuinely needed. Never use markdown
  syntax (no "##", "**", backtick code fences, "|---|" style tables, or emoji used as bullets or
  headers) -- it will show up as literal characters in the recipient's inbox, not formatting.
- Warm but efficient: no "I hope this finds you well," no restating the question back, no
  meta-commentary about how you're approaching the task.
- If part of the request can't be completed because no tool exists for it yet, say so in one plain
  sentence and stop there. Never propose or offer to run raw SQL, a direct database write, or any
  other unreviewed command as a workaround in the reply -- that decision belongs to Michael, not
  something to float over email.
- Do not add a "Sent by JRB Executive Assistant" signature yourself -- the caller appends that.
`.trim();

// Defense-in-depth for EA_REPLY_STYLE's "HTML only" instruction -- the model
// complying isn't guaranteed. If the result already contains HTML tags, trust
// it as-is; otherwise treat it as plain text and convert it ourselves (blank
// line = new paragraph, single newline = <br>) so a non-compliant plain-text
// response still renders as readable email instead of one run-on paragraph
// (dropping the old blanket `.replace(/\n/g,'<br>')` would do that, since HTML
// collapses bare whitespace).
function asHtmlBody(text) {
  const s = (text ?? '').trim();
  if (!s) return '';
  if (/<[a-z][^>]*>/i.test(s)) return s;
  return s.split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}

// Forces Sonnet on the email_poller general-fallback call below rather than
// relying on routeModel's keyword heuristic (that taskType isn't in
// SONNET_TASK_TYPES). Imported from core/agent.js instead of a second
// hardcoded literal here -- the two copies had already drifted out of sync
// once (both stuck on the prior model generation).
const FORCE_SONNET_MODEL = SONNET;

const SCHEDULED_TASKS = [
  {
    // Daily 8 AM — send follow-up SMS to employees with incomplete expense reports
    schedule: '0 8 * * *',
    name: 'expense_reminders',
    run: async () => {
      const { sendExpenseReminders } = await import('../tools/impl/expense.js');
      const result = await sendExpenseReminders();
      logger.info('Expense reminders complete', result);
    },
  },
  {
    // Monday 6 AM — consolidated weekly finance report (Revenue, AR, Expenses, Reconciliation)
    // Replaces: weekly_crm_report, weekly_expense_report, weekly_audit_email
    // Waits for AME to finish if still running at 6 AM — sends delay notification and polls.
    // runAudit() refreshes audit_issues so reconciliation sections have current data.
    schedule: '0 6 * * 1',
    name: 'weekly_finance_report',
    // Confirmed 2026-08-19: this task never fired on its own schedule since at least
    // 2026-08-10 despite the scheduler being continuously alive through multiple
    // qualifying Monday windows — same node-cron missed-tick bug documented in full
    // on qb_health_check below. Idempotent per ISO week (getPriorWeekRange), safe to
    // catch up.
    recoverMissedExecutions: true,
    run: async () => {
      const ameLockFile = join(tmpdir(), 'ame-weekly-sync.lock');
      let delayed = false;
      let delayMinutes = 0;

      // Grace period first: the original check only ever looked once (existsSync),
      // never waiting for the lock to appear — a pre-existing TOCTOU gap that mattered
      // little when ame_weekly_sync (00:01) and this task (6 AM) fired 6 hours apart on
      // schedule, but is worth closing now that both independently gained
      // recoverMissedExecutions (2026-08-19) and could in principle recover close
      // together. See waitForLockToAppear() above.
      await waitForLockToAppear(ameLockFile);

      if (existsSync(ameLockFile)) {
        delayed = true;
        const ameStartMs = Number(readFileSync(ameLockFile, 'utf8') || 0);
        const runningMin = ameStartMs ? Math.round((Date.now() - ameStartMs) / 60000) : '?';
        logger.info('weekly_finance_report: AME still running, sending delay notification', { runningMin });

        try {
          const { sendEmail } = await import('../tools/impl/m365.js');
          await sendEmail({
            to: ['michael@jrboehlke.com'],
            subject: `Weekly Finance Report Delayed — AME sync still running`,
            body: `<p style="font-family:Arial,sans-serif;">The weekly finance report is ready to run, but the AuditMatchingEngine sync started at 10 PM Saturday is still in progress (${runningMin} min elapsed).</p><p style="font-family:Arial,sans-serif;">The report will be sent automatically as soon as AME finishes. No action needed.</p>`,
          });
        } catch (e) {
          logger.warn('weekly_finance_report: delay notification failed', { err: e.message });
        }

        // Poll every 2 min until lock gone, stale (>5h old), or 4h timeout
        const pollStart = Date.now();
        await new Promise(resolve => {
          const iv = setInterval(() => {
            if (!existsSync(ameLockFile)) { clearInterval(iv); resolve(); return; }
            try {
              const lockTs = Number(readFileSync(ameLockFile, 'utf8') || 0);
              const lockAge = lockTs ? Date.now() - lockTs : 0;
              if (lockAge > 5 * 60 * 60 * 1000 || Date.now() - pollStart > 4 * 60 * 60 * 1000) {
                clearInterval(iv); resolve();
              }
            } catch { clearInterval(iv); resolve(); }
          }, 2 * 60 * 1000);
        });

        delayMinutes = Math.round((Date.now() - pollStart) / 60000);
        logger.info('weekly_finance_report: AME done (or timed out), proceeding', { delayMinutes });
      }

      try {
        const { runAudit } = await import('../tools/impl/audit.js');
        const { generateAndSendWeeklyFinanceReport } = await import('../tools/impl/weekly-finance-report.js');
        await runAudit();
        const result = await generateAndSendWeeklyFinanceReport({ delayed, delayMinutes });
        logger.info('weekly_finance_report: done', result);
      } catch (err) {
        logger.error('weekly_finance_report: FAILED', { err: err.message });
        try {
          const { sendProactiveMessage } = await import('../teams/notify.js');
          await sendProactiveMessage(`Weekly Finance Report FAILED to send. Error: ${err.message}`);
        } catch (notifyErr) {
          logger.error('weekly_finance_report: Teams alert also failed', { err: notifyErr.message });
        }
      }
    },
  },
  {
    // Monday 8:45 AM — AR/Collections report, ahead of the 9:00-10:00 AR/Collections
    // calendar block. Queries Supabase directly (sa_invoices/audit_issues) rather than
    // waiting on weekly_finance_report/AME locks — worst case it reports on slightly
    // stale data (flagged in the email itself) rather than risking not landing by 8:45
    // if AME is delayed up to its own 4h timeout.
    schedule: '45 8 * * 1',
    name: 'ar_collections_report',
    recoverMissedExecutions: true,
    run: async () => {
      try {
        const { generateAndSendARCollectionsReport } = await import('../tools/impl/ar-collections-report.js');
        const result = await generateAndSendARCollectionsReport();
        logger.info('ar_collections_report: done', result);
      } catch (err) {
        logger.error('ar_collections_report: FAILED', { err: err.message });
        try {
          const { sendProactiveMessage } = await import('../teams/notify.js');
          await sendProactiveMessage(`AR/Collections Report FAILED to send. Error: ${err.message}`);
        } catch (notifyErr) {
          logger.error('ar_collections_report: Teams alert also failed', { err: notifyErr.message });
        }
      }
    },
  },
  {
    // 8 AM on the 12th of every month — Monthly Bank AR/AP Report, 3 days
    // ahead of Michael's typical 15th-of-month bank submission deadline.
    // Reports AR (J.R. Boehlke only) + consolidated AP (both entities) AS OF
    // last month's end date, via QBO's own historical Reports API (see
    // getAgedReportAsOf in quickbooks.js) rather than a live "as of today"
    // snapshot — a bank wants the balance that was actually outstanding on
    // the stated closing date, not whatever's true on the 12th.
    schedule: '0 8 12 * *',
    name: 'bank_monthly_report',
    recoverMissedExecutions: true,
    run: async () => {
      try {
        const { generateAndSendBankMonthlyReport } = await import('../tools/impl/bank-monthly-report.js');
        const result = await generateAndSendBankMonthlyReport();
        logger.info('bank_monthly_report: done', result);
      } catch (err) {
        logger.error('bank_monthly_report: FAILED', { err: err.message });
        try {
          const { sendProactiveMessage } = await import('../teams/notify.js');
          await sendProactiveMessage(`Monthly Bank Report FAILED to send. Error: ${err.message}`);
        } catch (notifyErr) {
          logger.error('bank_monthly_report: Teams alert also failed', { err: notifyErr.message });
        }
      }
    },
  },
  {
    // Tuesday 8:30 AM — Field/Client Meetings briefing, ahead of the 9:00-11:30
    // Field/Client Meetings calendar block. Reads Michael's actual calendar for
    // the day (see field-briefing-report.js) rather than just querying business
    // data — three separate cron entries (Tue/Thu/Fri) since each occurrence has
    // its own block window and lead time.
    schedule: '30 8 * * 2',
    name: 'field_briefing_report_tue',
    recoverMissedExecutions: true,
    run: async () => {
      try {
        const { generateAndSendFieldBriefing } = await import('../tools/impl/field-briefing-report.js');
        const result = await generateAndSendFieldBriefing();
        logger.info('field_briefing_report_tue: done', result);
      } catch (err) {
        logger.error('field_briefing_report_tue: FAILED', { err: err.message });
        try {
          const { sendProactiveMessage } = await import('../teams/notify.js');
          await sendProactiveMessage(`Field/Client Meetings Briefing (Tue) FAILED to send. Error: ${err.message}`);
        } catch (notifyErr) {
          logger.error('field_briefing_report_tue: Teams alert also failed', { err: notifyErr.message });
        }
      }
    },
  },
  {
    // Monday 9:45 AM — 12-Week Cash Forecast, ahead of the 10:00-11:00 12-Week
    // Cash Forecast calendar block. Reuses the same AR aging data as
    // ar_collections_report (8:45 AM) plus a live QBO bank balance, open
    // bills, and a payroll cash-outflow heuristic — see tools/impl/
    // cash-forecast-report.js for the full set of documented assumptions.
    schedule: '45 9 * * 1',
    name: 'cash_forecast_report',
    recoverMissedExecutions: true,
    run: async () => {
      try {
        const { generateAndSendCashForecastReport } = await import('../tools/impl/cash-forecast-report.js');
        const result = await generateAndSendCashForecastReport();
        logger.info('cash_forecast_report: done', result);
      } catch (err) {
        logger.error('cash_forecast_report: FAILED', { err: err.message });
        try {
          const { sendProactiveMessage } = await import('../teams/notify.js');
          await sendProactiveMessage(`12-Week Cash Forecast Report FAILED to send. Error: ${err.message}`);
        } catch (notifyErr) {
          logger.error('cash_forecast_report: Teams alert also failed', { err: notifyErr.message });
        }
      }
    },
  },
  {
    // Thursday 9:30 AM — same briefing, ahead of the 10:00-11:30 Thursday
    // occurrence of the Field/Client Meetings block (this one starts an hour
    // later than Tuesday/Friday, per the President Weekly Block Schedule).
    schedule: '30 9 * * 4',
    name: 'field_briefing_report_thu',
    recoverMissedExecutions: true,
    run: async () => {
      try {
        const { generateAndSendFieldBriefing } = await import('../tools/impl/field-briefing-report.js');
        const result = await generateAndSendFieldBriefing();
        logger.info('field_briefing_report_thu: done', result);
      } catch (err) {
        logger.error('field_briefing_report_thu: FAILED', { err: err.message });
        try {
          const { sendProactiveMessage } = await import('../teams/notify.js');
          await sendProactiveMessage(`Field/Client Meetings Briefing (Thu) FAILED to send. Error: ${err.message}`);
        } catch (notifyErr) {
          logger.error('field_briefing_report_thu: Teams alert also failed', { err: notifyErr.message });
        }
      }
    },
  },
  {
    // Monday 1:45 PM — Sales Pipeline / BD report, ahead of the 2:00-3:00 PM
    // "Outbound Sales / Business Development" calendar block. 'bd' mode leads
    // with pipeline-by-stage + win rate/deal size (sales health, prospecting
    // framing); the follow-up call queue is shown condensed. See
    // tools/impl/sales-pipeline-report.js and the PR description for the full
    // timing rationale (one shared generator, two cron entries).
    schedule: '45 13 * * 1',
    name: 'sales_pipeline_report_bd',
    recoverMissedExecutions: true,
    run: async () => {
      try {
        const { generateAndSendSalesPipelineReport } = await import('../tools/impl/sales-pipeline-report.js');
        const result = await generateAndSendSalesPipelineReport({ mode: 'bd' });
        logger.info('sales_pipeline_report_bd: done', result);
      } catch (err) {
        logger.error('sales_pipeline_report_bd: FAILED', { err: err.message });
        try {
          const { sendProactiveMessage } = await import('../teams/notify.js');
          await sendProactiveMessage(`Sales Pipeline / BD Report (Monday Business Development) FAILED to send. Error: ${err.message}`);
        } catch (notifyErr) {
          logger.error('sales_pipeline_report_bd: Teams alert also failed', { err: notifyErr.message });
        }
      }
    },
  },
  {
    // Friday 8:30 AM — same briefing, ahead of the 9:00-11:30 Friday occurrence
    // of the Field/Client Meetings block.
    schedule: '30 8 * * 5',
    name: 'field_briefing_report_fri',
    recoverMissedExecutions: true,
    run: async () => {
      try {
        const { generateAndSendFieldBriefing } = await import('../tools/impl/field-briefing-report.js');
        const result = await generateAndSendFieldBriefing();
        logger.info('field_briefing_report_fri: done', result);
      } catch (err) {
        logger.error('field_briefing_report_fri: FAILED', { err: err.message });
        try {
          const { sendProactiveMessage } = await import('../teams/notify.js');
          await sendProactiveMessage(`Field/Client Meetings Briefing (Fri) FAILED to send. Error: ${err.message}`);
        } catch (notifyErr) {
          logger.error('field_briefing_report_fri: Teams alert also failed', { err: notifyErr.message });
        }
      }
    },
  },
  {
    // Wednesday 9:30 AM — Accounts Payable report, ahead of the 9:45-10:45 AP
    // calendar block. Live QBO Bill query each run (see getAPAgingReport in
    // quickbooks.js) rather than a Supabase-cached source, so no AME/SA lock
    // to wait on here.
    schedule: '30 9 * * 3',
    name: 'ap_report',
    recoverMissedExecutions: true,
    run: async () => {
      try {
        const { generateAndSendAPReport } = await import('../tools/impl/ap-report.js');
        const result = await generateAndSendAPReport();
        logger.info('ap_report: done', result);
      } catch (err) {
        logger.error('ap_report: FAILED', { err: err.message });
        try {
          const { sendProactiveMessage } = await import('../teams/notify.js');
          await sendProactiveMessage(`Accounts Payable Report FAILED to send. Error: ${err.message}`);
        } catch (notifyErr) {
          logger.error('ap_report: Teams alert also failed', { err: notifyErr.message });
        }
      }
    },
  },
  {
    // Thursday 8:45 AM — Sales Pipeline / BD report, ahead of the 9:00-10:00 AM
    // "Outbound Sales / Lead Follow-Up" calendar block. 'followup' mode leads
    // with the full overdue follow-up call queue (working the existing
    // pipeline framing) rather than the BD/prospecting-health framing above.
    schedule: '45 8 * * 4',
    name: 'sales_pipeline_report_followup',
    recoverMissedExecutions: true,
    run: async () => {
      try {
        const { generateAndSendSalesPipelineReport } = await import('../tools/impl/sales-pipeline-report.js');
        const result = await generateAndSendSalesPipelineReport({ mode: 'followup' });
        logger.info('sales_pipeline_report_followup: done', result);
      } catch (err) {
        logger.error('sales_pipeline_report_followup: FAILED', { err: err.message });
        try {
          const { sendProactiveMessage } = await import('../teams/notify.js');
          await sendProactiveMessage(`Sales Pipeline / BD Report (Thursday Lead Follow-Up) FAILED to send. Error: ${err.message}`);
        } catch (notifyErr) {
          logger.error('sales_pipeline_report_followup: Teams alert also failed', { err: notifyErr.message });
        }
      }
    },
  },
  {
    // Monday 12:45 PM — Marketing Performance report, ahead of the 1:00-2:00 PM
    // Marketing Performance calendar block. Google Ads figures come from
    // tools/impl/google-ads.js's getCampaignMetrics() (see that file's header
    // for why it shells out to the official Python client instead of a Node
    // REST call) — that call degrades to an "unavailable" section on its own
    // rather than throwing, so a bridge/API hiccup doesn't block the
    // SA-sourced won-job figures from still landing on time.
    schedule: '45 12 * * 1',
    name: 'marketing_performance_report',
    recoverMissedExecutions: true,
    run: async () => {
      try {
        const { generateAndSendMarketingPerformanceReport } = await import('../tools/impl/marketing-performance-report.js');
        const result = await generateAndSendMarketingPerformanceReport();
        logger.info('marketing_performance_report: done', result);
      } catch (err) {
        logger.error('marketing_performance_report: FAILED', { err: err.message });
        try {
          const { sendProactiveMessage } = await import('../teams/notify.js');
          await sendProactiveMessage(`Marketing Performance Report FAILED to send. Error: ${err.message}`);
        } catch (notifyErr) {
          logger.error('marketing_performance_report: Teams alert also failed', { err: notifyErr.message });
        }
      }
    },
  },
  {
    // Monday 6:00 AM — marketing re-engagement segment scan, well ahead of
    // both the 12:45 PM marketing_performance_report (which reads back this
    // run's results into its new "Marketing Ideas" section) and the 1:00 PM
    // Marketing Review block. Kept separate from the 12:45 report so this
    // job's SA/Supabase load never risks delaying that time-sensitive send.
    //
    // Runs identify_marketing_segment across all known, hand-verified
    // categories (Sealcoat, Crack Fill, Striping — see
    // tools/impl/marketing-segments.js's SERVICE_CATEGORY_LINE_ITEMS) and
    // writes the results to marketing_segment_candidates for the digest to
    // read back. Each identifySegment() call re-fetches the full SA account
    // roster independently rather than sharing one fetch across categories —
    // a known, accepted inefficiency (a few dozen extra seconds per category,
    // once a week) not worth the added complexity of threading a shared
    // roster through the function for this few categories.
    //
    // Read-only in effect from Michael's perspective — writes only to the
    // scan-results table, never applies an SA tag or drafts anything. That
    // only happens once he reviews and approves via the marketing-advisor
    // agent / apply-reengagement-campaign skill.
    schedule: '0 6 * * 1',
    name: 'marketing_segment_scan',
    recoverMissedExecutions: true,
    run: async () => {
      try {
        const { identifySegment, SERVICE_CATEGORY_LINE_ITEMS } = await import('../tools/impl/marketing-segments.js');
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(process.env.FLEETOPS_SUPABASE_URL, process.env.FLEETOPS_SUPABASE_SERVICE_KEY);

        const scanRunAt = new Date().toISOString();
        let totalWritten = 0;
        for (const serviceCategory of Object.keys(SERVICE_CATEGORY_LINE_ITEMS)) {
          const { candidates, flaggedForReview } = await identifySegment({ serviceCategory });
          const rows = [
            ...candidates.map(c => ({
              service_category: serviceCategory,
              client_id: c.clientId,
              client_name: c.clientName,
              sa_client_guid: c.clientId,
              last_service_or_estimate_date: c.lastServiceDate,
              days_since: c.daysSince,
              match_confidence: 'clean',
              ambiguity_flag: null,
              scan_run_at: scanRunAt,
            })),
            ...flaggedForReview.map(f => ({
              service_category: serviceCategory,
              client_id: f.clientId,
              client_name: f.clientName,
              sa_client_guid: f.clientId,
              last_service_or_estimate_date: f.lastServiceDate,
              days_since: f.daysSince,
              match_confidence: 'flagged',
              ambiguity_flag: f.flags?.join(',') || null,
              scan_run_at: scanRunAt,
            })),
          ];
          if (rows.length > 0) {
            const { error } = await supabase.from('marketing_segment_candidates').insert(rows);
            if (error) throw new Error(`${serviceCategory}: ${error.message}`);
          }
          totalWritten += rows.length;
        }
        logger.info('marketing_segment_scan: done', { totalWritten });
      } catch (err) {
        logger.error('marketing_segment_scan: FAILED', { err: err.message });
        try {
          const { sendProactiveMessage } = await import('../teams/notify.js');
          await sendProactiveMessage(`Marketing segment scan FAILED. Error: ${err.message}`);
        } catch (notifyErr) {
          logger.error('marketing_segment_scan: Teams alert also failed', { err: notifyErr.message });
        }
      }
    },
  },
  {
    // Weekdays 11:15 AM — Approvals Queue report, ahead of the 11:30 AM-12:00 PM
    // Direct Report / Approval Window calendar block. v1 covers expense-report
    // approvals only (see approvals-queue-report.js header comment for why QBO
    // payroll time-off isn't included yet). Skips sending on a genuinely empty
    // queue rather than mailing an "all clear" five days a week.
    schedule: '15 11 * * 1-5',
    name: 'approvals_queue_report',
    recoverMissedExecutions: true,
    run: async () => {
      try {
        const { generateAndSendApprovalsQueueReport } = await import('../tools/impl/approvals-queue-report.js');
        const result = await generateAndSendApprovalsQueueReport();
        logger.info('approvals_queue_report: done', result);
      } catch (err) {
        logger.error('approvals_queue_report: FAILED', { err: err.message });
        try {
          const { sendProactiveMessage } = await import('../teams/notify.js');
          await sendProactiveMessage(`Approvals Queue Report FAILED to send. Error: ${err.message}`);
        } catch (notifyErr) {
          logger.error('approvals_queue_report: Teams alert also failed', { err: notifyErr.message });
        }
      }
    },
  },
  {
    // Tuesday 1:15 PM — Estimating Pipeline report, ahead of the Tue 1:30-4:30 PM
    // "Estimating / Proposal Production" calendar block. Refreshed before EACH of
    // the block's 3 weekly occurrences (Tue/Thu/Fri) rather than once a week —
    // the backlog/aging numbers genuinely move day to day as estimates get built,
    // sent, and won/lost, so a Monday-only snapshot would already be stale by
    // Thursday. See PR description for the full timing rationale.
    schedule: '15 13 * * 2',
    name: 'estimating_pipeline_report_tue',
    recoverMissedExecutions: true,
    run: async () => {
      try {
        const { generateAndSendEstimatingPipelineReport } = await import('../tools/impl/estimating-pipeline-report.js');
        const result = await generateAndSendEstimatingPipelineReport({ blockLabel: "today's 1:30-4:30 PM Estimating/Proposal Production block" });
        logger.info('estimating_pipeline_report_tue: done', result);
      } catch (err) {
        logger.error('estimating_pipeline_report_tue: FAILED', { err: err.message });
        try {
          const { sendProactiveMessage } = await import('../teams/notify.js');
          await sendProactiveMessage(`Estimating Pipeline Report (Tue) FAILED to send. Error: ${err.message}`);
        } catch (notifyErr) {
          logger.error('estimating_pipeline_report_tue: Teams alert also failed', { err: notifyErr.message });
        }
      }
    },
  },
  {
    // Thursday 12:45 PM — same report, ahead of the Thu 1:00-4:30 PM occurrence.
    schedule: '45 12 * * 4',
    name: 'estimating_pipeline_report_thu',
    recoverMissedExecutions: true,
    run: async () => {
      try {
        const { generateAndSendEstimatingPipelineReport } = await import('../tools/impl/estimating-pipeline-report.js');
        const result = await generateAndSendEstimatingPipelineReport({ blockLabel: "today's 1:00-4:30 PM Estimating/Proposal Production block" });
        logger.info('estimating_pipeline_report_thu: done', result);
      } catch (err) {
        logger.error('estimating_pipeline_report_thu: FAILED', { err: err.message });
        try {
          const { sendProactiveMessage } = await import('../teams/notify.js');
          await sendProactiveMessage(`Estimating Pipeline Report (Thu) FAILED to send. Error: ${err.message}`);
        } catch (notifyErr) {
          logger.error('estimating_pipeline_report_thu: Teams alert also failed', { err: notifyErr.message });
        }
      }
    },
  },
  {
    // Friday 12:45 PM — same report, ahead of the Fri 1:00-3:00 PM occurrence.
    schedule: '45 12 * * 5',
    name: 'estimating_pipeline_report_fri',
    recoverMissedExecutions: true,
    run: async () => {
      try {
        const { generateAndSendEstimatingPipelineReport } = await import('../tools/impl/estimating-pipeline-report.js');
        const result = await generateAndSendEstimatingPipelineReport({ blockLabel: "today's 1:00-3:00 PM Estimating/Proposal Production block" });
        logger.info('estimating_pipeline_report_fri: done', result);
      } catch (err) {
        logger.error('estimating_pipeline_report_fri: FAILED', { err: err.message });
        try {
          const { sendProactiveMessage } = await import('../teams/notify.js');
          await sendProactiveMessage(`Estimating Pipeline Report (Fri) FAILED to send. Error: ${err.message}`);
        } catch (notifyErr) {
          logger.error('estimating_pipeline_report_fri: Teams alert also failed', { err: notifyErr.message });
        }
      }
    },
  },
  {
    // Friday 2:45 PM — Weekly Business Scorecard, ahead of the 3:00-4:30 PM
    // "Weekly Review / Next Week Prep" calendar block. A one-page synthesis of
    // cash/AR/AP/marketing/sales/estimating/crew-load — reuses the data
    // gathering already built for the other calendar-block reports rather
    // than re-deriving it (see tools/impl/weekly-scorecard-report.js header).
    schedule: '45 14 * * 5',
    name: 'weekly_scorecard_report',
    recoverMissedExecutions: true,
    run: async () => {
      try {
        const { generateAndSendWeeklyScorecardReport } = await import('../tools/impl/weekly-scorecard-report.js');
        const result = await generateAndSendWeeklyScorecardReport();
        logger.info('weekly_scorecard_report: done', result);
      } catch (err) {
        logger.error('weekly_scorecard_report: FAILED', { err: err.message });
        try {
          const { sendProactiveMessage } = await import('../teams/notify.js');
          await sendProactiveMessage(`Weekly Business Scorecard Report FAILED to send. Error: ${err.message}`);
        } catch (notifyErr) {
          logger.error('weekly_scorecard_report: Teams alert also failed', { err: notifyErr.message });
        }
      }
    },
  },
  {
    // Sunday 11 PM — synthesize week's observations into reusable patterns
    schedule: '0 23 * * 0',
    name: 'weekly_synthesis',
    // Same node-cron missed-tick bug as weekly_finance_report/qb_health_check below —
    // never fired on schedule since at least 2026-08-10. Read-mostly synthesis, safe
    // to catch up.
    recoverMissedExecutions: true,
    run: async () => {
      const { runWeeklySynthesis } = await import('../tools/impl/feedback.js');
      await runWeeklySynthesis();
    },
  },
  {
    schedule: '0 9 * * 3,5',
    name: 'invoice_aging_check',
    // Same node-cron missed-tick bug as weekly_finance_report/qb_health_check below —
    // never fired on schedule since at least 2026-08-10 (confirmed missed even on
    // 2026-08-19, a Wednesday, despite the scheduler being alive at 9 AM that day).
    // Only drafts reminder emails (never auto-sends), safe to catch up.
    recoverMissedExecutions: true,
    run: () => runAgent({
      task: 'Query QuickBooks for all open invoices. Flag invoices past due more than 14 days. Draft polite payment reminder emails. Do NOT send - save drafts to M365 Drafts folder. Return summary list.',
      taskType: 'crm',
      saveContext: false,
    }),
  },
  {
    // 2 AM nightly — bust CardDAV cache so phones get fresh QBO+SA contacts on next sync
    schedule: '0 2 * * *',
    name: 'carddav_cache_refresh',
    run: async () => {
      const { invalidateContactCache } = await import('../tools/impl/carddav.js');
      invalidateContactCache();
      logger.info('CardDAV contact cache invalidated — will refresh on next phone sync');
    },
  },
  {
    // Monday 3 AM — full SA weekly pipeline (estimates, tickets, waiting list, lead matching, sheets)
    schedule: '0 3 * * 1',
    name: 'sa_weekly_sync',
    // Same node-cron missed-tick bug as weekly_finance_report/qb_health_check below —
    // never fired on schedule since at least 2026-08-10, despite the scheduler being
    // continuously alive through the 2026-08-17 Monday window. weekly-sync.js re-syncs
    // current state, safe to catch up.
    recoverMissedExecutions: true,
    run: () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['weekly-sync.js'], {
        cwd: 'C:\\Users\\Assistant\\BTA Reporting',
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 900_000,
      });
      let out = '';
      let err = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('close', code => {
        logger.info('sa_weekly_sync complete', { code, output: out.slice(-2000) });
        if (err) logger.warn('sa_weekly_sync stderr', { stderr: err.slice(-1000) });
        code === 0 ? resolve() : reject(new Error(`weekly-sync.js exited ${code}`));
      });
      child.on('error', reject);
    }),
  },
  {
    // Monday 4 AM — QB weekly revenue pull to Supabase (prior ISO week).
    // Holds the 'qb_weekly_sync' run lock for its whole lifetime (not just the
    // dedup TTL acquireRunLock normally provides) so bta_qb_revenue_report below
    // can wait for it to finish before also touching QB — both spawn separate
    // BTA Reporting scripts that independently refresh/rotate the same
    // Credential-Manager-stored QB refresh token, and running them concurrently
    // risks one process rotating the token out from under the other mid-refresh.
    schedule: '0 4 * * 1',
    name: 'qb_weekly_sync',
    // Same node-cron missed-tick bug as weekly_finance_report/qb_health_check below —
    // never fired on schedule since at least 2026-08-10. This is the direct root cause
    // of qb_invoices/qb_payments (AME's QB-side Supabase cache) sitting ~14 days stale,
    // found 2026-08-19 while investigating a phantom-sync audit finding. Re-pulls prior
    // ISO week's data, safe to catch up.
    recoverMissedExecutions: true,
    run: () => {
      // Actually honor the lock's return value (previously discarded) — hardens the
      // existing dedup mechanism against any overlapping run, regardless of cause.
      if (!acquireRunLock('qb_weekly_sync', 6 * 60_000)) {
        logger.warn('qb_weekly_sync: skipped — already running (lock held)');
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        // NOTE: derives the target ISO week from actual execution time, not the intended
        // 4 AM Monday slot. Harmless for the sub-minute catch-up delays actually observed
        // so far, but a catch-up firing many hours/days late (long stall, or a genuine
        // scheduler restart landing after the missed tick) would pull/label the wrong
        // week. Not fixed here — reworking this to anchor on the intended slot deserves
        // its own dedicated, tested change to a live financial sync script, not a rushed
        // addition alongside enabling recoverMissedExecutions.
        const prev = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const jan1 = new Date(prev.getFullYear(), 0, 1);
        const wn = Math.ceil((((prev - jan1) / 86400000) + jan1.getDay() + 1) / 7);
        const prevWeek = `${prev.getFullYear()}-W${String(wn).padStart(2, '0')}`;
        const child = spawn(process.execPath, ['qb-sync.js', `--week=${prevWeek}`], {
          cwd: 'C:\\Users\\Assistant\\BTA Reporting',
          env: {
            ...process.env,
            SUPABASE_URL: process.env.FLEETOPS_SUPABASE_URL,
            SUPABASE_KEY: process.env.FLEETOPS_SUPABASE_SERVICE_KEY,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 300_000,
        });
        let out = '';
        let err = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err += d; });
        child.on('close', code => {
          logger.info('qb_weekly_sync complete', { code, week: prevWeek, output: out.slice(-2000) });
          if (err) logger.warn('qb_weekly_sync stderr', { stderr: err.slice(-1000) });
          code === 0 ? resolve() : reject(new Error(`qb-sync.js exited ${code}`));
        });
        child.on('error', reject);
      }).finally(() => releaseRunLock('qb_weekly_sync'));
    },
  },
  {
    // Monday 4:15 AM — BTA weekly revenue package (weekly-rp-*.csv, budget-summary).
    // Runs after sa_weekly_sync (3 AM) so division matching against SA won estimates
    // uses fresh data. Was previously only defined in an orphaned, never-deployed
    // copy of this file — it had not run on a schedule since 2026-06-24. Treated as
    // critical: a stale QB revenue package went unnoticed for over a month, so
    // failure here alerts via both Teams and email, not Teams alone.
    schedule: '15 4 * * 1',
    name: 'bta_qb_revenue_report',
    // Same node-cron missed-tick bug as weekly_finance_report/qb_health_check below —
    // never fired on schedule since at least 2026-08-10. Directly relevant to the
    // "stale QB revenue package went unnoticed for over a month" risk called out
    // above — this task existing wasn't sufficient if it never actually ran. Waits on
    // qb_weekly_sync's own lock (hardened below to close a pre-existing TOCTOU gap).
    recoverMissedExecutions: true,
    run: async () => {
      try {
        // qb_weekly_sync (4:00 AM) independently refreshes/rotates the same
        // Credential-Manager QB refresh token — wait for its lock to clear
        // (up to 6 min, matching the lock TTL) before also touching QB.
        // Grace period first: the original check only ever looked once (existsSync),
        // never waiting for the lock to appear — a pre-existing TOCTOU gap that mattered
        // little when these fired 15 min apart on schedule, but is worth closing now that
        // both independently gained recoverMissedExecutions (2026-08-19) and could in
        // principle recover close together. See waitForLockToAppear() near the top of
        // this file.
        const qbSyncLock = join(tmpdir(), 'jrb-scheduler-qb_weekly_sync.lock');
        await waitForLockToAppear(qbSyncLock);
        const waitStart = Date.now();
        while (existsSync(qbSyncLock) && Date.now() - waitStart < 6 * 60_000) {
          await new Promise(r => setTimeout(r, 5000));
        }
        await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['rp-formatter.js'], {
            cwd: 'C:\\Users\\Assistant\\BTA Reporting',
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 600_000,
          });
          let out = '';
          let err = '';
          child.stdout.on('data', d => { out += d; });
          child.stderr.on('data', d => { err += d; });
          child.on('close', code => {
            logger.info('bta_qb_revenue_report complete', { code, output: out.slice(-2000) });
            if (err) logger.warn('bta_qb_revenue_report stderr', { stderr: err.slice(-1000) });
            code === 0 ? resolve() : reject(new Error(`rp-formatter.js exited ${code}: ${err.slice(-500)}`));
          });
          child.on('error', reject);
        });
      } catch (err) {
        logger.error('bta_qb_revenue_report: FAILED', { err: err.message });
        const { sendEmail } = await import('../tools/impl/m365.js');
        await Promise.allSettled([
          sendProactiveMessage(`BTA QB Revenue Report FAILED — rp-formatter.js: ${err.message}`),
          sendEmail({
            to: ['michael@jrboehlke.com'],
            subject: 'BTA Weekly Report FAILED — QB Revenue Package',
            body: `<p style="font-family:Arial,sans-serif;">rp-formatter.js failed during the scheduled Monday BTA report run — revenue CSVs were NOT refreshed this week.</p><p style="font-family:Arial,sans-serif;color:#c00;"><strong>Error:</strong> ${err.message}</p>`,
          }),
        ]);
      }
    },
  },
  {
    // Monday 4:30 AM — BTA SP funnel CSVs from SA data. Non-fatal: the underlying
    // SA data isn't at risk, only this formatted view of it. Last step of the
    // BTA weekly report, so it also sends the completion notification below —
    // Michael wants to know every time this report runs (not just on failure),
    // with the actual per-category numbers visible, after finding and fixing
    // two counting bugs here 2026-07-30/31 (see funnel-summary read below).
    schedule: '30 4 * * 1',
    name: 'bta_sp_funnel_report',
    // Same node-cron missed-tick bug as weekly_finance_report/qb_health_check below —
    // never fired on schedule since at least 2026-08-10. Non-fatal/read-mostly per the
    // note above, safe to catch up.
    recoverMissedExecutions: true,
    run: async () => {
      try {
        await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['sheets-formatter.js'], {
            cwd: 'C:\\Users\\Assistant\\BTA Reporting',
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 180_000,
          });
          let out = '';
          let err = '';
          child.stdout.on('data', d => { out += d; });
          child.stderr.on('data', d => { err += d; });
          child.on('close', code => {
            logger.info('bta_sp_funnel_report complete', { code, output: out.slice(-2000) });
            if (err) logger.warn('bta_sp_funnel_report stderr', { stderr: err.slice(-1000) });
            code === 0 ? resolve() : reject(new Error(`sheets-formatter.js exited ${code}: ${err.slice(-500)}`));
          });
          child.on('error', reject);
        });

        let summaryLines = 'BTA Weekly Report ran — Leads / Est / Won by category:';
        try {
          const year = new Date().getFullYear();
          const summaryPath = 'C:\\Users\\Assistant\\BTA Reporting\\Output\\funnel-summary-' + year + '.json';
          const { summary } = JSON.parse(readFileSync(summaryPath, 'utf8'));
          for (const div of Object.values(summary)) {
            summaryLines += `\n- ${div.label}: Leads ${div.leads} / Est ${div.estimates} / Won ${div.jobs_won} ($${div.dollars_won.toLocaleString()})`;
          }
        } catch (readErr) {
          logger.warn('bta_sp_funnel_report: could not read funnel-summary for notification', { err: readErr.message });
          summaryLines = 'BTA Weekly Report ran (funnel-summary JSON unavailable for detail).';
        }
        await sendProactiveMessage(summaryLines).catch(() => {});
      } catch (err) {
        logger.warn('bta_sp_funnel_report: FAILED (non-fatal)', { err: err.message });
        await sendProactiveMessage(`BTA SP Funnel Report WARNING — sheets-formatter.js: ${err.message}`).catch(() => {});
      }
    },
  },
  {
    // Every 4 hours — QB connectivity health check. Catches ANY auth failure
    // (wrong-app/client mismatch, revoked access, expired token) within a few
    // hours instead of relying only on the calendar-day expiry estimate below,
    // which would have missed the 2026-07-29 "reauthorized against the wrong
    // Intuit app" failure entirely — that broke every QB-dependent feature for
    // a full day before anyone noticed. Alerts once on failure and once on
    // recovery, not on every check, via both Teams and email.
    schedule: '0 */4 * * *',
    name: 'qb_health_check',
    // Confirmed 2026-08-11: node-cron's default ScheduledTask only checks the exact
    // current second on each 1s poll tick (recoverMissedExecutions defaults false) — a
    // multi-second event-loop stall (Puppeteer/network work elsewhere in this process)
    // straddling this task's once-per-4h target second causes a silent, permanent skip
    // for that occurrence, no error logged. Reproduced directly; see
    // project-jrb-agent-architecture memory. This task is read-only (a token fetch) and
    // safe to catch up on, so opt in to node-cron's missed-execution recovery.
    recoverMissedExecutions: true,
    run: async () => {
      const { getQBAccessToken, getQBRealmId, listQBCompanies } = await import('../tools/impl/qb-token.js');
      const axios = (await import('axios')).default;

      for (const company of listQBCompanies()) {
        const realmId = getQBRealmId(company);
        // 'transport' has no realm ID until Michael actually completes its
        // /qb-reauth?company=transport authorization — skip silently rather
        // than alerting about a company that was never connected in the
        // first place.
        if (!realmId) continue;

        try {
          const token = await getQBAccessToken(company);
          await axios.get(
            `https://quickbooks.api.intuit.com/v3/company/${realmId}/companyinfo/${realmId}`,
            { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
          );
          if (qbWasDown.get(company)) {
            qbWasDown.set(company, false);
            await sendProactiveMessage(`✅ QuickBooks connectivity restored (${company}).`).catch(() => {});
          }
        } catch (err) {
          logger.warn('qb_health_check: QB unreachable', { company, err: err.message, status: err.response?.status });
          if (!qbWasDown.get(company)) {
            qbWasDown.set(company, true);
            const { sendEmail } = await import('../tools/impl/m365.js');
            const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
            const msg = `QuickBooks connection is failing for ${company} (status ${err.response?.status ?? 'n/a'}). All QB-dependent features for this company will be affected until reauthorized.\n\nDetail: ${detail}\n\nTo fix: visit https://agent.jrboehlke.com/qb-reauth?secret=<CLAUDE_EXECUTE_SECRET>&company=${company} to reconnect via Intuit. Confirm the realm ID matches ${realmId} before saving.`;
            await Promise.allSettled([
              sendProactiveMessage(`⚠️ ${msg}`),
              sendEmail({
                to: ['michael@jrboehlke.com'],
                subject: `⚠️ QuickBooks Connection Failing (${company})`,
                body: `<p style="font-family:Arial,sans-serif;color:#c00;font-weight:bold;">QuickBooks connection is failing for ${company} (status ${err.response?.status ?? 'n/a'}).</p><p style="font-family:Arial,sans-serif;">${msg.split('\n\n').join('</p><p style="font-family:Arial,sans-serif;">')}</p>`,
              }),
            ]);
          }
        }
      }
    },
  },
  {
    // Every 15 minutes — checked-out branch drift check. A stale/wrong branch
    // silently missing merged features (found 2026-07-30: this machine was
    // running an old unmerged branch, missing qb_reauth_reminder and
    // crackfill_reconciliation with zero indication anything was wrong) is
    // exactly the kind of failure that goes unnoticed for a long time —
    // tightened from every 6 hours after that blind spot let drift go
    // undetected for hours across multiple incidents on 2026-08-08. This
    // check is cheap (one fetch + two metadata reads), so 15 min is safe.
    // Alerts once when drift is detected and once when it clears, not on
    // every check — except when it can safely auto-correct (see below),
    // which always reports what it did.
    schedule: '*/15 * * * *',
    name: 'branch_drift_check',
    run: async () => {
      const REPO_DIR = 'C:\\Users\\Assistant\\JRBAgent';
      try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: REPO_DIR, encoding: 'utf8', timeout: 10_000 }).trim();
        // "HEAD" means detached — another concurrent session on this shared
        // checkout is very likely mid-checkout/rebase (a known pattern on
        // this machine). That's transient, not a real deployment problem;
        // skip this cycle rather than firing a false alarm that will have
        // already resolved itself by the next check.
        if (branch === 'HEAD') {
          logger.debug('branch_drift_check: HEAD is detached (likely a concurrent git operation) — skipping this cycle');
          return;
        }
        execSync('git fetch origin main --quiet', { cwd: REPO_DIR, timeout: 20_000 });
        const behind = parseInt(execSync('git rev-list --count HEAD..origin/main', { cwd: REPO_DIR, encoding: 'utf8', timeout: 10_000 }).trim(), 10) || 0;
        const drifted = branch !== 'main' || behind > 0;

        if (drifted) {
          logger.warn('branch_drift_check: drift detected', { branch, behind });

          if (branchWasDrifted) {
            // Grace period already satisfied (this isn't the first tick a
            // drift was seen — the first-alert branch below handles that).
            // From here on, ALWAYS re-attempt on every tick rather than
            // trying once and giving up: a transient git failure (e.g. a
            // lock held by a concurrent operation) should self-heal on the
            // next 15-min tick, and a tree that was dirty but has since been
            // committed/stashed should get corrected the moment it's safe —
            // neither should require a scheduler restart to recover from.
            // Repeat notifications for an unchanged outcome are throttled to
            // once an hour (below) so this doesn't spam every 15 min.
            // Matches any tracked-file change (modified, staged, staged+further
            // modified "MM", added, deleted, renamed...) — only excludes "??"
            // untracked files, which `git checkout` can't lose (it only ever
            // touches tracked paths; if main happens to already have a file at
            // an untracked path here, checkout errors out cleanly instead of
            // silently overwriting it, and that error is caught below).
            const dirtyFiles = execSync('git status --short', { cwd: REPO_DIR, encoding: 'utf8', timeout: 10_000 })
              .split('\n')
              .filter(line => line.trim() && !line.startsWith('??'))
              .map(line => line.slice(3).trim());

            if (dirtyFiles.length === 0) {
              try {
                if (branch !== 'main') execSync('git checkout main', { cwd: REPO_DIR, timeout: 15_000 });
                execSync('git pull origin main --quiet', { cwd: REPO_DIR, timeout: 20_000 });
                logger.info('branch_drift_check: auto-corrected', { previousBranch: branch, wasBehind: behind });
                await sendProactiveMessage(`🔧 JRBAgent deployment had drifted (${branch !== 'main' ? `was checked out on "${branch}"` : `${behind} commit${behind === 1 ? '' : 's'} behind origin/main`}) — working tree was clean, so this was automatically corrected: now on main and up to date. No action needed. Restart the scheduler/bot if either was running stale code.`).catch(() => {});
                branchWasDrifted = false;
                lastDirtyNoteAt = 0;
                lastFailureNoteAt = 0;
                saveBranchDriftState(false);
              } catch (fixErr) {
                // Distinct timer from the dirty-tree case below — this is a
                // real git failure (e.g. a linked worktree already has main
                // checked out), not just "skipped for safety". Using a
                // separate throttle so a failure note firing doesn't suppress
                // a later dirty-tree note (or vice versa) if the failure mode
                // changes mid-episode. Surfaces stderr when available since
                // execSync's `.message` alone can be an uninformative wrapper.
                const detail = fixErr.stderr?.toString().trim() || fixErr.message;
                logger.warn('branch_drift_check: auto-correct attempt failed', { err: detail });
                if (Date.now() - lastFailureNoteAt > 60 * 60 * 1000) {
                  lastFailureNoteAt = Date.now();
                  await sendProactiveMessage(`⚠️ JRBAgent deployment auto-correction is failing: ${detail.slice(0, 300)}. Still checked out on "${branch}" — will keep retrying automatically every 15 min; check out main and restart the scheduler/bot manually if this doesn't clear on its own.`).catch(() => {});
                }
              }
            } else if (Date.now() - lastDirtyNoteAt > 60 * 60 * 1000) {
              lastDirtyNoteAt = Date.now();
              await sendProactiveMessage(`⚠️ JRBAgent deployment is still checked out on "${branch}". Auto-correction is on hold because the working tree has uncommitted changes (${dirtyFiles.slice(0, 5).join(', ')}${dirtyFiles.length > 5 ? `, +${dirtyFiles.length - 5} more` : ''}) — whoever's session left those needs to commit or stash them first; it'll self-correct automatically (checked every 15 min) once the tree is clean.`).catch(() => {});
            }
          } else {
            branchWasDrifted = true;
            saveBranchDriftState(true);
            const detail = branch !== 'main'
              ? `checked out on "${branch}"${behind > 0 ? `, ${behind} commit${behind === 1 ? '' : 's'} behind origin/main` : ''}`
              : `${behind} commit${behind === 1 ? '' : 's'} behind origin/main`;
            await sendProactiveMessage(`⚠️ JRBAgent deployment is ${detail}. Deployed code may be missing merged features — this exact issue caused qb_reauth_reminder to silently stop running for weeks. Check out main and restart the scheduler/bot when convenient. If the working tree is clean, this will auto-correct on its own in ~15 min.`).catch(() => {});
          }
        } else if (branchWasDrifted) {
          branchWasDrifted = false;
          saveBranchDriftState(false);
          logger.info('branch_drift_check: back on main, up to date');
          await sendProactiveMessage('✅ JRBAgent deployment is back on main and up to date with origin/main.').catch(() => {});
        } else {
          logger.debug('branch_drift_check: on main, up to date');
        }
      } catch (err) {
        logger.warn('branch_drift_check: check failed', { err: err.message });
      }
    },
  },
  {
    // 6 AM daily — overnight SA activity report emailed to Michael
    schedule: '0 6 * * *',
    name: 'overnight_sa_report',
    run: async () => {
      const { generateOvernightReport } = await import('../tools/impl/overnight-report.js');
      const { sendEmail }               = await import('../tools/impl/m365.js');
      const report = await generateOvernightReport();
      await sendEmail({
        to:      ['michael@jrboehlke.com'],
        subject: report.subject,
        body:    report.body,
      });
      logger.info('overnight_sa_report: sent', { subject: report.subject });
    },
  },
  {
    // 7:15 AM / 1:15 PM / 7:15 PM daily — SA<->QBO sync-error watchdog.
    // Cadence reasoning: the recurring 401-cluster burst this job chases happens once a
    // morning (~6:30-6:31 AM per SA's own error timestamps), and SA's own sync batch runs
    // on a ~30 min cadence, so a few checks a day is plenty. Times are chosen to land
    // *between* the other SA-touching jobs in this file (sa_nightly_sync, sa_weekly_sync,
    // qb_weekly_sync, overnight_sa_report 6 AM) rather than on top of any of them —
    // running concurrent SA-touching scripts is a known landmine (session/proxy
    // contention can leave a record half-toggled if a call fails mid-operation).
    schedule: '15 7,13,19 * * *',
    name: 'qbo_sync_watchdog',
    // Confirmed 2026-08-11: never fired across two full scheduled windows despite a
    // valid expression, while sibling tasks in the same registration loop fired fine.
    // Root cause: node-cron's default ScheduledTask only checks the exact current
    // second on each 1s poll tick (recoverMissedExecutions defaults false) — any
    // multi-second event-loop stall straddling this task's narrow once-per-6h target
    // second causes a silent, permanent skip for that occurrence. Reproduced directly
    // against node-cron 3.0.3; see project-jrb-agent-architecture memory. The run itself
    // (runQboSyncWatchdog) already has its own lock + is documented safe to call
    // repeatedly, so opt in to node-cron's missed-execution recovery here.
    recoverMissedExecutions: true,
    run: async () => {
      if (!acquireRunLock('qbo_sync_watchdog', 10 * 60_000)) {
        logger.debug('qbo_sync_watchdog: skipped (another instance still running)');
        return;
      }
      try {
        const { runQboSyncWatchdog } = await import('../tools/impl/qbo-sync-watchdog.js');
        const result = await runQboSyncWatchdog();
        logger.info('qbo_sync_watchdog complete', result);
      } finally {
        releaseRunLock('qbo_sync_watchdog');
      }
    },
  },
  {
    // Every hour — check fleetops auth sequence drift and auto-fix.
    // Ported 2026-08-08 from the dead root-level scheduler/cron.js (this job's tool file,
    // tools/impl/fleetops-healthcheck.js, was always correctly live here — only the cron
    // registration itself was missing from this file, meaning the job has never actually
    // run in production since whatever point the app was split into this agent/ subtree).
    // Original: PR #94, "feat: hourly fleetops auth sequence health check with auto-fix".
    schedule: '0 * * * *',
    name: 'fleetops_healthcheck',
    run: async () => {
      const { runFleetopsHealthcheck } = await import('../tools/impl/fleetops-healthcheck.js');
      const result = await runFleetopsHealthcheck();
      logger.info('fleetops_healthcheck complete', result);
    },
  },
  {
    // 5:35 AM daily — pull live odometer readings from FleetSharp for the ~18 trucks
    // matched by ID convention (FLV018 = "Truck 18") and sync into FleetOps
    // (assets.odometer/odometer_date + odometer_readings history + odometer_sync_log).
    // Supersedes the FleetOps repo's Vercel-cron sync, which called a FleetSharp API
    // that never existed and synced 0 readings across 152 runs since 2026-03-25.
    schedule: '35 5 * * *',
    name: 'fleetops_odometer_sync',
    run: async () => {
      const { runOdometerSync } = await import('../tools/impl/fleetops-odometer-sync.js');
      await runOdometerSync();
    },
  },
  {
    // 6 AM on the 1st of each month (GPS data for the prior month is finalized by then) —
    // one combined Transport + Management email (two .xlsx attachments) for the prior full
    // calendar month, replacing the manual FleetSharp export-and-paste workflow that had a
    // formula bug always classifying every day "Short".
    schedule: '0 6 1 * *',
    name: 'transport_accounting_report',
    recoverMissedExecutions: true,
    run: async () => {
      const { runMonthlyTransportPackage } = await import('../tools/impl/monthly-transport-package.js');
      const now = new Date();
      const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const firstOfPriorMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastOfPriorMonth = new Date(firstOfThisMonth.getTime() - 86400000);
      const toDateStr = (d) => d.toISOString().slice(0, 10);
      await runMonthlyTransportPackage({ startDate: toDateStr(firstOfPriorMonth), endDate: toDateStr(lastOfPriorMonth) });
    },
  },
  {
    // 8 AM daily — warn if either QB company's refresh token is within 14 days of its 101-day expiry
    schedule: '0 8 * * *',
    name: 'qb_reauth_reminder',
    run: async () => {
      const { getQBTokenMeta, getQBRealmId, listQBCompanies, QB_TOKEN_TTL_DAYS } = await import('../tools/impl/qb-token.js');
      const secret = process.env.CLAUDE_EXECUTE_SECRET || '';
      for (const company of listQBCompanies()) {
        if (!getQBRealmId(company)) continue; // not connected yet — nothing to warn about
        const meta = getQBTokenMeta(company);
        if (!meta?.lastRotatedAt) continue; // no timestamp yet — nothing to warn about
        const msPerDay = 86_400_000;
        const daysSince = (Date.now() - new Date(meta.lastRotatedAt).getTime()) / msPerDay;
        const daysRemaining = Math.floor(QB_TOKEN_TTL_DAYS - daysSince);
        if (daysRemaining > 14) continue;
        const url = `https://agent.jrboehlke.com/qb-reauth?secret=${secret}&company=${company}`;
        const msg = daysRemaining > 0
          ? `QuickBooks token for ${company} expires in **${daysRemaining} day${daysRemaining === 1 ? '' : 's'}**. Tap to reconnect: ${url}`
          : `QuickBooks token for ${company} has **expired** (${Math.abs(daysRemaining)} days ago). Tap to reconnect: ${url}`;
        await sendProactiveMessage(msg);
        logger.info('qb_reauth_reminder: sent', { company, daysRemaining });
      }
    },
  },
  {
    // 8:05 AM daily — nudge if the Chase session has expired. The daemon watchdog
    // (below, outside this array) silently refuses to start and just re-logs
    // "session expired, not starting" every 5 minutes forever with no alert — this
    // was a real gap: Michael had no way to know re-init was needed short of reading
    // logs. Re-init requires a real interactive login (2FA, manual navigation), so
    // this can only ever be a reminder, never an auto-fix.
    schedule: '5 8 * * *',
    name: 'chase_session_reminder',
    run: async () => {
      const flagPath = 'C:\\Users\\Assistant\\ChasePoller\\session\\expired.flag';
      if (!existsSync(flagPath)) return;
      const msg = 'Chase session has expired — credit card alert coverage via ChasePoller is down '
        + '(the expense webhook + mailbox poller paths still work independently). '
        + 'To fix: on the JRB-Assistant machine, open a terminal and run '
        + '`cd C:\\Users\\Assistant\\ChasePoller; .\\run.ps1 -Init` — log into Chase Business Online, '
        + 'check "Keep me signed in" and "Remember this device" on 2FA, navigate to the corporate '
        + 'card\'s Account Activity tab, then press Enter in that terminal. The scheduler watchdog '
        + 'picks up the new session automatically within 5 minutes — no restart needed.';
      await sendProactiveMessage(msg);
      logger.info('chase_session_reminder: sent');
    },
  },
  {
    // Every 15 minutes — autonomous triage of michael@jrboehlke.com inbox.
    // Re-enabled 2026-08-24 (was disabled 2026-06-05 pending a behavior redesign —
    // see tools/impl/inbox-processor.js's header comment): rebuilt on Fyxer.ai's
    // 3-bucket model (needs_reply/fyi/marketing) instead of the old P1/P2/P3
    // scheme, plus tone-matched draft replies. acquireRunLock added here — the
    // original disabled version never had one, and a run can take long enough
    // (Haiku classify + Sonnet drafts + folder moves) to risk overlapping the
    // next 15-min tick.
    schedule: '*/15 * * * *',
    name: 'michael_inbox_processor',
    run: async () => {
      if (!acquireRunLock('michael_inbox_processor', 14 * 60_000)) {
        logger.debug('michael_inbox_processor: skipped (another instance running)');
        return;
      }
      try {
        const { processInbox } = await import('../tools/impl/inbox-processor.js');
        const result = await processInbox();
        logger.info('michael_inbox_processor: complete', result);
      } catch (err) {
        logger.error('michael_inbox_processor: FAILED', { err: err.message });
        try {
          await sendProactiveMessage(`Inbox processor FAILED. Error: ${err.message}`);
        } catch (notifyErr) {
          logger.error('michael_inbox_processor: Teams alert also failed', { err: notifyErr.message });
        }
      } finally {
        releaseRunLock('michael_inbox_processor');
      }
    },
  },
  {
    // 7:00 AM daily — scan Michael's sent folder for unanswered emails.
    // Re-enabled 2026-08-24 (see michael_inbox_processor above) — scanFollowups()
    // itself is unchanged, Michael explicitly wanted this feature kept as-is.
    schedule: '0 7 * * *',
    name: 'followup_scanner',
    recoverMissedExecutions: true,
    run: async () => {
      try {
        const { scanFollowups } = await import('../tools/impl/inbox-processor.js');
        const result = await scanFollowups();
        logger.info('followup_scanner: complete', result);
      } catch (err) {
        logger.error('followup_scanner: FAILED', { err: err.message });
        try {
          await sendProactiveMessage(`Follow-up scanner FAILED. Error: ${err.message}`);
        } catch (notifyErr) {
          logger.error('followup_scanner: Teams alert also failed', { err: notifyErr.message });
        }
      }
    },
  },
  {
    // 7:30 AM daily — morning briefing Teams message + email to Michael.
    // Re-enabled 2026-08-24 (see michael_inbox_processor above) — briefing content
    // updated to the new needs_reply/fyi/marketing bucket stats.
    schedule: '30 7 * * *',
    name: 'morning_briefing',
    recoverMissedExecutions: true,
    run: async () => {
      try {
        const { generateMorningBriefing } = await import('../tools/impl/morning-briefing.js');
        const { sendEmail }               = await import('../tools/impl/m365.js');

        const briefing = await generateMorningBriefing();

        // Teams message first — fast, Michael may be on his phone
        try {
          await sendProactiveMessage(briefing.teamsMessage);
          logger.info('morning_briefing: Teams message sent');
        } catch (err) {
          logger.warn('morning_briefing: Teams send failed', { err: err.message });
        }

        // Full HTML email
        await sendEmail({
          to:      ['michael@jrboehlke.com'],
          subject: briefing.emailSubject,
          body:    briefing.emailBody,
        });
        logger.info('morning_briefing: email sent', { subject: briefing.emailSubject });
      } catch (err) {
        logger.error('morning_briefing: FAILED', { err: err.message });
        try {
          await sendProactiveMessage(`Morning briefing FAILED to generate/send. Error: ${err.message}`);
        } catch (notifyErr) {
          logger.error('morning_briefing: Teams alert also failed', { err: notifyErr.message });
        }
      }
    },
  },
  {
    // 1:30 AM nightly — refresh sa_waiting_list from SA and prune completed/invoiced jobs
    schedule: '30 1 * * *',
    name: 'sa_waiting_list_sync',
    // Same node-cron missed-tick bug as weekly_finance_report/qb_health_check above —
    // confirmed live 2026-08-28: sa_sync_log/sa_waiting_list.extracted_at show this task
    // silently never fired once in the 8/20-8/28 window (every other task at :00/:30
    // registered in this file fired every night without fail), while data went stale by
    // 7-10 days. This once-a-day task gets exactly one chance to hit its target second;
    // the SA browser work this process does elsewhere is the kind of event-loop stall
    // that eats that one chance. Read-only refresh, safe to catch up on.
    recoverMissedExecutions: true,
    run: async () => {
      // sa_nightly_sync (1:00 AM, immediately above) does its own independent SA login
      // and also writes sa_waiting_list. Normally 30 min apart, but both tasks now have
      // recoverMissedExecutions — a restart landing after both were missed would replay
      // them back-to-back instead of staggered, and concurrent SA sessions have already
      // caused a real production incident here (the 2026-08-19/20 backfill run: a
      // concurrent SA probe tripped Incapsula's bot-detection and set a shared 45-min
      // backoff that silently failed ~9,926 in-flight rows). Same
      // wait-then-poll-with-cap pattern as bta_qb_revenue_report waiting on
      // qb_weekly_sync's lock, below.
      const nightlySyncLock = join(tmpdir(), 'jrb-scheduler-sa_nightly_sync.lock');
      await waitForLockToAppear(nightlySyncLock);
      const waitStart = Date.now();
      while (existsSync(nightlySyncLock) && Date.now() - waitStart < 10 * 60_000) {
        await new Promise(r => setTimeout(r, 5000));
      }
      const { syncWaitingList } = await import('../tools/impl/serviceautopilot.js');
      const result = await syncWaitingList();
      logger.info('sa_waiting_list_sync complete', result);
    },
  },
  {
    // 6:30 AM nightly — reconcile Lbs of Crackfill for PMM clients with Pavement Size set.
    // Runs after overnight_sa_report (6 AM) which wakes the SA browser session.
    schedule: '30 6 * * *',
    name: 'crackfill_reconciliation',
    run: async () => {
      if (!acquireRunLock('crackfill_reconciliation', 30 * 60_000)) {
        logger.debug('crackfill_reconciliation: skipped (another instance running)');
        return;
      }
      try {
        const { createClient } = await import('@supabase/supabase-js');
        const { setClientCrackfill } = await import('../tools/impl/serviceautopilot.js');
        const sb = createClient(process.env.FLEETOPS_SUPABASE_URL, process.env.FLEETOPS_SUPABASE_SERVICE_KEY);

        const { data: rows, error } = await sb
          .from('sa_waiting_list')
          .select('client_id')
          .ilike('service_code', 'PMM%')
          .not('client_id', 'is', null)
          .not('pavement_sf', 'is', null);
        if (error) throw new Error(`crackfill_reconciliation query: ${error.message}`);

        const clientIds = [...new Set((rows || []).map(r => r.client_id).filter(Boolean))];
        logger.info('crackfill_reconciliation: starting', { total: clientIds.length });

        let updated = 0; let skipped = 0; let failed = 0;
        for (const clientId of clientIds) {
          try {
            const result = await setClientCrackfill({ clientId });
            result.skipped ? skipped++ : updated++;
          } catch (err) {
            logger.warn('crackfill_reconciliation: failed for client', { clientId, err: err.message });
            failed++;
          }
          await new Promise(r => setTimeout(r, 300));
        }
        logger.info('crackfill_reconciliation: complete', { updated, skipped, failed, total: clientIds.length });
      } finally {
        releaseRunLock('crackfill_reconciliation');
      }
    },
  },
  {
    // 1 AM nightly — run all SA syncs (waiting list + scheduled jobs)
    schedule: '0 1 * * *',
    name: 'sa_nightly_sync',
    // Same node-cron missed-tick bug as sa_waiting_list_sync / weekly_finance_report
    // above — confirmed live 2026-08-28 via sa_sync_log: this task silently never fired
    // once in the 8/20-8/28 window while every other :00/:30 task in this file fired
    // nightly without fail, leaving sa_jobs 10 days stale with zero error logged. Spawns
    // a separate script; safe to catch up on a missed night.
    recoverMissedExecutions: true,
    run: () => {
      // Holds the lock sa_waiting_list_sync (1:30 AM, above) waits on — see that task's
      // comment for why: recoverMissedExecutions on both tasks means a restart could
      // otherwise replay them concurrently instead of staggered, and concurrent SA
      // sessions have already caused a real production incident in this codebase.
      if (!acquireRunLock('sa_nightly_sync', 12 * 60_000)) {
        logger.warn('sa_nightly_sync: skipped — already running (lock held)');
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['sa-nightly-sync.js'], {
          cwd: 'C:\\Users\\Assistant\\BTA Reporting',
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 600_000,
        });
        let out = '';
        let err = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err += d; });
        child.on('close', code => {
          logger.info('sa_nightly_sync complete', { code, output: out.slice(-2000) });
          if (err) logger.warn('sa_nightly_sync stderr', { stderr: err.slice(-1000) });
          code === 0 ? resolve() : reject(new Error(`sa-nightly-sync.js exited ${code}`));
        });
        child.on('error', reject);
      }).finally(() => releaseRunLock('sa_nightly_sync'));
    },
  },
  {
    // 2 AM nightly — current-SA estimate sync: refresh headers, then pull per-service
    // line items for any estimate not yet covered. Staggered after sa_nightly_sync (1 AM)
    // and sa_waiting_list_sync (1:30 AM) — see those tasks' comments on why concurrent SA
    // browser sessions from this codebase have caused real incidents before.
    //
    // Estimate headers (jrb-jobs `estimates` table) had NO scheduled refresh at all before
    // this task — import-current-to-jrb.js/import-current-sa.ps1 existed but were manual-only
    // (confirmed 2026-08-29: no Task Scheduler entry, no cron.js entry, no Vercel cron in
    // jrb-jobs). The header refresh is chained in front of the line-item pull for a concrete
    // reason, not just tidiness: 14-current-sa-estimate-lines.js only pulls line items for
    // estimate rows that already exist in `estimates` -- without a header refresh running
    // first, any estimate created after this task ships would never get its line items
    // pulled either, silently. Both steps upsert/insert idempotently and are safe to re-run.
    //
    // 14-current-sa-estimate-lines.js also re-checks every estimate with at least one
    // non-terminal (not Won/Lost) line item on every run, not just brand-new estimates --
    // otherwise a status change on an old estimate (e.g. a 45-day-old pending quote
    // finally marked Won) would never be captured after its first pull. This means the
    // line-item step's real runtime depends on how much of the pipeline is still open,
    // not just how many estimates are new -- expect it to run considerably longer than a
    // pure new-estimate diff, especially for the first several nights after this shipped
    // (2026-08-29) while the initial backlog of open quotes gets checked down. Worth
    // watching actual run duration against sa_client_classification_incremental's 4:30 AM
    // start if this task is ever seen running unusually long.
    schedule: '0 2 * * *',
    name: 'sa_estimate_line_sync',
    recoverMissedExecutions: true,
    run: async () => {
      // Same wait-then-poll-with-cap pattern as sa_waiting_list_sync waiting on
      // sa_nightly_sync's lock, above -- recoverMissedExecutions on all three tasks
      // means a restart could otherwise replay them concurrently instead of staggered,
      // and concurrent SA browser sessions have already caused a real production
      // incident in this codebase. sa_waiting_list_sync itself holds no lock of its
      // own to wait on (confirmed in this file), so sa_nightly_sync's lock is the
      // only one available to guard against here.
      const nightlySyncLock = join(tmpdir(), 'jrb-scheduler-sa_nightly_sync.lock');
      await waitForLockToAppear(nightlySyncLock);
      const waitStart = Date.now();
      while (existsSync(nightlySyncLock) && Date.now() - waitStart < 12 * 60_000) {
        await new Promise(r => setTimeout(r, 5000));
      }

      // TTL covers both chained children's timeouts plus overhead -- must exceed the
      // worst-case combined runtime, or a recoverMissedExecutions catch-up could see this
      // lock as stale mid-run and start a second overlapping instance. The line-items
      // child's own timeout is deliberately generous (2h) given the re-check-until-resolved
      // behavior documented above -- a hard 15-min cap would routinely kill it mid-run
      // rather than let it actually catch status changes on older open estimates.
      if (!acquireRunLock('sa_estimate_line_sync', 150 * 60_000)) {
        logger.warn('sa_estimate_line_sync: skipped — already running (lock held)');
        return Promise.resolve();
      }
      const runChild = (script, cwd, env, timeoutMs = 900_000) => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script], {
          cwd,
          env: { ...process.env, ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        let timedOut = false;
        // Not spawn()'s own `timeout` option -- that only SIGTERMs the node process itself,
        // never any Chromium subprocess it launched via playwright-core, so a timed-out
        // 14-current-sa-estimate-lines.js could leave an orphaned SA browser session alive
        // right as the lock releases -- the same class of concurrent-session incident this
        // task's comments already warn about. taskkill /t kills the whole process tree,
        // same pattern already used for the scheduler's own self-dedup at the top of this file.
        const killTimer = setTimeout(() => {
          timedOut = true;
          try { execSync(`taskkill /f /t /pid ${child.pid}`, { encoding: 'utf8', timeout: 5000 }); } catch {}
        }, timeoutMs);
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err += d; });
        child.on('close', code => {
          clearTimeout(killTimer);
          logger.info(`sa_estimate_line_sync: ${script} complete`, { code, output: out.slice(-2000), timedOut });
          if (err) logger.warn(`sa_estimate_line_sync: ${script} stderr`, { stderr: err.slice(-1000) });
          if (timedOut) return reject(new Error(`${script} timed out after ${timeoutMs}ms and was killed`));
          code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`));
        });
        child.on('error', reject);
      });

      return runChild('import-current-to-jrb.js', 'C:\\Users\\Assistant\\sa-history', {
        SUPABASE_FLEETOPS_URL: process.env.FLEETOPS_SUPABASE_URL,
        SUPABASE_FLEETOPS_KEY: process.env.FLEETOPS_SUPABASE_SERVICE_KEY,
        IMPORT_ESTIMATOR_ID:   '09ecaf4e-4b96-472b-aba5-526f26ad0eeb', // michael@jrboehlke.com
      })
        .then(() => runChild('extract\\14-current-sa-estimate-lines.js', 'C:\\Users\\Assistant\\sa-history', {}, 120 * 60_000))
        .finally(() => releaseRunLock('sa_estimate_line_sync'));
    },
  },
  {
    // Every 30 minutes — check SA connectivity, alert Michael on first failure and on recovery
    schedule: '*/30 * * * *',
    name: 'sa_connectivity_check',
    // Confirmed 2026-09-03 via cron_missed_fire_watchdog: this task repeatedly missed its
    // */30 tick (15:00, 16:30, 17:00, and 18:00 all silently skipped within a few hours)
    // despite the scheduler being continuously alive the whole time -- the same node-cron
    // missed-tick bug already documented and fixed on 15+ other tasks in this file
    // (qb_health_check, weekly_finance_report, sa_weekly_sync, qbo_sync_watchdog, etc.):
    // node-cron's default ScheduledTask only checks the exact current second on each 1s
    // poll tick (recoverMissedExecutions defaults false), so a multi-second event-loop
    // stall straddling this task's target second causes a silent, permanent skip for that
    // occurrence, no error logged. This run is a read-only connectivity probe + alert with
    // no side effects beyond notification, safe to opt in to catch-up.
    recoverMissedExecutions: true,
    run: async () => {
      const { searchClients, checkProxyHealth } = await import('../tools/impl/serviceautopilot.js');
      const { sendProactiveMessage } = await import('../teams/notify.js');
      try {
        await searchClients({ name: 'APIProbe', limit: 1 });
        if (saWasDown) {
          saWasDown = false;
          logger.info('sa_connectivity_check: SA connectivity restored');
          try { await sendProactiveMessage('✅ SA connectivity restored — ticket creation and CRM tools are back online.'); } catch {}
        } else {
          logger.debug('sa_connectivity_check: SA reachable');
        }
      } catch (err) {
        logger.warn('sa_connectivity_check: SA unreachable', { err: err.message });
        if (!saWasDown) {
          saWasDown = true;
          const proxyHealth = await checkProxyHealth().catch(() => null);
          // checkProxyHealth now runs its CONNECT probe even during an active Incapsula
          // backoff (the probe never touches SA/Incapsula, so backoff has no bearing on
          // it) — surface both signals so it's clear whether this outage is proxy-caused,
          // Incapsula-caused, or both.
          const backoffNote = proxyHealth?.incapsulaBackoffActive ? ' (Incapsula backoff also active)' : '';
          const proxyNote = proxyHealth?.checked ? `\nProxy check: ${proxyHealth.detail}${backoffNote}` : '';
          if (proxyHealth?.checked) logger.warn('sa_connectivity_check: proxy health', proxyHealth);
          try { await sendProactiveMessage(`⚠️ SA connectivity lost — ticket creation and CRM tools are offline.\n\nError: ${err.message.slice(0, 200)}${proxyNote}`); } catch {}
        }
      }
    },
  },
  {
    // Hourly — Google Ads Agent health check. Hits the daemon's own health endpoint
    // directly on localhost, NOT the public https://agent.jrboehlke.com/ads-health URL —
    // this machine hosts the daemon itself, so a local check has no dependency on the
    // Cloudflare tunnel, bot.js's proxy route, or any external egress path. Replaces a
    // cloud routine (trig_01UUoUnrmBfYMizeA84m6uwu) that hit the public URL via the
    // WebFetch tool from a Claude cloud sandbox — that sandbox's own egress allowlist
    // rejected the request with a 403 even though the daemon was healthy the whole time
    // (confirmed 2026-07-31: a direct curl from that same session succeeded immediately).
    // Same alert-once-on-failure/once-on-recovery pattern as sa_connectivity_check/qb_health_check.
    schedule: '23 * * * *',
    name: 'ads_health_check',
    run: async () => {
      try {
        const res = await fetch('http://localhost:8765/health', { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`health endpoint returned ${res.status}`);
        const data = await res.json();
        if (data.status !== 'ok') throw new Error(`status=${data.status} hours_since_last_run=${data.hours_since_last_run}`);
        if (adsHealthWasDown) {
          adsHealthWasDown = false;
          logger.info('ads_health_check: Google Ads Agent health restored');
          await sendProactiveMessage('✅ Google Ads Agent health check restored — daemon is reachable and healthy again.').catch(() => {});
        } else {
          logger.debug('ads_health_check: healthy', data);
        }
      } catch (err) {
        logger.warn('ads_health_check: unhealthy or unreachable', { err: err.message });
        if (!adsHealthWasDown) {
          adsHealthWasDown = true;
          await sendProactiveMessage(`⚠️ Google Ads Agent health check failed — daemon may be down.\n\nError: ${err.message}`).catch(() => {});
        }
      }
    },
  },
  {
    // Every 10 minutes — Phase 1+3 of the "autonomous schedule manager"
    // roadmap agreed with Michael 2026-08-20. Detects new/changed events on
    // his calendar that aren't JRB block-schedule blocks (a real meeting
    // appearing, or an invite being accepted) via calendar-watch.js's Graph
    // delta query, then (2026-08-24, Phase 3) actually reconciles each one
    // against that day's block schedule via
    // block-schedule-reconciler.js -- a real invite now displaces ANY block,
    // PROTECTED/DEEP_WORK included, per Michael's confirmed general rule
    // ("as a general rule, move to accommodate real invites"), with the
    // reconciler's own named exceptions (see EXEMPTIONS there) left alone.
    // No overlap lock between runs -- a run overlapping the next tick could
    // race on calendar_delta_state's upsert. Accepted: this task's own Graph
    // calls are lightweight (single page for a normal mailbox, confirmed
    // live) and finish in well under 10 minutes in every observed run.
    schedule: '*/10 * * * *',
    name: 'calendar_change_watch',
    run: async () => {
      try {
        const { getCalendarChanges } = await import('../tools/impl/calendar-watch.js');
        const { reconcileRealEventAgainstBlocks } = await import('../tools/impl/block-schedule-reconciler.js');
        const MAILBOX = 'michael@jrboehlke.com';
        const changes = await getCalendarChanges({ mailbox: MAILBOX });
        for (const e of changes) {
          // Keyed on id + lastModifiedDateTime, not just id -- a later genuine
          // change to an already-notified event (reschedule, new acceptance)
          // must still be reported, not swallowed as a false-positive repeat.
          const dedupeKey = `${e.id}:${e.lastModifiedDateTime}`;
          if (notifiedCalendarChangeIds.has(dedupeKey)) continue;
          if (e.isCancelled) { notifiedCalendarChangeIds.add(dedupeKey); continue; } // nothing to notify, but don't re-process forever
          // e.start is assumed to be a bare UTC dateTime string (confirmed
          // live: Graph returns calendarView/delta times in UTC by default
          // with no Prefer header sent). Guard the parse anyway -- an
          // unexpected format would otherwise render as "Invalid Date" in
          // the Teams message with no indication the time is unreliable,
          // rather than the honest "unknown time" already used when e.start
          // is missing entirely.
          const parsedStart = e.start ? new Date(e.start + 'Z') : null;
          const when = parsedStart && !isNaN(parsedStart.getTime())
            ? parsedStart.toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' })
            : 'unknown time';
          const acceptedNote = e.responseStatus === 'accepted' && !e.isOrganizer ? ' (just accepted)' : '';

          // Graph's delta feed can redeliver neighboring occurrences of a
          // recurring series as "changed" whenever any one occurrence gets
          // an exception (confirmed live 2026-08-24, immediately after this
          // reconciler shrunk several block-schedule occurrences) -- some of
          // those redeliveries carry no subject/start at all. Skip silently
          // rather than reconcile against garbage or send a useless
          // "undefined at unknown time" alert. The other historical source of
          // a missing subject (Graph's delta endpoint omitting inherited
          // fields on occurrence expansions) is now fixed at the source in
          // calendar-watch.js's bootstrapUrl $select -- this guard is
          // defense-in-depth against the redelivery case, not a workaround
          // for that one.
          if (!e.subject || !e.start) { notifiedCalendarChangeIds.add(dedupeKey); continue; }

          let reconcileNote = '';
          try {
            const result = await reconcileRealEventAgainstBlocks({ mailbox: MAILBOX, realEvent: e });
            if (result.skipped) {
              reconcileNote = '';
            } else {
              const parts = [];
              if (result.accepted) parts.push('auto-accepted (Breakthrough Academy)');
              if (result.resolvedActions.length) {
                parts.push(...result.resolvedActions.map(a =>
                  `**${a.blockSubject}** (${a.tier}) ${a.action}${a.droppedMinutes ? ` — ${a.droppedMinutes} min lost` : ''}`
                ));
              }
              if (result.exempted.length) {
                parts.push(...result.exempted.map(x => `left **${x.blockSubject}** untouched (known intentional overlap)`));
              }
              if (parts.length) reconcileNote = '\n' + parts.map(p => `↳ ${p}`).join('\n');
            }
          } catch (reconcileErr) {
            logger.warn('calendar_change_watch: block-schedule reconciliation failed', { err: reconcileErr.message, subject: e.subject });
            reconcileNote = '\n↳ ⚠️ Block-schedule reconciliation failed — review manually.';
          }

          try {
            await sendProactiveMessage(
              `📅 New calendar item detected${acceptedNote}: **${e.subject}** at ${when}.${reconcileNote}`
            );
            // Only mark as handled once the send actually succeeds -- marking
            // it beforehand would permanently drop this change if the send
            // failed (network blip, Bot Framework token issue), since the
            // delta cursor has already moved past it and Graph won't
            // redeliver it on a later poll.
            notifiedCalendarChangeIds.add(dedupeKey);
          } catch (sendErr) {
            logger.warn('calendar_change_watch: notification send failed, will retry next poll', { err: sendErr.message, subject: e.subject });
          }
        }
        // Bound memory rather than grow unbounded across a long-running process.
        // Prune to the most recent half rather than a full wipe -- Graph can
        // redeliver a just-notified change on the very next poll (confirmed
        // live during testing), and a full clear would defeat the redelivery
        // guard for everything notified just before the cap was hit, not only
        // genuinely old entries.
        if (notifiedCalendarChangeIds.size > 500) {
          const recent = Array.from(notifiedCalendarChangeIds).slice(-250);
          notifiedCalendarChangeIds.clear();
          recent.forEach(k => notifiedCalendarChangeIds.add(k));
        }
        if (calendarWatchWasDown) {
          calendarWatchWasDown = false;
          logger.info('calendar_change_watch: recovered');
          await sendProactiveMessage('✅ Calendar change monitoring recovered — detection is back online.').catch(() => {});
        }
      } catch (err) {
        // Same alert-once-on-failure/once-on-recovery pattern as
        // sa_connectivity_check/ads_health_check -- a 10-minute task that
        // just logged and stayed silent on failure would leave Michael with
        // no signal that calendar monitoring stopped working.
        const errMsg = err?.message ?? String(err); // tolerate a non-Error throw rather than crashing this catch itself
        logger.error('calendar_change_watch: failed', { err: errMsg });
        if (!calendarWatchWasDown) {
          calendarWatchWasDown = true;
          await sendProactiveMessage(`⚠️ Calendar change monitoring failed — new meetings/accepted invites won't be detected until this recovers.\n\nError: ${errMsg.slice(0, 200)}`).catch(() => {});
        }
      }
    },
  },
  {
    // Every 10 minutes — process the self-heal queue. teams/notify.js enqueues every
    // outbound Teams message matching this codebase's actual alert convention
    // (⚠️/FAILED/WARNING) to a local JSON queue. For each new entry, this runs an
    // unattended investigate-and-fix pass via the agent's own agentic loop (taskType
    // 'auto_fix' — same tools as 'code' minus github_merge_pr, so it can open a PR
    // for Michael but can never merge one itself, since nobody is watching this run).
    // Cooldown by signature (digit-stripped message prefix) stops a still-flapping
    // alert — e.g. the SA proxy check, which can legitimately fire every 30 min while
    // a known issue is being worked — from spawning a fresh fix attempt every time.
    schedule: '*/10 * * * *',
    name: 'self_heal_watcher',
    run: async () => {
      const { SELF_HEAL_QUEUE_PATH, writeFileAtomic, sendProactiveMessage: notify, buildAutoFixPrompt } = await import('../teams/notify.js');
      const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
      const STALE_PROCESSING_MS = 30 * 60 * 1000; // 30 min — far longer than any real runAgent call
      const MAX_PER_RUN = 2; // bound how much work one tick can kick off
      const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

      // Re-reads the file fresh and patches by id on every transition, rather than
      // holding the whole array across an `await runAgent(...)` (which can run for
      // minutes) and writing it back at the end — that pattern would silently drop
      // any alert notify.js enqueues while a remediation run is in flight. This does
      // NOT make patchEntry atomic with notify.js's enqueueSelfHeal across process
      // boundaries (the Teams Bot and Scheduler are separate OS processes) — only
      // that a crash partway through this run can't lose an already-completed
      // entry's status. Uses the same atomic (write-temp-then-rename) + retry
      // strategy as enqueueSelfHeal for the same reason: a torn read from the other
      // process mid-write is a real, if rare, possibility on Windows.
      const patchEntry = async (id, updates) => {
        const MAX_RETRIES = 3;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          try {
            let current;
            try {
              current = JSON.parse(readFileSync(SELF_HEAL_QUEUE_PATH, 'utf8'));
            } catch (readErr) {
              // ENOENT (no queue file yet) is expected and silent. Anything else —
              // a corrupted/partial file — silently no-opping here would leave this
              // entry permanently stuck at whatever status it already had (e.g.
              // 'processing' forever), with no trace of why. Warn so it's visible.
              if (readErr.code !== 'ENOENT') {
                logger.warn('self_heal_watcher: patchEntry could not read queue file', { id, err: readErr.message });
              }
              return;
            }
            const idx = current.findIndex(e => e.id === id);
            if (idx === -1) return;
            current[idx] = { ...current[idx], ...updates };
            writeFileAtomic(SELF_HEAL_QUEUE_PATH, JSON.stringify(current, null, 2));
            return; // success
          } catch (err) {
            if (attempt < MAX_RETRIES - 1) {
              // Async delay, not a busy-wait — this process also runs every other
              // scheduled task, so blocking the event loop here would stall them too.
              await sleep(20 * (attempt + 1));
            } else {
              logger.warn('self_heal_watcher: patchEntry failed', { id, err: err.message });
            }
          }
        }
      };

      let queue;
      try { queue = JSON.parse(readFileSync(SELF_HEAL_QUEUE_PATH, 'utf8')); }
      catch { return; } // nothing queued yet

      // Eligible for processing: normal 'pending' entries, PLUS 'processing' entries
      // stuck past STALE_PROCESSING_MS — the only way an entry stays 'processing'
      // that long is a crash/kill mid-run, since runAgent has never legitimately
      // taken 30 minutes. Without this, a crash permanently strands that entry,
      // since nothing else ever revisits 'processing' status.
      const runStartedAt = Date.now();
      const eligible = queue.filter(e =>
        e.status === 'pending' ||
        (e.status === 'processing' && (!e.processing_started_at || runStartedAt - new Date(e.processing_started_at).getTime() > STALE_PROCESSING_MS))
      );
      if (!eligible.length) return;

      const lastProcessedAt = {};
      for (const e of queue) {
        if (e.status === 'done' || e.status === 'failed') {
          if (!lastProcessedAt[e.signature] || e.processed_at > lastProcessedAt[e.signature]) {
            lastProcessedAt[e.signature] = e.processed_at;
          }
        }
      }

      let processedCount = 0, skippedCooldown = 0;
      for (const entry of eligible) {
        const last = lastProcessedAt[entry.signature];
        if (last && Date.now() - new Date(last).getTime() < COOLDOWN_MS) {
          // Deliberately does NOT patch status — leaving it 'pending' means this
          // entry is simply re-evaluated on the next tick, and gets processed
          // automatically once the cooldown actually expires. Marking it with a
          // terminal 'skipped_cooldown' status here would abandon it permanently,
          // since nothing else ever picks that status back up.
          skippedCooldown++;
          continue;
        }
        if (processedCount >= MAX_PER_RUN) continue; // stays 'pending' for the next tick

        await patchEntry(entry.id, { status: 'processing', processing_started_at: new Date().toISOString() });
        try {
          logger.info('self_heal_watcher: investigating', { id: entry.id, message: entry.message.slice(0, 100) });
          // Defense in depth against prompt injection: entry.message was already
          // sanitized (sanitizeForPrompt in notify.js, which strips ALL '<'/'>'
          // characters from untrusted content) before being queued, AND it's
          // wrapped here in an <alert_message> tag that — precisely because the
          // sanitizer strips every angle bracket from the payload — cannot be
          // faked or escaped from within entry.message itself. Quote-stripping
          // alone protects against breaking out of a `"..."` string; this
          // structural delimiter protects even if some other injection vector
          // the sanitizer doesn't yet cover is ever found.
          const { result } = await runAgent({
            taskType: 'auto_fix',
            task: buildAutoFixPrompt(entry.message, 'cron'),
          });
          const now = new Date().toISOString();
          await patchEntry(entry.id, { status: 'done', result: String(result).slice(0, 2000), processed_at: now });
          lastProcessedAt[entry.signature] = now; // visible to any later same-signature entry in this same run
          logger.info('self_heal_watcher: done', { id: entry.id });
          // Sent server-side with suppressSelfHeal hardcoded — NOT via the LLM
          // calling send_teams_message itself. auto_fix's tool set has no Teams
          // tool at all (see registry.js): trusting the agent to remember a flag
          // on every response is a weak boundary for an unattended, unsupervised
          // run — a summary that happens to contain "FAILED" and omits the flag
          // would silently re-enqueue itself.
          await notify(`🔧 Self-heal report for: "${entry.message.slice(0, 150)}"\n\n${String(result).slice(0, 1500)}`, { suppressSelfHeal: true }).catch(() => {});
        } catch (err) {
          const now = new Date().toISOString();
          await patchEntry(entry.id, { status: 'failed', result: err.message, processed_at: now });
          lastProcessedAt[entry.signature] = now;
          logger.warn('self_heal_watcher: remediation run failed', { id: entry.id, err: err.message });
          await notify(`🔧 Self-heal FAILED for: "${entry.message.slice(0, 150)}"\n\nRemediation run itself errored: ${err.message.slice(0, 300)}`, { suppressSelfHeal: true }).catch(() => {});
        }
        processedCount++;
      }

      if (skippedCooldown) logger.info('self_heal_watcher: skipped (cooldown, will retry next tick)', { count: skippedCooldown });
      const stillPending = Math.max(0, eligible.length - processedCount - skippedCooldown);
      if (stillPending > 0) logger.info('self_heal_watcher: deferred to next run', { count: stillPending });
    },
  },
  {
    // Hourly — retry any Menards rebates that failed transiently (IP rate limits clear within 1-2h).
    // First-attempt failures are queued as retry_pending; this cron fires the second attempt.
    // If the second attempt also fails, the manual fallback email is sent then.
    schedule: '0 * * * *',
    name: 'menards_rebate_retry',
    run: async () => {
      const { createClient } = await import('@supabase/supabase-js');
      const sb = createClient(
        process.env.FLEETOPS_SUPABASE_URL,
        process.env.FLEETOPS_SUPABASE_SERVICE_KEY
      );
      const { data: pending } = await sb
        .from('menards_rebates')
        .select('expense_report_id')
        .eq('status', 'retry_pending')
        .lte('retry_after', new Date().toISOString());
      if (!pending?.length) return;
      logger.info('menards_rebate_retry: retrying pending rebates', { count: pending.length });
      const { triggerMenardsRebate } = await import('../tools/impl/menards.js');
      for (const row of pending) {
        try {
          await triggerMenardsRebate(row.expense_report_id);
        } catch (err) {
          logger.error('menards_rebate_retry: unhandled error', { expenseReportId: row.expense_report_id, err: err.message });
        }
      }
    },
  },
  {
    schedule: '*/5 * * * *',
    name: 'email_poller',
    run: async () => {
      if (!acquireRunLock('email_poller', 4 * 60_000)) {
        logger.debug('email_poller: skipped (another instance running)');
        return;
      }
      try {
      const { listEmails, getEmail, sendEmail, markEmailRead, listEmailAttachments, getEmailAttachmentBytes, getThreadEmails } = await import('../tools/impl/m365.js');
      const { processEmailedReceipt, processChaseAlert } = await import('../tools/impl/expense.js');
      const emails = await listEmails({ folder: 'Inbox', limit: 10, unread_only: true });

      for (const email of emails) {
        // ── Chase transaction alert check (before receipt check and michael-only filter) ──
        try {
          const chaseHandled = await processChaseAlert(email, { getEmail, sendEmail });
          if (chaseHandled) {
            await markEmailRead({ email_id: email.id });
            continue;
          }
        } catch (err) {
          logger.warn('Chase alert check failed', { err: err.message, from: email.from });
        }

        // ── Receipt email check (runs before michael-only filter) ──
        try {
          const handled = await processEmailedReceipt(email, {
            listEmailAttachments,
            getEmailAttachmentBytes,
            sendEmail,
          });
          if (handled) {
            await markEmailRead({ email_id: email.id });
            continue;
          }
        } catch (err) {
          logger.warn('Receipt email check failed', { err: err.message, from: email.from });
        }

        // Only process non-receipt emails from Michael
        if (!email.from || email.from.toLowerCase() !== 'michael@jrboehlke.com') {
          await markEmailRead({ email_id: email.id });
          continue;
        }

        // Skip automated/system notifications
        const autoSubjects = ['shared the folder', 'shared a file', 'invited you', 'has shared'];
        if (autoSubjects.some(s => email.subject.toLowerCase().includes(s))) {
          await markEmailRead({ email_id: email.id });
          continue;
        }

        // Skip emails older than 24 hours (already handled or stale)
        const emailAge = Date.now() - new Date(email.date).getTime();
        if (emailAge > 24 * 60 * 60 * 1000) {
          await markEmailRead({ email_id: email.id });
          continue;
        }

        // Mark read before heavy processing — prevents duplicate handling if lock races
        await markEmailRead({ email_id: email.id });

        logger.info(`Email poller: processing email from ${email.from}`, { subject: email.subject });
        let full;
        try {
          full = await getEmail({ email_id: email.id });
        } catch (fetchErr) {
          logger.warn('Email poller: getEmail failed, skipping', { err: fetchErr.message, subject: email.subject });
          sendProactiveMessage(
            `⚠️ Email from Michael could not be read and was skipped.\nSubject: "${email.subject}"\nError: ${fetchErr.message}\nPlease resend or check the assistant inbox.`
          ).catch(() => {});
          continue;
        }
        const body = (full.body ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
        const fullText = email.subject + ' ' + body;

        // ── Feedback capture — runs on every Michael email before routing ────────
        try {
          const { detectAndCaptureFeedback } = await import('../tools/impl/feedback-capture.js');
          const fb = await detectAndCaptureFeedback(fullText, 'email');
          if (fb.captured) {
            logger.info(`Email poller: feedback rule captured`, { rule: fb.rule, agent: fb.agent });
          }
        } catch (err) {
          logger.warn('Email poller: feedback capture error (non-fatal)', { err: err.message });
        }

        // ── Commission report draft reply (checked before dev/CRM/general routing) ──
        // Lookup and handling are separate try/catches on purpose: a transient
        // failure just checking whether this thread has an open draft should
        // fall through to normal routing below, not drop an unrelated email
        // entirely — but once we know for certain this IS a commission-report
        // reply (openDraft found), a failure handling it should alert and stop,
        // since falling through to CRM/general routing on it would be wrong.
        let openDraft = null;
        try {
          const { findOpenDraftForThread } = await import('../tools/impl/commission-report-reply.js');
          openDraft = await findOpenDraftForThread(full.thread_id);
        } catch (err) {
          logger.warn('Email poller: commission draft lookup failed, falling through to normal routing', { err: err.message, subject: email.subject });
        }
        if (openDraft) {
          try {
            const { handleCommissionReportReply } = await import('../tools/impl/commission-report-reply.js');
            logger.info('Email poller: routing to commission report reply handler', { quarter: openDraft.quarter, threadId: full.thread_id });
            await handleCommissionReportReply({ ...full, body }, openDraft);
          } catch (err) {
            logger.error('Email poller: commission report reply handling failed', { err: err.message, subject: email.subject });
            sendProactiveMessage(`⚠️ Commission report reply from Michael failed to process.\nSubject: "${email.subject}"\nError: ${err.message}`).catch(() => {});
          }
          continue;
        }

        // ── Dev task detection ──────────────────────────────────────────────────
        const isExplicitDev = isExplicitDevTask(fullText);
        const isAmbiguousDev = !isExplicitDev && isAmbiguousDevTask(fullText);

        if (isExplicitDev) {
          // Michael clearly wants code built â€” reply with a scope proposal
          logger.info(`Email poller: detected explicit dev task`, { subject: email.subject });
          const task = `You received an email from Michael (michael@jrboehlke.com) asking you to build something.
Subject: "${email.subject}"
Email body:
${body}

Follow the github-dev skill workflow. Reply with a scope proposal:
- Restate the goal in 2-3 sentences
- List the files that will be created or changed
- Identify which repo this belongs in
- State any assumptions
- Ask Michael to confirm before you proceed

Do not write any code yet. Return only the reply text.

${EA_REPLY_STYLE}`;

          const agentResult = await runAgent({ task, taskType: 'code', saveContext: false });
          const result = asHtmlBody(agentResult?.result) || '<p>Got it — I\'ll scope this out and reply shortly.</p>';

          await sendEmail({
            to: [email.from],
            subject: `Re: ${email.subject}`,
            body: `<div style="font-family:Arial,sans-serif;max-width:640px;">${result}</div><hr style="margin:20px 0;"><p style="color:#888;font-size:12px;"><em>Sent by JRB Executive Assistant</em></p>`,
          });
          await markEmailRead({ email_id: email.id });
          logger.info(`Email poller: sent scope proposal to ${email.from}`);
          continue;
        }

        if (isAmbiguousDev) {
          // Unclear intent â€” send a clarification email before doing anything
          logger.info(`Email poller: detected ambiguous dev task, asking for clarification`, { subject: email.subject });
          const clarification = [
            `Hi Michael,`,
            ``,
            `I want to make sure I handle this correctly. Are you asking me to <strong>build or write code</strong> for this, or are you looking for information or advice?`,
            ``,
            `If you'd like me to build something, just reply with <strong>"yes, build it"</strong> and I'll put together a scope plan.`,
            ``,
            `<em>â€” JRB Executive Assistant</em>`,
          ].join('<br>');

          await sendEmail({
            to: [email.from],
            subject: `Re: ${email.subject}`,
            body: clarification,
          });
          await markEmailRead({ email_id: email.id });
          logger.info(`Email poller: sent clarification request to ${email.from}`);
          continue;
        }

        // ── CRM / SA action detection ─────────────────────────────────────────
        // Only check subject + first 600 chars of body to avoid quoted reply text
        // from previous assistant emails poisoning the keyword match.
        const isCrm = isCrmActionRequest(email.subject + ' ' + body.slice(0, 600));

        if (isCrm) {
          logger.info(`Email poller: detected CRM/SA action request`, { subject: email.subject });
          const isFromMichael = /michael@jrboehlke\.com|assistant@jrboehlke\.com/i.test(email.from);
          const crmTask = `You received an email from Michael with a new customer contact form or CRM request. Follow these steps exactly.

Company info (use exactly as written):
  Name: J.R. Boehlke
  Phone: 262-242-9924
  Sign off as: Michael

Subject: “${email.subject}”
Email body:
${body}

━━━ CONTACT FORM / NEW LEAD WORKFLOW ━━━

STEP 1 — PARSE CONTACT DETAILS:
Extract every field present in the email body:
- firstName, lastName (required)
- companyName (only if this is clearly a business customer — look for LLC, Inc, Co., business name, etc. Omit for residential.)
- address (full street address including number and street name — e.g. “1234 Oak St”)
- city, state (2-letter abbreviation e.g. “WI” — default to “WI” if not present in form), zip
- email, phone (10 digits only — strip country code prefix: “+1” or “1” + 10 digits → use the 10-digit portion)
If a field is not in the form, omit it from the tool call (except state: always include state, defaulting to “WI”).

STEP 2 — SEARCH FOR EXISTING CLIENT (deduplicate before creating):
Run multiple SA searches to check for an existing account. SA client names are stored as "First Last" or "Company Name".

a) Search by firstName: call sa_search_clients with firstName.
b) Search by lastName: call sa_search_clients with lastName.
c) If the name looks like a business (has LLC, Inc, Co, or companyName is set): also search by companyName.
d) Collect all unique results into a single candidates array.

e) Call sa_fuzzy_match_client with:
   - incoming: { firstName, lastName, address, email, phone } from STEP 1
   - candidates: merged array of all sa_search_clients results (include clientId, name, address, email, phone for each)

   The fuzzy matcher handles nicknames (Deborah↔Debbie, Robert↔Bob, etc.), address abbreviations
   (St↔Street, Dr↔Drive, etc.), normalized phone numbers, and spouse/same-address matching.

DUPLICATE DECISION RULES based on sa_fuzzy_match_client recommendation:
- USE_EXISTING → treat as EXISTING CLIENT. Use bestMatch.clientId. Skip STEP 3.
- USE_EXISTING_VERIFY → use bestMatch.clientId but note "Possible match on [matchedOn fields] — Michael should verify" in the STEP 7 summary.
- CREATE_NEW → proceed to STEP 3.

The goal is zero duplicate accounts. When in doubt, use the existing client.

STEP 3 — CREATE CLIENT (only if new):
Call sa_create_client with all parsed fields.
- Business: pass companyName (client name in SA will be the company name)
- Individual: pass firstName and lastName only — client name will be “First Last”
- Always pass address, city, state, zip as separate fields

STEP 4 — ADD TICKET:
Call sa_add_ticket with:
- clientId from the client search or creation
- subject: “Web Lead — [brief description of request]”
- notes: Format with clear paragraphs and double line breaks between sections:

  “Created by AI on [today's date, e.g. 'June 5, 2026']. Verify contact information before proceeding.

  [blank line]

  Name: [firstName lastName]
  Phone: [phone]
  Email: [email]
  Address: [address], [city], [state] [zip]

  [blank line]

  Service Requested: [SelectService value]

  [blank line]

  [If a Message field is present:]
  Customer Message:
  [message text]”

STEP 5 — VERIFY TICKET:
Call sa_get_ticket with the returned ticketId.
- Returns object → ticket confirmed
- Returns null → ticket not verified

STEP 6 — SET BILLING DEFAULTS (new clients only):
If a NEW client was created in STEP 3 (not an existing client found in STEP 2):
Call sa_set_billing_defaults with the clientId to set Taxable=Tax and InvoiceDelivery=Email.
- Success → note "Billing defaults set (Tax, Email)" in the reply
- Failure → note "Billing defaults could not be set — update manually in SA" in the reply
Skip this step entirely if STEP 2 found an existing client.

STEP 7 — COMPOSE INTERNAL SUMMARY:
Return a well-formatted HTML summary for Michael's reference. This is NOT sent to the customer — do NOT write a customer-facing letter or acknowledgment. Use this structure:

<h3>✅ TICKET CONFIRMED IN SA: [Client Name]</h3>
(or <h3>⚠️ WARNING — TICKET NOT VERIFIED: [Client Name]</h3>)

<table style=”border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:14px;”>
  <tr><td style=”padding:6px 12px;font-weight:bold;width:160px;”>Client Name</td><td style=”padding:6px 12px;”>[name]</td></tr>
  <tr style=”background:#f5f5f5;”><td style=”padding:6px 12px;font-weight:bold;”>SA Client ID</td><td style=”padding:6px 12px;”>[clientId]</td></tr>
  <tr><td style=”padding:6px 12px;font-weight:bold;”>Address</td><td style=”padding:6px 12px;”>[address, city, state zip]</td></tr>
  <tr style=”background:#f5f5f5;”><td style=”padding:6px 12px;font-weight:bold;”>Email</td><td style=”padding:6px 12px;”>[email]</td></tr>
  <tr><td style=”padding:6px 12px;font-weight:bold;”>Phone</td><td style=”padding:6px 12px;”>[phone]</td></tr>
  <tr style=”background:#f5f5f5;”><td style=”padding:6px 12px;font-weight:bold;”>Ticket ID</td><td style=”padding:6px 12px;”>[ticketId]</td></tr>
  <tr><td style=”padding:6px 12px;font-weight:bold;”>Ticket Subject</td><td style=”padding:6px 12px;”>[subject]</td></tr>
  <tr style=”background:#f5f5f5;”><td style=”padding:6px 12px;font-weight:bold;”>Billing Defaults</td><td style=”padding:6px 12px;”>[billing defaults status from STEP 6, or “N/A — existing client”]</td></tr>
  <tr><td style=”padding:6px 12px;font-weight:bold;”>Account Status</td><td style=”padding:6px 12px;”>[New account created / Existing account used (matched on: [fields]) / Existing account used — possible multi-property (verify)]</td></tr>
</table>

<h4>Lead Message</h4>
<p style=”background:#f9f9f9;padding:12px;border-left:3px solid #ccc;”>[brief summary of what they're asking for]</p>

<p><em>Note: [anything Michael should manually verify, e.g. incomplete address, ambiguous business/residential, possible duplicate account]</em></p>

━━━ OTHER SA ACTIONS ━━━
- If Michael asks to create a ticket, estimate, job, or other SA record: do it now using your tools, then reply with a brief HTML summary.
- If Michael asks to look up a client, invoice, or balance: do it and return the result in a readable format.

${EA_REPLY_STYLE}`;

          const crmReplyTo = isFromMichael ? 'michael@jrboehlke.com' : email.from;
          const crmSubject = isFromMichael ? `SA: ${email.subject}` : `Re: ${email.subject}`;

          // Import here so we can check the backoff timer immediately after runAgent returns.
          // The dispatcher catches tool-level errors and feeds them to the agent as messages,
          // so runAgent won't throw on SA blocks — we must poll the timer directly.
          const { getSABackoffUntil } = await import('../tools/impl/serviceautopilot.js');
          const crmResult = await runAgent({ task: crmTask, taskType: 'crm', saveContext: false });
          const backoffUntil = getSABackoffUntil();
          if (backoffUntil > Date.now()) {
            const runAfter = new Date(backoffUntil).toISOString();
            const remainingMin = Math.ceil((backoffUntil - Date.now()) / 60000);
            const SUPABASE_URL = process.env.SUPABASE_URL;
            const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
            await fetch(`${SUPABASE_URL}/rest/v1/agent_tasks`, {
              method: 'POST',
              headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
              body: JSON.stringify({ task: crmTask, task_type: 'crm', status: 'pending', run_after: runAfter, notify_email: crmReplyTo, reply_subject: crmSubject, retry_count: 0 }),
            });
            await sendEmail({
              to: [crmReplyTo],
              subject: crmSubject,
              body: `<p>SA is temporarily rate-limited by bot protection. I've queued this task and will retry automatically in ~${remainingMin} min — I'll email you the result when it completes.</p><hr><p style=”color:#888;font-size:12px;”><em>Sent by JRB Executive Assistant</em></p>`,
            });
            logger.info(`Email poller: Incapsula block detected post-run — queued CRM task, notified ${crmReplyTo}`);
            continue;
          }

          const crmReply = asHtmlBody(crmResult?.result) || '<p>Done — check SA for the new record.</p>';
          const isTicketFailure = /warning.*ticket not verified|ticket not verified|not verified|sa.*unreachable|sa.*fail|could not create|ticket.*fail/i.test(crmReply);
          if (isTicketFailure && crmReplyTo !== 'michael@jrboehlke.com') {
            try {
              await sendEmail({
                to: ['michael@jrboehlke.com'],
                subject: `⚠️ Ticket Creation Failed — ${email.subject}`,
                body: `<p style=”color:#c00;font-weight:bold;font-family:Arial,sans-serif;”>A lead came in but ticket creation in SA failed. Manual entry may be required.</p><div style=”font-family:Arial,sans-serif;max-width:640px;”>${crmReply}</div><hr style=”margin:20px 0;”><p style=”color:#888;font-size:12px;”><em>Sent by JRB Executive Assistant</em></p>`,
              });
              logger.info('Email poller: ticket failure notification sent to Michael', { subject: email.subject });
            } catch (notifyErr) {
              logger.warn('Email poller: failed to send ticket failure notification', { err: notifyErr.message });
            }
          }
          // Forwarded leads (from Michael) get an internal summary — don't reply to his own email
          await sendEmail({
            to: [crmReplyTo],
            subject: crmSubject,
            body: `<div style=”font-family:Arial,sans-serif;max-width:640px;”>${crmReply}</div><hr style=”margin:20px 0;”><p style=”color:#888;font-size:12px;”><em>Sent by JRB Executive Assistant</em></p>`,
          });
          logger.info(`Email poller: executed CRM action and sent summary to ${crmReplyTo}`);
          continue;
        }

        // ── General AI routing (fallback for all unclassified emails from Michael) ──
        // Pull recent thread history so a reply to an ongoing back-and-forth isn't
        // blind to what was already said (e.g. Michael replying "approve all" to a
        // digest the bot itself sent earlier that day). Best-effort -- a lookup
        // failure just falls back to no thread context rather than dropping the email.
        let threadContext = '';
        try {
          const priorMsgs = (await getThreadEmails({ thread_id: full.thread_id, limit: 6 }))
            .filter(m => m.id !== email.id)
            .sort((a, b) => new Date(a.date) - new Date(b.date))
            .slice(-4);
          const lines = (await Promise.all(priorMsgs.map(async m => {
            try {
              const msg = await getEmail({ email_id: m.id });
              const text = (msg.body ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
              return `[${m.date}] ${m.from}: ${text}`;
            } catch { return null; }
          }))).filter(Boolean);
          if (lines.length) {
            threadContext = `\n\nPrior messages in this thread (oldest to newest, for context only -- don't re-answer them, just don't contradict or forget them):\n${lines.join('\n\n')}`;
          }
        } catch (err) {
          logger.warn('Email poller: thread context lookup failed (non-fatal)', { err: err.message });
        }

        const task = `You received an email from Michael Reardon (michael@jrboehlke.com).

Subject: “${email.subject}”
Body:
${body}${threadContext}

Classify the email and respond appropriately:
- Question or info request → answer directly and concisely
- Task completable with your tools → do it now and report back what actually happened
- FYI / forwarded notification with no action needed → acknowledge in 1-2 sentences
- Financial/bank/vendor notification → note the key details (amount, merchant, account) and ask if any action is needed

Return ONLY the reply text. No preamble, no analysis section, no “Here is my reply:” header. Just the reply itself.

${EA_REPLY_STYLE}`;
        // taskType 'general' (not 'email') -- this is Michael's own request via his
        // own email channel, past the from-address check above, so it should have
        // the same tool access the Teams bot already grants him for the identical
        // "not dev, not CRM" fallback case (teams/bot.js's own general routing uses
        // 'general' too). The narrower 'email' taskType (EMAIL_TOOLS + TEAMS_TOOLS
        // only) was leaving genuinely completable requests -- e.g. anything needing
        // a QuickBooks/SA lookup -- unable to do anything but describe the gap.
        // 'general' isn't in SONNET_TASK_TYPES, so routeModel would otherwise fall
        // back to its keyword heuristic for model choice -- forcing Sonnet here
        // rather than relying on this prompt template happening to contain a
        // matching keyword (it does today, but that's exactly the kind of silent
        // wording-drift trap already documented elsewhere in this file for the
        // "Estimating" vs "estimate" routing miss).
        // saveContext: true (changed from false) -- this is Michael's own request via
        // his own email channel, exactly the same shape as a Teams 'general' message,
        // but was never writing its outcome back into agent_memory. A later Teams
        // conversation referencing "did you handle that email" had no way to know --
        // Teams/voice already share memory this way (see voice/call-memory.js's own
        // comment on cross-channel visibility), email was the one channel silently
        // left out.
        const agentResult = await runAgent({ task, taskType: 'general', model: FORCE_SONNET_MODEL, saveContext: true });
        const result = asHtmlBody(agentResult?.result) || '<p>I received your email and will follow up shortly.</p>';

        await sendEmail({
          to: [email.from],
          subject: `Re: ${email.subject}`,
          body: `<div style="font-family:Arial,sans-serif;max-width:640px;">${result}</div><hr style="margin:20px 0;"><p style="color:#888;font-size:12px;"><em>Sent by JRB Executive Assistant</em></p>`,
        });
        logger.info(`Email poller: replied to ${email.from}`);
      }

      // ── michael@jrboehlke.com's own inbox: vendor e-receipts ──
      // Separate from the assistant@ loop above (different mailbox, different
      // matching strategy) -- vendor receipts (Amazon, Menards, etc.) rarely
      // quote the "card ...1234: $X" SMS text processEmailedReceipt relies on
      // and often have no attachment at all. See processVendorEmailReceipt.
      try {
        const { processVendorEmailReceipt } = await import('../tools/impl/expense.js');
        const michaelEmail = 'michael@jrboehlke.com';
        const michaelEmails = await listEmails({ folder: 'Inbox', limit: 10, unread_only: true, userEmail: michaelEmail });
        for (const email of michaelEmails) {
          try {
            const handled = await processVendorEmailReceipt(
              email,
              { listEmailAttachments, getEmailAttachmentBytes, getEmail },
              michaelEmail
            );
            if (handled) await markEmailRead({ email_id: email.id, userEmail: michaelEmail });
          } catch (err) {
            logger.warn('Vendor email receipt check failed', { err: err.message, from: email.from });
          }
        }
      } catch (err) {
        logger.warn('michael@ inbox receipt poll failed', { err: err.message });
      }
      } finally {
        releaseRunLock('email_poller');
      }
    },
  },
  {
    // Monday 12:01 AM — AME full sync+match so data is fresh for Monday 6 AM finance report.
    // ame-run.ps1 injects credentials from Credential Manager; no env injection needed here.
    // Writes a lock file so any downstream finance report cron can wait for AME to finish.
    // Self-healing: each of the 5 steps runs individually. On failure the error is classified
    // and the step is retried once after a typed delay. QB_TOKEN_EXPIRED skips QB entirely and
    // sends reauth instructions. Any SA-step retry failure marks SA unreachable and skips
    // remaining SA steps. The match step always runs on whatever data synced cleanly.
    // Hard ceiling: aborts remaining steps after 5 h to protect the 6 AM finance report.
    schedule: '1 0 * * 1',
    name: 'ame_weekly_sync',
    // Same node-cron missed-tick bug as weekly_finance_report/qb_health_check below —
    // never fired on schedule since at least 2026-08-10, despite the scheduler being
    // continuously alive through the 2026-08-17 Monday 00:01 window. This is the direct
    // root cause of qb_invoices/qb_payments (this task's own QB sync steps) sitting
    // ~14 days stale, found 2026-08-19 while investigating a phantom-sync audit
    // finding — the fix from PR #256 was only ever applied to qbo_sync_watchdog and
    // qb_health_check, never extended here despite this being the single most
    // consequential task on this exact bug class. Self-healing/idempotent per its own
    // design (see comment above), safe to catch up.
    recoverMissedExecutions: true,
    run: async () => {
      const notify = (msg) => import('../teams/notify.js')
        .then(({ sendProactiveMessage }) => sendProactiveMessage(msg))
        .catch(() => {});

      const ameLockFile = join(tmpdir(), 'ame-weekly-sync.lock');
      const AME_PS1 = 'C:\\Users\\Assistant\\AuditMatchingEngine\\ame-run.ps1';
      const MAX_RUN_MS = 5 * 60 * 60 * 1000; // abort by 5 AM so the 6 AM finance report can run

      // Guard against a genuine overlapping run — previously this lock file was written
      // unconditionally, purely as a side-channel signal for weekly_finance_report to poll,
      // with nothing stopping ame_weekly_sync itself from clobbering a still-fresh lock
      // and running twice concurrently (both instances rotating the same QB refresh
      // token). A pre-existing latent gap, hardened here while touching this task anyway.
      // NOTE: this can't distinguish "still genuinely running" from "crashed without
      // reaching the finally block's unlinkSync, lock left behind, <5h old" — no PID
      // check, unlike the Chase daemon's liveness check elsewhere in this file. Alerting
      // via Teams (not just a log line) so a false skip doesn't silently repeat next week
      // too, which would be a real regression: this task gaining recoverMissedExecutions
      // is meant to make exactly that scenario self-heal, not fail a second, quieter way.
      if (existsSync(ameLockFile)) {
        const existingTs = Number(readFileSync(ameLockFile, 'utf8') || 0);
        if (existingTs && Date.now() - existingTs < MAX_RUN_MS) {
          const runningMin = Math.round((Date.now() - existingTs) / 60000);
          logger.warn('ame_weekly_sync: skipped — a run is already in progress (lock held)', { runningMin });
          await notify(`ame_weekly_sync skipped this run — lock file shows another instance started ${runningMin} min ago. If that's not actually still running (e.g. a prior crash left the lock behind), it'll block catch-up until the lock ages past 5h — check manually if AME data still looks stale.`);
          return;
        }
      }
      writeFileSync(ameLockFile, String(Date.now()), 'utf8');

      const runStart = Date.now();

      function runStep(script) {
        return new Promise(resolve => {
          const child = spawn('powershell.exe', [
            '-ExecutionPolicy', 'Bypass', '-File', AME_PS1, script,
          ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 90 * 60 * 1000 });
          let out = '', err = '';
          child.stdout.on('data', d => { out += d; });
          child.stderr.on('data', d => { err += d; });
          // code is null when Node kills the child via spawn timeout (Windows sends SIGTERM, no 'error' event)
          child.on('close', (code, signal) => resolve({ code: code ?? -1, out, err, timedOut: code === null }));
          // Append e.message to accumulated stderr so prior output isn't lost
          child.on('error', e => resolve({ code: -1, out, err: err + (err ? '\n' : '') + e.message }));
        });
      }

      function classifyError(out, err, step = {}) {
        const combined = (out + err).toLowerCase();
        if (combined.includes('token refresh failed') &&
            (combined.includes('invalid_grant') || combined.includes('401') || combined.includes('unauthorized'))) {
          return 'QB_TOKEN_EXPIRED';
        }
        if (combined.includes('token refresh failed') || (combined.includes('[qb-sync]') && combined.includes('error'))) {
          return 'QB_NETWORK';
        }
        // Only classify as SA login failure for SA steps — QB/match steps never log 'logged in',
        // so a TimeoutError in those steps would otherwise be misclassified here
        if (step.isSA && !combined.includes('logged in') && (combined.includes('timeouterror') || combined.includes('waitfornavigation'))) {
          return 'SA_LOGIN_FAILED';
        }
        if (combined.includes('target page') || combined.includes('page crashed') ||
            combined.includes('browser has been closed') || combined.includes('browser closed')) {
          return 'PLAYWRIGHT_CRASH';
        }
        if (/econnrefused|etimedout|enotfound|econnreset/.test(combined)) return 'NETWORK_ERROR';
        if (combined.includes('[supabase error]')) return 'SUPABASE_ERROR';
        return 'UNKNOWN';
      }

      const RETRY_DELAY_MIN = { QB_NETWORK: 5, SA_LOGIN_FAILED: 2, PLAYWRIGHT_CRASH: 2, NETWORK_ERROR: 5, SUPABASE_ERROR: 2, TIMEOUT: 3, UNKNOWN: 3 };

      const steps = [
        { script: 'sync:invoices',     label: 'SA Invoices',     isSA: true },
        { script: 'sync:payments',     label: 'SA Payments',     isSA: true },
        { script: 'sync:applications', label: 'SA Applications', isSA: true },
        { script: 'sync:qb',           label: 'QB Sync',         isQB: true },
        { script: 'match',             label: 'Invoice Matching Engine'       },
        { script: 'match:payments',    label: 'Payment Matching Engine'       },
      ];

      const passed = [], failed = [], skipped = [];
      let saUnreachable = false;
      let qbTokenExpired = false;

      try {
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];

          // Hard ceiling: abort remaining steps if we've been running > 5 h
          if (Date.now() - runStart > MAX_RUN_MS) {
            const remaining = steps.slice(i).map(s => s.label);
            skipped.push(...remaining);
            await notify(
              `AME weekly sync aborted after 5h -- remaining steps skipped to protect 6 AM finance report.\n` +
              `Skipped: ${remaining.join(', ')}`
            );
            break;
          }

          if (step.isSA && saUnreachable)  { skipped.push(step.label); continue; }
          if (step.isQB && qbTokenExpired) { skipped.push(step.label); continue; }

          logger.info(`ame_weekly_sync: starting ${step.script}`);
          let { code, out, err, timedOut } = await runStep(step.script);

          if (code === 0) {
            logger.info(`ame_weekly_sync: ${step.script} OK`);
            passed.push(step.label);
            continue;
          }

          const errType = timedOut ? 'TIMEOUT' : classifyError(out, err, step);
          logger.warn(`ame_weekly_sync: ${step.script} failed (${errType})`, { code, tail: (out + err).slice(-600) });

          if (errType === 'QB_TOKEN_EXPIRED') {
            qbTokenExpired = true;
            failed.push(`${step.label} -- QB token expired`);
            await notify(
              `**AME QB Sync Failed -- Token Expired**\n\n` +
              `The QuickBooks refresh token has expired and needs manual reauthorization.\n\n` +
              `**To fix:**\n` +
              `1. Go to https://developer.intuit.com/app/developer/playground\n` +
              `2. Get a new authorization code (scope: com.intuit.quickbooks.accounting)\n` +
              `3. Run: \`ame-run.ps1 get:qb-tokens <code> 9130357265584656\`\n` +
              `4. Store the new refresh token: \`Set-JRBSecret QB_REFRESH_TOKEN <token>\`\n\n` +
              `QB sync skipped for tonight -- finance report sections using QB data will be stale.`
            );
            continue;
          }

          const delayMin = RETRY_DELAY_MIN[errType] || 3;
          await notify(`AME **${step.label}** failed (${errType}) -- retrying in ${delayMin} min...`);
          await new Promise(r => setTimeout(r, delayMin * 60 * 1000));

          logger.info(`ame_weekly_sync: retrying ${step.script}`);
          ({ code, out, err, timedOut } = await runStep(step.script));

          if (code === 0) {
            logger.info(`ame_weekly_sync: ${step.script} recovered on retry`);
            passed.push(`${step.label} (retried)`);
          } else {
            const errType2 = timedOut ? 'TIMEOUT' : classifyError(out, err, step);
            logger.error(`ame_weekly_sync: ${step.script} failed after retry`, { errType2, tail: (out + err).slice(-800) });
            failed.push(`${step.label} (${errType2})`);
            if (step.isSA) saUnreachable = true; // any SA-step retry failure = skip remaining SA steps
            await notify(
              `AME **${step.label}** failed after retry (${errType2}).\n\n` +
              `\`\`\`\n${(out + err).slice(-500)}\n\`\`\``
            );
          }
        }
      } finally {
        // Summary notify fires in finally so it runs even on unexpected loop errors.
        // Lock released after notify so the finance report doesn't start reading Supabase
        // before this message is sent (~200 ms round-trip to Teams).
        const ok = failed.length === 0;
        const summary = [
          ok ? 'AME weekly sync complete.' : 'AME weekly sync finished with errors.',
          passed.length  ? `Passed (${passed.length}): ${passed.join(', ')}`    : null,
          failed.length  ? `Failed (${failed.length}): ${failed.join(', ')}`    : null,
          skipped.length ? `Skipped (${skipped.length}): ${skipped.join(', ')}` : null,
        ].filter(Boolean).join('\n');
        logger.info('ame_weekly_sync: summary', { ok, passed, failed, skipped });
        await notify(summary);
        try { unlinkSync(ameLockFile); } catch {}
      }

      if (failed.length > 0) throw new Error(`AME steps failed: ${failed.join(', ')}`);
    },
  },
  {
    // 6 AM on the 3rd of every month -- 3 days after month-end, per Michael
    // 2026-08-08 (was the 1st; gives SA/QBO a few extra days to sync before
    // the run, which several real misattributions this quarter traced back
    // to). Payment terms are still quarterly per the Accountability
    // Agreement — this cadence is for visibility only, so Michael can see
    // how things are tracking and the accountant can accrue more granularly
    // than once a quarter.
    // Jan/Apr/Jul/Oct 3 — "first payroll following quarter end" — finalize
    // the quarter that JUST ended (isFinal: true, same as before).
    // Every other month — snapshot the quarter still IN PROGRESS (isFinal:
    // false), so payable reflects quarter-to-date cash collected, not a final
    // payout number.
    // Every run (monthly and quarterly) goes out as a DRAFT first — see
    // commission-report-reply.js for the reply-driven approval loop.
    schedule: '0 6 3 * *',
    name: 'pm_commission_report',
    // Same node-cron missed-tick bug as weekly_finance_report/qb_health_check below —
    // monthly cadence makes a stall-coincidence less likely than the weekly tasks, but
    // still unprotected. Sends a draft, not a final, so safe to catch up.
    recoverMissedExecutions: true,
    run: async () => {
      try {
        const { previousQuarter, currentQuarter } = await import('../tools/impl/commission-engine.js');
        const { sendDraftForApproval } = await import('../tools/impl/commission-report.js');
        const isQuarterEndMonth = [0, 3, 6, 9].includes(new Date().getUTCMonth()); // Jan/Apr/Jul/Oct
        const quarter = isQuarterEndMonth ? previousQuarter() : currentQuarter();
        const result = await sendDraftForApproval({ quarter, isFinal: isQuarterEndMonth });
        logger.info('pm_commission_report: draft sent', result);
      } catch (err) {
        logger.error('pm_commission_report: FAILED', { err: err.message });
        try {
          await sendProactiveMessage(`PM Commission Report FAILED to send. Error: ${err.message}`);
        } catch (notifyErr) {
          logger.error('pm_commission_report: Teams alert also failed', { err: notifyErr.message });
        }
      }
    },
  },
  {
    // 3 AM daily - encrypted backup of every JRBAgent:* Credential Manager entry
    // to local disk + OneDrive. Built after the 2026-08-12 KB5121003 incident
    // wiped all 35 entries with no backup and no warning; see
    // tools/impl/credential-backup.js for the full design rationale.
    schedule: '0 3 * * *',
    name: 'credential_backup',
    run: async () => {
      try {
        const { runCredentialBackup } = await import('../tools/impl/credential-backup.js');
        const result = await runCredentialBackup();
        logger.info('credential_backup: complete', result);
      } catch (err) {
        logger.error('credential_backup: FAILED', { err: err.message });
        try {
          await sendProactiveMessage(`Credential backup FAILED: ${err.message}`);
        } catch (notifyErr) {
          logger.error('credential_backup: Teams alert also failed', { err: notifyErr.message });
        }
      }
    },
  },
  {
    // Every 20 minutes - detect missing JRBAgent:* Credential Manager entries.
    // The 2026-08-12 wipe went unnoticed for hours because nothing checked
    // presence at all; this catches it fast and points straight at the restore
    // script. Alerts once on detection and once on recovery, not every cycle.
    schedule: '*/20 * * * *',
    name: 'credential_healthcheck',
    run: async () => {
      try {
        const { runCredentialHealthcheck } = await import('../tools/impl/credential-backup.js');
        await runCredentialHealthcheck();
      } catch (err) {
        logger.warn('credential_healthcheck: check itself failed', { err: err.message });
      }
    },
  },
  {
    // Daily 4:30 AM - going-forward companion to the one-time historical client
    // classification backfill (2026-08-19/20, ~10,242 accounts tagged with
    // account type + service line). Finds accounts with no account-type tag yet
    // (i.e. created since the backfill ran), classifies and tags just those.
    // Scheduled off the 6-8 AM cluster (weekly finance report, BTA reporting,
    // QB health check) to avoid contending with them for the SA browser session.
    schedule: '30 4 * * *',
    name: 'sa_client_classification_incremental',
    run: async () => {
      try {
        // sa_estimate_line_sync (2 AM) now re-checks every open estimate on every run, not
        // just new ones (added 2026-08-29), which can push its worst-case runtime out to
        // 4:30 AM -- exactly this task's start time. No prior coordination existed between
        // this task and any of the 1-2 AM SA jobs since it was scheduled off that cluster
        // specifically to avoid contention; that assumption no longer holds against
        // sa_estimate_line_sync's new, much wider timeout. Same wait-then-poll-with-cap
        // pattern as sa_waiting_list_sync waiting on sa_nightly_sync's lock, above.
        const estimateLineSyncLock = join(tmpdir(), 'jrb-scheduler-sa_estimate_line_sync.lock');
        await waitForLockToAppear(estimateLineSyncLock);
        const waitStart = Date.now();
        while (existsSync(estimateLineSyncLock) && Date.now() - waitStart < 150 * 60_000) {
          await new Promise(r => setTimeout(r, 5000));
        }
        const { runIncrementalClassification } = await import('../tools/impl/sa-client-classification.js');
        const result = await runIncrementalClassification();
        if (result.classified > 0) {
          logger.info('sa_client_classification_incremental: complete', result);
        }
      } catch (err) {
        logger.warn('sa_client_classification_incremental: run failed', { err: err.message });
      }
    },
  },
  {
    // Daily 5:00 AM - going-forward companion to the one-time historical SA
    // phone cache backfill (2026-08-29, tools/impl/sa-phone-cache.js). Catches
    // clients created since the backfill (never cached) and refreshes anything
    // past PHONE_CACHE_TTL_DAYS, capped at 300/run as a safety ceiling -- same
    // shape as sa_client_classification_incremental just above, scheduled 30
    // min after it (both touch the shared SA browser session; staggering
    // avoids the two contending for it back-to-back).
    schedule: '0 5 * * *',
    name: 'sa_phone_cache_incremental',
    run: async () => {
      try {
        const { runPhoneCacheIncremental } = await import('../tools/impl/sa-phone-cache.js');
        const result = await runPhoneCacheIncremental();
        if (result.upserted > 0 || result.failed.length > 0) {
          logger.info('sa_phone_cache_incremental: complete', result);
        }
        if (result.incapsulaBackoffHit) {
          logger.warn('sa_phone_cache_incremental: stopped early on Incapsula backoff, will resume next run', result);
        }
      } catch (err) {
        logger.warn('sa_phone_cache_incremental: run failed', { err: err.message });
      }
    },
  },
  {
    // Every 30 min -- see the "Missed-fire watchdog" comment block above
    // acquireRunLock/estimateMonitoring for the full design rationale.
    schedule: '*/30 * * * *',
    name: 'cron_missed_fire_watchdog',
    run: async () => {
      const now = new Date();
      const state = loadTaskState();
      for (const task of SCHEDULED_TASKS) {
        if (task.name === 'cron_missed_fire_watchdog') continue;
        const spec = estimateMonitoring(task.schedule);
        if (!spec) continue;
        const taskState = state[task.name];
        if (!taskState || !taskState.lastRunMs) continue; // never recorded yet -- bootstrapping

        let overdue = false;
        let expectedLabel = '';
        if (spec.kind === 'interval') {
          overdue = (now.getTime() - taskState.lastRunMs) > (spec.intervalMs + spec.graceMs);
          expectedLabel = `every ${Math.round(spec.intervalMs / 60000)} min`;
        } else {
          const expected = mostRecentExpectedFire(now, spec);
          if (expected !== null && (now.getTime() - expected) > spec.graceMs && taskState.lastRunMs < expected) {
            overdue = true;
            expectedLabel = new Date(expected).toLocaleString('en-US', { timeZone: 'America/Chicago' });
          }
        }
        if (!overdue) continue;

        // Only alert once per distinct missed occurrence -- cleared the moment
        // lastRunMs advances past this alert (i.e. the next successful run).
        if (taskState.lastAlertMs && taskState.lastAlertMs > taskState.lastRunMs) continue;

        const hoursLate = ((now.getTime() - taskState.lastRunMs) / 3_600_000).toFixed(1);
        logger.warn('cron_missed_fire_watchdog: task overdue', { task: task.name, expectedLabel, hoursLate });
        recordTaskAlert(task.name);
        try {
          await sendProactiveMessage(
            `⚠️ Scheduled task "${task.name}" appears to have missed its run (expected ~${expectedLabel}, last ran ${hoursLate}h ago). Attempting an automatic catch-up run now.`
          );
        } catch (notifyErr) {
          logger.error('cron_missed_fire_watchdog: Teams alert failed', { err: notifyErr.message });
        }

        const result = await runScheduledTask(task, 'watchdog-selfheal');
        if (result.skipped) {
          logger.info('cron_missed_fire_watchdog: self-heal skipped, task already running', { task: task.name });
        } else if (result.success) {
          try { await sendProactiveMessage(`✅ "${task.name}" catch-up run completed successfully.`); } catch {}
        } else {
          try { await sendProactiveMessage(`❌ "${task.name}" catch-up run also failed: ${result.error}`); } catch {}
        }
      }
    },
  },
  {
    // BACKSTOP, not the primary trigger (as of 2026-09-02): each call now
    // triggers its own review immediately when it ends (see
    // voice/acs-call-handler.js's ws.on('close') handler), per Michael's
    // explicit request to not wait a week. This weekly Sunday 9 PM sweep
    // still exists to catch anything the inline trigger missed -- e.g. a
    // process crash between finalizeCallMemory's insert and the review call
    // -- same defense-in-depth posture as cron_missed_fire_watchdog backing
    // up recoverMissedExecutions elsewhere in this file. Quiet time slot,
    // deliberately outside the crowded 6-8 AM daily cluster and away from
    // any other weekly task's exact minute.
    // See tools/impl/voice-call-review.js for the full design and why
    // code-level findings are flagged to Michael rather than auto-applied.
    schedule: '0 21 * * 0',
    name: 'voice_call_quality_review',
    recoverMissedExecutions: true,
    run: async () => {
      const { runVoiceCallQualityReview } = await import('../tools/impl/voice-call-review.js');
      const result = await runVoiceCallQualityReview();
      logger.info('Voice call quality review complete', result);
    },
  },
];

// â”€â”€ Dev task detection helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Shared with bot.js â€” explicit build intent + deliverable noun, or known phrases

function isExplicitDevTask(text) {
  const t = text.toLowerCase();
  const intentVerbs = /\b(build|create|write|develop|code|make|set up|implement|automate|generate)\b/;
  const deliverableNouns = /\b(script|program|tool|app|application|function|integration|workflow|automation|report|dashboard|bot|scheduler|pipeline)\b/;
  const explicitPhrases = /\b(using your coding skills|write (me |us )?code|build (me |us )?a|deploy (this|it|to)|push to (github|vercel|prod)|open a pr|create a branch)\b/;
  return explicitPhrases.test(t) || (intentVerbs.test(t) && deliverableNouns.test(t));
}

function isAmbiguousDevTask(text) {
  const t = text.toLowerCase();
  const techTerms = /\b(script|code|github|deploy|vercel|supabase|automate|function|api|database|repo|branch|commit)\b/;
  return techTerms.test(t) && !isExplicitDevTask(text);
}

function isCrmActionRequest(text) {
  const t = text.toLowerCase();
  // Explicit exclusion: bank/transaction alerts are never CRM leads
  if (/you made a .{0,30}\$[\d,]+\.\d{2}/.test(t) || /chase.*transaction|transaction alert/i.test(t)) return false;
  return /\b(ticket|estimate|quote|job|waiting list|service autopilot|\bsa\b|client|lead|crm|follow.?up|call them|reach out|contact form|new customer|new lead)\b/.test(t);
}

// â”€â”€ Register all schedules â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

logger.info('Scheduler starting', { tasks: SCHEDULED_TASKS.map(t => t.name) });
for (const task of SCHEDULED_TASKS) {
  cron.schedule(task.schedule, () => runScheduledTask(task, 'scheduled'),
    task.recoverMissedExecutions ? { recoverMissedExecutions: true } : undefined);
}
logger.info('All schedules registered. Scheduler running.');

// Chase daemon watchdog — ensures chase-daemon.js is always running.
// Fires on scheduler startup and every 5 minutes.
// Does NOT start the daemon if session/expired.flag exists (session needs -Init).
const CHASE_EXPIRED_FLAG = 'C:\\Users\\Assistant\\ChasePoller\\session\\expired.flag';
const CHASE_STATE_PATH   = 'C:\\Users\\Assistant\\ChasePoller\\session\\state.json';
const CHASE_PID_FILE     = 'C:\\Users\\Assistant\\ChasePoller\\session\\daemon.pid';

function startChaseDaemonIfNeeded(reason) {
  if (existsSync(CHASE_EXPIRED_FLAG)) {
    logger.info('Chase daemon: session expired, not starting');
    return;
  }
  if (!existsSync(CHASE_STATE_PATH)) {
    logger.info('Chase daemon: no session file, not starting');
    return;
  }
  if (existsSync(CHASE_PID_FILE)) {
    const pid = parseInt(readFileSync(CHASE_PID_FILE, 'utf8').trim(), 10);
    try { process.kill(pid, 0); logger.info(`Chase daemon already running (PID ${pid})`); return; } catch {}
    // PID file exists but process is dead — clean it up
    try { unlinkSync(CHASE_PID_FILE); } catch {}
  }
  const child = spawn('powershell.exe', [
    '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', 'C:\\Users\\Assistant\\ChasePoller\\run.ps1', '-Daemon',
  ], { stdio: 'ignore', detached: true });
  child.unref();
  logger.info(`Chase daemon started (${reason})`);
}

startChaseDaemonIfNeeded('scheduler startup');

// Watchdog: restart daemon if it dies (every 5 minutes)
cron.schedule('*/5 * * * *', () => startChaseDaemonIfNeeded('watchdog'));

// MCP keepalive — ping /health every 4 minutes to verify the bot server is alive
// (previously pinged /mcp which caused 401s and created orphaned MCP sessions)
let mcpKeepaliveFailures = 0;

async function pingMcpKeepalive() {
  try {
    const res = await fetch('http://localhost:3978/health');
    if (res.ok) {
      mcpKeepaliveFailures = 0;
      logger.info('MCP keepalive ok', { status: res.status });
    } else {
      mcpKeepaliveFailures++;
      logger.warn('MCP keepalive non-200', { status: res.status, failures: mcpKeepaliveFailures });
    }
  } catch (err) {
    mcpKeepaliveFailures++;
    logger.warn('MCP keepalive failed', { err: err.message, failures: mcpKeepaliveFailures });
  }
}

// Ping every 4 minutes (240000ms)
setInterval(pingMcpKeepalive, 240000);
// Also ping once at startup after 30 seconds
setTimeout(pingMcpKeepalive, 30000);
logger.info('MCP keepalive scheduled (every 4 min)');

import './task-poller.js';
