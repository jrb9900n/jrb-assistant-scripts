// tools/impl/sa-history-match.js — matches "Old SA" historical accounts
// (2015–Aug 2023, a separate Supabase project with its own ID namespace —
// confirmed live 2026-08-19 there's zero client_id overlap with the current
// system, meaning a prior platform migration regenerated every GUID) to
// current SA clients by name/email/address, so the older service-visit
// history can enrich the current service-line classification.
//
// Precision over recall: only high-confidence matches (exact email, or a
// uniquely-resolved name match) are used. Ambiguous cases are skipped rather
// than guessed — misattributing one client's service history to another is
// worse than leaving that client's service line unclassified.

import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';
import { normalizeAddress, streetNumberOf, normalizeEmail } from './fuzzy-match.js';

// Lazy — JRBHistory:SUPABASE_URL/SUPABASE_SERVICE_KEY are a separate credential
// namespace from the standard JRBAgent:* set and aren't injected into the live
// scheduler's environment (only used ad hoc for the one-time backfill). A
// module-scope createClient() would throw on import the moment anything else
// in this file's import chain (e.g. the daily sa_client_classification_incremental
// cron task) loads sa-client-classification.js — which never actually calls into
// Old SA — so this only connects when a function below is actually invoked.
let _history = null;
function history() {
  if (!_history) _history = createClient(process.env.SUPABASE_HISTORY_URL, process.env.SUPABASE_HISTORY_KEY);
  return _history;
}

// Old SA's scheduled_visits.service_name vocabulary (confirmed live 2026-08-19 —
// 68 distinct values across 38,854 visits). Different vocabulary than the current
// sa_jobs.service codes (SERVICE_CODE_MAP in sa-client-classification.js) — no
// overlapping keys between the two maps, so callers can merge them directly.
export const HISTORY_SERVICE_CODE_MAP = {
  Lawn: 'Lawn/Landscape', 'BED M': 'Lawn/Landscape', SPRIN: 'Lawn/Landscape', AERAT: 'Lawn/Landscape',
  FALL: 'Lawn/Landscape', PCUP: 'Lawn/Landscape', LawnRoll: 'Lawn/Landscape', DETHA: 'Lawn/Landscape',
  MOSQU: 'Lawn/Landscape', BedPreE: 'Lawn/Landscape', SHRUB: 'Lawn/Landscape', EDGIN: 'Lawn/Landscape',
  PMM2: 'Lawn/Landscape', BROWN: 'Lawn/Landscape', LAND: 'Lawn/Landscape', DEBRI: 'Lawn/Landscape',
  WEED: 'Lawn/Landscape', HEMLOCK: 'Lawn/Landscape', TOPS: 'Lawn/Landscape', Duocide: 'Lawn/Landscape',
  SlitSeed: 'Lawn/Landscape', BAG: 'Lawn/Landscape',
  App1: 'Lawn/Landscape', App2: 'Lawn/Landscape', App3: 'Lawn/Landscape', App4: 'Lawn/Landscape',
  App5: 'Lawn/Landscape', App6: 'Lawn/Landscape', App7: 'Lawn/Landscape',
  'Coal Tar': 'Paving', Crack: 'Paving', Stripe: 'Paving',
  'Snow Remov': 'Snow',
  CONCRETE: 'Concrete',
  // Deliberately unmapped (too ambiguous/generic to trust): Rup, R&R, MIXED, Skid,
  // 'Yearly Non', SKIN.
};

function normalizeClientName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')       // "(AUTOPAY)", "(Residence)" — annotations, not identity
    .replace(/\s*-\s*[a-z]+\s*$/i, '') // trailing "- Rental", "- AUTOPAY" etc.
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pulls every Old SA account: { saId, name, address, email }. */
async function getHistoryAccounts() {
  const { count, error: countErr } = await history().from('accounts').select('*', { count: 'exact', head: true });
  if (countErr) throw new Error(`getHistoryAccounts: ${countErr.message}`);

  const rows = [];
  const pageSize = 1000;
  for (let from = 0; from < count; from += pageSize) {
    const { data, error } = await history().from('accounts').select('sa_id, client_name, address1, email').range(from, from + pageSize - 1);
    if (error) throw new Error(`getHistoryAccounts: ${error.message}`);
    for (const row of data) rows.push({ saId: row.sa_id, name: row.client_name || '', address: row.address1 || '', email: row.email || '' });
  }
  return rows;
}

