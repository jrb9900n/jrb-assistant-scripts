// tools/impl/weekly-scorecard-report.js
// Weekly Business Scorecard — Friday 2:45 PM, ahead of the 3:00-4:30 PM
// "Weekly Review / Next Week Prep" calendar block. A one-page "how did this
// week go, what's next week look like" roll-up: cash position, AR/AP
// snapshot, marketing/sales KPIs, estimating pipeline status, and crew load
// for next week.
//
// This is a SYNTHESIS report, not a new data pipeline. Eight other reports
// already gather and format this business's data (AR/Collections, AP,
// 12-Week Cash Forecast, Marketing Performance, Sales Pipeline/BD,
// Estimating Pipeline, Field/Client Meetings Briefing) plus the pre-existing
// Sunday 6 AM Weekly Finance Report. Rather than re-deriving any of that:
//   - Cash: multi-entity (added 2026-08-21) — gatherCashAndApByCompany()
//     calls quickbooks.js's getCashBalance() per configured QB company (see
//     qb-token.js's listQBCompanies()) via the shared gatherAcrossCompanies
//     helper, combined into one group total; JRB Transport LLC and JRB
//     Granville Propco's own accounts are broken out in their own sections.
//     Also reads cash-forecast-report.js's own cash_forecast_snapshots row
//     (written every Monday, itself combined-all-entities) for a one-line
//     "next week's projected cash" pointer instead of recomputing the
//     12-week heuristic model.
//   - AR / AP: AR reuses ar-report-helpers.js's gatherSAARaging() — J.R.
//     Boehlke only, since Service Autopilot doesn't track the other
//     entities' customers (confirmed by Michael, they have no A/R at all).
//     AP is multi-entity like Cash above (same gatherCashAndApByCompany()
//     call, since QBO's own API happens to serve both cheaply together) —
//     shown per-entity + combined; the "Net (AR-AP)" figure stays JRB-vs-JRB
//     only, since blending J.R. Boehlke's receivables against the whole
//     group's payables would fabricate a working-capital number no single
//     entity actually has.
//   - Marketing / Sales KPIs: marketing-performance-report.js and
//     sales-pipeline-report.js only export their top-level `generateAndSend*`
//     functions (their gather/compute helpers are internal, entangled with
//     their own email building) — rather than force a refactor of two
//     already-merged reports, this reads the latest row each already writes
//     to its own trend-snapshot table (marketing_performance_snapshots,
//     sales_pipeline_snapshots) every week. Labeled with the snapshot's own
//     week_start so staleness is honest, not hidden.
//   - Estimating pipeline: same reasoning — estimating-pipeline-report.js's
//     helpers are internal, so this runs one small independent query against
//     sa_estimates_2026 for just the backlog count/value/oldest-waiting
//     summary, using the same TEST_CLIENT_IDS/EXCLUDED_STAGE_NAMES exclusion
//     convention already duplicated locally across the other pipeline
//     reports (they intentionally don't import from each other's files —
//     see sales-pipeline-report.js's header comment).
//   - Crew capacity for next week: NEW ground — no other report computes
//     this. Uses tools/impl/scheduling.js's getCrews() (active crew roster)
//     and direct sa_jobs / sa_waiting_list queries (same tables/fields
//     overnight-report.js's "Today's Dispatch" / "Waiting List by Crew"
//     sections already use) for real scheduled-job counts next week, grouped
//     by crew. Deliberately NOT a computed utilization percentage: crews.
//     daily_capacity exists in the schema but its unit/meaning has never
//     been confirmed anywhere in this codebase (no doc, no comment, no
//     consuming code treats it as hours vs. jobs vs. anything else) — see
//     the "Crew Capacity" section's own gap note. Showing scheduled job
//     counts against an unconfirmed capacity number would be a fabricated
//     metric, which this report explicitly avoids per its build brief.
//
// Deliberately NOT duplicated: weekly-finance-report.js's Sunday-morning
// audit content (payment-level revenue detail, reconciliation/AME
// discrepancies, credit card expense detail, unrecorded-payment matching).
// This is a different day (Friday) and a different frame (forward-looking
// week wrap + next-week prep), not a second financial audit.

import { logger } from '../../core/logger.js';
import { sendEmail } from './m365.js';
import { supabase, gatherSAARaging, gatherSAFreshness, mondayOf, addDaysUTC, daysBetween, f$, fD, sectionHeader, alertBox, entityDivider } from './ar-report-helpers.js';
import { getCashBalance, getAPAgingReport } from './quickbooks.js';
import { gatherAcrossCompanies, summarizeAcrossCompanies } from './qb-token.js';
import { getCrews } from './scheduling.js';

const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';

// Same known non-production test accounts excluded by estimating-pipeline-report.js
// and sales-pipeline-report.js — duplicated locally rather than imported, per
// this codebase's established convention of not depending on each other's
// pipeline-report internals (see file header + sales-pipeline-report.js's
// own comment on why). NOTE: this is now the third copy of this same
// constant pair across the codebase (estimating-pipeline-report.js,
// sales-pipeline-report.js, here) — a real duplication smell, but
// consolidating it means touching two already-merged files, out of scope
// for this change; worth a dedicated cleanup pass extracting it to
// ar-report-helpers.js alongside TEST_CLIENT_IDS's sibling helpers.
const TEST_CLIENT_IDS = [
  'e2a7420a-930c-4908-90aa-67ba158e0921', // APIProbe, JRBTest
  '3ed0d43d-9865-439a-875d-eda0afb7930c', // Test, Test
];
const EXCLUDED_STAGE_NAMES = ['Test Stage'];

