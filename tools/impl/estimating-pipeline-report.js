// tools/impl/estimating-pipeline-report.js
// Estimating Pipeline Report — sent ahead of each of Michael's three weekly
// "Estimating / Proposal Production" calendar blocks (Tue 1:30-4:30, Thu 1:00-4:30,
// Fri 1:00-3:00), refreshed shortly before each occurrence since the backlog
// changes throughout the week (see scheduler/cron.js registration + PR description
// for the timing rationale).
//
// Single data source: Supabase `sa_estimates_2026` (fleetops project), populated
// by the BTA Reporting `estimate-scraper.js` (part of weekly-sync.js's Sunday
// pipeline) — see skills/definitions/service-autopilot.md. That table already
// carries SA's full quote lifecycle (Draft -> Sent -> Won/Lost) with quote_date/
// sent_date/won_date, so no live SA browser session is needed here, mirroring the
// ar-collections-report.js pattern of querying pre-synced Supabase data directly.
//
// Sections: backlog (not-yet-sent + sent-awaiting-response) with aging buckets,
// an oldest-first priority queue, a per-estimator backlog breakdown, and a
// trailing-90-day win/loss rate on estimates sent in that window. No explicit
// "deadline" field exists anywhere in the synced SA data for pre-sale estimates
// (sa_waiting_list.target_date is a POST-win scheduling field, out of scope here) —
// oldest-first ranking is used as the priority signal per the task's documented
// fallback.

import { logger } from '../../core/logger.js';
import { sendEmail } from './m365.js';
import { supabase, f$, fD, sectionHeader, alertBox } from './ar-report-helpers.js';

// Known non-production test accounts seen in sa_estimates_2026 — excluded so the
// report never shows fake backlog to Michael. "APIProbe, JRBTest" is the documented
// SA test account (CLAUDE.md); "Test, Test" is a second ad hoc test lead found via
// live inspection while building this report (client_id 3ed0d43d-...).
const TEST_CLIENT_IDS = [
  'e2a7420a-930c-4908-90aa-67ba158e0921', // APIProbe, JRBTest
  '3ed0d43d-9865-439a-875d-eda0afb7930c', // Test, Test
];
const EXCLUDED_STAGE_NAMES = ['Test Stage'];

const WIN_LOSS_WINDOW_DAYS = 90;
const PRIORITY_QUEUE_MAX_ROWS = 15;
const BACKLOG_BY_ESTIMATOR_MAX_ROWS = 10;
// estimate-scraper.js runs as part of BTA Reporting's weekly-sync.js (Sunday 8 AM
// cron in that separate project) rather than nightly — so a same-day staleness
// threshold like ar-collections-report.js's 24h would false-positive every day of
// the week. 8 days gives one day of slack past the weekly cadence.
const STALE_DATA_HOURS = 24 * 8;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Pure UTC calendar-day diff — deliberately avoids .setHours()/local-timezone math.
// quote_date/sent_date come back from Postgres `date` columns as e.g. '2026-08-20',
// which `new Date(...)` parses as UTC midnight. On a server west of UTC (confirmed
// Central time here), converting that to LOCAL midnight via .setHours(0,0,0,0)
// rolls it back to the previous calendar day, inflating every age by 1 day (caught
// by /code-review executing this function live). Comparing UTC calendar-day numbers
// directly sidesteps local time zone entirely, matching the Date.UTC(...) pattern
// ar-collections-report.js's mondayOf() already uses for the same reason.
function daysBetween(fromDateLike, toDateLike = new Date()) {
  if (!fromDateLike) return null;
  const from = new Date(fromDateLike);
  if (Number.isNaN(from.getTime())) return null;
  const to = new Date(toDateLike);
  const fromUTC = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const toUTC = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.max(0, Math.round((toUTC - fromUTC) / 86400000));
}

// Local color-coded aging badge for "days waiting" — deliberately NOT reusing
// ar-report-helpers.js's ageBadge() here even though the task description called
// it out as reusable: ageBadge's copy is hardcoded "Xd past due" / "due <date>",
// written for AR invoice aging. Every row in this report's Priority Queue has
// ageDays >= 0 by definition (an open estimate, not an overdue invoice), so
// ageBadge's text would read "5d past due" on estimates that were never "due" at
// all — directly contradicting this report's own "no deadline exists" disclaimer
// right above the table (confirmed by /code-review executing ageBadge() live).
// Same color/weight/size styling as ageBadge is kept for visual consistency across
// reports; only the wording changes.
function waitingBadge(days) {
  if (days <= 0) return `<span style="font-size:11px;color:#888888;">today</span>`;
  if (days <= 60) return `<span style="font-size:11px;color:#b35900;font-weight:bold;">${days}d waiting</span>`;
  return `<span style="font-size:11px;color:#c0392b;font-weight:bold;background:#fff0f0;padding:1px 4px;border-radius:2px;">${days}d WAITING</span>`;
}

