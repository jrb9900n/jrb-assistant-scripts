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
//
// Multi-entity (added 2026-08-21, Propco added same day): covers every QBO
// company in the static ENTITIES list below — J.R. Boehlke, LLC ('jrb'), JRB
// Transport LLC ('transport'), and JRB Granville Propco ('propco') —
// reusing getAPAgingReport's existing `company` param from the multi-company
// QuickBooks build (see CLAUDE.md's "Multi-Company QuickBooks Support"
// section). Every bill is tagged with its entity so Michael knows which
// company's checking account to pay from. Each company's fetch is
// independently try/caught (not a bare Promise.all) so a QBO hiccup on one
// company still lets the others' real, successfully-fetched data reach
// Michael instead of blanking the whole email. A company with no realm ID
// yet (not yet OAuth-authorized — Propco as of this writing) is silently
// omitted rather than shown as a failure; see fetchEntityAging's
// notConnected check. Note: ENTITIES here is a static, hand-maintained list —
// unlike bank-monthly-report.js's AP_ENTITIES, which derives dynamically
// from qb-token.js's listQBCompanies() — so a future 5th company needs a
// manual line added here too, not just a QB_COMPANIES registry entry.
//
// Intercompany note: investigated live on 2026-08-21 whether JRB/Transport's
// open bills need intercompany elimination (the classic "one entity's payable
// is the other's mirror-image receivable, so don't double-count it" problem).
// Confirmed directly against both companies' QBO data that the answer today
// is no — the real intercompany relationship (JRB's "Vehicle Transportation &
// Management" expense / Transport's "Management & Employment Expenses") is
// tracked entirely through dedicated "Due to/from" balance-sheet accounts via
// journal entries, never through the vendor/Bill system on either side (zero
// open bills against vendor "JRB Transport LLC" in JRB's books; J.R. Boehlke
// isn't even set up as a vendor in Transport's books). So there is nothing to
// eliminate at the AP-bill level right now. EXCLUDED_INTERCOMPANY_VENDORS
// below is a defensive guard in case that ever changes (e.g. someone starts
// entering an intercompany bill against that vendor relationship instead of a
// journal entry) — it's a no-op today, confirmed live, not a workaround for a
// real problem. Propco's intercompany relationship (if any) has NOT been
// investigated — it has no entry in EXCLUDED_INTERCOMPANY_VENDORS yet. Per
// Michael's decision 2026-08-21, this report intentionally does NOT surface
// the Due-to/from intercompany balances themselves (a separate, larger
// discrepancy was found there — ~$700 mismatch between JRB/Transport's
// "Transportation" due-to/from accounts — flagged to Michael directly in
// chat, not built into this report).

import { logger } from '../../core/logger.js';
import { sendEmail } from './m365.js';
import { getAPAgingReport } from './quickbooks.js';
import { getQBRealmId } from './qb-token.js';
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

const ENTITIES = [
  { company: 'jrb', label: 'J.R. Boehlke' },
  { company: 'transport', label: 'JRB Transport' },
  { company: 'propco', label: 'JRB Granville Propco' },
];

// Defensive only — see file header note. Vendor display names, per entity,
// that represent the OTHER related entity rather than a genuine third party.
// Excluded from AP totals so an intercompany bill (if one is ever entered
// this way instead of via journal entry) can't inflate the consolidated
// "real" AP figure. Confirmed empty in practice as of 2026-08-21.
// Matched via normalizeVendorName() below (not exact string equality) so a
// harmless real-world variation in how the vendor got typed into QBO
// (punctuation, "L.L.C." vs "LLC", case, extra whitespace) can't silently
// defeat this guard — a mismatch here would inflate the "real" AP total with
// no indication anything was skipped, exactly what this guard exists to stop.
const EXCLUDED_INTERCOMPANY_VENDORS = {
  jrb: new Set(['jrb transport llc', 'jrb transport'].map(normalizeVendorName)),
  transport: new Set(['j r boehlke llc', 'j r boehlke inc', 'j r boehlke', 'jr boehlke'].map(normalizeVendorName)),
};

