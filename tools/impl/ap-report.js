// tools/impl/ap-report.js
// Accounts Payable Report — Wednesday 9:30 AM, ahead of the 9:45-10:45 AP
// calendar block. Mirrors ar-collections-report.js's structure/conventions:
// reuses quickbooks.js's getAPAgingReport() (built alongside this file, same
// bucket-and-return-shape convention as the existing getARAgingReport()) for
// aging data, and the generic HTML template helpers already extracted to
// ar-report-helpers.js (f$/fD/sectionHeader/alertBox/ageBadge — despite the
// filename, none of those are AR-specific).
//
// Sections: AP aging summary, bills due in the coming week, vendor payment
// priority (cash impact), and duplicate-invoice / amount-discrepancy flags.
//
// Unlike the AR report (which reads a Supabase cache synced by AME), this is
// a live QBO query every run — query()'s own result cache (default 1h TTL,
// see memory.js) is the only caching layer, so no separate "stale data"
// banner is needed here.

import { logger } from '../../core/logger.js';
import { sendEmail } from './m365.js';
import { getAPAgingReport } from './quickbooks.js';
import { f$, fD, ageBadge, sectionHeader, alertBox } from './ar-report-helpers.js';

const DUE_SOON_DAYS = 7;
const DUE_SOON_MAX_ROWS = 15;
const VENDOR_PRIORITY_MAX_ROWS = 10;
// Two open bills from the same vendor for the same amount, entered within this
// many days of each other, are flagged as a possible duplicate entry. 5 days
// comfortably covers same-invoice-entered-twice scenarios (e.g. once from a
// vendor email, once from a paper copy a few days later) without flagging
// genuinely recurring bills of the same amount (e.g. a flat monthly service
// fee), which are normally a month or more apart.
const DUPLICATE_DATE_WINDOW_DAYS = 5;
// Bill line items not summing to TotalAmt within a penny indicates a data
// entry error (rounding aside) rather than a real discrepancy.
const DISCREPANCY_TOLERANCE = 0.01;

function todayUTC() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function allBillsFrom(apAging) {
  return [
    ...(apAging.buckets.current ?? []),
    ...(apAging.buckets.d30 ?? []),
    ...(apAging.buckets.d60 ?? []),
    ...(apAging.buckets.d90 ?? []),
    ...(apAging.buckets.d120plus ?? []),
  ];
}

// Bills due today through DUE_SOON_DAYS out (not yet overdue — overdue bills
// already surface in the aging buckets above). Ranked soonest-due first.
// Returns { count, rows } — `count` is the true total (used for the executive
// summary stat / returned metrics), `rows` is capped to DUE_SOON_MAX_ROWS for
// the email table. Keeping these separate avoids the summary stat silently
// understating real due-soon exposure whenever more than DUE_SOON_MAX_ROWS
// bills qualify.
function buildDueSoon(apAging) {
  const today = todayUTC();
  const cutoff = new Date(today.getTime() + DUE_SOON_DAYS * 86400000);
  const all = (apAging.buckets.current ?? [])
    .filter(b => {
      if (!b.dueDate) return false; // defensive — dueDate falls back to TxnDate in getAPAgingReport(), but guard against a malformed record with neither
      const d = new Date(b.dueDate.length === 10 ? b.dueDate + 'T00:00:00Z' : b.dueDate);
      return d >= today && d <= cutoff;
    })
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  return { count: all.length, rows: all.slice(0, DUE_SOON_MAX_ROWS) };
}