function isRealAccount(row) {
  return !TEST_CLIENT_IDS.includes(row.client_id) && !EXCLUDED_STAGE_NAMES.includes(row.stage_name);
}

// Pulls the full pre-sale pipeline (Draft + Sent) plus enough of the resolved
// (Won/Lost) rows to compute the win/loss window, in one query.
async function gatherEstimatingData() {
  // Explicit .range() rather than trusting the client's default page size (1000) —
  // sa_estimates_2026 currently sits at exactly 1000 rows, which is suspiciously
  // close to that default. Same defect class CLAUDE.md already documents for
  // getClientsByTag's default max=5000: "silently truncates rather than erroring."
  // 4999 gives 5x headroom over the current row count.
  const { data, error } = await supabase
    .from('sa_estimates_2026')
    .select('estimate_id, estimate_number, client_name, client_address, stage, stage_name, salesperson, estimated_value, quote_date, created_date, sent_date, won_date, extracted_at, landscape_won, asphalt_won, concrete_won, other_won')
    .order('quote_date', { ascending: true })
    .range(0, 4999);

  if (error) {
    logger.warn('estimating_pipeline_report: sa_estimates_2026 query failed', { err: error.message });
    return { rows: [], freshness: { stale: true, ageHours: 999 } };
  }

  const rows = (data ?? []).filter(isRealAccount);

  const latestExtractedAt = rows.reduce((max, r) => {
    const t = r.extracted_at ? new Date(r.extracted_at).getTime() : 0;
    return t > max ? t : max;
  }, 0);
  const ageHours = latestExtractedAt ? Math.round((Date.now() - latestExtractedAt) / 3600000) : 999;
  const freshness = { stale: ageHours > STALE_DATA_HOURS, ageHours };

  return { rows, freshness };
}

function buildBacklog(rows) {
  const backlog = rows
    .filter(r => r.stage === 'Draft' || r.stage === 'Sent')
    .map(r => {
      const waitingSince = r.stage === 'Sent' ? (r.sent_date ?? r.quote_date ?? r.created_date) : (r.quote_date ?? r.created_date);
      return {
        estimateNumber: r.estimate_number,
        client: r.client_name || 'Unknown Client',
        address: r.client_address,
        stage: r.stage, // 'Draft' | 'Sent'
        salesperson: r.salesperson || 'Unassigned',
        value: Number(r.estimated_value ?? 0),
        ageDays: daysBetween(waitingSince) ?? 0,
      };
    })
    .sort((a, b) => b.ageDays - a.ageDays);

  const total = backlog.reduce((s, r) => s + r.value, 0);
  const notYetSent = backlog.filter(r => r.stage === 'Draft');
  const awaitingResponse = backlog.filter(r => r.stage === 'Sent');

  const bucketDefs = [[0, 7], [8, 14], [15, 30], [31, 60], [61, Infinity]];
  const buckets = bucketDefs.map(([min, max]) => ({
    min, max,
    label: max === Infinity ? `${min}d+` : `${min}-${max}d`,
    rows: backlog.filter(r => r.ageDays >= min && r.ageDays <= max),
  }));

  const byEstimator = {};
  for (const r of backlog) {
    if (!byEstimator[r.salesperson]) byEstimator[r.salesperson] = { count: 0, value: 0 };
    byEstimator[r.salesperson].count += 1;
    byEstimator[r.salesperson].value += r.value;
  }
  const estimatorRows = Object.entries(byEstimator).sort((a, b) => b[1].value - a[1].value);

  return { backlog, total, notYetSent, awaitingResponse, buckets, estimatorRows };
}

