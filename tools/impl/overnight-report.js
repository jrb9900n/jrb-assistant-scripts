// tools/impl/overnight-report.js — Daily morning SA activity report
// Sends at 6 AM to michael@jrboehlke.com via the scheduler/cron.js task.
//
// Sections:
//   1. Jobs accepted yesterday   — Won estimates first seen since last report
//   2. Awaiting waiting list     — Accepted estimates not yet on WL (persists day over day)
//   3. Estimates sent yesterday  — Sent stage, QuoteDate = yesterday
//   4. Aging estimates           — Sent 7+ days ago, no acceptance
//   5. Today's dispatch          — sa_jobs table for today's date

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
  if (amount == null || isNaN(amount)) return '—';
  return '$' + Number(amount).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function totalOf(rows) {
  return rows.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
}

// ── SA field extraction ───────────────────────────────────────────────────────
// The V2EstimateList_Query BFF uses PascalCase fields; fall back across common variants.

function extractEstimate(e) {
  const amount = parseFloat(
    e.TotalAmount ?? e.Total ?? e.Amount ?? e.TotalPrice ?? 0
  );
  const quoteDate = e.QuoteDate
    ? new Date(e.QuoteDate.Year, e.QuoteDate.Month - 1, e.QuoteDate.Day)
    : null;

  return {
    estimateId:  e.ID || e.QuoteID || e.EstimateID || '',
    estimateNum: e.EstimateNumber || e.QuoteNumber || '',
    clientName:  e.CustomerName || e.ClientName || e.Client || '—',
    clientId:    e.CustomerID   || e.ClientID   || '',
    address:     [e.Address, e.City, e.State].filter(Boolean).join(', ') || '—',
    salesRep:    e.SalesRepName || e.SalesRep   || '—',
    serviceType: e.Service || e.ServiceDescription || e.Description || '—',
    amount,
    stage:       e.QuoteStageType || e.Stage || '',
    quoteDate,
    quoteDateStr: quoteDate ? isoDate(quoteDate) : null,
  };
}

// ── Section 1 & 2: Won estimate tracking ─────────────────────────────────────
// Fetches Won estimates from SA (last 60 days), upserts to sa_accepted_estimates.
// Returns { acceptedYesterday, outstanding }

async function syncWonEstimates() {
  const db = fleetops();
  const sixtyDaysAgo = daysAgo(60);
  const now = new Date();

  // Pull Won estimates from last 60 days
  const raw = await getEstimateList({
    dateFrom: sixtyDaysAgo,
    dateTo:   now,
    stages:   ['Won'],
    max:      500,
  });

  const estimates = raw.map(extractEstimate).filter(e => e.estimateId);

  if (estimates.length > 0) {
    // Upsert — on conflict (estimate_id) do nothing so first_seen_at is preserved
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

    const { error } = await db
      .from('sa_accepted_estimates')
      .upsert(rows, { onConflict: 'estimate_id', ignoreDuplicates: true });

    if (error) logger.warn('overnight-report: sa_accepted_estimates upsert error', { error: error.message });
  }

  // Resolve outstanding items that now appear in sa_waiting_list
  const { data: outstanding } = await db
    .from('sa_accepted_estimates')
    .select('estimate_id, client_id')
    .is('resolved_at', null);

  if (outstanding?.length > 0) {
    const clientIds = [...new Set(outstanding.map(r => r.client_id).filter(Boolean))];
    const { data: onWL } = await db
      .from('sa_waiting_list')
      .select('client_id')
      .in('client_id', clientIds);

    const onWLSet = new Set((onWL || []).map(r => r.client_id));

    for (const row of outstanding) {
      if (onWLSet.has(row.client_id)) {
        await db
          .from('sa_accepted_estimates')
          .update({ resolved_at: now.toISOString(), resolved_reason: 'found_on_waiting_list' })
          .eq('estimate_id', row.estimate_id);
      }
    }
  }

  // "Accepted yesterday" = first_seen_at between yesterday midnight and today midnight
  const { data: acceptedYesterday } = await db
    .from('sa_accepted_estimates')
    .select('*')
    .gte('first_seen_at', yesterday().toISOString())
    .lt('first_seen_at', today().toISOString())
    .order('amount', { ascending: false });

  // "Outstanding" = resolved_at IS NULL
  const { data: stillOutstanding } = await db
    .from('sa_accepted_estimates')
    .select('*')
    .is('resolved_at', null)
    .order('amount', { ascending: false });

  return {
    acceptedYesterday: acceptedYesterday || [],
    outstanding:       stillOutstanding  || [],
  };
}

