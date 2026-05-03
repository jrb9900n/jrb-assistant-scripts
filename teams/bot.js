// teams/bot.js - Microsoft Teams bot server
import 'dotenv/config';
import http from 'http';
import { runAgent } from '../core/agent.js';
import { runSavedAgent } from '../agents/library.js';
import { runSkill } from '../skills/library.js';
import { listAgents } from '../agents/library.js';
import { listSkills } from '../skills/library.js';
import { logger } from '../core/logger.js';

const PORT = parseInt(process.env.TEAMS_PORT ?? '3978');
const BOT_APP_ID     = process.env.TEAMS_BOT_APP_ID;
const BOT_APP_SECRET = process.env.TEAMS_BOT_APP_SECRET;

let _botToken = null;
let _botTokenExpiry = 0;

async function getBotToken() {
  if (_botToken && Date.now() < _botTokenExpiry - 30_000) return _botToken;
  const res = await fetch('https://login.microsoftonline.com/9299991a-3e06-48e4-8ba8-f3f7d3aada32/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     BOT_APP_ID,
      client_secret: BOT_APP_SECRET,
      scope:         'https://api.botframework.com/.default',
    }),
  });
  const data = await res.json();
  _botToken = data.access_token;
  _botTokenExpiry = Date.now() + data.expires_in * 1000;
  return _botToken;
}

async function replyToTeams(activity, text) {
  const token = await getBotToken();
  const serviceUrl = activity.serviceUrl.replace(/\/$/, '');
  const url = `${serviceUrl}/v3/conversations/${activity.conversation.id}/activities/${activity.id}`;
  const replyRes = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'message',
      text,
      replyToId: activity.id,
      from: { id: BOT_APP_ID, name: 'JRB Assistant' },
      conversation: activity.conversation,
      recipient: activity.from,
    }),
  });
  const replyText = await replyRes.text();
  logger.info('Reply status', { status: replyRes.status, body: replyText.slice(0, 200) });
}

async function handleMessage(text, activity) {
  const trimmed = text.trim();

  if (/^\/list\s+(agents|skills)/i.test(trimmed)) {
    const type = trimmed.match(/agents/i) ? 'agents' : 'skills';
    const items = type === 'agents' ? await listAgents() : await listSkills();
    const lines = items.map(i => `• **${i.name}** — ${i.description}`).join('\n');
    return `**Available ${type}:**\n\n${lines}`;
  }

  const agentMatch = trimmed.match(/^\/agent\s+(\S+)\s+([\s\S]+)/i);
  if (agentMatch) {
    const [, agentName, task] = agentMatch;
    const { result } = await runSavedAgent({ agentName, task });
    return result;
  }

  const skillMatch = trimmed.match(/^\/skill\s+(\S+)(.*)/i);
  if (skillMatch) {
    const [, skillName, varStr] = skillMatch;
    const vars = Object.fromEntries(
      [...varStr.matchAll(/(\w+)=([^\s]+)/g)].map(m => [m[1], m[2]])
    );
    const { result } = await runSkill({ skill: skillName, vars });
    return result;
  }

  const { result } = await runAgent({
    task: trimmed,
    taskType: inferTaskType(trimmed),
  });
  return result;
}

function inferTaskType(text) {
  const t = text.toLowerCase();
  if (/email|inbox|draft|send|reply|message/i.test(t))   return 'email';
  if (/invoice|payment|overdue|quickbooks|crm|deal|hubspot/i.test(t)) return 'crm';
  if (/report|summary|analyse|analyze|pipeline/i.test(t)) return 'report';
  if (/script|code|write|function|playwright|automate/i.test(t)) return 'code';
  if (/file|folder|onedrive|save|upload/i.test(t))       return 'file';
  return 'general';
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/messages') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();

  let activity;
  try {
    activity = JSON.parse(body);
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{}');

  if (activity.type !== 'message' || !activity.text) return;

  const text = activity.text.replace(/<at>[^<]+<\/at>/g, '').trim();
  if (!text) return;

  logger.info('Teams message received', {
    serviceUrl: activity.serviceUrl,
    from: activity.from?.name,
    text: text.slice(0, 80),
  });

  try {
    await replyToTeams(activity, '⏳ Working on it...');
    const reply = await handleMessage(text, activity);
    const msgChunks = chunkText(reply, 24000);
    for (const chunk of msgChunks) {
      await replyToTeams(activity, chunk);
    }
  } catch (err) {
    logger.error('Teams handler error', { err: err.message });
    await replyToTeams(activity, `❌ Error: ${err.message}`);
  }
});

function chunkText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks;
}

server.listen(PORT, () => {
  logger.info(`Teams bot listening on port ${PORT}`);
});

export default server;