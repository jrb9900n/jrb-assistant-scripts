// tools/impl/overnight-report.js — Daily morning SA activity report
// Sends at 6 AM to michael@jrboehlke.com via the scheduler/cron.js task.
//
// Section order (top → bottom):
//   1. Today's dispatch       — grouped by crew, sorted by start_time
//   2. Jobs accepted yesterday — Won estimates first seen since last report (seeded=false)
//   3. Awaiting waiting list  — accepted but not yet scheduled, grouped by job type
//   4. Estimates sent recently — stage changed to Sent in last 2 days, grouped by estimator
//   5. Aging estimates        — Sent 7+ days ago, no acceptance, grouped by estimator

import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';
import { getEstimateList, getEstimateLineItems } from './serviceautopilot.js';

// ── Supabase ──────────────────────────────────────────────────────────────────

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

function today()     { return startOfDay(new Date()); }
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
  if (amount == null || isNaN(amount) || amount === 0) return '$0';
  return '$' + Number(amount).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function totalOf(rows) {
  return rows.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
}

// ── Job type categorization ───────────────────────────────────────────────────

const JOB_TYPE_RULES = [
  [/sealcoat|seal coat/i,           'Sealcoating'],
  [/crack.?fill/i,                  'Crack Filling'],
  [/asphalt|paving|\bpave\b|\br&r\b/i, 'Asphalt'],
  [/concrete|curb|flatwork|sidewalk/i, 'Concrete'],
  [/mulch|\bbed\b/i,                'Mulching'],
  [/mosquito/i,                     'Mosquito Control'],
  [/fertiliz|fert|lawn|application\s*\d|app\s*\d|\bfert\b/i, 'Lawn Care'],
  [/landscape|grading|\bgrade\b/i,  'Landscaping'],
  [/snow|ice.?melt|salting/i,       'Snow Removal'],
];

function categorizeJobType(text) {
  const t = (text || '').toLowerCase();
  for (const [re, cat] of JOB_TYPE_RULES) {
    if (re.test(t)) return cat;
  }
  return 'Other';
}

// ── SA field extraction ───────────────────────────────────────────────────────
// V2EstimateList_Query uses PascalCase; fall back across common variants.

function extractEstimate(e) {
  const amount = parseFloat(
    e.TotalAmount ?? e.TotalPrice ?? e.Total ?? e.Amount ?? 0
  );
  const quoteDate = e.QuoteDate
    ? new Date(e.QuoteDate.Year, e.QuoteDate.Month - 1, e.QuoteDate.Day)
    : null;

  // Description is the estimate title; Service/ServiceType holds the category label
  const serviceType = e.ServiceType || e.ServiceTypeName || e.ServiceName
                   || e.Service || e.ServiceDescription || '';

  return {
    estimateId:   e.ID || e.QuoteID || e.EstimateID || '',
    estimateNum:  e.EstimateNumber || e.QuoteNumber || '',
    clientName:   e.CustomerName || e.ClientName || e.Client || '—',
    clientId:     e.CustomerID   || e.ClientID   || '',
    address:      [e.Address, e.City, e.State].filter(Boolean).join(', ') || '—',
    salesRep:     e.SalesRepName || e.SalesRep || e.AssignedTo || '—',
    serviceType,
    amount:       isNaN(amount) ? 0 : amount,
    stage:        e.QuoteStageType || e.Stage || '',
    quoteDate,
    quoteDateStr: quoteDate ? isoDate(quoteDate) : null,
    // Preserve the raw object for diagnosing unknown field names
    _raw: e,
  };
}

// ── Section 1: Today's dispatch ───────────────────────────────────────────────

async function getTodayJobs() {
  const db = fleetops();
  const todayStr = isoDate(today());
  const { data, error } = await db
    .from('sa_jobs')
    .select('client, address, city, service, assigned, sales_rep, amount, status, start_time, start_date')
    .eq('start_date', todayStr)
    .order('start_time', { ascending: true, nullsFirst: false });

  if (error) {
    logger.warn('overnight-report: sa_jobs query error', { error: error.message });
    return [];
  }
  return data || [];
}

// ── Section 2 & 3: Won estimate tracking ─────────────────────────────────────
// Queries Won estimates from last 730 days. New estimates with QuoteDate
// within 30 days are treated as genuinely recent (seeded=false). Older first-
// time records are marked seeded=true so they don't flood the "accepted
// yesterday" section on first-ever run.

