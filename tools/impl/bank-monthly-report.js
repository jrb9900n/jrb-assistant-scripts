// tools/impl/bank-monthly-report.js
// Monthly Bank AR/AP Report — 8 AM on the 12th of each month, ahead of
// Michael's bank submission deadline (the 15th). Reports AR (J.R. Boehlke
// only — JRB Transport has zero customers/invoices, confirmed live
// 2026-08-21) and consolidated AP (every configured QBO company) AS OF the
// last day of the PRIOR month, not "as of whenever this cron happens to run"
// — a bank wants to know what was actually owed on a specific closing date.
// Uses quickbooks.js's getAgedReportAsOf(), which calls QBO's own Reports
// API — the only mechanism that correctly reconstructs a historical "as of"
// balance (a bill paid after the as-of date but before this report runs
// would otherwise show as already-paid, understating what was truly
// outstanding on that date if built from live current-balance queries like
// ar-collections-report.js/ap-report.js use for their own, different,
// "right now" purpose).
//
// Legacy AR/AP over 365 days past due is excluded from the headline totals
// and broken out separately (WRITE_OFF_THRESHOLD_DAYS below, passed
// explicitly into getAgedReportAsOf — that function keeps this threshold as
// a caller param rather than a hardcoded default, since it's this report's
// business-policy decision, not a fact about QBO). Confirmed live 2026-08-21
// that this matters in practice, not just in theory: JRB's real QBO AR
// contains a ~$4.08M data-conversion artifact (488 receivables all dated the
// exact same day, 2023-08-20 — clearly not real business from one day) plus
// another ~$918K of genuinely old pre-2024 AR, and JRB's AP separately
// carries ~$12.6K of real Sealmaster bills simply unpaid for 1.5+ years.
// Different root causes, same fix. Per Michael's explicit decision
// 2026-08-21: report only the real, current AR/AP as the headline
// bank-facing number, and surface the >365-day amount every month as its own
// flagged line so it can't silently grow unnoticed or get forgotten about.
//
// Total-outage handling: if AR *and* every AP company fail to fetch, this
// throws rather than sending a "$0.00 / unavailable" email — a bank report
// with literally nothing real in it should trigger the same Teams failure
// alert as any other broken cron task, not silently "succeed" with an empty
// shell. A partial failure (e.g. one AP company down, or just AR down) still
// sends with whatever real data did come back, clearly flagged.

import { logger } from '../../core/logger.js';
import { sendEmail } from './m365.js';
import { getAgedReportAsOf } from './quickbooks.js';
import { listQBCompanies, getQBCompanyLabel } from './qb-token.js';
import { f$, fD, sectionHeader, alertBox } from './ar-report-helpers.js';

const WRITE_OFF_THRESHOLD_DAYS = 365;

// Added 2026-08-21, same day as the fix above: rather than showing the
// entire 2023-08-20 conversion dump (and everything else that old) inside
// the "Over 12 Months" write-off section every month, Michael's follow-up
// decision was to fully drop anything dated on or before that exact date
// from the report altogether — it's not real, reviewable business activity,
// so there's nothing for a monthly write-off review to act on by seeing it
// repeated. Genuinely old-but-real debt from after that date (e.g. the
// Sealmaster bills) still shows up normally in the write-off section.
const IGNORE_ON_OR_BEFORE = '2023-08-20';

// Every configured QBO company gets an AP section — derived from
// qb-token.js's own company registry rather than hardcoded here, so a third
// company added in the future is picked up automatically instead of
// silently missing from a bank-facing consolidated total (the same registry
// scheduler/cron.js's qb_health_check already loops over for this reason).
const AP_ENTITIES = listQBCompanies().map(company => ({ company, label: getQBCompanyLabel(company) }));

// Defensive guard against an intercompany bill ever being entered against
// the *other* related entity as a vendor, instead of through the "Due
// to/from" journal-entry mechanism both companies actually use today
// (confirmed live 2026-08-21 — see ap-report.js / PR #305, "Make Accounts
// Payable report multi-entity", for the full investigation notes). This is
// a duplicated copy of that PR's equivalent guard, not a shared import — the
// two branches were built in parallel; worth consolidating into
// ar-report-helpers.js once #305 has merged. No-op today either way.
const EXCLUDED_INTERCOMPANY_VENDORS = {
  jrb: new Set(['jrb transport llc', 'jrb transport']),
  transport: new Set(['j r boehlke llc', 'j r boehlke inc', 'j r boehlke', 'jr boehlke']),
};
function normalizeVendorName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

