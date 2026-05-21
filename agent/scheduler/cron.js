// scheduler/cron.js - Automated task scheduler
import 'dotenv/config';
import cron from 'node-cron';
import { runAgent } from '../core/agent.js';
import { logger } from '../core/logger.js';
import { classifyIntent, isExplicitDevTask, isAmbiguousDevTask } from '../teams/router.js';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// File-based lock to prevent duplicate runs when multiple scheduler instances are alive.
// Returns true if this instance should proceed; false if another instance ran recently.
function acquireRunLock(taskName, ttlMs = 60_000) {
  const lockFile = join(tmpdir(), `jrb-scheduler-${taskName}.lock`);
  try {
    if (existsSync(lockFile)) {
      const ts = Number(readFileSync(lockFile, 'utf8'));
      if (Date.now() - ts < ttlMs) return false; // another instance holds the lock
    }
    writeFileSync(lockFile, String(Date.now()), 'utf8');
    return true;
  } catch {
    return true; // if we can't read/write the lock, proceed anyway
  }
}

function releaseRunLock(taskName) {
  const lockFile = join(tmpdir(), `jrb-scheduler-${taskName}.lock`);
  try { unlinkSync(lockFile); } catch { /* ignore */ }
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
    // Monday 7 AM — prior week credit card expense summary to Michael
    schedule: '0 7 * * 1',
    name: 'weekly_expense_report',
    run: async () => {
      const { generateWeeklyExpenseReport } = await import('../tools/impl/expense.js');
      const { sendEmail } = await import('../tools/impl/m365.js');
      const report = await generateWeeklyExpenseReport();
      await sendEmail({
        to: ['michael@jrboehlke.com'],
        subject: report.subject,
        body: report.body,
      });
      logger.info('Weekly expense report sent', { subject: report.subject });
    },
  },
  {
    // Sunday 1:30 AM — QBO ↔ SA audit matching engine
    // Runs after the 1 AM SA nightly sync to ensure sa_jobs is fresh.
    schedule: '30 1 * * 0',
    name: 'weekly_audit_run',
    run: async () => {
      const { runAudit } = await import('../tools/impl/audit.js');
      const result = await runAudit();
      logger.info('Weekly audit run complete', result);
    },
  },
  {
    // Sunday 6 AM — send QBO ↔ SA audit summary email to Michael
    schedule: '0 6 * * 0',
    name: 'weekly_audit_email',
    run: async () => {
      const { generateAuditEmail } = await import('../tools/impl/audit.js');
      const { sendEmail } = await import('../tools/impl/m365.js');
      const report = await generateAuditEmail();
      await sendEmail({
        to: ['michael@jrboehlke.com'],
        subject: report.subject,
        body: report.body,
      });
      logger.info('Weekly audit email sent', { subject: report.subject });
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
    schedule: '0 7 * * 1',
    name: 'weekly_crm_report',
    run: async () => {
      if (!acquireRunLock('weekly_crm_report', 10 * 60_000)) {
        logger.debug('weekly_crm_report: skipped (another instance running)');
        return;
      }
      try {
        const { sendEmail } = await import('../tools/impl/m365.js');
        const d = new Date();
        const dayNum = d.getUTCDay() || 7;
        const thu = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 4 - dayNum));
        const yearStart = new Date(Date.UTC(thu.getUTCFullYear(), 0, 1));
        const weekNum = Math.ceil((((thu - yearStart) / 86400000) + 1) / 7);
        const weekLabel = `${thu.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;

        const { result: reportContent } = await runAgent({
          task: `Pull HubSpot deals data. Identify new deals, deals moved to next stage, deals at risk, deals closed. Pull QuickBooks outstanding invoices and payments. Write executive summary. Save to OneDrive at /Agent Reports/Weekly CRM/${weekLabel}.md. Return the full report as plain text. Do NOT send a Teams message.`,
          taskType: 'report',
          saveContext: true,
        });

        await sendEmail({
          to: ['michael@jrboehlke.com'],
          subject: `Weekly CRM & Finance Report — ${weekLabel}`,
          body: `<p>${(reportContent ?? 'Report generated — see OneDrive for full details.').replace(/\n/g, '<br>')}</p><hr><p><em>Sent by JRB Executive Assistant</em></p>`,
        });
        logger.info('Weekly CRM report sent', { week: weekLabel });
      } finally {
        releaseRunLock('weekly_crm_report');
      }
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
    // 1 AM nightly — run all SA syncs (waiting list + scheduled jobs)
    schedule: '0 1 * * *',
    name: 'sa_nightly_sync',
    run: () => runAgent({
      task: 'Run the SA nightly sync script. Use run_script with script_path "C:\\\\Users\\\\Assistant\\\\OneDrive - jrboehlke.com\\\\JR Boehlke - Claude Folder\\\\BTA Reporting\\\\sa-nightly-sync.js" and timeout_ms 600000 (10 minutes). Log the result including job counts for each sync.',
      taskType: 'code',
      saveContext: false,
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

        const intent = classifyIntent(fullText);

        // ── Scheduling request ────────────────────────────────────────────────
        if (intent === 'scheduling') {
          logger.info('Email poller: detected scheduling request', { subject: email.subject });
          const schedTask = `You received an email from Michael asking about crew scheduling.\nSubject: "${email.subject}"\n\n${body}\n\nHandle this scheduling request using your scheduling tools. Return only the reply text.`;
          const schedResult = await runAgent({ task: schedTask, taskType: 'scheduling', saveContext: false });
          const schedReply = schedResult?.result ?? 'On it — checking the schedule now.';
          await sendEmail({
            to: [email.from],
            subject: `Re: ${email.subject}`,
            body: `<p>${schedReply.replace(/\n/g, '<br>')}</p><hr><p><em>Sent by JRB Executive Assistant</em></p>`,
          });
          logger.info('Email poller: replied to scheduling request', { from: email.from });
          continue;
        }

        // ── Dev task detection ──────────────────────────────────────────────────
        const isExplicitDev = intent === 'dev';
        const isAmbiguousDev = intent === 'dev_ambiguous';

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
        const isCrm = intent === 'crm';

        if (isCrm) {
          logger.info(`Email poller: detected CRM/SA action request`, { subject: email.subject });
          const crmTask = `You received an email from Michael. Execute the action he is requesting using your SA and CRM tools.

Subject: “${email.subject}”
Email body:
${body}

Instructions:
- If this is a forwarded contact form or new customer inquiry: search SA for the client by name (sa_search_clients). If not found, create them (sa_create_client with name, address, phone, email from the form). Then add a ticket (sa_add_ticket) summarizing the inquiry and any follow-up requested.
- If Michael asks to create a ticket, estimate, job, or any SA record: do it now using your tools.
- If Michael asks to look up a client, invoice, or balance: do it and report back.
- Always confirm what you did: client name, SA IDs, actions taken.
- Reply in plain text — no HTML needed.`;

          const crmResult = await runAgent({ task: crmTask, taskType: 'crm', saveContext: false });
          const crmReply = crmResult?.result ?? 'Done — check SA for the new record.';
          await sendEmail({
            to: [email.from],
            subject: `Re: ${email.subject}`,
            body: `<p>${crmReply.replace(/\n/g, '<br>')}</p><hr><p><em>Sent by JRB Executive Assistant</em></p>`,
          });
          logger.info(`Email poller: executed CRM action and replied to ${email.from}`);
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
];

// â”€â”€ Dev task detection helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Shared with bot.js â€” explicit build intent + deliverable noun, or known phrases

// Intent detection is imported from teams/router.js (shared with bot.js)

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

// Server liveness check — ping /health every 4 minutes.
// Uses /health (no auth required) instead of /mcp so the scheduler process doesn't
// need CLAUDE_EXECUTE_SECRET. Verifies the bot server is alive; logs only on failure.
let mcpKeepaliveFailures = 0;

async function pingMcpKeepalive() {
  try {
    const res = await fetch('http://localhost:3978/health');
    if (res.ok) {
      if (mcpKeepaliveFailures > 0) {
        logger.info('Server liveness restored', { failures: mcpKeepaliveFailures });
        mcpKeepaliveFailures = 0;
      }
    } else {
      mcpKeepaliveFailures++;
      logger.warn('Server liveness non-200', { status: res.status, failures: mcpKeepaliveFailures });
    }
  } catch (err) {
    mcpKeepaliveFailures++;
    logger.warn('Server liveness check failed', { err: err.message, failures: mcpKeepaliveFailures });
  }
}

// Ping every 4 minutes (240000ms)
setInterval(pingMcpKeepalive, 240000);
// Also ping once at startup after 30 seconds
setTimeout(pingMcpKeepalive, 30000);
logger.info('MCP keepalive scheduled (every 4 min)');

import './task-poller.js';