async function syncWonEstimates() {
  const db  = fleetops();
  const now = new Date();

  const raw = await getEstimateList({
    dateFrom: daysAgo(730),
    dateTo:   now,
    stages:   ['Won'],
    max:      2000,
  });

  const estimates = raw.map(extractEstimate).filter(e => e.estimateId);
  logger.info('overnight-report: fetched Won estimates', { count: estimates.length });

  if (estimates.length > 0) {
    // Find which estimate IDs are already in the DB
    const { data: existing } = await db
      .from('sa_accepted_estimates')
      .select('estimate_id');
    const existingIds = new Set((existing || []).map(r => r.estimate_id));

    const newEstimates = estimates.filter(e => !existingIds.has(e.estimateId));
    logger.info('overnight-report: new Won estimates to insert', { count: newEstimates.length });

    if (newEstimates.length > 0) {
      // Estimates whose QuoteDate is within 30 days are likely recently accepted.
      // Older ones were Won before we started tracking → mark seeded so they don't
      // show as "accepted yesterday."
      const thirtyDaysAgo = daysAgo(30);

      const rows = newEstimates.map(e => {
        const isRecent = e.quoteDate && e.quoteDate >= thirtyDaysAgo;
        return {
          estimate_id:     e.estimateId,
          estimate_number: e.estimateNum,
          client_name:     e.clientName,
          client_id:       e.clientId,
          address:         e.address,
          sales_rep:       e.salesRep,
          service_type:    e.serviceType || '—',
          amount:          e.amount || null,
          quote_date:      e.quoteDateStr,
          seeded:          !isRecent,
          // Old estimates get a historical first_seen_at so they never surface in
          // the date-windowed "accepted yesterday" query.
          first_seen_at:   isRecent ? now.toISOString() : '2020-01-01T00:00:00.000Z',
        };
      });

      const { error } = await db
        .from('sa_accepted_estimates')
        .upsert(rows, { onConflict: 'estimate_id', ignoreDuplicates: true });
      if (error) logger.warn('overnight-report: upsert error', { error: error.message });

      // For recently-Won estimates, fetch QueryLineItems for accurate amount + service names.
      // Cap at 20 to limit Puppeteer API calls per run.
      const recentNew = newEstimates
        .filter(e => e.quoteDate && e.quoteDate >= thirtyDaysAgo)
        .slice(0, 20);

      for (const est of recentNew) {
        try {
          const detail = await getEstimateLineItems(est.estimateId);
          if (detail) {
            await db.from('sa_accepted_estimates')
              .update({
                amount:       detail.total > 0 ? detail.total : (est.amount || null),
                service_type: detail.services.length > 0 ? detail.services.join(', ') : (est.serviceType || '—'),
              })
              .eq('estimate_id', est.estimateId);
          }
        } catch (err) {
          logger.warn('overnight-report: line items fetch failed', {
            estimateId: est.estimateId,
            err: err.message,
          });
        }
      }
    }
  }

  // Auto-resolve outstanding items that now appear in sa_waiting_list
  const { data: outstanding } = await db
    .from('sa_accepted_estimates')
    .select('estimate_id, client_id')
    .is('resolved_at', null)
    .eq('seeded', false);

  if (outstanding?.length > 0) {
    const clientIds = [...new Set(outstanding.map(r => r.client_id).filter(Boolean))];
    if (clientIds.length > 0) {
      const { data: onWL } = await db
        .from('sa_waiting_list')
        .select('client_id')
        .in('client_id', clientIds);
      const onWLSet = new Set((onWL || []).map(r => r.client_id));
      for (const row of outstanding) {
        if (onWLSet.has(row.client_id)) {
          await db.from('sa_accepted_estimates')
            .update({ resolved_at: now.toISOString(), resolved_reason: 'found_on_waiting_list' })
            .eq('estimate_id', row.estimate_id);
        }
      }
    }
  }

  // "Accepted yesterday" = seeded=false, first_seen_at in [yesterday midnight, today midnight)
  const { data: acceptedYesterday } = await db
    .from('sa_accepted_estimates')
    .select('*')
    .eq('seeded', false)
    .gte('first_seen_at', yesterday().toISOString())
    .lt('first_seen_at', today().toISOString())
    .order('amount', { ascending: false });

  // "Outstanding" = seeded=false, resolved_at IS NULL
  const { data: stillOutstanding } = await db
    .from('sa_accepted_estimates')
    .select('*')
    .eq('seeded', false)
    .is('resolved_at', null)
    .order('first_seen_at', { ascending: false });

  return {
    acceptedYesterday: acceptedYesterday || [],
    outstanding:       stillOutstanding  || [],
  };
}

