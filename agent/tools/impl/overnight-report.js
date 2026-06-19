// tools/impl/overnight-report.js — Daily morning SA activity report
// Sends at 6 AM to michael@jrboehlke.com via the scheduler/cron.js task.
//
// Sections:
//   1. Jobs accepted yesterday   — Won estimates first seen since last report, with line items
//   2. Awaiting waiting list     — Live comparison: Won estimates not found on WL or dispatch board
//   3. Estimates sent yesterday  — Tracked via sa_sent_estimates; first seen in Sent stage yesterday
//   4. Aging estimates           — Sent 7+ days ago, no acceptance  [skipped per 2026-06-16 review]
//   5. Today's dispatch          — sa_jobs for today, grouped by crew with subtotals
//
// Required Supabase table (run once in fleetops project):
//   CREATE TABLE IF NOT EXISTS sa_sent_estimates (
//     estimate_id TEXT PRIMARY KEY,
//     estimate_number TEXT,
//     client_name TEXT,
//     client_id TEXT,
//     address TEXT,
//     sales_rep TEXT,
//     service_type TEXT,
//     amount NUMERIC,
//     quote_date DATE,
//     first_seen_sent_at TIMESTAMPTZ DEFAULT NOW(),
//     created_at TIMESTAMPTZ DEFAULT NOW()
//   );

import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';
import { getEstimateList } from './serviceautopilot.js';

// ── Supabase clients ──────────────────────────────────────────────────────────

function fleetops() {
  return createClient(
    process.env.FLEETOPS_SUPABASE_URL,
    process.env.FLEETOPS_SUPABASE_SERVICE_KEY,
  );
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return startOfDay(d);
}

function today() { return startOfDay(new Date()); }
function yesterday() { return daysAgo(1); }

