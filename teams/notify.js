// teams/notify.js — Proactive Teams messaging (no circular deps)
// Separated from bot.js so mcp/server.js can import it without creating a cycle.

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { logger } from '../core/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CONV_REF_PATH = path.join(__dirname, 'conversation-ref.json');

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
}
