// teams/bot.js - Microsoft Teams bot server
// REBUILT 2026-05-04 — MCP removed from this file, lives in mcp/server.js
import http from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { runAgent } from '../core/agent.js';
import { runSavedAgent } from '../agents/library.js';
import { runSkill } from '../skills/library.js';
import { listAgents } from '../agents/library.js';
import { listSkills } from '../skills/library.js';
import { logger } from '../core/logger.js';
import { buildContextBlock } from '../tools/impl/feedback.js';
import { saveConversationRef, sendProactiveMessage } from './notify.js';
import { handleCardDAV } from '../tools/impl/carddav.js';
import {
  handleOAuthAuthorize,
  handleOAuthApprove,
  handleOAuthToken,
  handleOAuthRegister,
  handleOAuthWellKnown,
} from '../mcp/oauth.js';
import { classifyIntent } from './router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load scheduling skill definition once at startup
let SCHEDULING_SKILL = '';
try {
  SCHEDULING_SKILL = readFileSync(
    path.join(__dirname, '../skills/definitions/fieldops-scheduling.md'),
    'utf8'
  );
  // Strip YAML frontmatter
  SCHEDULING_SKILL = SCHEDULING_SKILL.replace(/^---[\s\S]*?---\n/, '').trim();
  logger.info('Scheduling skill loaded', { chars: SCHEDULING_SKILL.length });
} catch (e) {
  logger.warn('Could not load fieldops-scheduling.md skill', { err: e.message });
}

const PORT = parseInt(process.env.TEAMS_PORT ?? '3978');
const BOT_APP_ID     = process.env.TEAMS_BOT_APP_ID;
const BOT_APP_SECRET = process.env.TEAMS_BOT_APP_SECRET;
const EXECUTE_SECRET = process.env.CLAUDE_EXECUTE_SECRET;

