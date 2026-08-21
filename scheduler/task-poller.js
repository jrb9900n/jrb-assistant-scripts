// scheduler/task-poller.js
import { runAgent } from '../core/agent.js';
import { logger } from '../core/logger.js';
import { sendProactiveMessage } from '../teams/notify.js';
import { sendEmail } from '../tools/impl/m365.js';
import { saveTurn } from '../memory/conversation.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ALERT_AFTER_FAILURES = 5;
const MAX_RETRIES = 3;

let consecutiveFailures = 0;

// Fix 5: Hoist SA import to module level so it loads once and any load
// failure is surfaced immediately rather than halting a mid-loop iteration.
let getSABackoffUntil = null;
let resetSABackoff = null;
try {
  const saModule = await import('../tools/impl/serviceautopilot.js');
  getSABackoffUntil = saModule.getSABackoffUntil;
  // Fix 2: expect the SA module to export a reset helper; if it doesn't,
  // we fall back to a no-op so the rest of the logic is unaffected.
  resetSABackoff = typeof saModule.resetSABackoff === 'function'
    ? saModule.resetSABackoff
    : () => {};
} catch (err) {
  logger.error('[task-poller] Failed to load serviceautopilot module — SA backoff checks disabled', { err: err.message });
  getSABackoffUntil = () => 0;
  resetSABackoff = () => {};
}

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
    // Fix 1: Atomic claim — PATCH only succeeds when status is still 'pending'.
    // If another poller instance already claimed this row the response array
    // will be empty, so we skip rather than running the task twice.
    let claimed;
    try {
      claimed = await sb(
        'agent_tasks?id=eq.' + row.id + '&status=eq.pending',
        { method: 'PATCH', body: JSON.stringify({ status: 'running' }) }
      );
    } catch (err) {
      logger.warn('[task-poller] Could not claim task — skipping', { id: row.id, err: err.message });
      continue;
    }
    if (!Array.isArray(claimed) || claimed.length === 0) {
      // Row was already claimed by another poller instance; skip silently.
      logger.info('[task-poller] Task already claimed by another worker — skipping', { id: row.id });
      continue;
    }

    // Fix 2: Reset the module-level SA backoff state before running each task
    // so a block triggered by task A does not incorrectly affect task B.
    resetSABackoff();

    // Fix 3: Initialise result/status to explicit sentinel values so any
    // accidental fall-through writes a safe, identifiable error instead of
    // undefined.
    let result = 'Error: task did not complete';
    let status = 'error';

    let taskCompleted = false;
    try {
      const { result: r } = await runAgent({
        task: row.task,
        taskType: row.task_type || 'general',
        ...(row.system_prompt_override ? { systemPromptOverride: row.system_prompt_override } : {}),
        ...(row.extra_messages ? { extraMessages: row.extra_messages } : {}),
      });

      // Dispatcher catches tool-level errors — runAgent won't throw on SA blocks.
      // Check the backoff timer directly to detect if SA was blocked mid-run.
      // 'auto_fix' never has SA tools (see tools/registry.js TOOL_MAP), so it
      // structurally cannot be the thing a live SA backoff is about — treat
      // it as never backed off, same bypass as teams/bot.js's identical
      // check, so a stale/unrelated backoff can't discard an already-
      // completed auto_fix result (which may include an opened PR).
      const backoffUntil = (row.task_type === 'auto_fix') ? 0 : getSABackoffUntil();
      if (backoffUntil > Date.now()) {
        const retryCount = (row.retry_count || 0) + 1;
        if (retryCount <= MAX_RETRIES) {
          const runAfter = new Date(backoffUntil).toISOString();
          try {
            await sb('agent_tasks?id=eq.' + row.id, {
              method: 'PATCH',
              body: JSON.stringify({ status: 'pending', run_after: runAfter, retry_count: retryCount }),
            });
            logger.warn('[task-poller] SA Incapsula block detected post-run — re-queued task', { id: row.id, runAfter, retryCount });
          } catch (patchErr) {
            logger.warn('[task-poller] Could not re-queue SA-blocked task', { id: row.id, err: patchErr.message });
          }
          // Fix 3: Use a flag to signal the re-queue path so the final PATCH
          // and notify blocks are skipped by explicit intent, not by accident.
          taskCompleted = false;
          continue;
        }
        // Max retries exceeded — fall through to final PATCH with error status.
        result = 'Error: SA Incapsula block — max retries exceeded';
        status = 'error';
      } else {
        result = r;
        status = 'done';
      }
      taskCompleted = true;
    } catch (err) {
      result = 'Error: ' + err.message;
      status = 'error';
      taskCompleted = true;
    }

    if (!taskCompleted) {
      // Should not be reached given the continue above, but guards against
      // future refactors silently skipping the final PATCH.
      continue;
    }

    try {
      await sb('agent_tasks?id=eq.' + row.id, { method: 'PATCH', body: JSON.stringify({ status, result }) });
    } catch (err) {
      logger.warn('[task-poller] Could not update task status', { id: row.id, err: err.message });
    }

    // Send proactive Teams + email notification for tasks queued via the retry mechanism
    if (row.notify_teams) {
      const label = status === 'done' ? 'Retry complete' : 'Retry failed';
      const preview = (result || '').slice(0, 800);
      const attemptNum = row.retry_count || 0;

      const teamsMsg = `**${label}** (queued SA task, attempt ${attemptNum}):\n\n${preview}`;
      try {
        await sendProactiveMessage(teamsMsg);
        // Record the real outcome as the conversation's assistant turn --
        // otherwise conversation_turns only ever has the generic "I've
        // queued this task..." placeholder bot.js saved when it first
        // deferred the task, and a follow-up like "what did you find"
        // would be answered from stale context.
        if (row.session_id) {
          saveTurn(row.session_id, 'assistant', teamsMsg).catch(err =>
            logger.warn('[task-poller] saveTurn (assistant) failed', { err: err.message })
          );
        }
      } catch (e) {
        logger.warn('[task-poller] Could not send Teams notification', { err: e.message });
      }

      // Fix 4: The outer `if (row.notify_teams)` already guarantees notify_teams
      // is truthy here, so the previous `row.notify_teams ? ... : null` ternary
      // was always true and would unconditionally use the hardcoded address.
      // Use a plain fallback string instead.
      const emailRecipient = row.notify_email || 'michael@jrboehlke.com';
      const emailSubject   = row.reply_subject || `Agent: ${label} — queued SA task`;
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

if (SUPABASE_URL && SUPABASE_KEY) {
  logger.info('[task-poller] Started');
  setInterval(pollTasks, 30000);
  pollTasks();
}

export { pollTasks };