const STALE_SA_HOURS = 24;
const STALE_ESTIMATES_HOURS = 24 * 8; // sa_estimates_2026 only re-syncs weekly (BTA Sunday pipeline)
const CREW_JOBS_MAX_ROWS = 12;
// Headroom above sa_estimates_2026's live row count (~1,000 as of this
// writing per estimating-pipeline-report.js's own comment) — explicit
// .range() + an order clause, not a bare default page size, per the same
// silent-truncation defect class CLAUDE.md documents for getClientsByTag's
// default max (SA Client Categorization section): a truncated, UNORDERED
// page would otherwise silently drop an arbitrary subset of the backlog
// with zero warning.
const ESTIMATES_QUERY_MAX_ROWS = 5000;

function isRealAccount(row) {
  return !TEST_CLIENT_IDS.includes(row.client_id) && !EXCLUDED_STAGE_NAMES.includes(row.stage_name);
}

// ── Estimating pipeline: small independent summary query ───────────────────
// Deliberately not the full estimating-pipeline-report.js output (per-
// estimator breakdown, aging buckets, win/loss) — just the backlog headline
// numbers this scorecard needs. See file header for why this isn't imported.
async function gatherEstimatingSnapshot() {
  const { data, error } = await supabase
    .from('sa_estimates_2026')
    .select('estimate_id, client_id, stage, stage_name, estimated_value, quote_date, created_date, sent_date, extracted_at')
    .in('stage', ['Draft', 'Sent'])
    .order('quote_date', { ascending: true })
    .range(0, ESTIMATES_QUERY_MAX_ROWS - 1);

  if (error) {
    logger.warn('weekly_scorecard_report: sa_estimates_2026 query failed', { err: error.message });
    return { available: false, count: 0, value: 0, oldestWaitingDays: null, freshness: { stale: true, ageHours: 999 } };
  }

  if ((data ?? []).length === ESTIMATES_QUERY_MAX_ROWS) {
    // Hit the cap — same visible-rather-than-silent-truncation convention as
    // field-briefing-report.js's CANDIDATE_SEARCH_LIMIT warning.
    logger.warn('weekly_scorecard_report: sa_estimates_2026 query hit ESTIMATES_QUERY_MAX_ROWS — backlog figures may be incomplete', { max: ESTIMATES_QUERY_MAX_ROWS });
  }

  const rows = (data ?? []).filter(isRealAccount);
  const withAge = rows.map(r => {
    const waitingSince = r.stage === 'Sent' ? (r.sent_date ?? r.quote_date ?? r.created_date) : (r.quote_date ?? r.created_date);
    return { ...r, ageDays: daysBetween(waitingSince) ?? 0 };
  });

  const count = withAge.length;
  const value = withAge.reduce((s, r) => s + Number(r.estimated_value ?? 0), 0);
  const oldestWaitingDays = withAge.length ? Math.max(...withAge.map(r => r.ageDays)) : null;

  // A zero-length backlog (everything currently Won/Lost, nothing Draft/
  // Sent) is a legitimate, good business state, not evidence of a stale
  // sync — there's no Draft/Sent row's extracted_at to check freshness
  // against at all. Distinguishing "nothing to report" from "haven't heard
  // from the sync in a while" avoids a false "Estimate Data May Be Stale
  // (999h)" banner on a week with a genuinely empty backlog.
  let freshness;
  if (withAge.length === 0) {
    freshness = { stale: false, ageHours: null };
  } else {
    const latestExtractedAt = withAge.reduce((max, r) => {
      const t = r.extracted_at ? new Date(r.extracted_at).getTime() : 0;
      return t > max ? t : max;
    }, 0);
    const ageHours = latestExtractedAt ? Math.round((Date.now() - latestExtractedAt) / 3600000) : 999;
    freshness = { stale: ageHours > STALE_ESTIMATES_HOURS, ageHours };
  }

  return { available: true, count, value, oldestWaitingDays, freshness };
}

// ── Marketing / Sales: read the latest row each report already wrote ───────
// Both tables are populated weekly by their own reports (Monday morning) —
// this deliberately reads rather than recomputes (see file header).
async function gatherLatestMarketingSnapshot() {
  try {
    const { data, error } = await supabase
      .from('marketing_performance_snapshots')
      .select('week_start, total_spend, conversions, cost_per_lead, won_job_count, won_revenue, cost_per_won_job')
      .order('week_start', { ascending: false })
      .limit(1);
    if (error) throw error;
    return data?.[0] ?? null;
  } catch (err) {
    logger.warn('weekly_scorecard_report: marketing_performance_snapshots read failed', { err: err.message });
    return null;
  }
}

async function gatherLatestSalesPipelineSnapshot() {
  try {
    const { data, error } = await supabase
      .from('sales_pipeline_snapshots')
      .select('week_start, open_pipeline_value, open_pipeline_count, win_rate, avg_deal_size')
      .order('week_start', { ascending: false })
      .limit(1);
    if (error) throw error;
    return data?.[0] ?? null;
  } catch (err) {
    logger.warn('weekly_scorecard_report: sales_pipeline_snapshots read failed', { err: err.message });
    return null;
  }
}

// ── Cash / AP: multi-entity (added 2026-08-21) ──────────────────────────────
// Confirmed by Michael — JRB Transport LLC and JRB Granville Propco have no
// A/R or commissions of their own, but their cash position and AP should
// still appear here. Both gathers loop over every configured QB company
// (tools/impl/qb-token.js's listQBCompanies()); a company never OAuth-
// authorized yet is silently omitted (not an error), one whose live query
// fails is flagged with `error` rather than silently dropped from totals.
// Combined into one gatherAcrossCompanies pass (not two separate ones) so
// each company's realm-ID/not-connected check — including the blocking
// meta-file read getQBRealmId() falls back to for a not-yet-restarted
// process, see qb-token.js — only happens once per company per run, and so
// cash/AP for a given company always land in the same result object.
async function gatherCashAndApByCompany() {
  return gatherAcrossCompanies(async company => {
    const [{ total: cashTotal, accounts }, { total: apTotal }] = await Promise.all([
      getCashBalance(company),
      getAPAgingReport(company),
    ]);
    return { cashTotal, accounts, apTotal };
  });
}

