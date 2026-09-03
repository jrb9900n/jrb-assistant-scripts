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
import { loadRecentTurns, saveTurn } from '../memory/conversation.js';
import { saveConversationRef, saveEmployeeConversationRef, sendProactiveMessage, sanitizeForPrompt, buildAutoFixPrompt } from './notify.js';
import { resolveSender } from './identity.js';
import { handleCardDAV } from '../tools/impl/carddav.js';
import {
  handleOAuthAuthorize,
  handleOAuthApprove,
  handleOAuthToken,
  handleOAuthRegister,
  handleOAuthWellKnown,
} from '../mcp/oauth.js';
import { classifyIntent, classifyIntentLLM } from './router.js';

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

function buildSchedulingSystemPrompt(sessionId, weekStart, draftContext, rulesBlock = '', memoryBlock = '', decisionsBlock = '') {
  const skillSection = SCHEDULING_SKILL
    ? `\n\n---\n\n${SCHEDULING_SKILL}\n\n---`
    : '';

  return `You are the JRB Field Operations Scheduling Agent embedded in the FieldOps web app.

## Session Context
Session ID: ${sessionId}
Target week: ${weekStart || 'ask the user if not specified'}
Current date/time: ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })}
${decisionsBlock}
${skillSection}

## Available Tools
- get_crews — load crew definitions, capacities, work types
- get_waiting_list — load unscheduled jobs (filter by service keyword)
- get_treatment_history — check last completed application per customer (REQUIRED before scheduling fert/mosquito)
- get_weather_forecast — 14-day SE Wisconsin forecast with safe_for_fert flag
- save_schedule_draft — persist the schedule so FieldOps board updates live
- get_schedule_draft — load current draft before editing
- record_decision — persist a confirmed user decision to session memory so it survives across turns. Call this immediately when Michael confirms any specific action.
- sync_pavement_sizes — fetch Pavement Size (sq ft) from SA for all PMM clients and store in Supabase. Call this if pavement_sf is null across waiting list results. Pass force=true to re-fetch already-populated values.
- sa_list_resources — get SA crew list with GUIDs (call once before dispatching)
- sa_dispatch_job — move a waiting-list job onto the SA dispatch board for a specific date + crew
- sa_update_route_order — set the stop sequence on the SA dispatch board after all jobs are dispatched

## Editing Drafts
Load with get_schedule_draft (session_id: "${sessionId}"), modify, then save_schedule_draft with the same draft_id.

## Confirmation
When user says "looks good / write it to SA / confirm":
1. Update draft status to 'confirmed' in save_schedule_draft.
2. Call sa_list_resources to get crew GUIDs. Match the crew name (e.g. "Dave Grennier") to its GUID.
3. For each job in the confirmed draft, call sa_dispatch_job with the job_id, scheduled date (YYYY-MM-DD), and crew GUID.
4. After ALL jobs are dispatched, call sa_update_route_order once per day with the job_ids in stop order (same order as the draft). This sets the stop sequence on the SA dispatch board.
5. Report how many jobs were dispatched and confirm route order was set. List any failures — do NOT abort the batch on a single failure.
${rulesBlock}${draftContext}${memoryBlock ? `\n\n${memoryBlock}` : ''}`.trim();
}

async function loadSchedulingMemory() {
  try {
    const { loadContext } = await import('../memory/memory.js');
    // strict:true -- scheduling deliberately keeps its own isolated memory
    // stream (see the extraMessages comment at this function's call site);
    // unlike core/agent.js's default (broad, cross-topic) call, an unrelated
    // recent CRM/report summary must not get spliced into this prompt.
    return await loadContext({ topic: 'scheduling', strict: true, limit: 3 });
  } catch (e) {
    logger.warn('Could not load scheduling memory', { err: e.message });
    return '';
  }
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

// Same as replyToTeams, but attaches synthesized speech audio as a data URI.
// A data URI (vs. uploading to storage and linking) keeps this self-contained
// -- no new storage dependency -- and stays well within reasonable payload
// size for a single spoken reply, since synthesizeSpeech's input is already
// capped at TTS_MAX_INPUT_CHARS before this is ever called.
async function replyToTeamsWithAudio(activity, text, audioBuffer) {
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
      attachments: [{
        contentType: 'audio/mp3',
        contentUrl: `data:audio/mp3;base64,${audioBuffer.toString('base64')}`,
        name: 'voice-reply.mp3',
      }],
    }),
  });
  if (!replyRes.ok) {
    logger.error('Teams voice reply failed', { status: replyRes.status, body: await replyRes.text() });
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

// ── Teams image attachments ──────────────────────────────────────────────────
// Teams delivers a pasted/uploaded screenshot as an `image/*` attachment
// whose contentUrl requires the same Bot Framework bearer token used for
// proactive sends -- an unauthenticated fetch just 401s. Claude's vision
// input wants base64, so this downloads, size-checks, and encodes each one.
const IMAGE_CONTENT_TYPE_RE = /^image\/(png|jpe?g|gif|webp)$/i;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // stay well under Claude's per-image limit

// A pasted (Ctrl+V) image often arrives as an inline <img src="..."> tag
// inside activity.text's HTML rather than as a top-level attachments[]
// entry -- confirmed missing live 2026-08-24 (Michael sent a photo, bot said
// it saw nothing). activity.text gets its HTML tags stripped down to plain
// text before use, which would silently destroy this reference if it isn't
// captured first.
const INLINE_IMG_SRC_RE = /<img[^>]+src=["']([^"']+)["']/gi;

async function extractImageAttachments(activity) {
  const candidates = [];
  for (const att of activity.attachments || []) {
    if (att.contentUrl && IMAGE_CONTENT_TYPE_RE.test(att.contentType || '')) {
      candidates.push({ url: att.contentUrl, mediaType: att.contentType.toLowerCase() });
    }
  }
  INLINE_IMG_SRC_RE.lastIndex = 0;
  let match;
  while ((match = INLINE_IMG_SRC_RE.exec(activity.text || ''))) {
    if (!candidates.some(c => c.url === match[1])) candidates.push({ url: match[1], mediaType: null });
  }

  const images = [];
  for (const { url, mediaType } of candidates) {
    try {
      const token = await getBotToken();
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        logger.warn('Teams: image attachment download failed', { status: res.status, url: url.slice(0, 80) });
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_IMAGE_BYTES) {
        logger.warn('Teams: image attachment too large, skipping', { size: buf.length, max: MAX_IMAGE_BYTES });
        continue;
      }
      // Inline <img> tags carry no contentType -- fall back to whatever the
      // download response itself reports.
      const resolvedType = (mediaType || res.headers.get('content-type')?.split(';')[0] || '').toLowerCase();
      if (!IMAGE_CONTENT_TYPE_RE.test(resolvedType)) {
        logger.warn('Teams: image had unrecognized content type, skipping', { resolvedType });
        continue;
      }
      images.push({ mediaType: resolvedType === 'image/jpg' ? 'image/jpeg' : resolvedType, base64: buf.toString('base64') });
    } catch (err) {
      logger.warn('Teams: image attachment fetch error', { err: err.message });
    }
  }
  return images;
}