function formatDate(d) {
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function isoDate(d) { return d.toISOString().split('T')[0]; }

function daysBetween(a, b) {
  return Math.floor((b - a) / 86400000);
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmt$(amount) {
  if (amount == null || isNaN(amount) || amount === 0) return '—';
  return '$' + Number(amount).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function totalOf(rows) {
  return rows.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
}

// ── SA field extraction ───────────────────────────────────────────────────────
// V2EstimateList_Query BFF uses PascalCase fields; fall back across common variants.

function extractEstimate(e) {
  // V2EstimateList_Query actual field names confirmed via probe 2026-06-19
  const amount = parseFloat(e.EstimatedValue ?? 0);
  const quoteDate = e.QuoteDate?.IsValid
    ? new Date(e.QuoteDate.Year, e.QuoteDate.Month - 1, e.QuoteDate.Day)
    : null;

  return {
    estimateId:   e.ID || '',
    estimateNum:  e.Number || '',
    clientName:   e.ClientName || '—',
    clientId:     e.ClientID || '',
    address:      e.ClientAddress || '—',
    salesRep:     e.SalesPersonName || '—',
    serviceType:  '—',
    amount,
    stage:        e.QuoteStageType || '',
    quoteDate,
    quoteDateStr: quoteDate ? isoDate(quoteDate) : null,
  };
}

// ── Section 1 & 2: Won estimate tracking ─────────────────────────────────────
// Fetches ALL Won estimates from SA (no date limit — fixes estimates won yesterday
// but created months ago).  Upserts to sa_accepted_estimates; first_seen_at is
// preserved on conflict so we can detect "newly won yesterday".
// Returns { acceptedYesterday (with lineItems), outstanding (Won but not on WL/dispatch) }

async function syncWonEstimates() {
  const db = fleetops();
  const now = new Date();

  // Fetch recent Won estimates; limit to 1 year to avoid pulling 2000 oldest.
  // Old estimates already in sa_accepted_estimates won't re-flood — ignoreDuplicates.
  const raw = await getEstimateList({ dateFrom: daysAgo(365), dateTo: today(), stages: ['Won'], max: 2000 });
  // Stage filter is ignored server-side — must filter client-side on QuoteStageType
  const estimates = raw.filter(e => e.QuoteStageType === 'Won').map(extractEstimate).filter(e => e.estimateId);
  logger.info('overnight-report: Won estimates from SA', { count: estimates.length });

  if (estimates.length > 0) {
    const rows = estimates.map(e => ({
      estimate_id:     e.estimateId,
      estimate_number: e.estimateNum,
      client_name:     e.clientName,
      client_id:       e.clientId,
      address:         e.address,
      sales_rep:       e.salesRep,
      service_type:    e.serviceType,
      amount:          e.amount || null,
      quote_date:      e.quoteDateStr,
    }));

    // Upsert — ignoreDuplicates preserves first_seen_at for existing rows
    const { error: upsertErr } = await db
      .from('sa_accepted_estimates')
      .upsert(rows, { onConflict: 'estimate_id', ignoreDuplicates: true });
    if (upsertErr) logger.warn('overnight-report: sa_accepted_estimates upsert error', { error: upsertErr.message });

    // Cleanup: remove rows no longer in SA's Won list (lost/cancelled estimates)
    // This also purges any stale non-Won entries left from before this fix.
    const currentWonIds = estimates.map(e => e.estimateId);
    const { data: allTracked } = await db.from('sa_accepted_estimates').select('estimate_id');
    const toDelete = (allTracked || [])
      .map(r => r.estimate_id)
      .filter(id => !currentWonIds.includes(id));
    if (toDelete.length > 0) {
      await db.from('sa_accepted_estimates').delete().in('estimate_id', toDelete);
      logger.info('overnight-report: cleaned stale sa_accepted_estimates', { removed: toDelete.length });
    }
  }

  // Section 1: estimates first seen in Won stage yesterday — these are newly won
  const { data: newYesterday } = await db
    .from('sa_accepted_estimates')
    .select('*')
    .gte('first_seen_at', yesterday().toISOString())
    .lt('first_seen_at', today().toISOString())
    .order('client_name');

  // QueryLineItems only works for estimates open in the SA session — returns 0 for all
  // existing estimates. Skip the per-estimate fetch; display EstimatedValue total instead.
  const acceptedYesterday = newYesterday || [];

  // Section 2: live comparison — Won estimates whose client is NOT on WL or upcoming dispatch
  const { data: wlRows }  = await db.from('sa_waiting_list').select('client_id').not('client_id', 'is', null);
  const { data: dispRows } = await db.from('sa_jobs').select('customer_id').gte('start_date', isoDate(today())).not('customer_id', 'is', null);

  const coveredClientIds = new Set([
    ...(wlRows  || []).map(r => r.client_id),
    ...(dispRows || []).map(r => r.customer_id),
  ]);

  // Also join first_seen_at from sa_accepted_estimates for "days since won"
  const { data: trackedRows } = await db.from('sa_accepted_estimates').select('estimate_id, first_seen_at');
  const trackedMap = new Map((trackedRows || []).map(r => [r.estimate_id, r.first_seen_at]));

  const outstanding = estimates
    .filter(e => e.clientId && !coveredClientIds.has(e.clientId))
    .map(e => ({ ...e, first_seen_at: trackedMap.get(e.estimateId) || null }))
    .sort((a, b) => (a.clientName || '').localeCompare(b.clientName || ''));

  return { acceptedYesterday, outstanding };
}

// ── Section 3: Estimates sent yesterday ──────────────────────────────────────
// Uses sa_sent_estimates table to track first_seen_at in Sent stage (fixes the
// QuoteDate vs. send-date mismatch in the old approach).
// Falls back gracefully if the table doesn't exist yet.

async function syncSentEstimates() {
  const db  = fleetops();
  const now = new Date();

  const raw = await getEstimateList({ dateFrom: daysAgo(365), dateTo: today(), stages: ['Sent'], max: 2000 });
  // Stage filter is ignored server-side — must filter client-side on QuoteStageType
  const estimates = raw.filter(e => e.QuoteStageType === 'Sent').map(extractEstimate).filter(e => e.estimateId);
  logger.info('overnight-report: Sent estimates from SA', { count: estimates.length });

  if (estimates.length === 0) return [];

  const rows = estimates.map(e => ({
    estimate_id:     e.estimateId,
    estimate_number: e.estimateNum,
    client_name:     e.clientName,
    client_id:       e.clientId,
    address:         e.address,
    sales_rep:       e.salesRep,
    service_type:    e.serviceType,
    amount:          e.amount || null,
    quote_date:      e.quoteDateStr,
  }));

  try {
    // Upsert — ignoreDuplicates preserves first_seen_sent_at for existing rows
    const { error } = await db
      .from('sa_sent_estimates')
      .upsert(rows, { onConflict: 'estimate_id', ignoreDuplicates: true });
    if (error) {
      logger.warn('overnight-report: sa_sent_estimates upsert error', { error: error.message });
      return [];
    }

    // Cleanup: remove estimates no longer in Sent stage
    const currentSentIds = estimates.map(e => e.estimateId);
    const { data: allTracked } = await db.from('sa_sent_estimates').select('estimate_id');
    const toDelete = (allTracked || []).map(r => r.estimate_id).filter(id => !currentSentIds.includes(id));
    if (toDelete.length > 0) {
      await db.from('sa_sent_estimates').delete().in('estimate_id', toDelete);
    }

    // Return estimates first seen in Sent stage yesterday
    const { data: sentYesterday } = await db
      .from('sa_sent_estimates')
      .select('*')
      .gte('first_seen_sent_at', yesterday().toISOString())
      .lt('first_seen_sent_at', today().toISOString())
      .order('sales_rep')
      .order('client_name');

    return sentYesterday || [];
  } catch (err) {
    // Table doesn't exist yet — return empty and log instructions
    logger.warn('overnight-report: sa_sent_estimates table missing — create it per PR notes', { err: err.message });
    return [];
  }
}

// ── Section 4: Aging estimates ────────────────────────────────────────────────

async function getAgingEstimates() {
  const raw = await getEstimateList({
    dateFrom: daysAgo(60),
    dateTo:   daysAgo(7),
    stages:   ['Sent'],
    max:      200,
  });
  return raw
    .filter(e => e.QuoteStageType === 'Sent')
    .map(extractEstimate)
    .filter(e => e.estimateId)
    .map(e => ({
      ...e,
      daysOut: e.quoteDate ? daysBetween(e.quoteDate, new Date()) : null,
    }))
    .sort((a, b) => b.amount - a.amount);
}

// ── Section 5: Today's dispatch ───────────────────────────────────────────────

async function getTodayJobs() {
  const db = fleetops();
  const todayStr = isoDate(today());
  const { data, error } = await db
    .from('sa_jobs')
    .select('id, client, address, service, assigned, amount, status')
    .eq('start_date', todayStr)
    .order('assigned', { nullsFirst: false })
    .order('client');

  if (error) {
    logger.warn('overnight-report: sa_jobs query error', { error: error.message });
    return [];
  }

  // Deduplicate by job id (same job may appear twice from sync overlap)
  const seen = new Set();
  return (data || []).filter(r => {
    if (!r.id || seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

async function getAssignedWaitingListJobs() {
  const db = fleetops();
  const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';
  const { data, error } = await db
    .from('sa_waiting_list')
    .select('job_id, client_name, address, service_code, assigned, amount, target_date')
    .not('assigned', 'is', null)
    .neq('assigned', '')
    .neq('assigned', EMPTY_GUID)
    .order('assigned')
    .order('target_date', { nullsFirst: false })
    .order('client_name');
  if (error) {
    logger.warn('overnight-report: sa_waiting_list query error', { error: error.message });
    return [];
  }
  return data || [];
}

// ── HTML builders ─────────────────────────────────────────────────────────────

const CSS = `
  body { font-family: Segoe UI, Arial, sans-serif; font-size: 14px; color: #1a1a1a; margin: 0; padding: 0; background: #f4f4f4; }
  .wrap { max-width: 700px; margin: 20px auto; background: #fff; border-radius: 6px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
  .header { background: #1a3a5c; color: #fff; padding: 18px 24px; }
  .header h1 { margin: 0; font-size: 18px; font-weight: 600; }
  .header p  { margin: 4px 0 0; font-size: 12px; color: #aac4e0; }
  .section { padding: 16px 24px; border-bottom: 1px solid #eee; }
  .section:last-child { border-bottom: none; }
  .section-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: #555; margin: 0 0 10px; display: flex; align-items: center; gap: 8px; }
  .badge { background: #1a3a5c; color: #fff; border-radius: 10px; padding: 1px 8px; font-size: 11px; font-weight: 600; }
  .badge.orange { background: #e07b00; }
  .badge.green  { background: #1a7a3c; }
  .badge.red    { background: #a00; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: #f0f4f8; text-align: left; padding: 6px 8px; font-weight: 600; color: #444; border-bottom: 2px solid #dde3ea; }
  td { padding: 6px 8px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .amount { text-align: right; font-weight: 600; white-space: nowrap; }
  .days  { color: #888; font-size: 12px; }
  .total-row td { font-weight: 700; background: #f8f9fa; border-top: 2px solid #dde3ea; }
  .empty { color: #888; font-size: 13px; padding: 6px 0; }
  .summary-box { background: #f0f4f8; border-radius: 4px; padding: 10px 14px; margin-bottom: 12px; font-size: 13px; }
  .summary-box strong { font-size: 15px; }
  .group-header td { background: #e8eef5; font-weight: 700; font-size: 13px; border-top: 2px solid #c4d0de; color: #1a3a5c; }
  .group-subtotal td { background: #f4f7fb; font-weight: 600; font-size: 12px; color: #444; border-top: 1px solid #dde3ea; }
  .est-header td { background: #f0f7f0; font-weight: 700; font-size: 13px; border-top: 2px solid #b8d8b8; }
  .line-item td { font-size: 12px; color: #333; }
  .line-item td:first-child { padding-left: 24px; }
  .footer { background: #f8f9fa; padding: 10px 24px; font-size: 11px; color: #888; text-align: center; }
`;

// Section 1: Won estimates — one row per estimate, total from EstimatedValue
function wonEstimatesHtml(estimates) {
  if (!estimates.length) return '<p class="empty">None.</p>';

  let html = `<table>
    <thead><tr>
      <th>Client</th>
      <th>Estimator</th>
      <th>Est #</th>
      <th style="text-align:right">Amount</th>
    </tr></thead><tbody>`;

  let grandTotal = 0;
  for (const est of estimates) {
    const amount = parseFloat(est.amount) || 0;
    grandTotal += amount;
    html += `<tr>
      <td>${est.client_name || '—'}</td>
      <td>${est.sales_rep || '—'}</td>
      <td>${est.estimate_number || '—'}</td>
      <td class="amount">${fmt$(amount)}</td>
    </tr>`;
  }

  html += `<tr class="total-row">
    <td colspan="3" style="text-align:right;padding-right:8px">Total</td>
    <td class="amount">${fmt$(grandTotal)}</td>
  </tr></tbody></table>`;

  return html;
}

// Section 2: Outstanding Won estimates not yet on WL or dispatch
function outstandingEstimatesHtml(estimates) {
  if (!estimates.length) return '<p class="empty">All Won estimates are accounted for on the waiting list or dispatch board.</p>';

  let html = `<table>
    <thead><tr>
      <th>Client</th>
      <th>Estimator</th>
      <th>Days Since Won</th>
      <th style="text-align:right">Amount</th>
    </tr></thead><tbody>`;

  for (const e of estimates) {
    const daysSince = e.first_seen_at ? daysBetween(new Date(e.first_seen_at), new Date()) : null;
    html += `<tr>
      <td>${e.clientName || e.client_name || '—'}</td>
      <td>${e.salesRep || e.sales_rep || '—'}</td>
      <td class="days">${daysSince != null ? `${daysSince}d` : '—'}</td>
      <td class="amount">${fmt$(e.amount)}</td>
    </tr>`;
  }

  const total = estimates.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  html += `<tr class="total-row">
    <td colspan="3" style="text-align:right;padding-right:8px">Total</td>
    <td class="amount">${fmt$(total)}</td>
  </tr></tbody></table>`;

  return html;
}

// Section 3: Sent estimates grouped by estimator
function sentEstimatesHtml(estimates) {
  if (!estimates.length) return '<p class="empty">None.</p>';

  // Group by sales_rep
  const byRep = new Map();
  for (const e of estimates) {
    const rep = e.sales_rep || '(Unassigned)';
    if (!byRep.has(rep)) byRep.set(rep, []);
    byRep.get(rep).push(e);
  }

  let html = `<table>
    <thead><tr>
      <th>Client</th>
      <th>Est #</th>
      <th style="text-align:right">Amount</th>
    </tr></thead><tbody>`;

  for (const [rep, rows] of byRep) {
    const repTotal = totalOf(rows);
    html += `<tr class="group-header">
      <td colspan="2">${rep} &mdash; ${rows.length} estimate${rows.length !== 1 ? 's' : ''}</td>
      <td class="amount">${fmt$(repTotal)}</td>
    </tr>`;
    for (const r of rows) {
      html += `<tr>
        <td>${r.client_name || '—'}</td>
        <td style="font-size:12px;color:#555">${r.estimate_number || '—'}</td>
        <td class="amount">${fmt$(r.amount)}</td>
      </tr>`;
    }
  }

  const grand = totalOf(estimates);
  html += `<tr class="total-row">
    <td colspan="2" style="text-align:right;padding-right:8px">Total</td>
    <td class="amount">${fmt$(grand)}</td>
  </tr></tbody></table>`;

  return html;
}

// Section 5: Dispatch grouped by crew with subtotals
function dispatchByCrewHtml(jobs) {
  if (!jobs.length) return '<p class="empty">Nothing scheduled for today.</p>';

  // Group by assigned crew (null → "Unassigned")
  const byCrew = new Map();
  for (const j of jobs) {
    const crew = j.assigned || 'Unassigned';
    if (!byCrew.has(crew)) byCrew.set(crew, []);
    byCrew.get(crew).push(j);
  }

  const grandTotal = jobs.reduce((s, j) => s + (parseFloat(j.amount) || 0), 0);

  let html = `<table>
    <thead><tr>
      <th>Client</th>
      <th>Address</th>
      <th>Service</th>
      <th style="text-align:right">Amount</th>
    </tr></thead><tbody>`;

  for (const [crew, rows] of byCrew) {
    const crewTotal = rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
    html += `<tr class="group-header">
      <td colspan="3">${crew} &mdash; ${rows.length} job${rows.length !== 1 ? 's' : ''}</td>
      <td class="amount">${fmt$(crewTotal)}</td>
    </tr>`;
    for (const r of rows) {
      html += `<tr>
        <td>${r.client || '—'}</td>
        <td style="font-size:12px;color:#555">${r.address || '—'}</td>
        <td>${r.service || '—'}</td>
        <td class="amount">${fmt$(r.amount)}</td>
      </tr>`;
    }
    html += `<tr class="group-subtotal">
      <td colspan="3" style="text-align:right;padding-right:8px">${crew} subtotal</td>
      <td class="amount">${fmt$(crewTotal)}</td>
    </tr>`;
  }

  html += `<tr class="total-row">
    <td colspan="3" style="text-align:right;padding-right:8px">Total</td>
    <td class="amount">${fmt$(grandTotal)}</td>
  </tr></tbody></table>`;

  return html;
}

// Section 6: Waiting list grouped by assigned crew
function waitingListByCrewHtml(jobs) {
  if (!jobs.length) return '<p class="empty">No crew-assigned waiting list jobs. (Crew assignments sync nightly — will populate after next run.)</p>';

  const byCrew = new Map();
  for (const j of jobs) {
    if (!byCrew.has(j.assigned)) byCrew.set(j.assigned, []);
    byCrew.get(j.assigned).push(j);
  }

  const grandTotal = jobs.reduce((s, j) => s + (parseFloat(j.amount) || 0), 0);

  let html = `<table>
    <thead><tr>
      <th>Client</th>
      <th>Service</th>
      <th>Target Date</th>
      <th style="text-align:right">Amount</th>
    </tr></thead><tbody>`;

  for (const [crew, rows] of byCrew) {
    const crewTotal = rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
    html += `<tr class="group-header">
      <td colspan="3">${crew} &mdash; ${rows.length} job${rows.length !== 1 ? 's' : ''}</td>
      <td class="amount">${fmt$(crewTotal)}</td>
    </tr>`;
    for (const r of rows) {
      html += `<tr>
        <td>${r.client_name || '—'}</td>
        <td>${r.service_code || '—'}</td>
        <td class="days">${r.target_date || '—'}</td>
        <td class="amount">${fmt$(r.amount)}</td>
      </tr>`;
    }
  }

  html += `<tr class="total-row">
    <td colspan="3" style="text-align:right;padding-right:8px">Total</td>
    <td class="amount">${fmt$(grandTotal)}</td>
  </tr></tbody></table>`;
  return html;
}

// Section 4: Aging estimates table (unchanged layout)
function agingEstimatesHtml(rows) {
  if (!rows.length) return '<p class="empty">None.</p>';
  let html = `<table>
    <thead><tr>
      <th>Client</th>
      <th>Address</th>
      <th>Estimator</th>
      <th>Job Type</th>
      <th>Days Out</th>
      <th style="text-align:right">Amount</th>
    </tr></thead><tbody>`;
  for (const r of rows) {
    html += `<tr>
      <td>${r.clientName || '—'}</td>
      <td style="font-size:12px;color:#555">${r.address || '—'}</td>
      <td>${r.salesRep || '—'}</td>
      <td>${r.serviceType || '—'}</td>
      <td class="days">${r.daysOut != null ? `${r.daysOut}d` : '—'}</td>
      <td class="amount">${fmt$(r.amount)}</td>
    </tr>`;
  }
  html += `<tr class="total-row">
    <td colspan="5" style="text-align:right;padding-right:8px">Total</td>
    <td class="amount">${fmt$(totalOf(rows))}</td>
  </tr></tbody></table>`;
  return html;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function generateOvernightReport() {
  logger.info('overnight-report: starting');

  const [wonResult, sentResult, agingResult, jobsResult, wlResult] = await Promise.allSettled([
    syncWonEstimates(),
    syncSentEstimates(),
    getAgingEstimates(),
    getTodayJobs(),
    getAssignedWaitingListJobs(),
  ]);

  const { acceptedYesterday = [], outstanding = [] } =
    wonResult.status === 'fulfilled' ? wonResult.value : {};
  const sentYesterday = sentResult.status === 'fulfilled'  ? sentResult.value : [];
  const aging         = agingResult.status === 'fulfilled' ? agingResult.value : [];
  const todayJobs     = jobsResult.status === 'fulfilled'  ? jobsResult.value : [];
  const wlJobs        = wlResult.status === 'fulfilled'    ? wlResult.value   : [];

  if (wonResult.status === 'rejected')
    logger.error('overnight-report: won sync failed',  { err: wonResult.reason?.message });
  if (sentResult.status === 'rejected')
    logger.error('overnight-report: sent sync failed', { err: sentResult.reason?.message });
  if (agingResult.status === 'rejected')
    logger.error('overnight-report: aging failed',     { err: agingResult.reason?.message });
  if (jobsResult.status === 'rejected')
    logger.error('overnight-report: jobs failed',      { err: jobsResult.reason?.message });
  if (wlResult.status === 'rejected')
    logger.error('overnight-report: wl jobs failed',   { err: wlResult.reason?.message });

  const dateLabel      = formatDate(yesterday());
  const outstandingTotal = outstanding.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);

  // Count unique crews for dispatch badge
  const crewSet = new Set(todayJobs.map(j => j.assigned || 'Unassigned'));

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="wrap">

  <div class="header">
    <h1>JRB Daily Morning Report</h1>
    <p>${formatDate(new Date())} &mdash; Activity for ${dateLabel}</p>
  </div>

  <!-- Section 1: Jobs Accepted Yesterday -->
  <div class="section">
    <div class="section-title">
      ✅ Jobs Accepted Yesterday
      <span class="badge green">${acceptedYesterday.length}</span>
    </div>
    ${wonEstimatesHtml(acceptedYesterday)}
  </div>

  <!-- Section 2: Won estimates not yet on WL or dispatch board -->
  <div class="section">
    <div class="section-title">
      ⏳ Accepted — Awaiting Waiting List
      <span class="badge orange">${outstanding.length}</span>
    </div>
    ${outstanding.length > 0
      ? `<div class="summary-box">
           <strong>${outstanding.length}</strong> won estimate${outstanding.length !== 1 ? 's' : ''} with no waiting-list or scheduled job &mdash; pipeline value: <strong>${fmt$(outstandingTotal)}</strong>
         </div>`
      : ''}
    ${outstandingEstimatesHtml(outstanding)}
  </div>

  <!-- Section 3: Estimates Sent Yesterday -->
  <div class="section">
    <div class="section-title">
      📝 Estimates Sent Yesterday
      <span class="badge">${sentYesterday.length}</span>
    </div>
    ${sentEstimatesHtml(sentYesterday)}
  </div>

  <!-- Section 4: Aging Estimates -->
  <div class="section">
    <div class="section-title">
      ⚠️ Aging Estimates — No Response (7+ days)
      <span class="badge red">${aging.length}</span>
    </div>
    ${agingEstimatesHtml(aging)}
  </div>

  <!-- Section 5: Today's Dispatch -->
  <div class="section">
    <div class="section-title">
      📅 Today's Dispatch
      <span class="badge">${todayJobs.length} job${todayJobs.length !== 1 ? 's' : ''} &bull; ${crewSet.size} crew${crewSet.size !== 1 ? 's' : ''}</span>
    </div>
    ${dispatchByCrewHtml(todayJobs)}
  </div>

  <!-- Section 6: Waiting List by Crew -->
  <div class="section">
    <div class="section-title">
      📋 Waiting List by Crew
      <span class="badge">${wlJobs.length} job${wlJobs.length !== 1 ? 's' : ''}</span>
    </div>
    ${waitingListByCrewHtml(wlJobs)}
  </div>

  <div class="footer">Sent by JRB Executive Assistant &mdash; ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT</div>
</div>
</body></html>`;

  const subject = `JRB Morning Report — ${dateLabel} | ${acceptedYesterday.length} accepted, ${outstanding.length} awaiting WL, ${todayJobs.length} dispatched`;

  logger.info('overnight-report: complete', {
    accepted:    acceptedYesterday.length,
    outstanding: outstanding.length,
    sent:        sentYesterday.length,
    aging:       aging.length,
    todayJobs:   todayJobs.length,
  });

  return { subject, body: html };
}
