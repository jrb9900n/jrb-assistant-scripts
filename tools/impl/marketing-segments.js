// tools/impl/marketing-segments.js
// Segment identification for re-engagement marketing campaigns. This is
// where three real bugs found and fixed during a live 2026-08-19/24
// "due for a recoat" campaign are encoded as tested code, not left as
// something a future ad hoc script has to rediscover:
//
//   1. Recency must be measured from TODAY, not a fixed historical cutoff.
//      A binary "has this client shown up at all since date X" check wrongly
//      cleared a client (Pro 2 Pave, Inc. - a ~$1.2M/3yr account) as
//      "already redone" because its last invoice fell just after the cutoff
//      - by the time the campaign actually ran, that was 2.8 years stale.
//   2. Name normalization must NEVER strip parenthetical content. This
//      business uses "(Property Name)" suffixes to distinguish one client's
//      different physical properties (e.g. "Panda Express (Greendale)" vs
//      "Panda Express (2611 S. 108th St)", "Rite-Hite (Overnite LLC)" vs
//      "(Sixsibs LLC)"). An earlier normalizer stripped parens entirely and
//      risked collapsing distinct properties into one false match.
//   3. Every candidate must be cross-checked against the CURRENT calendar
//      year's estimates (any stage) before being proposed - otherwise a
//      client already served or already in an active bid conversation this
//      year gets a redundant "you're overdue" campaign.
//
// Deliberately current-SA-only (Aug 2023-present, via sa_invoice_line_items)
// for now - reaching back into pre-Aug-2023 "Old SA" history would mean
// reusing sa-history-match.js's name-matching, which strips parens (fine for
// that file's broad account-type-linking purpose, not fine for precise
// per-property campaign targeting) and touching a live, heavily-tested
// classification system to fix that isn't worth the risk here. Two years of
// current-SA data already covers any reasonable recency threshold as of
// today; extending further back is a defined future enhancement, not done
// silently wrong.

import { supabase, daysBetween } from './ar-report-helpers.js';
import { getAllSAAccounts } from './serviceautopilot.js';
import { logger } from '../../core/logger.js';

// PostgREST/Supabase silently caps unbounded queries at ~1000 rows by
// default - a previously-documented, repeatedly-fixed bug class in this
// exact codebase (estimating-pipeline-report.js, sales-pipeline-report.js,
// weekly-scorecard-report.js all guard against it the same way, with an
// explicit .order() + .range() rather than a bare default page size).
// sa_estimates_2026 in particular is already confirmed to sit at ~1000 rows
// today per estimating-pipeline-report.js's own comment - an unpaginated
// query against it here would already be silently truncating.
const LINE_ITEMS_QUERY_MAX_ROWS = 19999; // no documented row count for sa_invoice_line_items; generous headroom since it spans 2+ years of current-SA history, filtered to a handful of exact line_item_name values
const ESTIMATES_QUERY_MAX_ROWS = 4999; // same headroom used by the sibling report files above against this same table

// Known, hand-verified service categories -> the exact sa_invoice_line_items
// line_item_name values that belong to them. Deliberately a small, explicit
// map rather than a keyword guess against arbitrary service names - these
// three were confirmed live 2026-08-19 against real invoice data. Add a new
// category only after confirming its real line-item names the same way
// (query `select distinct line_item_name from sa_invoice_line_items where
// line_item_name ilike '%keyword%'` and eyeball the results before trusting
// them).
export const SERVICE_CATEGORY_LINE_ITEMS = {
  Sealcoat: ['Sealcoating - PMM - 2 Coats', 'Sealcoating - PMM - 1 Coat', 'Sealcoating - Res. 1 Coat', 'Sealcoating - Res. 2 Coat', 'Sealcoating - Coal Tar - 1 Coat'],
  'Crack Fill': ['Hot Rubberized Crack Filler'],
  Striping: ['Striping'],
};

// Loose match used ONLY for scanning sa_estimates_2026's free-text
// serviceTypeName field inside each estimate's line_items JSONB (estimates
// don't share the same controlled vocabulary as invoice line items) - never
// used for the primary invoice-based candidate query above, which uses exact
// names on purpose.
const CROSS_CHECK_PATTERNS = {
  Sealcoat: /seal/i,
  'Crack Fill': /crack/i,
  Striping: /striping/i,
};

