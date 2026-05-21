// scheduler/cron.js - Automated task scheduler
import 'dotenv/config';
import cron from 'node-cron';
import { spawn } from 'child_process';
import { runAgent } from '../core/agent.js';
import { logger } from '../core/logger.js';

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
    // Sunday 1:30 AM — QBO ↔ SA audit matching engine (runs after 1 AM sa_nightly_sync)
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
    // Monday 7 AM — prior week QBO AR/payment summary to Michael
    schedule: '0 7 * * 1',
    name: 'weekly_crm_report',
    run: async () => {
      const { sendEmail } = await import('../tools/impl/m365.js');
      const d = new Date();
      const dayNum = d.getUTCDay() || 7;
      const thu = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 4 - dayNum));
      const yearStart = new Date(Date.UTC(thu.getUTCFullYear(), 0, 1));
      const weekNum = Math.ceil((((thu - yearStart) / 86400000) + 1) / 7);
      const weekLabel = `${thu.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;

      const { result: reportContent } = await runAgent({
        task: `Pull QuickBooks data for the prior week. Include: outstanding invoices (total AR, overdue breakdown), payments received, any new customers, and top open balances. Write a concise executive summary. Save to OneDrive at /Agent Reports/Weekly CRM/${weekLabel}.md. Return the full report as plain text. Do NOT send a Teams message.`,
        taskType: 'report',
        saveContext: true,
      });

      await sendEmail({
        to: ['michael@jrboehlke.com'],
        subject: `Weekly Finance Report — ${weekLabel}`,
        body: `<p>${(reportContent ?? 'Report generated — see OneDrive for full details.').replace(/\n/g, '<br>')}</p><hr><p><em>Sent by JRB Executive Assistant</em></p>`,
      });
      logger.info('Weekly CRM report sent', { week: weekLabel });
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
          const crmTask = `You received an email from Michael. Execute the action he is requesting using your SA and CRM tools.

Subject: “${email.subject}”
Email body:
${body}

Instructions:
- If this is a forwarded contact form or new customer inquiry: search SA for the client by name (sa_search_clients). If not found, create them (sa_create_client with name, address, phone, email from the form). Then add a ticket (sa_add_ticket) summarizing the inquiry and any follow-up requested.
- If Michael asks to create a ticket, estimate, job, or any SA record: do it now using your tools.
- If Michael asks to look up a client, invoice, or balance: do it and report back.

TICKET VERIFICATION (required after any sa_add_ticket call):
After creating a ticket, immediately call sa_get_ticket with the returned ticketId to verify it was saved in SA.
- If sa_get_ticket returns the ticket: begin your reply with "TICKET CONFIRMED IN SA:" followed by the client name, subject, and ticket ID.
- If sa_get_ticket returns null or fails: begin your reply with "WARNING — TICKET NOT VERIFIED:" and describe what was attempted. Michael should manually check SA.

Always include: client name, SA IDs, and actions taken. Reply in plain text — no HTML needed.`;

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
