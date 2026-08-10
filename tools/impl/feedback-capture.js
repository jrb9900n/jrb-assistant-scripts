// tools/impl/feedback-capture.js
// Detects feedback/instructions from Michael and saves them to two places:
//   1. Supabase `rules` table — injected into every agent system prompt via buildContextBlock()
//   2. Claude Code memory file — persists across Claude Code sessions
//
// Called from:
//   - teams/bot.js on every Teams message before intent routing
//   - scheduler/cron.js email_poller on every email from michael@

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { logger } from '../../core/logger.js';

const HAIKU = 'claude-haiku-4-5-20251001';

// Claude Code memory file — shared with Claude Code sessions
const MEMORY_FILE = 'C:/Users/Assistant/.claude/projects/C--Users-Assistant/memory/feedback-runtime-rules.md';

function supabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// ── Quick heuristic — synchronous, no LLM cost ────────────────────────────────
// Returns true if the message MIGHT contain a standing rule or correction.
// Designed to over-detect (low false-negative rate) — the LLM filters further.

const FEEDBACK_PATTERNS = [
  /\b(don't|do not|never|always|stop|from now on|going forward|in the future|next time)\b/i,
  /\b(remember to|make sure (you|to)|make sure that)\b/i,
  /\b(you should(n't)?|you must|you need to|you are not|you cannot|you can't)\b/i,
  /\b(that('s| is) (wrong|incorrect|not right)|you (got|were) wrong|incorrect)\b/i,
  /\b(as a rule|standing rule|standing instruction|general rule)\b/i,
  /\b(for all (future|future requests|emails|replies|messages))\b/i,
  /\b(i want you to|i need you to|i'd like you to)\b.*\b(always|never|every|each|all)\b/i,
];

// If message primarily looks like a direct task, don't classify as feedback
const TASK_ONLY_PATTERNS = [
  /^(can you|please|could you|would you|go ahead and)\b/i,
  /^(check|run|pull|send|create|add|delete|update|show|list|find|get|build|fix)\b/i,
];

export function mightBeFeedback(text) {
  const t = text.trim();
  if (t.length < 10) return false;
  // If it matches a task-only opener and has no feedback signal, skip
  const hasTaskOpener = TASK_ONLY_PATTERNS.some(p => p.test(t));
  const hasFeedbackSignal = FEEDBACK_PATTERNS.some(p => p.test(t));
  if (hasTaskOpener && !hasFeedbackSignal) return false;
  return hasFeedbackSignal;
}

// ── LLM extraction ────────────────────────────────────────────────────────────
// Returns null if the message isn't actually feedback, or a structured rule if it is.

const EXTRACT_SYSTEM = `You extract standing rules and instructions from messages sent by Michael Reardon to his AI assistant.

A "rule" is a standing instruction that should apply to ALL future interactions — not a one-time task or question.

Examples of rules:
  "Don't send confirmation emails after approvals" → rule
  "Always sign emails as Michael, not the assistant" → rule
  "Never create duplicate SA clients without checking first" → rule
  "From now on, send reports on Monday not Sunday" → rule

Examples of NON-rules (one-time tasks):
  "Can you check my inbox?" → NOT a rule
  "Send Dave a reminder today" → NOT a rule
  "What's the weather?" → NOT a rule

Return JSON: { "is_rule": boolean, "rule": "clean actionable statement or empty string", "agent": "general" | "email" | "crm" | "scheduling" | "reporting" }

If is_rule is false, rule must be "". Agent is which part of the system the rule applies to; use "general" if unclear.`;

async function extractRule(text) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const resp = await anthropic.messages.create({
    model: HAIKU,
    max_tokens: 256,
    system: EXTRACT_SYSTEM,
    messages: [{ role: 'user', content: text }],
  });
  const raw = resp.content[0]?.text ?? '{}';
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    if (!parsed.is_rule || !parsed.rule) return null;
    return { rule: parsed.rule, agent: parsed.agent ?? 'general' };
  } catch {
    return null;
  }
}

// ── Save to Supabase rules table ──────────────────────────────────────────────

async function saveToRules(rule, agent, source) {
  const { error } = await supabase().from('rules').insert({
    agent,
    rule,
    source: source ?? 'michael_feedback',
  });
  if (error) logger.warn('feedback-capture: rules insert error', { error: error.message });
  else logger.info('feedback-capture: rule saved to Supabase', { agent, rule: rule.slice(0, 80) });
}

// ── Save to Claude Code memory file ──────────────────────────────────────────
// Maintains a running log file in the Claude Code memory directory.
// Claude Code reads this at session start to know what rules Michael has stated.

function saveToMemoryFile(rule, agent, source) {
  try {
    const timestamp = new Date().toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
    const entry = `- [${timestamp}] (${source}, ${agent}) ${rule}\n`;

    if (!existsSync(MEMORY_FILE)) {
      const header = `---
name: feedback-runtime-rules
description: "Standing rules and corrections Michael has given the agent at runtime via Teams or email"
metadata:
  type: feedback
---

Rules captured from Michael's Teams messages and email replies. Each entry is a standing instruction that applies to all future agent interactions.

`;
      writeFileSync(MEMORY_FILE, header + entry, 'utf8');
    } else {
      const current = readFileSync(MEMORY_FILE, 'utf8');
      writeFileSync(MEMORY_FILE, current + entry, 'utf8');
    }
    logger.info('feedback-capture: rule written to Claude Code memory', { rule: rule.slice(0, 80) });
  } catch (err) {
    logger.warn('feedback-capture: memory file write failed', { err: err.message });
  }
}

// ── Main export ───────────────────────────────────────────────────────────────
// Call this on every message from Michael before routing to the task handler.
// Returns { captured: true, rule, agent } if a rule was found and saved, or { captured: false }.

export async function detectAndCaptureFeedback(text, source = 'teams') {
  if (!mightBeFeedback(text)) return { captured: false };

  let extracted;
  try {
    extracted = await extractRule(text);
  } catch (err) {
    logger.warn('feedback-capture: LLM extraction failed', { err: err.message });
    return { captured: false };
  }

  if (!extracted) return { captured: false };

  const { rule, agent } = extracted;

  // Fire both saves concurrently — neither blocks the caller
  await Promise.allSettled([
    saveToRules(rule, agent, source),
    Promise.resolve(saveToMemoryFile(rule, agent, source)),
  ]);

  return { captured: true, rule, agent };
}
