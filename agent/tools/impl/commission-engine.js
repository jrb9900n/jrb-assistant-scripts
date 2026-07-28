// tools/impl/commission-engine.js — Quarterly PM commission calculation
//
// Commission is cash-basis: paid only as the client actually pays a job/contract
// off, prorated by amount paid (per Michael, 2026-07-27). Two categories per the
// Accountability Agreement, both keyed off sa_invoices.is_contract:
//   - maintenance_snow: recurring landscape maintenance & snow contracts, 2.5%
//     of first-year annualized value, new/expanded contracts only (not renewals)
//   - self_performed:   one-time asphalt/concrete/landscape projects, 4.5% of
//     project value
// Subcontracted work earns the same rate but is capped at 20% of GP/markup on
// subs — since no system reliably captures actual sub cost today, qualifying
// LINE ITEMS (not whole invoices — see "line-item splitting" below) are
// matched against QBO vendor bills as CANDIDATES ONLY and flagged for manual
// confirmation. The cap is never auto-applied; see "subcontractor withholding"
// for how this stays safe in the meantime.
//
// PM attribution comes from pm_job_assignments (manual, or scraped from the
// client's original accepted estimate — see resolvePM).
//
// ── Line-item splitting (2026-07-28) ──────────────────────────────────────
// A single invoice (or one of a contract's constituent invoices) can mix
// self-performed and subcontracted line items. commission_ledger_lines holds
// one row per QBO invoice line (fetched from qb_invoices.raw_data.Line, no
// live API call needed — already synced). Each candidate vendor-bill match is
// best-effort attributed to the invoice line whose description most closely
// matches the bill line's description; when no confident attribution exists,
// its dollars count toward the job's unconfirmed_subcontracted_fraction
// without being pinned to a specific line. When a job's underlying invoice(s)
// have no resolvable QBO link, no line rows are written and the job falls
// back to whole-invoice treatment (fraction is 0 or 1, same as pre-line-item
// behavior).
//
// ── Accrual vs payable, and why two different "amount paid so far" numbers exist ──
// accrued_commission is the FULL commission for a job, recognized once — in the
// ledger row for the EARLIEST quarter on record for that sa_reference (not the
// first one *inserted*, so backtesting/out-of-order runs still land the accrual
// in the right period). Every later quarter's row has accrued_commission = 0,
// so summing it across rows is always double-count-safe.
//
// payable_commission is commission on cash newly attributed to this job THIS
// run — computed against commissioned_through_amount, not paid_amount:
//   - paid_amount is the real cumulative cash the client has paid (informational).
//   - commissioned_through_amount is the cumulative cash that has actually had
//     commission paid out against it. It only advances by the CONFIRMED
//     fraction of newly-collected cash — the unconfirmed_subcontracted_fraction
//     of each increment stays frozen in the gap between paid_amount and
//     commissioned_through_amount, so once a line is confirmed the backlog
//     becomes payable in one catch-up run instead of being silently skipped.
// Renewal-pending zeroes BOTH accrued and payable (a confirmed renewal earns
// nothing at all). Subcontractor-pending only withholds the affected FRACTION
// of payable — accrued still books the full uncapped rate as a conservative
// liability estimate, since some non-zero amount will definitely be owed once
// the 20% cap is confirmed, and overstating a liability is the safe direction
// for the accountant's books.

import { createClient } from '@supabase/supabase-js';
import { getVendorBillsForPeriod, matchBillsToJob } from './quickbooks.js';
import { logger } from '../../core/logger.js';

const fleetops = createClient(
  process.env.FLEETOPS_SUPABASE_URL,
  process.env.FLEETOPS_SUPABASE_SERVICE_KEY
);

const LOOKBACK_DAYS = 400;          // covers a first-year maintenance/snow contract plus buffer
const RENEWAL_LOOKBACK_START = 800; // window (days ago) to search for a plausible prior-year contract
const RENEWAL_LOOKBACK_END = 300;
const SELF_PERFORMED_BILL_WINDOW_DAYS = 45; // sub bills usually arrive well before the job is invoiced

