// core/logger.js — Structured logger with token usage tracking
import winston from 'winston';
import { createClient } from '@supabase/supabase-js';

const { combine, timestamp, printf, colorize } = winston.format;

const fmt = printf(({ level, message, timestamp, ...meta }) => {
  const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  return `${timestamp} [${level}] ${message}${extra}`;
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), colorize(), fmt),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: 'logs/agent.log',
      format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), fmt),
      maxsize: 5_000_000,
      maxFiles: 5,
    }),
  ],
});

// ── Token usage tracker ──────────────────────────────────────
// Persists cumulative token usage to Supabase so you can
// monitor spend across sessions without relying on ephemeral memory.

let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) {
      throw new Error(
        'Supabase configuration is missing: ' +
        (!url && !key
          ? 'SUPABASE_URL and SUPABASE_SERVICE_KEY are not set'
          : !url
          ? 'SUPABASE_URL is not set'
          : 'SUPABASE_SERVICE_KEY is not set') +
        '. Token logging is unavailable.'
      );
    }
    _supabase = createClient(url, key);
  }
  return _supabase;
}

/**
 * Log a Claude API call's token usage.
 * @param {object} opts
 * @param {string} opts.task      - Task name/type
 * @param {string} opts.model     - e.g. 'claude-haiku-4-5' or 'claude-sonnet-4-6'
 * @param {number} opts.input     - Input tokens used
 * @param {number} opts.output    - Output tokens used
 * @param {string} [opts.runId]   - Optional run/session ID
 */
export async function trackTokens({ task, model, input, output, runId }) {
  const total = input + output;
  logger.info(`Tokens: ${total} (in:${input} out:${output})`, { task, model, runId });

  try {
    await getSupabase().from('agent_token_log').insert({
      task,
      model,
      input_tokens: input,
      output_tokens: output,
      total_tokens: total,
      run_id: runId || null,
    });
  } catch (err) {
    // Non-fatal — don't crash the agent over logging
    logger.warn('Failed to persist token log', { err: err.message });
  }
}
