// scheduler/task-poller.js
import { runAgent } from '../core/agent.js';
import { logger } from '../core/logger.js';
import { sendProactiveMessage } from '../teams/notify.js';
import { sendEmail } from '../tools/impl/m365.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ALERT_AFTER_FAILURES = 5;
const MAX_RETRIES = 3;

let consecutiveFailures = 0;

async function sb(p, opts = {}) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + p, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) { const t = await r.text(); throw new Error('Supabase ' + r.status + ': ' + t); }
  return r.json();
}

async function pollTasks() {
  let rows;
  try {
    const now = new Date().toISOString();
    // Skip tasks with a future run_after — only pick up tasks ready to run
    rows = await sb(
      `agent_tasks?status=eq.pending&or=(run_after.is.null,run_after.lte.${now})&order=created_at.asc&limit=3`
    );
    consecutiveFailures = 0;
  } catch (err) {
    consecutiveFailures++;
    if (consecutiveFailures === ALERT_AFTER_FAILURES) {
      logger.error('[task-poller] Supabase unreachable for 5 consecutive polls — task queue stalled', { err: err.message });
    } else {
      logger.warn('[task-poller] Poll failed', { err: err.message, consecutiveFailures });
    }
    return;
  }

  for (const row of rows) {
    try { await sb('agent_tasks?id=eq.' + row.id, { method: 'PATCH', body: JSON.stringify({ status: 'running' }) }); } catch { /* ignore */ }
    let result, status;
    try {
      const { result: r } = await runAgent({ task: row.task, taskType: row.task_type || 'general' });
      result = r; status = 'done';
    } catch (err) {
      const isIncapsula = err.message.includes('Incapsula backoff');
      const retryCount  = (row.retry_count || 0) + 1;

      if (isIncapsula && retryCount <= MAX_RETRIES) {
        // Re-queue with new backoff time instead of marking as error
        let { getSABackoffUntil } = await import('../tools/impl/serviceautopilot.js');
        const backoffUntil = getSABackoffUntil();
        const runAfter = backoffUntil > Date.now()
          ? new Date(backoffUntil).toISOString()
          : new Date(Date.now() + 45 * 60 * 1000).toISOString();
        try {
          await sb('agent_tasks?id=eq.' + row.id, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'pending', run_after: runAfter, retry_count: retryCount }),
          });
          logger.warn('[task-poller] SA Incapsula block — re-queued task', { id: row.id, runAfter, retryCount });
        } catch { /* ignore */ }
        continue;
      }

      result = 'Error: ' + err.message;
      status = isIncapsula ? 'error' : 'error';
    }

    try { await sb('agent_tasks?id=eq.' + row.id, { method: 'PATCH', body: JSON.stringify({ status, result }) }); } catch { /* ignore */ }

    // Send proactive Teams + email notification for tasks queued via the retry mechanism
    if (row.notify_teams) {
      const label = status === 'done' ? 'Retry complete' : 'Retry failed';
      const preview = (result || '').slice(0, 800);
      const attemptNum = row.retry_count || 0;

      try {
        await sendProactiveMessage(`**${label}** (queued SA task, attempt ${attemptNum}):\n\n${preview}`);
      } catch (e) {
        logger.warn('[task-poller] Could not send Teams notification', { err: e.message });
      }

      // notify_email: reply to the original sender (email-triggered tasks)
      // falls back to michael@ for Teams-triggered tasks that also want an email
      const emailRecipient = row.notify_email || (row.notify_teams ? 'michael@jrboehlke.com' : null);
      const emailSubject   = row.reply_subject || `Agent: ${label} — queued SA task`;
      if (emailRecipient) {
        try {
          await sendEmail({
            to: emailRecipient,
            subject: emailSubject,
            body: `<div style="font-family:Arial,sans-serif;max-width:640px;"><p><strong>${label}</strong> (attempt ${attemptNum})</p><p>${preview.replace(/\n/g, '<br>')}</p><hr><p style="color:#888;font-size:12px;"><em>Sent by JRB Executive Assistant</em></p></div>`,
          });
        } catch (e) {
          logger.warn('[task-poller] Could not send email notification', { err: e.message });
        }
      }
    }
  }
}

if (SUPABASE_URL && SUPABASE_KEY) {
  logger.info('[task-poller] Started');
  setInterval(pollTasks, 30000);
  pollTasks();
}

export { pollTasks };