// ── Section 4: Estimates sent recently ───────────────────────────────────────
// SA's V2EstimateList_Query date filter operates on QuoteDate (creation date),
// not on the date the estimate was emailed. Broadening to 2 days captures
// same-day create-and-send workflows. SentDate is checked if present.

async function getEstimatesSentYesterday() {
  const raw = await getEstimateList({
    dateFrom: daysAgo(2),
    dateTo:   new Date(),
    stages:   ['Sent'],
    max:      200,
  });
  const estimates = raw.map(extractEstimate).filter(e => e.estimateId);

  // If the response includes a SentDate field, filter to yesterday only.
  // Otherwise fall through and show all returned (last 2 days).
  const firstRaw = raw[0] || {};
  const hasSentDate = 'SentDate' in firstRaw || 'EmailedDate' in firstRaw || 'StatusDate' in firstRaw;
  if (hasSentDate) {
    const yd = yesterday();
    const td = today();
    return estimates.filter(e => {
      const sd = e._raw.SentDate || e._raw.EmailedDate || e._raw.StatusDate;
      if (!sd) return false;
      const d = new Date(sd);
      return d >= yd && d < td;
    }).sort((a, b) => b.amount - a.amount);
  }

  return estimates.sort((a, b) => b.amount - a.amount);
}

// ── Section 5: Aging estimates ────────────────────────────────────────────────

