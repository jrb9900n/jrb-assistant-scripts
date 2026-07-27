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
// jobs are matched against QBO vendor bills as CANDIDATES ONLY and flagged for
// manual confirmation. The cap is never auto-applied; see "subcontractor
// withholding" below for how this stays safe in the meantime.
//
// PM attribution comes from pm_job_assignments (manual — see that table's
// comment for why: no SA or FieldOps field reliably identifies "who sent this
// estimate" today).
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
//     commission paid out against it. It only advances to paid_amount when the
//     job is NOT withheld. While withheld (a pending renewal, or unconfirmed
//     subcontractor involvement), it stays frozen — so once the hold clears,
//     the full backlog becomes payable in one catch-up run instead of the cash
//     collected during the hold being silently skipped forever.
// Renewal-pending zeroes BOTH accrued and payable (a confirmed renewal earns
// nothing at all). Subcontractor-pending only withholds payable — accrued still
// books the full uncapped rate as a conservative liability estimate, since some
// non-zero amount will definitely be owed once the 20% cap is confirmed, and
// overstating a liability is the safe direction for the accountant's books.

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

// ── PM attribution ─────────────────────────────────────────────
// Priority: assignment tied to this specific invoice > this contract > this client.
// Ordered by assigned_at desc so a reassignment (a second row, not an edit to
// the first — the table is append-only by design) resolves to the latest one.
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
    .select('sa_id, client, customer_id, contract_id, invoice_total, invoice_balance, frequency, date')
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
    });
  }
  return jobs;
}

async function assembleSelfPerformedJobs() {
  const lookbackDate = dateStr(LOOKBACK_DAYS);
  const { data: rows, error } = await fleetops
    .from('sa_invoices')
    .select('sa_id, client, customer_id, invoice_total, invoice_balance, date')
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
    // renewal stickiness, the quarter-chronology baseline, and detecting
    // still-unconfirmed subcontractor flags from an earlier quarter's row.
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

    // Subcontractor-cost candidate matching, computed BEFORE the upsert so
    // involvement is known upfront rather than requiring a second write.
    const candidateMatches = matchBillsToJob(
      { clientName: job.clientName, dateStart: job.dateStart, dateEnd: job.dateEnd },
      vendorBills
    );
    const freshlyInvolvesSubcontractor = candidateMatches.length > 0;

    // A prior quarter's still-unconfirmed flag also withholds pay, even if this
    // run's fuzzy match doesn't re-find the same bill (sub_bill_flags are tied
    // to that quarter's ledger_id, so they don't automatically carry forward).
    let hasUnconfirmedPriorFlag = false;
    if (rows.length) {
      const { data: openFlags, error: flagsError } = await fleetops
        .from('commission_sub_bill_flags')
        .select('id')
        .in('ledger_id', rows.map(r => r.id))
        .eq('confirmed', false)
        .limit(1);
      if (flagsError) logger.warn('prior sub-bill-flag lookup failed', { err: flagsError.message, saReference: job.saReference });
      hasUnconfirmedPriorFlag = (openFlags ?? []).length > 0;
    }
    const involvesSubcontractor = freshlyInvolvesSubcontractor || hasUnconfirmedPriorFlag;
    const isSubCapPending = involvesSubcontractor; // withholds payable only — see header comment

    const priorCommissionedThrough = priorQuarterRow ? Number(priorQuarterRow.commissioned_through_amount) : 0;
    const incrementalPaid = Math.max(0, job.paidAmount - priorCommissionedThrough);

    // Accrued: full amount, booked once in the row for the earliest quarter on
    // record. A same-quarter re-run recomputes it (confirmation status may have
    // changed); a later quarter's row is always 0 — already accrued back then.
    const accruedCommission = isEarliestQuarter
      ? (isExcludedRenewal ? 0 : round2(rate * job.contractOrFirstYearValue))
      : Number(existingThisQuarterRow?.accrued_commission ?? 0);

    // Payable: commission on cash newly attributed this run. Withheld (frozen
    // baseline, $0 payable) while a renewal is unresolved OR subcontractor
    // involvement is unconfirmed — resolving either later pays the full
    // backlog in one run rather than losing it.
    const isWithheld = isExcludedRenewal || isSubCapPending;
    const payableCommission = isWithheld ? 0 : round2(rate * incrementalPaid);
    const commissionedThroughAmount = isWithheld ? priorCommissionedThrough : round2(job.paidAmount);

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

    if (freshlyInvolvesSubcontractor) {
      const flagRows = candidateMatches.map(match => ({
        ledger_id: ledgerRow.id,
        qbo_bill_id: match.qboBillId,
        vendor_name: match.vendorName,
        bill_amount: match.billAmount,
        bill_date: match.billDate,
        match_confidence: match.matchConfidence,
      }));
      const { error: flagError, data: flagData } = await fleetops
        .from('commission_sub_bill_flags')
        .upsert(flagRows, { onConflict: 'ledger_id,qbo_bill_id', ignoreDuplicates: true })
        .select('id');
      if (flagError) logger.warn('commission_sub_bill_flags upsert failed', { err: flagError.message });
      else results.subBillFlags += flagData?.length ?? 0;
    }
  }

  logger.info('Commission engine run complete', { quarter: targetQuarter, ...results });
  return { quarter: targetQuarter, ...results };
}