const BUCKET_LABELS = [['current', 'Current'], ['d30', '1-30d'], ['d60', '31-60d'], ['d90', '61-90d'], ['d120plus', '91-365d']];

function lastMonthEndUTC(referenceDate = new Date()) {
  const firstOfThisMonth = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), 1));
  const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - 86400000);
  return lastOfPrevMonth.toISOString().slice(0, 10);
}

// Sum of every bucket except writeOffCandidate — the "real" headline figure.
function realTotal(buckets) {
  return Object.entries(buckets)
    .filter(([key]) => key !== 'writeOffCandidate')
    .reduce((s, [, rows]) => s + rows.reduce((rs, r) => rs + r.balance, 0), 0);
}

async function fetchAR(asOfDate) {
  try {
    const aging = await getAgedReportAsOf({ reportName: 'AgedReceivableDetail', asOfDate, company: 'jrb', writeOffThresholdDays: WRITE_OFF_THRESHOLD_DAYS, ignoreOnOrBefore: IGNORE_ON_OR_BEFORE });
    return { ok: true, buckets: aging.buckets, ignoredCount: aging.ignoredCount, ignoredTotal: aging.ignoredTotal };
  } catch (err) {
    logger.warn('bank_monthly_report: AR fetch failed', { err: err.message });
    return { ok: false, error: err.message };
  }
}

async function fetchAPEntity({ company, label }, asOfDate) {
  try {
    const raw = await getAgedReportAsOf({ reportName: 'AgedPayableDetail', asOfDate, company, writeOffThresholdDays: WRITE_OFF_THRESHOLD_DAYS, ignoreOnOrBefore: IGNORE_ON_OR_BEFORE });
    const excluded = EXCLUDED_INTERCOMPANY_VENDORS[company] ?? new Set();
    const buckets = {};
    for (const [key, rows] of Object.entries(raw.buckets)) {
      buckets[key] = rows
        .filter(r => !excluded.has(normalizeVendorName(r.name)))
        .map(r => ({ ...r, entity: label }));
    }
    return { ok: true, company, label, buckets, ignoredCount: raw.ignoredCount, ignoredTotal: raw.ignoredTotal };
  } catch (err) {
    logger.warn('bank_monthly_report: AP entity fetch failed', { company, err: err.message });
    return { ok: false, company, label, error: err.message };
  }
}

// Merges however many AP entities fetched successfully. `ok` is false only
// when EVERY entity failed — the caller uses that to decide whether the AP
// figure is real-but-partial (some entities loaded) vs. entirely unavailable
// (none did), the same current/d30/../writeOffCandidate bucket shape either
// way so buildAgingTable()/buildWriteOffBox() don't need to special-case it.
function mergeAPEntities(results) {
  const ok = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);
  const buckets = { current: [], d30: [], d60: [], d90: [], d120plus: [], writeOffCandidate: [] };
  for (const r of ok) {
    for (const key of Object.keys(buckets)) buckets[key].push(...(r.buckets[key] ?? []));
  }
  for (const b of Object.values(buckets)) b.sort((a, c) => c.balance - a.balance);
  const ignoredCount = ok.reduce((s, r) => s + (r.ignoredCount ?? 0), 0);
  const ignoredTotal = ok.reduce((s, r) => s + (r.ignoredTotal ?? 0), 0);
  return { buckets, ok: ok.length > 0, failedLabels: failed.map(r => r.label), ignoredCount, ignoredTotal };
}

function buildAgingTable(buckets) {
  let html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;">`;
  for (const [key, label] of BUCKET_LABELS) {
    const rows = buckets[key] ?? [];
    const sum = rows.reduce((s, r) => s + r.balance, 0);
    const color = key === 'd90' || key === 'd120plus' ? '#c0392b' : key === 'd60' ? '#b35900' : '#333333';
    html += `<tr>
      <td style="padding:4px 6px;font-size:13px;color:#444444;">${label}</td>
      <td style="padding:4px 6px;font-size:12px;color:#888888;text-align:right;">${rows.length}</td>
      <td style="padding:4px 6px;font-size:13px;font-weight:bold;color:${color};text-align:right;white-space:nowrap;">${f$(sum)}</td>
    </tr>`;
  }
  html += `</table>`;
  return html;
}