// ── Cash: pointer to next week's already-computed forecast ─────────────────
// cash_forecast_snapshots is written every Monday by cash-forecast-report.js
// with week_start = that Monday and weekly_forecast[i] = the i-th forecast
// week starting from week_start (i=0 is the current week, i=1 is next week).
// Reading index 1 off THIS week's row avoids recomputing the 12-week
// AR-collection/AP/payroll heuristic model here. Only used if the row's
// week_start matches the current week — an older/missing row degrades to
// "not available" rather than showing a stale or mismatched projection.
async function gatherNextWeekCashForecast(weekStart) {
  try {
    const { data, error } = await supabase
      .from('cash_forecast_snapshots')
      .select('week_start, weekly_forecast')
      .eq('week_start', weekStart)
      .limit(1);
    if (error) throw error;
    const row = data?.[0];
    const nextWeek = row?.weekly_forecast?.[1];
    const starting = Number(nextWeek?.starting);
    const ending = Number(nextWeek?.ending);
    // Both fields must be finite, not just `ending` — a malformed/partial
    // snapshot row with a valid ending but a null/NaN starting would
    // otherwise pass through f$()'s `Number(n||0)` coercion downstream and
    // render as a fabricated "starting ~$0.00" instead of the honest
    // "not available" fallback.
    if (!nextWeek || !Number.isFinite(starting) || !Number.isFinite(ending)) return null;
    return { starting, ending };
  } catch (err) {
    logger.warn('weekly_scorecard_report: cash_forecast_snapshots read failed', { err: err.message });
    return null;
  }
}

