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
  logger.info(`Scheduler: received ${signal}, closing SA session before exit`);
  try {
    const { closeSaSession } = await import('../tools/impl/serviceautopilot.js');
    await closeSaSession();
  } catch (err) {
    logger.warn('Scheduler: closeSaSession failed during shutdown', { err: err.message });
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

let saWasDown = false;
let qbWasDown = false;

// branch_drift_check's debounce flag, persisted so a scheduler restart while
// drift is still ongoing doesn't re-fire the "detected" alert unnecessarily
// (an in-memory-only flag would reset to false on every restart).
const BRANCH_DRIFT_STATE_FILE = join(tmpdir(), 'jrb-branch-drift-state.json');
let branchWasDrifted = false;
try { branchWasDrifted = JSON.parse(readFileSync(BRANCH_DRIFT_STATE_FILE, 'utf8')).drifted === true; } catch {}
function saveBranchDriftState(drifted) {
  try { writeFileSync(BRANCH_DRIFT_STATE_FILE, JSON.stringify({ drifted }), 'utf8'); } catch {}
}

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
    run: async () => {
      const ameLockFile = join(tmpdir(), 'ame-weekly-sync.lock');
      let delayed = false;
      let delayMinutes = 0;

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
    // Sunday 11 PM — synthesize week's observations into reusable patterns
    schedule: '0 23 * * 0',
    name: 'weekly_synthesis',
    run: async () => {
      const { runWeeklySynthesis } = await import('../tools/impl/feedback.js');
      await runWeeklySynthesis();
    },
  },
  {
    schedule: '0 9 * * 3,5',
    name: 'invoice_aging_check',
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
    run: () => {
      acquireRunLock('qb_weekly_sync', 6 * 60_000);
      return new Promise((resolve, reject) => {
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
    run: async () => {
      try {
        // qb_weekly_sync (4:00 AM) independently refreshes/rotates the same
        // Credential-Manager QB refresh token — wait for its lock to clear
        // (up to 6 min, matching the lock TTL) before also touching QB.
        const qbSyncLock = join(tmpdir(), 'jrb-scheduler-qb_weekly_sync.lock');
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
    // Every 6 hours — checked-out branch drift check. A stale/wrong branch
    // silently missing merged features (found 2026-07-30: this machine was
    // running an old unmerged branch, missing qb_reauth_reminder and
    // crackfill_reconciliation with zero indication anything was wrong) is
    // exactly the kind of failure that goes unnoticed for a long time.
    // Alerts once when drift is detected and once when it clears, not on
    // every check.
    schedule: '0 */6 * * *',
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
          if (!branchWasDrifted) {
            branchWasDrifted = true;
            saveBranchDriftState(true);
            const detail = branch !== 'main'
              ? `checked out on "${branch}"${behind > 0 ? `, ${behind} commit${behind === 1 ? '' : 's'} behind origin/main` : ''}`
              : `${behind} commit${behind === 1 ? '' : 's'} behind origin/main`;
            await sendProactiveMessage(`⚠️ JRBAgent deployment is ${detail}. Deployed code may be missing merged features — this exact issue caused qb_reauth_reminder to silently stop running for weeks. Check out main and restart the scheduler/bot when convenient.`).catch(() => {});
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
          const proxyNote = proxyHealth?.checked ? `\nProxy check: ${proxyHealth.detail}` : '';
          if (proxyHealth?.checked) logger.warn('sa_connectivity_check: proxy health', proxyHealth);
          try { await sendProactiveMessage(`⚠️ SA connectivity lost — ticket creation and CRM tools are offline.\n\nError: ${err.message.slice(0, 200)}${proxyNote}`); } catch {}
        }
      }
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
    run: async () => {
      const notify = (msg) => import('../teams/notify.js')
        .then(({ sendProactiveMessage }) => sendProactiveMessage(msg))
        .catch(() => {});

      const ameLockFile = join(tmpdir(), 'ame-weekly-sync.lock');
      writeFileSync(ameLockFile, String(Date.now()), 'utf8');

      const AME_PS1 = 'C:\\Users\\Assistant\\AuditMatchingEngine\\ame-run.ps1';
      const MAX_RUN_MS = 5 * 60 * 60 * 1000; // abort by 5 AM so the 6 AM finance report can run
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
        { script: 'match',             label: 'Matching Engine'              },
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
    // 6 AM on the 1st of every month. Payment terms are still quarterly per the
    // Accountability Agreement — this cadence is for visibility only, so Michael
    // can see how things are tracking and the accountant can accrue more
    // granularly than once a quarter.
    // Jan/Apr/Jul/Oct 1 — "first payroll following quarter end" — finalize the
    // quarter that JUST ended (isFinal: true, same as before).
    // Every other month — snapshot the quarter still IN PROGRESS (isFinal:
    // false), so payable reflects quarter-to-date cash collected, not a final
    // payout number.
    // Every run (monthly and quarterly) goes out as a DRAFT first — see
    // commission-report-reply.js for the reply-driven approval loop.
    schedule: '0 6 1 * *',
    name: 'pm_commission_report',
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
  });
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