async function getAgingEstimates() {
  const raw = await getEstimateList({
    dateFrom: daysAgo(90),
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
    .sort((a, b) => (b.daysOut || 0) - (a.daysOut || 0));
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

const CSS = `
  body { font-family: Segoe UI, Arial, sans-serif; font-size: 14px; color: #1a1a1a; margin: 0; padding: 0; background: #f4f4f4; }
  .wrap { max-width: 700px; margin: 20px auto; background: #fff; border-radius: 6px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
  .header { background: #1a3a5c; color: #fff; padding: 18px 24px; }
  .header h1 { margin: 0; font-size: 18px; font-weight: 600; }
  .header p  { margin: 4px 0 0; font-size: 12px; color: #aac4e0; }
  .section { padding: 16px 24px; border-bottom: 1px solid #eee; }
  .section:last-child { border-bottom: none; }
  .section-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: #555; margin: 0 0 10px; display: flex; align-items: center; gap: 8px; }
  .group-header { font-size: 12px; font-weight: 700; color: #1a3a5c; text-transform: uppercase; letter-spacing: .4px; padding: 8px 0 4px; border-top: 1px solid #dde3ea; margin-top: 8px; }
  .group-header:first-child { border-top: none; margin-top: 0; }
  .crew-header { font-size: 13px; font-weight: 700; color: #fff; background: #1a3a5c; padding: 5px 8px; margin-bottom: 0; }
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
  .sub  { font-size: 12px; color: #555; }
  .total-row td { font-weight: 700; background: #f8f9fa; border-top: 2px solid #dde3ea; }
  .empty { color: #888; font-size: 13px; padding: 6px 0; }
  .summary-box { background: #f0f4f8; border-radius: 4px; padding: 10px 14px; margin-bottom: 12px; font-size: 13px; }
  .summary-box strong { font-size: 15px; }
  .footer { background: #f8f9fa; padding: 10px 24px; font-size: 11px; color: #888; text-align: center; }
`;

// ── Dispatch table: grouped by crew, sorted by start_time ────────────────────

function dispatchSection(jobs) {
  if (!jobs.length) return '<p class="empty">Nothing scheduled for today.</p>';

  // Group by crew
  const crewMap = new Map();
  for (const j of jobs) {
    const crew = j.assigned || 'Unassigned';
    if (!crewMap.has(crew)) crewMap.set(crew, []);
    crewMap.get(crew).push(j);
  }
  const crews = [...crewMap.entries()].sort(([a], [b]) => {
    if (a === 'Unassigned') return 1;
    if (b === 'Unassigned') return -1;
    return a.localeCompare(b);
  });

  let html = '';
  for (const [crew, crewJobs] of crews) {
    const crewTotal = crewJobs.reduce((s, j) => s + (parseFloat(j.amount) || 0), 0);
    html += `<div class="crew-header">${crew} &mdash; ${crewJobs.length} job${crewJobs.length !== 1 ? 's' : ''} &mdash; ${fmt$(crewTotal)}</div>`;
    html += `<table>
      <thead><tr>
        <th>Client</th><th>Address</th><th>Service</th>
        <th>Time</th><th style="text-align:right">Amount</th>
      </tr></thead><tbody>`;
    for (const j of crewJobs) {
      const addr = [j.address, j.city].filter(Boolean).join(', ') || '—';
      const time = j.start_time ? j.start_time.slice(0, 5) : '—';
      html += `<tr>
        <td>${j.client || '—'}</td>
        <td class="sub">${addr}</td>
        <td>${j.service || '—'}</td>
        <td class="days">${time}</td>
        <td class="amount">${fmt$(j.amount)}</td>
      </tr>`;
    }
    html += '</tbody></table>';
  }
  return html;
}

// ── Estimate table: grouped by a key (job type or estimator) ─────────────────

function groupedEstimateTable(rows, groupFn, extraColLabel, extraColValue) {
  if (!rows.length) return '<p class="empty">None.</p>';

  const groups = new Map();
  for (const r of rows) {
    const key = groupFn(r) || 'Other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  let html = '';
  for (const [group, items] of [...groups.entries()].sort()) {
    const groupTotal = totalOf(items);
    html += `<div class="group-header">${group} &mdash; ${items.length} estimate${items.length !== 1 ? 's' : ''} &mdash; ${fmt$(groupTotal)}</div>`;
    html += `<table><thead><tr>
      <th>Client</th><th>Address</th><th>Estimator</th><th>Job Type</th>
      ${extraColLabel ? `<th>${extraColLabel}</th>` : ''}
      <th style="text-align:right">Amount</th>
    </tr></thead><tbody>`;
    for (const r of items) {
      html += `<tr>
        <td>${r.client_name || r.clientName || '—'}</td>
        <td class="sub">${r.address || '—'}</td>
        <td>${r.sales_rep || r.salesRep || '—'}</td>
        <td>${r.service_type || r.serviceType || '—'}</td>
        ${extraColLabel ? `<td class="days">${extraColValue(r)}</td>` : ''}
        <td class="amount">${fmt$(r.amount)}</td>
      </tr>`;
    }
    const colspan = extraColLabel ? 5 : 4;
    html += `<tr class="total-row">
      <td colspan="${colspan}" style="text-align:right;padding-right:8px">Subtotal</td>
      <td class="amount">${fmt$(groupTotal)}</td>
    </tr>`;
    html += '</tbody></table>';
  }
  return html;
}

// Simple flat estimate table (for accepted yesterday — no grouping needed)
function estimateTable(rows, extraColLabel, extraColValue) {
  if (!rows.length) return '<p class="empty">None.</p>';
  let html = `<table><thead><tr>
    <th>Client</th><th>Address</th><th>Estimator</th><th>Job Type</th>
    ${extraColLabel ? `<th>${extraColLabel}</th>` : ''}
    <th style="text-align:right">Amount</th>
  </tr></thead><tbody>`;
  for (const r of rows) {
    html += `<tr>
      <td>${r.client_name || r.clientName || '—'}</td>
      <td class="sub">${r.address || '—'}</td>
      <td>${r.sales_rep || r.salesRep || '—'}</td>
      <td>${r.service_type || r.serviceType || '—'}</td>
      ${extraColLabel ? `<td class="days">${extraColValue(r)}</td>` : ''}
      <td class="amount">${fmt$(r.amount)}</td>
    </tr>`;
  }
  const total   = totalOf(rows);
  const colspan = extraColLabel ? 5 : 4;
  html += `<tr class="total-row">
    <td colspan="${colspan}" style="text-align:right;padding-right:8px">Total</td>
    <td class="amount">${fmt$(total)}</td>
  </tr>`;
  html += '</tbody></table>';
  return html;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function generateOvernightReport() {
  logger.info('overnight-report: starting');

  const [wonResult, sentResult, agingResult, dispatchResult] = await Promise.allSettled([
    syncWonEstimates(),
    getEstimatesSentYesterday(),
    getAgingEstimates(),
    getTodayJobs(),
  ]);

  const { acceptedYesterday = [], outstanding = [] } =
    wonResult.status === 'fulfilled' ? wonResult.value : {};
  const sent    = sentResult.status === 'fulfilled'    ? sentResult.value    : [];
  const aging   = agingResult.status === 'fulfilled'   ? agingResult.value   : [];
  const todayQ  = dispatchResult.status === 'fulfilled' ? dispatchResult.value : [];

  if (wonResult.status === 'rejected')
    logger.error('overnight-report: won sync failed',     { err: wonResult.reason?.message });
  if (sentResult.status === 'rejected')
    logger.error('overnight-report: sent query failed',   { err: sentResult.reason?.message });
  if (agingResult.status === 'rejected')
    logger.error('overnight-report: aging query failed',  { err: agingResult.reason?.message });
  if (dispatchResult.status === 'rejected')
    logger.error('overnight-report: dispatch failed',     { err: dispatchResult.reason?.message });

  const dateLabel        = formatDate(yesterday());
  const outstandingTotal = totalOf(outstanding);

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="wrap">

  <div class="header">
    <h1>JRB Daily Morning Report</h1>
    <p>${formatDate(new Date())} &mdash; Activity for ${dateLabel}</p>
  </div>

  <!-- Section 1: Today's Dispatch -->
  <div class="section">
    <div class="section-title">
      📅 Today's Dispatch
      <span class="badge">${todayQ.length} job${todayQ.length !== 1 ? 's' : ''}</span>
    </div>
    ${dispatchSection(todayQ)}
  </div>

  <!-- Section 2: Jobs Accepted Yesterday -->
  <div class="section">
    <div class="section-title">
      ✅ Jobs Accepted Yesterday
      <span class="badge green">${acceptedYesterday.length}</span>
    </div>
    ${estimateTable(acceptedYesterday)}
  </div>

  <!-- Section 3: Awaiting Waiting List — grouped by job type -->
  <div class="section">
    <div class="section-title">
      ⏳ Accepted — Awaiting Waiting List
      <span class="badge orange">${outstanding.length}</span>
    </div>
    ${outstanding.length > 0
      ? `<div class="summary-box">
           Total pipeline: <strong>${fmt$(outstandingTotal)}</strong> across ${outstanding.length} job${outstanding.length !== 1 ? 's' : ''}
         </div>`
      : ''}
    ${groupedEstimateTable(
      outstanding,
      r => categorizeJobType(r.service_type || r.serviceType || ''),
      'Days Since Won',
      r => {
        const d = r.first_seen_at ? daysBetween(new Date(r.first_seen_at), new Date()) : null;
        return d != null ? `${d}d` : '—';
      },
    )}
  </div>

  <!-- Section 4: Estimates Sent Recently — grouped by estimator -->
  <div class="section">
    <div class="section-title">
      📝 Estimates Sent Yesterday
      <span class="badge">${sent.length}</span>
    </div>
    ${groupedEstimateTable(
      sent,
      r => r.salesRep || '—',
      null,
      null,
    )}
  </div>

  <!-- Section 5: Aging Estimates — grouped by estimator -->
  <div class="section">
    <div class="section-title">
      ⚠️ Aging Estimates — No Response (7+ days)
      <span class="badge red">${aging.length}</span>
    </div>
    ${groupedEstimateTable(
      aging,
      r => r.salesRep || '—',
      'Days Out',
      r => r.daysOut != null ? `${r.daysOut}d` : '—',
    )}
  </div>

  <div class="footer">Sent by JRB Executive Assistant &mdash; ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT</div>
</div>
</body></html>`;

  const subject = `JRB Morning Report — ${dateLabel} | ${acceptedYesterday.length} accepted, ${outstanding.length} awaiting WL, ${todayQ.length} on dispatch`;

  logger.info('overnight-report: complete', {
    accepted:    acceptedYesterday.length,
    outstanding: outstanding.length,
    sent:        sent.length,
    aging:       aging.length,
    todayJobs:   todayQ.length,
  });

  return { subject, body: html };
}