// ── Crew capacity for next week (new ground, see file header) ──────────────
// sa_jobs = already-dispatched jobs (real scheduled work); sa_waiting_list
// entries with a target_date next week AND an assigned crew = demand that
// still needs to be put on the board. The waiting-list query filters on
// status ['6','7','1'] — the exact same status-code set tools/impl/
// scheduling.js's getWaitingList() already uses to mean "still on the
// waiting list" — rather than cross-referencing sa_jobs directly (no
// waiting-list-row -> job-row foreign key is exposed anywhere in this
// codebase to join on). SA transitions a row's status once it's dispatched,
// so this status filter is this codebase's own established idiom for "not
// yet dispatched," matching getWaitingList()'s convention.
// Both grouped by the crew name/GUID recorded directly on each row (`assigned`)
// — same field overnight-report.js's "Today's Dispatch"/"Waiting List by
// Crew" sections already group by. Deliberately NOT joined against
// getCrews()'s roster to label a crew "idle" — that would require a
// confirmed 1:1 match between sa_jobs.assigned's free text and crews.name/
// display_name that hasn't been verified anywhere in this codebase; a wrong
// match would fabricate an idle/overloaded claim. The active crew roster is
// shown as its own reference list instead.
async function gatherCrewCapacityNextWeek(nextMonday, nextSunday) {
  let crewsFetchFailed = false;
  const [jobsRes, wlRes, crewsRes] = await Promise.all([
    supabase.from('sa_jobs').select('id, client, assigned, amount, start_date')
      .gte('start_date', nextMonday).lte('start_date', nextSunday),
    supabase.from('sa_waiting_list').select('job_id, client_name, assigned, amount, target_date, status')
      .gte('target_date', nextMonday).lte('target_date', nextSunday)
      .in('status', ['6', '7', '1'])
      .not('assigned', 'is', null).neq('assigned', '').neq('assigned', EMPTY_GUID),
    getCrews().catch(err => {
      logger.warn('weekly_scorecard_report: getCrews failed', { err: err.message });
      crewsFetchFailed = true;
      return [];
    }),
  ]);

  if (jobsRes.error) logger.warn('weekly_scorecard_report: sa_jobs next-week query failed', { err: jobsRes.error.message });
  if (wlRes.error) logger.warn('weekly_scorecard_report: sa_waiting_list next-week query failed', { err: wlRes.error.message });

  // Dedupe sa_jobs by id — same sync-overlap defensive pattern as
  // overnight-report.js's getTodayJobs().
  const seen = new Set();
  const jobs = (jobsRes.data ?? []).filter(r => {
    if (!r.id || seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  const scheduledByCrew = {};
  for (const j of jobs) {
    const crew = j.assigned || 'Unassigned';
    if (!scheduledByCrew[crew]) scheduledByCrew[crew] = { count: 0, value: 0 };
    scheduledByCrew[crew].count += 1;
    scheduledByCrew[crew].value += Number(j.amount ?? 0);
  }

  const unscheduledByCrew = {};
  for (const w of (wlRes.data ?? [])) {
    const crew = w.assigned || 'Unassigned';
    if (!unscheduledByCrew[crew]) unscheduledByCrew[crew] = { count: 0, value: 0 };
    unscheduledByCrew[crew].count += 1;
    unscheduledByCrew[crew].value += Number(w.amount ?? 0);
  }

  const scheduledRows = Object.entries(scheduledByCrew).sort((a, b) => b[1].count - a[1].count);
  const unscheduledRows = Object.entries(unscheduledByCrew).sort((a, b) => b[1].count - a[1].count);

  return {
    scheduledRows,
    unscheduledRows,
    scheduledTotalCount: jobs.length,
    scheduledTotalValue: jobs.reduce((s, j) => s + Number(j.amount ?? 0), 0),
    unscheduledTotalCount: (wlRes.data ?? []).length,
    activeCrews: crewsRes,
    crewsFetchFailed,
  };
}

// ── Email ────────────────────────────────────────────────────────────────────

function statTile(value, label, color = '#1a1a2e') {
  return `<td style="padding:14px 10px;text-align:center;border-right:1px solid #d8e0f0;">
    <p style="margin:0;font-size:18px;font-weight:bold;color:${color};">${value}</p>
    <p style="margin:2px 0 0;font-size:10px;color:#555577;text-transform:uppercase;letter-spacing:0.5px;">${label}</p>
  </td>`;
}

function crewTableHtml(rows, valueLabel) {
  if (!rows.length) return `<p style="margin:0 0 12px;font-size:13px;color:#888888;font-style:italic;">None.</p>`;
  const capped = rows.slice(0, CREW_JOBS_MAX_ROWS);
  let html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:6px;">
  <tr style="background-color:#f8f8f8;">
    <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;">Crew</td>
    <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Jobs</td>
    <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">${valueLabel}</td>
  </tr>`;
  capped.forEach(([crew, info], i) => {
    html += `<tr style="background-color:${i % 2 ? '#f8f8f8' : '#ffffff'};">
      <td style="padding:6px 6px;font-size:13px;color:#333333;">${crew}</td>
      <td style="padding:6px 6px;font-size:13px;color:#444444;text-align:right;">${info.count}</td>
      <td style="padding:6px 6px;font-size:13px;font-weight:bold;color:#1a1a2e;text-align:right;white-space:nowrap;">${f$(info.value)}</td>
    </tr>`;
  });
  html += `</table>`;
  if (rows.length > capped.length) {
    html += `<p style="margin:0 0 12px;font-size:11px;color:#aaaaaa;font-style:italic;">+ ${rows.length - capped.length} more crew${rows.length - capped.length === 1 ? '' : 's'} not shown.</p>`;
  }
  return html;
}

function buildEmail({ weekStart, nextMonday, nextSunday, cashByCompany, apByCompany, cashOk, apOk, combinedCash, cashAvailable, combinedAp, apAvailable, jrbAp, jrbApAvailable, net, nextWeekCash, arAging, arFlaggedCount, marketing, sales, estimating, crew, freshness, isDelayedRun }) {
  // arAging.available is false only when gatherSAARaging()'s own Supabase
  // query failed (see ar-report-helpers.js) — its total:0 default in that
  // case is a query-failure sentinel, not a real zero AR balance, so it must
  // not be rendered as one.
  const arAvailable = arAging.available !== false;
  const arTotal = arAvailable ? arAging.total : null;

  // Partial-failure detection: cashAvailable/apAvailable only require ONE
  // company to have succeeded, so a combined total can silently exclude a
  // failed entity (e.g. JRB itself) with no visible caveat at the headline —
  // flagged explicitly here rather than presenting a partial sum as if it
  // were the real group total. Uses the SAME `cashOk`/`apOk` arrays
  // summarizeAcrossCompanies() already computed for combinedCash/combinedAp
  // (passed in, not re-derived) — a local re-filter here previously used a
  // looser `connected && !error` check missing summarizeAcrossCompanies'
  // Number.isFinite guard, so a company returning a non-numeric total (e.g.
  // a malformed QBO response) could silently count as "ok" here while
  // already being excluded from the actual combined sum, hiding a real
  // partial-failure from the caveat banner.
  const cashPartial = cashAvailable && cashOk.length < cashByCompany.filter(c => c.connected).length;
  const apPartial = apAvailable && apOk.length < apByCompany.filter(c => c.connected).length;

  let html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Weekly Business Scorecard ${weekStart}</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" style="max-width:660px;background-color:#ffffff;border-radius:6px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

<!-- HEADER -->
<tr><td style="background-color:#1a1a2e;padding:24px 32px;">
  <p style="margin:0;color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:0.5px;">JRB Group</p>
  <p style="margin:4px 0 0;color:#aaaacc;font-size:13px;">Weekly Business Scorecard &nbsp;|&nbsp; Week of ${fD(weekStart)} &nbsp;|&nbsp; ahead of the 3:00-4:30 PM Weekly Review / Next Week Prep block</p>
</td></tr>

<!-- BODY -->
<tr><td style="padding:28px 32px;">`;

  if (isDelayedRun) {
    html += alertBox('#fff3cd', '#e6a817', 'Delayed / Recovered Run',
      `<p style="margin:0;font-size:13px;color:#533f03;">This report was scheduled for Friday 2:45 PM but ran late (recovered a missed execution). "Week of ${fD(weekStart)}" and "next week" below are relative to today, not the original Friday — figures may reflect a different week than intended if this ran into a new week.</p>`);
  }

  if (freshness?.stale) {
    // gatherSAFreshness() only inspects sa_invoices.synced_at — it says
    // nothing about sa_jobs/sa_waiting_list (the crew section's source,
    // which has no freshness check of its own — an honest gap, not fixed
    // here) or sa_estimates_2026 (the estimating section already shows its
    // own, separately-computed staleness banner below). Scoping this
    // banner's claim to AR only avoids both a false "crew may be stale"
    // warning when sa_invoices lags but sa_jobs is fine, and a misleading
    // implied "estimating is covered by this check too" when it isn't.
    html += alertBox('#fff8f0', '#e6a817', `SA Invoice Data May Be Stale (${freshness.ageHours}h Since Last Sync)`,
      `<p style="margin:0;font-size:13px;color:#533f03;">AR figures below may not reflect the most recent invoices. (Crew and estimating data are synced separately — see their own sections for estimating's staleness check; no equivalent check exists yet for crew/job data.)</p>`);
  }

  // ── Top KPI bar ────────────────────────────────────────────────────────────
  html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eef1fa;border-radius:4px;margin-bottom:20px;"><tr>
  ${statTile(cashAvailable ? f$(combinedCash) : '&mdash;', cashPartial ? 'Cash On Hand (Partial — see below)' : 'Cash On Hand (All Entities)', '#1a6e1a')}
  ${statTile(net !== null ? f$(net) : '&mdash;', 'JRB AR &minus; AP', net !== null && net >= 0 ? '#1a6e1a' : net !== null ? '#c0392b' : '#1a1a2e')}
  ${statTile(sales ? f$(sales.open_pipeline_value) : '&mdash;', 'Open Sales Pipeline')}
  ${statTile(estimating.available ? f$(estimating.value) : '&mdash;', 'Estimating Backlog', '#b35900')}
</tr></table>`;

  // ── Section: Cash Position ──────────────────────────────────────────────────
  // Multi-entity: JRB Transport LLC and JRB Granville Propco have their own
  // bank accounts, separate from J.R. Boehlke's — shown as their own rows
  // below combined into one total, never blended account-by-account.
  html += sectionHeader('Cash Position (All Entities)');
  if (!cashAvailable) {
    html += alertBox('#fff0f0', '#c0392b', 'Cash Position Unavailable This Run',
      `<p style="margin:0;font-size:13px;color:#7a1f1f;">No QuickBooks bank balance could be fetched from any entity this run — figures below are not shown rather than guessed. This means either no entity is authorized yet, or a connected entity's lookup failed — check QuickBooks directly or wait for the next run.</p>`);
  } else {
    if (cashPartial) {
      const missing = cashByCompany.filter(c => c.connected && c.error).map(c => c.label).join(', ');
      html += `<p style="margin:0 0 10px;font-size:12px;color:#c0392b;">Combined total below is PARTIAL — includes ${cashOk.map(c => c.label).join(', ')}; missing ${missing} (lookup failed this run).</p>`;
    }
    for (const c of cashByCompany) {
      if (!c.connected) continue; // not yet OAuth-authorized — nothing to show
      if (c.error) {
        html += `<p style="margin:0 0 8px;font-size:12px;color:#c0392b;">${c.label}: cash lookup failed (${c.error}).</p>`;
        continue;
      }
      html += entityDivider(c.label);
      html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:4px;">`;
      for (const acct of c.accounts) {
        html += `<tr>
          <td style="padding:4px 6px;font-size:13px;color:#444444;">${acct.name}</td>
          <td style="padding:4px 6px;font-size:13px;font-weight:bold;color:#333333;text-align:right;white-space:nowrap;">${f$(acct.balance)}</td>
        </tr>`;
      }
      html += `<tr><td style="padding:5px 6px;font-size:12px;font-weight:bold;color:#1a1a2e;">Subtotal</td><td style="padding:5px 6px;font-size:13px;font-weight:bold;color:#1a6e1a;text-align:right;white-space:nowrap;">${f$(c.total)}</td></tr>`;
      html += `</table>`;
    }
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 8px;border-top:1px solid #e8e8e8;"><tr>
      <td style="padding:8px 6px 0;font-size:13px;font-weight:bold;color:#1a1a2e;">Combined Total</td>
      <td style="padding:8px 6px 0;font-size:15px;font-weight:bold;color:#1a6e1a;text-align:right;white-space:nowrap;">${f$(combinedCash)}</td>
    </tr></table>`;
  }
  if (nextWeekCash) {
    html += `<p style="margin:0 0 16px;font-size:12px;color:#555577;">Next week's projection (from Monday's 12-Week Cash Forecast, combined all entities): starting ~${f$(nextWeekCash.starting)}, ending ~${f$(nextWeekCash.ending)}. See that report for the full model, per-entity breakdown, and its assumptions.</p>`;
  } else {
    html += `<p style="margin:0 0 16px;font-size:11px;color:#aaaaaa;font-style:italic;">Next week's cash projection not available this run — see Monday's 12-Week Cash Forecast report.</p>`;
  }

  // ── Section: AR / AP Snapshot ────────────────────────────────────────────────
  // AR is J.R. Boehlke-only (Service Autopilot doesn't track the other
  // entities' customers — confirmed by Michael, they have no A/R at all).
  // AP is shown per-entity + combined, since Transport/Propco's AP is real
  // exposure even though they carry no AR. Net (AR-AP) stays JRB-vs-JRB —
  // blending J.R. Boehlke's receivables against the whole group's payables
  // would fabricate a working-capital number no single entity actually has.
  html += sectionHeader('AR / AP Snapshot');
  if (!arAvailable) {
    html += alertBox('#fff0f0', '#c0392b', 'AR Total Unavailable This Run',
      `<p style="margin:0;font-size:13px;color:#7a1f1f;">The Supabase AR aging query failed this run — AR and Net figures below are not shown rather than guessed as $0.</p>`);
  }
  if (!apAvailable) {
    html += alertBox('#fff8f0', '#e6a817', 'AP Totals Unavailable This Run',
      `<p style="margin:0;font-size:13px;color:#533f03;">No QuickBooks AP aging could be fetched from any entity this run — AP and Net figures below are not shown rather than guessed. This means either no entity is authorized yet, or a connected entity's lookup failed.${arAvailable ? ' AR is still shown (a separate, Supabase-backed source).' : ''}</p>`);
  } else if (!jrbApAvailable) {
    // apAvailable only requires ONE company to have succeeded — if Transport
    // or Propco loaded fine but JRB itself didn't, apAvailable stays true (so
    // the banner above never fires) even though the JRB-specific AP/Net rows
    // just below render as bare "—" with no adjacent explanation otherwise.
    html += alertBox('#fff8f0', '#e6a817', 'J.R. Boehlke AP Unavailable This Run',
      `<p style="margin:0;font-size:13px;color:#533f03;">J.R. Boehlke's own AP lookup failed this run — its AP and Net figures below are not shown rather than guessed, even though another entity's AP did load (see AP by Entity below).</p>`);
  }
  html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:6px;">
    <tr>
      <td style="padding:5px 6px;font-size:13px;color:#444444;">Total Open AR (J.R. Boehlke)</td>
      <td style="padding:5px 6px;font-size:13px;font-weight:bold;color:#b35900;text-align:right;white-space:nowrap;">${arAvailable ? f$(arTotal) : '&mdash;'}</td>
    </tr>
    <tr>
      <td style="padding:5px 6px;font-size:13px;color:#444444;">Total Open AP (J.R. Boehlke)</td>
      <td style="padding:5px 6px;font-size:13px;font-weight:bold;color:#b35900;text-align:right;white-space:nowrap;">${jrbApAvailable ? f$(jrbAp.total) : '&mdash;'}</td>
    </tr>
    <tr>
      <td style="padding:6px 6px;font-size:13px;font-weight:bold;color:#1a1a2e;">Net (AR &minus; AP), J.R. Boehlke only</td>
      <td style="padding:6px 6px;font-size:14px;font-weight:bold;color:${net === null ? '#888888' : net >= 0 ? '#1a6e1a' : '#c0392b'};text-align:right;white-space:nowrap;">${net !== null ? f$(net) : '&mdash;'}</td>
    </tr>
  </table>`;
  html += `<p style="margin:0 0 16px;font-size:12px;color:#555577;">${arFlaggedCount} account${arFlaggedCount === 1 ? '' : 's'} currently on the collection call queue (30+ days, $500+) — see Monday's AR/Collections report for the full list.</p>`;
  if (apAvailable) {
    html += `<p style="margin:0 0 6px;font-size:12px;font-weight:bold;color:#555577;">AP by Entity</p>`;
    if (apPartial) {
      const missing = apByCompany.filter(c => c.connected && c.error).map(c => c.label).join(', ');
      html += `<p style="margin:0 0 6px;font-size:12px;color:#c0392b;">Combined total below is PARTIAL — missing ${missing} (lookup failed this run).</p>`;
    }
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">`;
    for (const c of apByCompany) {
      if (!c.connected) continue;
      if (c.error) {
        html += `<tr><td style="padding:4px 6px;font-size:12px;color:#c0392b;" colspan="2">${c.label}: AP lookup failed (${c.error}).</td></tr>`;
        continue;
      }
      html += `<tr>
        <td style="padding:4px 6px;font-size:13px;color:#444444;">${c.label}</td>
        <td style="padding:4px 6px;font-size:13px;font-weight:bold;color:#333333;text-align:right;white-space:nowrap;">${f$(c.total)}</td>
      </tr>`;
    }
    html += `<tr><td style="padding:5px 6px;font-size:13px;font-weight:bold;color:#1a1a2e;">Combined Total AP</td><td style="padding:5px 6px;font-size:14px;font-weight:bold;color:#b35900;text-align:right;white-space:nowrap;">${f$(combinedAp)}</td></tr>`;
    html += `</table>`;
    html += `<p style="margin:0 0 16px;font-size:11px;color:#888888;">Full vendor-level detail (aging, due-soon, duplicate/discrepancy flags) is in Wednesday's Accounts Payable report.</p>`;
  }

  // ── Section: Marketing & Sales KPIs This Week ────────────────────────────────
  html += sectionHeader('Marketing & Sales KPIs');
  if (marketing) {
    html += `<p style="margin:0 0 6px;font-size:12px;color:#888888;">As of Monday's Marketing Performance report (week of ${fD(marketing.week_start)}):</p>`;
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;">
      <tr><td style="padding:4px 6px;font-size:13px;color:#444444;">Ad Spend</td><td style="padding:4px 6px;font-size:13px;font-weight:bold;color:#333333;text-align:right;">${f$(marketing.total_spend)}</td></tr>
      <tr><td style="padding:4px 6px;font-size:13px;color:#444444;">Leads (Conversions)</td><td style="padding:4px 6px;font-size:13px;font-weight:bold;color:#333333;text-align:right;">${Number(marketing.conversions ?? 0).toFixed(1)}</td></tr>
      <tr><td style="padding:4px 6px;font-size:13px;color:#444444;">Cost / Lead</td><td style="padding:4px 6px;font-size:13px;font-weight:bold;color:#333333;text-align:right;">${marketing.cost_per_lead !== null ? f$(marketing.cost_per_lead) : '&mdash;'}</td></tr>
      <tr><td style="padding:4px 6px;font-size:13px;color:#444444;">SA Jobs Won This Period</td><td style="padding:4px 6px;font-size:13px;font-weight:bold;color:#333333;text-align:right;">${marketing.won_job_count}</td></tr>
    </table>`;
  } else {
    html += `<p style="margin:0 0 12px;font-size:11px;color:#aaaaaa;font-style:italic;">No marketing snapshot available yet this week — see Monday's Marketing Performance report.</p>`;
  }
  if (sales) {
    html += `<p style="margin:0 0 6px;font-size:12px;color:#888888;">As of Monday's Sales Pipeline / BD report (week of ${fD(sales.week_start)}):</p>`;
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
      <tr><td style="padding:4px 6px;font-size:13px;color:#444444;">Open Pipeline</td><td style="padding:4px 6px;font-size:13px;font-weight:bold;color:#333333;text-align:right;">${sales.open_pipeline_count} leads &middot; ${f$(sales.open_pipeline_value)}</td></tr>
      <tr><td style="padding:4px 6px;font-size:13px;color:#444444;">Win Rate (90d)</td><td style="padding:4px 6px;font-size:13px;font-weight:bold;color:#333333;text-align:right;">${sales.win_rate !== null ? Number(sales.win_rate).toFixed(0) + '%' : '&mdash;'}</td></tr>
      <tr><td style="padding:4px 6px;font-size:13px;color:#444444;">Avg. Deal Size (Won)</td><td style="padding:4px 6px;font-size:13px;font-weight:bold;color:#333333;text-align:right;">${sales.avg_deal_size !== null ? f$(sales.avg_deal_size) : '&mdash;'}</td></tr>
    </table>`;
  } else {
    html += `<p style="margin:0 0 12px;font-size:11px;color:#aaaaaa;font-style:italic;">No sales pipeline snapshot available yet this week — see Monday's Business Development report.</p>`;
  }

  // ── Section: Estimating Pipeline Status ──────────────────────────────────────
  html += sectionHeader('Estimating Pipeline Status');
  if (estimating.available) {
    if (estimating.freshness?.stale) {
      html += alertBox('#fff8f0', '#e6a817', `Estimate Data May Be Stale (${estimating.freshness.ageHours}h Since Last Sync)`,
        `<p style="margin:0;font-size:13px;color:#533f03;">The BTA estimate-scraper syncs weekly (Sunday) — figures below may not reflect estimates built/sent since the last sync.</p>`);
    }
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
      <tr><td style="padding:4px 6px;font-size:13px;color:#444444;">Open Backlog (Draft + Sent)</td><td style="padding:4px 6px;font-size:13px;font-weight:bold;color:#333333;text-align:right;">${estimating.count} estimate${estimating.count === 1 ? '' : 's'}</td></tr>
      <tr><td style="padding:4px 6px;font-size:13px;color:#444444;">Backlog Value</td><td style="padding:4px 6px;font-size:13px;font-weight:bold;color:#b35900;text-align:right;">${f$(estimating.value)}</td></tr>
      <tr><td style="padding:4px 6px;font-size:13px;color:#444444;">Oldest Waiting</td><td style="padding:4px 6px;font-size:13px;font-weight:bold;color:${estimating.oldestWaitingDays > 30 ? '#c0392b' : '#333333'};text-align:right;">${estimating.oldestWaitingDays !== null ? estimating.oldestWaitingDays + 'd' : '&mdash;'}</td></tr>
    </table>`;
    html += `<p style="margin:0 0 16px;font-size:11px;color:#888888;">Full aging buckets, priority queue, and per-estimator breakdown are in the Estimating Pipeline reports (Tue/Thu/Fri).</p>`;
  } else {
    html += `<p style="margin:0 0 16px;font-size:13px;color:#888888;font-style:italic;">Estimating backlog data unavailable this run.</p>`;
  }

  // ── Section: Crew Capacity — Next Week ───────────────────────────────────────
  html += sectionHeader(`Crew Load — Week of ${fD(nextMonday)}`);
  html += `<p style="margin:-4px 0 10px;font-size:11px;color:#888888;">Real scheduled-job counts from Service Autopilot, not a computed capacity/utilization percentage — this system has no confirmed unit or meaning for the crews table's "daily capacity" field, so no such number is calculated here (see Gaps below).</p>`;
  html += `<p style="margin:0 0 6px;font-size:13px;font-weight:bold;color:#444444;">Already Dispatched (${crew.scheduledTotalCount} job${crew.scheduledTotalCount === 1 ? '' : 's'}, ${f$(crew.scheduledTotalValue)})</p>`;
  html += crewTableHtml(crew.scheduledRows, 'Value');
  if (crew.unscheduledTotalCount > 0) {
    html += `<p style="margin:8px 0 6px;font-size:13px;font-weight:bold;color:#b35900;">Assigned But Not Yet Dispatched (${crew.unscheduledTotalCount} waiting-list job${crew.unscheduledTotalCount === 1 ? '' : 's'} targeted for next week)</p>`;
    html += crewTableHtml(crew.unscheduledRows, 'Value');
  }
  if (crew.crewsFetchFailed) {
    html += `<p style="margin:8px 0 0;font-size:11px;color:#c0392b;">Active crew roster unavailable this run (lookup failed) — not the same as zero active crews. See logs.</p>`;
  } else {
    html += `<p style="margin:8px 0 0;font-size:11px;color:#888888;">${crew.activeCrews.length} active crew${crew.activeCrews.length === 1 ? '' : 's'} on file: ${crew.activeCrews.length ? crew.activeCrews.map(c => c.display_name || c.name).join(', ') : 'none found'}.</p>`;
  }

  // ── Honest gaps ──────────────────────────────────────────────────────────────
  html += `<p style="margin:24px 0 0;font-size:11px;color:#aaaaaa;font-style:italic;">Not included: a computed crew capacity/utilization percentage (no confirmed unit for the crews table's daily-capacity field); this week's live marketing/sales activity (Marketing Performance and Sales Pipeline figures above are as of Monday's reports, not recomputed live). See the individual reports referenced above for full detail on any section.</p>`;

  html += `
</td></tr>
</table></td></tr></table>
</body></html>`;

  return html;
}

// Pulls a settled value out or falls back, logging the rejection. Using
// Promise.allSettled (rather than Promise.all) at the call site below is
// deliberate: this report synthesizes 9 independent sources into one
// roll-up, so one transient failure (e.g. a QBO hiccup) degrading its own
// section is far more useful to Michael on a Friday afternoon than a single
// failed source blanking the entire email — same "partial is better than
// nothing" reasoning overnight-report.js already applies via its own
// per-query try/catch pattern, just expressed at the top level here since
// several of these gathers (getCashBalance/getAPAgingReport in particular)
// don't already catch their own errors internally.
function unwrap(result, fallback, label) {
  if (result.status === 'fulfilled') return result.value;
  logger.warn(`weekly_scorecard_report: ${label} failed`, { err: result.reason?.message });
  return fallback;
}

export async function generateAndSendWeeklyScorecardReport() {
  const weekStart = mondayOf();
  const nextMonday = addDaysUTC(weekStart, 7);
  const nextSunday = addDaysUTC(weekStart, 13);

  // A recoverMissedExecutions catch-up run can fire well after the intended
  // Friday 2:45 PM slot (e.g. Monday morning, if the scheduler was down over
  // the weekend) — mondayOf() always resolves to "the Monday of whatever
  // week it's called in," so a late run landing in a NEW week would silently
  // report on that new week's numbers under a header that still implies a
  // normal Friday send. Flagged explicitly rather than left implicit, since
  // this report's whole premise is a Friday week-wrap.
  const isDelayedRun = new Date().getUTCDay() !== 5; // 5 = Friday (UTC)

  const results = await Promise.allSettled([
    gatherCashAndApByCompany(),
    gatherSAARaging(),
    gatherSAFreshness({ staleHours: STALE_SA_HOURS }),
    gatherLatestMarketingSnapshot(),
    gatherLatestSalesPipelineSnapshot(),
    gatherEstimatingSnapshot(),
    gatherCrewCapacityNextWeek(nextMonday, nextSunday),
    gatherNextWeekCashForecast(weekStart),
  ]);
  const [cashAndApResult, arResult, freshnessResult, marketingResult, salesResult, estimatingResult, crewResult, nextWeekCashResult] = results;

  // Each gather already handles its own per-company errors internally (see
  // gatherCashAndApByCompany) — this outer unwrap only catches the
  // (unlikely) case the whole Promise.all itself rejects. buildEmail expects
  // cash and AP as separate per-company arrays (cashByCompany's `.total`
  // means cash total, apByCompany's `.total` means AP total) — reshaped here
  // from the one combined fetch rather than fetching each company twice.
  const cashAndApByCompany = unwrap(cashAndApResult, [], 'gatherCashAndApByCompany');
  const cashByCompany = cashAndApByCompany.map(c => c.connected && !c.error ? { ...c, total: c.cashTotal } : c);
  const apByCompany = cashAndApByCompany.map(c => c.connected && !c.error ? { ...c, total: c.apTotal } : c);
  const arAging = unwrap(arResult, { total: 0, buckets: { current: [], d30: [], d60: [], d90: [], d120plus: [] }, flagged: [], available: false }, 'gatherSAARaging');
  const freshness = unwrap(freshnessResult, { stale: true, ageHours: 999 }, 'gatherSAFreshness');
  const marketing = unwrap(marketingResult, null, 'gatherLatestMarketingSnapshot');
  const sales = unwrap(salesResult, null, 'gatherLatestSalesPipelineSnapshot');
  const estimating = unwrap(estimatingResult, { available: false, count: 0, value: 0, oldestWaitingDays: null, freshness: { stale: true, ageHours: 999 } }, 'gatherEstimatingSnapshot');
  const crew = unwrap(crewResult, { scheduledRows: [], unscheduledRows: [], scheduledTotalCount: 0, scheduledTotalValue: 0, unscheduledTotalCount: 0, activeCrews: [], crewsFetchFailed: true }, 'gatherCrewCapacityNextWeek');
  const nextWeekCash = unwrap(nextWeekCashResult, null, 'gatherNextWeekCashForecast');

  const arFlaggedCount = (arAging.flagged ?? []).length;

  // Multi-entity cash/AP: combined = sum across every connected+successful
  // entity; jrb-specific values are pulled out separately for the Net
  // (AR-AP) figure, which only makes sense entity-matched — SA/AR is
  // JRB-only, so blending it against the whole group's AP would be a
  // fabricated number, not a real working-capital metric. Computed once here
  // (not re-derived inside buildEmail) so the email body and the subject
  // line/logged summary below can never silently disagree.
  const arAvailable = arAging.available !== false;
  const { ok: cashOk, combinedTotal: combinedCash, available: cashAvailable } = summarizeAcrossCompanies(cashByCompany, c => c.total);
  const { ok: apOk, combinedTotal: combinedAp, available: apAvailable } = summarizeAcrossCompanies(apByCompany, c => c.total);
  const jrbAp = apByCompany.find(c => c.company === 'jrb');
  const jrbApAvailable = jrbAp?.connected && !jrbAp?.error && Number.isFinite(jrbAp?.total);
  const net = (jrbApAvailable && arAvailable && Number.isFinite(arAging.total)) ? (arAging.total - jrbAp.total) : null;

  const body = buildEmail({
    weekStart, nextMonday, nextSunday, cashByCompany, apByCompany, cashOk, apOk,
    combinedCash, cashAvailable, combinedAp, apAvailable, jrbAp, jrbApAvailable, net,
    nextWeekCash, arAging, arFlaggedCount, marketing, sales, estimating, crew, freshness, isDelayedRun,
  });

  const cashLabel = cashAvailable ? `${f$(combinedCash)} cash` : 'cash unavailable';
  const netLabel = net === null ? 'net AR-AP unavailable' : `${f$(net)} net AR-AP (JRB)`;

  await sendEmail({
    to: ['michael@jrboehlke.com'],
    subject: `Weekly Business Scorecard — Week of ${fD(weekStart)} | ${cashLabel}, ${netLabel}${isDelayedRun ? ' (delayed run)' : ''}`,
    body,
  });

  const perCompanyCash = Object.fromEntries(cashByCompany.map(c => [c.company, { connected: c.connected, error: c.error ?? null, total: c.total ?? null }]));
  const perCompanyAp = Object.fromEntries(apByCompany.map(c => [c.company, { connected: c.connected, error: c.error ?? null, total: c.total ?? null }]));

  logger.info('weekly_scorecard_report: sent', {
    weekStart,
    isDelayedRun,
    combinedCashTotal: cashAvailable ? combinedCash : null,
    arTotal: arAvailable ? arAging.total : null,
    combinedApTotal: apAvailable ? combinedAp : null,
    estimatingBacklogCount: estimating.count,
    crewScheduledCount: crew.scheduledTotalCount,
    perCompanyCash,
    perCompanyAp,
  });

  return {
    weekStart,
    isDelayedRun,
    cashTotal: cashAvailable ? combinedCash : null,
    arTotal: arAvailable ? arAging.total : null,
    apTotal: apAvailable ? combinedAp : null,
    estimatingBacklogCount: estimating.count,
    crewScheduledCount: crew.scheduledTotalCount,
  };
}
