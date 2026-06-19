// tools/impl/weekly-finance-report.js
// Consolidated Sunday 6 AM weekly finance report.
// Sections: Revenue | Accounts Receivable | Credit Card Expenses | Reconciliation & Errors | Unrecorded Payments

import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';
import { sendEmail } from './m365.js';
import {
  getPaymentsForWeek,
  getARAgingReport,
  getInvoicesForWeek,
  getOldNationalDeposits,
} from './quickbooks.js';

const supabase = createClient(
  process.env.FLEETOPS_SUPABASE_URL,
  process.env.FLEETOPS_SUPABASE_SERVICE_KEY
);

// ── Date helpers ────────────────────────────────────────────────────────────

export function getPriorWeekRange() {
  const now = new Date();
  const dow = now.getUTCDay(); // 0=Sun
  const thisSun = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dow));
  const lastMon = new Date(thisSun); lastMon.setUTCDate(thisSun.getUTCDate() - 6);
  const lastSun = new Date(thisSun); lastSun.setUTCDate(thisSun.getUTCDate() - 0);

  const fmt = d => d.toISOString().slice(0, 10);
  const label = (d, opts) => d.toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });

  const thu = new Date(lastMon); thu.setUTCDate(lastMon.getUTCDate() + 3);
  const yearStart = new Date(Date.UTC(thu.getUTCFullYear(), 0, 1));
  const wn = Math.ceil(((thu - yearStart) / 86400000 + 1) / 7);
  const weekLabel = `${thu.getUTCFullYear()}-W${String(wn).padStart(2, '0')}`;

  return {
    start: fmt(lastMon),
    end: fmt(lastSun),
    weekLabel,
    displayRange: `${label(lastMon, { month: 'short', day: 'numeric' })} – ${label(lastSun, { month: 'short', day: 'numeric', year: 'numeric' })}`,
  };
}

// ── Data gathering ──────────────────────────────────────────────────────────

async function gatherExpenseData(start, end) {
  const from = new Date(start + 'T00:00:00Z').toISOString();
  const to   = new Date(end   + 'T23:59:59Z').toISOString();
  const { data, error } = await supabase
    .from('expense_reports')
    .select('*')
    .gte('created_at', from)
    .lte('created_at', to)
    .order('amount', { ascending: false });
  if (error) throw new Error(`Supabase expense query: ${error.message}`);
  return data ?? [];
}

async function gatherAuditIssues() {
  const { data, error } = await supabase
    .from('audit_issues')
    .select('*')
    .eq('status', 'open')
    .order('severity', { ascending: true })
    .order('last_seen_at', { ascending: false });
  if (error) throw new Error(`Supabase audit query: ${error.message}`);
  return data ?? [];
}

async function gatherAMEMatches() {
  const { data, error } = await supabase
    .from('audit_matches')
    .select('*')
    .in('match_status', ['discrepancy', 'unmatched_sa', 'unmatched_qb']);
  if (error) { logger.warn('AME matches query failed', { err: error.message }); return []; }
  return data ?? [];
}

async function gatherSAPaymentTotals(start, end) {
  const { data, error } = await supabase
    .from('sa_payments')
    .select('payment_amount, synced_at')
    .gte('payment_date', start)
    .lte('payment_date', end)
    .eq('deleted', false);
  if (error) { logger.warn('SA payment totals query failed', { err: error.message }); return null; }
  const rows = data ?? [];
  const total = rows.reduce((s, r) => s + Number(r.payment_amount || 0), 0);
  const lastSync = rows.length ? rows.reduce((max, r) => r.synced_at > max ? r.synced_at : max, '') : null;
  return { count: rows.length, total, lastSync };
}

async function gatherUnrecordedPayments() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const [{ data: qbPmts, error: e1 }, { data: saPmts, error: e2 }] = await Promise.all([
    supabase.from('qb_payments').select('qb_id,customer_name,amount,date,payment_method').gte('date', cutoffStr).order('date', { ascending: false }),
    supabase.from('sa_payments').select('sa_id,client,payment_amount,payment_date').gte('payment_date', cutoffStr).eq('deleted', false),
  ]);
  if (e1 || e2) { logger.warn('Unrecorded payments query failed', { e1: e1?.message, e2: e2?.message }); return []; }

  // Flag QB payments with no SA payment match (same amount ±$1, within 14 days)
  const unrecorded = [];
  for (const qb of (qbPmts ?? [])) {
    const qbDate = new Date(qb.date + 'T12:00:00Z');
    const qbAmt  = Number(qb.amount);
    const match = (saPmts ?? []).find(sa => {
      if (Math.abs(Number(sa.payment_amount) - qbAmt) > 1) return false;
      const saDate = new Date(sa.payment_date + 'T12:00:00Z');
      return Math.abs(saDate - qbDate) <= 14 * 86400000;
    });
    if (!match) unrecorded.push(qb);
  }
  return unrecorded;
}