function buildWinLoss(rows) {
  const cutoff = new Date(Date.now() - WIN_LOSS_WINDOW_DAYS * 86400000);
  const inWindow = rows.filter(r => r.sent_date && new Date(r.sent_date) >= cutoff);

  const won = inWindow.filter(r => r.stage === 'Won');
  const lost = inWindow.filter(r => r.stage === 'Lost');
  const pending = inWindow.filter(r => r.stage === 'Sent');

  const sumVal = list => list.reduce((s, r) => s + Number(r.estimated_value ?? 0), 0);
  // skills/definitions/service-autopilot.md documents that "$ Booked" must sum only
  // the line items actually marked Won (landscape_won/asphalt_won/concrete_won/
  // other_won), not the full estimated_value — a single estimate can have some
  // line items won and others declined. Lost estimates have no equivalent per-
  // category "*_lost" columns in this table, so lostValue/pendingValue still use
  // the full quoted estimated_value (a real approximation for Lost, since nothing
  // on the estimate closed; an intentional "at stake" total for still-open Sent).
  const sumWonVal = list => list.reduce((s, r) => s + ['landscape_won', 'asphalt_won', 'concrete_won', 'other_won']
    .reduce((rowSum, col) => rowSum + Number(r[col] ?? 0), 0), 0);
  const decided = won.length + lost.length;
  const winRate = decided > 0 ? (won.length / decided) * 100 : null;

  const winDurations = won
    .filter(r => r.won_date && r.sent_date)
    .map(r => (new Date(r.won_date) - new Date(r.sent_date)) / 86400000);
  const avgDaysToWin = winDurations.length
    ? Math.round((winDurations.reduce((s, d) => s + d, 0) / winDurations.length) * 10) / 10
    : null;

  return {
    windowDays: WIN_LOSS_WINDOW_DAYS,
    wonCount: won.length,
    lostCount: lost.length,
    pendingCount: pending.length,
    wonValue: sumWonVal(won),
    lostValue: sumVal(lost),
    pendingValue: sumVal(pending),
    winRate,
    avgDaysToWin,
  };
}

