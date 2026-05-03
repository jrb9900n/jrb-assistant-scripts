// scheduler/cron.js - Automated task scheduler
import 'dotenv/config';
import cron from 'node-cron';
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
    schedule: '0 7 * * 1',
    name: 'weekly_crm_report',
    run: () => runAgent({
      task: 'Pull HubSpot deals data. Identify new deals, deals moved to next stage, deals at risk, deals closed. Pull QuickBooks outstanding invoices and payments. Write executive summary. Save to OneDrive at /Agent Reports/Weekly CRM/YYYY-WW.md',
      taskType: 'report',
      saveContext: true,
    }),
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
    schedule: '*/5 * * * *',
    name: 'email_poller',
    run: async () => {
      const { listEmails, getEmail, sendEmail, markEmailRead } = await import('../tools/impl/m365.js');
      const emails = await listEmails({ folder: 'Inbox', limit: 10, unread_only: true });
      for (const email of emails) {
        if (!email.from || email.from.toLowerCase() !== 'michael@jrboehlke.com') {
          await markEmailRead({ email_id: email.id });
          continue;
        }
        const autoSubjects = ['shared the folder', 'shared a file', 'invited you', 'has shared'];
        if (autoSubjects.some(s => email.subject.toLowerCase().includes(s))) {
          await markEmailRead({ email_id: email.id });
          continue;
        }
        const emailAge = Date.now() - new Date(email.date).getTime();
        if (emailAge > 24 * 60 * 60 * 1000) {
          await markEmailRead({ email_id: email.id });
          continue;
        }
        logger.info(`Email poller: processing email from ${email.from}`, { subject: email.subject });
        const full = await getEmail({ email_id: email.id });
        const body = full.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
        const task = `You received an email from ${email.from} with subject "${email.subject}". Email body:\n\n${body}\n\nWrite a concise helpful reply. Return only the reply text.`;
        const agentResult = await runAgent({ task, taskType: 'email', saveContext: false });
        const result = agentResult?.result ?? 'I received your email and will follow up shortly.';
        await sendEmail({
          to: [email.from],
          subject: `Re: ${email.subject}`,
          body: `<p>${result.replace(/\n/g, '<br>')}</p><hr><p><em>Sent by JRB Executive Assistant</em></p>`,
        });
        await markEmailRead({ email_id: email.id });
        logger.info(`Email poller: replied to ${email.from}`);
      }
    },
  },
];

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