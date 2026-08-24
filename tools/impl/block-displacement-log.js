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
    logger.warn('block-displacement-log: count query failed', { seriesMasterId, err: error.message });
    return 0; // fail open, same reasoning as the missing-seriesMasterId case above
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