// Vendor payment priority: total open exposure per vendor across every open
// bill (not just past-due ones — a vendor with a large not-yet-due balance
// still deserves visibility ahead of next week's payment run). Ranked by
// total balance (cash impact) descending as the primary key; ties broken by
// the vendor's single oldest-due bill (oldest due first) — a reasonable,
// explicit interpretation of "largest amounts / oldest due first" since the
// two criteria can't both be primary at once. Documented here rather than
// left implicit so a future reader isn't left guessing which one wins.
function buildVendorPriority(apAging) {
  const byVendor = {};
  for (const b of allBillsFrom(apAging)) {
    if (!byVendor[b.vendor]) byVendor[b.vendor] = { balance: 0, billCount: 0, maxAgeDays: -Infinity };
    const v = byVendor[b.vendor];
    v.balance += b.balance;
    v.billCount += 1;
    if (b.ageDays > v.maxAgeDays) v.maxAgeDays = b.ageDays;
  }
  return Object.entries(byVendor)
    .sort((a, b) => {
      const balDiff = b[1].balance - a[1].balance;
      if (Math.abs(balDiff) > 0.01) return balDiff;
      return b[1].maxAgeDays - a[1].maxAgeDays; // tie-break: oldest due first
    })
    .slice(0, VENDOR_PRIORITY_MAX_ROWS);
}

// Possible duplicate bills: same vendor + same TotalAmt, entered within
// DUPLICATE_DATE_WINDOW_DAYS of each other. A shared, identical DocNumber is
// called out as "exact duplicate" (much higher-confidence signal — the same
// bill number entered twice) vs. "possible duplicate" for same vendor/amount
// alone (could legitimately be two different bills that happen to match).
function buildDuplicateFlags(apAging) {
  const bills = allBillsFrom(apAging);
  const groups = {};
  for (const b of bills) {
    const key = `${b.vendor}|${b.totalAmt.toFixed(2)}`;
    (groups[key] ??= []).push(b);
  }

  const flags = [];
  for (const group of Object.values(groups)) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, c) => new Date(a.txnDate) - new Date(c.txnDate));
    for (let i = 1; i < sorted.length; i++) {
      const gapDays = Math.abs((new Date(sorted[i].txnDate) - new Date(sorted[i - 1].txnDate)) / 86400000);
      if (gapDays > DUPLICATE_DATE_WINDOW_DAYS) continue;
      const sameDoc = sorted[i].docNumber && sorted[i].docNumber === sorted[i - 1].docNumber;
      flags.push({
        type: sameDoc ? 'exact' : 'possible',
        vendor: sorted[i].vendor,
        amount: sorted[i].totalAmt,
        bills: [sorted[i - 1], sorted[i]],
      });
    }
  }
  // Exact duplicates (same DocNumber) first, then by amount desc within each tier
  return flags.sort((a, b) => (a.type === b.type ? b.amount - a.amount : a.type === 'exact' ? -1 : 1));
}

// Bills whose line items (plus any separately-tracked sales tax) don't sum to
// TotalAmt — a QBO data-entry error, not a duplicate. (QBO itself allows
// this; it doesn't validate line sums against the header total on save.)
// Must include taxAmt here — QBO tracks sales tax in TxnTaxDetail, never as
// part of the Line array, so comparing lineTotal alone against TotalAmt would
// flag every legitimately taxed bill as a false discrepancy.
function buildDiscrepancyFlags(apAging) {
  return allBillsFrom(apAging)
    .filter(b => Math.abs((b.lineTotal + b.taxAmt) - b.totalAmt) > DISCREPANCY_TOLERANCE)
    .map(b => ({ ...b, diff: (b.lineTotal + b.taxAmt) - b.totalAmt }))
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
}

