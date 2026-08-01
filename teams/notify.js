// teams/notify.js — Proactive Teams messaging (no circular deps)
// Separated from bot.js so mcp/server.js can import it without creating a cycle.

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { randomUUID } from 'crypto';
import { logger } from '../core/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CONV_REF_PATH = path.join(__dirname, 'conversation-ref.json');

// Self-heal queue: every outbound Teams message matching this pattern gets queued
// for an unattended investigate-and-fix pass (see scheduler/cron.js's
// self_heal_watcher task). Matches this codebase's actual alert conventions
// (grepped across every sendProactiveMessage call site) rather than a generic
// "error"/"failed" keyword list, to avoid false-positiving on routine messages
// like task-poller previews or expense/commission confirmations.
//
// IMPORTANT: Pass { suppressSelfHeal: true } when sending agent summary messages
// from the cron's self_heal_watcher itself, to prevent the agent's own status
// report from re-enqueuing a new self-heal and creating an infinite alert loop.
const ERROR_SIGNAL_RE = /⚠️|\bFAILED\b|\bWARNING\b/;
export const SELF_HEAL_QUEUE_PATH = path.join(__dirname, 'self-heal-queue.json');
const SELF_HEAL_QUEUE_MAX = 200; // cap so a flapping alert can't grow this file unbounded

