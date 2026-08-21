// tools/impl/ar-collections-report.js
// AR / Collections Report — Monday 8:45 AM, ahead of the 9:00-10:00 AR/Collections
// calendar block. Reuses the same aging-bucket logic and email template conventions
// as weekly-finance-report.js (see ar-report-helpers.js) rather than re-deriving them.
//
// Sections: totals + DSO trend, aging buckets, top delinquent accounts, collection
// call queue. Explicitly excluded from v1: promise-to-pay tracking — no data source
// for this exists anywhere in the system yet (would need a new manual-logging
// mechanism, e.g. an SA ticket type); noting it in the email rather than faking it.

import { logger } from '../../core/logger.js';
import { sendEmail } from './m365.js';
import { supabase, gatherSAARaging, mondayOf, gatherSAFreshness, f$, fD, ageBadge, masterCustomer, sectionHeader, alertBox } from './ar-report-helpers.js';

const DELINQUENT_MIN_AGE_DAYS = 30;
const DELINQUENT_MAX_ROWS = 10;
// gatherSAARaging's `flagged` list (ar-report-helpers.js) draws from the d60/d90/d120plus
// buckets, whose youngest bucket (d60) covers 31-60 days past due -- so the real
// effective age floor here is >30 days, not 60. Keep this comment and the email
// copy below in sync with that if the bucket boundaries ever change.
const CALL_QUEUE_MIN_BALANCE = 500;
const CALL_QUEUE_MAX_ROWS = 15;
const STALE_DATA_HOURS = 24;

// Trailing-28-day invoiced revenue, for a simple DSO estimate: total open AR /
// (trailing revenue / 28). Not a textbook average-AR DSO (would need historical
// AR snapshots we don't have) — close enough for a directional weekly trend.
async function gatherTrailing28DayRevenue() {
  const cutoff = new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('sa_invoices')
    .select('invoice_total')
    .gte('date', cutoff)
    .eq('deleted', false);
  if (error) {
    logger.warn('ar_collections_report: trailing revenue query failed', { err: error.message });
    return 0;
  }
  return (data ?? []).reduce((s, r) => s + Number(r.invoice_total ?? 0), 0);
}

// Reads last week's DSO snapshot for the trend line, writes this week's row.
// The ar_dso_snapshots table may not exist yet if its migration hasn't been
// applied — degrades to "no trend" rather than failing the whole report.
async function gatherAndRecordDSO(totalAR) {
  const revenue28d = await gatherTrailing28DayRevenue();
  const dso = revenue28d > 0 ? Math.round((totalAR / (revenue28d / 28)) * 10) / 10 : null;
  const weekStart = mondayOf();

  let previousDso = null;
  try {
    const { data: prior, error: priorErr } = await supabase
      .from('ar_dso_snapshots')
      .select('week_start, dso')
      .lt('week_start', weekStart)
      .order('week_start', { ascending: false })
      .limit(1);
    if (priorErr) throw priorErr;
    previousDso = prior?.[0]?.dso ?? null;

    if (dso !== null) {
      const { error: upsertErr } = await supabase
        .from('ar_dso_snapshots')
        .upsert({ week_start: weekStart, total_ar: totalAR, dso }, { onConflict: 'week_start' });
      if (upsertErr) throw upsertErr;
    }
  } catch (err) {
    logger.warn('ar_collections_report: DSO snapshot read/write failed — reporting current DSO only', { err: err.message });
  }

  return { dso, previousDso };
}

function buildTopDelinquent(arAging) {
  const all = [
    ...(arAging.buckets.current ?? []),
    ...(arAging.buckets.d30 ?? []),
    ...(arAging.buckets.d60 ?? []),
    ...(arAging.buckets.d90 ?? []),
    ...(arAging.buckets.d120plus ?? []),
  ].filter(r => r.ageDays >= DELINQUENT_MIN_AGE_DAYS);

  const byClient = {};
  for (const r of all) {
    const master = masterCustomer(r.customer);
    if (!byClient[master]) byClient[master] = { balance: 0, invoiceCount: 0, maxAgeDays: -Infinity };
    byClient[master].balance += r.balance;
    byClient[master].invoiceCount += 1;
    if (r.ageDays > byClient[master].maxAgeDays) byClient[master].maxAgeDays = r.ageDays;
  }
  return Object.entries(byClient)
    .sort((a, b) => b[1].balance - a[1].balance)
    .slice(0, DELINQUENT_MAX_ROWS);
}