const WRITE_OFF_MAX_ROWS = 10;

// Write-off rows can span years (that's the whole point of this section) —
// ar-report-helpers.js's shared fD() deliberately omits the year (every
// other report's dates are all within the current year, where that's the
// right call), so a local formatter is used here instead of changing that
// shared convention for every other report.
function fDWithYear(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr.length === 10 ? dateStr + 'T12:00:00Z' : dateStr);
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
}

function buildWriteOffBox(rows, title, itemNoun) {
  if (!rows.length) return '';
  const total = rows.reduce((s, r) => s + r.balance, 0);
  const shown = rows.slice(0, WRITE_OFF_MAX_ROWS);
  const tableRows = shown.map(r =>
    `<tr><td style="padding:3px 0;font-size:12px;color:#7a1f1f;">${r.name}${r.entity ? ` (${r.entity})` : ''} <span style="color:#999999;">${fDWithYear(r.dueDate || r.txnDate)}</span></td><td style="padding:3px 0;font-size:12px;font-weight:bold;color:#7a1f1f;text-align:right;">${f$(r.balance)}</td></tr>`
  ).join('');
  const moreNote = rows.length > shown.length
    ? `<p style="margin:6px 0 0;font-size:11px;color:#888888;">+ ${rows.length - shown.length} more ${itemNoun}, not itemized here — see QuickBooks for the full list.</p>`
    : '';
  return alertBox('#fdecea', '#c0392b', `${title} — ${f$(total)} (${rows.length} ${itemNoun})`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${tableRows}</table>${moreNote}`);
}

function buildEmail({ asOfDate, arResult, apMerged }) {
  const apReal = apMerged.ok ? realTotal(apMerged.buckets) : null;

  let html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Monthly Bank Report ${asOfDate}</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" style="max-width:620px;background-color:#ffffff;border-radius:6px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

<!-- HEADER -->
<tr><td style="background-color:#1a1a2e;padding:24px 32px;">
  <p style="margin:0;color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:0.5px;">J.R. Boehlke, LLC &amp; JRB Transport LLC</p>
  <p style="margin:4px 0 0;color:#aaaacc;font-size:13px;">Monthly Bank Report &nbsp;|&nbsp; As of ${fD(asOfDate)}</p>
</td></tr>

<!-- BODY -->
<tr><td style="padding:28px 32px;">
<p style="margin:0 0 20px;font-size:12px;color:#888888;font-style:italic;">Balances below reflect what was actually outstanding as of ${fD(asOfDate)} (QuickBooks' own historical aging as of that date), not today's live balances.</p>`;

  if (apMerged.failedLabels.length) {
    const verb = apMerged.ok ? 'the totals below reflect only the entities that did load' : 'the AP figure below is unavailable this run';
    html += alertBox('#fff8f0', '#e6a817', `${apMerged.failedLabels.join(' & ')} AP Data Unavailable`,
      `<p style="margin:0;font-size:13px;color:#533f03;">Couldn't reach QuickBooks for ${apMerged.failedLabels.join(' and ')} this run — ${verb}.</p>`);
  }

  // ── Accounts Receivable (J.R. Boehlke) ───────────────────────────────────
  html += sectionHeader('Accounts Receivable — J.R. Boehlke, LLC');
  if (!arResult.ok) {
    html += alertBox('#fff8f0', '#e6a817', 'AR Data Unavailable', `<p style="margin:0;font-size:13px;color:#533f03;">Couldn't reach QuickBooks for AR this run.</p>`);
  } else {
    const arReal = realTotal(arResult.buckets);
    html += `<p style="margin:0 0 10px;font-size:20px;font-weight:bold;color:#1a1a2e;">${f$(arReal)} <span style="font-size:12px;font-weight:normal;color:#888888;">real AR as of ${fD(asOfDate)}</span></p>`;
    html += buildAgingTable(arResult.buckets);
    html += buildWriteOffBox(arResult.buckets.writeOffCandidate, 'AR Over 12 Months — Recommend Write-off Review', 'invoices');
  }

  // ── Accounts Payable (Consolidated) ──────────────────────────────────────
  html += sectionHeader('Accounts Payable — Consolidated (J.R. Boehlke + JRB Transport)');
  if (!apMerged.ok) {
    html += alertBox('#fff8f0', '#e6a817', 'AP Data Unavailable', `<p style="margin:0;font-size:13px;color:#533f03;">Couldn't reach QuickBooks for any AP entity this run.</p>`);
  } else {
    html += `<p style="margin:0 0 10px;font-size:20px;font-weight:bold;color:#1a1a2e;">${f$(apReal)} <span style="font-size:12px;font-weight:normal;color:#888888;">real AP as of ${fD(asOfDate)}</span></p>`;
    html += buildAgingTable(apMerged.buckets);
    html += buildWriteOffBox(apMerged.buckets.writeOffCandidate, 'AP Over 12 Months — Recommend Write-off Review', 'bills');
  }

  html += `
<p style="margin:24px 0 0;font-size:11px;color:#aaaaaa;">Sent 3 days ahead of the typical 15th-of-month bank submission deadline.</p>
</td></tr>
</table></td></tr></table>
</body></html>`;

  return html;
}

export async function generateAndSendBankMonthlyReport({ asOfDate: asOfOverride } = {}) {
  const asOfDate = asOfOverride ?? lastMonthEndUTC();

  // recoverMissedExecutions (scheduler/cron.js) can fire this well after the
  // scheduled 12th if the scheduler was down — lastMonthEndUTC() is computed
  // from the ACTUAL run time, so a recovery landing after a full month
  // boundary has passed would silently report on the wrong period (e.g. a
  // missed August run recovering in October would report September's
  // close, not August's, with nothing flagging that mismatch). Not a full
  // fix (that needs the scheduler to pass its originally-intended tick
  // time, which recoverMissedExecutions doesn't currently expose) — just
  // making the gap visible instead of silent.
  if (!asOfOverride) {
    const today = new Date();
    if (today.getUTCDate() > 20) {
      logger.warn('bank_monthly_report: running unusually late in the month — verify asOfDate is the intended closing date, not a stale recovery run', { asOfDate, actualRunDate: today.toISOString().slice(0, 10) });
    }
  }

  const [arResult, ...apResults] = await Promise.all([
    fetchAR(asOfDate),
    ...AP_ENTITIES.map(e => fetchAPEntity(e, asOfDate)),
  ]);
  const apMerged = mergeAPEntities(apResults);

  // Total outage (nothing real to report at all) is a hard failure, not a
  // degraded-but-successful send — throwing here lets scheduler/cron.js's
  // existing try/catch fire the Teams alert instead of this task quietly
  // "succeeding" with an all-unavailable email visible only if Michael
  // happens to open and read it before his bank deadline.
  if (!arResult.ok && !apMerged.ok) {
    throw new Error(`bank_monthly_report: total outage — AR failed (${arResult.error}) and every AP company failed (${apMerged.failedLabels.join(', ')})`);
  }

  const body = buildEmail({ asOfDate, arResult, apMerged });

  const arReal = arResult.ok ? realTotal(arResult.buckets) : null;
  const apReal = apMerged.ok ? realTotal(apMerged.buckets) : null;

  await sendEmail({
    to: ['michael@jrboehlke.com'],
    subject: `Monthly Bank Report — As of ${fD(asOfDate)} | AR ${arReal !== null ? f$(arReal) : 'unavailable'}, AP ${apReal !== null ? f$(apReal) : 'unavailable'}`,
    body,
  });

  // ignoredCount/ignoredTotal (from the IGNORE_ON_OR_BEFORE cutoff) are
  // logged here, not shown in the bank-facing email itself — Michael wants
  // the pre-2023-08-20 conversion dump fully excluded from what the bank
  // sees, not called out on the document. This log line is the only trace
  // of how much was dropped, so a future regression in the cutoff logic
  // (or someone accidentally removing it) is still visible in the app log
  // even though it will never appear in the email.
  logger.info('bank_monthly_report: sent', {
    asOfDate, arReal, apReal, arOk: arResult.ok, apOk: apMerged.ok, apFailedLabels: apMerged.failedLabels,
    arIgnoredCount: arResult.ignoredCount ?? 0, arIgnoredTotal: arResult.ignoredTotal ?? 0,
    apIgnoredCount: apMerged.ignoredCount ?? 0, apIgnoredTotal: apMerged.ignoredTotal ?? 0,
  });
  return { asOfDate, arReal, apReal, arOk: arResult.ok, apOk: apMerged.ok, apFailedLabels: apMerged.failedLabels };
}
