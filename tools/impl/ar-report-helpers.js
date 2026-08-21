// tools/impl/ar-report-helpers.js
// Shared AR-aging data fetch + HTML template helpers.
//
// Extracted from weekly-finance-report.js so the AR/Collections report (and any
// future report needing the same aging buckets or template conventions) reuses
// this logic instead of re-deriving it. Pure/read-only — no behavior change from
// the original inline versions.

import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';

// Exported so weekly-finance-report.js and ar-collections-report.js share one
// client for the fleetops project instead of each instantiating their own.
export const supabase = createClient(
  process.env.FLEETOPS_SUPABASE_URL,
  process.env.FLEETOPS_SUPABASE_SERVICE_KEY
);

// SA AR aging — queries sa_invoices (invoice_balance > 0).
// Replaces live QB getARAgingReport() — uses pre-computed days_past_due from last AME sync.
export async function gatherSAARaging() {
  const { data, error } = await supabase
    .from('sa_invoices')
    .select('sa_id, invoice_number, client, invoice_balance, days_past_due, due_date, date')
    .gt('invoice_balance', 0)
    .eq('deleted', false)
    .order('days_past_due', { ascending: false });
  if (error) {
    logger.warn('SA AR aging query failed', { err: error.message });
    // `available: false` is additive — existing callers (ar-collections-
    // report.js, cash-forecast-report.js, weekly-finance-report.js) only
    // ever read .total/.buckets/.flagged directly and are unaffected by the
    // extra field, but a query failure defaulting silently to total:0 was
    // otherwise indistinguishable from a genuine zero-AR state to any new
    // caller that actually needs to tell the two apart (e.g. an "AR
    // unavailable" banner instead of a fabricated $0.00).
    return { buckets: { current: [], d30: [], d60: [], d90: [], d120plus: [] }, flagged: [], total: 0, available: false };
  }

  const buckets = { current: [], d30: [], d60: [], d90: [], d120plus: [] };
  let total = 0;

  for (const inv of (data ?? [])) {
    const balance = Number(inv.invoice_balance);
    const ageDays = Number(inv.days_past_due ?? 0);
    total += balance;
    const record = {
      invoiceNum: inv.invoice_number,
      customer:   inv.client,
      balance,
      ageDays,
      dueDate:    inv.due_date ?? inv.date,
    };
    if (ageDays <= 0)        buckets.current.push(record);
    else if (ageDays <= 30)  buckets.d30.push(record);
    else if (ageDays <= 60)  buckets.d60.push(record);
    else if (ageDays <= 90)  buckets.d90.push(record);
    else                     buckets.d120plus.push(record);
  }
  for (const b of Object.values(buckets)) b.sort((a, c) => c.balance - a.balance);

  const flagged = [...buckets.d60, ...buckets.d90, ...buckets.d120plus]
    .filter(r => r.balance >= 500)
    .sort((a, b) => b.balance - a.balance);

  return { buckets, flagged, total, available: true };
}

// Monday (UTC) of the week containing referenceDate, as YYYY-MM-DD.
// Shared by ar-collections-report.js and cash-forecast-report.js so both
// reports agree on "week start" without each re-deriving it.
export function mondayOf(referenceDate = new Date()) {
  const d = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), referenceDate.getUTCDate()));
  const dow = d.getUTCDay(); // 0=Sun
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

// Adds `days` (may be negative) to a YYYY-MM-DD (or full ISO) date string,
// UTC-safe, returning a YYYY-MM-DD string. cash-forecast-report.js has its
// OWN same-named local helper that looks identical but is NOT a duplicate of
// this one — it returns a raw Date object (its callers rely on that for
// direct Date comparisons in buildAPForecast's due-date bucketing), while
// every caller here only ever needs the formatted string. Deliberately left
// that file's version alone rather than forcing it onto this string-
// returning contract, which would require touching its date-math-sensitive,
// already-live forecast bucketing logic for a cosmetic rename, not a real
// behavior fix. New string-returning callers (e.g. weekly-scorecard-report.js)
// should use this shared version instead of adding another local copy.
export function addDaysUTC(dateStr, days) {
  const d = new Date(dateStr.length === 10 ? dateStr + 'T00:00:00Z' : dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Pure UTC calendar-day diff between two date-likes. Deliberately avoids
// .setHours(0,0,0,0), which rolls a UTC-midnight-parsed date back one
// calendar day on a server west of UTC — the exact off-by-one bug
// estimating-pipeline-report.js's own /code-review caught and fixed live.
// Comparing UTC calendar-day numbers directly sidesteps local time zone
// entirely, matching mondayOf()'s own Date.UTC(...) convention above.
// estimating-pipeline-report.js and sales-pipeline-report.js each carry
// their own private copy of this same function (built before this shared
// helpers file had one) — not retrofitted to import from here as part of
// this change since both are already-merged files outside this change's
// scope; new callers should use this shared version instead of adding yet
// another copy.
export function daysBetween(fromDateLike, toDateLike = new Date()) {
  if (!fromDateLike) return null;
  const from = new Date(fromDateLike);
  if (Number.isNaN(from.getTime())) return null;
  const to = new Date(toDateLike);
  const fromUTC = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const toUTC = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.max(0, Math.round((toUTC - fromUTC) / 86400000));
}

// SA sync freshness check — shared by any report reading sa_invoices, so a
// stale scrape is flagged consistently rather than each report re-deriving
// its own staleness logic.
export async function gatherSAFreshness({ staleHours = 24 } = {}) {
  const { data } = await supabase
    .from('sa_invoices')
    .select('synced_at')
    .order('synced_at', { ascending: false })
    .limit(1);
  const ts = data?.[0]?.synced_at ? new Date(data[0].synced_at).getTime() : 0;
  if (!ts) return { stale: true, ageHours: 999 };
  const ageHours = Math.round((Date.now() - ts) / 3600000);
  return { stale: ageHours > staleHours, ageHours };
}

// ── Formatting helpers ──────────────────────────────────────────────────────

export const f$ = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fD = s => s ? new Date(s.length === 10 ? s + 'T12:00:00Z' : s).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }) : '—';

// Reduced-red age badge: orange for <=60d, red only for 61d+
export const ageBadge = days => {
  if (days <= 0) return `<span style="font-size:11px;color:#888888;">due ${fD(new Date(Date.now() - days * 86400000).toISOString().slice(0,10))}</span>`;
  if (days <= 30) return `<span style="font-size:11px;color:#b35900;font-weight:bold;">${days}d past due</span>`;
  if (days <= 60) return `<span style="font-size:11px;color:#b35900;font-weight:bold;">${days}d past due</span>`;
  return `<span style="font-size:11px;color:#c0392b;font-weight:bold;background:#fff0f0;padding:1px 4px;border-radius:2px;">${days}d PAST DUE</span>`;
};

// Extract QB parent customer from "Parent:SubCustomer" format
export function masterCustomer(name) {
  if (!name) return name;
  const idx = name.indexOf(':');
  return idx > 0 ? name.slice(0, idx).trim() : name;
}

export function sectionHeader(title) {
  return `<p style="margin:28px 0 10px 0;font-size:13px;font-weight:bold;text-transform:uppercase;letter-spacing:0.8px;color:#888888;border-bottom:1px solid #e8e8e8;padding-bottom:6px;">${title}</p>`;
}

export function alertBox(color, borderColor, title, rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${color};border-left:4px solid ${borderColor};border-radius:4px;margin-bottom:16px;"><tr><td style="padding:12px 16px;"><p style="margin:0 0 8px 0;font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:0.8px;color:${borderColor};">${title}</p>${rows}</td></tr></table>`;
}
