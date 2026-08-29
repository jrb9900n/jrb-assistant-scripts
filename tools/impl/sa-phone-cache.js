// tools/impl/sa-phone-cache.js — One-time historical backfill + going-forward
// incremental cron that caches SA per-client phone fields (HomePhone,
// CellPhone, WorkPhone, OtherPhone, PreferredPhoneID) into the
// sa_client_phone_cache Supabase table (jrb-assistant project, migration
// 20260829090000_sa_client_phone_cache.sql).
//
// Why this exists: findDuplicateClient()'s phone-only dedup path (PR #361,
// tools/impl/serviceautopilot.js, branch claude/sa-lead-source-dedup — not
// yet merged as of this writing) is bounded to the 50 most-recently-created
// accounts (PHONE_ONLY_RECENT_SCAN_CAP) because no bulk SA endpoint carries
// phone data — confirmed exhaustively in that PR's own comments: phone only
// ever comes back from the per-client GetClientInfo endpoint
// (ClientEditOverlayWs.asmx). Michael asked directly: run GetClientInfo for
// every client and cache the results, so phone dedup can check the full
// ~10,300-account population instead of just the newest 50.
//
// Shape closely follows tools/impl/sa-client-classification.js (see
// CLAUDE.md's "SA Client Categorization" section): a resumable backfill
// driven in ~8-minute chunks (each Claude Code tool call has a hard ~10-min
// cap; this job spans hours) via a disposable driver script (not committed —
// the reusable logic lives here, same convention as
// applyClassificationBackfill), plus a going-forward incremental cron
// registered in scheduler/cron.js.
//
// Resumability is simpler here than the classification backfill: instead of
// a separate JSON checkpoint file, the cache table itself IS the checkpoint —
// every chunk call re-derives its own candidate list from "which accounts are
// missing or stale in sa_client_phone_cache right now," and each successful
// fetch is upserted immediately (not batched at the end), so a crash or
// interruption mid-chunk loses at most the one in-flight client, not the
// whole chunk's progress.
//
// Incapsula handling: mirrors the classification backfill's real incident
// (an unrelated probe elsewhere false-flagged Incapsula bot detection,
// setting the shared 45-minute backoff file that every SA call respects,
// including this one — see serviceautopilot.js's looksLikeIncapsula/post()).
// The backoff check throws synchronously with a message containing
// "Incapsula" before any real request is attempted, so a burst of these looks
// nothing like a real per-client failure (near-instant, identical message,
// every remaining candidate in the batch). isIncapsulaError() below detects
// that shape and stops the chunk immediately instead of burning through the
// rest of the candidate list as fake failures — the untouched candidates
// simply stay uncached and get retried on a later chunk once the backoff
// clears, no special retry bookkeeping needed.

import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';
import { getAllSAAccounts, getSAClientDetails } from './serviceautopilot.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const TABLE = 'sa_client_phone_cache';

// How long a cached row is trusted before it's treated as needing a refresh.
// 30 days balances "phone-only dedup doesn't need up-to-the-minute
// freshness" against re-fetching all ~10,300 accounts too often once the
// initial backfill completes.
export const PHONE_CACHE_TTL_DAYS = 30;

