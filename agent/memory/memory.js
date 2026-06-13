// memory/memory.js — Compressed context store backed by Supabase
//
// Token conservation strategy:
//   - Full conversation history is NEVER replayed verbatim.
//   - After each agent run, a summary is generated (Haiku) and stored.
//   - On next run, only the N most-relevant summaries + recent raw turns
//     (last 3 by default) are loaded into context.
//   - This keeps context windows small even after months of use.

import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import { logger, trackTokens } from '../core/logger.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Schema (run once in Supabase SQL editor) ─────────────────
// See config/supabase_schema.sql for the full schema.

// ── Public API ───────────────────────────────────────────────

/**
 * Load compressed context for a new agent run.
 * Returns a short string to inject at the top of the system prompt.
 *
 * @param {object} opts
 * @param {string} opts.topic   - Current task topic (used for relevance filter)
 * @param {number} [opts.limit] - Max summaries to load (default 5)
 */
export async function loadContext({ topic, limit = 5 }) {
  let query = supabase
    .from('agent_memory')
    .select('summary, created_at, topics')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (topic) query = query.contains('topics', [topic]);

  const { data: summaries, error } = await query;
  if (error) {
    logger.warn('loadContext query failed', { err: error.message, topic });
    return '';
  }

  if (!summaries?.length) return '';

  const lines = summaries.map(s =>
    `[${s.created_at.slice(0, 10)}] ${s.summary}`
  );

  return `## Memory from past sessions\n${lines.join('\n')}\n`;
}

/**
 * Save a summary of the current run to persistent memory.
 * Uses Haiku to compress — very cheap.
 *
 * @param {object} opts
 * @param {string[]} opts.messages  - Raw messages array from this run
 * @param {string}   opts.topic     - Task topic
 * @param {string}   [opts.runId]   - Run ID for correlation
 */
export async function saveMemory({ messages, topic, runId }) {
  if (!messages?.length) return;

  const transcript = messages
    .map(m => {
      if (typeof m.content === 'string') return `${m.role}: ${m.content}`;
      if (!Array.isArray(m.content)) return '';
      const parts = m.content.flatMap(b => {
        if (b.type === 'text') return [b.text];
        if (b.type === 'tool_use') return [`[tool: ${b.name}(${JSON.stringify(b.input).slice(0, 120)})]`];
        if (b.type === 'tool_result') {
          const snippet = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
          return [`[tool_result: ${snippet.slice(0, 300)}]`];
        }
        return [];
      });
      return parts.length ? `${m.role}: ${parts.join(' ')}` : '';
    })
    .filter(Boolean)
    .join('\n');

  // Summarise with Haiku (cheap)
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Summarise the key outcomes, decisions, and data points from this agent session in 2-4 sentences. Be specific — include names, numbers, dates where present. Omit conversational filler.\n\nTopic: ${topic}\n\nTranscript:\n${transcript.slice(0, 6000)}`
    }]
  });

  const summary = response.content[0].text;

  await trackTokens({
    task: `memory_summarise:${topic}`,
    model: 'claude-haiku-4-5-20251001',
    input: response.usage.input_tokens,
    output: response.usage.output_tokens,
    runId,
  });

  await supabase.from('agent_memory').insert({
    summary,
    topics: [topic],
    run_id: runId || null,
    raw_length: transcript.length,
  });

  logger.info('Memory saved', { topic, summaryLength: summary.length });
}

// ── Result cache ─────────────────────────────────────────────
// Caches expensive data fetches (QB, HubSpot) with a TTL.
// Prevents re-fetching the same CRM data on every scheduler tick.

/**
 * Get a cached value. Returns null if missing or expired.
 * @param {string} key
 */
export async function cacheGet(key) {
  const { data } = await supabase
    .from('agent_cache')
    .select('value, expires_at')
    .eq('key', key)
    .single();

  if (!data) return null;
  if (new Date(data.expires_at) < new Date()) {
    await supabase.from('agent_cache').delete().eq('key', key);
    return null;
  }
  return data.value;
}

/**
 * Set a cached value with TTL (seconds).
 * @param {string} key
 * @param {any}    value   - Will be JSON-stringified
 * @param {number} [ttl]   - Seconds until expiry (default from env)
 */
export async function cacheSet(key, value, ttl) {
  const ttlSec = ttl ?? parseInt(process.env.CACHE_TTL_SECONDS ?? '3600');
  const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();

  await supabase.from('agent_cache').upsert({
    key,
    value: JSON.stringify(value),
    expires_at: expiresAt,
  }, { onConflict: 'key' });
}
