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

// â”€â”€ Dev task detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Returns true when Michael is clearly asking for code to be written/deployed.
// Looks for explicit build/code intent combined with a deliverable noun.
function isExplicitDevTask(text) {
  const t = text.toLowerCase();
  const intentVerbs = /\b(build|create|write|develop|code|make|set up|implement|automate|generate)\b/;
  const deliverableNouns = /\b(script|program|tool|app|application|function|integration|workflow|automation|report|dashboard|bot|scheduler|pipeline)\b/;
  const explicitPhrases = /\b(using your coding skills|write (me |us )?code|build (me |us )?a|deploy (this|it|to)|push to (github|vercel|prod)|open a pr|create a branch)\b/;
  return explicitPhrases.test(t) || (intentVerbs.test(t) && deliverableNouns.test(t));
}

// Returns true when the message mentions code/tech topics but intent is unclear â€”
// could be a question, a discussion, or a build request.
function isAmbiguousDevTask(text) {
  const t = text.toLowerCase();
  const techTerms = /\b(script|code|github|deploy|vercel|supabase|automate|function|api|database|repo|branch|commit)\b/;
  return techTerms.test(t) && !isExplicitDevTask(text);
}

// â”€â”€ Message handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function handleMessage(text, activity) {
  const trimmed = text.trim();

  // Built-in slash commands
  if (/^\/list\s+(agents|skills)/i.test(trimmed)) {
    const type = trimmed.match(/agents/i) ? 'agents' : 'skills';
    const items = type === 'agents' ? await listAgents() : await listSkills();
    const lines = items.map(i => `â€¢ **${i.name}** â€” ${i.description}`).join('\n');
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

  // Dev task routing
  if (isExplicitDevTask(trimmed)) {
    // Clear build intent â€” run the github-dev skill and return scope proposal
    const { result } = await runAgent({
      task: trimmed,
      taskType: 'code',
      systemPromptOverride: buildDevSystemPrompt(),
    });
    return result;
  }

  if (isAmbiguousDevTask(trimmed)) {
    // Unclear whether Michael wants code built or just a question answered â€”
    // ask for clarification before starting any dev work
    return [
      `Just to make sure I understand what you need:`,
      ``,
      `Are you asking me to **build or write code** for this, or are you looking for information/advice?`,
      ``,
      `Reply with **"yes, build it"** and I'll put together a scope plan. Or just rephrase and I'll take it from there.`,
    ].join('\n');
  }

  // All other tasks â€” standard agent routing
  const { result } = await runAgent({
    task: trimmed,
    taskType: inferTaskType(trimmed),
  });
  return result;
}

// System prompt override for dev tasks â€” loads the github-dev skill rules
function buildDevSystemPrompt() {
  return `You are JRB Assistant, an AI executive assistant for J.R. Boehlke, LLC.

You have been asked to build or write code. Follow the github-dev skill workflow exactly:

1. SCOPE FIRST â€” before writing any code, restate the goal in 2-3 sentences, list the files 
   that will be created or changed, identify which repo this belongs in, state any assumptions, 
   and ask Michael to confirm before proceeding.

2. BRANCH â€” all work goes on a branch named claude/[short-task-description], never on main.

3. CHECKPOINTS â€” check in with Michael after scope, after core logic, after testing, 
   and before any deployment. Do not proceed past a checkpoint without a response.

4. PR â€” open a Pull Request when ready. Never merge without Michael's approval.
   Approval phrases: "looks good", "ship it", "approve", "merge it".

5. DEPLOY â€” never deploy to Vercel production or apply Supabase migrations without 
   explicit instruction from Michael.

Repos in scope: jrb9900n/jrb-assistant-scripts, jrb9900n/FleetOps, 
jrb9900n/FieldOps, jrb9900n/AuditMatchingEngine.

Start your response with the scope proposal. Do not write any code yet.`;
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

// â”€â”€ HTTP server â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    await replyToTeams(activity, 'â³ Working on it...');
    const reply = await handleMessage(text, activity);
    const msgChunks = chunkText(reply, 24000);
    for (const chunk of msgChunks) {
      await replyToTeams(activity, chunk);
    }
  } catch (err) {
    logger.error('Teams handler error', { err: err.message });
    await replyToTeams(activity, `âŒ Error: ${err.message}`);
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
