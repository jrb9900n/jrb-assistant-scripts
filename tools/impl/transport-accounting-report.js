// tools/impl/transport-accounting-report.js — automated monthly transport accounting report
//
// Replaces a manual workflow: someone logged into FleetSharp, ran the "Advanced Trips"
// report, exported it, pasted it into a spreadsheet, and read off Short/Long trip-day
// counts per truck for intercompany invoicing. That spreadsheet's classification formula
// had a real bug (confirmed 2026-08-19): every per-day cell could only ever evaluate to
// "S" or blank — there was no code path that could ever produce "L" (Long), so every
// truck-day was silently billed as Short regardless of whether the truck actually left
// the local area. This module pulls the same FleetSharp report via API instead of by
// hand, and classifies each truck-day correctly.
//
// Classification rule (validated against real historical export data 2026-08-19): a
// truck's day is "Long" if ANY event that day has a location but no matching Start/End
// Geofence at all — meaning it's outside every defined geofence, including the "50 Mile
// Radius" catch-all that normally matches almost everything. A local trip always matches
// at least that catch-all fence; only a genuine >50mi trip goes fully unmatched. Verified
// against a real 7-month export: found exactly one true long trip (Truck 192, Milton/
// Janesville/Cambridge, WI — all 50+ miles from the Mequon home base) with zero false
// positives or negatives among ~500 truck-days.

import XLSX from 'xlsx';
import { getAdvancedTripsExport } from './fleetsharp.js';
import { sendEmail } from './m365.js';
import { logger } from '../../core/logger.js';

// Flat per-day rate, matching the existing Invoice tab's simple billing model (as opposed
// to the Management tab's more granular per-person hourly-rate x roundtrip-hours system,
// which is tied to which specific person typically drives each truck and changes as staff
// does — not replicated here to avoid silently going stale; ask Michael if the per-person
// breakdown should be automated too). Edit these values as rates change.
export const RATE_CONFIG = {
  shortDayRate: 150,
  longDayRate: 375,
};

function parseSADate(raw) {
  // FleetSharp's Advanced Trips export writes dates as plain strings: 'MM/DD/YYYY HH:MM AM/PM'.
  // Every row observed so far zero-pads month/day, but month/day accept 1-2 digits here too
  // (matching the hour, which is legitimately unpadded, e.g. '8/1/2026 6:05 AM') so an
  // unpadded date can't silently drop that row out of the day-count entirely.
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec((raw || '').trim());
  if (!m) return null;
  const [, mm, dd, yyyy, hhRaw, min, ampm] = m;
  let hh = parseInt(hhRaw, 10);
  if (ampm.toUpperCase() === 'PM' && hh !== 12) hh += 12;
  if (ampm.toUpperCase() === 'AM' && hh === 12) hh = 0;
  return new Date(Number(yyyy), Number(mm) - 1, Number(dd), hh, Number(min));
}

function toDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Matches "Truck 18", "Truck 193 (Fert)", etc. — excludes non-vehicle trackers on the same
// FleetSharp account (e.g. "CAT 262D3", a skid steer) that this report isn't billed for.
const VEHICLE_NAME_RE = /^Truck\s+\d+/i;

/**
 * Parses the raw Advanced Trips export buffer into per-truck Short/Long day counts.
 * Exported separately from the FleetSharp pull so the classification logic can be
 * tested against a saved .xlsx without hitting the live API each time.
 */
export function classifyFromExportBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: null });

  const activityByTruck = new Map();       // truck -> Set of 'YYYY-MM-DD'
  const outsideCountByTruck = new Map();   // truck -> Map of 'YYYY-MM-DD' -> count of blank-geofence rows

  // Row shape: [(blank), Event, Tracker, Driver, Start Time, Start Location, Start Geofence,
  //             End Time, End Location, End Geofence, Distance, Travel Time, Idle Time, Stop Time, Authorized]
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const tracker = r[2];
    const startTimeRaw = r[4];
    const startLoc = r[5];
    const startGeo = r[6];
    const endGeo = r[9];
    if (!tracker || !startTimeRaw) continue; // group-header/summary rows have no Tracker+Start Time
    if (!VEHICLE_NAME_RE.test(tracker)) continue; // equipment (e.g. "CAT 262D3" skid steer) isn't billed as a trip-day vehicle

    const dt = parseSADate(startTimeRaw);
    if (!dt) continue;
    const dateKey = toDateKey(dt);

    if (!activityByTruck.has(tracker)) activityByTruck.set(tracker, new Set());
    activityByTruck.get(tracker).add(dateKey);

    if (startLoc && !startGeo && !endGeo) {
      if (!outsideCountByTruck.has(tracker)) outsideCountByTruck.set(tracker, new Map());
      const dayCounts = outsideCountByTruck.get(tracker);
      dayCounts.set(dateKey, (dayCounts.get(dateKey) || 0) + 1);
    }
  }

  // A single blank-geofence row can be a one-off GPS/geofence-matching glitch even at a
  // well-known local address (confirmed live 2026-08-19: Truck 24 got one blank-geofence
  // row at the JRB Shop itself — the home base, nowhere near 50 miles out). A genuine long
  // trip generates many such rows as the truck pings repeatedly while outside every
  // geofence (the one fully-validated historical case, Truck 192 on 2026-03-23, had 21).
  // Requiring several rows filters the single-glitch case while staying far below what a
  // real trip produces.
  const MIN_OUTSIDE_ROWS_FOR_LONG_DAY = 3;

  const trucks = [...activityByTruck.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return trucks.map(truck => {
    const activeDays = activityByTruck.get(truck) || new Set();
    const dayCounts = outsideCountByTruck.get(truck) || new Map();
    const longDays = new Set([...dayCounts.entries()].filter(([, count]) => count >= MIN_OUTSIDE_ROWS_FOR_LONG_DAY).map(([d]) => d));
    const shortDayCount = activeDays.size - longDays.size;
    return {
      truck,
      shortDayCount,
      longDayCount: longDays.size,
      longDates: [...longDays].sort(),
    };
  });
}

