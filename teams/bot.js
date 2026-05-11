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

function buildSchedulingSystemPrompt(sessionId, weekStart, draftContext) {
  return `You are the JRB Field Operations Scheduling Agent embedded in the FieldOps web app.

## Your Role
Build and refine optimized daily/weekly schedules for J.R. Boehlke, LLC field crews in SE Wisconsin (metro Milwaukee). Michael Boehlke is the owner.

## Session Context
Session ID: ${sessionId}
Target week: ${weekStart || 'ask the user if not specified'}
Current date/time: ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })}

## Available Tools
- get_crews — load crew definitions, capacities, work types
- get_waiting_list — load unscheduled jobs (filter by service keyword)
- get_treatment_history — check last completed application per customer (REQUIRED before scheduling fert/mosquito)
- get_weather_forecast — 14-day SE Wisconsin forecast with safe_for_fert flag
- save_schedule_draft — persist the schedule so FieldOps board updates live
- get_schedule_draft — load current draft before editing

## Treatment Program Rules (CRITICAL)
- 5-application season: App 1 → App 2 → App 3 → App 4 → App 5
- MINIMUM 14 days between consecutive applications per customer
- ALWAYS call get_treatment_history before scheduling — check each customer's last App N-1 date
- Exclude customers where interval would be < 14 days; name them in your reply with the reason
- Mosquito control routes alongside fertilization (same crew: Dave Grennier)

## Scheduling Process
1. get_crews → understand who's available and their capacity
2. get_waiting_list (filtered by requested service type)
3. get_treatment_history (pass client_names from step 2 — NOT customer_ids)
4. get_weather_forecast (check target week)
5. Build day-by-day assignments: group by geography (city/zip on same day), respect daily_capacity, avoid days where safe_for_fert=false
6. Prioritize customers with highest days_waiting
7. save_schedule_draft — ALWAYS save; the board reads this in real time
8. Reply with a plain-text summary naming customers, days, counts, and any exclusions

## schedule_data Structure (for save_schedule_draft)
{
  "days": {
    "YYYY-MM-DD": {
      "Dave Grennier": [
        { "job_id": "...", "client": "Smith Residence", "address": "123 Main", "city": "Waukesha", "service": "App 3 Fertilization", "days_waiting": 45, "interval_ok": true }
      ]
    }
  },
  "summary": "47 App 3 jobs across 5 days..."
}

## Editing Drafts
Load with get_schedule_draft (session_id: "${sessionId}"), modify, then save_schedule_draft with the same draft_id.

## Confirmation
When user says "looks good / write it to SA / confirm": update draft status to 'confirmed' and note that SA write-back will be available once the endpoint is configured.
${draftContext}`.trim();
}

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
      ({ result } = await runSavedAgent({ agentName: agentId, task }));
    } else if (skillId) {
      ({ result } = await runSkill({ skill: skillId }));
    } else {
      ({ result } = await runAgent({ task, taskType: 'general' }));
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
    const { result } = await runAgent({ task: userText, taskType: 'general' });
    await replyToTeams(activity, result);
  } catch (err) {
    logger.error('Teams handler error', { err: err.message });
    await replyToTeams(activity, `Error: ${err.message}`);
  }
}

// ── FieldOps chat endpoint ────────────────────────────────────────────────────
async function handleFieldOpsChat(req, res) {
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

  const { message, sessionId, weekStart } = parsed;
  if (!message || !sessionId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'message and sessionId are required' }));
    return;
  }

  logger.info('FieldOps chat', { sessionId, message: message.slice(0, 80) });

  // Load existing draft to inject as context
  let draftContext = '';
  try {
    const { getScheduleDraft } = await import('../tools/impl/scheduling.js');
    const draft = await getScheduleDraft({ session_id: sessionId });
    if (draft) {
      const preview = JSON.stringify(draft.schedule_data, null, 2).slice(0, 2000);
      draftContext = `\n\n## Current Draft (ID: ${draft.id})\nDirective: ${draft.directive}\nWeek: ${draft.week_start || 'TBD'}\n\n${preview}`;
    }
  } catch (e) {
    logger.warn('Could not load draft context', { err: e.message });
  }

  const systemPrompt = buildSchedulingSystemPrompt(sessionId, weekStart, draftContext);

  try {
    const { result } = await runAgent({
      task: message,
      taskType: 'scheduling',
      systemPromptOverride: systemPrompt,
      saveContext: false,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ reply: result }));
  } catch (err) {
    logger.error('FieldOps chat error', { err: err.message });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
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

    // MCP Reconnect helper
  if (req.method === 'GET' && url === '/mcp-reconnect') {
    const s = new URL(req.url, 'https://agent.jrboehlke.com').searchParams.get('secret');
    if (!s || s !== EXECUTE_SECRET) { res.writeHead(401); res.end('Unauthorized'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><html><head><title>JRB Reconnect</title><style>body{font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center;padding:0 20px}.btn{display:inline-block;background:#2563eb;color:white;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:16px;margin-top:24px}</style></head><body><h2>JRB Executive Agent</h2><p style="color:#16a34a;font-weight:600">Agent is running</p><p style="margin-top:16px">Click below then disconnect and reconnect the JRB Assistant connector.</p><a href="https://claude.ai/settings/integrations" class="btn">Open Claude.ai Connector Settings</a><p style="margin-top:28px;color:#6b7280;font-size:13px">Bookmark this page for one-click reconnect after restarts.</p></body></html>');
    return;
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

  // FieldOps embedded chat — scheduling agent with session context
  if (req.method === 'POST' && url === '/fieldops-chat') {
    await handleFieldOpsChat(req, res); return;
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
