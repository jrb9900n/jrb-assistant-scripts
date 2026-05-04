// teams/bot.js - Microsoft Teams bot server
// REBUILT 2026-05-04 — MCP removed from this file, lives in mcp/server.js
import http from 'http';
import { runAgent } from '../core/agent.js';
import { runSavedAgent } from '../agents/library.js';
import { runSkill } from '../skills/library.js';
import { listAgents } from '../agents/library.js';
import { listSkills } from '../skills/library.js';
import { logger } from '../core/logger.js';
import {
  handleOAuthAuthorize,
  handleOAuthApprove,
  handleOAuthToken,
  handleOAuthRegister,
  handleOAuthWellKnown,
} from '../mcp/oauth.js';

const PORT = parseInt(process.env.TEAMS_PORT ?? '3978');
const BOT_APP_ID     = process.env.TEAMS_BOT_APP_ID;
const BOT_APP_SECRET = process.env.TEAMS_BOT_APP_SECRET;
const EXECUTE_SECRET = process.env.CLAUDE_EXECUTE_SECRET;

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
    body: JSON.stringify({ type: 'message', text }),
  });
  if (!replyRes.ok) {
    logger.error('Teams reply failed', { status: replyRes.status, body: await replyRes.text() });
  }
}

// ── /execute endpoint — Claude.ai chat can trigger agent tasks ────────────────
async function handleExecute(req, res) {
  // Auth check
  const auth = req.headers['x-execute-secret'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!EXECUTE_SECRET || auth !== EXECUTE_SECRET) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  let body = '';
  req.on('data', d => body += d);
  await new Promise(r => req.on('end', r));

  let parsed;
  try { parsed = JSON.parse(body); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  const { task, agentId, skillId } = parsed;
  if (!task) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'task is required' }));
    return;
  }

  logger.info('Execute request', { task: task.slice(0, 80) });

  try {
    let result;
    if (agentId) {
      result = await runSavedAgent(agentId, task);
    } else if (skillId) {
      result = await runSkill(skillId, task);
    } else {
      result = await runAgent(task, 'general');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result }));
  } catch (err) {
    logger.error('Execute error', { err: err.message });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ── /agents and /skills listing endpoints ────────────────────────────────────
async function handleList(req, res, type) {
  const auth = req.headers['x-execute-secret'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!EXECUTE_SECRET || auth !== EXECUTE_SECRET) {
    res.writeHead(401); res.end('Unauthorized'); return;
  }
  const items = type === 'agents' ? await listAgents() : await listSkills();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(items));
}

// ── Teams activity handler ────────────────────────────────────────────────────
async function handleTeamsActivity(req, res) {
  let body = '';
  req.on('data', d => body += d);
  await new Promise(r => req.on('end', r));

  let activity;
  try { activity = JSON.parse(body); } catch {
    res.writeHead(400); res.end('Bad request'); return;
  }

  res.writeHead(200); res.end('OK');

  if (activity.type !== 'message') return;

  const userText = (activity.text || '').replace(/<[^>]+>/g, '').trim();
  if (!userText) return;

  logger.info('Teams message', { text: userText.slice(0, 80) });

  try {
    const result = await runAgent(userText, 'general');
    await replyToTeams(activity, result);
  } catch (err) {
    logger.error('Teams handler error', { err: err.message });
    await replyToTeams(activity, `Error: ${err.message}`);
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────
// Dynamically import MCP handler (built separately, may not exist yet)
let mcpHandler = null;
async function loadMcpHandler() {
  try {
    const mod = await import('../mcp/server.js');
    mcpHandler = mod.handleMcpRequest;
    logger.info('MCP handler loaded from mcp/server.js');
  } catch (err) {
    logger.warn('MCP handler not loaded (mcp/server.js missing or errored)', { err: err.message });
  }
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Execute-Secret, mcp-session-id');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url?.split('?')[0];

  // ── OAuth 2.0 endpoints (required by Claude.ai custom connector) ──────────
  if (req.method === 'GET' && url === '/.well-known/oauth-authorization-server') {
    await handleOAuthWellKnown(req, res); return;
  }
  if (req.method === 'POST' && url === '/register') {
    await handleOAuthRegister(req, res); return;
  }
  if (req.method === 'GET' && url === '/authorize') {
    await handleOAuthAuthorize(req, res); return;
  }
  if (req.method === 'GET' && url === '/oauth/approve') {
    await handleOAuthApprove(req, res); return;
  }
  if (req.method === 'POST' && url === '/token') {
    await handleOAuthToken(req, res); return;
  }

    // MCP endpoint — delegate entirely to mcp/server.js
  if (url === '/mcp') {
    if (mcpHandler) {
      await mcpHandler(req, res);
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'MCP server not loaded' }));
    }
    return;
  }

  // Execute endpoint
  if (req.method === 'POST' && url === '/execute') {
    await handleExecute(req, res); return;
  }

  // Agent/skill listing
  if (req.method === 'GET' && url === '/agents') {
    await handleList(req, res, 'agents'); return;
  }
  if (req.method === 'GET' && url === '/skills') {
    await handleList(req, res, 'skills'); return;
  }

  // Teams webhook
  if (req.method === 'POST' && url === '/api/messages') {
    await handleTeamsActivity(req, res); return;
  }

  // Health check
  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', mcp: mcpHandler ? 'loaded' : 'not loaded', ts: new Date().toISOString() }));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

await loadMcpHandler();

server.listen(PORT, () => {
  logger.info(`Teams bot listening on port ${PORT}`);
});