// Subcontractor/GC pass-through keyword heuristic - flags (never
// auto-excludes) accounts whose name reads like a paving/construction
// company acting as the "client," not a retail property owner. Validated
// 2026-08-19 against real accounts: Pro 2 Pave, Inc. (~$1.2M/3yr, missed by
// an earlier version of this list that checked "paving" but not "pave"),
// Show Striping Industries, Panacea Construction Group, Khotol Services
// Corp, Stark Pavement Corporation, Murphy Construction Services.
const SUBCONTRACTOR_KEYWORDS = ['construction', 'paving', 'pave', 'services corp', 'contractors', 'asphalt maintenance', 'excavat', 'blacktop'];

// Never strip parenthetical content - see file header. Deliberately NOT
// reusing sa-history-match.js's normalizeClientName, which does strip parens
// for its own (different-tolerance) purpose.
export function normalizeName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9\s&]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isSubcontractorLike(name) {
  const lower = (name || '').toLowerCase();
  return SUBCONTRACTOR_KEYWORDS.some(k => lower.includes(k));
}

/**
 * Identify a client segment for a re-engagement campaign: everyone whose
 * most recent invoiced service in `serviceCategory` is older than
 * `recencyThresholdDays`, excluding anyone with a current-calendar-year
 * estimate touching that category, matched to their live SA account (so the
 * result is directly usable by apply-reengagement-campaign).
 *
 * Read-only - makes no writes to SA or Supabase. Does not look up each
 * candidate's existing "Client Type" tag (that's a per-client live SA call,
 * deferred to apply-time for just the approved subset, keeping this
 * identify step fast).
 *
 * @param {object} opts
 * @param {string} opts.serviceCategory - a key of SERVICE_CATEGORY_LINE_ITEMS
 * @param {number} [opts.recencyThresholdDays=365]
 * @param {boolean} [opts.excludeCurrentYearEstimates=true]
 * @returns {Promise<{candidates, flaggedForReview, excludedCurrentYearEstimate, summary}>}
 */