/**
 * Pulls Old SA's scheduled_visits, grouped by the OLD account's sa_id.
 * Returns Map<oldSaId, Set<rawServiceNameStrings>>.
 */
export async function getHistoryServiceMap() {
  const { count, error: countErr } = await history().from('scheduled_visits').select('*', { count: 'exact', head: true }).not('client_id', 'is', null).not('service_name', 'is', null);
  if (countErr) throw new Error(`getHistoryServiceMap: ${countErr.message}`);

  const map = new Map();
  const pageSize = 1000;
  for (let from = 0; from < count; from += pageSize) {
    const { data, error } = await history().from('scheduled_visits').select('client_id, service_name').not('client_id', 'is', null).not('service_name', 'is', null).range(from, from + pageSize - 1);
    if (error) throw new Error(`getHistoryServiceMap: ${error.message}`);
    for (const row of data) {
      if (!map.has(row.client_id)) map.set(row.client_id, new Set());
      map.get(row.client_id).add(row.service_name);
    }
  }
  logger.info('SA history match: service map built', { oldAccountsWithService: map.size });
  return map;
}

/**
 * Matches Old SA accounts to current SA accounts. currentAccounts must include
 * { clientId, name, address, email } (as returned by getAllSAAccounts, which
 * now includes email).
 *
 * Returns { matched: Map<oldSaId, currentClientId>, stats: {byEmail, byName, ambiguousSkipped, noMatch} }.
 */
export async function matchHistoryAccountsToCurrent(currentAccounts) {
  const byEmail = new Map();
  const emailCollisions = new Set();
  const byName = new Map();

  for (const c of currentAccounts) {
    const email = normalizeEmail(c.email);
    if (email) {
      if (byEmail.has(email) && byEmail.get(email) !== c.clientId) emailCollisions.add(email);
      byEmail.set(email, c.clientId);
    }
    const name = normalizeClientName(c.name);
    if (name) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push({ clientId: c.clientId, streetNumber: streetNumberOf(c.address) });
    }
  }
  for (const email of emailCollisions) byEmail.delete(email);

  const historyAccounts = await getHistoryAccounts();
  const matched = new Map();
  const stats = { byEmail: 0, byName: 0, ambiguousSkipped: 0, noMatch: 0 };

  for (const old of historyAccounts) {
    const email = normalizeEmail(old.email);
    if (email && byEmail.has(email)) {
      matched.set(old.saId, byEmail.get(email));
      stats.byEmail++;
      continue;
    }

    const name = normalizeClientName(old.name);
    const candidates = byName.get(name) || [];
    if (candidates.length === 1) {
      matched.set(old.saId, candidates[0].clientId);
      stats.byName++;
    } else if (candidates.length > 1) {
      const oldStreetNumber = streetNumberOf(old.address);
      const addressMatches = oldStreetNumber ? candidates.filter(c => c.streetNumber === oldStreetNumber) : [];
      if (addressMatches.length === 1) {
        matched.set(old.saId, addressMatches[0].clientId);
        stats.byName++;
      } else {
        stats.ambiguousSkipped++;
      }
    } else {
      stats.noMatch++;
    }
  }

  logger.info('SA history match: accounts matched', { total: historyAccounts.length, ...stats, matched: matched.size });
  return { matched, stats };
}

/**
 * Enriches a current service-history map (from getServiceHistoryMap in
 * sa-client-classification.js) with Old SA's data, for accounts confidently
 * matched. Mutates and returns the same map — additive only, never overwrites
 * a current clientId's existing entries.
 */
export function mergeHistoryIntoServiceMap(currentServiceHistoryMap, historyServiceMap, matched) {
  let enrichedCount = 0;
  for (const [oldSaId, currentClientId] of matched) {
    const oldServices = historyServiceMap.get(oldSaId);
    if (!oldServices || oldServices.size === 0) continue;
    if (!currentServiceHistoryMap.has(currentClientId)) currentServiceHistoryMap.set(currentClientId, new Set());
    const before = currentServiceHistoryMap.get(currentClientId).size;
    for (const s of oldServices) currentServiceHistoryMap.get(currentClientId).add(s);
    if (currentServiceHistoryMap.get(currentClientId).size > before) enrichedCount++;
  }
  logger.info('SA history match: merged into service history map', { enrichedCount });
  return currentServiceHistoryMap;
}