// ── Formatting helpers ──────────────────────────────────────────────────────

const f$ = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fD = s => s ? new Date(s.length === 10 ? s + 'T12:00:00Z' : s).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }) : '—';
const dayName = s => s ? new Date(s + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' }) : '—';
const ageBadge = days => {
  if (days <= 0) return `<span style="font-size:11px;color:#888888;">due ${fD(new Date(Date.now() - days * 86400000).toISOString().slice(0,10))}</span>`;
  if (days <= 30) return `<span style="font-size:11px;color:#b35900;font-weight:bold;">${days}d past due</span>`;
  if (days <= 60) return `<span style="font-size:11px;color:#c0392b;font-weight:bold;">${days}d past due</span>`;
  return `<span style="font-size:11px;color:#c0392b;font-weight:bold;background:#fff0f0;padding:1px 4px;border-radius:2px;">${days}d PAST DUE</span>`;
};

function sectionHeader(title) {
  return `<p style="margin:28px 0 10px 0;font-size:13px;font-weight:bold;text-transform:uppercase;letter-spacing:0.8px;color:#888888;border-bottom:1px solid #e8e8e8;padding-bottom:6px;">${title}</p>`;
}

function alertBox(color, borderColor, title, rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${color};border-left:4px solid ${borderColor};border-radius:4px;margin-bottom:16px;"><tr><td style="padding:12px 16px;"><p style="margin:0 0 8px 0;font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:0.8px;color:${borderColor};">${title}</p>${rows}</td></tr></table>`;
}

// ── HTML email builder ──────────────────────────────────────────────────────

function buildEmail({ weekLabel, displayRange, payments, arAging, invoices, deposits, expenses, auditIssues, ameMatches, saPaymentTotals, unrecordedPayments }) {
  const totalCollected = payments.reduce((s, p) => s + p.amount, 0);
  const totalAR        = arAging.total;

  const earnedNotInvoiced = auditIssues
    .filter(i => i.issue_type === 'unbilled_complete')
    .sort((a, b) => (b.sa_amount ?? 0) - (a.sa_amount ?? 0));

  const revByCat = {};
  for (const inv of invoices) {
    revByCat[inv.category] = (revByCat[inv.category] ?? 0) + inv.totalAmt;
  }
  const totalInvoiced = invoices.reduce((s, i) => s + i.totalAmt, 0);
  const totalUnbilled = earnedNotInvoiced.reduce((s, i) => s + (i.sa_amount ?? 0), 0);

  const expTotal     = expenses.reduce((s, e) => s + Number(e.amount ?? 0), 0);
  const expPending   = expenses.filter(e => e.status === 'pending_employee');
  const expMaintLogs = expenses.filter(e => e.status === 'pending_maintenance_log');
  const expFlags     = expenses.filter(e => Number(e.amount) > 500);
  const expByEmp     = {};
  for (const e of expenses) {
    const n = e.employee_name || e.card_last_four || '?';
    if (!expByEmp[n]) expByEmp[n] = { total: 0, count: 0, pending: 0 };
    expByEmp[n].total   += Number(e.amount ?? 0);
    expByEmp[n].count   += 1;
    expByEmp[n].pending += (e.status === 'pending_employee' || e.status === 'pending_maintenance_log') ? 1 : 0;
  }

  const highIssues = auditIssues.filter(i => i.severity === 'high');

  let html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Weekly Finance Report ${weekLabel}</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" style="max-width:620px;background-color:#ffffff;border-radius:6px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

<!-- HEADER -->
<tr><td style="background-color:#1a1a2e;padding:24px 32px;">
  <p style="margin:0;color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:0.5px;">J.R. Boehlke, LLC</p>
  <p style="margin:4px 0 0;color:#aaaacc;font-size:13px;">Weekly Finance Report &nbsp;|&nbsp; ${weekLabel} &nbsp;|&nbsp; ${displayRange}</p>
</td></tr>

<!-- BODY -->
<tr><td style="padding:28px 32px;">`;

  // ── Snapshot KPIs ──────────────────────────────────────────────────────────
  html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f4ff;border-radius:4px;margin-bottom:20px;">
<tr>
  <td style="padding:14px 16px;text-align:center;border-right:1px solid #d8e0f0;">
    <p style="margin:0;font-size:20px;font-weight:bold;color:#1a6e1a;">${f$(totalCollected)}</p>
    <p style="margin:2px 0 0;font-size:11px;color:#555577;text-transform:uppercase;letter-spacing:0.6px;">Collected</p>
  </td>
  <td style="padding:14px 16px;text-align:center;border-right:1px solid #d8e0f0;">
    <p style="margin:0;font-size:20px;font-weight:bold;color:#1a1a2e;">${f$(totalInvoiced)}</p>
    <p style="margin:2px 0 0;font-size:11px;color:#555577;text-transform:uppercase;letter-spacing:0.6px;">Invoiced</p>
  </td>
  <td style="padding:14px 16px;text-align:center;border-right:1px solid #d8e0f0;">
    <p style="margin:0;font-size:20px;font-weight:bold;color:#b35900;">${f$(totalAR)}</p>
    <p style="margin:2px 0 0;font-size:11px;color:#555577;text-transform:uppercase;letter-spacing:0.6px;">Total Open AR</p>
  </td>
  <td style="padding:14px 16px;text-align:center;">
    <p style="margin:0;font-size:20px;font-weight:bold;color:${expTotal > 0 ? '#c0392b' : '#333'};">${f$(expTotal)}</p>
    <p style="margin:2px 0 0;font-size:11px;color:#555577;text-transform:uppercase;letter-spacing:0.6px;">Card Spend</p>
  </td>
</tr></table>`;

  // ── Priority alert bar ─────────────────────────────────────────────────────
  const pastDue = (arAging.flagged ?? []).filter(r => r.ageDays > 14).slice(0, 5);
  if (pastDue.length) {
    let rows = pastDue.map(r =>
      `<tr><td style="padding:3px 0;font-size:13px;color:#533f03;">${r.customer}</td><td style="padding:3px 0;font-size:13px;color:#533f03;font-weight:bold;text-align:right;">${f$(r.balance)}</td></tr>`
    ).join('');
    html += alertBox('#fff3cd', '#e6a817', 'Past-Due Priority Calls',
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`);
  }
  if (highIssues.length) {
    const issRows = highIssues.slice(0, 4).map(i =>
      `<p style="margin:3px 0;font-size:13px;color:#c0392b;">${i.description}</p>`
    ).join('');
    html += alertBox('#fff5f5', '#c0392b', `${highIssues.length} High-Priority Reconciliation Issue${highIssues.length > 1 ? 's' : ''}`, issRows);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 1 — REVENUE
  // ══════════════════════════════════════════════════════════════════════════
  html += sectionHeader('Section 1 — Revenue');

  html += `<p style="margin:0 0 10px;font-size:13px;font-weight:bold;color:#444444;">Invoiced This Week &mdash; ${f$(totalInvoiced)}</p>`;
  if (Object.keys(revByCat).length) {
    const catOrder = ['Asphalt','Concrete Construction','Landscape Construction','Landscape Maintenance','Snow','Other'];
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px;">`;
    for (const cat of catOrder) {
      if (!revByCat[cat]) continue;
      const pct = totalInvoiced > 0 ? Math.round((revByCat[cat] / totalInvoiced) * 100) : 0;
      html += `<tr>
        <td style="padding:5px 8px;font-size:13px;color:#333333;">${cat}</td>
        <td style="padding:5px 8px;font-size:13px;color:#333333;text-align:right;white-space:nowrap;font-weight:bold;">${f$(revByCat[cat])}</td>
        <td style="padding:5px 8px;font-size:12px;color:#888888;text-align:right;white-space:nowrap;">${pct}%</td>
      </tr>`;
    }
    html += `</table>`;
  } else {
    html += `<p style="margin:0 0 10px;font-size:13px;color:#888888;font-style:italic;">No invoices issued this week.</p>`;
  }

  if (earnedNotInvoiced.length) {
    html += `<p style="margin:0 0 6px;font-size:13px;color:#444444;"><strong>Earned but Not Yet Invoiced &mdash; ${f$(totalUnbilled)}</strong> (${earnedNotInvoiced.length} SA jobs completed, no QB invoice)</p>`;
    const topUnbilled = earnedNotInvoiced.slice(0, 6);
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px;">`;
    for (const [i, u] of topUnbilled.entries()) {
      html += `<tr style="${i % 2 ? 'background:#f8f8f8;' : ''}">
        <td style="padding:5px 8px;font-size:13px;color:#333333;">${u.sa_client ?? '—'}</td>
        <td style="padding:5px 8px;font-size:13px;color:#b35900;font-weight:bold;text-align:right;white-space:nowrap;">${f$(u.sa_amount ?? 0)}</td>
      </tr>`;
    }
    if (earnedNotInvoiced.length > 6) {
      html += `<tr><td colspan="2" style="padding:5px 8px;font-size:12px;color:#888888;">… and ${earnedNotInvoiced.length - 6} more</td></tr>`;
    }
    html += `</table>`;
  }

  // Payments received
  html += `<p style="margin:16px 0 8px;font-size:13px;font-weight:bold;color:#444444;">Payments Received (${payments.length} transactions &mdash; ${f$(totalCollected)})</p>`;

  // SA vs QB payment discrepancy callout
  if (saPaymentTotals) {
    const countDiff = saPaymentTotals.count - payments.length;
    const amtDiff   = saPaymentTotals.total - totalCollected;
    if (Math.abs(countDiff) > 0 || Math.abs(amtDiff) > 1) {
      const syncNote = saPaymentTotals.lastSync
        ? `SA data as of ${fD(saPaymentTotals.lastSync.slice(0,10))}`
        : 'SA data from last AME sync';
      html += alertBox('#fff8f0', '#e6a817', 'QB vs SA Payment Discrepancy',
        `<p style="margin:3px 0;font-size:13px;color:#533f03;">QB: ${payments.length} payments &mdash; ${f$(totalCollected)}</p>
         <p style="margin:3px 0;font-size:13px;color:#533f03;">SA: ${saPaymentTotals.count} payments &mdash; ${f$(saPaymentTotals.total)}</p>
         <p style="margin:6px 0 0;font-size:12px;color:#888888;">Difference: ${Math.abs(countDiff)} payment${Math.abs(countDiff) !== 1 ? 's' : ''}, ${f$(Math.abs(amtDiff))} &mdash; ${syncNote}. May include payments not yet synced to QB.</p>`);
    }
  }

  if (payments.length) {
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
    <tr style="background-color:#f8f8f8;">
      <td style="padding:5px 8px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;">Day</td>
      <td style="padding:5px 8px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;">Customer</td>
      <td style="padding:5px 8px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Amount</td>
    </tr>`;
    for (let i = 0; i < payments.length; i++) {
      const p = payments[i];
      const hasFlag = p.memo && /unappl/i.test(p.memo);
      const bgColor = i % 2 === 0 ? '#ffffff' : '#f8f8f8';
      html += `<tr style="background-color:${hasFlag ? '#fff8f0' : bgColor};">
        <td style="padding:5px 8px;font-size:13px;color:#888888;white-space:nowrap;">${dayName(p.date)}</td>
        <td style="padding:5px 8px;font-size:13px;color:#333333;">${p.customerName}${hasFlag ? ' <span style="font-size:11px;color:#b35900;font-weight:bold;">&#9888; unapplied</span>' : ''}</td>
        <td style="padding:5px 8px;font-size:13px;color:#333333;font-weight:${p.amount >= 5000 ? 'bold' : 'normal'};text-align:right;white-space:nowrap;">${f$(p.amount)}</td>
      </tr>`;
    }
    html += `</table>`;

    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1a2e;border-radius:4px;margin-bottom:14px;">
    <tr>
      <td style="padding:10px 16px;font-size:13px;color:#aaaacc;font-weight:bold;">Week Total</td>
      <td style="padding:10px 16px;font-size:15px;color:#ffffff;font-weight:bold;text-align:right;">${f$(totalCollected)}</td>
    </tr></table>`;
  }

  const unidentified = deposits.filter(d => d.hasUnidentifiedCash);
  if (unidentified.length) {
    const rows = unidentified.map(d =>
      `<p style="margin:3px 0;font-size:13px;color:#533f03;">${fD(d.date)} &mdash; ${f$(d.unlinkedTotal)} unclassified cash in deposit #${d.id}${d.memo ? ` (${d.memo.slice(0,60)})` : ''}</p>`
    ).join('');
    html += alertBox('#fff8f0', '#e6a817', 'Old National — Unidentified Cash Deposits', rows);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 2 — ACCOUNTS RECEIVABLE
  // ══════════════════════════════════════════════════════════════════════════
  html += sectionHeader('Section 2 — Accounts Receivable');

  const bucketDefs = [
    { key: 'current',  label: 'Current',   color: '#1a6e1a' },
    { key: 'd30',      label: '1–30 days',  color: '#b35900' },
    { key: 'd60',      label: '31–60 days', color: '#c0392b' },
    { key: 'd90',      label: '61–90 days', color: '#c0392b' },
    { key: 'd120plus', label: '90+ days',   color: '#c0392b' },
  ];
  html += `<p style="margin:0 0 8px;font-size:13px;font-weight:bold;color:#444444;">AR Aging &mdash; Total Open: ${f$(totalAR)}</p>`;
  html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
  <tr style="background-color:#f8f8f8;">
    <td style="padding:6px 8px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;">Bucket</td>
    <td style="padding:6px 8px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;"># Invoices</td>
    <td style="padding:6px 8px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Total</td>
  </tr>`;
  for (const b of bucketDefs) {
    const list = arAging.buckets[b.key] ?? [];
    if (!list.length) continue;
    const sum = list.reduce((s, r) => s + r.balance, 0);
    html += `<tr>
      <td style="padding:6px 8px;font-size:13px;color:#333333;">${b.label}</td>
      <td style="padding:6px 8px;font-size:13px;color:#555555;text-align:right;">${list.length}</td>
      <td style="padding:6px 8px;font-size:13px;font-weight:bold;color:${b.color};text-align:right;white-space:nowrap;">${f$(sum)}</td>
    </tr>`;
  }
  html += `</table>`;

  // Significantly aged accounts (60+ days) — grouped by customer, sorted by total overdue
  const agedAccounts = [...(arAging.buckets.d60 ?? []), ...(arAging.buckets.d90 ?? []), ...(arAging.buckets.d120plus ?? [])];
  if (agedAccounts.length) {
    // Group by customer name
    const byCustomer = {};
    for (const r of agedAccounts) {
      if (!byCustomer[r.customer]) byCustomer[r.customer] = { invoices: [], total: 0 };
      byCustomer[r.customer].invoices.push(r);
      byCustomer[r.customer].total += r.balance;
    }
    // Sort customers by total overdue descending
    const sortedCustomers = Object.entries(byCustomer).sort((a, b) => b[1].total - a[1].total);

    html += `<p style="margin:0 0 8px;font-size:13px;font-weight:bold;color:#c0392b;">Significantly Aged (60+ Days)</p>`;
    for (const [customer, { invoices, total }] of sortedCustomers) {
      // Sort invoices within customer by age desc
      invoices.sort((a, b) => b.ageDays - a.ageDays);
      html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;">
      <tr style="background-color:#fff0f0;">
        <td style="padding:6px 8px;font-size:13px;font-weight:bold;color:#c0392b;">${customer}</td>
        <td style="padding:6px 8px;font-size:12px;color:#888888;text-align:center;">${invoices.length} invoice${invoices.length > 1 ? 's' : ''}</td>
        <td style="padding:6px 8px;font-size:13px;font-weight:bold;color:#c0392b;text-align:right;white-space:nowrap;">${f$(total)}</td>
      </tr>`;
      for (const r of invoices) {
        html += `<tr style="background-color:#fffafa;">
          <td style="padding:4px 8px 4px 20px;font-size:12px;color:#888888;">INV #${r.invoiceNum}</td>
          <td style="padding:4px 8px;text-align:center;">${ageBadge(r.ageDays)}</td>
          <td style="padding:4px 8px;font-size:12px;color:#c0392b;text-align:right;white-space:nowrap;">${f$(r.balance)}</td>
        </tr>`;
      }
      html += `</table>`;
    }
  }

  // Top 10 open balances
  const top10 = [
    ...(arAging.buckets.current ?? []),
    ...(arAging.buckets.d30 ?? []),
    ...(arAging.buckets.d60 ?? []),
    ...(arAging.buckets.d90 ?? []),
    ...(arAging.buckets.d120plus ?? []),
  ]
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 10);

  if (top10.length) {
    html += `<p style="margin:0 0 8px;font-size:13px;font-weight:bold;color:#444444;">Top 10 Open Balances</p>`;
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
    <tr style="background-color:#f8f8f8;">
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;width:24px;">#</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;">Customer</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Balance</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Status</td>
    </tr>`;
    for (let i = 0; i < top10.length; i++) {
      const r = top10[i];
      const isPastDue = r.ageDays > 0;
      html += `<tr style="background-color:${isPastDue ? '#fff5f5' : i % 2 ? '#f8f8f8' : '#ffffff'};">
        <td style="padding:6px 6px;font-size:13px;color:#888888;">${i + 1}</td>
        <td style="padding:6px 6px;font-size:13px;color:#333333;">${r.customer}<br><span style="font-size:11px;color:#888888;">INV #${r.invoiceNum}</span></td>
        <td style="padding:6px 6px;font-size:13px;font-weight:bold;color:${isPastDue ? '#c0392b' : '#333333'};text-align:right;white-space:nowrap;">${f$(r.balance)}</td>
        <td style="padding:6px 6px;text-align:right;white-space:nowrap;">${ageBadge(r.ageDays)}</td>
      </tr>`;
    }
    html += `</table>`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 3 — CREDIT CARD EXPENSES
  // ══════════════════════════════════════════════════════════════════════════
  html += sectionHeader('Section 3 — Credit Card Expenses');

  if (!expenses.length) {
    html += `<p style="margin:0 0 16px;font-size:13px;color:#888888;font-style:italic;">No credit card charges this week.</p>`;
  } else {
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8f8f8;border-radius:4px;margin-bottom:14px;">
    <tr>
      <td style="padding:10px 16px;text-align:center;border-right:1px solid #e8e8e8;">
        <p style="margin:0;font-size:18px;font-weight:bold;color:#c0392b;">${f$(expTotal)}</p>
        <p style="margin:2px 0 0;font-size:11px;color:#888888;text-transform:uppercase;">Total Spend</p>
      </td>
      <td style="padding:10px 16px;text-align:center;border-right:1px solid #e8e8e8;">
        <p style="margin:0;font-size:18px;font-weight:bold;color:#333333;">${expenses.length}</p>
        <p style="margin:2px 0 0;font-size:11px;color:#888888;text-transform:uppercase;">Charges</p>
      </td>
      <td style="padding:10px 16px;text-align:center;border-right:1px solid #e8e8e8;">
        <p style="margin:0;font-size:18px;font-weight:bold;color:${expPending.length ? '#c0392b' : '#1a6e1a'};">${expPending.length}</p>
        <p style="margin:2px 0 0;font-size:11px;color:#888888;text-transform:uppercase;">Pending</p>
      </td>
      <td style="padding:10px 16px;text-align:center;">
        <p style="margin:0;font-size:18px;font-weight:bold;color:${expFlags.length ? '#c0392b' : '#1a6e1a'};">${expFlags.length}</p>
        <p style="margin:2px 0 0;font-size:11px;color:#888888;text-transform:uppercase;">Flags (&gt;$500)</p>
      </td>
    </tr></table>`;

    html += `<p style="margin:0 0 6px;font-size:13px;font-weight:bold;color:#444444;">By Employee</p>`;
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px;">
    <tr style="background-color:#f8f8f8;">
      <td style="padding:5px 8px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;">Employee</td>
      <td style="padding:5px 8px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Charges</td>
      <td style="padding:5px 8px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Total</td>
      <td style="padding:5px 8px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Pending</td>
    </tr>`;
    for (const [name, e] of Object.entries(expByEmp).sort((a, b) => b[1].total - a[1].total)) {
      html += `<tr>
        <td style="padding:5px 8px;font-size:13px;color:#333333;font-weight:bold;">${name}</td>
        <td style="padding:5px 8px;font-size:13px;color:#555555;text-align:right;">${e.count}</td>
        <td style="padding:5px 8px;font-size:13px;font-weight:bold;color:#c0392b;text-align:right;">${f$(e.total)}</td>
        <td style="padding:5px 8px;font-size:13px;color:${e.pending ? '#c0392b' : '#1a6e1a'};font-weight:bold;text-align:right;">${e.pending}</td>
      </tr>`;
    }
    html += `</table>`;

    if (expFlags.length) {
      const flagRows = expFlags.map(e =>
        `<p style="margin:3px 0;font-size:13px;color:#c0392b;">${fD(e.transaction_date)} &mdash; ${e.employee_name || '?'} &mdash; ${e.vendor || 'Unknown vendor'} &mdash; <strong>${f$(e.amount)}</strong>${e.category ? ` (${e.category})` : ''}</p>`
      ).join('');
      html += alertBox('#fff5f5', '#c0392b', `${expFlags.length} Large Charge${expFlags.length > 1 ? 's' : ''} (&gt;$500)`, flagRows);
    }

    if (expPending.length) {
      const pendRows = expPending.map(e =>
        `<p style="margin:3px 0;font-size:13px;color:#533f03;">${fD(e.transaction_date)} &mdash; ${e.employee_name || '?'} &mdash; ${e.vendor || '?'} &mdash; ${f$(e.amount)}</p>`
      ).join('');
      html += alertBox('#fff8f0', '#e6a817', `${expPending.length} Receipt${expPending.length > 1 ? 's' : ''} Not Submitted`, pendRows);
    }

    if (expMaintLogs.length) {
      const maintRows = expMaintLogs.map(e =>
        `<p style="margin:3px 0;font-size:13px;color:#533f03;">${fD(e.transaction_date)} &mdash; ${e.employee_name || '?'} &mdash; ${e.vendor || '?'} &mdash; ${f$(e.amount)}</p>`
      ).join('');
      html += alertBox('#fff8f0', '#e6a817', `${expMaintLogs.length} Maintenance Log${expMaintLogs.length > 1 ? 's' : ''} Needed`, maintRows);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 4 — RECONCILIATION & ERRORS
  // Uses both audit_issues (high-level) and audit_matches (invoice-level AME)
  // ══════════════════════════════════════════════════════════════════════════
  html += sectionHeader('Section 4 — Reconciliation & Errors');

  // audit_issues: unbilled completed jobs, overdue invoices, SA nonzero balances
  const issueTypes = {
    unbilled_complete: { label: 'SA Completed — No QB Invoice',   color: '#c0392b' },
    overdue_invoice:   { label: 'QB Invoices Overdue (30d+)',      color: '#b35900' },
    nonzero_balance:   { label: 'SA Clients with Open Balance',    color: '#888888' },
  };
  let hasAnyIssue = false;
  for (const [type, meta] of Object.entries(issueTypes)) {
    const issues = auditIssues.filter(i => i.issue_type === type);
    if (!issues.length) continue;
    hasAnyIssue = true;
    const total = issues.reduce((s, i) => s + Math.abs(i.qbo_amount ?? i.sa_amount ?? 0), 0);
    html += `<p style="margin:12px 0 6px;font-size:13px;font-weight:bold;color:${meta.color};">${meta.label} &mdash; ${issues.length} issue${issues.length > 1 ? 's' : ''} (${f$(total)})</p>`;
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">`;
    for (let i = 0; i < Math.min(issues.length, 8); i++) {
      const iss = issues[i];
      const age = Math.floor((Date.now() - new Date(iss.first_seen_at).getTime()) / 86400000);
      html += `<tr style="background-color:${i % 2 ? '#f8f8f8' : '#ffffff'};">
        <td style="padding:5px 8px;font-size:13px;color:#333333;">${iss.description}</td>
        <td style="padding:5px 8px;font-size:12px;color:#888888;text-align:right;white-space:nowrap;">${age === 0 ? 'new' : `${age}d`}</td>
      </tr>`;
    }
    if (issues.length > 8) html += `<tr><td colspan="2" style="padding:5px 8px;font-size:12px;color:#888888;">… and ${issues.length - 8} more</td></tr>`;
    html += `</table>`;
  }

  // AME invoice-level mismatches
  const ameByStatus = {
    discrepancy:    { label: 'Invoice Amount Mismatches (QB ≠ SA)',  color: '#b35900' },
    unmatched_qb:   { label: 'QB Invoices — No SA Match',            color: '#c0392b' },
    unmatched_sa:   { label: 'SA Invoices — No QB Match',            color: '#c0392b' },
  };
  for (const [status, meta] of Object.entries(ameByStatus)) {
    const matches = ameMatches.filter(m => m.match_status === status);
    if (!matches.length) continue;
    hasAnyIssue = true;
    const totalDiff = status === 'discrepancy'
      ? matches.reduce((s, m) => s + Math.abs(m.amount_diff ?? 0), 0)
      : matches.reduce((s, m) => s + Math.abs(m.sa_amount ?? m.qb_amount ?? 0), 0);
    html += `<p style="margin:12px 0 6px;font-size:13px;font-weight:bold;color:${meta.color};">${meta.label} &mdash; ${matches.length} (${f$(totalDiff)})</p>`;
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
    <tr style="background-color:#f8f8f8;">
      <td style="padding:5px 8px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;">Customer</td>
      ${status === 'discrepancy' ? '<td style="padding:5px 8px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">SA Amt</td><td style="padding:5px 8px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">QB Amt</td><td style="padding:5px 8px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Diff</td>' : '<td style="padding:5px 8px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Amount</td>'}
    </tr>`;
    for (let i = 0; i < Math.min(matches.length, 10); i++) {
      const m = matches[i];
      const name = m.sa_customer || m.qb_customer || '—';
      html += `<tr style="background-color:${i % 2 ? '#f8f8f8' : '#ffffff'};">
        <td style="padding:5px 8px;font-size:13px;color:#333333;">${name}</td>
        ${status === 'discrepancy'
          ? `<td style="padding:5px 8px;font-size:12px;color:#555;text-align:right;">${f$(m.sa_amount)}</td><td style="padding:5px 8px;font-size:12px;color:#555;text-align:right;">${f$(m.qb_amount)}</td><td style="padding:5px 8px;font-size:13px;font-weight:bold;color:#b35900;text-align:right;">${f$(Math.abs(m.amount_diff))}</td>`
          : `<td style="padding:5px 8px;font-size:13px;color:#c0392b;font-weight:bold;text-align:right;">${f$(m.sa_amount ?? m.qb_amount)}</td>`}
      </tr>`;
    }
    const colspan = status === 'discrepancy' ? 4 : 2;
    if (matches.length > 10) html += `<tr><td colspan="${colspan}" style="padding:5px 8px;font-size:12px;color:#888888;">… and ${matches.length - 10} more</td></tr>`;
    html += `</table>`;
  }

  if (!hasAnyIssue) {
    html += `<p style="margin:0 0 16px;font-size:13px;color:#1a6e1a;font-style:italic;">No open reconciliation issues. QB ↔ SA are in sync.</p>`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 5 — UNRECORDED PAYMENTS
  // QB payments (last 90 days) with no matching SA payment
  // ══════════════════════════════════════════════════════════════════════════
  html += sectionHeader('Section 5 — Unrecorded Payments (QB received, not in SA)');

  if (!unrecordedPayments.length) {
    html += `<p style="margin:0 0 16px;font-size:13px;color:#1a6e1a;font-style:italic;">No unrecorded payments found in the last 90 days.</p>`;
  } else {
    const unrecordedTotal = unrecordedPayments.reduce((s, p) => s + Number(p.amount), 0);
    html += `<p style="margin:0 0 8px;font-size:13px;color:#444444;">The following ${unrecordedPayments.length} QB payment${unrecordedPayments.length > 1 ? 's' : ''} (${f$(unrecordedTotal)} total) have no matching SA payment within 14 days at the same amount. These may need to be applied in SA.</p>`;
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
    <tr style="background-color:#f8f8f8;">
      <td style="padding:5px 8px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;">Date</td>
      <td style="padding:5px 8px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;">Customer</td>
      <td style="padding:5px 8px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Amount</td>
    </tr>`;
    for (let i = 0; i < unrecordedPayments.length; i++) {
      const p = unrecordedPayments[i];
      html += `<tr style="background-color:${i % 2 ? '#f8f8f8' : '#ffffff'};">
        <td style="padding:5px 8px;font-size:13px;color:#888888;white-space:nowrap;">${fD(p.date)}</td>
        <td style="padding:5px 8px;font-size:13px;color:#333333;">${p.customer_name || '—'}</td>
        <td style="padding:5px 8px;font-size:13px;font-weight:bold;color:#1a6e1a;text-align:right;white-space:nowrap;">${f$(p.amount)}</td>
      </tr>`;
    }
    html += `</table>`;
    html += `<p style="margin:0 0 16px;font-size:12px;color:#888888;font-style:italic;">Source: QB payments vs SA payment records (last AME sync). Run <code>ame-run.ps1 sync:sa</code> to refresh SA data before relying on this section.</p>`;
  }

  // ── BTA Files ───────────────────────────────────────────────────────────────
  html += `<hr style="border:none;border-top:1px solid #e8e8e8;margin:24px 0;">`;
  html += `<p style="margin:0 0 6px;font-size:13px;font-weight:bold;text-transform:uppercase;letter-spacing:0.8px;color:#888888;">BTA Reporting Files</p>`;
  html += `<p style="margin:0 0 16px;font-size:13px;color:#555555;">Weekly revenue package (RP tabs, budget summary) refreshed Sunday at 8 AM. ` +
    `<a href="file:///C:/Users/Assistant/OneDrive%20-%20jrboehlke.com/JR%20Boehlke%20-%20Claude%20Folder/BTA%20Reporting/Output" ` +
    `style="color:#1a6e8c;">Open BTA Output Folder</a></p>`;

  html += `<p style="margin:24px 0 0;font-size:13px;color:#888888;">Generated automatically by your JRB Assistant. Reply with questions.</p>
</td></tr>

<!-- FOOTER -->
<tr><td style="background-color:#f8f8f8;padding:14px 32px;border-top:1px solid #e8e8e8;">
  <p style="margin:0;font-size:12px;color:#888888;line-height:1.6;">J.R. Boehlke, LLC &nbsp;|&nbsp; Milwaukee, WI &nbsp;|&nbsp; Source: QuickBooks Online &amp; Service Autopilot</p>
</td></tr>

</table></td></tr></table>
</body></html>`;

  return html;
}

