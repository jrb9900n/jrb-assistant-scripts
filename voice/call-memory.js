// voice/call-memory.js — persists voice call transcripts and gives calls
// (and Teams) shared memory of each other.
//
// Two distinct things happen on every call that said anything post-PIN:
//   1. The full raw transcript is written to voice_call_log (permanent, not
//      pruned) -- a call-log/audit record, not a context-loading mechanism.
//   2. A Haiku summary of the same transcript is saved via memory.js's
//      existing saveMemory(), tagged topic 'voice_call'. That's the SAME
//      agent_memory table Teams already reads via loadContext() with
//      strict:false (loads the N most recent summaries regardless of which
//      taskType/topic saved them) -- so a voice call's outcome becomes
//      visible to a later Teams conversation for free, and a later voice
//      call sees both its own call history AND anything discussed on Teams.
//      This file doesn't build a separate cross-channel memory system; it
//      plugs into the one that already exists.
import { createClient } from '@supabase/supabase-js';
import { logger } from '../core/logger.js';
import { loadContext, saveMemory } from '../memory/memory.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/**
 * Recent cross-channel context to prepend to a freshly-PIN-verified call's
 * system prompt. Deliberately non-strict (topic: 'voice_call' is just this
 * call's own save-topic, not a filter) -- see loadContext()'s own rationale
 * in memory.js for why Michael's memory shouldn't be siloed by which
 * channel/taskType wrote it.
 */
export async function loadRecentCallContext() {
  return loadContext({ topic: 'voice_call', strict: false, limit: 5 });
}

/**
 * Call once per hung-up call, after the caller passed the PIN gate and said
 * at least one thing. No-ops silently on an empty transcript (PIN-only
 * calls, wrong numbers, hangups mid-greeting) -- nothing worth logging or
 * summarizing.
 */
export async function finalizeCallMemory(session) {
  if (!session?.transcript?.length) return;
  const { callConnectionId, fromNumber, transcript, startedAt, toolCalls } = session;

  const { error } = await supabase.from('voice_call_log').insert({
    call_connection_id: callConnectionId,
    from_number: fromNumber,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    transcript,
    tool_calls: toolCalls ?? [],
  });
  if (error) {
    logger.warn('Voice bridge: call transcript save failed', { err: error.message, callConnectionId });
  }

  // Reuses memory.js's message-transcript-building logic -- {role, content}
  // pairs are exactly the shape it already knows how to flatten and
  // summarize; role names are mapped from this file's 'caller'/'assistant'
  // to memory.js's convention-neutral 'user'/'assistant' (it never inspects
  // the string beyond that).
  const messages = transcript.map(t => ({
    role: t.role === 'caller' ? 'user' : 'assistant',
    content: t.text,
  }));

  try {
    await saveMemory({ messages, topic: 'voice_call', runId: callConnectionId });
  } catch (err) {
    logger.warn('Voice bridge: call memory summarise failed', { err: err.message, callConnectionId });
  }
}
