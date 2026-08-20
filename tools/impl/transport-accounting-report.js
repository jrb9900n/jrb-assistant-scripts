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

// Flat per-day rate, matching the existing Invoice tab's simple billing model (as opposed
// to the Management tab's more granular per-person hourly-rate x roundtrip-hours system,
// which is tied to which specific person typically drives each truck and changes as staff
// does — not replicated here to avoid silently going stale; ask Michael if the per-person
// breakdown should be automated too). Edit these values as rates change.
export const RATE_CONFIG = {
  shortDayRate: 150,
  longDayRate: 375,
};

// Fixed truck list, in the same order as the real spreadsheet's B8:B26 (Invoice tab) /
// B3:B21 (Management tab) rows — confirmed identical order in both tabs 2026-08-19. The
// spreadsheet always lists every one of these trucks even when a truck saw zero activity
// that month; computeTransportInvoiceTotals/computeManagementEmploymentTotals iterate this
// list so a quiet truck still shows up as a $0 row instead of silently disappearing.
export const CANONICAL_TRUCKS = [
  { number: 4, tracker: 'Truck 4' },
  { number: 7, tracker: 'Truck 7' },
  { number: 71, tracker: 'Truck 71' },
  { number: 9, tracker: 'Truck 9' },
  { number: 106, tracker: 'Truck 106' },
  { number: 12, tracker: 'Truck 12' },
  { number: 13, tracker: 'Truck 13' },
  { number: 14, tracker: 'Truck 14' },
  { number: 25, tracker: 'Truck 25' },
  { number: 18, tracker: 'Truck 18' },
  { number: 19, tracker: 'Truck 19' },
  { number: 190, tracker: 'Truck 190' },
  { number: 191, tracker: 'Truck 191' },
  { number: 192, tracker: 'Truck 192' },
  { number: 193, tracker: 'Truck 193 (Fert)' },
  { number: 194, tracker: 'Truck 194' },
  { number: 22, tracker: 'Truck 22' },
  { number: 220, tracker: 'Truck 220' },
  { number: 24, tracker: 'Truck 24' },
];

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
 *
 * `startDate`/`endDate` ('YYYY-MM-DD', inclusive) are required (not just optional) to
 * bound the day count to the requested period. Confirmed live 2026-08-19: FleetSharp's
 * Advanced Trips export for a given date range isn't hard-clipped to it — a real May
 * 1-31 pull included trailing rows from late April — so without this filter, every
 * truck picked up 1-2 extra active days from the adjacent month (219 vs. the correct
 * 193 for May 2026). The manual spreadsheet never hit this because its day columns only
 * span the target month, so any bled-in row from an adjacent month simply has no column
 * to match. Required (throws if omitted) rather than defaulting to unfiltered, matching
 * getAdvancedTripsExport's own convention — an unfiltered call would silently
 * reintroduce this exact bug rather than erroring.
 */
export function classifyFromExportBuffer(buffer, { startDate, endDate } = {}) {
  if (!startDate || !endDate) throw new Error('classifyFromExportBuffer requires startDate and endDate');
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
    if (startDate && dateKey < startDate) continue;
    if (endDate && dateKey > endDate) continue;

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

function extractTruckNumber(tracker) {
  const m = /^Truck\s+(\d+)/i.exec((tracker || '').trim());
  return m ? Number(m[1]) : null;
}

/**
 * Walks CANONICAL_TRUCKS in its fixed order, looking up each truck's classified day
 * counts (defaulting to zero for a quiet truck) and running them through `priceFn` —
 * so a truck with zero activity that month still shows a $0 row instead of disappearing,
 * matching the real spreadsheet's always-list-every-truck layout. Any tracker seen in
 * the export that isn't on the fixed list (e.g. a new truck added to the fleet since
 * this list was last updated) is appended after, not silently dropped. Shared by both
 * computeTransportInvoiceTotals and computeManagementEmploymentTotals so the alignment
 * logic — and the canonical truck number, resolved once here instead of re-derived by
 * every caller — only lives in one place.
 */
export function alignToCanonicalTrucks(perTruckClassification, priceFn) {
  const byTracker = new Map(perTruckClassification.map(t => [t.truck, t]));
  const seen = new Set();
  const lines = [];

  for (const { tracker, number } of CANONICAL_TRUCKS) {
    seen.add(tracker);
    const t = byTracker.get(tracker);
    lines.push(priceFn({
      tracker, truckNumber: number,
      shortDayCount: t?.shortDayCount ?? 0, longDayCount: t?.longDayCount ?? 0, longDates: t?.longDates ?? [],
    }));
  }
  for (const t of perTruckClassification) {
    if (seen.has(t.truck)) continue;
    lines.push(priceFn({
      tracker: t.truck, truckNumber: extractTruckNumber(t.truck),
      shortDayCount: t.shortDayCount, longDayCount: t.longDayCount, longDates: t.longDates,
    }));
  }
  return lines;
}

/**
 * Prices an already-classified per-truck breakdown (see classifyFromExportBuffer) using
 * the flat Invoice-tab rate model.
 */
export function computeTransportInvoiceTotals(perTruckClassification) {
  const lines = alignToCanonicalTrucks(perTruckClassification, ({ tracker, shortDayCount, longDayCount, longDates }) => {
    const amount = shortDayCount * RATE_CONFIG.shortDayRate + longDayCount * RATE_CONFIG.longDayRate;
    return { truck: tracker, shortDayCount, longDayCount, longDates, amount };
  });

  return {
    lines,
    totalShort: lines.reduce((s, l) => s + l.shortDayCount, 0),
    totalLong: lines.reduce((s, l) => s + l.longDayCount, 0),
    totalAmount: lines.reduce((s, l) => s + l.amount, 0),
  };
}

/**
 * Single choke point for "pull the Advanced Trips export, then classify it" — every
 * report generator goes through this so the date-range filter (see
 * classifyFromExportBuffer above) is applied exactly once, not re-passed at every call
 * site.
 */
export async function pullAndClassify({ startDate, endDate }) {
  const buffer = await getAdvancedTripsExport({ startDate, endDate });
  return classifyFromExportBuffer(buffer, { startDate, endDate });
}

/**
 * Pulls the Advanced Trips report from FleetSharp for the given period and returns the
 * classified per-truck breakdown plus computed invoice totals.
 */
export async function generateTransportAccountingReport({ startDate, endDate }) {
  const perTruck = await pullAndClassify({ startDate, endDate });
  return { startDate, endDate, ...computeTransportInvoiceTotals(perTruck) };
}
