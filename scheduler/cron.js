// scheduler/cron.js - Automated task scheduler
import 'dotenv/config';
import cron from 'node-cron';
import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runAgent } from '../core/agent.js';
import { logger } from '../core/logger.js';

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

const SCHEDULED_TASKS = [
  {
    schedule: '0 8 * * 1-5',
    name: 'daily_email_digest',
    run: () => runAgent({
      task: 'List unread emails from the past 24 hours. Group by urgency: urgent, pending, FYI. Draft brief replies for urgent emails. Save summary to OneDrive at /Agent Reports/Email Digests/YYYY-MM-DD.md',
      taskType: 'email',
      saveContext: true,
    }),
  },
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
            } catch { clearInterval(iv); resolve(); } // lock deleted between existsSync and readFileSync
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
    // Monday 12:15 AM — full BTA weekly run: QB revenue package + SA pipeline + SP CSV output
    // Runs 14 min after AME (Mon 12:01 AM) to avoid QB API token pressure.
    // Scripts (sequential): rp-formatter.js → weekly-sync.js → sheets-formatter.js
    // Outputs: weekly-rp-*.csv, weekly-sp-*.csv, sa-estimates/tickets/waiting-list JSON
    schedule: '15 0 * * 1',
    name: 'bta_weekly_report',
    run: async () => {
      const BTA = 'C:\\Users\\Assistant\\BTA Reporting';
      const notify = (msg) => import('../teams/notify.js')
        .then(({ sendProactiveMessage }) => sendProactiveMessage(msg))
        .catch(() => {});

      const runScript = (script, timeoutMs) => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script], {
          cwd: BTA,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: timeoutMs,
        });
        let out = '', err = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err += d; });
        child.on('close', code => {
          logger.info(`bta_weekly_report:${script}`, { code, output: out.slice(-2000) });
          if (err) logger.warn(`bta_weekly_report:${script} stderr`, { stderr: err.slice(-1000) });
          if (code !== 0) reject(new Error(`${script} exited ${code}`));
          else resolve();
        });
        child.on('error', reject);
      });

      // Step 1: QB revenue package — failure is fatal
      await runScript('rp-formatter.js', 600_000).catch(async (e) => {
        await notify(`BTA Weekly Report FAILED — rp-formatter.js: ${e.message}`);
        throw e;
      });

      // Step 2: SA pipeline — failure is non-fatal (logs + warns, but still run sheets-formatter)
      await runScript('weekly-sync.js', 3_600_000).catch((e) => {
        logger.warn('bta_weekly_report: weekly-sync.js failed (non-fatal)', { err: e.message });
        notify(`BTA Weekly Report WARNING — weekly-sync.js: ${e.message}`);
      });

      // Step 3: SP CSV output from SA data — failure is non-fatal
      await runScript('sheets-formatter.js', 120_000).catch((e) => {
        logger.warn('bta_weekly_report: sheets-formatter.js failed (non-fatal)', { err: e.message });
        notify(`BTA Weekly Report WARNING — sheets-formatter.js: ${e.message}`);
      });
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
    // 2 AM nightly — sync QBO customers + vendors into each employee's Outlook contact folders
    schedule: '0 2 * * *',
    name: 'qbo_contacts_sync',
    run: async () => {
      const { runContactsSync } = await import('../tools/impl/contacts-sync.js');
      const result = await runContactsSync();
      logger.info('QBO contacts sync complete', { succeeded: result.succeeded, failed: result.failed });
    },
  },
  {
    // Monday 3 AM — full SA weekly pipeline (estimates, tickets, waiting list, lead matching, sheets)
    schedule: '0 3 * * 1',
    name: 'sa_weekly_sync',
    run: () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['weekly-sync.js'], {
        cwd: 'C:\\Users\\Assistant\\BTA Reporting',
        env: {
          ...process.env,
          FIELDOPS_SUPABASE_KEY: process.env.FLEETOPS_SUPABASE_SERVICE_KEY,
        },
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
    // Monday 4 AM — QB weekly revenue pull to Supabase (prior ISO week)
    schedule: '0 4 * * 1',
    name: 'qb_weekly_sync',
    run: () => new Promise((resolve, reject) => {
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
    }),
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
    // Every hour — check fleetops auth sequence drift and auto-fix
    schedule: '0 * * * *',
    name: 'fleetops_healthcheck',
    run: async () => {
      const { runFleetopsHealthcheck } = await import('../agent/tools/impl/fleetops-healthcheck.js');
      const result = await runFleetopsHealthcheck();
      logger.info('fleetops_healthcheck complete', result);
    },
  },
  {
    // 1 AM nightly — run all SA syncs (waiting list + scheduled jobs)
    schedule: '0 1 * * *',
    name: 'sa_nightly_sync',
    run: () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['sa-nightly-sync.js'], {
        cwd: 'C:\\Users\\Assistant\\BTA Reporting',
        env: {
          ...process.env,
          // Script uses FIELDOPS_SUPABASE_KEY; launcher injects FLEETOPS_SUPABASE_SERVICE_KEY
          FIELDOPS_SUPABASE_KEY: process.env.FLEETOPS_SUPABASE_SERVICE_KEY,
        },
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
    schedule: '*/5 * * * *',
    name: 'email_poller',
    run: async () => {
      if (!acquireRunLock('email_poller', 4 * 60_000)) {
        logger.debug('email_poller: skipped (another instance running)');
        return;
      }
      try {
      const { listEmails, getEmail, sendEmail, markEmailRead, listEmailAttachments, getEmailAttachmentBytes } = await import('../tools/impl/m365.js');
      const { processEmailedReceipt } = await import('../tools/impl/expense.js');
      const emails = await listEmails({ folder: 'Inbox', limit: 10, unread_only: true });

      for (const email of emails) {
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
        const full = await getEmail({ email_id: email.id });
        const body = full.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
        const fullText = email.subject + ' ' + body;

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
        // Contact forms, forwarded leads, and explicit SA/ticket requests go to
        // CRM routing which gives the agent SA tools and an action-oriented prompt.
        const isCrm = isCrmActionRequest(fullText);

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
- email, phone
If a field is not in the form, omit it from the tool call (except state: always include state, defaulting to “WI”).

STEP 2 — SEARCH FOR EXISTING CLIENT:
Call sa_search_clients using their last name. If a client with the same name or email already exists, do NOT create a duplicate — skip to STEP 4.

STEP 3 — CREATE CLIENT (only if new):
Call sa_create_client with all parsed fields.
- Business: pass companyName (client name in SA will be the company name)
- Individual: pass firstName and lastName only — client name will be “First Last”
- Always pass address, city, state, zip as separate fields

STEP 4 — ADD TICKET:
Call sa_add_ticket with:
- clientId from the client search or creation
- subject: “Web Lead — [brief description of request]”
- notes: Begin with “Created by AI on [today's date, e.g. 'May 21, 2026']. Verify contact information before proceeding.” then a blank line, then the full message from the contact form including all details

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
</table>

<h4>Lead Message</h4>
<p style=”background:#f9f9f9;padding:12px;border-left:3px solid #ccc;”>[brief summary of what they're asking for]</p>

<p><em>Note: [anything Michael should manually verify, e.g. incomplete address, ambiguous business/residential]</em></p>

━━━ OTHER SA ACTIONS ━━━
- If Michael asks to create a ticket, estimate, job, or other SA record: do it now using your tools, then reply with a brief HTML summary.
- If Michael asks to look up a client, invoice, or balance: do it and return the result in a readable format.`;

          const crmResult = await runAgent({ task: crmTask, taskType: 'crm', saveContext: false });
          const crmReply = crmResult?.result ?? 'Done — check SA for the new record.';
          // Forwarded leads (from Michael) get an internal summary — don't reply to his own email
          const crmReplyTo = isFromMichael ? 'michael@jrboehlke.com' : email.from;
          const crmSubject = isFromMichael ? `SA: ${email.subject}` : `Re: ${email.subject}`;
          await sendEmail({
            to: [crmReplyTo],
            subject: crmSubject,
            body: `<div style=”font-family:Arial,sans-serif;max-width:640px;”>${crmReply}</div><hr style=”margin:20px 0;”><p style=”color:#888;font-size:12px;”><em>Sent by JRB Executive Assistant</em></p>`,
          });
          logger.info(`Email poller: executed CRM action and sent summary to ${crmReplyTo}`);
          continue;
        }

        // ── Standard email reply ──────────────────────────────────────────────
        const task = `You received an email from ${email.from} with subject “${email.subject}”. Email body:\n\n${body}\n\nWrite a concise helpful reply. Return only the reply text.`;
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
  // Forwarded emails are almost always contact forms / leads
  if (/^(fw|fwd):/i.test(text.split('\n')[0])) return true;
  // Explicit SA/CRM keywords
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
    } catch (err) {
      logger.error(`Scheduled task failed: ${task.name}`, { err: err.message });
    }
  });
}
logger.info('All schedules registered. Scheduler running.');

// MCP keepalive — ping our own MCP endpoint every 4 minutes to prevent
// Claude.ai connector from timing out the session
const MCP_TOKEN = process.env.CLAUDE_MCP_TOKEN || process.env.CLAUDE_EXECUTE_SECRET;
let mcpKeepaliveFailures = 0;

async function pingMcpKeepalive() {
  try {
    const res = await fetch('http://localhost:3978/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(MCP_TOKEN ? { 'Authorization': `Bearer ${MCP_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'keepalive', version: '1.0.0' },
        },
      }),
    });
    if (res.ok || res.status === 200) {
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