// Ranked call-queue: SA-side flagged accounts (real balance + age) first, then
// any QB-side stalled_ar audit finding for a customer NOT already covered by SA
// data (SA is the fresher/cheaper source — see ar-report-helpers.js — so it's
// never overwritten, only supplemented for gaps SA might be missing).
async function buildCollectionCallQueue(arAging) {
  const byClient = {};
  for (const r of (arAging.flagged ?? [])) {
    const master = masterCustomer(r.customer);
    if (!byClient[master]) byClient[master] = { balance: 0, maxAgeDays: -Infinity, hasAge: true };
    byClient[master].balance += r.balance;
    if (r.ageDays > byClient[master].maxAgeDays) byClient[master].maxAgeDays = r.ageDays;
  }

  try {
    const { data: stalled, error } = await supabase
      .from('audit_issues')
      .select('qbo_customer_name, qbo_amount')
      .eq('issue_type', 'stalled_ar')
      .eq('status', 'open');
    if (error) throw error;
    for (const iss of (stalled ?? [])) {
      const master = masterCustomer(iss.qbo_customer_name);
      if (!master || byClient[master]) continue;
      byClient[master] = { balance: Number(iss.qbo_amount ?? 0), maxAgeDays: null, hasAge: false };
    }
  } catch (err) {
    logger.warn('ar_collections_report: stalled_ar audit issues query failed — call queue is SA-only', { err: err.message });
  }

  return Object.entries(byClient)
    .filter(([, info]) => info.balance >= CALL_QUEUE_MIN_BALANCE)
    .sort((a, b) => b[1].balance - a[1].balance)
    .slice(0, CALL_QUEUE_MAX_ROWS);
}

function bucketColor(key) {
  if (key === 'd60') return '#b35900';
  if (key === 'd90' || key === 'd120plus') return '#c0392b';
  return '#333333';
}