const FREQUENCY_MULTIPLIER = {
  weekly: 52,
  biweekly: 26,
  monthly: 12,
  quarterly: 4,
  semiannually: 2,
  annually: 1,
  yearly: 1,
};

const round2 = n => Number(n.toFixed(2));

function dateStr(daysAgo) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

function daysBefore(dateISO, days) {
  const d = new Date(dateISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split('T')[0];
}

function daysAfter(dateISO, days) {
  const d = new Date(dateISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

export function currentQuarter(asOfDate = new Date()) {
  const q = Math.floor(asOfDate.getUTCMonth() / 3) + 1;
  return `${asOfDate.getUTCFullYear()}-Q${q}`;
}

// The quarter that just ended — used when the cron fires on the 1st of the
// month following quarter-end ("first payroll following quarter end").
export function previousQuarter(asOfDate = new Date()) {
  const q = Math.floor(asOfDate.getUTCMonth() / 3) + 1;
  return q === 1 ? `${asOfDate.getUTCFullYear() - 1}-Q4` : `${asOfDate.getUTCFullYear()}-Q${q - 1}`;
}

// Sortable integer for 'YYYY-Qn' so quarters compare chronologically rather
// than by insertion order — matters for backtesting/out-of-order runs.
function quarterSortKey(quarterStr) {
  const [year, q] = quarterStr.split('-Q');
  return Number(year) * 4 + Number(q);
}

function annualizeContractValue(invoiceTotal, frequency) {
  const key = (frequency || '').toLowerCase().replace(/[^a-z]/g, '');
  const mult = FREQUENCY_MULTIPLIER[key];
  return mult ? invoiceTotal * mult : invoiceTotal; // unknown frequency: conservative — treat as its own annual value
}

function normalizeWords(s) {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
}

// Best-effort match of a bill line's description to one of a job's invoice
// lines, by shared-word count. Returns null (no confident attribution) rather
// than guessing when nothing overlaps — the caller falls back to a whole-job
// fractional withhold in that case.
function bestLineMatch(billLineDescription, lines) {
  const billWords = normalizeWords(billLineDescription);
  if (!billWords.length) return null;
  let best = null, bestScore = 0;
  for (const line of lines) {
    const lineWords = normalizeWords(`${line.description} ${line.itemName}`);
    const shared = billWords.filter(w => lineWords.includes(w)).length;
    if (shared > bestScore) { bestScore = shared; best = line; }
  }
  return best;
}

// ── Line items (per QBO invoice, via already-synced qb_invoices.raw_data) ──
async function fetchLineItemsForInvoice(saInvoiceSaId, qboId) {
  if (!qboId) return [];
  const { data, error } = await fleetops
    .from('qb_invoices')
    .select('raw_data')
    .eq('qb_id', qboId)
    .maybeSingle();
  if (error) { logger.warn('fetchLineItemsForInvoice query failed', { err: error.message, qboId }); return []; }
  const lines = data?.raw_data?.Line ?? [];
  return lines
    .filter(l => l.DetailType === 'SalesItemLineDetail')
    .map(l => ({
      saInvoiceSaId,
      description: l.Description ?? '',
      itemName: l.SalesItemLineDetail?.ItemRef?.name ?? '',
      // Rounded immediately, once, here — every downstream key/comparison
      // (confirmation carry-forward, dollar sums) uses this same rounded
      // value, so floating-point drift can never cause a key mismatch.
      amount: round2(Number(l.Amount ?? 0)),
    }));
}

function lineKeyOf(line) {
  return `${line.saInvoiceSaId}|${line.description}|${line.amount}`;
}

// ── PM attribution ─────────────────────────────────────────────
// Priority: assignment tied to this specific invoice > this contract > this
// client > scraped from the client's original accepted estimate. Ordered by
// assigned_at desc within the manual tiers so a reassignment (a second row,
// not an edit to the first — the table is append-only by design) resolves to
// the latest one; a later manual row always outranks a scraped one since the
// scraped fallback only runs when no assignment row exists yet at all.
async function resolvePM({ saClientId, contractId, invoiceSaId }) {
  const attempts = [
    invoiceSaId && ['sa_invoice_sa_id', invoiceSaId],
    contractId  && ['sa_contract_id', contractId],
    saClientId  && ['sa_client_id', saClientId],
  ].filter(Boolean);

  for (const [col, val] of attempts) {
    const { data, error } = await fleetops
      .from('pm_job_assignments')
      .select('employee_name')
      .eq(col, val)
      .order('assigned_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) { logger.warn('resolvePM query failed', { col, err: error.message }); continue; }
    if (data?.employee_name) return data.employee_name;
  }

  // No manual assignment exists for this client at all — scrape the rep off
  // the client's original accepted estimate. sa_accepted_estimates is synced
  // daily by the existing overnight_sa_report cron and already carries a
  // resolved employee name (not a raw SA rep GUID) in sales_rep. Picks the
  // most recent accepted estimate for the client as the best guess at who
  // originated this job. Known limitation: a client with multiple jobs handled
  // by different PMs over time will attribute ALL of them to whoever's
  // reflected on their most recent won estimate — a later manual correction
  // (a new 'manual' row) always overrides this, since this fallback only
  // fires when no assignment row exists yet.
  if (saClientId) {
    const { data: estRow, error: estError } = await fleetops
      .from('sa_accepted_estimates')
      .select('sales_rep, estimate_id')
      .eq('client_id', saClientId)
      .not('sales_rep', 'is', null)
      .neq('sales_rep', '—')
      .order('quote_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (estError) { logger.warn('resolvePM sa_accepted_estimates lookup failed', { err: estError.message }); return null; }
    if (estRow?.sales_rep) {
      const { error: insertError } = await fleetops.from('pm_job_assignments').insert({
        sa_client_id: saClientId,
        employee_name: estRow.sales_rep,
        source: 'sa_signal',
        notes: `Scraped from accepted estimate ${estRow.estimate_id}`,
      });
      // Duplicate-insert races (two jobs for the same brand-new client resolving
      // concurrently) are harmless — both attribute the same employee_name either way.
      if (insertError) logger.warn('pm_job_assignments sa_signal insert failed', { err: insertError.message });
      return estRow.sales_rep;
    }
  }
  return null;
}

// ── Renewal detection ───────────────────────────────────────────
// Heuristic only — SA has no native renewal flag. A different contract_id for
// the same customer_id in the prior-year window is treated as a likely renewal
// and flagged for manual confirmation; never auto-excluded silently.
async function looksLikeRenewal(customerId, contractId, earliestDate) {
  if (!customerId) return false;
  // Window is relative to THIS contract's own earliest invoice date, not "today" —
  // matters for backtesting a historical quarter, not just live runs.
  const windowStart = daysBefore(earliestDate, RENEWAL_LOOKBACK_START);
  const windowEnd = daysBefore(earliestDate, RENEWAL_LOOKBACK_END);
  let q = fleetops
    .from('sa_invoices')
    .select('contract_id')
    .eq('customer_id', customerId)
    .eq('is_contract', true)
    .gte('date', windowStart)
    .lte('date', windowEnd)
    .limit(1);
  if (contractId) q = q.neq('contract_id', contractId); // exclude self-match only when we have a real id to exclude by
  const { data, error } = await q;
  if (error) { logger.warn('looksLikeRenewal query failed', { err: error.message }); return false; }
  return (data ?? []).length > 0;
}

// ── Candidate job assembly ──────────────────────────────────────

async function assembleMaintenanceSnowJobs() {
  const lookbackDate = dateStr(LOOKBACK_DAYS);
  const { data: rows, error } = await fleetops
    .from('sa_invoices')
    .select('sa_id, client, customer_id, contract_id, invoice_total, invoice_balance, frequency, date, qbo_id')
    .eq('is_contract', true)
    .eq('deleted', false)
    .gte('date', lookbackDate)
    .order('date', { ascending: true });
  if (error) throw new Error(`assembleMaintenanceSnowJobs query failed: ${error.message}`);

  // Group by contract_id (fall back to customer_id if a contract has no id set)
  const groups = new Map();
  for (const row of rows ?? []) {
    const key = row.contract_id || `client:${row.customer_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const jobs = [];
  for (const [contractKey, contractRows] of groups) {
    // Use the EARLIEST invoice for the annualization basis — "first-year value"
    // means the value at signing, not a later in-contract price adjustment
    // (which would overstate accrual if a mid-year rate increase inflated it).
    const earliest = contractRows[0];
    const latest = contractRows[contractRows.length - 1];
    const invoicedAmount = contractRows.reduce((s, r) => s + Number(r.invoice_total || 0), 0);
    const paidAmount = contractRows.reduce(
      (s, r) => s + (Number(r.invoice_total || 0) - Number(r.invoice_balance || 0)), 0
    );

    jobs.push({
      category: 'maintenance_snow',
      saReference: `contract:${contractKey}`,
      saClientId: latest.customer_id,
      contractId: latest.contract_id,
      invoiceSaId: null,
      clientName: latest.client,
      contractOrFirstYearValue: annualizeContractValue(Number(earliest.invoice_total || 0), earliest.frequency),
      invoicedAmount,
      paidAmount,
      dateStart: earliest.date,
      dateEnd: latest.date,
      earliestDate: earliest.date,
      underlyingInvoices: contractRows.map(r => ({ saId: r.sa_id, qboId: r.qbo_id })),
    });
  }
  return jobs;
}

async function assembleSelfPerformedJobs() {
  const lookbackDate = dateStr(LOOKBACK_DAYS);
  const { data: rows, error } = await fleetops
    .from('sa_invoices')
    .select('sa_id, client, customer_id, invoice_total, invoice_balance, date, qbo_id')
    .eq('is_contract', false)
    .eq('deleted', false)
    .gte('date', lookbackDate)
    .gt('invoice_total', 0);
  if (error) throw new Error(`assembleSelfPerformedJobs query failed: ${error.message}`);

  return (rows ?? []).map(row => ({
    category: 'self_performed',
    saReference: `invoice:${row.sa_id}`,
    saClientId: row.customer_id,
    contractId: null,
    invoiceSaId: row.sa_id,
    clientName: row.client,
    contractOrFirstYearValue: Number(row.invoice_total || 0),
    invoicedAmount: Number(row.invoice_total || 0),
    paidAmount: Number(row.invoice_total || 0) - Number(row.invoice_balance || 0),
    // Sub bills usually arrive before the client is invoiced — widen the match
    // window rather than using the single invoice date (a zero-width window
    // makes the description-based fuzzy match unreachable).
    dateStart: daysBefore(row.date, SELF_PERFORMED_BILL_WINDOW_DAYS),
    dateEnd: daysAfter(row.date, SELF_PERFORMED_BILL_WINDOW_DAYS),
    earliestDate: row.date,
    underlyingInvoices: [{ saId: row.sa_id, qboId: row.qbo_id }],
  }));
}

// ── Main run ─────────────────────────────────────────────────────

export async function runCommissionEngine({ quarter } = {}) {
  const targetQuarter = quarter || currentQuarter();
  const targetKey = quarterSortKey(targetQuarter);

  const { data: plans, error: plansError } = await fleetops
    .from('commission_plans')
    .select('*')
    .eq('active', true);
  if (plansError) throw new Error(`commission_plans query failed: ${plansError.message}`);
  const planByEmployee = new Map((plans ?? []).map(p => [p.employee_name, p]));

  const [maintenanceJobs, selfPerformedJobs] = await Promise.all([
    assembleMaintenanceSnowJobs(),
    assembleSelfPerformedJobs(),
  ]);
  const allJobs = [...maintenanceJobs, ...selfPerformedJobs];

  // Fetch vendor bills ONCE for the whole lookback window rather than per-job
  // (getVendorBillsForPeriod paginates internally, so this covers the full window).
  const vendorBills = await getVendorBillsForPeriod(dateStr(LOOKBACK_DAYS), dateStr(-1)).catch(err => {
    logger.warn('getVendorBillsForPeriod failed — subcontractor flagging skipped this run', { err: err.message });
    return [];
  });

  const results = {
    written: 0, skippedNoPM: 0, skippedNoPlan: 0, renewalFlags: 0, subBillFlags: 0,
    unassignedJobs: [], unplannedJobs: [], processingErrors: [],
  };

  for (const job of allJobs) {
    const employeeName = await resolvePM({
      saClientId: job.saClientId,
      contractId: job.contractId,
      invoiceSaId: job.invoiceSaId,
    });
    if (!employeeName) {
      results.skippedNoPM++;
      results.unassignedJobs.push({
        saReference: job.saReference, clientName: job.clientName, category: job.category,
        value: job.contractOrFirstYearValue,
      });
      continue;
    }

    const plan = planByEmployee.get(employeeName);
    if (!plan || plan.effective_date > job.earliestDate) {
      results.skippedNoPlan++;
      results.unplannedJobs.push({
        saReference: job.saReference, clientName: job.clientName, category: job.category,
        employeeName, value: job.contractOrFirstYearValue,
      });
      continue;
    }

    const rate = job.category === 'maintenance_snow' ? plan.maintenance_rate : plan.self_performed_rate;
    const paidPct = job.invoicedAmount > 0 ? job.paidAmount / job.invoicedAmount : 0;

    // Fetch every prior ledger row for this job across all quarters — used for
    // renewal stickiness, the quarter-chronology baseline, and carrying forward
    // per-line confirmation status (see below).
    const { data: priorRows, error: priorError } = await fleetops
      .from('commission_ledger')
      .select('id, quarter, paid_amount, commissioned_through_amount, renewal_confirmed, accrued_commission, status')
      .eq('sa_reference', job.saReference);
    if (priorError) {
      logger.warn('prior ledger lookup failed — job skipped this run', { err: priorError.message, saReference: job.saReference });
      results.processingErrors.push({ saReference: job.saReference, clientName: job.clientName, error: priorError.message });
      continue;
    }

    const rows = priorRows ?? [];
    const existingThisQuarterRow = rows.find(r => r.quarter === targetQuarter) ?? null;
    const priorQuarterRows = rows.filter(r => quarterSortKey(r.quarter) < targetKey);
    const priorQuarterRow = priorQuarterRows.length
      ? priorQuarterRows.reduce((a, b) => (quarterSortKey(a.quarter) > quarterSortKey(b.quarter) ? a : b))
      : null;
    const earliestKeyOnRecord = rows.length ? Math.min(...rows.map(r => quarterSortKey(r.quarter))) : targetKey;
    const isEarliestQuarter = targetKey <= earliestKeyOnRecord;

    // Backtesting an earlier quarter after a later one already ran means the
    // later row wrongly claimed the accrual as if IT were earliest — correct
    // it here so summing accrued_commission across rows stays double-count-safe.
    if (isEarliestQuarter) {
      const wronglyAccruedRows = rows.filter(r => quarterSortKey(r.quarter) > targetKey && Number(r.accrued_commission) > 0);
      if (wronglyAccruedRows.length) {
        const { error: fixupError } = await fleetops.from('commission_ledger')
          .update({ accrued_commission: 0 })
          .in('id', wronglyAccruedRows.map(r => r.id));
        if (fixupError) logger.warn('accrual fixup for out-of-order backtest failed', { err: fixupError.message, saReference: job.saReference });
        else logger.info('Corrected a later quarter\'s accrual after an earlier quarter was backtested', { saReference: job.saReference, correctedIds: wronglyAccruedRows.map(r => r.id) });
      }
    }

    // Renewal confirmation is sticky once a human has set it — the heuristic's
    // date window drifts forward every quarter as old invoices age out of the
    // rolling lookback, so re-deriving it every run could silently flip a
    // confirmed renewal back to "not a renewal" and start paying it out.
    const renewalConfirmed = existingThisQuarterRow?.renewal_confirmed ?? priorQuarterRow?.renewal_confirmed ?? null;
    let renewalFlag = false;
    if (job.category === 'maintenance_snow') {
      renewalFlag = renewalConfirmed !== null
        ? renewalConfirmed === true
        : await looksLikeRenewal(job.saClientId, job.contractId, job.earliestDate);
      if (renewalFlag) results.renewalFlags++;
    }
    const isExcludedRenewal = renewalFlag && renewalConfirmed !== false;

    // ── Line-item assembly + subcontractor attribution ──────────────────
    const lineItems = (await Promise.all(
      job.underlyingInvoices.map(inv => fetchLineItemsForInvoice(inv.saId, inv.qboId))
    )).flat();

    const candidateMatches = matchBillsToJob(
      { clientName: job.clientName, dateStart: job.dateStart, dateEnd: job.dateEnd },
      vendorBills
    );

    // Carry forward confirmation status for lines matching a prior quarter's
    // row for this SAME job — commission_ledger_lines rows are per-quarter, so
    // without this a human's earlier confirmation would silently reset.
    const priorLineConfirmedByKey = new Map();
    if (rows.length) {
      const { data: priorLines, error: priorLinesError } = await fleetops
        .from('commission_ledger_lines')
        .select('sa_invoice_sa_id, qbo_line_description, line_amount, confirmed')
        .in('ledger_id', rows.map(r => r.id))
        .eq('category', 'subcontracted_candidate');
      if (priorLinesError) logger.warn('prior ledger lines lookup failed', { err: priorLinesError.message, saReference: job.saReference });
      for (const pl of priorLines ?? []) {
        priorLineConfirmedByKey.set(`${pl.sa_invoice_sa_id}|${pl.qbo_line_description}|${pl.line_amount}`, pl.confirmed);
      }
    }
    const currentLineKeys = new Set(lineItems.map(lineKeyOf));

    // Attribute each candidate bill match to its best-matching invoice line;
    // matches that can't be confidently pinned to a line (either no line
    // items exist for this job, or the best line was already claimed by an
    // earlier match) are tracked as unattributed IN THIS SAME PASS — not
    // recomputed later, which previously let an already-claimed match's
    // dollars count toward the fraction while getting neither a
    // commission_ledger_lines row nor a commission_sub_bill_flags row.
    const attributedLineKeys = new Set();
    const lineRecords = []; // rows to persist in commission_ledger_lines
    const unattributedMatches = [];
    let unattributedCandidateDollars = 0;

    for (const match of candidateMatches) {
      const line = lineItems.length ? bestLineMatch(match.billLineDescription, lineItems) : null;
      const lineKey = line ? lineKeyOf(line) : null;
      if (line && !attributedLineKeys.has(lineKey)) {
        attributedLineKeys.add(lineKey);
        lineRecords.push({
          sa_invoice_sa_id: line.saInvoiceSaId,
          qbo_line_description: line.description,
          qbo_item_name: line.itemName,
          line_amount: line.amount, // already rounded at extraction
          category: 'subcontracted_candidate',
          // Line-attribution confidence is a DIFFERENT question than "is this
          // bill really this client's" (match.matchConfidence) — bestLineMatch
          // has no confidence gradation of its own, so never claim 'high' for
          // the line question even when the underlying bill match was 'high'.
          match_confidence: match.matchConfidence === 'high' ? 'medium' : match.matchConfidence,
          confirmed: priorLineConfirmedByKey.get(lineKey) ?? false,
          vendor_name: match.vendorName,
          bill_qbo_id: match.qboBillId,
          bill_amount: round2(match.billAmount),
          bill_date: match.billDate,
        });
      } else {
        unattributedMatches.push(match);
        unattributedCandidateDollars += Number(match.billAmount || 0);
      }
    }
    // Remaining lines default to self-performed — UNLESS this exact line was
    // already flagged pending in a prior quarter and still isn't confirmed,
    // in which case it stays a pending candidate (carried forward with no
    // fresh bill match this run) so it doesn't silently vanish from the
    // review report while its cash is still being withheld.
    for (const line of lineItems) {
      const lineKey = lineKeyOf(line);
      if (attributedLineKeys.has(lineKey)) continue;
      const priorConfirmed = priorLineConfirmedByKey.get(lineKey);
      if (priorConfirmed === false) {
        lineRecords.push({
          sa_invoice_sa_id: line.saInvoiceSaId,
          qbo_line_description: line.description,
          qbo_item_name: line.itemName,
          line_amount: line.amount,
          category: 'subcontracted_candidate',
          match_confidence: 'low', // no fresh bill match this run — carried forward from an earlier flag only
          confirmed: false,
          vendor_name: null, bill_qbo_id: null, bill_amount: null, bill_date: null,
        });
      } else {
        lineRecords.push({
          sa_invoice_sa_id: line.saInvoiceSaId,
          qbo_line_description: line.description,
          qbo_item_name: line.itemName,
          line_amount: line.amount,
          category: 'self_performed',
          confirmed: false,
        });
      }
    }

    const attributedUnconfirmedDollars = lineRecords
      .filter(l => l.category === 'subcontracted_candidate' && !l.confirmed)
      .reduce((s, l) => s + Number(l.line_amount), 0);
    // A prior quarter's still-unconfirmed line that has genuinely disappeared
    // from this run's line items (not just unmatched — actually gone, e.g. the
    // invoice was edited) still gets honored here so its hold isn't dropped.
    // Lines still present get a fresh lineRecord above and are already counted
    // via attributedUnconfirmedDollars — this must exclude those to avoid
    // double-counting the same dollars in both buckets.
    const staleUnconfirmedDollars = [...priorLineConfirmedByKey.entries()]
      .filter(([key, confirmed]) => !confirmed && !currentLineKeys.has(key))
      .reduce((s, [key]) => {
        const amt = Number(key.split('|').pop());
        return s + (Number.isFinite(amt) ? amt : 0);
      }, 0);

    const unconfirmedFraction = job.invoicedAmount > 0
      ? Math.min(1, (attributedUnconfirmedDollars + staleUnconfirmedDollars + unattributedCandidateDollars) / job.invoicedAmount)
      : 0;
    const involvesSubcontractor = unconfirmedFraction > 0 || lineRecords.some(l => l.category === 'subcontracted_candidate');
    const pendingCount = lineRecords.filter(l => l.category === 'subcontracted_candidate' && !l.confirmed).length + unattributedMatches.length;
    results.subBillFlags += pendingCount;

    const priorCommissionedThrough = priorQuarterRow ? Number(priorQuarterRow.commissioned_through_amount) : 0;
    const incrementalPaid = Math.max(0, job.paidAmount - priorCommissionedThrough);
    const confirmedIncrementalPaid = incrementalPaid * (1 - unconfirmedFraction);

    // Accrued: full amount, booked once in the row for the earliest quarter on
    // record. A same-quarter re-run recomputes it (confirmation status may have
    // changed); a later quarter's row is always 0 — already accrued back then.
    const accruedCommission = isEarliestQuarter
      ? (isExcludedRenewal ? 0 : round2(rate * job.contractOrFirstYearValue))
      : Number(existingThisQuarterRow?.accrued_commission ?? 0);

    // Payable: commission on the CONFIRMED fraction of cash newly attributed
    // this run. Zeroed entirely while a renewal is unresolved; reduced by
    // unconfirmedFraction while any subcontractor involvement is unconfirmed —
    // resolving either later pays the full backlog in one run (see file header).
    const payableCommission = isExcludedRenewal ? 0 : round2(rate * confirmedIncrementalPaid);
    const commissionedThroughAmount = isExcludedRenewal
      ? priorCommissionedThrough
      : round2(priorCommissionedThrough + confirmedIncrementalPaid);

    // Never regress a status a human has already advanced past 'flagged' by
    // re-running the same quarter (e.g. to pick up a late invoice).
    const status = (existingThisQuarterRow?.status && existingThisQuarterRow.status !== 'flagged')
      ? existingThisQuarterRow.status
      : 'flagged';

    const { data: ledgerRow, error: upsertError } = await fleetops
      .from('commission_ledger')
      .upsert({
        employee_name: employeeName,
        category: job.category,
        sa_reference: job.saReference,
        sa_client_id: job.saClientId,
        client_name: job.clientName,
        contract_or_first_year_value: round2(job.contractOrFirstYearValue),
        invoiced_amount: round2(job.invoicedAmount),
        paid_amount: round2(job.paidAmount),
        paid_pct: Number(paidPct.toFixed(4)),
        commissioned_through_amount: commissionedThroughAmount,
        commission_rate: rate,
        accrued_commission: accruedCommission,
        payable_commission: payableCommission,
        involves_subcontractor: involvesSubcontractor,
        unconfirmed_subcontracted_fraction: Number(unconfirmedFraction.toFixed(4)),
        renewal_flag: renewalFlag,
        renewal_confirmed: renewalConfirmed,
        status,
        quarter: targetQuarter,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'sa_reference,quarter' })
      .select('id')
      .single();
    if (upsertError) { logger.warn('commission_ledger upsert failed', { err: upsertError.message, saReference: job.saReference }); continue; }
    results.written++;

    // Lines are regenerated fresh every run (rebuilt above from the current
    // line items + carried-forward confirmations) — delete the old set for
    // this ledger row first so re-running the same quarter (the monthly cron
    // re-fires the in-progress quarter every month; a change-request reply
    // also triggers a full re-run) never accumulates duplicate rows.
    const { error: deleteLinesError } = await fleetops.from('commission_ledger_lines').delete().eq('ledger_id', ledgerRow.id);
    if (deleteLinesError) logger.warn('commission_ledger_lines delete-before-insert failed', { err: deleteLinesError.message, saReference: job.saReference });
    if (lineRecords.length) {
      const { error: linesError } = await fleetops
        .from('commission_ledger_lines')
        .insert(lineRecords.map(l => ({ ...l, ledger_id: ledgerRow.id })));
      if (linesError) logger.warn('commission_ledger_lines insert failed', { err: linesError.message, saReference: job.saReference });
    }

    // Whole-invoice subcontractor-bill flags for matches that couldn't be
    // pinned to a specific line (tracked in the single attribution pass above,
    // not recomputed here) — same safety net as before line-item splitting existed.
    if (unattributedMatches.length) {
      const flagRows = unattributedMatches.map(match => ({
        ledger_id: ledgerRow.id,
        qbo_bill_id: match.qboBillId,
        vendor_name: match.vendorName,
        bill_amount: round2(match.billAmount),
        bill_date: match.billDate,
        match_confidence: match.matchConfidence,
      }));
      const { error: flagError } = await fleetops
        .from('commission_sub_bill_flags')
        .upsert(flagRows, { onConflict: 'ledger_id,qbo_bill_id', ignoreDuplicates: true });
      if (flagError) logger.warn('commission_sub_bill_flags upsert failed', { err: flagError.message });
    }
  }

  logger.info('Commission engine run complete', { quarter: targetQuarter, ...results });
  return { quarter: targetQuarter, ...results };
}