// Same digit-only normalization PR #361's findDuplicateClient/createClient
// use (strip everything but digits, then strip a leading US country code "1"
// off an 11-digit result) — duplicated here rather than imported because
// that helper isn't exported from serviceautopilot.js's main-branch copy (PR
// #361 hasn't merged yet, so its normalizePhoneDigits doesn't exist here).
// Keep this in sync if that PR's version of the helper ever changes.
function normalizePhoneDigits(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

// Matches the exact throw shape of serviceautopilot.js's post() when the
// shared Incapsula backoff file is already active, or was just set by a
// fresh block ("SA Incapsula backoff active — N min remaining...", "SA
// blocked by Incapsula bot protection...") — both contain "Incapsula" in
// that file's own wording; matched case-insensitively here as a small margin
// of safety, not because the casing is expected to vary.
function isIncapsulaError(err) {
  return typeof err?.message === 'string' && /incapsula/i.test(err.message);
}

/** Paginates sa_client_phone_cache, returning Map<clientId, fetchedAtIso>. */
async function getCacheFreshnessMap() {
  const map = new Map();
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('client_id, fetched_at')
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`sa-phone-cache: getCacheFreshnessMap Supabase error: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) map.set(row.client_id, row.fetched_at);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return map;
}

/**
 * Reports overall backfill progress without doing any SA write work (still
 * pulls a full roster + full cache table, so not free, but no GetClientInfo
 * calls) — useful for checking status between chunked backfill passes.
 * Returns { totalAccounts, cachedTotal, freshCount, staleOrMissingCount }.
 */
export async function getPhoneCacheStats({ ttlDays = PHONE_CACHE_TTL_DAYS } = {}) {
  const [roster, freshnessMap] = await Promise.all([
    getAllSAAccounts({ max: 20000 }),
    getCacheFreshnessMap(),
  ]);
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  let freshCount = 0;
  for (const account of roster) {
    const fetchedAt = freshnessMap.get(account.clientId);
    if (fetchedAt && new Date(fetchedAt).getTime() >= cutoff) freshCount++;
  }
  return {
    totalAccounts: roster.length,
    cachedTotal: freshnessMap.size,
    freshCount,
    staleOrMissingCount: roster.length - freshCount,
  };
}

/**
 * Core resumable unit of work — call repeatedly (via a disposable driver
 * script for the initial backfill, or the incremental cron below) until
 * staleOrMissingCount (see getPhoneCacheStats) reaches 0. Each call:
 *   1. Pulls the live account roster (getAllSAAccounts) and the current
 *      cache freshness map.
 *   2. Filters to accounts missing from the cache or older than ttlDays.
 *   3. Processes up to maxAccounts of them: one GetClientInfo call each
 *      (getSAClientDetails), upserted into sa_client_phone_cache
 *      immediately on success (not batched) so a crash mid-chunk only loses
 *      the one in-flight client, not the whole chunk's progress.
 *   4. Stops immediately (without touching the rest of the batch) the
 *      moment an Incapsula backoff is detected — see isIncapsulaError's
 *      comment above. Every account not yet reached in that case is simply
 *      left uncached and picked up again by a later chunk once the backoff
 *      clears; no separate failure-retry bookkeeping needed. The same is
 *      true of an ordinary per-client failure (e.g. a transient network
 *      error) — it's logged but not upserted, so it stays a candidate and
 *      gets retried automatically on a later chunk.
 *
 * Returns { candidates, processed, upserted, failed: [{clientId, name,
 * error}], incapsulaBackoffHit, remainingAfterThisChunk }.
 * remainingAfterThisChunk is an approximate progress indicator only (it
 * doesn't distinguish "failed, will retry" from "genuinely untouched") —
 * the next call always recomputes the real candidate list fresh regardless.
 */
export async function runPhoneCacheBackfillChunk({ maxAccounts = 400, ttlDays = PHONE_CACHE_TTL_DAYS } = {}) {
  const [roster, freshnessMap] = await Promise.all([
    getAllSAAccounts({ max: 20000 }),
    getCacheFreshnessMap(),
  ]);

  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  const candidates = roster.filter(a => {
    const fetchedAt = freshnessMap.get(a.clientId);
    return !fetchedAt || new Date(fetchedAt).getTime() < cutoff;
  });

  const toProcess = candidates.slice(0, maxAccounts);
  let upserted = 0;
  const failed = [];
  let incapsulaBackoffHit = false;
  let stoppedAt = toProcess.length;

  for (let i = 0; i < toProcess.length; i++) {
    const account = toProcess[i];
    let detail;
    try {
      detail = await getSAClientDetails(account.clientId);
    } catch (err) {
      if (isIncapsulaError(err)) {
        incapsulaBackoffHit = true;
        stoppedAt = i;
        logger.warn('sa-phone-cache: Incapsula backoff hit mid-chunk, stopping chunk early', {
          processedSoFar: i, remainingInChunk: toProcess.length - i,
        });
        break;
      }
      failed.push({ clientId: account.clientId, name: account.name, error: err.message });
      logger.warn('sa-phone-cache: GetClientInfo failed for client', { clientId: account.clientId, error: err.message });
      continue;
    }

    const { error: upsertError } = await supabase.from(TABLE).upsert({
      client_id: account.clientId,
      client_name: account.name || null,
      home_phone: detail.homePhone || null,
      cell_phone: detail.cellPhone || null,
      work_phone: detail.workPhone || null,
      other_phone: detail.otherPhone || null,
      preferred_phone_id: detail.preferredPhoneId || null,
      fetched_at: new Date().toISOString(),
    }, { onConflict: 'client_id' });

    if (upsertError) {
      failed.push({ clientId: account.clientId, name: account.name, error: `Supabase upsert failed: ${upsertError.message}` });
      logger.warn('sa-phone-cache: Supabase upsert failed', { clientId: account.clientId, error: upsertError.message });
    } else {
      upserted++;
    }
  }

  const remainingAfterThisChunk = candidates.length - stoppedAt;
  logger.info('sa-phone-cache: backfill chunk complete', {
    candidateCount: candidates.length, processed: stoppedAt, upserted, failedCount: failed.length,
    incapsulaBackoffHit, remainingAfterThisChunk,
  });
  return { candidates: candidates.length, processed: stoppedAt, upserted, failed, incapsulaBackoffHit, remainingAfterThisChunk };
}

/**
 * Going-forward companion to the one-time historical backfill — same shape
 * as sa-client-classification.js's runIncrementalClassification. Catches
 * clients created since the backfill (never cached) and refreshes anything
 * past ttlDays, capped at maxAccounts/run as a safety ceiling so a large
 * accumulated backlog (e.g. after an outage) can't monopolize the shared SA
 * browser session on any single scheduled run.
 */
export async function runPhoneCacheIncremental({ maxAccounts = 300, ttlDays = PHONE_CACHE_TTL_DAYS } = {}) {
  return runPhoneCacheBackfillChunk({ maxAccounts, ttlDays });
}

/**
 * Full-population phone match against the cache — the intended replacement
 * for findDuplicateClient()'s bounded PHONE_ONLY_RECENT_SCAN_CAP fallback
 * (PR #361, tools/impl/serviceautopilot.js — not yet merged as of this
 * writing, see this file's own header comment for why the wiring itself
 * isn't in this PR). Paginates the entire cache table client-side
 * (comfortably small at ~10,300 rows) and normalizes both sides before
 * comparing, since SA's raw phone strings aren't stored pre-normalized in
 * the cache (kept raw so a spot-check against a live GetClientInfo call is a
 * direct visual comparison, not a lossy one).
 *
 * Returns { matches: [{clientId, name, matchedField}], totalCached,
 * ttlDays } — `matches` is an empty array (never thrown) when nothing
 * matches; callers should treat that the same way findDuplicateClient
 * treats confidence:'none'.
 */
export async function findPhoneMatchesInCache({ phone, ttlDays = PHONE_CACHE_TTL_DAYS } = {}) {
  const normPhone = normalizePhoneDigits(phone);
  if (!normPhone) throw new Error('sa-phone-cache: findPhoneMatchesInCache requires a non-empty phone');

  const matches = [];
  let totalCached = 0;
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('client_id, client_name, home_phone, cell_phone, work_phone, other_phone')
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`sa-phone-cache: findPhoneMatchesInCache Supabase error: ${error.message}`);
    if (!data || data.length === 0) break;
    totalCached += data.length;
    for (const row of data) {
      const fields = [
        ['homePhone', row.home_phone],
        ['cellPhone', row.cell_phone],
        ['workPhone', row.work_phone],
        ['otherPhone', row.other_phone],
      ];
      for (const [field, value] of fields) {
        if (value && normalizePhoneDigits(value) === normPhone) {
          matches.push({ clientId: row.client_id, name: row.client_name || '', matchedField: field });
          break; // one match entry per client row is enough, even if 2+ fields match the same phone
        }
      }
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }

  logger.info('sa-phone-cache: phone match query complete', { normPhone, matchCount: matches.length, totalCached });
  return { matches, totalCached, ttlDays };
}