export async function identifySegment({ serviceCategory, recencyThresholdDays = 365, excludeCurrentYearEstimates = true }) {
  const lineItemNames = SERVICE_CATEGORY_LINE_ITEMS[serviceCategory];
  if (!lineItemNames) {
    throw new Error(`identifySegment: unknown serviceCategory "${serviceCategory}" - known categories: ${Object.keys(SERVICE_CATEGORY_LINE_ITEMS).join(', ')}`);
  }

  // ── 1. Pull current-SA invoice line items for this category ─────────────
  const { data: lineItems, error: liErr } = await supabase
    .from('sa_invoice_line_items')
    .select('client_name, line_item_date, total, invoice_id')
    .in('line_item_name', lineItemNames)
    .gt('total', 0)
    .order('line_item_date', { ascending: true })
    .range(0, LINE_ITEMS_QUERY_MAX_ROWS - 1);
  if (liErr) throw new Error(`identifySegment: sa_invoice_line_items query failed: ${liErr.message}`);
  if (lineItems && lineItems.length === LINE_ITEMS_QUERY_MAX_ROWS) {
    logger.warn('identifySegment: sa_invoice_line_items query hit LINE_ITEMS_QUERY_MAX_ROWS - results may be truncated', { serviceCategory, max: LINE_ITEMS_QUERY_MAX_ROWS });
  }

  // ── 2. Group by EXACT client_name (never normalized here - confirmed
  //      zero cases this session of one exact name covering multiple
  //      addresses in this data, so exact grouping is safe) ────────────────
  const byClient = new Map();
  for (const row of lineItems ?? []) {
    if (!byClient.has(row.client_name)) {
      byClient.set(row.client_name, { clientName: row.client_name, lastDate: row.line_item_date, totalSpend: 0, invoiceIds: new Set() });
    }
    const e = byClient.get(row.client_name);
    if (row.line_item_date > e.lastDate) e.lastDate = row.line_item_date;
    e.totalSpend += Number(row.total) || 0;
    e.invoiceIds.add(row.invoice_id);
  }

  // ── 3. Address lookup (one query, joined client-side) ───────────────────
  const invoiceIds = [...new Set([...byClient.values()].flatMap(e => [...e.invoiceIds]))];
  const addressByInvoiceId = new Map();
  const CHUNK = 200;
  for (let i = 0; i < invoiceIds.length; i += CHUNK) {
    const chunk = invoiceIds.slice(i, i + CHUNK);
    const { data: invRows, error: invErr } = await supabase.from('sa_invoices').select('sa_id, address').in('sa_id', chunk);
    if (invErr) { logger.warn('identifySegment: address lookup chunk failed', { err: invErr.message }); continue; }
    for (const r of invRows ?? []) addressByInvoiceId.set(r.sa_id, r.address);
  }
  for (const e of byClient.values()) {
    const firstInvoiceId = [...e.invoiceIds][0];
    e.address = addressByInvoiceId.get(firstInvoiceId) || '';
  }

  // ── 4. Recency filter - measured from TODAY, not a fixed cutoff ─────────
  let past = [...byClient.values()].filter(e => daysBetween(e.lastDate) > recencyThresholdDays);

  // ── 5. Cross-check against current-year estimates (any stage) ───────────
  const excludedCurrentYearEstimate = [];
  if (excludeCurrentYearEstimates) {
    const currentYear = new Date().getFullYear();
    const yearStart = `${currentYear}-01-01`;
    const { data: estimates, error: estErr } = await supabase
      .from('sa_estimates_2026')
      .select('client_name, estimate_number, stage, stage_name, quote_date, line_items')
      .gte('quote_date', yearStart)
      .order('quote_date', { ascending: true })
      .range(0, ESTIMATES_QUERY_MAX_ROWS - 1);
    if (estimates && estimates.length === ESTIMATES_QUERY_MAX_ROWS) {
      logger.warn('identifySegment: sa_estimates_2026 cross-check query hit ESTIMATES_QUERY_MAX_ROWS - results may be truncated', { serviceCategory, max: ESTIMATES_QUERY_MAX_ROWS });
    }
    if (estErr) {
      logger.warn('identifySegment: current-year estimate cross-check failed, proceeding WITHOUT it', { err: estErr.message });
    } else {
      const pattern = CROSS_CHECK_PATTERNS[serviceCategory];
      const estByNormName = new Map();
      for (const est of estimates ?? []) {
        const items = Array.isArray(est.line_items) ? est.line_items : [];
        const touches = items.some(li => pattern.test(li?.serviceTypeName || ''));
        if (!touches) continue;
        const key = normalizeName(est.client_name);
        if (!estByNormName.has(key)) estByNormName.set(key, []);
        estByNormName.get(key).push(est);
      }
      const stillDue = [];
      for (const candidate of past) {
        const hits = estByNormName.get(normalizeName(candidate.clientName));
        if (hits && hits.length) {
          excludedCurrentYearEstimate.push({ ...candidate, matchingEstimates: hits.map(h => ({ estimateNumber: h.estimate_number, stage: h.stage_name, quoteDate: h.quote_date })) });
        } else {
          stillDue.push(candidate);
        }
      }
      past = stillDue;
    }
  }

  // ── 6. Resolve to a live SA clientId via the full roster (never SA's
  //      broken name-search filter - see CLAUDE.md's documented gap) ──────
  // max is generous headroom above the ~10,242 live accounts confirmed in
  // CLAUDE.md's classification backfill notes - that roster only grows, and
  // a cap sized to today's count would silently start truncating later
  // (the same class of bug getClientsByTag's default already caused once).
  const roster = await getAllSAAccounts({ max: 50000 });
  const rosterByNorm = new Map();
  for (const a of roster) {
    const key = normalizeName(a.name);
    if (!rosterByNorm.has(key)) rosterByNorm.set(key, []);
    rosterByNorm.get(key).push(a);
  }

  const candidates = [];
  const flaggedForReview = [];
  for (const e of past) {
    const key = normalizeName(e.clientName);
    const hits = rosterByNorm.get(key);
    const flags = [];
    if (isSubcontractorLike(e.clientName)) flags.push('subcontractor');
    if (!hits || hits.length === 0) {
      flags.push('no_live_match');
      flaggedForReview.push({ clientName: e.clientName, address: e.address, lastServiceDate: e.lastDate, daysSince: daysBetween(e.lastDate), totalSpend: Math.round(e.totalSpend * 100) / 100, flags, clientId: null });
      continue;
    }
    if (hits.length > 1) flags.push('roster_collision');

    const row = { clientName: e.clientName, address: e.address, lastServiceDate: e.lastDate, daysSince: daysBetween(e.lastDate), totalSpend: Math.round(e.totalSpend * 100) / 100, clientId: hits[0].clientId, flags };
    if (flags.length > 0) flaggedForReview.push(row);
    else candidates.push(row);
  }

  candidates.sort((a, b) => a.lastServiceDate.localeCompare(b.lastServiceDate));

  const summary = {
    serviceCategory,
    recencyThresholdDays,
    candidateCount: candidates.length,
    flaggedCount: flaggedForReview.length,
    excludedCurrentYearEstimateCount: excludedCurrentYearEstimate.length,
    totalHistoricalSpend: Math.round(candidates.reduce((s, c) => s + c.totalSpend, 0) * 100) / 100,
  };
  logger.info('identifySegment: complete', summary);

  return { candidates, flaggedForReview, excludedCurrentYearEstimate, summary };
}