function buildEmail({ arAging, dso, previousDso, topDelinquent, callQueue, freshness, weekStart }) {
  let trendLine;
  if (previousDso === null) {
    trendLine = `<span style="color:#888888;">Trend available starting next week (no prior snapshot yet).</span>`;
  } else {
    const delta = dso - previousDso;
    const arrow = delta > 0 ? '&#9650;' : delta < 0 ? '&#9660;' : '&#9679;';
    const color = delta > 0 ? '#c0392b' : delta < 0 ? '#1a6e1a' : '#888888';
    const verdict = delta > 0 ? 'worse' : delta < 0 ? 'better' : 'unchanged';
    trendLine = `<span style="color:${color};font-weight:bold;">${arrow} ${Math.abs(delta).toFixed(1)}d ${verdict}</span> vs last week (${previousDso.toFixed(1)}d)`;
  }

  let html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>AR / Collections Report ${weekStart}</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" style="max-width:620px;background-color:#ffffff;border-radius:6px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

<!-- HEADER -->
<tr><td style="background-color:#1a1a2e;padding:24px 32px;">
  <p style="margin:0;color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:0.5px;">J.R. Boehlke, LLC</p>
  <p style="margin:4px 0 0;color:#aaaacc;font-size:13px;">AR / Collections Report &nbsp;|&nbsp; Week of ${fD(weekStart)}</p>
</td></tr>

<!-- BODY -->
<tr><td style="padding:28px 32px;">`;

  if (freshness?.stale) {
    html += alertBox('#fff8f0', '#e6a817', `SA Data May Be Stale (${freshness.ageHours}h Since Last Sync)`,
      `<p style="margin:0;font-size:13px;color:#533f03;">Figures below may not reflect the most recent invoices/payments.</p>`);
  }

  // ── Totals bar ────────────────────────────────────────────────────────────
  html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eef1fa;border-radius:4px;margin-bottom:6px;"><tr>
  <td style="padding:14px 16px;text-align:center;border-right:1px solid #d8e0f0;">
    <p style="margin:0;font-size:20px;font-weight:bold;color:#b35900;">${f$(arAging.total)}</p>
    <p style="margin:2px 0 0;font-size:11px;color:#555577;text-transform:uppercase;letter-spacing:0.6px;">Total Open AR</p>
  </td>
  <td style="padding:14px 16px;text-align:center;">
    <p style="margin:0;font-size:20px;font-weight:bold;color:#1a1a2e;">${dso !== null ? dso.toFixed(1) + 'd' : '—'}</p>
    <p style="margin:2px 0 0;font-size:11px;color:#555577;text-transform:uppercase;letter-spacing:0.6px;">DSO (est.)</p>
  </td>
</tr></table>`;
  html += `<p style="margin:0 0 20px;font-size:12px;text-align:center;">${trendLine}</p>`;

  // ── Aging buckets ─────────────────────────────────────────────────────────
  html += sectionHeader('Aging Buckets');
  const bucketLabels = [['current', 'Current'], ['d30', '1-30d'], ['d60', '31-60d'], ['d90', '61-90d'], ['d120plus', '90d+']];
  html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">`;
  for (const [key, label] of bucketLabels) {
    const rows = arAging.buckets[key] ?? [];
    const sum = rows.reduce((s, r) => s + r.balance, 0);
    html += `<tr>
      <td style="padding:5px 6px;font-size:13px;color:#444444;">${label}</td>
      <td style="padding:5px 6px;font-size:12px;color:#888888;text-align:right;">${rows.length} invoice${rows.length === 1 ? '' : 's'}</td>
      <td style="padding:5px 6px;font-size:13px;font-weight:bold;color:${bucketColor(key)};text-align:right;white-space:nowrap;">${f$(sum)}</td>
    </tr>`;
  }
  html += `</table>`;

  // ── Top delinquent accounts ──────────────────────────────────────────────
  html += sectionHeader('Top Delinquent Accounts (30+ Days)');
  if (!topDelinquent.length) {
    html += `<p style="margin:0 0 16px;font-size:13px;color:#888888;font-style:italic;">No accounts currently 30+ days past due.</p>`;
  } else {
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
    <tr style="background-color:#f8f8f8;">
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;width:20px;">#</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;">Client</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Balance</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Age</td>
    </tr>`;
    topDelinquent.forEach(([client, info], i) => {
      html += `<tr style="background-color:${i % 2 ? '#f8f8f8' : '#ffffff'};">
        <td style="padding:6px 6px;font-size:13px;color:#888888;">${i + 1}</td>
        <td style="padding:6px 6px;font-size:13px;color:#333333;">${client}${info.invoiceCount > 1 ? `<br><span style="font-size:11px;color:#888888;">${info.invoiceCount} open invoices</span>` : ''}</td>
        <td style="padding:6px 6px;font-size:13px;font-weight:bold;color:#b35900;text-align:right;white-space:nowrap;">${f$(info.balance)}</td>
        <td style="padding:6px 6px;text-align:right;white-space:nowrap;">${ageBadge(info.maxAgeDays)}</td>
      </tr>`;
    });
    html += `</table>`;
  }

  // ── Collection call queue ─────────────────────────────────────────────────
  html += sectionHeader(`This Week's Collection Call Queue`);
  if (!callQueue.length) {
    html += `<p style="margin:0 0 8px;font-size:13px;color:#888888;font-style:italic;">No accounts currently meet the ${f$(CALL_QUEUE_MIN_BALANCE)}+/30d+ call threshold.</p>`;
  } else {
    const rows = callQueue.map(([client, info], i) =>
      `<tr><td style="padding:4px 0;font-size:13px;color:#533f03;">${i + 1}. ${client} <span style="font-size:11px;color:#888888;">(${info.hasAge ? info.maxAgeDays + 'd past due' : 'QB-flagged, age unknown'})</span></td><td style="padding:4px 0;font-size:13px;color:#533f03;font-weight:bold;text-align:right;">${f$(info.balance)}</td></tr>`
    ).join('');
    html += alertBox('#fff3cd', '#e6a817', `${callQueue.length} Account${callQueue.length > 1 ? 's' : ''} to Call This Week`,
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`);
    html += `<p style="margin:-8px 0 16px;font-size:11px;color:#888888;">Phone numbers not included — SA's bulk client list doesn't reliably expose them. Look up contact info in SA before calling.</p>`;
  }

  html += `<p style="margin:24px 0 0;font-size:11px;color:#aaaaaa;font-style:italic;">Not yet included: broken promise-to-pay follow-ups — no tracking mechanism exists yet for promises clients have made to pay by a given date.</p>`;

  html += `
</td></tr>
</table></td></tr></table>
</body></html>`;

  return html;
}

export async function generateAndSendARCollectionsReport() {
  const weekStart = mondayOf();
  const [arAging, freshness] = await Promise.all([gatherSAARaging(), gatherSAFreshness({ staleHours: STALE_DATA_HOURS })]);
  const { dso, previousDso } = await gatherAndRecordDSO(arAging.total);
  const topDelinquent = buildTopDelinquent(arAging);
  const callQueue = await buildCollectionCallQueue(arAging);

  const body = buildEmail({ arAging, dso, previousDso, topDelinquent, callQueue, freshness, weekStart });

  await sendEmail({
    to: ['michael@jrboehlke.com'],
    subject: `AR / Collections — Week of ${fD(weekStart)} | ${f$(arAging.total)} outstanding`,
    body,
  });

  logger.info('ar_collections_report: sent', { weekStart, totalAR: arAging.total, dso });
  return { weekStart, totalAR: arAging.total, dso, callQueueCount: callQueue.length };
}