// ── Section 3: Estimates sent yesterday ──────────────────────────────────────

async function getEstimatesSentYesterday() {
  const raw = await getEstimateList({
    dateFrom: yesterday(),
    dateTo:   yesterday(),
    stages:   ['Sent'],
    max:      200,
  });
  return raw
    .map(extractEstimate)
    .filter(e => e.estimateId)
    .sort((a, b) => b.amount - a.amount);
}

// ── Section 4: Aging estimates ────────────────────────────────────────────────

async function getAgingEstimates() {
  // Sent 7–60 days ago, still in Sent stage (no response)
  const raw = await getEstimateList({
    dateFrom: daysAgo(60),
    dateTo:   daysAgo(7),
    stages:   ['Sent'],
    max:      200,
  });
  return raw
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
    .select('client, address, service, assigned, amount, status')
    .eq('start_date', todayStr)
    .order('amount', { ascending: false });

  if (error) {
    logger.warn('overnight-report: sa_jobs query error', { error: error.message });
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
  .summary-box { background: #f0f4f8; border-radius: 4px; padding: 10px 14px; margin-bottom: 0; font-size: 13px; }
  .summary-box strong { font-size: 15px; }
  .footer { background: #f8f9fa; padding: 10px 24px; font-size: 11px; color: #888; text-align: center; }
`;

function tableRow(cells) {
  return `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
}

function estimateTable(rows, extraCols = []) {
  if (!rows.length) return '<p class="empty">None.</p>';
  const headers = ['Client', 'Address', 'Estimator', 'Job Type', ...extraCols.map(c => c.label), 'Amount'];
  const head = `<tr>${headers.map(h => `<th${h === 'Amount' ? ' style="text-align:right"' : ''}>${h}</th>`).join('')}</tr>`;
  const body = rows.map(r => {
    const extras = extraCols.map(c => `<td class="${c.cls || ''}">${c.value(r)}</td>`);
    return `<tr>
      <td>${r.client_name || r.clientName || '—'}</td>
      <td style="font-size:12px;color:#555">${r.address || '—'}</td>
      <td>${r.sales_rep || r.salesRep || '—'}</td>
      <td>${r.service_type || r.serviceType || '—'}</td>
      ${extras.join('')}
      <td class="amount">${fmt$(r.amount)}</td>
    </tr>`;
  }).join('');
  const total = totalOf(rows);
  const foot = `<tr class="total-row"><td colspan="${4 + extraCols.length}" style="text-align:right;padding-right:8px">Total</td><td class="amount">${fmt$(total)}</td></tr>`;
  return `<table><thead>${head}</thead><tbody>${body}${foot}</tbody></table>`;
}

function jobsTable(rows) {
  if (!rows.length) return '<p class="empty">Nothing scheduled for today.</p>';
  const head = `<tr><th>Client</th><th>Address</th><th>Service</th><th>Crew</th><th style="text-align:right">Amount</th></tr>`;
  const body = rows.map(r => `<tr>
    <td>${r.client || '—'}</td>
    <td style="font-size:12px;color:#555">${r.address || '—'}</td>
    <td>${r.service || '—'}</td>
    <td>${r.assigned || '—'}</td>
    <td class="amount">${fmt$(r.amount)}</td>
  </tr>`).join('');
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function generateOvernightReport() {
  logger.info('overnight-report: starting');

  const [wonResult, sentYesterday, agingEstimates, todayJobs] = await Promise.allSettled([
    syncWonEstimates(),
    getEstimatesSentYesterday(),
    getAgingEstimates(),
    getTodayJobs(),
  ]);

  const { acceptedYesterday = [], outstanding = [] } = wonResult.status === 'fulfilled' ? wonResult.value : {};
  const sent    = sentYesterday.status === 'fulfilled'  ? sentYesterday.value  : [];
  const aging   = agingEstimates.status === 'fulfilled' ? agingEstimates.value : [];
  const todayQ  = todayJobs.status === 'fulfilled'      ? todayJobs.value      : [];

  if (wonResult.status === 'rejected')    logger.error('overnight-report: won sync failed', { err: wonResult.reason?.message });
  if (sentYesterday.status === 'rejected') logger.error('overnight-report: sent query failed', { err: sentYesterday.reason?.message });
  if (agingEstimates.status === 'rejected') logger.error('overnight-report: aging query failed', { err: agingEstimates.reason?.message });
  if (todayJobs.status === 'rejected')    logger.error('overnight-report: today jobs failed', { err: todayJobs.reason?.message });

  const dateLabel = formatDate(yesterday());
  const outstandingTotal = totalOf(outstanding);

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
    ${estimateTable(acceptedYesterday)}
  </div>

  <!-- Section 2: Awaiting Waiting List -->
  <div class="section">
    <div class="section-title">
      ⏳ Accepted — Awaiting Waiting List
      <span class="badge orange">${outstanding.length}</span>
    </div>
    ${outstanding.length > 0
      ? `<div class="summary-box" style="margin-bottom:12px">
           Total pipeline value: <strong>${fmt$(outstandingTotal)}</strong> across ${outstanding.length} job${outstanding.length !== 1 ? 's' : ''}
         </div>`
      : ''}
    ${estimateTable(outstanding, [
      {
        label: 'Days Since Won',
        cls:   'days',
        value: r => {
          const d = r.first_seen_at ? daysBetween(new Date(r.first_seen_at), new Date()) : null;
          return d != null ? `${d}d` : '—';
        },
      },
    ])}
  </div>

  <!-- Section 3: Estimates Sent Yesterday -->
  <div class="section">
    <div class="section-title">
      📝 Estimates Sent Yesterday
      <span class="badge">${sent.length}</span>
    </div>
    ${estimateTable(sent)}
  </div>

  <!-- Section 4: Aging Estimates (Sent 7+ days, no response) -->
  <div class="section">
    <div class="section-title">
      ⚠️ Aging Estimates — No Response (7+ days)
      <span class="badge red">${aging.length}</span>
    </div>
    ${estimateTable(aging, [
      {
        label: 'Days Out',
        cls:   'days',
        value: r => r.daysOut != null ? `${r.daysOut}d` : '—',
      },
    ])}
  </div>

  <!-- Section 5: Today's Dispatch -->
  <div class="section">
    <div class="section-title">
      📅 Today's Dispatch
      <span class="badge">${todayQ.length} job${todayQ.length !== 1 ? 's' : ''}</span>
    </div>
    ${jobsTable(todayQ)}
  </div>

  <div class="footer">Sent by JRB Executive Assistant &mdash; ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT</div>
</div>
</body></html>`;

  const subject = `JRB Morning Report — ${dateLabel} | ${acceptedYesterday.length} accepted, ${outstanding.length} awaiting WL`;

  logger.info('overnight-report: complete', {
    accepted: acceptedYesterday.length,
    outstanding: outstanding.length,
    sent: sent.length,
    aging: aging.length,
    todayJobs: todayQ.length,
  });

  return { subject, body: html };
}