function buildEmail({ apAging, dueSoon, vendorPriority, duplicateFlags, discrepancyFlags, today }) {
  let html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Accounts Payable Report ${today}</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" style="max-width:620px;background-color:#ffffff;border-radius:6px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

<!-- HEADER -->
<tr><td style="background-color:#1a1a2e;padding:24px 32px;">
  <p style="margin:0;color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:0.5px;">J.R. Boehlke, LLC</p>
  <p style="margin:4px 0 0;color:#aaaacc;font-size:13px;">Accounts Payable Report &nbsp;|&nbsp; ${fD(today)}</p>
</td></tr>

<!-- BODY -->
<tr><td style="padding:28px 32px;">`;

  // ── Totals bar ────────────────────────────────────────────────────────────
  html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eef1fa;border-radius:4px;margin-bottom:20px;"><tr>
  <td style="padding:14px 16px;text-align:center;border-right:1px solid #d8e0f0;">
    <p style="margin:0;font-size:20px;font-weight:bold;color:#b35900;">${f$(apAging.total)}</p>
    <p style="margin:2px 0 0;font-size:11px;color:#555577;text-transform:uppercase;letter-spacing:0.6px;">Total Open AP</p>
  </td>
  <td style="padding:14px 16px;text-align:center;">
    <p style="margin:0;font-size:20px;font-weight:bold;color:#1a1a2e;">${dueSoon.count}</p>
    <p style="margin:2px 0 0;font-size:11px;color:#555577;text-transform:uppercase;letter-spacing:0.6px;">Bills Due in ${DUE_SOON_DAYS} Days</p>
  </td>
</tr></table>`;

  // ── Aging buckets ─────────────────────────────────────────────────────────
  html += sectionHeader('AP Aging Summary');
  const bucketLabels = [['current', 'Current'], ['d30', '1-30d'], ['d60', '31-60d'], ['d90', '61-90d'], ['d120plus', '90d+']];
  html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">`;
  for (const [key, label] of bucketLabels) {
    const rows = apAging.buckets[key] ?? [];
    const sum = rows.reduce((s, r) => s + r.balance, 0);
    const color = key === 'd90' || key === 'd120plus' ? '#c0392b' : key === 'd60' ? '#b35900' : '#333333';
    html += `<tr>
      <td style="padding:5px 6px;font-size:13px;color:#444444;">${label}</td>
      <td style="padding:5px 6px;font-size:12px;color:#888888;text-align:right;">${rows.length} bill${rows.length === 1 ? '' : 's'}</td>
      <td style="padding:5px 6px;font-size:13px;font-weight:bold;color:${color};text-align:right;white-space:nowrap;">${f$(sum)}</td>
    </tr>`;
  }
  html += `</table>`;

  // ── Bills due in the coming week ─────────────────────────────────────────
  html += sectionHeader(`Bills Due in the Coming Week`);
  if (!dueSoon.count) {
    html += `<p style="margin:0 0 16px;font-size:13px;color:#888888;font-style:italic;">No open bills due in the next ${DUE_SOON_DAYS} days.</p>`;
  } else {
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
    <tr style="background-color:#f8f8f8;">
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;">Due</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;">Vendor</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Amount</td>
    </tr>`;
    dueSoon.rows.forEach((b, i) => {
      html += `<tr style="background-color:${i % 2 ? '#f8f8f8' : '#ffffff'};">
        <td style="padding:6px 6px;font-size:13px;color:#333333;white-space:nowrap;">${fD(b.dueDate)}</td>
        <td style="padding:6px 6px;font-size:13px;color:#333333;">${b.vendor}${b.docNumber ? `<br><span style="font-size:11px;color:#888888;">#${b.docNumber}</span>` : ''}</td>
        <td style="padding:6px 6px;font-size:13px;font-weight:bold;color:#1a1a2e;text-align:right;white-space:nowrap;">${f$(b.balance)}</td>
      </tr>`;
    });
    html += `</table>`;
    if (dueSoon.count > dueSoon.rows.length) {
      html += `<p style="margin:-8px 0 16px;font-size:11px;color:#888888;">Showing the ${dueSoon.rows.length} soonest of ${dueSoon.count} bills due in the next ${DUE_SOON_DAYS} days.</p>`;
    }
  }

  // ── Vendor payment priority ──────────────────────────────────────────────
  html += sectionHeader('Vendor Payment Priority (Cash Impact)');
  if (!vendorPriority.length) {
    html += `<p style="margin:0 0 16px;font-size:13px;color:#888888;font-style:italic;">No open vendor bills.</p>`;
  } else {
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
    <tr style="background-color:#f8f8f8;">
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;width:20px;">#</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;">Vendor</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Open Balance</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Oldest Due</td>
    </tr>`;
    vendorPriority.forEach(([vendor, info], i) => {
      html += `<tr style="background-color:${i % 2 ? '#f8f8f8' : '#ffffff'};">
        <td style="padding:6px 6px;font-size:13px;color:#888888;">${i + 1}</td>
        <td style="padding:6px 6px;font-size:13px;color:#333333;">${vendor}${info.billCount > 1 ? `<br><span style="font-size:11px;color:#888888;">${info.billCount} open bills</span>` : ''}</td>
        <td style="padding:6px 6px;font-size:13px;font-weight:bold;color:#b35900;text-align:right;white-space:nowrap;">${f$(info.balance)}</td>
        <td style="padding:6px 6px;text-align:right;white-space:nowrap;">${ageBadge(info.maxAgeDays)}</td>
      </tr>`;
    });
    html += `</table>`;
  }

  // ── Duplicate / discrepancy flags ────────────────────────────────────────
  html += sectionHeader('Duplicate & Discrepancy Flags');
  if (!duplicateFlags.length && !discrepancyFlags.length) {
    html += `<p style="margin:0 0 16px;font-size:13px;color:#888888;font-style:italic;">No duplicate-invoice or amount-discrepancy flags this week.</p>`;
  } else {
    if (duplicateFlags.length) {
      const rows = duplicateFlags.map(f => {
        const [b1, b2] = f.bills;
        const label = f.type === 'exact' ? 'EXACT DUPLICATE (same bill #)' : 'Possible duplicate';
        return `<tr><td style="padding:4px 0;font-size:13px;color:#533f03;">${label}: <strong>${f.vendor}</strong> — ${f$(f.amount)}
          <br><span style="font-size:11px;color:#888888;">Bill ${b1.docNumber ?? b1.id} (${fD(b1.txnDate)}) &amp; Bill ${b2.docNumber ?? b2.id} (${fD(b2.txnDate)})</span>
        </td></tr>`;
      }).join('');
      html += alertBox('#fff3cd', '#e6a817', `${duplicateFlags.length} Possible Duplicate Bill${duplicateFlags.length > 1 ? 's' : ''}`,
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`);
    }
    if (discrepancyFlags.length) {
      const rows = discrepancyFlags.map(b =>
        `<tr><td style="padding:4px 0;font-size:13px;color:#7a1f1f;"><strong>${b.vendor}</strong> Bill ${b.docNumber ?? b.id} — line items ${f$(b.lineTotal)} vs. total ${f$(b.totalAmt)}
          <span style="font-size:11px;color:#888888;">(${b.diff > 0 ? '+' : ''}${f$(b.diff)})</span>
        </td></tr>`
      ).join('');
      html += alertBox('#fdecea', '#c0392b', `${discrepancyFlags.length} Amount Discrepanc${discrepancyFlags.length > 1 ? 'ies' : 'y'}`,
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`);
    }
  }

  html += `
</td></tr>
</table></td></tr></table>
</body></html>`;

  return html;
}