function normalizeVendorName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

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

// Fetches one entity's AP aging, tags every bill with its entity label, and
// drops any intercompany-vendor bill per EXCLUDED_INTERCOMPANY_VENDORS above.
// Never throws — a QBO failure for one entity shouldn't blank the whole
// report when the other entity's data fetched fine.
async function fetchEntityAging({ company, label }) {
  // Not yet OAuth-authorized (e.g. Propco added to ENTITIES before Michael
  // completes /qb-reauth for it) — skip quietly rather than surfacing a
  // "data unavailable" warning every run for a company that was never
  // connected in the first place. mergeEntityAgings() below only shows the
  // failedLabels banner for a REAL fetch failure, not this case.
  if (!getQBRealmId(company)) return { ok: false, company, label, notConnected: true };

  try {
    const raw = await getAPAgingReport(company);
    const excluded = EXCLUDED_INTERCOMPANY_VENDORS[company] ?? new Set();
    const buckets = {};
    let total = 0;
    let excludedCount = 0;
    for (const [bucketKey, rows] of Object.entries(raw.buckets)) {
      buckets[bucketKey] = rows
        .filter(b => {
          if (excluded.has(normalizeVendorName(b.vendor))) { excludedCount += 1; return false; }
          return true;
        })
        .map(b => ({ ...b, entity: label }));
      total += buckets[bucketKey].reduce((s, b) => s + b.balance, 0);
    }
    if (excludedCount > 0) {
      logger.info('ap_report: excluded intercompany-vendor bill(s)', { company, excludedCount });
    }
    return { ok: true, company, label, buckets, total };
  } catch (err) {
    logger.warn('ap_report: entity fetch failed', { company, err: err.message });
    return { ok: false, company, label, error: err.message };
  }
}

