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
    return { buckets: { current: [], d30: [], d60: [], d90: [], d120plus: [] }, flagged: [], total: 0 };
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

  return { buckets, flagged, total };
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
