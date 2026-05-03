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
        // Only process emails from Michael
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

        logger.info(`Email poller: processing email from ${email.from}`, { subject: email.subject });
        const full = await getEmail({ email_id: email.id });
        const body = full.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);

        // â”€â”€ Dev task detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const isExplicitDev = isExplicitDevTask(email.subject + ' ' + body);
        const isAmbiguousDev = !isExplicitDev && isAmbiguousDevTask(email.subject + ' ' + body);

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

        // â”€â”€ Standard email reply â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
