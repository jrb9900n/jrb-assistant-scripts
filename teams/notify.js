// teams/notify.js — Proactive Teams messaging (no circular deps)
// Separated from bot.js so mcp/server.js can import it without creating a cycle.

import { readFileSync, writeFileSync } from 'fs';
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
const ERROR_SIGNAL_RE = /⚠️|\bFAILED\b|\bWARNING\b/;
export const SELF_HEAL_QUEUE_PATH = path.join(__dirname, 'self-heal-queue.json');
const SELF_HEAL_QUEUE_MAX = 200; // cap so a flapping alert can't grow this file unbounded

function enqueueSelfHeal(message) {
  try {
    let queue = [];
    try { queue = JSON.parse(readFileSync(SELF_HEAL_QUEUE_PATH, 'utf8')); } catch {}
    queue.push({
      id: randomUUID(),
      created_at: new Date().toISOString(),
      message,
      // Digits stripped so near-identical repeats of a flapping alert (different
      // timestamps/counts) collapse to the same signature for cooldown purposes.
      signature: message.replace(/[0-9]+/g, '#').slice(0, 120),
      status: 'pending',
    });
    if (queue.length > SELF_HEAL_QUEUE_MAX) queue = queue.slice(-SELF_HEAL_QUEUE_MAX);
    writeFileSync(SELF_HEAL_QUEUE_PATH, JSON.stringify(queue, null, 2));
  } catch (err) {
    logger.warn('Could not enqueue self-heal entry', { err: err.message });
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

export async function sendProactiveMessage(message) {
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
  logger.info('Proactive Teams message sent', { preview: message.slice(0, 60) });
  if (ERROR_SIGNAL_RE.test(message)) enqueueSelfHeal(message);
}