// ── Per-conversation serialization ───────────────────────────────────────────
// Teams can deliver two of Michael's messages close enough together that the
// second one's conversation-history load races the first one's still-in-
// flight turn-save -- confirmed live 2026-08-24 (naming two SA accounts to
// tag, then immediately "Can you update those for me," got "I don't have
// context for what 'those' refers to" one message later). Queuing every
// message for a given Teams conversation onto the same promise chain forces
// strict in-order processing instead of just narrowing the race window --
// a full fix rather than the previously-accepted partial mitigation.
const sessionQueues = new Map();

function runSerializedPerSession(sessionId, fn) {
  const prior = sessionQueues.get(sessionId) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  // A never-rejecting tail for the queue's own bookkeeping -- one message's
  // failure must not break serialization for the next message on the same
  // conversation. The real result/error is still returned to the caller.
  sessionQueues.set(sessionId, run.catch(() => {}));
  return run;
}

// ── Teams voice memos ────────────────────────────────────────────────────────
// A voice memo arrives as a single `audio/*` attachment, same download/auth
// mechanics as an image attachment above, but piped through OpenAI's Whisper
// API for transcription instead of handed to the model as-is (Claude doesn't
// take raw audio input). A voice memo typically carries no activity.text at
// all, so the caller must fold this transcript in BEFORE deciding whether the
// message has any actionable content.
const AUDIO_CONTENT_TYPE_RE = /^audio\//i;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // generous cap for a several-minute voice memo

async function extractAndTranscribeVoiceMemo(activity) {
  const attachments = activity.attachments || [];
  const audioAtt = attachments.find(a => a.contentUrl && AUDIO_CONTENT_TYPE_RE.test(a.contentType || ''));
  if (!audioAtt) return null;

  try {
    const token = await getBotToken();
    const res = await fetch(audioAtt.contentUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      logger.warn('Teams: voice memo download failed', { status: res.status, contentType: audioAtt.contentType });
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_AUDIO_BYTES) {
      logger.warn('Teams: voice memo too large, skipping', { size: buf.length, max: MAX_AUDIO_BYTES });
      return null;
    }
    const { transcribeAudio } = await import('../tools/impl/openai-voice.js');
    return await transcribeAudio({ audioBuffer: buf, mimeType: audioAtt.contentType, filename: audioAtt.name || 'voice-memo' });
  } catch (err) {
    logger.warn('Teams: voice memo transcription error', { err: err.message });
    return null;
  }
}

// A user asking for a spoken reply is the only trigger for voice output
// (Michael's explicit choice — replies stay text-only otherwise, even when
// the incoming message was itself a voice memo).
const WANTS_VOICE_REPLY_RE = /\b(reply|respond|answer|say|read|talk|speak)\b.{0,30}\b(voice|audio|out loud|aloud)\b|\b(voice|audio)\b.{0,10}\breply\b/i;

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

  const sessionId = `teams-${activity.conversation.id}`;
  await runSerializedPerSession(sessionId, () => processTeamsMessage(activity, sessionId));
}