function buildEmail({ backlog, winLoss, freshness, reportDate, blockLabel }) {
  const { total, notYetSent, awaitingResponse, buckets, estimatorRows, backlog: allBacklog } = backlog;
  const priorityQueue = allBacklog.slice(0, PRIORITY_QUEUE_MAX_ROWS);

  let html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Estimating Pipeline Report ${reportDate}</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" style="max-width:620px;background-color:#ffffff;border-radius:6px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

<!-- HEADER -->
<tr><td style="background-color:#1a1a2e;padding:24px 32px;">
  <p style="margin:0;color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:0.5px;">J.R. Boehlke, LLC</p>
  <p style="margin:4px 0 0;color:#aaaacc;font-size:13px;">Estimating Pipeline Report &nbsp;|&nbsp; ${fD(reportDate)} &nbsp;|&nbsp; ahead of ${blockLabel}</p>
</td></tr>

<!-- BODY -->
<tr><td style="padding:28px 32px;">`;

  if (freshness?.stale) {
    html += alertBox('#fff8f0', '#e6a817', `SA Estimate Data May Be Stale (${freshness.ageHours}h Since Last Sync)`,
      `<p style="margin:0;font-size:13px;color:#533f03;">The BTA estimate-scraper syncs weekly (Sunday) — figures below may not reflect estimates built/sent since the last sync.</p>`);
  }

  // ── Totals bar ────────────────────────────────────────────────────────────
  html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eef1fa;border-radius:4px;margin-bottom:6px;"><tr>
  <td style="padding:14px 12px;text-align:center;border-right:1px solid #d8e0f0;">
    <p style="margin:0;font-size:18px;font-weight:bold;color:#1a1a2e;">${allBacklog.length}</p>
    <p style="margin:2px 0 0;font-size:10px;color:#555577;text-transform:uppercase;letter-spacing:0.5px;">Backlog Items</p>
  </td>
  <td style="padding:14px 12px;text-align:center;border-right:1px solid #d8e0f0;">
    <p style="margin:0;font-size:18px;font-weight:bold;color:#b35900;">${f$(total)}</p>
    <p style="margin:2px 0 0;font-size:10px;color:#555577;text-transform:uppercase;letter-spacing:0.5px;">Backlog Value</p>
  </td>
  <td style="padding:14px 12px;text-align:center;border-right:1px solid #d8e0f0;">
    <p style="margin:0;font-size:18px;font-weight:bold;color:${allBacklog.length && allBacklog[0].ageDays > 30 ? '#c0392b' : '#1a1a2e'};">${allBacklog.length ? allBacklog[0].ageDays + 'd' : '—'}</p>
    <p style="margin:2px 0 0;font-size:10px;color:#555577;text-transform:uppercase;letter-spacing:0.5px;">Oldest Waiting</p>
  </td>
  <td style="padding:14px 12px;text-align:center;">
    <p style="margin:0;font-size:18px;font-weight:bold;color:#1a6e1a;">${winLoss.winRate !== null ? winLoss.winRate.toFixed(0) + '%' : '—'}</p>
    <p style="margin:2px 0 0;font-size:10px;color:#555577;text-transform:uppercase;letter-spacing:0.5px;">Win Rate (${winLoss.windowDays}d)</p>
  </td>
</tr></table>`;

  // ── Backlog split ────────────────────────────────────────────────────────
  html += sectionHeader('Backlog Overview');
  html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
    <tr>
      <td style="padding:5px 6px;font-size:13px;color:#444444;">Not Yet Sent (needs to be built/finished)</td>
      <td style="padding:5px 6px;font-size:12px;color:#888888;text-align:right;">${notYetSent.length} estimate${notYetSent.length === 1 ? '' : 's'}</td>
      <td style="padding:5px 6px;font-size:13px;font-weight:bold;color:#333333;text-align:right;white-space:nowrap;">${f$(notYetSent.reduce((s, r) => s + r.value, 0))}</td>
    </tr>
    <tr>
      <td style="padding:5px 6px;font-size:13px;color:#444444;">Sent, Awaiting Client Response</td>
      <td style="padding:5px 6px;font-size:12px;color:#888888;text-align:right;">${awaitingResponse.length} estimate${awaitingResponse.length === 1 ? '' : 's'}</td>
      <td style="padding:5px 6px;font-size:13px;font-weight:bold;color:#333333;text-align:right;white-space:nowrap;">${f$(awaitingResponse.reduce((s, r) => s + r.value, 0))}</td>
    </tr>
  </table>`;

  // ── Aging buckets ─────────────────────────────────────────────────────────
  html += sectionHeader('Backlog Aging (Days Waiting)');
  html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">`;
  for (const b of buckets) {
    const sum = b.rows.reduce((s, r) => s + r.value, 0);
    const color = b.min >= 61 ? '#c0392b' : b.min >= 31 ? '#b35900' : '#333333';
    html += `<tr>
      <td style="padding:5px 6px;font-size:13px;color:#444444;">${b.label}</td>
      <td style="padding:5px 6px;font-size:12px;color:#888888;text-align:right;">${b.rows.length} item${b.rows.length === 1 ? '' : 's'}</td>
      <td style="padding:5px 6px;font-size:13px;font-weight:bold;color:${color};text-align:right;white-space:nowrap;">${f$(sum)}</td>
    </tr>`;
  }
  html += `</table>`;

  // ── Priority queue (oldest-first) ────────────────────────────────────────
  html += sectionHeader('Priority Queue (Oldest First)');
  html += `<p style="margin:-4px 0 10px;font-size:11px;color:#888888;">No explicit deadline field exists in the synced SA estimate data, so this queue is ranked purely by how long each item has been waiting.</p>`;
  if (!priorityQueue.length) {
    html += `<p style="margin:0 0 16px;font-size:13px;color:#888888;font-style:italic;">No open estimating backlog right now.</p>`;
  } else {
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
    <tr style="background-color:#f8f8f8;">
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;width:20px;">#</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;">Client</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;">Stage</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Value</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Waiting</td>
    </tr>`;
    priorityQueue.forEach((item, i) => {
      const stageLabel = item.stage === 'Draft' ? 'Not Sent' : 'Awaiting Reply';
      html += `<tr style="background-color:${i % 2 ? '#f8f8f8' : '#ffffff'};">
        <td style="padding:6px 6px;font-size:13px;color:#888888;">${i + 1}</td>
        <td style="padding:6px 6px;font-size:13px;color:#333333;">${item.client}<br><span style="font-size:11px;color:#888888;">#${item.estimateNumber} &middot; ${item.salesperson}</span></td>
        <td style="padding:6px 6px;font-size:12px;color:#555577;">${stageLabel}</td>
        <td style="padding:6px 6px;font-size:13px;font-weight:bold;color:#b35900;text-align:right;white-space:nowrap;">${f$(item.value)}</td>
        <td style="padding:6px 6px;text-align:right;white-space:nowrap;">${waitingBadge(item.ageDays)}</td>
      </tr>`;
    });
    html += `</table>`;
    if (allBacklog.length > priorityQueue.length) {
      html += `<p style="margin:0 0 16px;font-size:11px;color:#aaaaaa;font-style:italic;">+ ${allBacklog.length - priorityQueue.length} more backlog item${allBacklog.length - priorityQueue.length === 1 ? '' : 's'} not shown.</p>`;
    }
  }

  // ── Backlog by estimator ─────────────────────────────────────────────────
  html += sectionHeader('Backlog by Estimator');
  if (!estimatorRows.length) {
    html += `<p style="margin:0 0 16px;font-size:13px;color:#888888;font-style:italic;">No open estimating backlog right now.</p>`;
  } else {
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">`;
    estimatorRows.slice(0, BACKLOG_BY_ESTIMATOR_MAX_ROWS).forEach(([name, info]) => {
      html += `<tr>
        <td style="padding:5px 6px;font-size:13px;color:#444444;">${name}</td>
        <td style="padding:5px 6px;font-size:12px;color:#888888;text-align:right;">${info.count} item${info.count === 1 ? '' : 's'}</td>
        <td style="padding:5px 6px;font-size:13px;font-weight:bold;color:#333333;text-align:right;white-space:nowrap;">${f$(info.value)}</td>
      </tr>`;
    });
    html += `</table>`;
  }

  // ── Win/loss ──────────────────────────────────────────────────────────────
  html += sectionHeader(`Win / Loss — Estimates Sent in Last ${winLoss.windowDays} Days`);
  html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8f8f8;border-radius:4px;margin-bottom:8px;"><tr>
    <td style="padding:12px 10px;text-align:center;border-right:1px solid #e8e8e8;">
      <p style="margin:0;font-size:16px;font-weight:bold;color:#1a6e1a;">${winLoss.wonCount}</p>
      <p style="margin:2px 0 0;font-size:10px;color:#888888;text-transform:uppercase;">Won &middot; ${f$(winLoss.wonValue)}</p>
    </td>
    <td style="padding:12px 10px;text-align:center;border-right:1px solid #e8e8e8;">
      <p style="margin:0;font-size:16px;font-weight:bold;color:#c0392b;">${winLoss.lostCount}</p>
      <p style="margin:2px 0 0;font-size:10px;color:#888888;text-transform:uppercase;">Lost &middot; ${f$(winLoss.lostValue)}</p>
    </td>
    <td style="padding:12px 10px;text-align:center;">
      <p style="margin:0;font-size:16px;font-weight:bold;color:#555577;">${winLoss.pendingCount}</p>
      <p style="margin:2px 0 0;font-size:10px;color:#888888;text-transform:uppercase;">Still Pending &middot; ${f$(winLoss.pendingValue)}</p>
    </td>
  </tr></table>`;
  html += `<p style="margin:0 0 20px;font-size:12px;color:#555577;">${winLoss.winRate !== null ? `Win rate on decided estimates: <b>${winLoss.winRate.toFixed(1)}%</b>` : 'No decided estimates in this window yet.'}${winLoss.avgDaysToWin !== null ? ` &nbsp;|&nbsp; Avg. days sent&rarr;won: <b>${winLoss.avgDaysToWin}d</b>` : ''}</p>`;

  html += `
</td></tr>
</table></td></tr></table>
</body></html>`;

  return html;
}

export async function generateAndSendEstimatingPipelineReport({ blockLabel = 'the next Estimating/Proposal Production block' } = {}) {
  const reportDate = todayISO();
  const { rows, freshness } = await gatherEstimatingData();
  const backlog = buildBacklog(rows);
  const winLoss = buildWinLoss(rows);

  const body = buildEmail({ backlog, winLoss, freshness, reportDate, blockLabel });

  await sendEmail({
    to: ['michael@jrboehlke.com'],
    subject: `Estimating Pipeline — ${backlog.backlog.length} open, ${f$(backlog.total)} backlog | ${fD(reportDate)}`,
    body,
  });

  logger.info('estimating_pipeline_report: sent', {
    reportDate,
    backlogCount: backlog.backlog.length,
    backlogValue: backlog.total,
    winRate: winLoss.winRate,
  });

  return {
    reportDate,
    backlogCount: backlog.backlog.length,
    backlogValue: backlog.total,
    oldestWaitingDays: backlog.backlog[0]?.ageDays ?? null,
    winRate: winLoss.winRate,
  };
}
