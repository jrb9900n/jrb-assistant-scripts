// tools/impl/cash-forecast-report.js
// 12-Week Cash Forecast — Monday 9:45 AM, right after the 9:00-10:00 AR/Collections
// block and ahead of the 10:00-11:00 12-Week Cash Forecast calendar block. Mirrors
// ar-collections-report.js's structure/template conventions (see ar-report-helpers.js).
//
// THIS IS AN ESTIMATE, NOT A FACT. Every number below rests on a documented
// assumption (collection rates, a smoothed payroll average, which open bills
// happen to be entered in QuickBooks today) — the email itself spells each one
// out rather than presenting projected balances as certain. Treat this as a
// directional planning tool, not a bank-balance guarantee.
//
// Scope explicitly excluded from v1 (documented in the email, not silently
// dropped): new/future revenue and invoicing that will occur during the
// 12-week window — this only forecasts collection of AR that is already
// outstanding today, not sales that haven't happened yet. A real 13-week
// cash flow model at a mature company usually layers in a sales forecast too;
// this system has no sales-pipeline forecast to draw on yet.
//
// Multi-entity (added 2026-08-21): confirmed by Michael — JRB Transport LLC
// and JRB Granville Propco have no A/R of their own, but their cash/AP should
// still feed this forecast. Each connected company (tools/impl/qb-token.js's
// listQBCompanies()) gets its OWN independent 12-week running-balance series
// (own starting cash, own AP due, own payroll outflow) — these are separate
// legal entities with separate bank accounts, so nothing here models moving
// cash between them. The AR collection forecast (SA-derived) only applies to
// 'jrb' since SA only tracks J.R. Boehlke's customers; other entities get a
// zero AR-in series. A "combined" series (the plain per-week sum of every
// connected entity's own series) is shown as the headline number for
// at-a-glance total group liquidity, with each entity's own numbers broken
// out below — a company whose OWN forecast goes negative matters even if the
// combined total looks fine, since cash can't move between entities here.

import { logger } from '../../core/logger.js';
import { sendEmail } from './m365.js';
import { supabase, gatherSAARaging, gatherSAFreshness, mondayOf, f$, fD, sectionHeader, alertBox, entityDivider } from './ar-report-helpers.js';
import { getCashBalance, getOpenBillsForForecast, getPayrollCashOutflowEstimate } from './quickbooks.js';
import { gatherAcrossCompanies } from './qb-token.js';

const FORECAST_WEEKS = 12;
const STALE_DATA_HOURS = 24;
const PAYROLL_LOOKBACK_DAYS = 56; // trailing 8 weeks

// ── AR collection heuristic (documented here AND in the email itself) ──────
// "Current" + "1-30 days past due" are grouped as the near-term pool: assume
// CURRENT_D30_NEAR_TERM_PCT of that pool collects within the first
// CURRENT_D30_NEAR_TERM_WEEKS weeks (evenly), and the remainder trickles in
// evenly over the following CURRENT_D30_REMAINDER_WEEKS weeks. Older buckets
// (31-60d, 61d+) are already flagged as delinquent by the AR/Collections
// report — assume only a small fraction of those ever convert to cash within
// the 12-week window, spread evenly across all 12 weeks.
const CURRENT_D30_NEAR_TERM_PCT = 0.65;
const CURRENT_D30_NEAR_TERM_WEEKS = 2;
const CURRENT_D30_REMAINDER_WEEKS = 4;
const D60_COLLECTION_PCT = 0.15;
const D90PLUS_COLLECTION_PCT = 0.08;

const LOW_CASH_WARN_THRESHOLD = 10000; // chosen for this report's own color-coding only — not a target Michael has set

