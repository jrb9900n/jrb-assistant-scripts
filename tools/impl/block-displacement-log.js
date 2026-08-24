// tools/impl/block-displacement-log.js — tracks how often an [OCCASIONAL]-tier
// block-schedule occurrence gets auto-displaced, so scheduling-visits.js's
// checkAndResolveDisplacement can enforce a real rolling-window cap (2 per 30
// days per series, confirmed with Michael) instead of just a label. Same
// lazy-Supabase-client pattern as calendar-watch.js.

import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';

let _supabase = null;
function supabase() {
  if (!_supabase) _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  return _supabase;
}

/**
 * Counts how many times a series has been displaced within the trailing
 * windowDays. A block with no seriesMasterId (shouldn't happen for a real
 * recurring block-schedule entry, but not fatal) is treated as always
 * under-cap — there's no stable key to count against, so failing open here
 * (rather than blocking every displacement) matches this codebase's general
 * "don't let a missing signal become a false negative" posture elsewhere.
 *
 * IMPORTANT: A DB error is NOT treated as "under cap". If the count cannot
 * be determined, this function throws so that the caller
 * (checkAndResolveDisplacement) can decline the displacement rather than
 * silently bypass the rolling-window cap. The cap is the only enforcement
 * mechanism for the "occasional, not routine" rule; making it fail open
 * during any outage would render it meaningless.
 */
export async function countRecentDisplacements({ seriesMasterId, windowDays }) {
  if (!seriesMasterId) return 0;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase()
    .from('block_displacement_log')
    .select('id', { count: 'exact', head: true })
    .eq('series_master_id', seriesMasterId)
    .gte('created_at', since);

  if (error) {
    logger.error('block-displacement-log: count query failed — failing closed to protect cap', { seriesMasterId, err: error.message });
    // Throw so callers treat this as a hard error and decline the displacement.
    // Failing open here would make the rolling-window cap unenforceable during
    // any Supabase outage — an unacceptable integrity gap.
    throw new Error(`block-displacement-log: count query failed: ${error.message}`);
  }
  return count ?? 0;
}

export async function logBlockDisplacement({ mailbox, seriesMasterId, occurrenceId, subject, occurrenceDate, action, requestedBy, requesterIdentity }) {
  const { error } = await supabase().from('block_displacement_log').insert({
    mailbox, series_master_id: seriesMasterId ?? null, occurrence_id: occurrenceId,
    subject, occurrence_date: occurrenceDate, action,
    requested_by: requestedBy ?? null, requester_identity: requesterIdentity ?? null,
  });
  if (error) logger.warn('block-displacement-log: insert failed', { occurrenceId, err: error.message });
}