// Merges however many entities fetched successfully into one buckets/total
// shape matching getAPAgingReport()'s own return shape, so the rest of this
// file's builders (written against a single-entity apAging) work unchanged.
function mergeEntityAgings(results) {
  const ok = results.filter(r => r.ok);
  // notConnected entities are omitted from the failure banner entirely (see
  // fetchEntityAging) — only a real fetch failure on an already-authorized
  // entity is worth interrupting Michael about every run.
  const failed = results.filter(r => !r.ok && !r.notConnected);
  const buckets = { current: [], d30: [], d60: [], d90: [], d120plus: [] };
  let total = 0;
  for (const r of ok) {
    for (const key of Object.keys(buckets)) buckets[key].push(...(r.buckets[key] ?? []));
    total += r.total;
  }
  for (const b of Object.values(buckets)) b.sort((a, c) => c.balance - a.balance);
  return {
    apAging: { buckets, total },
    includedLabels: ok.map(r => r.label),
    failedLabels: failed.map(r => r.label),
    perEntityTotals: ok.map(r => ({ label: r.label, total: r.total, billCount: allBillsFrom({ buckets: r.buckets }).length })),
  };
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
//
// Grouped by entity+vendor (not vendor alone) — two different companies'
// vendor lists are independent, so a same-named vendor at each (unlikely, but
// not impossible) must never have its balances combined.
function buildVendorPriority(apAging) {
  const byVendor = {};
  for (const b of allBillsFrom(apAging)) {
    const key = `${b.entity}|${b.vendor}`;
    if (!byVendor[key]) byVendor[key] = { entity: b.entity, vendor: b.vendor, balance: 0, billCount: 0, maxAgeDays: -Infinity };
    const v = byVendor[key];
    v.balance += b.balance;
    v.billCount += 1;
    if (b.ageDays > v.maxAgeDays) v.maxAgeDays = b.ageDays;
  }
  return Object.values(byVendor)
    .sort((a, b) => {
      const balDiff = b.balance - a.balance;
      if (Math.abs(balDiff) > 0.01) return balDiff;
      return b.maxAgeDays - a.maxAgeDays; // tie-break: oldest due first
    })
    .slice(0, VENDOR_PRIORITY_MAX_ROWS);
}

// Possible duplicate bills: same entity + vendor + TotalAmt, entered within
// DUPLICATE_DATE_WINDOW_DAYS of each other. A shared, identical DocNumber is
// called out as "exact duplicate" (much higher-confidence signal — the same
// bill number entered twice) vs. "possible duplicate" for same vendor/amount
// alone (could legitimately be two different bills that happen to match).
// Grouped by entity too — a coincidental same-vendor-name-and-amount match
// across two different companies is not a duplicate of anything.
function buildDuplicateFlags(apAging) {
  const bills = allBillsFrom(apAging);
  const groups = {};
  for (const b of bills) {
    const key = `${b.entity}|${b.vendor}|${b.totalAmt.toFixed(2)}`;
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
        entity: sorted[i].entity,
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

function buildEmail({ apAging, dueSoon, vendorPriority, duplicateFlags, discrepancyFlags, today, perEntityTotals, failedLabels }) {
  let html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Accounts Payable Report ${today}</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" style="max-width:620px;background-color:#ffffff;border-radius:6px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

<!-- HEADER -->
<tr><td style="background-color:#1a1a2e;padding:24px 32px;">
  <p style="margin:0;color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:0.5px;">JRB Group</p>
  <p style="margin:4px 0 0;color:#aaaacc;font-size:13px;">Accounts Payable Report &nbsp;|&nbsp; ${fD(today)}</p>
</td></tr>

<!-- BODY -->
<tr><td style="padding:28px 32px;">`;

  if (failedLabels.length) {
    html += alertBox('#fff8f0', '#e6a817', `${failedLabels.join(' & ')} Data Unavailable This Run`,
      `<p style="margin:0;font-size:13px;color:#533f03;">Couldn't reach QuickBooks for ${failedLabels.join(' and ')} this run — the totals below reflect only the entities that did load.</p>`);
  }

  // ── Totals bar ────────────────────────────────────────────────────────────
  html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eef1fa;border-radius:4px;margin-bottom:6px;"><tr>
  <td style="padding:14px 16px;text-align:center;border-right:1px solid #d8e0f0;">
    <p style="margin:0;font-size:20px;font-weight:bold;color:#b35900;">${f$(apAging.total)}</p>
    <p style="margin:2px 0 0;font-size:11px;color:#555577;text-transform:uppercase;letter-spacing:0.6px;">Total Open AP</p>
  </td>
  <td style="padding:14px 16px;text-align:center;">
    <p style="margin:0;font-size:20px;font-weight:bold;color:#1a1a2e;">${dueSoon.count}</p>
    <p style="margin:2px 0 0;font-size:11px;color:#555577;text-transform:uppercase;letter-spacing:0.6px;">Bills Due in ${DUE_SOON_DAYS} Days</p>
  </td>
</tr></table>`;
  if (perEntityTotals.length > 1) {
    html += `<p style="margin:0 0 20px;font-size:12px;color:#666666;text-align:center;">${perEntityTotals.map(e => `${e.label}: <strong>${f$(e.total)}</strong> (${e.billCount} bill${e.billCount === 1 ? '' : 's'})`).join(' &nbsp;|&nbsp; ')}</p>`;
  } else {
    html += `<div style="margin-bottom:20px;"></div>`;
  }

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
        <td style="padding:6px 6px;font-size:13px;color:#333333;">${b.vendor}
          <br><span style="font-size:11px;color:#888888;">${b.entity}${b.docNumber ? ` &middot; #${b.docNumber}` : ''}</span>
        </td>
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
    vendorPriority.forEach((info, i) => {
      html += `<tr style="background-color:${i % 2 ? '#f8f8f8' : '#ffffff'};">
        <td style="padding:6px 6px;font-size:13px;color:#888888;">${i + 1}</td>
        <td style="padding:6px 6px;font-size:13px;color:#333333;">${info.vendor}
          <br><span style="font-size:11px;color:#888888;">${info.entity}${info.billCount > 1 ? ` &middot; ${info.billCount} open bills` : ''}</span>
        </td>
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
        return `<tr><td style="padding:4px 0;font-size:13px;color:#533f03;">${label}: <strong>${f.vendor}</strong> (${f.entity}) — ${f$(f.amount)}
          <br><span style="font-size:11px;color:#888888;">Bill ${b1.docNumber ?? b1.id} (${fD(b1.txnDate)}) &amp; Bill ${b2.docNumber ?? b2.id} (${fD(b2.txnDate)})</span>
        </td></tr>`;
      }).join('');
      html += alertBox('#fff3cd', '#e6a817', `${duplicateFlags.length} Possible Duplicate Bill${duplicateFlags.length > 1 ? 's' : ''}`,
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`);
    }
    if (discrepancyFlags.length) {
      const rows = discrepancyFlags.map(b =>
        `<tr><td style="padding:4px 0;font-size:13px;color:#7a1f1f;"><strong>${b.vendor}</strong> (${b.entity}) Bill ${b.docNumber ?? b.id} — line items ${f$(b.lineTotal)} vs. total ${f$(b.totalAmt)}
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

  const entityResults = await Promise.all(ENTITIES.map(fetchEntityAging));
  const { apAging, includedLabels, failedLabels, perEntityTotals } = mergeEntityAgings(entityResults);

  // Total outage (nothing real to report at all) is a hard failure, not a
  // degraded-but-successful send — a bold "$0.00 Total Open AP" headline
  // during a total data outage would read as "nothing owed" instead of
  // "couldn't fetch." Throwing lets scheduler/cron.js's existing try/catch
  // fire the Teams alert, same protection bank-monthly-report.js applies for
  // its own equivalent total-outage case.
  if (includedLabels.length === 0) {
    throw new Error(`ap_report: total outage — every AP entity failed to fetch (${entityResults.map(r => r.label).join(', ')})`);
  }

  // Note: getAPAgingReport() also returns `flagged` (60d+/$500+ bills, same
  // convention as getARAgingReport()'s AR call-queue source), but it's
  // intentionally not surfaced as its own section here — Vendor Payment
  // Priority below already ranks every open bill (not just the 60d+ bucket)
  // by cash impact across the whole open-AP set, which supersedes it for
  // this report. Left unused deliberately, not by oversight.
  const dueSoon = buildDueSoon(apAging);
  const vendorPriority = buildVendorPriority(apAging);
  const duplicateFlags = buildDuplicateFlags(apAging);
  const discrepancyFlags = buildDiscrepancyFlags(apAging);

  const body = buildEmail({ apAging, dueSoon, vendorPriority, duplicateFlags, discrepancyFlags, today, perEntityTotals, failedLabels });

  const subjectSuffix = failedLabels.length ? ` (${failedLabels.join('/')} unavailable)` : '';
  await sendEmail({
    to: ['michael@jrboehlke.com'],
    subject: `Accounts Payable — ${fD(today)} | ${f$(apAging.total)} owed${subjectSuffix}`,
    body,
  });

  logger.info('ap_report: sent', {
    today,
    totalAP: apAging.total,
    includedLabels,
    failedLabels,
    dueSoonCount: dueSoon.count,
    duplicateFlagCount: duplicateFlags.length,
    discrepancyFlagCount: discrepancyFlags.length,
  });
  return {
    today,
    totalAP: apAging.total,
    includedLabels,
    failedLabels,
    dueSoonCount: dueSoon.count,
    vendorPriorityCount: vendorPriority.length,
    duplicateFlagCount: duplicateFlags.length,
    discrepancyFlagCount: discrepancyFlags.length,
  };
}