// ── Main entry point ────────────────────────────────────────────────────────

export async function generateAndSendWeeklyFinanceReport() {
  const { start, end, weekLabel, displayRange } = getPriorWeekRange();
  logger.info('weekly_finance_report: gathering data', { weekLabel, start, end });

  const [payments, arAging, invoices, deposits, expenses, auditIssues, ameMatches, saPaymentTotals, unrecordedPayments] = await Promise.all([
    getPaymentsForWeek(start, end),
    getARAgingReport(),
    getInvoicesForWeek(start, end),
    getOldNationalDeposits(start, end),
    gatherExpenseData(start, end),
    gatherAuditIssues(),
    gatherAMEMatches(),
    gatherSAPaymentTotals(start, end),
    gatherUnrecordedPayments(),
  ]);

  logger.info('weekly_finance_report: data gathered', {
    payments: payments.length,
    openInvoices: Object.values(arAging.buckets).flat().length,
    invoicesIssued: invoices.length,
    deposits: deposits.length,
    expenses: expenses.length,
    auditIssues: auditIssues.length,
    ameMatches: ameMatches.length,
    saPayments: saPaymentTotals?.count ?? 'n/a',
    unrecordedPayments: unrecordedPayments.length,
  });

  const body = buildEmail({ weekLabel, displayRange, payments, arAging, invoices, deposits, expenses, auditIssues, ameMatches, saPaymentTotals, unrecordedPayments });
  const totalCollected = payments.reduce((s, p) => s + p.amount, 0);

  await sendEmail({
    to: ['michael@jrboehlke.com'],
    subject: `Weekly Finance Report — ${weekLabel} | ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(totalCollected)} collected`,
    body,
  });

  logger.info('weekly_finance_report: sent', { weekLabel, totalCollected });
  return { weekLabel, totalCollected, paymentsCount: payments.length };
}