function addDaysUTC(dateStr, days) {
  const d = new Date(dateStr.length === 10 ? dateStr + 'T00:00:00Z' : dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function buildWeekWindows(weekStart) {
  const windows = [];
  for (let i = 0; i < FORECAST_WEEKS; i++) {
    const start = addDaysUTC(weekStart, i * 7);
    const end = addDaysUTC(weekStart, (i + 1) * 7); // exclusive
    windows.push({ index: i, start, end, startStr: start.toISOString().slice(0, 10) });
  }
  return windows;
}

// Distributes today's existing AR aging balances across the 12 forecast
// weeks per the heuristic documented above. Returns per-week collection
// amounts plus the bucket totals used, so the email can show its work.
function buildARCollectionForecast(arAging) {
  const bucketTotal = key => (arAging.buckets[key] ?? []).reduce((s, r) => s + r.balance, 0);
  const nearTermPool = bucketTotal('current') + bucketTotal('d30');
  const d60Total = bucketTotal('d60');
  const d90PlusTotal = bucketTotal('d90') + bucketTotal('d120plus');

  const weekly = new Array(FORECAST_WEEKS).fill(0);

  const nearTermFast = nearTermPool * CURRENT_D30_NEAR_TERM_PCT;
  const nearTermSlow = nearTermPool - nearTermFast;
  for (let w = 0; w < CURRENT_D30_NEAR_TERM_WEEKS; w++) weekly[w] += nearTermFast / CURRENT_D30_NEAR_TERM_WEEKS;
  for (let w = CURRENT_D30_NEAR_TERM_WEEKS; w < CURRENT_D30_NEAR_TERM_WEEKS + CURRENT_D30_REMAINDER_WEEKS; w++) {
    weekly[w] += nearTermSlow / CURRENT_D30_REMAINDER_WEEKS;
  }

  const d60Forecast = d60Total * D60_COLLECTION_PCT;
  const d90PlusForecast = d90PlusTotal * D90PLUS_COLLECTION_PCT;
  for (let w = 0; w < FORECAST_WEEKS; w++) {
    weekly[w] += d60Forecast / FORECAST_WEEKS;
    weekly[w] += d90PlusForecast / FORECAST_WEEKS;
  }

  return {
    weekly,
    totals: { nearTermPool, nearTermFast, nearTermSlow, d60Total, d60Forecast, d90PlusTotal, d90PlusForecast },
  };
}

// Buckets today's open QuickBooks bills into the 12-week window by due date.
// Anything already overdue lands in week 0 ("due now"); anything due beyond
// the 12-week window is excluded and called out separately rather than
// silently dropped or wrongly stuffed into week 11.
function buildAPForecast(bills, weekWindows) {
  const weekly = new Array(FORECAST_WEEKS).fill(0);
  let overdueTotal = 0;
  let beyondWindowTotal = 0;
  let beyondWindowCount = 0;
  const windowStart = weekWindows[0].start;
  const windowEnd = weekWindows[FORECAST_WEEKS - 1].end;

  for (const b of bills) {
    const due = new Date(b.dueDate.length === 10 ? b.dueDate + 'T00:00:00Z' : b.dueDate);
    if (due < windowStart) {
      weekly[0] += b.balance;
      overdueTotal += b.balance;
    } else if (due >= windowEnd) {
      beyondWindowTotal += b.balance;
      beyondWindowCount += 1;
    } else {
      const win = weekWindows.find(w => due >= w.start && due < w.end);
      weekly[(win ?? weekWindows[FORECAST_WEEKS - 1]).index] += b.balance;
    }
  }

  return { weekly, overdueTotal, beyondWindowTotal, beyondWindowCount };
}

// Rolls one entity's own starting cash forward across the 12 weeks using its
// own AP/payroll outflow (and, for 'jrb' only, its AR collection forecast —
// other entities pass arForecast: null and get a zero AR-in series). This is
// the exact same recurrence the single-entity version of this report always
// used; multi-entity support runs it once per connected company instead of
// once total. weekStart is kept on every row (not just derivable from the
// index) to match cash_forecast_snapshots.weekly_forecast's documented shape
// (see its migration comment) — other consumers of that column besides this
// file's own two readers may rely on it being present.
function buildEntityRows({ startingCash, apForecast, payrollEstimate, arForecast, weekWindows }) {
  const rows = [];
  let running = startingCash;
  for (let i = 0; i < FORECAST_WEEKS; i++) {
    const arIn = arForecast ? arForecast.weekly[i] : 0;
    const apOut = apForecast.weekly[i];
    const payrollOut = payrollEstimate.weeklyAverage;
    const ending = running + arIn - apOut - payrollOut;
    rows.push({ weekStart: weekWindows[i].startStr, starting: running, arIn, apOut, payrollOut, ending });
    running = ending;
  }
  return rows;
}

// Combined series = the plain per-week sum of every connected+successful
// entity's own independent series. Valid because each entity's recurrence
// never depends on another's (no inter-company cash transfer is modeled) —
// combined[i].ending == sum of each entity's own ending in week i by
// induction, since combined[i].starting is itself the prior week's combined
// ending.
function combineEntityRows(entityRowsList, weekWindows) {
  const rows = [];
  for (let i = 0; i < FORECAST_WEEKS; i++) {
    const week = { weekStart: weekWindows[i].startStr, starting: 0, arIn: 0, apOut: 0, payrollOut: 0, ending: 0 };
    for (const entityRows of entityRowsList) {
      week.starting += entityRows[i].starting;
      week.arIn += entityRows[i].arIn;
      week.apOut += entityRows[i].apOut;
      week.payrollOut += entityRows[i].payrollOut;
      week.ending += entityRows[i].ending;
    }
    rows.push(week);
  }
  return rows;
}

function findLowest(rows) {
  let lowest = rows[0];
  let lowestIndex = 0;
  rows.forEach((r, i) => { if (r.ending < lowest.ending) { lowest = r; lowestIndex = i; } });
  return { ...lowest, index: lowestIndex };
}

// Reads last week's snapshot (if any) so this week can report how the prior
// week's forecast for "this week's starting cash" compared to what actually
// happened — a simple self-check on forecast accuracy over time. Degrades to
// "no comparison yet" rather than failing the report if the table/row isn't
// there (first run, or migration not yet applied).
async function gatherAndRecordSnapshot({ weekStart, startingCash, weeklyRows, lowestWeek, lowestAmount }) {
  let priorComparison = null;
  try {
    const { data: prior, error: priorErr } = await supabase
      .from('cash_forecast_snapshots')
      .select('week_start, weekly_forecast')
      .lt('week_start', weekStart)
      .order('week_start', { ascending: false })
      .limit(1);
    if (priorErr) throw priorErr;
    const priorRow = prior?.[0];
    // Only treat it as "last week's forecast" if it's exactly 7 days prior —
    // the scheduler has a documented history of missed Monday cron ticks
    // elsewhere in this codebase, so a gap (e.g. two skipped Mondays) would
    // otherwise silently diff this week's actual cash against a forecast for
    // a non-adjacent week, mislabeling the comparison as "last week's."
    const isAdjacentWeek = priorRow && addDaysUTC(priorRow.week_start, 7).toISOString().slice(0, 10) === weekStart;
    if (isAdjacentWeek && priorRow.weekly_forecast?.[0]) {
      const predictedEnding = Number(priorRow.weekly_forecast[0].ending ?? NaN);
      if (Number.isFinite(predictedEnding)) {
        priorComparison = { weekStart: priorRow.week_start, predictedEnding, actualStarting: startingCash, variance: startingCash - predictedEnding };
      }
    }

    const { error: upsertErr } = await supabase
      .from('cash_forecast_snapshots')
      .upsert({
        week_start: weekStart,
        starting_cash: startingCash,
        weekly_forecast: weeklyRows,
        lowest_week: lowestWeek,
        lowest_amount: lowestAmount,
      }, { onConflict: 'week_start' });
    if (upsertErr) throw upsertErr;
  } catch (err) {
    logger.warn('cash_forecast_report: snapshot read/write failed — reporting current forecast only', { err: err.message });
  }
  return priorComparison;
}

// Renders one series' (combined or a single entity's) weekly table + lowest-
// point call-out. Shared by the combined headline block and each per-entity
// section so they never drift apart in formatting.
function renderWeeklySeries(rows, weekWindows, lowest) {
  const weekLabel = w => `${fD(w.startStr)}–${fD(new Date(w.end.getTime() - 86400000).toISOString().slice(0, 10))}`;
  let html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;font-size:12px;">
    <tr style="background-color:#f8f8f8;">
      <td style="padding:5px 6px;font-weight:bold;color:#888888;text-transform:uppercase;">Week</td>
      <td style="padding:5px 6px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Start</td>
      <td style="padding:5px 6px;font-weight:bold;color:#1a6e1a;text-align:right;">+AR</td>
      <td style="padding:5px 6px;font-weight:bold;color:#b35900;text-align:right;">-AP</td>
      <td style="padding:5px 6px;font-weight:bold;color:#b35900;text-align:right;">-Payroll</td>
      <td style="padding:5px 6px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">End</td>
    </tr>`;
  rows.forEach((r, i) => {
    const isLowest = i === lowest.index;
    const endColor = r.ending < 0 ? '#c0392b' : (isLowest ? '#b35900' : '#333333');
    html += `<tr style="background-color:${isLowest ? '#fff3cd' : (i % 2 ? '#f8f8f8' : '#ffffff')};">
      <td style="padding:5px 6px;color:#444444;">${weekLabel(weekWindows[i])}</td>
      <td style="padding:5px 6px;text-align:right;color:#555555;">${f$(r.starting)}</td>
      <td style="padding:5px 6px;text-align:right;color:#1a6e1a;">+${f$(r.arIn)}</td>
      <td style="padding:5px 6px;text-align:right;color:#b35900;">-${f$(r.apOut)}</td>
      <td style="padding:5px 6px;text-align:right;color:#b35900;">-${f$(r.payrollOut)}</td>
      <td style="padding:5px 6px;text-align:right;font-weight:bold;color:${endColor};">${f$(r.ending)}${isLowest ? ' &#9660;' : ''}</td>
    </tr>`;
  });
  html += `</table>`;
  html += `<p style="margin:0 0 20px;font-size:11px;color:#888888;">&#9660; = lowest projected point over the 12 weeks.</p>`;

  const lowColor = lowest.ending < 0 ? '#c0392b' : (lowest.ending < LOW_CASH_WARN_THRESHOLD ? '#e6a817' : '#1a6e1a');
  const lowBg = lowest.ending < 0 ? '#fff0f0' : (lowest.ending < LOW_CASH_WARN_THRESHOLD ? '#fff3cd' : '#f0fff4');
  html += alertBox(lowBg, lowColor, 'Lowest Projected Point', `
    <p style="margin:0;font-size:14px;font-weight:bold;color:${lowColor};">${f$(lowest.ending)} — week of ${fD(weekWindows[lowest.index].startStr)}</p>
    <p style="margin:6px 0 0;font-size:12px;color:#333333;">${lowest.ending < 0
      ? 'Projected to go negative — this is the estimate crossing zero, not a certainty; treat as an early warning to plan around, not a bank prediction.'
      : lowest.ending < LOW_CASH_WARN_THRESHOLD
        ? `Stays positive but thin (below the ${f$(LOW_CASH_WARN_THRESHOLD)} line used for this report's own color-coding — not a target Michael has set).`
        : 'Stays comfortably positive across the full 12-week window under these assumptions.'}</p>`);
  return html;
}

function renderApDetail(apForecast, apBills) {
  let html = sectionHeader(`Open Bills Feeding This Forecast (${apBills.length})`);
  if (apForecast.overdueTotal > 0) {
    const oldestOverdueDays = apBills.reduce((max, b) => (b.ageDays > max ? b.ageDays : max), 0);
    html += `<p style="margin:0 0 8px;font-size:12px;color:#c0392b;"><b>${f$(apForecast.overdueTotal)}</b> already overdue — folded into this week's AP (oldest: ${oldestOverdueDays}d past due).</p>`;
  }
  html += `<p style="margin:0 0 16px;font-size:11px;color:#888888;">Source: QuickBooks open Bills (Balance &gt; 0), bucketed by due date.${apForecast.beyondWindowCount ? ` ${apForecast.beyondWindowCount} open bill(s) totaling ${f$(apForecast.beyondWindowTotal)} are due beyond this 12-week window and are excluded.` : ''}</p>`;
  return html;
}

function buildEmail({ weekStart, weekWindows, combinedRows, combinedLowest, entities, cashAccounts, payrollEstimate, freshness, priorComparison, totalFailure }) {
  const ok = entities.filter(e => e.connected && !e.error);
  const entityList = ok.map(e => e.label).join(', ');
  const anyConnected = entities.some(e => e.connected);

  let html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>12-Week Cash Forecast ${weekStart}</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" style="max-width:680px;background-color:#ffffff;border-radius:6px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

<!-- HEADER -->
<tr><td style="background-color:#1a1a2e;padding:24px 32px;">
  <p style="margin:0;color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:0.5px;">JRB Group</p>
  <p style="margin:4px 0 0;color:#aaaacc;font-size:13px;">12-Week Cash Forecast &nbsp;|&nbsp; Week of ${fD(weekStart)}</p>
</td></tr>

<!-- BODY -->
<tr><td style="padding:28px 32px;">`;

  if (freshness?.stale) {
    html += alertBox('#fff8f0', '#e6a817', `SA Data May Be Stale (${freshness.ageHours}h Since Last Sync)`,
      `<p style="margin:0;font-size:13px;color:#533f03;">AR collections figures below may not reflect the most recent invoices/payments.</p>`);
  }

  if (totalFailure) {
    // No company produced usable forecast data this run (either none are
    // authorized yet, or a connected company's live query failed) —
    // combinedRows would otherwise be an all-zero series (see
    // combineEntityRows([])), which would misleadingly read as "$0 low
    // point, totally healthy" rather than "couldn't fetch any data."
    html += alertBox('#fff0f0', '#c0392b', 'Cash Forecast Unavailable This Run', `
      <p style="margin:0;font-size:13px;color:#7a1f1f;">No cash/AP/payroll data could be fetched from any QuickBooks entity this run — no forecast is shown below because none could be computed, not because cash is actually $0. This means either no entity is authorized yet, or a connected entity's live query failed — check QuickBooks connectivity/authorization or wait for next Monday's run.</p>`);
  }

  // ── This is an estimate ──────────────────────────────────────────────────
  html += alertBox('#f0f4ff', '#1a1a2e', 'This Is An Estimate, Not A Guarantee', `
    <p style="margin:0 0 6px;font-size:12px;color:#333333;">Every figure below rests on a documented assumption. Read these before trusting a number:</p>
    <ul style="margin:0;padding-left:18px;font-size:12px;color:#333333;line-height:1.6;">
      <li><b>Entities included:</b> ${entityList || (anyConnected ? 'none — every connected entity failed to fetch this run' : 'none — no entity connected')}. Each entity has its own bank accounts and its own AP/payroll — nothing here models moving cash between them, so a "combined" number can look fine even while one entity alone is thin or negative (see that entity's own section below).</li>
      <li><b>Starting cash</b> (per entity) = sum of that entity's QuickBooks bank account balances as of the most recent QuickBooks read (may be up to ~1hr cached, not the current second). Not a full balance-sheet reconciliation (outstanding checks, undeposited funds, etc. are not adjusted for). Example — J.R. Boehlke, LLC's own accounts: ${cashAccounts.length ? cashAccounts.map(a => `${a.name}: ${f$(a.balance)}`).join(', ') : 'unavailable this run'}. Each other entity's own accounts are shown in its own section below; nothing on this line is a group total.</li>
      <li><b>AR collections</b> only applies to J.R. Boehlke, LLC — JRB Transport LLC and JRB Granville Propco have no A/R tracked in Service Autopilot, so their forecasts carry $0 AR-in every week. J.R. Boehlke's forecast projects ONLY today's already-outstanding AR — it does NOT project new sales/invoicing that will happen during these 12 weeks. Heuristic: ${Math.round(CURRENT_D30_NEAR_TERM_PCT * 100)}% of the Current + 1-30d balance is assumed to collect within the first ${CURRENT_D30_NEAR_TERM_WEEKS} weeks, the remainder over the following ${CURRENT_D30_REMAINDER_WEEKS} weeks; only ${Math.round(D60_COLLECTION_PCT * 100)}% of the 31-60d bucket and ${Math.round(D90PLUS_COLLECTION_PCT * 100)}% of 61d+ is assumed to ever convert to cash in this window.</li>
      <li><b>AP due</b> (per entity) = that entity's bills currently entered as open Bills in QuickBooks, bucketed by due date. Anything not yet entered as a Bill (e.g. a cash purchase, a subscription charged directly to a card) is not captured here.</li>
      <li><b>Payroll</b> (per entity) = the trailing ${payrollEstimate.lookbackWeeks}-week average of that entity's actual "Payroll Payable" cash postings in QuickBooks — a smoothed average, NOT a real ADP pay calendar (this integration doesn't have QuickBooks Payroll API access, only the regular Accounting API). Applied flat to every week. Employer payroll taxes/ADP fees/benefits are excluded (posted to separate accounts; captured via the AP line only if they're billed as a vendor Bill).</li>
    </ul>`);

  // ── Combined headline ─────────────────────────────────────────────────────
  html += sectionHeader('Combined 12-Week Projection (All Entities)');
  if (totalFailure) {
    html += `<p style="margin:0 0 16px;font-size:13px;color:#888888;font-style:italic;">Not shown — see the failure notice above.</p>`;
  } else {
    html += renderWeeklySeries(combinedRows, weekWindows, combinedLowest);
  }

  // ── Forecast accuracy vs last week (combined only) ───────────────────────
  if (totalFailure) {
    // Intentionally not rendered — no combined series was computed this run.
  } else if (priorComparison) {
    const variance = priorComparison.variance;
    const color = Math.abs(variance) > LOW_CASH_WARN_THRESHOLD ? '#c0392b' : '#888888';
    html += sectionHeader(`Last Week's Combined Forecast vs. Reality`);
    html += `<p style="margin:0 0 16px;font-size:12px;color:#333333;">Last week's forecast (${fD(priorComparison.weekStart)}) projected this week's combined starting cash at ${f$(priorComparison.predictedEnding)}. Actual: ${f$(priorComparison.actualStarting)}. <span style="color:${color};font-weight:bold;">Variance: ${variance >= 0 ? '+' : ''}${f$(variance)}</span>.</p>`;
  } else {
    html += `<p style="margin:0 0 16px;font-size:11px;color:#aaaaaa;font-style:italic;">Forecast-accuracy trend available starting next week (no prior snapshot yet).</p>`;
  }

  // ── Per-entity sections ───────────────────────────────────────────────────
  for (const e of entities) {
    if (!e.connected) continue; // never OAuth-authorized yet — nothing to show
    html += entityDivider(e.label);
    if (e.error) {
      html += `<p style="margin:8px 0 16px;font-size:13px;color:#c0392b;">Cash forecast unavailable for ${e.label}: ${e.error}</p>`;
      continue;
    }
    html += renderWeeklySeries(e.rows, weekWindows, e.lowest);
    html += renderApDetail(e.apForecast, e.apBills);
  }

  html += `<p style="margin:24px 0 0;font-size:11px;color:#aaaaaa;font-style:italic;">Not yet included: a sales/pipeline forecast for new revenue during this window, and full employer payroll tax/benefit cash timing beyond what's captured in open Bills.</p>`;

  html += `
</td></tr>
</table></td></tr></table>
</body></html>`;

  return html;
}

// Gathers every configured company's own raw cash/AP/payroll data via
// qb-token.js's shared gatherAcrossCompanies. Deliberately does NOT build the
// forecast rows yet (that needs arForecast, computed from a separate SA/
// Supabase fetch) — kept as a separate step (see applyArForecast below) so
// the caller can run this QBO-heavy gather concurrently with the SA gather
// instead of serializing one behind the other.
async function gatherAllCompanyRawData(weekWindows) {
  return gatherAcrossCompanies(async company => {
    const [cashBalance, apBills, payrollEstimate] = await Promise.all([
      getCashBalance(company),
      getOpenBillsForForecast(company),
      getPayrollCashOutflowEstimate({ lookbackDays: PAYROLL_LOOKBACK_DAYS, company }),
    ]);
    return { cashBalance, apBills, payrollEstimate, apForecast: buildAPForecast(apBills, weekWindows) };
  });
}

// Builds each company's forecast rows once arForecast is available. AR
// collection forecasting only exists for 'jrb' (SA doesn't track other
// entities' customers) — every other company gets a $0 AR-in series. Pure/
// synchronous — no additional latency, so splitting this out of the gather
// above costs nothing while letting the QBO and SA fetches overlap.
function applyArForecast(rawEntities, arForecast, weekWindows) {
  return rawEntities.map(e => {
    if (!e.connected || e.error) return e; // nothing to build rows from
    const rows = buildEntityRows({ startingCash: e.cashBalance.total, apForecast: e.apForecast, payrollEstimate: e.payrollEstimate, arForecast: e.company === 'jrb' ? arForecast : null, weekWindows });
    return { ...e, rows, lowest: findLowest(rows) };
  });
}

export async function generateAndSendCashForecastReport() {
  const weekStart = mondayOf();
  const weekWindows = buildWeekWindows(weekStart);

  // SA/Supabase AR gather and the (now up to 3x larger, one per entity) QBO
  // gather run concurrently — arForecast is only needed for the pure/
  // synchronous row-building step after both finish, not before.
  const [arAging, freshness, rawEntities] = await Promise.all([
    gatherSAARaging(),
    gatherSAFreshness({ staleHours: STALE_DATA_HOURS }),
    gatherAllCompanyRawData(weekWindows),
  ]);
  const arForecast = buildARCollectionForecast(arAging);
  const entities = applyArForecast(rawEntities, arForecast, weekWindows);

  const ok = entities.filter(e => e.rows);
  // Unconditional on ok.length, NOT gated on "is any company marked
  // connected" — a full Credential Manager wipe (has happened before on this
  // project) could plausibly leave zero companies looking "connected" too,
  // and either way there's no real data to build a series from. See
  // buildEmail's totalFailure branch for what this prevents: a fabricated
  // all-zero forecast reading as "healthy" instead of "couldn't fetch."
  const totalFailure = ok.length === 0;

  const combinedRows = totalFailure ? null : combineEntityRows(ok.map(e => e.rows), weekWindows);
  const combinedLowest = totalFailure ? null : findLowest(combinedRows);

  // Legacy per-JRB fields kept for the "starting cash" line in the assumptions
  // block above and the snapshot self-check below — both predate multi-entity
  // and are scoped to J.R. Boehlke specifically, not the combined total.
  const jrb = ok.find(e => e.company === 'jrb');
  const cashAccounts = jrb?.cashBalance.accounts ?? [];
  const payrollEstimate = jrb?.payrollEstimate ?? { lookbackWeeks: PAYROLL_LOOKBACK_DAYS / 7 };

  // Note: cash_forecast_snapshots previously stored a JRB-only forecast; from
  // this deploy forward it stores the combined (all-entities) forecast under
  // the same columns. The very first post-deploy run will diff this week's
  // real combined starting cash against LAST week's JRB-only prediction — a
  // one-time, self-correcting mismatch in the "vs. Reality" comparison, not a
  // bug. Every run after that compares combined-vs-combined correctly. On a
  // total-failure run, the snapshot write is skipped entirely — writing a
  // fabricated $0 forecast would corrupt next week's own vs-reality check.
  const priorComparison = totalFailure ? null : await gatherAndRecordSnapshot({
    weekStart,
    startingCash: combinedRows[0].starting,
    weeklyRows: combinedRows,
    lowestWeek: weekWindows[combinedLowest.index].startStr,
    lowestAmount: combinedLowest.ending,
  });

  const body = buildEmail({
    weekStart, weekWindows, combinedRows, combinedLowest, entities, cashAccounts, payrollEstimate, freshness, priorComparison, totalFailure,
  });

  await sendEmail({
    to: ['michael@jrboehlke.com'],
    subject: totalFailure
      ? `12-Week Cash Forecast — Week of ${fD(weekStart)} | data unavailable`
      : `12-Week Cash Forecast — Week of ${fD(weekStart)} | Low point ${f$(combinedLowest.ending)}`,
    body,
  });

  const perCompany = Object.fromEntries(entities.map(e => [e.company, {
    connected: e.connected,
    error: e.error ?? null,
    lowestEnding: e.lowest?.ending ?? null,
  }]));
  const combinedLowestWeek = totalFailure ? null : weekWindows[combinedLowest.index].startStr;

  logger.info('cash_forecast_report: sent', {
    weekStart,
    totalFailure,
    combinedStartingCash: totalFailure ? null : combinedRows[0].starting,
    combinedLowestEnding: totalFailure ? null : combinedLowest.ending,
    combinedLowestWeek,
    perCompany,
  });
  return {
    weekStart,
    startingCash: totalFailure ? null : combinedRows[0].starting,
    lowestEnding: totalFailure ? null : combinedLowest.ending,
    lowestWeek: combinedLowestWeek,
    perCompany,
  };
}
