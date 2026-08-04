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
const JOB_MATCH_WINDOW_DAYS = 45; // sa_jobs.invoice_id is often still the placeholder for recently-completed jobs; a job completed within this many days of the invoice is treated as its likely source
const SA_EMPTY_GUID = '00000000-0000-0000-0000-000000000000';

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

// Last calendar day of a quarter, e.g. '2026-Q2' -> '2026-06-30'.
function quarterEndDate(quarterStr) {
  const [year, q] = quarterStr.split('-Q').map(Number);
  const endMonth = q * 3; // 3, 6, 9, 12
  const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate(); // day 0 of next month = last day of endMonth
  return `${year}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

// Cash actually collected on a set of invoices BY a given date — used only
// for the quarter-end close (isFinal), where "payable this quarter" must
// mean cash that landed by quarter-end, not however much happens to be paid
// by whenever the close actually runs. Without this, a payment landing after
// quarter-end (e.g. collected in July against a Q2 job) would get counted as
// Q2 payable just because the close ran after the money arrived — caught by
// Michael 2026-08-04 on three real Q2 jobs (Jason Carver, Kelley Sovol, Laura
// Ramos) all paid after 6/30. sa_invoices.invoice_balance (used for the live
// job.paidAmount elsewhere in this file) has no such cutoff; it's always
// "as of now." payment_date is stored as text (YYYY-MM-DD, same caveat as
// fetchJobDetails' datePaid) so lexicographic comparison against the cutoff
// works.
// taxScale (see stripTax) converts a raw/tax-inclusive cash amount into the
// same pre-tax basis as job.invoicedAmount, so incrementalPaid stays
// consistent regardless of which source below actually answered.
async function fetchPaidAmountAsOf(underlyingInvoices, asOfDate, qboPaymentIndex, taxScale) {
  if (!underlyingInvoices.length) return 0;
  const invoiceIds = underlyingInvoices.map(inv => inv.saId);

  // Manual escape hatch first (see commission_payment_overrides' own
  // migration for why this exists) — an override always wins for its invoice,
  // regardless of what the sync does or doesn't know.
  const { data: overrides, error: overridesError } = await fleetops
    .from('commission_payment_overrides')
    .select('sa_invoice_sa_id, paid_amount_confirmed, as_of_date')
    .in('sa_invoice_sa_id', invoiceIds);
  if (overridesError) throw new Error(`fetchPaidAmountAsOf commission_payment_overrides query failed: ${overridesError.message}`);
  const overrideByInvoice = new Map((overrides ?? []).map(o => [o.sa_invoice_sa_id, o]));
  let total = [...overrideByInvoice.values()]
    .filter(o => o.as_of_date <= asOfDate)
    .reduce((sum, o) => sum + Number(o.paid_amount_confirmed || 0) * taxScale, 0);

  const remaining = underlyingInvoices.filter(inv => !overrideByInvoice.has(inv.saId));
  if (!remaining.length) return round2(total);

  // QBO payment data next (see buildQboPaymentIndex) — far more complete than
  // sa_payment_applications in practice (real gap found 2026-08-04: several
  // fully-paid invoices — Jason Carver x2, Kelley Sovol, Laura Ramos, Joyce
  // Aldon — have zero rows in sa_payment_applications at all, but all of
  // them are present here).
  const stillRemaining = [];
  for (const inv of remaining) {
    const qboPayments = qboPaymentIndex.get(inv.qboId);
    if (!qboPayments?.length) { stillRemaining.push(inv); continue; }
    total += qboPayments
      .filter(p => p.date && p.date <= asOfDate)
      .reduce((sum, p) => sum + p.amount * taxScale, 0);
  }
  if (!stillRemaining.length) return round2(total);

  const stillRemainingIds = stillRemaining.map(inv => inv.saId);
  const { data: apps, error } = await fleetops
    .from('sa_payment_applications')
    .select('invoice_sa_id, payment_sa_id, amount_applied')
    .in('invoice_sa_id', stillRemainingIds);
  if (error) throw new Error(`fetchPaidAmountAsOf sa_payment_applications query failed: ${error.message}`);
  const paymentIds = [...new Set((apps ?? []).map(a => a.payment_sa_id).filter(Boolean))];
  if (!paymentIds.length) return round2(total);

  const { data: payments, error: paymentsError } = await fleetops
    .from('sa_payments').select('sa_id, payment_date').in('sa_id', paymentIds);
  if (paymentsError) throw new Error(`fetchPaidAmountAsOf sa_payments query failed: ${paymentsError.message}`);
  const dateById = new Map((payments ?? []).map(p => [p.sa_id, p.payment_date]));

  // No signal at all (no override, no QBO payment link, no SA payment
  // application) means we don't know when it was paid — deliberately NOT
  // falling back to the live invoice_balance-derived total here, since
  // "unknown timing" must not silently resolve to "definitely paid by
  // quarter-end" for a payout.
  total += (apps ?? []).reduce((sum, a) => {
    const paymentDate = dateById.get(a.payment_sa_id);
    if (!paymentDate || paymentDate > asOfDate) return sum;
    return sum + Number(a.amount_applied || 0) * taxScale;
  }, 0);
  return round2(total);
}

// Sales tax on an invoice is not part of the job's value for commission
// purposes -- pulled from qb_invoices.raw_data.TxnTaxDetail.TotalTax (already
// synced, no live API call) rather than sa_invoices, which has no tax field
// of its own. Batched over every qbo_id in a single call, mirroring the
// prefetch-once pattern used elsewhere in this file (assignmentIndex,
// estimatesByClient, vendorBills) instead of one query per invoice.
const IN_CLAUSE_CHUNK_SIZE = 200; // a company-wide scan's qbo_id set can run into the thousands -- PostgREST's GET-encoded .in() rejects an unbounded list with a 400

async function fetchTaxByQboId(qboIds) {
  const uniqueIds = [...new Set(qboIds.filter(Boolean))];
  if (!uniqueIds.length) return new Map();
  const taxByQboId = new Map();
  for (let i = 0; i < uniqueIds.length; i += IN_CLAUSE_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + IN_CLAUSE_CHUNK_SIZE);
    const { data, error } = await fleetops.from('qb_invoices').select('qb_id, raw_data').in('qb_id', chunk);
    if (error) throw new Error(`fetchTaxByQboId query failed: ${error.message}`);
    for (const r of data ?? []) taxByQboId.set(r.qb_id, Number(r.raw_data?.TxnTaxDetail?.TotalTax ?? 0));
  }
  return taxByQboId;
}

// Removes sales tax from an invoice_total/invoice_balance pair, scaling the
// balance (and therefore paidAmount = total - balance) proportionally --
// there's no per-line tax breakdown of which dollars are still outstanding,
// so an even split across the whole invoice is the best available estimate,
// consistent with how paidPct etc. already approximate elsewhere in this file.
function stripTax(invoiceTotal, invoiceBalance, taxAmount) {
  const preTaxTotal = round2(Math.max(0, invoiceTotal - taxAmount));
  const scale = invoiceTotal > 0 ? preTaxTotal / invoiceTotal : 1;
  return { preTaxTotal, preTaxBalance: round2(invoiceBalance * scale), scale };
}

// QuickBooks Payment objects carry their own LinkedTxn back to the invoice(s)
// they paid off -- this turned out to be a far more complete data source for
// "when was this actually paid" than sa_payment_applications/sa_payments
// (found 2026-08-04: several fully-paid invoices — Jason Carver x2, Kelley
// Sovol, Laura Ramos, Joyce Aldon — have ZERO rows in sa_payment_applications
// at all, but their real payment dates are all present here). Built once per
// run (qb_payments is a few thousand rows in the lookback window, no live API
// call) rather than queried per job. Keyed by the QBO invoice id (Payment
// Line[].LinkedTxn[].TxnId), value is every {date, amount} applied to that
// invoice (a single payment can split across several invoices, one Line per
// invoice, so amount is the per-line applied amount, not the payment total).
async function buildQboPaymentIndex() {
  const lookbackDate = dateStr(LOOKBACK_DAYS + 120); // payments can land well after an invoice's own lookback-bounded date
  const { data, error } = await fleetops.from('qb_payments').select('date, raw_data').gte('date', lookbackDate);
  if (error) throw new Error(`buildQboPaymentIndex query failed: ${error.message}`);
  const index = new Map();
  for (const payment of data ?? []) {
    for (const line of payment.raw_data?.Line ?? []) {
      for (const txn of line?.LinkedTxn ?? []) {
        if (!txn?.TxnId) continue;
        if (!index.has(txn.TxnId)) index.set(txn.TxnId, []);
        index.get(txn.TxnId).push({ date: payment.date, amount: Number(line.Amount ?? 0) });
      }
    }
  }
  return index;
}

// Latest known payment date for a job from the QBO payment index, across all
// of its underlying invoices.
function latestQboPaymentDate(underlyingInvoices, qboPaymentIndex) {
  const dates = underlyingInvoices
    .flatMap(inv => qboPaymentIndex.get(inv.qboId) ?? [])
    .map(p => p.date)
    .filter(Boolean);
  return dates.length ? dates.sort().at(-1) : null;
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

// ── Job detail (service, estimate, dates) for report readability ───────────
// Only called for jobs that have already cleared PM + plan resolution (i.e.
// commission-eligible jobs — a small subset of the company-wide scan), so
// this doesn't add meaningful N+1 cost across the full job list.
async function fetchJobDetails(job, { qboPaymentIndex } = {}) {
  const invoiceIds = job.underlyingInvoices.map(inv => inv.saId);

  const lineItems = (await Promise.all(
    job.underlyingInvoices.map(inv => fetchLineItemsForInvoice(inv.saId, inv.qboId))
  )).flat();
  // Prefer the QBO item name ("Grading", "Topsoil", "Hardscape Installation")
  // over the free-text line description, which is often blank or generic —
  // falls back to description only when no item name exists at all. QBO's
  // item names are full category paths ("Landscape:Landscape
  // Enhancements:Topsoil") — only the last segment is the actual item.
  const computedLineItemNames = [...new Set(
    lineItems.map(l => (l.itemName || l.description).split(':').pop().trim()).filter(Boolean)
  )].join(', ') || null;

  const [jobsResult, estimateResult, paymentAppsResult, invoicesResult, lineItemOverrideResult] = await Promise.all([
    fleetops.from('sa_jobs').select('service, date_completed').in('invoice_id', invoiceIds),
    // No direct FK from an invoice to its originating estimate — best-effort:
    // the client's accepted estimate closest to (and no later than) this job's
    // earliest date. Same limitation as resolvePM's scraping fallback.
    fleetops.from('sa_accepted_estimates')
      .select('estimate_number, quote_date')
      .eq('client_id', job.saClientId)
      .lte('quote_date', job.earliestDate)
      .order('quote_date', { ascending: false })
      .limit(1)
      .maybeSingle(),
    fleetops.from('sa_payment_applications').select('payment_sa_id').in('invoice_sa_id', invoiceIds),
    // For self_performed jobs there's exactly one underlying invoice; for a
    // maintenance_snow contract row (many invoices) this shows the EARLIEST
    // one, matching the "first-year value" basis used elsewhere for that
    // category — a contract row's Invoice #/Date is representative, not
    // exhaustive.
    fleetops.from('sa_invoices').select('invoice_number, date').in('sa_id', invoiceIds).order('date', { ascending: true }).limit(1).maybeSingle(),
    // Manual escape hatch for when QBO's own line data doesn't resolve at all
    // (see commission_line_item_overrides' own migration).
    fleetops.from('commission_line_item_overrides').select('line_item_name').in('sa_invoice_sa_id', invoiceIds).limit(1).maybeSingle(),
  ]);
  const lineItemNames = lineItemOverrideResult.data?.line_item_name ?? computedLineItemNames;

  if (jobsResult.error) logger.warn('fetchJobDetails sa_jobs query failed', { err: jobsResult.error.message, saReference: job.saReference });
  if (estimateResult.error) logger.warn('fetchJobDetails sa_accepted_estimates query failed', { err: estimateResult.error.message, saReference: job.saReference });
  if (paymentAppsResult.error) logger.warn('fetchJobDetails sa_payment_applications query failed', { err: paymentAppsResult.error.message, saReference: job.saReference });
  if (invoicesResult.error) logger.warn('fetchJobDetails sa_invoices query failed', { err: invoicesResult.error.message, saReference: job.saReference });
  if (lineItemOverrideResult.error) logger.warn('fetchJobDetails commission_line_item_overrides query failed', { err: lineItemOverrideResult.error.message, saReference: job.saReference });

  const jobRows = jobsResult.data ?? [];
  const serviceNames = [...new Set(jobRows.map(r => r.service).filter(Boolean))].join(', ') || null;
  const dateCompleted = jobRows.map(r => r.date_completed).filter(Boolean).sort().at(-1) ?? null;

  // QBO's own payment records first (see buildQboPaymentIndex — far more
  // complete in practice than the sa_payment_applications join below).
  let datePaid = qboPaymentIndex ? latestQboPaymentDate(job.underlyingInvoices, qboPaymentIndex) : null;

  if (!datePaid) {
    const paymentSaIds = [...new Set((paymentAppsResult.data ?? []).map(r => r.payment_sa_id).filter(Boolean))];
    if (paymentSaIds.length) {
      const { data: payments, error: paymentsError } = await fleetops
        .from('sa_payments').select('payment_date').in('sa_id', paymentSaIds);
      if (paymentsError) logger.warn('fetchJobDetails sa_payments query failed', { err: paymentsError.message, saReference: job.saReference });
      // payment_date is stored as text — sorting lexicographically works only
      // because SA's sync writes it as YYYY-MM-DD; if that ever changes this
      // would need real date parsing.
      datePaid = (payments ?? []).map(p => p.payment_date).filter(Boolean).sort().at(-1) ?? null;
    }
  }

  if (!datePaid) {
    const { data: overrides, error: overridesError } = await fleetops
      .from('commission_payment_overrides').select('as_of_date').in('sa_invoice_sa_id', invoiceIds)
      .order('as_of_date', { ascending: false }).limit(1).maybeSingle();
    if (overridesError) logger.warn('fetchJobDetails commission_payment_overrides query failed', { err: overridesError.message, saReference: job.saReference });
    datePaid = overrides?.as_of_date ?? null;
  }

  return {
    serviceNames,
    lineItemNames,
    estimateNumber: estimateResult.data?.estimate_number ?? null,
    estimateDate: estimateResult.data?.quote_date ?? null,
    invoiceNumber: invoicesResult.data?.invoice_number ?? null,
    invoiceDate: invoicesResult.data?.date ?? null,
    dateCompleted,
    datePaid,
  };
}

// SA raw payloads use M/D/YYYY (no leading zeros) rather than ISO — e.g. sa_jobs.raw_json.EndDate.
function parseSaDate(mdy) {
  if (!mdy) return null;
  const [m, d, y] = mdy.split('/').map(Number);
  if (!m || !d || !y) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

// ── Job-level PM attribution (2026-07-30) ───────────────────────────────────
// sa_jobs carries a real, per-job SalesRep in raw_json (the flattened
// sales_rep COLUMN isn't populated by the current sync — a separate mapping
// gap, worth fixing in the sync script itself) reflecting who actually
// owns/sold that specific service ticket. This is ground truth where it
// exists, unlike the estimate-date heuristic below, which has now been caught
// picking the wrong estimate twice (Celia Shaughnessy, Lori Pegelow) when a
// client has multiple people quoting different work over time — a multi-line
// estimate invoiced incrementally over months, or a second estimate for
// unrelated work, both defeat pure date-proximity matching. Confirmed this
// field is NEVER populated for jobs generated under a signed recurring
// contract (0 of 155 real job records on an active maintenance contract) —
// nobody "sells" each individual recurring visit — so this only applies to
// self_performed (non-contract) jobs; contract jobs still rely on the
// estimate scrape, since no per-visit signal exists there at all.
// fuzzyCandidateCache: Map<saClientId, Array<{salesRep, endDate}>>, one query
// per customer per run instead of one per invoice — a company-wide scan calls
// this for every self_performed job, and without caching, a customer with
// several invoices this quarter re-fetched and re-parsed the same full job
// history once per invoice (confirmed a real memory/latency cost, not just
// theoretical, on a run that OOM'd — this codebase already runs on a
// memory-constrained shared machine). Also select only the two jsonb fields
// actually used instead of the whole raw_json blob (which carries dozens of
// unused fields per job), cutting transferred/retained payload further.
async function findJobLevelSalesRep({ saClientId, invoiceSaId, invoiceDate, fuzzyCandidateCache }) {
  // Exact match: sa_jobs.invoice_id already backfilled to this specific invoice.
  const { data: exactRows, error: exactError } = await fleetops
    .from('sa_jobs')
    .select('sales_rep:raw_json->>SalesRep')
    .eq('invoice_id', invoiceSaId);
  if (exactError) { logger.warn('findJobLevelSalesRep exact lookup failed', { err: exactError.message }); return null; }
  const exactReps = [...new Set((exactRows ?? []).map(r => r.sales_rep).filter(Boolean))];
  if (exactReps.length === 1) return { employeeName: exactReps[0], confidence: 'job_confirmed' };
  if (exactReps.length > 1) {
    logger.warn('findJobLevelSalesRep: exact invoice match has conflicting sales reps — not guessing', { invoiceSaId, exactReps });
    return null;
  }

  // sa_jobs.invoice_id is frequently still SA's null-GUID placeholder for
  // recently-completed jobs — captured by the sync before SA backfills the
  // real invoice link (see the sa_jobs staleness note elsewhere in this
  // codebase). Fall back to the same customer's placeholder-invoice jobs
  // within a tight window of the invoice date.
  if (!saClientId || !invoiceDate) return null;

  let candidates = fuzzyCandidateCache?.get(saClientId);
  if (candidates === undefined) {
    const { data: candidateRows, error: candidateError } = await fleetops
      .from('sa_jobs')
      .select('sales_rep:raw_json->>SalesRep, end_date:raw_json->>EndDate')
      .eq('customer_id', saClientId)
      .eq('invoice_id', SA_EMPTY_GUID);
    if (candidateError) {
      logger.warn('findJobLevelSalesRep fuzzy lookup failed', { err: candidateError.message });
      candidates = [];
    } else {
      candidates = (candidateRows ?? [])
        .filter(r => r.sales_rep)
        .map(r => ({ salesRep: r.sales_rep, endDate: parseSaDate(r.end_date) }))
        .filter(r => r.endDate);
    }
    fuzzyCandidateCache?.set(saClientId, candidates);
  }

  const invoiceDateMs = new Date(invoiceDate + 'T00:00:00Z').getTime();
  const windowMs = JOB_MATCH_WINDOW_DAYS * 86400000;
  const nearbyReps = [...new Set(
    candidates
      .filter(j => Math.abs(invoiceDateMs - j.endDate.getTime()) <= windowMs)
      .map(j => j.salesRep)
  )];
  if (nearbyReps.length === 1) return { employeeName: nearbyReps[0], confidence: 'job_fuzzy_matched' };
  // Zero or multiple distinct reps nearby — no coverage, or genuinely ambiguous.
  // Either way, don't guess; fall through to the (lower-confidence) estimate scrape.
  return null;
}

// Fetches the whole table once per run instead of up to 3 queries PER JOB —
// confirmed a real, unbounded-with-run-length memory growth (a run crashed
// faster when given a smaller --max-old-space-size ceiling, the signature of
// genuine accumulation rather than incidental system memory pressure): the
// manual-assignment lookup alone ran unconditionally for every job in a
// company-wide scan of ~3,000 jobs, up to 3 requests each. Both tables are
// small (927 / 2,828 rows as of 2026-07-30) — cheap to hold in memory for a
// single run.
async function buildAttributionIndexes() {
  const { data: allAssignments, error: assignError } = await fleetops
    .from('pm_job_assignments')
    .select('sa_invoice_sa_id, sa_contract_id, sa_client_id, employee_name, source, confidence, assigned_at')
    .order('assigned_at', { ascending: true }); // ascending: later rows overwrite earlier ones below, matching "most recent wins"
  if (assignError) throw new Error(`pm_job_assignments prefetch failed: ${assignError.message}`);

  const assignmentIndex = { byInvoice: new Map(), byContract: new Map(), byClient: new Map() };
  for (const row of allAssignments ?? []) {
    const entry = { employeeName: row.employee_name, source: row.source, confidence: row.confidence };
    if (row.sa_invoice_sa_id) assignmentIndex.byInvoice.set(row.sa_invoice_sa_id, entry);
    if (row.sa_contract_id) assignmentIndex.byContract.set(row.sa_contract_id, entry);
    if (row.sa_client_id) assignmentIndex.byClient.set(row.sa_client_id, entry);
  }

  const { data: allEstimates, error: estError } = await fleetops
    .from('sa_accepted_estimates')
    .select('client_id, sales_rep, estimate_id, quote_date')
    .not('sales_rep', 'is', null)
    .neq('sales_rep', '—')
    .order('quote_date', { ascending: true }); // ascending: lets resolvePM scan and stop at the first one past earliestDate
  if (estError) throw new Error(`sa_accepted_estimates prefetch failed: ${estError.message}`);

  const estimatesByClient = new Map();
  for (const row of allEstimates ?? []) {
    if (!estimatesByClient.has(row.client_id)) estimatesByClient.set(row.client_id, []);
    estimatesByClient.get(row.client_id).push(row);
  }

  return { assignmentIndex, estimatesByClient };
}

// ── PM attribution ─────────────────────────────────────────────
// Priority: assignment tied to this specific invoice > this contract > this
// client > job-level SalesRep (self_performed only, see findJobLevelSalesRep)
// > scraped from the client's original accepted estimate. The manual tiers
// and the estimate scrape both read from indexes prefetched once for the
// whole run (see buildAttributionIndexes) rather than querying per job.
// Returns { employeeName, confidence } or null. confidence is one of
// 'manual' | 'job_confirmed' | 'job_fuzzy_matched' | 'estimate_scrape' — see
// the 20260801_commission_pm_confidence.sql migration. Only 'estimate_scrape'
// (the fallible date-proximity guess, caught wrong 3 times against real data:
// Sterling Pharma, Celia Shaughnessy, Lori Pegelow) withholds payable
// commission pending human confirmation; everything else is trusted.
async function resolvePM({ saClientId, contractId, invoiceSaId, earliestDate, isContractJob, fuzzyCandidateCache, assignmentIndex, estimatesByClient }) {
  const manualMatch =
    (invoiceSaId && assignmentIndex.byInvoice.get(invoiceSaId)) ||
    (contractId && assignmentIndex.byContract.get(contractId)) ||
    (saClientId && assignmentIndex.byClient.get(saClientId));
  if (manualMatch) {
    // A row written before this confidence column existed has confidence=null
    // — treat it the same as 'estimate_scrape' (least trusted) rather than
    // assuming it's safe, since we can't tell retroactively which tier wrote it.
    const confidence = manualMatch.source === 'manual' ? 'manual' : (manualMatch.confidence ?? 'estimate_scrape');
    return { employeeName: manualMatch.employeeName, confidence };
  }

  // No manual assignment exists yet — try real job-level data before falling
  // back to guessing off an estimate. Contract jobs skip this entirely (no
  // per-visit signal exists there — see findJobLevelSalesRep).
  if (!isContractJob && invoiceSaId) {
    const jobLevel = await findJobLevelSalesRep({ saClientId, invoiceSaId, invoiceDate: earliestDate, fuzzyCandidateCache });
    if (jobLevel?.employeeName) {
      const { error: insertError } = await fleetops.from('pm_job_assignments').insert({
        sa_invoice_sa_id: invoiceSaId,
        employee_name: jobLevel.employeeName,
        source: 'sa_signal',
        confidence: jobLevel.confidence,
        notes: `Matched from sa_jobs.raw_json.SalesRep (${jobLevel.confidence})`,
      });
      if (insertError) logger.warn('pm_job_assignments job-level insert failed', { err: insertError.message });
      return { employeeName: jobLevel.employeeName, confidence: jobLevel.confidence };
    }
  }

  // No job-level signal either — scrape the rep off the estimate that
  // actually preceded (and could plausibly have won) THIS job, not just
  // "whichever estimate is most recent for the client overall."
  // Fixed 2026-07-29 after a real misattribution: Sterling Pharma's March 2026
  // maintenance contract (won by Michael Reardon, per estimate #4975) got
  // attributed to Jarrett Bruce because a LATER, unrelated May estimate
  // (#5325, actually his) was the client's most-recent accepted estimate at
  // scrape time — the old query had no upper bound on quote_date at all.
  // sa_accepted_estimates is synced daily by the existing overnight_sa_report
  // cron and already carries a resolved employee name (not a raw SA rep GUID)
  // in sales_rep. Still caught wrong since (Celia Shaughnessy, Lori Pegelow) —
  // this whole tier is 'estimate_scrape' confidence, payable withheld until
  // confirmed (see runCommissionEngine's main loop).
  if (saClientId && earliestDate) {
    // estimatesByClient's per-client array is sorted ascending by quote_date
    // (see buildAttributionIndexes) — scan forward and keep the last row still
    // <= earliestDate, i.e. the closest-but-not-after match.
    let estRow = null;
    for (const row of (estimatesByClient.get(saClientId) ?? [])) {
      if (row.quote_date > earliestDate) break;
      estRow = row;
    }
    if (estRow?.sales_rep) {
      // Scoped to the most specific identifier available (contract/invoice),
      // NOT sa_client_id — a client-wide row would incorrectly apply this same
      // attribution to any OTHER job/contract for the same client later on,
      // exactly the bug being fixed here. Only falls back to client-wide
      // scoping if no more specific identifier exists for this job at all.
      const scopeCols = (contractId || invoiceSaId)
        ? { sa_contract_id: contractId ?? null, sa_invoice_sa_id: invoiceSaId ?? null }
        : { sa_client_id: saClientId };
      const { error: insertError } = await fleetops.from('pm_job_assignments').insert({
        ...scopeCols,
        employee_name: estRow.sales_rep,
        source: 'sa_signal',
        confidence: 'estimate_scrape',
        notes: `Scraped from accepted estimate ${estRow.estimate_id}`,
      });
      // Duplicate-insert races (two jobs for the same brand-new client resolving
      // concurrently) are harmless — both attribute the same employee_name either way.
      if (insertError) logger.warn('pm_job_assignments sa_signal insert failed', { err: insertError.message });
      return { employeeName: estRow.sales_rep, confidence: 'estimate_scrape' };
    }
  }
  return null;
}

// ── Estimate-first coverage check (2026-08-04) ──────────────────────────────
// The main engine works backward from invoices (scan every company invoice,
// then guess who sold it) — that guessing is exactly what caused the Sterling
// Pharma/Celia Shaughnessy/Lori Pegelow misattributions. This works forward
// instead, starting from ground truth (sa_accepted_estimates.sales_rep) for
// the small set of estimates a given employee actually won, and checks
// whether each one ever produced a commission_ledger row — surfacing any
// that haven't as a coverage gap rather than letting a won job silently
// never appear in a report (this is how the Sterling enhancement job went
// unreported for a full report cycle: it was correctly in the ledger, the
// report just wasn't regenerated after it landed). estimate_number linkage
// is the same best-effort match fetchJobDetails/resolvePM already rely on
// elsewhere in this file — not a strict FK — so this is a coverage signal to
// review, not proof that something is actually wrong with any given estimate.
export async function findUnmatchedWonEstimates({ employeeName, lookbackDays = LOOKBACK_DAYS } = {}) {
  const cutoff = dateStr(lookbackDays);
  const { data: estimates, error } = await fleetops
    .from('sa_accepted_estimates')
    .select('estimate_id, estimate_number, client_name, client_id, amount, quote_date')
    .eq('sales_rep', employeeName)
    .gte('quote_date', cutoff);
  if (error) throw new Error(`findUnmatchedWonEstimates estimates query failed: ${error.message}`);

  const estimateNumbers = [...new Set((estimates ?? []).map(e => e.estimate_number).filter(Boolean))];
  if (!estimateNumbers.length) return [];

  const [tracedResult, resolutionsResult] = await Promise.all([
    fleetops.from('commission_ledger').select('estimate_number').in('estimate_number', estimateNumbers),
    // sa_accepted_estimates ("accepted") turns out to include estimates that
    // are merely sent, or later lost -- resolved_at/resolved_reason are null
    // for every row checked so far, so SA gives no reliable won/lost signal.
    // estimate_resolutions is where a human records that once (see its own
    // migration) instead of re-explaining the same estimate every cycle.
    fleetops.from('estimate_resolutions').select('estimate_number, resolution, note').in('estimate_number', estimateNumbers),
  ]);
  if (tracedResult.error) throw new Error(`findUnmatchedWonEstimates ledger query failed: ${tracedResult.error.message}`);
  if (resolutionsResult.error) throw new Error(`findUnmatchedWonEstimates resolutions query failed: ${resolutionsResult.error.message}`);
  const tracedSet = new Set((tracedResult.data ?? []).map(r => r.estimate_number).filter(Boolean));
  const resolutionByEstimate = new Map((resolutionsResult.data ?? []).map(r => [r.estimate_number, r]));

  return (estimates ?? [])
    .filter(e => e.estimate_number && !tracedSet.has(e.estimate_number))
    .map(e => ({ ...e, resolution: resolutionByEstimate.get(e.estimate_number) }))
    // 'lost'/'sent_only'/'invoiced' are fully resolved -- don't keep flagging
    // them every run. 'in_progress' still surfaces (with its note) since it's
    // real, ongoing, uninvoiced work worth tracking, just not an error.
    .filter(e => !e.resolution || e.resolution.resolution === 'in_progress')
    .map(e => ({
      estimateId: e.estimate_id,
      estimateNumber: e.estimate_number,
      clientName: e.client_name,
      clientId: e.client_id,
      amount: Number(e.amount || 0),
      quoteDate: e.quote_date,
      inProgressNote: e.resolution?.note ?? null,
    }));
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

  // Sales tax is not part of a job's value for commission purposes (Michael,
  // 2026-08-04) — stripped per invoice before grouping/summing.
  const taxByQboId = await fetchTaxByQboId((rows ?? []).map(r => r.qbo_id));

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
    const earliestPreTax = stripTax(Number(earliest.invoice_total || 0), 0, taxByQboId.get(earliest.qbo_id) ?? 0);
    let invoicedAmount = 0, paidAmount = 0, rawTotal = 0;
    for (const r of contractRows) {
      const total = Number(r.invoice_total || 0);
      const { preTaxTotal, preTaxBalance } = stripTax(total, Number(r.invoice_balance || 0), taxByQboId.get(r.qbo_id) ?? 0);
      invoicedAmount += preTaxTotal;
      paidAmount += preTaxTotal - preTaxBalance;
      rawTotal += total;
    }

    jobs.push({
      category: 'maintenance_snow',
      saReference: `contract:${contractKey}`,
      saClientId: latest.customer_id,
      contractId: latest.contract_id,
      invoiceSaId: null,
      clientName: latest.client,
      contractOrFirstYearValue: annualizeContractValue(earliestPreTax.preTaxTotal, earliest.frequency),
      invoicedAmount: round2(invoicedAmount),
      paidAmount: round2(paidAmount),
      // Approximate — a multi-invoice contract can mix different tax rates
      // across its constituent invoices; weighted by total value here rather
      // than tracked per-invoice, since fetchPaidAmountAsOf only needs one
      // scalar per job (self_performed, the only category Jarrett has today,
      // always has exactly one invoice, where this is exact).
      taxScale: rawTotal > 0 ? invoicedAmount / rawTotal : 1,
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

  // Sales tax is not part of a job's value for commission purposes (Michael,
  // 2026-08-04) — stripped per invoice from qb_invoices.raw_data.TxnTaxDetail.
  const taxByQboId = await fetchTaxByQboId((rows ?? []).map(r => r.qbo_id));

  return (rows ?? []).map(row => {
    const total = Number(row.invoice_total || 0);
    const { preTaxTotal, preTaxBalance, scale } = stripTax(total, Number(row.invoice_balance || 0), taxByQboId.get(row.qbo_id) ?? 0);
    return {
      category: 'self_performed',
      saReference: `invoice:${row.sa_id}`,
      saClientId: row.customer_id,
      contractId: null,
      invoiceSaId: row.sa_id,
      clientName: row.client,
      contractOrFirstYearValue: preTaxTotal,
      invoicedAmount: preTaxTotal,
      paidAmount: round2(preTaxTotal - preTaxBalance),
      taxScale: scale,
      // Sub bills usually arrive before the client is invoiced — widen the match
      // window rather than using the single invoice date (a zero-width window
      // makes the description-based fuzzy match unreachable).
      dateStart: daysBefore(row.date, SELF_PERFORMED_BILL_WINDOW_DAYS),
      dateEnd: daysAfter(row.date, SELF_PERFORMED_BILL_WINDOW_DAYS),
      earliestDate: row.date,
      underlyingInvoices: [{ saId: row.sa_id, qboId: row.qbo_id }],
    };
  });
}

// ── Main run ─────────────────────────────────────────────────────

export async function runCommissionEngine({ quarter, isFinal = true } = {}) {
  const targetQuarter = quarter || currentQuarter();
  const targetKey = quarterSortKey(targetQuarter);
  const targetQuarterEnd = quarterEndDate(targetQuarter);

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

  // A job that WAS commissionable in a prior run for this quarter (e.g. a
  // manual pm_job_assignments override just moved it to an employee with no
  // plan, or removed its PM entirely) needs its old row actively removed --
  // the loop below only ever upserts rows for jobs that resolve to a planned
  // employee THIS run; a job that no longer qualifies is simply `continue`d
  // past, which on its own leaves the old row sitting there stale (real bug,
  // caught 2026-08-04: reassigning a Heather Kehr invoice off Jarrett Bruce
  // left the old commission owed to him unchanged in the ledger). Prefetched
  // once (this table only ever holds a handful of real rows) rather than
  // queried per job.
  const { data: existingLedgerRows, error: existingLedgerError } = await fleetops
    .from('commission_ledger').select('id, sa_reference').eq('quarter', targetQuarter);
  if (existingLedgerError) throw new Error(`existing commission_ledger prefetch failed: ${existingLedgerError.message}`);
  const existingLedgerIdByReference = new Map((existingLedgerRows ?? []).map(r => [r.sa_reference, r.id]));

  // Broader case than removeStaleLedgerRowIfAny below: a job can vanish from
  // allJobs ENTIRELY, not just resolve to a different employee -- e.g. its
  // invoice_total gets corrected to $0 in QBO/SA after the fact (real case
  // caught 2026-08-04: two Jason Carver invoices, $2,268.25 and $131.88,
  // were zeroed out — apparently re-split into two other invoices that DO
  // have real amounts — but sat in the ledger unchanged since the query that
  // assembles candidate jobs filters on invoice_total > 0, so a zeroed
  // invoice never even reaches the per-job loop to be reconsidered). Any
  // existing row whose sa_reference isn't in this run's candidate set at all
  // is unconditionally stale.
  const allJobReferences = new Set(allJobs.map(j => j.saReference));
  const orphanedRows = (existingLedgerRows ?? []).filter(r => !allJobReferences.has(r.sa_reference));
  if (orphanedRows.length) {
    const { error: orphanDeleteError } = await fleetops.from('commission_ledger').delete().in('id', orphanedRows.map(r => r.id));
    if (orphanDeleteError) {
      logger.warn('orphaned commission_ledger row cleanup failed', { err: orphanDeleteError.message });
    } else {
      logger.info('Removed commission_ledger rows for jobs no longer in the candidate set at all', { saReferences: orphanedRows.map(r => r.sa_reference) });
      for (const r of orphanedRows) existingLedgerIdByReference.delete(r.sa_reference);
    }
  }

  async function removeStaleLedgerRowIfAny(saReference) {
    const staleId = existingLedgerIdByReference.get(saReference);
    if (!staleId) return;
    const { error: deleteError } = await fleetops.from('commission_ledger').delete().eq('id', staleId);
    if (deleteError) logger.warn('removeStaleLedgerRowIfAny delete failed', { err: deleteError.message, saReference });
    else logger.info('Removed stale commission_ledger row — job no longer resolves to a planned employee', { saReference });
    existingLedgerIdByReference.delete(saReference);
  }

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

  // One sa_jobs fetch per customer for the whole run, not per invoice — see
  // findJobLevelSalesRep.
  const fuzzyCandidateCache = new Map();
  const { assignmentIndex, estimatesByClient } = await buildAttributionIndexes();
  const qboPaymentIndex = await buildQboPaymentIndex();

  for (const job of allJobs) {
    const pmResolution = await resolvePM({
      saClientId: job.saClientId,
      contractId: job.contractId,
      invoiceSaId: job.invoiceSaId,
      earliestDate: job.earliestDate,
      isContractJob: job.category === 'maintenance_snow',
      fuzzyCandidateCache,
      assignmentIndex,
      estimatesByClient,
    });
    const employeeName = pmResolution?.employeeName ?? null;
    // Withhold payable (not accrued) for any attribution resting solely on the
    // fallible estimate-date guess, until a human confirms it -- see
    // 20260801_commission_pm_confidence.sql. Everything else (manual entry,
    // job-level SalesRep match) is trusted.
    const pmAttributionConfirmed = pmResolution?.confidence !== 'estimate_scrape';
    if (!employeeName) {
      results.skippedNoPM++;
      results.unassignedJobs.push({
        saReference: job.saReference, clientName: job.clientName, category: job.category,
        value: job.contractOrFirstYearValue,
      });
      await removeStaleLedgerRowIfAny(job.saReference);
      continue;
    }

    const plan = planByEmployee.get(employeeName);
    if (!plan || plan.effective_date > job.earliestDate) {
      results.skippedNoPlan++;
      results.unplannedJobs.push({
        saReference: job.saReference, clientName: job.clientName, category: job.category,
        employeeName, value: job.contractOrFirstYearValue,
      });
      await removeStaleLedgerRowIfAny(job.saReference);
      continue;
    }

    let jobDetails;
    try {
      jobDetails = await fetchJobDetails(job, { qboPaymentIndex });
    } catch (err) {
      // fetchJobDetails' internal queries log+swallow their own {error} results;
      // this catches a harder failure (e.g. a rejected network call) so one job's
      // transient failure doesn't abort the rest of the quarter's loop.
      logger.warn('fetchJobDetails failed — job skipped this run', { err: err.message, saReference: job.saReference });
      results.processingErrors.push({ saReference: job.saReference, clientName: job.clientName, error: err.message });
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

    // Quarter-end close: cap newly-collected cash to what actually landed by
    // targetQuarterEnd, not whatever's paid as of whenever this run happens
    // (see fetchPaidAmountAsOf). A mid-quarter tracking run (isFinal=false)
    // has no such close to honor yet, so it keeps using the live total.
    const paidAmountForPayable = isFinal
      ? await fetchPaidAmountAsOf(job.underlyingInvoices, targetQuarterEnd, qboPaymentIndex, job.taxScale ?? 1)
      : job.paidAmount;

    const priorCommissionedThrough = priorQuarterRow ? Number(priorQuarterRow.commissioned_through_amount) : 0;
    const incrementalPaid = Math.max(0, paidAmountForPayable - priorCommissionedThrough);
    // Same withholding mechanism as unconfirmedFraction, composed rather than
    // duplicated: an unconfirmed PM attribution zeroes the confirmed fraction
    // entirely (same as unconfirmedFraction=1), and commissionedThroughAmount
    // simply doesn't advance until a human confirms it -- the whole backlog
    // becomes payable in one run the moment it is, exactly like the existing
    // subcontractor catch-up.
    const confirmedIncrementalPaid = incrementalPaid * (1 - unconfirmedFraction) * (pmAttributionConfirmed ? 1 : 0);

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
        pm_attribution_confirmed: pmAttributionConfirmed,
        service_names: jobDetails.serviceNames,
        line_item_names: jobDetails.lineItemNames,
        estimate_number: jobDetails.estimateNumber,
        estimate_date: jobDetails.estimateDate,
        invoice_number: jobDetails.invoiceNumber,
        invoice_date: jobDetails.invoiceDate,
        date_completed: jobDetails.dateCompleted,
        date_paid: jobDetails.datePaid,
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

  // Log counts, not the full unassignedJobs/unplannedJobs arrays — those can run
  // to thousands of entries across a company-wide scan (only a handful of jobs
  // are ever commission-eligible), and nothing reads the per-job detail from logs.
  logger.info('Commission engine run complete', {
    quarter: targetQuarter, written: results.written, skippedNoPM: results.skippedNoPM,
    skippedNoPlan: results.skippedNoPlan, renewalFlags: results.renewalFlags, subBillFlags: results.subBillFlags,
    unassignedJobCount: results.unassignedJobs.length, unplannedJobCount: results.unplannedJobs.length,
    processingErrorCount: results.processingErrors.length,
  });
  return { quarter: targetQuarter, ...results };
}