/**
 * Pulls the Advanced Trips report from FleetSharp for the given period and returns the
 * classified per-truck breakdown plus computed invoice totals.
 */
export async function generateTransportAccountingReport({ startDate, endDate }) {
  const buffer = await getAdvancedTripsExport({ startDate, endDate });
  const perTruck = classifyFromExportBuffer(buffer);

  let totalShort = 0, totalLong = 0, totalAmount = 0;
  const lines = perTruck.map(t => {
    const amount = t.shortDayCount * RATE_CONFIG.shortDayRate + t.longDayCount * RATE_CONFIG.longDayRate;
    totalShort += t.shortDayCount;
    totalLong += t.longDayCount;
    totalAmount += amount;
    return { ...t, amount };
  });

  return { startDate, endDate, lines, totalShort, totalLong, totalAmount };
}

function formatCurrency(n) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function buildEmailHtml(report) {
  const rows = report.lines.map(l => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${l.truck}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${l.shortDayCount}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;${l.longDayCount > 0 ? 'color:#b45309;font-weight:600;' : ''}">${l.longDayCount}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${formatCurrency(l.amount)}</td>
    </tr>
    ${l.longDates.length > 0 ? `<tr><td colspan="4" style="padding:0 12px 8px 12px;font-size:12px;color:#6b7280;">Long trip date(s): ${l.longDates.join(', ')}</td></tr>` : ''}
  `).join('');

  return `
    <div style="font-family:Arial,sans-serif;color:#1f2937;max-width:700px;">
      <div style="background:#1a1a2e;color:#fff;padding:20px 24px;">
        <h2 style="margin:0;font-size:20px;">Transport Accounting Report</h2>
        <p style="margin:4px 0 0 0;color:#cbd5e1;font-size:13px;">${report.startDate} to ${report.endDate}</p>
      </div>
      <div style="padding:20px 24px;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <thead>
            <tr style="background:#f3f4f6;">
              <th style="padding:8px 12px;text-align:left;">Truck</th>
              <th style="padding:8px 12px;text-align:right;">Short Days</th>
              <th style="padding:8px 12px;text-align:right;">Long Days</th>
              <th style="padding:8px 12px;text-align:right;">Amount</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr style="background:#1a1a2e;color:#fff;font-weight:600;">
              <td style="padding:10px 12px;">Total</td>
              <td style="padding:10px 12px;text-align:right;">${report.totalShort}</td>
              <td style="padding:10px 12px;text-align:right;">${report.totalLong}</td>
              <td style="padding:10px 12px;text-align:right;">${formatCurrency(report.totalAmount)}</td>
            </tr>
          </tfoot>
        </table>
        <p style="font-size:12px;color:#6b7280;margin-top:16px;">
          Rates: $${RATE_CONFIG.shortDayRate}/short day, $${RATE_CONFIG.longDayRate}/long day (50-mile radius cutoff).
          Long-day dates are called out below each truck row for reference.
        </p>
      </div>
    </div>
  `;
}

/**
 * Generates and emails the transport accounting report for a given period.
 * Called by the monthly cron job with the prior full calendar month.
 */
export async function runTransportAccountingReport({ startDate, endDate }) {
  // Does NOT close the FleetSharp session when done — tools/impl/fleetsharp.js keeps a
  // single shared browser/page open for its full 4-hour SESSION_TTL_MS, reused by every
  // caller (fleetops_odometer_sync, interactive fleetsharp_get_* agent tools, etc.).
  // Closing it here would yank that session out from under any concurrent caller. Only
  // the process-level shutdown handler in scheduler/cron.js should ever close it.
  const report = await generateTransportAccountingReport({ startDate, endDate });
  await sendEmail({
    to: ['michael@jrboehlke.com'],
    subject: `Transport Accounting Report — ${startDate} to ${endDate}`,
    body: buildEmailHtml(report),
  });
  logger.info('transport_accounting_report complete', {
    startDate, endDate, totalShort: report.totalShort, totalLong: report.totalLong, totalAmount: report.totalAmount,
  });
  return report;
}