// TRUST BOUNDARY: `message` originates from sendProactiveMessage call sites
// throughout the codebase. Some call sites incorporate external data (API
// response bodies, client names, filenames). The sanitized message written to
// the queue is used verbatim as part of an LLM prompt in cron.js's
// self_heal_watcher (auto_fix task). Strip prompt-injection vectors before
// enqueuing: remove backtick fences, angle-bracket tags, and newline/control
// characters that could break prompt structure or inject instructions.
function sanitizeForPrompt(str) {
  return str
    // Remove any content inside <...> tags that could be mistaken for XML/HTML
    // instruction blocks by the LLM
    .replace(/<[^>]{0,200}>/g, '')
    // Remove backtick sequences (code-fence injection)
    .replace(/`{1,3}/g, "'")
    // Collapse newlines/carriage returns to a single space so multi-line
    // content cannot push new instructions onto a fresh prompt line
    .replace(/[\r\n]+/g, ' ')
    // Remove other ASCII control characters
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();
}

// Write data to a file atomically using a write-to-temp-then-rename strategy.
// On POSIX systems rename(2) is atomic. On Windows it is not guaranteed atomic
// but is still far safer than truncating the target file in-place, because a
// crash (or another process's read — the Teams Bot and Scheduler run as
// separate OS processes and both call sendProactiveMessage) can't observe or
// leave behind a half-written file.
export function writeFileAtomic(targetPath, data) {
  const dir = path.dirname(targetPath);
  const tmp = path.join(dir, `.tmp-${randomUUID()}`);
  try {
    writeFileSync(tmp, data, 'utf8');
    renameSync(tmp, targetPath);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

function enqueueSelfHeal(message) {
  // Sanitize before anything else — cron.js interpolates queue[n].message
  // directly into an LLM prompt; an unsanitized message containing external
  // data (API response bodies, client names, filenames) is a prompt-injection
  // vector into the unattended auto_fix agent.
  const safeMessage = sanitizeForPrompt(message);

  // Cross-process contention note: readFileSync/writeFileAtomic are atomic on
  // POSIX but not guaranteed atomic on Windows, and cron.js's patchEntry reads
  // and writes this same file from a separate process. The retry loop below
  // recovers from the rare transient failure of a reader catching the OS
  // mid-rename; the atomic write above already eliminates the more common
  // failure mode (a torn/truncated read of a partially-written file).
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let previousQueueLength = 0;
    try {
      let queue = [];
      try {
        queue = JSON.parse(readFileSync(SELF_HEAL_QUEUE_PATH, 'utf8'));
      } catch (parseErr) {
        if (parseErr.code !== 'ENOENT') {
          logger.warn(
            'self-heal queue file could not be parsed — starting fresh. Previously queued entries may have been lost.',
            { err: parseErr.message, path: SELF_HEAL_QUEUE_PATH }
          );
        }
        queue = [];
      }
      if (!Array.isArray(queue)) {
        logger.warn('self-heal queue file contained non-array data — resetting to empty queue', { type: typeof queue });
        queue = [];
      }
      previousQueueLength = queue.length;

      queue.push({
        id: randomUUID(),
        created_at: new Date().toISOString(),
        message: safeMessage,
        // Digits stripped so near-identical repeats of a flapping alert (different
        // timestamps/counts) collapse to the same signature for cooldown purposes.
        signature: safeMessage.replace(/[0-9]+/g, '#').slice(0, 120),
        status: 'pending',
      });
      if (queue.length > SELF_HEAL_QUEUE_MAX) queue = queue.slice(-SELF_HEAL_QUEUE_MAX);

      writeFileAtomic(SELF_HEAL_QUEUE_PATH, JSON.stringify(queue, null, 2));
      return; // success
    } catch (err) {
      if (attempt < MAX_RETRIES - 1) {
        // Brief spin before retry — a rare transient failure resolves within one tick.
        const deadline = Date.now() + 20 * (attempt + 1);
        while (Date.now() < deadline) { /* spin */ }
      } else {
        logger.warn('Could not enqueue self-heal entry', { err: err.message, previousQueueLength });
      }
    }
  }
}

const BOT_APP_ID     = () => process.env.TEAMS_BOT_APP_ID;
const BOT_APP_SECRET = () => process.env.TEAMS_BOT_APP_SECRET;

let _botToken = null;
let _botTokenExpiry = 0;

async function getBotToken() {
  if (_botToken && Date.now() < _botTokenExpiry - 30_000) return _botToken;
  const res = await fetch('https://login.microsoftonline.com/9299991a-3e06-48e4-8ba8-f3f7d3aada32/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     BOT_APP_ID(),
      client_secret: BOT_APP_SECRET(),
      scope:         'https://api.botframework.com/.default',
    }),
  });
  const data = await res.json();
  _botToken = data.access_token;
  _botTokenExpiry = Date.now() + data.expires_in * 1000;
  return _botToken;
}

export function saveConversationRef(activity) {
  try {
    writeFileSync(CONV_REF_PATH, JSON.stringify({
      serviceUrl:     activity.serviceUrl,
      conversationId: activity.conversation.id,
      savedAt:        new Date().toISOString(),
    }));
  } catch (err) {
    logger.warn('Could not save conversation ref', { err: err.message });
  }
}

/**
 * Send a proactive message to the Teams conversation.
 *
 * @param {string} message                    - Message text to send.
 * @param {object} [options]                  - Optional settings.
 * @param {boolean} [options.suppressSelfHeal=false]
 *   When true, skip enqueueing this message for self-heal even if it matches
 *   ERROR_SIGNAL_RE. Set this to true when sending the agent's own remediation
 *   summary from cron's self_heal_watcher to prevent the status report from
 *   triggering another self-heal run (infinite loop guard).
 */
export async function sendProactiveMessage(message, { suppressSelfHeal = false } = {}) {
  let ref;
  try { ref = JSON.parse(readFileSync(CONV_REF_PATH, 'utf8')); }
  catch { throw new Error('No conversation reference stored. Send a message to the JRB bot in Teams first.'); }

  const token = await getBotToken();
  const url = `${ref.serviceUrl.replace(/\/$/, '')}/v3/conversations/${ref.conversationId}/activities`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'message', text: message }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Teams proactive message failed: ${res.status} ${body}`);
  }
  logger.info('Proactive Teams message sent', { preview: message.slice(0, 60), suppressSelfHeal });

  if (!suppressSelfHeal && ERROR_SIGNAL_RE.test(message)) {
    enqueueSelfHeal(message);
  }
}
