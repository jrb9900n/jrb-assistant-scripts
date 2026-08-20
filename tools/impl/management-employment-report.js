// tools/impl/management-employment-report.js — automated Management and Employment Calc report
//
// Downstream companion to transport-accounting-report.js: same FleetSharp Short/Long
// trip-day counts, but priced using the Management Reporting Template's more granular
// per-person hourly-rate model instead of the flat $150/$375 rate, then rolled up with
// a 5% markup into a final invoice total (mirrors that spreadsheet's O22/O23/O24 cells).
//
// Real bug found and fixed while porting this (2026-08-19): the spreadsheet's Long-day
// dollar formula (column N) multiplied by the *Short* roundtrip-hours assumption (3 hrs)
// instead of the Long one (8 hrs) for every truck row — so even a correctly-counted Long
// day would have been underbilled on the hours side. This version uses the correct
// per-classification roundtrip hours for each.
//
// The rate table below is genuinely staff-dependent (tied to who typically drives each
// truck) and will go stale as people/trucks change — it's seeded from the real spreadsheet
// values as of 2026-08-19, kept as plain editable objects rather than baked into logic so
// updating a rate or reassigning a truck is a one-line edit, not a code change.

import { pullAndClassify, alignToCanonicalTrucks } from './transport-accounting-report.js';

// Per-person hourly rates, grouped by category — edit individual rates here as they change.
export const PERSON_RATES = {
  sealcoat: { Ross: 28, Jose: 31, Tyler: 24 },
  landscape: { Tyler: 27, 'College Kids': 20 },
  weeder: { Lindsey: 21 },
  other: { Dave: 28, Reid: 25, Chris: 32, Rick: 35, James: 28, Scott: 22, Michael: 2000 / 40, Jacob: 20, Steffen: 38 },
};

// Truck number -> rate assignment. `category` alone uses that category's average rate;
// `person` (with a `category` to look the name up in) pins the truck to one specific
// person's rate instead of the average — matching the "Typical Driver" column, which
// names either a role (uses the team average) or a specific individual.
export const TRUCK_RATE_ASSIGNMENT = {
  4: { category: 'sealcoat' },
  7: { category: 'weeder' },
  71: { category: 'landscape' },
  9: { category: 'sealcoat' },
  106: { category: 'other' },
  12: { category: 'landscape' },
  13: { category: 'landscape' },
  14: { category: 'other' },
  25: { category: 'landscape' },
  18: { category: 'other', person: 'Rick' },
  19: { category: 'sealcoat' },
  190: { category: 'sealcoat' },
  191: { category: 'landscape' },
  192: { category: 'landscape' },
  193: { category: 'other', person: 'Dave' },
  194: { category: 'other' },
  22: { category: 'other' },
  220: { category: 'other', person: 'Scott' },
  24: { category: 'other', person: 'Steffen' },
};

// Roundtrip-hours assumption per trip type — the actual fix for the N-column bug above:
// Short and Long each use their own value, not both using Short's.
export const ROUNDTRIP_HOURS = { short: 3, long: 8 };
export const MARKUP_RATE = 0.05;

function categoryAverage(category) {
  const rates = Object.values(PERSON_RATES[category] || {});
  if (rates.length === 0) return null;
  return rates.reduce((a, b) => a + b, 0) / rates.length;
}

function getTruckRate(truckNumber) {
  const assignment = TRUCK_RATE_ASSIGNMENT[truckNumber];
  if (!assignment) return null;
  if (assignment.person) {
    const personRate = PERSON_RATES[assignment.category]?.[assignment.person];
    if (personRate !== undefined) return personRate;
  }
  return categoryAverage(assignment.category);
}

/**
 * Computes the Management/Employment per-truck pricing from already-classified
 * Short/Long day counts (see classifyFromExportBuffer in transport-accounting-report.js).
 * Split out from the FleetSharp pull so it's testable against fixed input.
 */
export function computeManagementEmploymentTotals(perTruckClassification) {
  const lines = alignToCanonicalTrucks(perTruckClassification, ({ tracker, truckNumber, shortDayCount, longDayCount }) => {
    const rate = truckNumber === null ? null : getTruckRate(truckNumber);
    if (rate === null) {
      return { truck: tracker, truckNumber, rate: null, shortDayCount, longDayCount, shortAmount: 0, longAmount: 0, total: 0, unmapped: true };
    }
    const shortAmount = rate * shortDayCount * ROUNDTRIP_HOURS.short;
    const longAmount = rate * longDayCount * ROUNDTRIP_HOURS.long;
    return { truck: tracker, truckNumber, rate, shortDayCount, longDayCount, shortAmount, longAmount, total: shortAmount + longAmount, unmapped: false };
  });

  const subtotal = lines.reduce((s, l) => s + l.total, 0);
  const markup = subtotal * MARKUP_RATE;
  const grandTotal = subtotal + markup;
  return { lines, subtotal, markup, grandTotal };
}

export async function generateManagementEmploymentReport({ startDate, endDate }) {
  const perTruck = await pullAndClassify({ startDate, endDate });
  const totals = computeManagementEmploymentTotals(perTruck);
  return { startDate, endDate, ...totals };
}
