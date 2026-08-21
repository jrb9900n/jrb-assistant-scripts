// scheduler/cron.js - Automated task scheduler
import 'dotenv/config';
import cron from 'node-cron';
import { spawn, execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runAgent } from '../core/agent.js';
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

function acquireRunLock(taskName, ttlMs = 60_000) {
  const lockFile = join(tmpdir(), `jrb-scheduler-${taskName}.lock`);
  try {
    if (existsSync(lockFile)) {
      const ts = Number(readFileSync(lockFile, 'utf8'));
      if (Date.now() - ts < ttlMs) return false;
    }
    writeFileSync(lockFile, String(Date.now()), 'utf8');
    return true;
  } catch { return true; }
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

let saWasDown = false;
let qbWasDown = false;
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
      try {
        const { getQBAccessToken } = await import('../tools/impl/qb-token.js');
        const axios = (await import('axios')).default;
        const token = await getQBAccessToken();
        await axios.get(
          `https://quickbooks.api.intuit.com/v3/company/${process.env.QB_REALM_ID}/companyinfo/${process.env.QB_REALM_ID}`,
          { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
        );
        if (qbWasDown) {
          qbWasDown = false;
          await sendProactiveMessage('✅ QuickBooks connectivity restored.').catch(() => {});
        }
      } catch (err) {
        logger.warn('qb_health_check: QB unreachable', { err: err.message, status: err.response?.status });
        if (!qbWasDown) {
          qbWasDown = true;
          const { sendEmail } = await import('../tools/impl/m365.js');
          const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
          const msg = `QuickBooks connection is failing (status ${err.response?.status ?? 'n/a'}). All QB-dependent features (BTA reports, CardDAV, finance report, audit engine) will be affected until reauthorized.\n\nDetail: ${detail}\n\nTo fix: developer.intuit.com/app/developer/playground -> get authorization code (scope com.intuit.quickbooks.accounting) -> authorize as J.R. Boehlke -> get tokens -> save refresh_token via Set-JRBSecret. Confirm the realm ID matches ${process.env.QB_REALM_ID} before saving.`;
          await Promise.allSettled([
            sendProactiveMessage(`⚠️ ${msg}`),
            sendEmail({
              to: ['michael@jrboehlke.com'],
              subject: '⚠️ QuickBooks Connection Failing',
              body: `<p style="font-family:Arial,sans-serif;color:#c00;font-weight:bold;">QuickBooks connection is failing (status ${err.response?.status ?? 'n/a'}).</p><p style="font-family:Arial,sans-serif;">${msg.split('\n\n').join('</p><p style="font-family:Arial,sans-serif;">')}</p>`,
            }),
          ]);
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
    // 8 AM daily — warn if QB refresh token is within 14 days of its 101-day expiry
    schedule: '0 8 * * *',
    name: 'qb_reauth_reminder',
    run: async () => {
      const { getQBTokenMeta, QB_TOKEN_TTL_DAYS } = await import('../tools/impl/qb-token.js');
      const meta = getQBTokenMeta();
      if (!meta?.lastRotatedAt) return; // no timestamp yet — nothing to warn about
      const msPerDay = 86_400_000;
      const daysSince = (Date.now() - new Date(meta.lastRotatedAt).getTime()) / msPerDay;
      const daysRemaining = Math.floor(QB_TOKEN_TTL_DAYS - daysSince);
      if (daysRemaining > 14) return;
      const secret = process.env.CLAUDE_EXECUTE_SECRET || '';
      const url = `https://agent.jrboehlke.com/qb-reauth?secret=${secret}`;
      const msg = daysRemaining > 0
        ? `QuickBooks token expires in **${daysRemaining} day${daysRemaining === 1 ? '' : 's'}**. Tap to reconnect: ${url}`
        : `QuickBooks token has **expired** (${Math.abs(daysRemaining)} days ago). Tap to reconnect: ${url}`;
      await sendProactiveMessage(msg);
      logger.info('qb_reauth_reminder: sent', { daysRemaining });
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
  // DISABLED — inbox processor, followup scanner, morning briefing
  // Re-enable when inbox processing behavior is ready.
  // {
  //   schedule: '*/15 * * * *',
  //   name: 'michael_inbox_processor',
  //   ...
  // },
  // {
  //   schedule: '0 7 * * *',
  //   name: 'followup_scanner',
  //   ...
  // },
  // {
  //   schedule: '30 7 * * *',
  //   name: 'morning_briefing',
  //   ...
  // },
  {
    // 1:30 AM nightly — refresh sa_waiting_list from SA and prune completed/invoiced jobs
    schedule: '30 1 * * *',
    name: 'sa_waiting_list_sync',
    run: async () => {
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
    run: () => new Promise((resolve, reject) => {
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
    }),
  },
  {
    // Every 30 minutes — check SA connectivity, alert Michael on first failure and on recovery
    schedule: '*/30 * * * *',
    name: 'sa_connectivity_check',
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
    // Every 10 minutes — Phase 1 of the "autonomous schedule manager" roadmap
    // agreed with Michael 2026-08-20. Detects new/changed events on his
    // calendar that aren't JRB block-schedule blocks (a real meeting
    // appearing, or an invite being accepted) via calendar-watch.js's Graph
    // delta query. Detection + notification only -- no auto-displacement
    // yet (that's Phase 3, which needs this plumbing first).
    // No overlap lock between runs -- a run overlapping the next tick could
    // race on calendar_delta_state's upsert. Accepted for Phase 1: this
    // task's own Graph call is lightweight (single page for a normal
    // mailbox, confirmed live) and finishes in well under 10 minutes in
    // every observed run.
    schedule: '*/10 * * * *',
    name: 'calendar_change_watch',
    run: async () => {
      try {
        const { getCalendarChanges } = await import('../tools/impl/calendar-watch.js');
        const changes = await getCalendarChanges({ mailbox: 'michael@jrboehlke.com' });
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
          try {
            await sendProactiveMessage(
              `📅 New calendar item detected${acceptedNote}: **${e.subject}** at ${when}. Automatic block displacement isn't built yet — review for schedule conflicts.`
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
      const { listEmails, getEmail, sendEmail, markEmailRead, listEmailAttachments, getEmailAttachmentBytes } = await import('../tools/impl/m365.js');
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

Do not write any code yet. Return only the reply text.`;

          const agentResult = await runAgent({ task, taskType: 'code', saveContext: false });
          const result = agentResult?.result ?? 'Got it â€” I\'ll scope this out and reply shortly.';

          await sendEmail({
            to: [email.from],
            subject: `Re: ${email.subject}`,
            body: `<p>${result.replace(/\n/g, '<br>')}</p><hr><p><em>Sent by JRB Executive Assistant</em></p>`,
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
- If Michael asks to look up a client, invoice, or balance: do it and return the result in a readable format.`;

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

          const crmReply = crmResult?.result ?? 'Done — check SA for the new record.';
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
        const task = `You received an email from Michael Reardon (michael@jrboehlke.com).

Subject: “${email.subject}”
Body:
${body}

Classify the email and respond appropriately:
- Question or info request → answer directly and concisely
- Task completable without code or CRM tools → complete it and report back
- FYI / forwarded notification with no action needed → acknowledge in 1-2 sentences
- Financial/bank/vendor notification → note the key details (amount, merchant, account) and ask if any action is needed

Return ONLY the reply text. No preamble, no analysis section, no “Here is my reply:” header. Just the reply itself.`;
        const agentResult = await runAgent({ task, taskType: 'email', saveContext: false });
        const result = agentResult?.result ?? 'I received your email and will follow up shortly.';

        await sendEmail({
          to: [email.from],
          subject: `Re: ${email.subject}`,
          body: `<p>${result.replace(/\n/g, '<br>')}</p><hr><p><em>Sent by JRB Executive Assistant</em></p>`,
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
  cron.schedule(task.schedule, async () => {
    logger.info(`Scheduled task starting: ${task.name}`);
    try {
      await task.run();
      logger.info(`Scheduled task complete: ${task.name}`);
      try { writeFileSync(SCHEDULER_HEARTBEAT_FILE, String(Date.now()), 'utf8'); } catch {}
    } catch (err) {
      logger.error(`Scheduled task failed: ${task.name}`, { err: err.message });
    }
  }, task.recoverMissedExecutions ? { recoverMissedExecutions: true } : undefined);
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
