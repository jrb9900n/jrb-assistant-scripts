// memory/conversation.js — Raw short-term conversation turn history
//
// memory.js stores Haiku-summarized long-term memory (what happened, in
// past tense, across sessions). This module is different: it stores the
// last few raw turns of a single Teams conversation so the agent doesn't
// lose the thread mid-conversation — e.g. Michael says "test that" right
// after describing a test, and the agent needs to see the message it just
// sent to know what "that" refers to. Bounded per session; old turns are
// pruned so the table doesn't grow unbounded.

import { createClient } from '@supabase/supabase-js';
import { logger } from '../core/logger.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const TURN_LIMIT = 12;        // messages loaded into context (~6 exchanges)
const KEEP_PER_SESSION = 40;  // rows retained per session before pruning

/**
 * Load recent turns for a session as an alternating user/assistant array,
 * ready to spread into runAgent's `extraMessages`. Guarantees the result
 * starts with 'user' and ends with 'assistant' (or is empty) so appending
 * the new user turn afterward never produces consecutive same-role turns.
 */
export async function loadRecentTurns(sessionId, limit = TURN_LIMIT) {
  // Ordered by the identity column rather than created_at -- id is assigned
  // monotonically per insert commit, so it stays correctly ordered even when
  // two Teams messages in the same conversation are handled concurrently and
  // their timestamps land close enough together to tie or invert.
  const { data, error } = await supabase
    .from('conversation_turns')
    .select('id, role, content')
    .eq('session_id', sessionId)
    .order('id', { ascending: false })
    .limit(limit);

  if (error) {
    logger.warn('loadRecentTurns query failed', { err: error.message, sessionId });
    return [];
  }
  if (!data?.length) return [];

  const chronological = data.reverse();

  // Merge consecutive same-role rows so the sequence strictly alternates.
  // Capped so a run of several same-role rows (e.g. multiple queued-retry
  // outcomes landing back to back with no intervening user turn) can't
  // balloon a single merged message to tens of KB.
  const MAX_MERGED_CHARS = 4000;
  const merged = [];
  for (const t of chronological) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) last.content = (last.content + '\n' + t.content).slice(-MAX_MERGED_CHARS);
    else merged.push({ role: t.role, content: t.content });
  }

  while (merged.length && merged[0].role !== 'user') merged.shift();
  // Accepted limitation: this also discards a genuinely unanswered prior
  // user turn (e.g. the process crashed between saveTurn('user', ...) and
  // the reply being saved) — trimming can't distinguish that case from the
  // far more common one it exists for: the current request's own just-saved
  // user turn racing ahead of this same request's history load. Losing an
  // unanswered turn on a mid-request crash is a narrow, low-frequency gap
  // versus the alternative of duplicating the current message into its own
  // context on every normal turn.
  while (merged.length && merged[merged.length - 1].role === 'user') merged.pop();

  return merged;
}

/**
 * Save one turn and prune older rows beyond KEEP_PER_SESSION for this
 * session. Never throws — callers should still wrap/catch since this
 * returns a rejected promise on unexpected errors from the client itself.
 */
export async function saveTurn(sessionId, role, content) {
  if (!content) return;
  const { error } = await supabase.from('conversation_turns').insert({
    session_id: sessionId,
    role,
    content: String(content).slice(0, 8000),
  });
  if (error) {
    logger.warn('saveTurn insert failed', { err: error.message, sessionId });
    return;
  }
  pruneOldTurns(sessionId).catch(err =>
    logger.warn('pruneOldTurns failed', { err: err.message, sessionId })
  );
}

async function pruneOldTurns(sessionId) {
  // Find the id of the row at rank KEEP_PER_SESSION (0-indexed) and delete
  // everything older than it in one shot -- a fixed offset/limit window
  // (e.g. range(40, 240)) would only ever clear ~200 excess rows per call,
  // leaving anything beyond that window stuck if a burst of inserts ever
  // pushed the session's row count past it faster than pruning caught up.
  const { data, error } = await supabase
    .from('conversation_turns')
    .select('id')
    .eq('session_id', sessionId)
    .order('id', { ascending: false })
    .range(KEEP_PER_SESSION, KEEP_PER_SESSION);

  if (error || !data?.length) return;
  // offset KEEP_PER_SESSION lands on the row *at* rank KEEP_PER_SESSION
  // (0-indexed) -- deleting <= that id keeps exactly KEEP_PER_SESSION rows
  // (ranks 0..KEEP_PER_SESSION-1), not KEEP_PER_SESSION+1.
  const cutoffId = data[0].id;
  await supabase.from('conversation_turns').delete().eq('session_id', sessionId).lte('id', cutoffId);
}