export async function generateAndSendAPReport() {
  const today = todayUTC().toISOString().slice(0, 10);
  // Note: getAPAgingReport() also returns `flagged` (60d+/$500+ bills, same
  // convention as getARAgingReport()'s AR call-queue source), but it's
  // intentionally not surfaced as its own section here — Vendor Payment
  // Priority below already ranks every open bill (not just the 60d+ bucket)
  // by cash impact across the whole open-AP set, which supersedes it for
  // this report. Left unused deliberately, not by oversight.
  const apAging = await getAPAgingReport();
  const dueSoon = buildDueSoon(apAging);
  const vendorPriority = buildVendorPriority(apAging);
  const duplicateFlags = buildDuplicateFlags(apAging);
  const discrepancyFlags = buildDiscrepancyFlags(apAging);

  const body = buildEmail({ apAging, dueSoon, vendorPriority, duplicateFlags, discrepancyFlags, today });

  await sendEmail({
    to: ['michael@jrboehlke.com'],
    subject: `Accounts Payable — ${fD(today)} | ${f$(apAging.total)} owed`,
    body,
  });

  logger.info('ap_report: sent', {
    today,
    totalAP: apAging.total,
    dueSoonCount: dueSoon.count,
    duplicateFlagCount: duplicateFlags.length,
    discrepancyFlagCount: discrepancyFlags.length,
  });
  return {
    today,
    totalAP: apAging.total,
    dueSoonCount: dueSoon.count,
    vendorPriorityCount: vendorPriority.length,
    duplicateFlagCount: duplicateFlags.length,
    discrepancyFlagCount: discrepancyFlags.length,
  };
}