async function processTeamsMessage(activity, sessionId) {
  const rawText = (activity.text || '').replace(/<[^>]+>/g, '').trim();

  // Extract any image attachments BEFORE the empty-text bail below -- Michael
  // can send a photo as its own message with no caption text at all.
  // Confirmed live 2026-08-24: a photo sent with no caption was silently
  // dropped entirely (this bail used to run before image extraction ever
  // happened), so the bot never saw it and later denied receiving one.
  const images = await extractImageAttachments(activity).catch(err => {
    logger.warn('Teams: could not extract image attachments', { err: err.message });
    return [];
  });

  // Transcribe any voice memo BEFORE the empty-text bail below -- a voice
  // memo typically arrives with activity.text empty, carrying its entire
  // content in the audio attachment. Bailing on !userText first would
  // silently drop the whole message.
  const voiceTranscript = await extractAndTranscribeVoiceMemo(activity);

  const userText = voiceTranscript
    ? (rawText ? `${rawText}\n\n[Voice memo transcript]: ${voiceTranscript}` : voiceTranscript)
    : rawText || (images.length
      ? '(Photo attached, no caption provided -- describe what you see and act on it if relevant to the current conversation.)'
      : '');
  if (!userText) return;

  // Resolve WHO is messaging before anything else. Added 2026-08-24 —
  // Michael's inbox/personal/business data must only ever be shared with
  // him; a non-Michael sender gets routed to a completely separate,
  // structurally-restricted path (see handleEmployeeMessage below and
  // tools/registry.js's TOOL_MAP.employee) instead of the normal pipeline.
  // resolveSender fails open (treats every sender as Michael) until
  // TEAMS_MICHAEL_AAD_ID is configured, so this is a zero-behavior-change
  // no-op today.
  const sender = await resolveSender(activity);
  if (!sender.isMichael) {
    await handleEmployeeMessage(activity, sender, sessionId, userText);
    return;
  }

  const wantsVoiceReply = WANTS_VOICE_REPLY_RE.test(userText);

  // Persist conversation reference so we can send proactive messages later
  saveConversationRef(activity);

  // Short-term conversation memory: recent raw turns from this same Teams
  // conversation, so the agent doesn't lose the thread mid-conversation
  // (e.g. "test that" right after a message describing what to test).
  // Awaited (not fire-and-forget) so this message's own turn is guaranteed
  // saved before loadRecentTurns runs below -- combined with
  // runSerializedPerSession above (which guarantees this whole function runs
  // to completion before the next queued message on this same conversation
  // starts), this closes the burst-race gap that used to let a fast second
  // message load history before the first message's turn had landed.
  await saveTurn(sessionId, 'user', userText).catch(err =>
    logger.warn('Teams: saveTurn (user) failed', { err: err.message })
  );

  // Feedback capture and conversation-history load touch unrelated data —
  // run them concurrently rather than paying both latencies sequentially.
  const [, extraMessages] = await Promise.all([
    (async () => {
      try {
        const { detectAndCaptureFeedback } = await import('../tools/impl/feedback-capture.js');
        const fb = await detectAndCaptureFeedback(userText, 'teams');
        if (fb.captured) {
          logger.info('Teams: feedback rule captured', { rule: fb.rule, agent: fb.agent });
        }
      } catch (err) {
        logger.warn('Teams: feedback capture error (non-fatal)', { err: err.message });
      }
    })(),
    loadRecentTurns(sessionId).catch(err => {
      logger.warn('Teams: could not load conversation history', { err: err.message });
      return [];
    }),
  ]);

  async function remember(text, { voiceReply = false } = {}) {
    if (voiceReply) {
      try {
        const { synthesizeSpeech } = await import('../tools/impl/openai-voice.js');
        const audio = await synthesizeSpeech(text);
        if (audio) {
          await replyToTeamsWithAudio(activity, text, audio);
          saveTurn(sessionId, 'assistant', text).catch(err =>
            logger.warn('Teams: saveTurn (assistant) failed', { err: err.message })
          );
          return;
        }
        logger.warn('Teams: voice reply requested but synthesis unavailable, falling back to text');
      } catch (err) {
        logger.warn('Teams: voice reply synthesis error, falling back to text', { err: err.message });
      }
    }
    await replyToTeams(activity, text);
    await saveTurn(sessionId, 'assistant', text).catch(err =>
      logger.warn('Teams: saveTurn (assistant) failed', { err: err.message })
    );
  }

  // Check whether this message from Michael is a reply to a pending employee
  // approval request (see tools/impl/privacy-gate.js) BEFORE normal intent
  // routing — a fast no-op (one Supabase count query) when nothing is
  // pending, which is the overwhelming majority of his messages. Only
  // short-circuits when there's a real pending request AND the message reads
  // as a yes/no/"remember this" decision; anything else falls through to the
  // normal flow below unchanged.
  try {
    const { resolvePendingApprovalReply } = await import('../tools/impl/privacy-gate.js');
    const approvalResult = await resolvePendingApprovalReply(userText);
    if (approvalResult) {
      await remember(approvalResult.replyToMichael);
      return;
    }
  } catch (err) {
    logger.warn('Teams: resolvePendingApprovalReply check failed (non-fatal)', { err: err.message });
  }

  // A Claude Code escalation (tools/impl/claude-code-escalation.js) no
  // longer has a pending yes/no state to check for here -- rebuilt
  // 2026-09-03 to start immediately instead of waiting on a Teams
  // approval reply (see that file's own header for why). There is
  // nothing left for a "resolvePendingEscalationReply"-shaped check to do.

  // A reply to a pending code/repo/infra-write approval (see
  // tools/impl/code-approval.js). Deliberately NOT run through
  // isApprovalReply/runAgent like the two checks above -- confirmation here
  // requires the exact 8-character code from the original request ("confirm
  // a1b2c3d4", matching row.id.slice(0,8) exactly, never a shorter prefix --
  // findPendingApproval also refuses an ambiguous partial match, but
  // requiring the full code here is the first line of defense against
  // acting on the wrong pending action), matched deterministically against
  // the pending row, so execution can never be triggered by the model
  // inferring "the user seems to be agreeing" from free-form text. Handles
  // both this session's own pending action and a voice-originated one
  // (Michael confirming from Teams what he asked for on a call) --
  // code-approval.js's rows aren't scoped to a single sessionId lookup
  // here, the code itself is the key.
  const confirmMatch = /^\s*confirm\s+([a-f0-9]{8})\b/i.exec(userText);
  const denyMatch = !confirmMatch && /^\s*(?:deny|cancel)\s+([a-f0-9]{8})\b/i.exec(userText);
  if (confirmMatch || denyMatch) {
    const code = (confirmMatch ?? denyMatch)[1];
    try {
      const { findPendingApproval, executeApprovedAction, denyPendingApproval } = await import('../tools/impl/code-approval.js');
      const pending = await findPendingApproval(code);
      if (!pending) {
        await remember(`No pending confirmation found for code "${code}" — it may have already run, been denied, or expired.`);
        return;
      }
      if (denyMatch) {
        await denyPendingApproval(pending);
        await remember(`Denied — won't run: ${pending.description}`);
        return;
      }
      await remember(`Confirmed — running now: ${pending.description}`);
      let result;
      try {
        result = await executeApprovedAction(pending);
      } catch (err) {
        await remember(`That failed: ${err.message}`);
        return;
      }
      const resultText = typeof result === 'string' ? result : JSON.stringify(result);
      await remember(`✅ Done: ${pending.description}\n\n${resultText.slice(0, 1500)}`);
    } catch (err) {
      logger.error('Teams: confirm/deny-code-action handling failed', { err: err.message });
      await remember("Something went wrong handling that — check the logs.");
    }
    return;
  }

  let intent = classifyIntent(userText);
  // The regex router only reaches 'general' when nothing else confidently
  // matched -- a cheap one-shot Haiku re-classification here catches
  // phrasings the fixed keyword list didn't anticipate (e.g. "check three
  // systems and cross-reference X") without adding any latency to the large
  // majority of messages that DO match a regex directly. See router.js's
  // classifyIntentLLM comment for the full rationale.
  if (intent === 'general') {
    intent = await classifyIntentLLM(userText).catch(() => 'general');
  }
  logger.info('Teams message', { intent, text: userText.slice(0, 80) });

  // Track what we're about to run so the catch block can queue a retry if SA is blocked
  let retryTask = userText;
  let retryTaskType = 'general';
  let retrySystemPrompt = null;

  try {
    let result;

    if (intent === 'scheduling') {
      // Uses the scheduling system prompt keyed to this Teams conversation so
      // draft state persists across multiple messages in the same conversation.
      let rulesBlock = '';
      try {
        const ctx = await buildContextBlock('scheduling');
        if (ctx) rulesBlock = `\n\n${ctx}`;
      } catch (e) { logger.warn('Could not load scheduling rules', { err: e.message }); }

      let draftContext = '';
      try {
        const { getScheduleDraft } = await import('../tools/impl/scheduling.js');
        const draft = await getScheduleDraft({ session_id: sessionId });
        if (draft) {
          const preview = JSON.stringify(draft.schedule_data, null, 2).slice(0, 2000);
          draftContext = `\n\n## Current Draft (ID: ${draft.id})\nDirective: ${draft.directive}\nWeek: ${draft.week_start || 'TBD'}\n\n${preview}`;
        }
      } catch (e) { logger.warn('Could not load draft context', { err: e.message }); }

      const memoryBlock = await loadSchedulingMemory();
      const systemPrompt = buildSchedulingSystemPrompt(sessionId, null, draftContext, rulesBlock, memoryBlock);
      retryTaskType = 'scheduling';
      retrySystemPrompt = systemPrompt;
      // Deliberately not passed here: scheduling already gets its own
      // session-keyed continuity via draftContext/rulesBlock/memoryBlock
      // above. Mixing in raw cross-intent turns (e.g. an earlier CRM or dev
      // exchange in the same Teams conversation) would just add noise the
      // model could mistake for scheduling-relevant instructions.
      ({ result } = await runAgent({ task: userText, taskType: 'scheduling', systemPromptOverride: systemPrompt, saveContext: true, images, context: { sender, activity, sessionId, taskType: retryTaskType } }));

    } else if (intent === 'calendar') {
      // Added 2026-08-25 -- see teams/router.js's isCalendarRescheduleRequest
      // and tools/impl/block-schedule-reconciler.js's
      // resolveCalendarConflictBySubject for the incident this fixes.
      // extraMessages included (unlike scheduling's own branch) since this is
      // an ordinary multi-turn back-and-forth over a Teams conversation, not
      // a flow with its own session-keyed draft/rules context.
      const calendarTask = `You received a Teams message from Michael about calendar rescheduling. Message: "${userText}"

- If he's asking to prioritize a real meeting/event over one or more President Weekly Block Schedule blocks (e.g. "prioritize X over the client meeting block", "move my BTA meeting's conflicts"): use resolve_calendar_conflict with the real event's subject and date. It automatically finds every block overlapping that event and resolves it (shrink/split/delete) in favor of the real event. Do NOT read calendar events yourself and ask Michael to manually pick new slots for the displaced blocks -- that is exactly what this tool already does.
- If resolve_calendar_conflict reports the event wasn't found or matched more than one event, relay its message back to Michael and ask him to clarify -- don't guess which event he meant.
- For anything else calendar-related (reading a day's schedule, creating a new event, or directly updating/deleting one specific event by name), use your calendar tools directly.
- Always confirm what actually happened: which blocks were shrunk, split, deleted, or kept, and any that were skipped as an intentional exemption.`;
      retryTask = calendarTask; retryTaskType = 'calendar';
      ({ result } = await runAgent({ task: calendarTask, taskType: 'calendar', extraMessages, saveContext: false, images, context: { sender, activity, sessionId, taskType: retryTaskType } }));

    } else if (intent === 'crm') {
      const crmTask = `You received a Teams message from Michael. Execute the action he is requesting using your SA, CRM, and CardDAV tools.

Message: "${userText}"

- If this is a forwarded contact form or new customer inquiry: search SA for the client, create if not found, add a ticket.
- If Michael asks to create a ticket, estimate, job, or SA record: do it now.
- If Michael asks to look up a client, invoice, or balance: do it and report back.
- If Michael asks to provision CardDAV for an employee: use carddav_provision with their email and name. Return the server URL, username, and token with iOS/Android setup instructions.
- If Michael asks to revoke CardDAV for an employee: use carddav_revoke with their email.
- If Michael asks to list CardDAV credentials: use carddav_list.
- If Michael asks to schedule/book an estimate visit with a client: use schedule_estimate_visit. If it comes back needs_clarification, ask him which client he means instead of guessing.
- Always confirm what you did: client name, SA IDs, actions taken.`;
      retryTask = crmTask; retryTaskType = 'crm';
      ({ result } = await runAgent({ task: crmTask, taskType: 'crm', extraMessages, saveContext: false, images, context: { sender, activity, sessionId, taskType: retryTaskType } }));

    } else if (intent === 'ops_alert') {
      // A system/watchdog alert was posted or pasted into live chat (see
      // teams/router.js's isOpsAlertLike). Run the same investigate-and-fix
      // workflow as scheduler/cron.js's unattended self_heal_watcher, but
      // attended — Michael is in this conversation, so unlike auto_fix's
      // cron-triggered runs there's no need for a hardcoded suppressSelfHeal
      // Teams send here; the normal remember(result) below reports back.
      // Sanitized + tag-wrapped the same way notify.js's enqueueSelfHeal does
      // before it reaches cron.js's prompt, even though this text usually
      // comes from Michael directly (not aggregated third-party data) —
      // pasted/forwarded alert text can still carry an embedded API error
      // body or similar external content worth treating as data, not
      // instructions. extraMessages (raw prior turns) is deliberately NOT
      // passed here, unlike the crm/dev branches — those turns were never
      // run through sanitizeForPrompt, so mixing them into a taskType with
      // file-edit/branch/PR tools would hand auto_fix unprotected content
      // with equal standing to the hardened current-turn text above. Same
      // reasoning the scheduling branch already uses to skip extraMessages,
      // just for a trust-boundary reason here instead of a noise reason.
      const safeAlertText = sanitizeForPrompt(userText);
      const opsAlertTask = buildAutoFixPrompt(safeAlertText, 'live-chat');
      retryTask = opsAlertTask; retryTaskType = 'auto_fix';
      ({ result } = await runAgent({ task: opsAlertTask, taskType: 'auto_fix', saveContext: false, images }));

    } else if (intent === 'dev') {
      const devTask = `Michael sent this Teams message:\n\n"${userText}"\n\nFollow the github-dev skill workflow. Reply with a scope proposal:\n- Restate the goal in 2-3 sentences\n- List the files that will be created or changed\n- Identify which repo this belongs in\n- State any assumptions\n- Ask Michael to confirm before you proceed\n\nDo not write any code yet. Return only the reply text.`;
      retryTask = devTask; retryTaskType = 'code';
      ({ result } = await runAgent({ task: devTask, taskType: 'code', extraMessages, saveContext: false, images, context: { sender, activity, sessionId, taskType: retryTaskType } }));

    } else if (intent === 'dev_ambiguous') {
      // Was a fully hardcoded canned string with no LLM call at all -- now
      // runs through runAgent() so the clarifying question is contextual
      // (and has memory/conversation history via extraMessages) instead of
      // static, while keeping the actual safety property intact: taskType
      // 'dev_ambiguous' (tools/registry.js) deliberately has NO code/file/
      // github/deploy tools, so the model literally cannot start real dev
      // work off an ambiguous request -- it can only ask.
      const ambiguousTask = `Michael sent this Teams message, which may or may not be a request to build/write code, a script, or deploy something:\n\n"${userText}"\n\nYou do NOT have code/file/deployment/GitHub tools available for this response on purpose -- do not attempt any dev work now. Ask ONE brief, context-aware clarifying question to find out whether he wants you to build/write something (he'll confirm and you'll scope it out fully next message) or whether he's just asking for information/advice about the topic. Tailor the question to what he actually asked -- 1-2 sentences, no generic canned phrasing. Do not ask which channel/medium a piece of content came from or should apply to (e.g. "is this about Teams or email?") when that's already obvious from context -- this message is itself a Teams message, and if he's reacting to something you sent him (a report, an alert, an earlier reply), the channel is whichever one that content just appeared in. Only ask about channel/medium if his message genuinely could mean either and nothing in this conversation settles it.`;
      retryTask = ambiguousTask; retryTaskType = 'dev_ambiguous';
      ({ result } = await runAgent({ task: ambiguousTask, taskType: 'dev_ambiguous', extraMessages, saveContext: false, images, context: { sender, activity, sessionId, taskType: retryTaskType } }));

    } else if (intent === 'report') {
      retryTaskType = 'report';
      ({ result } = await runAgent({ task: userText, taskType: 'report', extraMessages, saveContext: false, images, context: { sender, activity, sessionId, taskType: retryTaskType } }));

    } else {
      ({ result } = await runAgent({ task: userText, taskType: 'general', extraMessages, images, context: { sender, activity, sessionId, taskType: retryTaskType } }));
    }

    // Dispatcher catches tool-level errors — runAgent won't throw on SA blocks.
    // Check the backoff timer directly to detect if SA was blocked mid-run.
    // auto_fix's tool set (registry.js TOOL_MAP) never includes SA tools, so
    // it structurally cannot have been the thing blocked — treat it as never
    // backed off. Without this, a stale/unrelated SA backoff (possibly from
    // the very outage this ops_alert investigation was reporting on) would
    // discard an already-completed result — which may include an opened PR —
    // and tell Michael it's "queued for retry," a false status that hides
    // finished work and would trigger a fully redundant second run later.
    const { getSABackoffUntil } = await import('../tools/impl/serviceautopilot.js');
    const backoffUntil = retryTaskType === 'auto_fix' ? 0 : getSABackoffUntil();
    if (backoffUntil > Date.now()) {
      const runAfter = new Date(backoffUntil).toISOString();
      const remainingMin = Math.ceil((backoffUntil - Date.now()) / 60000);
      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/agent_tasks`, {
          method: 'POST',
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ task: retryTask, task_type: retryTaskType, status: 'pending', run_after: runAfter, notify_teams: true, retry_count: 0, session_id: sessionId, ...(retryTaskType === 'scheduling' ? {} : { extra_messages: extraMessages }), ...(retrySystemPrompt ? { system_prompt_override: retrySystemPrompt } : {}) }),
        });
        await remember(`SA is temporarily rate-limited by bot protection. I've queued this task and will retry automatically in ~${remainingMin} min — I'll notify you here when it completes.`);
      } catch (queueErr) {
        logger.error('Teams handler: failed to queue SA retry task', { err: queueErr.message });
        await remember(result);
      }
    } else {
      await remember(result, { voiceReply: wantsVoiceReply });
    }
  } catch (err) {
    logger.error('Teams handler error', { err: err.message });
    await remember(`Error: ${err.message}`);
  }
}

// The default system prompt (core/agent.js's buildSystemPrompt) frames the
// agent as Michael's own assistant with no notion it might be talking to
// someone else — confirmed live 2026-08-24 that leaving it in place here
// would rely ENTIRELY on request_employee_approval's own tool description to
// keep the model from just answering a private question out of its own
// general/contextual knowledge. That's not a reliable enough boundary on its
// own (the hard boundary is EMPLOYEE_TOOLS' absence of any real data tool —
// this prompt is the soft layer telling the model what to do given that
// constraint, not a substitute for it).
function buildEmployeeSystemPrompt(senderName) {
  // Confirmed live 2026-08-24: an earlier version of this prompt omitted real
  // company facts entirely (systemPromptOverride REPLACES the default prompt,
  // it doesn't add to it) — asked "what services does JRB offer," the model
  // hallucinated "real estate services" out of nowhere rather than admit it
  // didn't know. Include the same real facts core/agent.js's default prompt
  // already has, so a genuinely-generic answer is actually correct instead of
  // confidently wrong.
  return `You are the AI assistant for J.R. Boehlke, LLC, an asphalt, concrete, landscape, and snow contractor in southeast Wisconsin and metro Milwaukee. Main phone: 262-242-9924.

You are currently messaged by ${senderName || 'an employee'} — NOT Michael Reardon, the business owner. This is a different conversation than your normal one with Michael.

Michael's explicit standing rule: his inbox, calendar, personal information, and business data are only ever shared with him directly. You must never answer, guess at, or reveal any of that to anyone else, including this requester.

- If the request is genuinely generic/public information you actually know (e.g. company hours, phone number, what services JRB offers) — answer it directly and briefly, using only real facts, never a guess.
- If it's generic but you don't actually know the answer (e.g. a specific policy detail) — say so plainly rather than guessing.
- For ANYTHING else — Michael's schedule or availability, his inbox, financials, client/business specifics, or any judgment call — call request_employee_approval instead. Do not explain why in your own words, do not apologize at length, do not try to be helpful by guessing at an answer. Just call the tool.
- Never confirm or deny that specific private information exists, even indirectly.

Current date/time: ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })}`;
}

// ── Non-Michael Teams requester path ─────────────────────────────────────────
// Added 2026-08-24. Completely separate from processTeamsMessage above — no
// scheduling/crm/dev/report intent routing, no SA-backoff retry queue, no
// extraMessages from Michael's own conversation history. Structurally
// restricted to taskType 'employee' (see tools/registry.js's TOOL_MAP), which
// simply doesn't include any tool capable of returning Michael's mailbox,
// calendar, SA/QB, file, or code data — the model in this path cannot fetch
// that data no matter what it's asked, only tools/impl/privacy-gate.js's
// request_employee_approval (or, once Phase B lands, book_time_with_michael)
// are available.
async function handleEmployeeMessage(activity, sender, sessionId, userText) {
  saveEmployeeConversationRef(sender.aadId, activity);

  await saveTurn(sessionId, 'user', userText).catch(err =>
    logger.warn('Teams (employee): saveTurn (user) failed', { err: err.message })
  );

  async function reply(text) {
    await replyToTeams(activity, text);
    await saveTurn(sessionId, 'assistant', text).catch(err =>
      logger.warn('Teams (employee): saveTurn (assistant) failed', { err: err.message })
    );
  }

  try {
    const { checkStandingException } = await import('../tools/impl/privacy-gate.js');
    const exception = await checkStandingException(sender.aadId, userText).catch(err => {
      logger.warn('Teams (employee): checkStandingException failed (non-fatal)', { err: err.message });
      return null;
    });

    if (exception) {
      // Michael already pre-approved this KIND of request going forward —
      // answer it directly with full tools, same authorization logic as a
      // fresh one-time approval, just without pinging him again first.
      logger.info('Teams (employee): standing exception matched', { requester: sender.name, exceptionId: exception.id });
      const { result } = await runAgent({ task: userText, taskType: 'general', saveContext: false });
      await reply(result);
      return;
    }

    const { result } = await runAgent({
      task: userText,
      taskType: 'employee',
      systemPromptOverride: buildEmployeeSystemPrompt(sender.name),
      saveContext: false,
      context: { sender, activity, requestText: userText },
    });
    await reply(result);
  } catch (err) {
    logger.error('Teams (employee) handler error', { requester: sender.name, err: err.message });
    await reply("Sorry, something went wrong on my end — I've flagged it. Please try again in a bit.");
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
  let decisionsBlock = '';
  try {
    const { getScheduleDraft } = await import('../tools/impl/scheduling.js');
    const draft = await getScheduleDraft({ session_id: sessionId });
    if (draft) {
      if (Array.isArray(draft.session_notes) && draft.session_notes.length > 0) {
        decisionsBlock = `\n## CONFIRMED DECISIONS THIS SESSION — DO NOT RE-ASK\n` +
          draft.session_notes.map(n => `- ${n}`).join('\n') +
          `\n\nThese are already confirmed. Act on them directly without asking again.\n`;
      }
      const hasData = draft.schedule_data && Object.keys(draft.schedule_data).length > 0;
      if (hasData) {
        const preview = JSON.stringify(draft.schedule_data, null, 2).slice(0, 2000);
        draftContext = `\n\n## Current Draft (ID: ${draft.id})\nDirective: ${draft.directive}\nWeek: ${draft.week_start || 'TBD'}\n\n${preview}`;
      }
    }
  } catch (e) {
    logger.warn('Could not load draft context', { err: e.message });
  }

  const memoryBlock = await loadSchedulingMemory();
  const systemPrompt = buildSchedulingSystemPrompt(sessionId, weekStart, draftContext, rulesBlock, memoryBlock, decisionsBlock);

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

  // FieldOps Refresh button — sync SA waiting list via puppeteer session
  if (req.method === 'POST' && url === '/sync-waiting-list') {
    const auth = req.headers['x-execute-secret'];
    if (!EXECUTE_SECRET || auth !== EXECUTE_SECRET) { res.writeHead(401); res.end('Unauthorized'); return; }
    try {
      const { syncWaitingList } = await import('../tools/impl/serviceautopilot.js');
      const result = await syncWaitingList();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      // Fire-and-forget: fill pavement_sf for any new PMM clients added this sync
      import('../tools/impl/scheduling.js')
        .then(({ syncPavementSizes }) => syncPavementSizes({ force: false }))
        .then(r => logger.info('pavement SF sync complete', r))
        .catch(e => logger.warn('pavement SF sync failed', { err: e?.message ?? String(e) }));
    } catch (err) {
      logger.error('sync-waiting-list error', { err: err.message });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // FieldOps — sync pavement SF from SA custom fields into Supabase
  if (req.method === 'POST' && url === '/sync-pavement-sizes') {
    const auth = req.headers['x-execute-secret'];
    if (!EXECUTE_SECRET || auth !== EXECUTE_SECRET) { res.writeHead(401); res.end('Unauthorized'); return; }
    let body = '';
    req.on('data', d => body += d);
    await new Promise(r => req.on('end', r));
    const force = (() => { try { return JSON.parse(body).force === true; } catch { return false; } })();
    try {
      const { syncPavementSizes } = await import('../tools/impl/scheduling.js');
      const result = await syncPavementSizes({ force });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      logger.error('sync-pavement-sizes error', { err: err.message });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // FieldOps — list SA resources (crews) for dispatch assignment
  if (req.method === 'GET' && url === '/sa-resources') {
    const auth = req.headers['x-execute-secret'];
    if (!EXECUTE_SECRET || auth !== EXECUTE_SECRET) { res.writeHead(401); res.end('Unauthorized'); return; }
    try {
      const { listSAResources } = await import('../tools/impl/serviceautopilot.js');
      const resources = await listSAResources();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resources));
    } catch (err) {
      logger.error('sa-resources error', { err: err.message });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // FieldOps — dispatch a waiting list job to a date + crew in SA
  if (req.method === 'POST' && url === '/dispatch-job') {
    const auth = req.headers['x-execute-secret'];
    if (!EXECUTE_SECRET || auth !== EXECUTE_SECRET) { res.writeHead(401); res.end('Unauthorized'); return; }
    let body = '';
    req.on('data', d => body += d);
    await new Promise(r => req.on('end', r));
    try {
      const { wlItemId, scheduleDate, resourceId } = JSON.parse(body);
      if (!wlItemId || !scheduleDate || !resourceId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'wlItemId, scheduleDate, resourceId required' }));
        return;
      }
      const { dispatchWaitingListJob } = await import('../tools/impl/serviceautopilot.js');
      const result = await dispatchWaitingListJob({ wlItemId, scheduleDate, resourceId });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      logger.error('dispatch-job error', { err: err.message });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Expense capture endpoints ─────────────────────────────────

  // QBO webhook verification challenge — Intuit sends GET with verificationToken query param
  if (req.method === 'GET' && url.startsWith('/qbo-webhook')) {
    const vt = new URL(req.url, 'https://agent.jrboehlke.com').searchParams.get('verificationToken');
    if (vt) {
      logger.info('QBO webhook: verification challenge received', { tokenLength: vt.length });
      res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(vt);
    } else {
      res.writeHead(200); res.end('OK');
    }
    return;
  }

  // QBO webhook — fires when a new Purchase entity is created
  if (req.method === 'POST' && url === '/qbo-webhook') {
    logger.info('QBO webhook: incoming POST', {
      contentLength: req.headers['content-length'] ?? 'unknown',
      sigPresent: !!req.headers['intuit-signature'],
    });
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

  // GET /maintenance-log-data?log=<uuid> — returns pre-filled log data for the portal
  if (req.method === 'GET' && url.startsWith('/maintenance-log-data')) {
    const logId = new URL(req.url, 'https://agent.jrboehlke.com').searchParams.get('log');
    if (!logId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'log required' })); return; }
    const { getMaintenanceLogData } = await import('../tools/impl/expense.js');
    const data = await getMaintenanceLogData(logId);
    if (!data) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  // POST /maintenance-log-complete — marks the maintenance log done and expense report complete
  if (req.method === 'POST' && url === '/maintenance-log-complete') {
    let body = '';
    req.on('data', d => body += d);
    await new Promise(r => req.on('end', r));
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' })); return;
    }
    const { log_id } = parsed;
    if (!log_id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'log_id required' })); return; }
    const { completeMaintenanceLog } = await import('../tools/impl/expense.js');
    const result = await completeMaintenanceLog(log_id);
    res.writeHead(result.error ? 400 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // POST /enroll — SMS double opt-in enrollment from FieldOps form
  if (req.method === 'POST' && url === '/enroll') {
    let body = '';
    req.on('data', d => body += d);
    await new Promise(r => req.on('end', r));
    const ct = req.headers['content-type'] || '';
    let parsed;
    if (ct.includes('application/json')) {
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' })); return;
      }
    } else {
      const p = new URLSearchParams(body);
      parsed = { phone: p.get('phone'), name: p.get('name') };
    }
    const { phone, name } = parsed;
    if (!phone) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'phone is required' })); return;
    }
    try {
      const { enrollPhone } = await import('../tools/impl/sms-enrollment.js');
      const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
      await enrollPhone(phone, name, ip, req.headers['user-agent']);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      logger.error('Enroll error', { err: err.message });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /sms-webhook — Twilio inbound SMS (YES/STOP/HELP responses)
  if (req.method === 'POST' && url === '/sms-webhook') {
    let body = '';
    req.on('data', d => body += d);
    await new Promise(r => req.on('end', r));

    const params = Object.fromEntries(new URLSearchParams(body));
    const fromPhone = params.From;
    const messageBody = params.Body;

    // Validate Twilio request signature
    const sig = req.headers['x-twilio-signature'];
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (sig && authToken) {
      const { default: twilioLib } = await import('twilio');
      const valid = twilioLib.validateRequest(authToken, sig, 'https://agent.jrboehlke.com/sms-webhook', params);
      if (!valid) {
        logger.warn('SMS webhook: invalid Twilio signature');
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden'); return;
      }
    }

    try {
      const { handleInboundSms } = await import('../tools/impl/sms-enrollment.js');
      const reply = await handleInboundSms(fromPhone, messageBody);
      const escaped = reply
        ? reply.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        : null;
      const twiml = escaped
        ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`
        : '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(twiml);
    } catch (err) {
      logger.error('SMS webhook error', { err: err.message });
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }
    return;
  }

  // Health check
  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', mcp: mcpHandler ? 'loaded' : 'not loaded', ts: new Date().toISOString() }));
    return;
  }

  // ── Google Ads scheduler health check — proxy to Python webhook server ──────
  // Reachable externally at agent.jrboehlke.com/ads-health specifically so a
  // session-independent monitor can catch the whole local daemon stack being
  // down (unlike the local Task Scheduler watchdogs, which require an active
  // Windows logon and share that blind spot with the Google Ads Agent task itself).
  if (req.method === 'GET' && url === '/ads-health') {
    try {
      const proxyRes = await fetch('http://localhost:8765/health');
      const respBody = await proxyRes.arrayBuffer();
      res.writeHead(proxyRes.status, {
        'Content-Type': proxyRes.headers.get('content-type') || 'application/json',
      });
      res.end(Buffer.from(respBody));
    } catch (err) {
      logger.warn('Ads health proxy failed', { err: err.message });
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'unreachable', error: err.message }));
    }
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
  // GET /qb-reauth?secret=<EXECUTE_SECRET>&company=<jrb|transport>
  //   → redirects to Intuit auth page so Michael can (re)connect a QB company.
  //   `company` defaults to 'jrb'; pass company=transport to authorize JRB
  //   Transport LLC as a second, independently-tokened QBO connection.
  // GET /qb-callback?code=<code>&realmId=<id>&state=<company>:<...>
  //   → exchanges auth code, saves new refresh token + realm ID, done
  if (req.method === 'GET' && url.startsWith('/qb-reauth')) {
    const params = new URL(req.url, 'https://agent.jrboehlke.com').searchParams;
    const secret = params.get('secret');
    if (secret !== process.env.CLAUDE_EXECUTE_SECRET) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized'); return;
    }
    const company = params.get('company') || 'jrb';
    try {
      const { buildQBAuthUrl } = await import('../tools/impl/qb-token.js');
      const authUrl = buildQBAuthUrl(company, 'reauth-' + Date.now());
      res.writeHead(302, { Location: authUrl });
      res.end();
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(`QB reauth failed: ${err.message}`);
    }
    return;
  }

  if (req.method === 'GET' && url.startsWith('/qb-callback')) {
    const params = new URL(req.url, 'https://agent.jrboehlke.com').searchParams;
    const code = params.get('code');
    const realmId = params.get('realmId');
    if (!code) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Missing code'); return; }

    try {
      const { exchangeQBAuthCode, parseQBAuthState } = await import('../tools/impl/qb-token.js');
      const company = parseQBAuthState(params.get('state'));
      await exchangeQBAuthCode(code, company, realmId);
      logger.info('QB: re-auth complete', { company, realmId });
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:monospace;background:#0a0a0a;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:#111;border:1px solid #333;border-radius:8px;padding:32px 40px;max-width:420px;text-align:center}
h2{color:#00cc66;margin-bottom:12px}p{color:#888;font-size:13px}</style></head>
<body><div class="box"><h2>QuickBooks Connected (${company})</h2>
<p>New refresh token saved. QBO queries for this company will work immediately.</p></div></body></html>`);
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

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`Teams bot: port ${PORT} already in use — another instance is running. Exiting.`, { code: err.code });
  } else {
    logger.error('Teams bot server error', { err: err.message, code: err.code });
  }
  process.exit(1);
});

server.listen(PORT, () => {
  logger.info(`Teams bot listening on port ${PORT}`);
});