function buildSchedulingSystemPrompt(sessionId, weekStart, draftContext, rulesBlock = '') {
  const skillSection = SCHEDULING_SKILL
    ? `\n\n---\n\n${SCHEDULING_SKILL}\n\n---`
    : '';

  return `You are the JRB Field Operations Scheduling Agent embedded in the FieldOps web app.

## Session Context
Session ID: ${sessionId}
Target week: ${weekStart || 'ask the user if not specified'}
Current date/time: ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })}
${skillSection}

## Available Tools
- get_crews — load crew definitions, capacities, work types
- get_waiting_list — load unscheduled jobs (filter by service keyword)
- get_treatment_history — check last completed application per customer (REQUIRED before scheduling fert/mosquito)
- get_weather_forecast — 14-day SE Wisconsin forecast with safe_for_fert flag
- save_schedule_draft — persist the schedule so FieldOps board updates live
- get_schedule_draft — load current draft before editing
- save_scheduling_rule — persist a correction or standing rule to Supabase so it applies to ALL future sessions. Use immediately when Michael corrects a mistake or states a rule. Write it as a clear, actionable statement.

## Editing Drafts
Load with get_schedule_draft (session_id: "${sessionId}"), modify, then save_schedule_draft with the same draft_id.

## Confirmation
When user says "looks good / write it to SA / confirm": update draft status to 'confirmed' and note that SA write-back will be available once the endpoint is configured.
${rulesBlock}${draftContext}`.trim();
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

// ── /notify endpoint — send a proactive Teams message to Michael ──────────────
async function handleNotify(req, res) {
  const auth = req.headers['x-execute-secret'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!EXECUTE_SECRET || auth !== EXECUTE_SECRET) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  let body = '';
  req.on('data', d => body += d);
  await new Promise(r => req.on('end', r));

  let message;
  try {
    const parsed = JSON.parse(body);
    message = parsed.message;
  } catch {
    message = null;
  }

  if (!message) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'message is required in JSON body' }));
    return;
  }

  try {
    await sendProactiveMessage(message);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    logger.error('Notify error', { err: err.message });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
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

  // Persist conversation reference so we can send proactive messages later
  saveConversationRef(activity);

  // Capture any standing rules/corrections before routing — non-blocking
  try {
    const { detectAndCaptureFeedback } = await import('../tools/impl/feedback-capture.js');
    const fb = await detectAndCaptureFeedback(userText, 'teams');
    if (fb.captured) {
      logger.info('Teams: feedback rule captured', { rule: fb.rule, agent: fb.agent });
    }
  } catch (err) {
    logger.warn('Teams: feedback capture error (non-fatal)', { err: err.message });
  }

  const intent = classifyIntent(userText);
  logger.info('Teams message', { intent, text: userText.slice(0, 80) });

  // Track what we're about to run so the catch block can queue a retry if SA is blocked
  let retryTask = userText;
  let retryTaskType = 'general';

  try {
    let result;

    if (intent === 'scheduling') {
      // Use the scheduling system prompt keyed to this Teams conversation so
      // draft state persists across multiple messages in the same conversation.
      const sessionId = `teams-${activity.conversation.id}`;
      let rulesBlock = '';
      try {
        const ctx = await buildContextBlock('scheduling');
        if (ctx) rulesBlock = `\n\n${ctx}`;
      } catch { /* non-fatal */ }

      let draftContext = '';
      try {
        const { getScheduleDraft } = await import('../tools/impl/scheduling.js');
        const draft = await getScheduleDraft({ session_id: sessionId });
        if (draft) {
          const preview = JSON.stringify(draft.schedule_data, null, 2).slice(0, 2000);
          draftContext = `\n\n## Current Draft (ID: ${draft.id})\nDirective: ${draft.directive}\nWeek: ${draft.week_start || 'TBD'}\n\n${preview}`;
        }
      } catch { /* non-fatal */ }

      const systemPrompt = buildSchedulingSystemPrompt(sessionId, null, draftContext, rulesBlock);
      retryTaskType = 'scheduling';
      ({ result } = await runAgent({ task: userText, taskType: 'scheduling', systemPromptOverride: systemPrompt, saveContext: true }));

    } else if (intent === 'crm') {
      const crmTask = `You received a Teams message from Michael. Execute the action he is requesting using your SA, CRM, and CardDAV tools.

Message: "${userText}"

- If this is a forwarded contact form or new customer inquiry: search SA for the client, create if not found, add a ticket.
- If Michael asks to create a ticket, estimate, job, or SA record: do it now.
- If Michael asks to look up a client, invoice, or balance: do it and report back.
- If Michael asks to provision CardDAV for an employee: use carddav_provision with their email and name. Return the server URL, username, and token with iOS/Android setup instructions.
- If Michael asks to revoke CardDAV for an employee: use carddav_revoke with their email.
- If Michael asks to list CardDAV credentials: use carddav_list.
- Always confirm what you did: client name, SA IDs, actions taken.`;
      retryTask = crmTask; retryTaskType = 'crm';
      ({ result } = await runAgent({ task: crmTask, taskType: 'crm', saveContext: false }));

    } else if (intent === 'dev') {
      const devTask = `Michael sent this Teams message:\n\n"${userText}"\n\nFollow the github-dev skill workflow. Reply with a scope proposal:\n- Restate the goal in 2-3 sentences\n- List the files that will be created or changed\n- Identify which repo this belongs in\n- State any assumptions\n- Ask Michael to confirm before you proceed\n\nDo not write any code yet. Return only the reply text.`;
      retryTask = devTask; retryTaskType = 'code';
      ({ result } = await runAgent({ task: devTask, taskType: 'code', saveContext: false }));

    } else if (intent === 'dev_ambiguous') {
      result = `Want to make sure I handle this correctly — are you asking me to build or write code, or looking for information/advice? Reply "yes, build it" and I'll put together a scope plan.`;

    } else if (intent === 'report') {
      retryTaskType = 'report';
      ({ result } = await runAgent({ task: userText, taskType: 'report', saveContext: false }));

    } else {
      ({ result } = await runAgent({ task: userText, taskType: 'general' }));
    }

    // Dispatcher catches tool-level errors — runAgent won't throw on SA blocks.
    // Check the backoff timer directly to detect if SA was blocked mid-run.
    const { getSABackoffUntil } = await import('../tools/impl/serviceautopilot.js');
    const backoffUntil = getSABackoffUntil();
    if (backoffUntil > Date.now()) {
      const runAfter = new Date(backoffUntil).toISOString();
      const remainingMin = Math.ceil((backoffUntil - Date.now()) / 60000);
      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/agent_tasks`, {
          method: 'POST',
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ task: retryTask, task_type: retryTaskType, status: 'pending', run_after: runAfter, notify_teams: true, retry_count: 0 }),
        });
        await replyToTeams(activity, `SA is temporarily rate-limited by bot protection. I've queued this task and will retry automatically in ~${remainingMin} min — I'll notify you here when it completes.`);
      } catch (queueErr) {
        logger.error('Teams handler: failed to queue SA retry task', { err: queueErr.message });
        await replyToTeams(activity, result);
      }
    } else {
      await replyToTeams(activity, result);
    }
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

  // Load dynamic rules from Supabase (Michael's corrections that persist across sessions)
  let rulesBlock = '';
  try {
    const ctx = await buildContextBlock('scheduling');
    if (ctx) rulesBlock = `\n\n${ctx}`;
  } catch (e) {
    logger.warn('Could not load scheduling rules from Supabase', { err: e.message });
  }

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

  const systemPrompt = buildSchedulingSystemPrompt(sessionId, weekStart, draftContext, rulesBlock);

  try {
    const { result } = await runAgent({
      task: message,
      taskType: 'scheduling',
      systemPromptOverride: systemPrompt,
      saveContext: true,
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
  const url = req.url?.split('?')[0];

  // CardDAV — handle before CORS (CardDAV has its own OPTIONS/auth)
  if (url?.startsWith('/carddav')) {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    await new Promise(r => req.on('end', r));
    const bodyBuf = Buffer.concat(chunks);

    // Minimal Express-style adapter
    const fakeReq = {
      method: req.method,
      path: url,
      headers: req.headers,
      body: bodyBuf,
    };
    const headers = {};
    const fakeRes = {
      _status: 200,
      set: (k, v) => { headers[k] = v; return fakeRes; },
      status: (s) => { fakeRes._status = s; return fakeRes; },
      send: (body) => {
        res.writeHead(fakeRes._status, headers);
        res.end(body);
      },
      redirect: (code, loc) => {
        res.writeHead(code, { Location: loc });
        res.end();
      },
    };

    try {
      await handleCardDAV(fakeReq, fakeRes);
    } catch (err) {
      logger.error('CardDAV error', { err: err.message });
      res.writeHead(500);
      res.end('Internal Server Error');
    }
    return;
  }

  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Execute-Secret, mcp-session-id');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

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

  // Notify — send a proactive Teams message (usable from Claude Code, scripts, etc.)
  if (req.method === 'POST' && url === '/notify') {
    await handleNotify(req, res); return;
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

  // ── Expense capture endpoints ─────────────────────────────────

  // QBO webhook — fires when a new Purchase entity is created
  if (req.method === 'POST' && url === '/qbo-webhook') {
    let rawBody = '';
    req.on('data', d => rawBody += d);
    await new Promise(r => req.on('end', r));
    const sig = req.headers['intuit-signature'] ?? '';
    res.writeHead(200); res.end('OK');          // QBO requires fast 200
    const { handleQboWebhook } = await import('../tools/impl/expense.js');
    handleQboWebhook(rawBody, sig).catch(err =>
      logger.error('QBO webhook error', { err: err.message })
    );
    return;
  }

  // GET /expense-data?token=<uuid> — returns pre-filled form data for the portal
  if (req.method === 'GET' && url.startsWith('/expense-data')) {
    const token = new URL(req.url, 'https://agent.jrboehlke.com').searchParams.get('token');
    if (!token) { res.writeHead(400); res.end(JSON.stringify({ error: 'token required' })); return; }
    const { getExpenseData } = await import('../tools/impl/expense.js');
    const data = await getExpenseData(token);
    if (!data) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  // POST /expense-submit — receives completed form from expense portal
  if (req.method === 'POST' && url === '/expense-submit') {
    let body = '';
    req.on('data', d => body += d);
    await new Promise(r => req.on('end', r));
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' })); return;
    }
    const { token, ...fields } = parsed;
    if (!token) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'token required' })); return; }
    const { submitExpenseReport } = await import('../tools/impl/expense.js');
    const result = await submitExpenseReport(token, fields);
    res.writeHead(result.error ? 400 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // Health check
  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', mcp: mcpHandler ? 'loaded' : 'not loaded', ts: new Date().toISOString() }));
    return;
  }

  // ── Google Ads flag actions — proxy to Python webhook server on port 8765 ──
  // Handles GET (approve/reject/comment form) and POST (comment submission).
  // Exposed via the Cloudflare tunnel so buttons in email are true one-click links.
  if (/^\/flag\/\d+\/(approve|reject|comment)\/[^/]+/i.test(url)) {
    const target = `http://localhost:8765${req.url}`;
    try {
      const init = { method: req.method };
      if (req.method === 'POST') {
        let postBody = '';
        req.on('data', d => postBody += d);
        await new Promise(r => req.on('end', r));
        init.body = postBody;
        init.headers = {
          'Content-Type': req.headers['content-type'] || 'application/x-www-form-urlencoded',
          'Content-Length': String(Buffer.byteLength(postBody)),
        };
      }
      const proxyRes = await fetch(target, init);
      const respBody = await proxyRes.arrayBuffer();
      res.writeHead(proxyRes.status, {
        'Content-Type': proxyRes.headers.get('content-type') || 'text/html; charset=utf-8',
      });
      res.end(Buffer.from(respBody));
    } catch (err) {
      logger.warn('Ads webhook proxy failed', { err: err.message });
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Approval server temporarily unavailable. Try again in a moment.');
    }
    return;
  }

  // ── QuickBooks OAuth re-auth ──────────────────────────────────
  // GET /qb-reauth?secret=<EXECUTE_SECRET>
  //   → redirects to Intuit auth page so Michael can reconnect QB
  // GET /qb-callback?code=<code>&realmId=<id>
  //   → exchanges auth code, saves new refresh token, done
  if (req.method === 'GET' && url.startsWith('/qb-reauth')) {
    const secret = new URL(req.url, 'https://agent.jrboehlke.com').searchParams.get('secret');
    if (secret !== process.env.CLAUDE_EXECUTE_SECRET) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized'); return;
    }
    const { buildQBAuthUrl } = await import('../tools/impl/qb-token.js');
    const authUrl = buildQBAuthUrl('reauth-' + Date.now());
    res.writeHead(302, { Location: authUrl });
    res.end(); return;
  }

  if (req.method === 'GET' && url.startsWith('/qb-callback')) {
    const params = new URL(req.url, 'https://agent.jrboehlke.com').searchParams;
    const code = params.get('code');
    const realmId = params.get('realmId');
    if (!code) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Missing code'); return; }

    try {
      const { exchangeQBAuthCode } = await import('../tools/impl/qb-token.js');
      await exchangeQBAuthCode(code);
      logger.info('QB: re-auth complete', { realmId });
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:monospace;background:#0a0a0a;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:#111;border:1px solid #333;border-radius:8px;padding:32px 40px;max-width:420px;text-align:center}
h2{color:#00cc66;margin-bottom:12px}p{color:#888;font-size:13px}</style></head>
<body><div class="box"><h2>QuickBooks Connected</h2>
<p>New refresh token saved. QBO queries will work immediately.</p></div></body></html>`);
    } catch (err) {
      logger.error('QB: re-auth callback failed', { err: err.message });
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`QB auth failed: ${err.message}`);
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

await loadMcpHandler();

server.listen(PORT, () => {
  logger.info(`Teams bot listening on port ${PORT}`);
});
