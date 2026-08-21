// tools/impl/sales-pipeline-report.js
// Sales Pipeline / BD Report — sent twice a week ahead of Michael's two
// "Outbound Sales" calendar blocks: Monday 2:00-3:00 PM "Business Development"
// and Thursday 9:00-10:00 AM "Lead Follow-Up". One shared generator with a
// `mode` param rather than two separate files — the underlying data (SA
// estimate pipeline) is identical either way; only which sections lead and how
// much detail they carry changes (see buildEmail's mode branching + the PR
// description for the full timing rationale).
//
// Same data source as the Estimating Pipeline Report (tools/impl/
// estimating-pipeline-report.js, PR #292, not yet merged as of this writing):
// Supabase `sa_estimates_2026` (fleetops project), populated weekly by BTA
// Reporting's estimate-scraper.js. Deliberately NOT importing from that file
// (it lives on an unmerged branch, so main can't depend on it) — the small
// amount of overlapping logic (stage filtering, UTC-safe day math) is
// re-implemented locally rather than duplicated verbatim, and this report's
// framing is different on purpose: Estimating Pipeline is an *estimator
// workload* view (who's carrying how much backlog, ranked oldest-first as a
// build queue); this report is a *sales/BD activity* view (stage funnel,
// which specific leads are overdue for a human follow-up call, win rate and
// average deal size as sales performance, not estimator throughput).
//
// Sections: pipeline by stage (Draft/Sent, i.e. "open"), a follow-up call
// queue (Draft held too long without being sent, Sent held too long without a
// decision), win rate + average deal size (overall and by salesperson), and a
// week-over-week open-pipeline-value/win-rate trend. See the "Response-time
// SLA" note in buildEmail for why that requested metric is explicitly omitted
// rather than faked.

import { logger } from '../../core/logger.js';
import { sendEmail } from './m365.js';
import { supabase, f$, fD, sectionHeader, alertBox, ageBadge } from './ar-report-helpers.js';

// Same known non-production test accounts as estimating-pipeline-report.js —
// "APIProbe, JRBTest" is the documented SA test account (CLAUDE.md); "Test,
// Test" is a second ad hoc test lead found during that report's build. Kept as
// a local constant (not imported) since the source file lives on an unmerged
// branch.
const TEST_CLIENT_IDS = [
  'e2a7420a-930c-4908-90aa-67ba158e0921', // APIProbe, JRBTest
  '3ed0d43d-9865-439a-875d-eda0afb7930c', // Test, Test
];
const EXCLUDED_STAGE_NAMES = ['Test Stage'];

// A Draft estimate sitting unsent this long risks losing the deal to a
// competitor who responds faster — this is the whole point of a "Business
// Development" framing on this data. A Sent estimate with no decision this
// long is judged overdue for a human follow-up call rather than just waiting
// passively. Both are deliberately shorter than Estimating Pipeline's oldest
// aging bucket (61d+) — that report's buckets describe estimator workload
// aging; these thresholds describe when a BD/sales action is actually due.
const DRAFT_OVERDUE_DAYS = 5;
const SENT_OVERDUE_DAYS = 14;
const FOLLOWUP_QUEUE_MAX_ROWS_FULL = 15; // Thursday "Lead Follow-Up" mode
const FOLLOWUP_QUEUE_MAX_ROWS_CONDENSED = 5; // Monday "Business Development" mode

const WIN_LOSS_WINDOW_DAYS = 90;
const SALESPERSON_MIN_DECIDED = 2; // hides noisy 100%/0% rows from n=1
// sa_estimates_2026 is only re-synced weekly (BTA's Sunday pipeline) — same
// staleness threshold and reasoning as estimating-pipeline-report.js.
const STALE_DATA_HOURS = 24 * 8;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function mondayOf(referenceDate = new Date()) {
  const d = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), referenceDate.getUTCDate()));
  const dow = d.getUTCDay(); // 0=Sun
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

// Pure UTC calendar-day diff. Deliberately avoids .setHours(0,0,0,0), which
// rolls a UTC-midnight-parsed date back one calendar day on a server west of
// UTC (the exact off-by-one bug estimating-pipeline-report.js's /code-review
// caught and fixed live) — comparing UTC calendar-day numbers directly
// sidesteps local timezone entirely.
function daysBetween(fromDateLike, toDateLike = new Date()) {
  if (!fromDateLike) return null;
  const from = new Date(fromDateLike);
  if (Number.isNaN(from.getTime())) return null;
  const to = new Date(toDateLike);
  const fromUTC = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const toUTC = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.max(0, Math.round((toUTC - fromUTC) / 86400000));
}

function isRealAccount(row) {
  return !TEST_CLIENT_IDS.includes(row.client_id) && !EXCLUDED_STAGE_NAMES.includes(row.stage_name);
}

async function gatherPipelineData() {
  // Explicit .range() rather than trusting the client default page size —
  // same defect class CLAUDE.md documents for getClientsByTag's default max.
  const { data, error } = await supabase
    .from('sa_estimates_2026')
    .select('estimate_id, estimate_number, client_name, stage, stage_name, salesperson, estimated_value, quote_date, created_date, sent_date, won_date, extracted_at, landscape_won, asphalt_won, concrete_won, other_won')
    .order('quote_date', { ascending: true })
    .range(0, 4999);

  if (error) {
    logger.warn('sales_pipeline_report: sa_estimates_2026 query failed', { err: error.message });
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

// "Open leads/opportunities by stage" — the two pre-decision stages in the
// synced SA estimate lifecycle. (SA's own inbound-lead ticket log,
// `sa_tickets.is_lead`, has no creation timestamp and unconfirmed status-code
// semantics — see the Response-time SLA note below — so it isn't used here to
// avoid asserting an "open"/"closed" meaning that hasn't actually been
// verified against SA.)
function buildStageOverview(rows) {
  const draft = rows.filter(r => r.stage === 'Draft');
  const sent = rows.filter(r => r.stage === 'Sent');
  const sum = list => list.reduce((s, r) => s + Number(r.estimated_value ?? 0), 0);
  return {
    draft: { rows: draft, count: draft.length, value: sum(draft) },
    sent: { rows: sent, count: sent.length, value: sum(sent) },
    openCount: draft.length + sent.length,
    openValue: sum(draft) + sum(sent),
  };
}

// Follow-up call queue: which specific open items need a human action today,
// not just an aging bucket. Draft items overdue to be sent; Sent items
// overdue for a check-in call.
//
// A row with no usable date at all (daysBetween() returns null) is NOT
// coerced to ageDays=0 — that would silently drop a potentially very stale,
// undated lead out of the queue forever (an undated Draft/Sent estimate is a
// data-quality problem, not a fresh one). Instead it's flagged with
// ageDays=Infinity so it sorts to the very top of the queue and renders with
// an explicit "date unknown" badge rather than disappearing.
function buildFollowUpQueue(rows) {
  let undatedCount = 0;
  function resolveAge(dateLike) {
    const days = daysBetween(dateLike);
    if (days === null) {
      undatedCount += 1;
      return Infinity;
    }
    return days;
  }

  const draftOverdue = rows
    .filter(r => r.stage === 'Draft')
    .map(r => ({
      client: r.client_name || 'Unknown Client',
      estimateNumber: r.estimate_number,
      salesperson: r.salesperson || 'Unassigned',
      value: Number(r.estimated_value ?? 0),
      ageDays: resolveAge(r.quote_date ?? r.created_date),
      action: 'Not yet sent',
    }))
    .filter(r => r.ageDays > DRAFT_OVERDUE_DAYS);

  const sentOverdue = rows
    .filter(r => r.stage === 'Sent')
    .map(r => ({
      client: r.client_name || 'Unknown Client',
      estimateNumber: r.estimate_number,
      salesperson: r.salesperson || 'Unassigned',
      value: Number(r.estimated_value ?? 0),
      ageDays: resolveAge(r.sent_date ?? r.quote_date ?? r.created_date),
      action: 'Follow-up call due',
    }))
    .filter(r => r.ageDays > SENT_OVERDUE_DAYS);

  if (undatedCount > 0) {
    logger.warn('sales_pipeline_report: rows with no usable date, flagged as top-priority instead of dropped', { undatedCount });
  }

  const all = [...draftOverdue, ...sentOverdue].sort((a, b) => b.ageDays - a.ageDays);
  return {
    all,
    total: all.reduce((s, r) => s + r.value, 0),
    notYetSentCount: draftOverdue.length,
    followUpCallCount: sentOverdue.length,
  };
}

// Win rate + average deal size, overall and by salesperson, for estimates
// *sent* in the trailing window — a sales-performance view (who's closing,
// how big are the deals) rather than Estimating Pipeline's backlog-carrying
// view.
function buildWinLossAndDealSize(rows) {
  const cutoff = new Date(Date.now() - WIN_LOSS_WINDOW_DAYS * 86400000);
  const inWindow = rows.filter(r => r.sent_date && new Date(r.sent_date) >= cutoff);

  const won = inWindow.filter(r => r.stage === 'Won');
  const lost = inWindow.filter(r => r.stage === 'Lost');
  const pending = inWindow.filter(r => r.stage === 'Sent');

  // sa_estimates_2026 tracks per-category *_won columns because a single
  // estimate can have some line items won and others declined (documented BTA
  // convention, also relied on by estimating-pipeline-report.js) — summing
  // those rather than the full estimated_value avoids overstating $ won.
  const wonValueOf = r => ['landscape_won', 'asphalt_won', 'concrete_won', 'other_won']
    .reduce((sum, col) => sum + Number(r[col] ?? 0), 0);

  function summarize(list) {
    const decidedWon = list.filter(r => r.stage === 'Won');
    const decidedLost = list.filter(r => r.stage === 'Lost');
    const decided = decidedWon.length + decidedLost.length;
    const winRate = decided > 0 ? (decidedWon.length / decided) * 100 : null;
    const wonValues = decidedWon.map(wonValueOf);
    const avgDealSize = wonValues.length ? wonValues.reduce((s, v) => s + v, 0) / wonValues.length : null;
    return { wonCount: decidedWon.length, lostCount: decidedLost.length, decided, winRate, avgDealSize, wonValue: wonValues.reduce((s, v) => s + v, 0) };
  }

  const overall = summarize(inWindow);
  overall.pendingCount = pending.length;
  overall.pendingValue = pending.reduce((s, r) => s + Number(r.estimated_value ?? 0), 0);
  overall.lostValue = lost.reduce((s, r) => s + Number(r.estimated_value ?? 0), 0);

  const bySalesperson = {};
  for (const r of inWindow) {
    const name = r.salesperson || 'Unassigned';
    if (!bySalesperson[name]) bySalesperson[name] = [];
    bySalesperson[name].push(r);
  }
  const salespersonRows = Object.entries(bySalesperson)
    .map(([name, list]) => ({ name, ...summarize(list) }))
    .filter(r => r.decided >= SALESPERSON_MIN_DECIDED)
    .sort((a, b) => b.winRate - a.winRate);

  return { windowDays: WIN_LOSS_WINDOW_DAYS, overall, salespersonRows, won, lost };
}

// Reads last week's snapshot for the trend line (both modes), but only
// WRITES this week's row from the Monday 'bd' run — the migration's own
// comment documents "one row per BD-mode run" for exactly this reason. The
// Thursday 'followup' run shares the same week_start key (mondayOf() always
// resolves to that week's Monday regardless of which day it's called on), so
// letting it upsert too would silently overwrite Monday's figures with
// Thursday's every week, corrupting the week-over-week trend the next Monday
// would compare against. Degrades to "no trend" rather than failing the whole
// report if the migration hasn't been applied yet — same convention as
// ar-collections-report.js's gatherAndRecordDSO().
async function gatherAndRecordTrend(mode, openPipelineValue, openPipelineCount, winRate, avgDealSize) {
  const weekStart = mondayOf();
  let prior = null;
  try {
    const { data: priorRows, error: priorErr } = await supabase
      .from('sales_pipeline_snapshots')
      .select('week_start, open_pipeline_value, win_rate')
      .lt('week_start', weekStart)
      .order('week_start', { ascending: false })
      .limit(1);
    if (priorErr) throw priorErr;
    prior = priorRows?.[0] ?? null;

    if (mode === 'bd') {
      const { error: upsertErr } = await supabase
        .from('sales_pipeline_snapshots')
        .upsert({
          week_start: weekStart,
          open_pipeline_value: openPipelineValue,
          open_pipeline_count: openPipelineCount,
          win_rate: winRate,
          avg_deal_size: avgDealSize,
        }, { onConflict: 'week_start' });
      if (upsertErr) throw upsertErr;
    }
  } catch (err) {
    logger.warn('sales_pipeline_report: trend snapshot read/write failed — reporting current figures only', { err: err.message });
  }
  return { prior };
}

// ar-report-helpers.js's ageBadge() has no case for an unresolvable age
// (buildFollowUpQueue() flags those as Infinity rather than dropping them —
// see the comment there) — wrapping locally instead of changing the shared
// helper, which ar-collections-report.js also relies on for real finite ages.
function followUpAgeBadge(days) {
  if (days === Infinity) {
    return `<span style="font-size:11px;color:#c0392b;font-weight:bold;background:#fff0f0;padding:1px 4px;border-radius:2px;">DATE UNKNOWN</span>`;
  }
  return ageBadge(days);
}

function trendLine(current, prior, unit, formatFn) {
  if (prior === null || prior === undefined) {
    return `<span style="color:#888888;">Trend available starting next week (no prior snapshot yet).</span>`;
  }
  const delta = current - prior;
  const arrow = delta > 0 ? '&#9650;' : delta < 0 ? '&#9660;' : '&#9679;';
  const color = unit === 'winRate'
    ? (delta > 0 ? '#1a6e1a' : delta < 0 ? '#c0392b' : '#888888')
    : (delta > 0 ? '#c0392b' : delta < 0 ? '#1a6e1a' : '#888888'); // rising pipeline value is neutral/cautionary, not "bad" — colored like AR's DSO (up=orange-red) only loosely; kept simple here
  return `<span style="color:${color};font-weight:bold;">${arrow} ${formatFn(Math.abs(delta))}</span> vs last week (${formatFn(prior)})`;
}

function buildEmail({ mode, blockLabel, stageOverview, followUp, winLoss, trend, freshness, reportDate }) {
  const isFollowUp = mode === 'followup';
  const followUpMaxRows = isFollowUp ? FOLLOWUP_QUEUE_MAX_ROWS_FULL : FOLLOWUP_QUEUE_MAX_ROWS_CONDENSED;
  const followUpRows = followUp.all.slice(0, followUpMaxRows);
  const title = isFollowUp
    ? `Lead Follow-Up — ${followUp.all.length} overdue`
    : `Business Development — ${stageOverview.openCount} open, ${f$(stageOverview.openValue)} pipeline`;

  let html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title} ${reportDate}</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" style="max-width:620px;background-color:#ffffff;border-radius:6px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

<!-- HEADER -->
<tr><td style="background-color:#1a1a2e;padding:24px 32px;">
  <p style="margin:0;color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:0.5px;">J.R. Boehlke, LLC</p>
  <p style="margin:4px 0 0;color:#aaaacc;font-size:13px;">${isFollowUp ? 'Lead Follow-Up' : 'Sales Pipeline / Business Development'} &nbsp;|&nbsp; ${fD(reportDate)} &nbsp;|&nbsp; ahead of ${blockLabel}</p>
</td></tr>

<!-- BODY -->
<tr><td style="padding:28px 32px;">`;

  if (freshness?.stale) {
    html += alertBox('#fff8f0', '#e6a817', `SA Estimate Data May Be Stale (${freshness.ageHours}h Since Last Sync)`,
      `<p style="margin:0;font-size:13px;color:#533f03;">The BTA estimate-scraper syncs weekly (Sunday) — figures below may not reflect leads/estimates created or updated since the last sync.</p>`);
  }

  // ── Totals bar ────────────────────────────────────────────────────────────
  html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eef1fa;border-radius:4px;margin-bottom:6px;"><tr>
  <td style="padding:14px 12px;text-align:center;border-right:1px solid #d8e0f0;">
    <p style="margin:0;font-size:18px;font-weight:bold;color:#1a1a2e;">${stageOverview.openCount}</p>
    <p style="margin:2px 0 0;font-size:10px;color:#555577;text-transform:uppercase;letter-spacing:0.5px;">Open Pipeline</p>
  </td>
  <td style="padding:14px 12px;text-align:center;border-right:1px solid #d8e0f0;">
    <p style="margin:0;font-size:18px;font-weight:bold;color:#b35900;">${f$(stageOverview.openValue)}</p>
    <p style="margin:2px 0 0;font-size:10px;color:#555577;text-transform:uppercase;letter-spacing:0.5px;">Pipeline Value</p>
  </td>
  <td style="padding:14px 12px;text-align:center;border-right:1px solid #d8e0f0;">
    <p style="margin:0;font-size:18px;font-weight:bold;color:${followUp.all.length ? '#c0392b' : '#1a1a2e'};">${followUp.all.length}</p>
    <p style="margin:2px 0 0;font-size:10px;color:#555577;text-transform:uppercase;letter-spacing:0.5px;">Overdue Follow-Ups</p>
  </td>
  <td style="padding:14px 12px;text-align:center;">
    <p style="margin:0;font-size:18px;font-weight:bold;color:#1a6e1a;">${winLoss.overall.winRate !== null ? winLoss.overall.winRate.toFixed(0) + '%' : '—'}</p>
    <p style="margin:2px 0 0;font-size:10px;color:#555577;text-transform:uppercase;letter-spacing:0.5px;">Win Rate (${winLoss.windowDays}d)</p>
  </td>
</tr></table>`;
  html += `<p style="margin:0 0 20px;font-size:12px;text-align:center;">${trend.pipelineTrendLine}</p>`;

  // ── Follow-up call queue (headline for Lead Follow-Up mode) ─────────────
  html += sectionHeader(isFollowUp ? "This Week's Follow-Up Call Queue" : 'Follow-Ups Needing Attention');
  if (followUp.all.length) {
    html += `<p style="margin:-4px 0 10px;font-size:12px;color:#555577;">${followUp.notYetSentCount} not yet sent &middot; ${followUp.followUpCallCount} awaiting a follow-up call</p>`;
  }
  if (!followUpRows.length) {
    html += `<p style="margin:0 0 16px;font-size:13px;color:#888888;font-style:italic;">Nothing overdue — every open item is within its normal turnaround window.</p>`;
  } else {
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
    <tr style="background-color:#f8f8f8;">
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;width:20px;">#</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;">Client</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;">Action</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Value</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Age</td>
    </tr>`;
    followUpRows.forEach((item, i) => {
      html += `<tr style="background-color:${i % 2 ? '#f8f8f8' : '#ffffff'};">
        <td style="padding:6px 6px;font-size:13px;color:#888888;">${i + 1}</td>
        <td style="padding:6px 6px;font-size:13px;color:#333333;">${item.client}<br><span style="font-size:11px;color:#888888;">#${item.estimateNumber} &middot; ${item.salesperson}</span></td>
        <td style="padding:6px 6px;font-size:12px;color:#555577;">${item.action}</td>
        <td style="padding:6px 6px;font-size:13px;font-weight:bold;color:#b35900;text-align:right;white-space:nowrap;">${f$(item.value)}</td>
        <td style="padding:6px 6px;text-align:right;white-space:nowrap;">${followUpAgeBadge(item.ageDays)}</td>
      </tr>`;
    });
    html += `</table>`;
    if (followUp.all.length > followUpRows.length) {
      html += `<p style="margin:0 0 16px;font-size:11px;color:#aaaaaa;font-style:italic;">+ ${followUp.all.length - followUpRows.length} more overdue item${followUp.all.length - followUpRows.length === 1 ? '' : 's'} not shown.</p>`;
    }
  }
  html += `<p style="margin:-8px 0 16px;font-size:11px;color:#888888;">"Overdue" = Draft estimates unsent ${DRAFT_OVERDUE_DAYS}+ days, or Sent estimates with no decision ${SENT_OVERDUE_DAYS}+ days.</p>`;

  // ── Pipeline by stage ─────────────────────────────────────────────────────
  html += sectionHeader('Open Pipeline by Stage');
  html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
    <tr>
      <td style="padding:5px 6px;font-size:13px;color:#444444;">Not Yet Sent (Draft)</td>
      <td style="padding:5px 6px;font-size:12px;color:#888888;text-align:right;">${stageOverview.draft.count} lead${stageOverview.draft.count === 1 ? '' : 's'}</td>
      <td style="padding:5px 6px;font-size:13px;font-weight:bold;color:#333333;text-align:right;white-space:nowrap;">${f$(stageOverview.draft.value)}</td>
    </tr>
    <tr>
      <td style="padding:5px 6px;font-size:13px;color:#444444;">Sent, Awaiting Response</td>
      <td style="padding:5px 6px;font-size:12px;color:#888888;text-align:right;">${stageOverview.sent.count} lead${stageOverview.sent.count === 1 ? '' : 's'}</td>
      <td style="padding:5px 6px;font-size:13px;font-weight:bold;color:#333333;text-align:right;white-space:nowrap;">${f$(stageOverview.sent.value)}</td>
    </tr>
  </table>`;

  // ── Win rate / average deal size ─────────────────────────────────────────
  html += sectionHeader(`Sales Performance — Sent in Last ${winLoss.windowDays} Days`);
  html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8f8f8;border-radius:4px;margin-bottom:8px;"><tr>
    <td style="padding:12px 10px;text-align:center;border-right:1px solid #e8e8e8;">
      <p style="margin:0;font-size:16px;font-weight:bold;color:#1a6e1a;">${winLoss.overall.wonCount}</p>
      <p style="margin:2px 0 0;font-size:10px;color:#888888;text-transform:uppercase;">Won &middot; ${f$(winLoss.overall.wonValue)}</p>
    </td>
    <td style="padding:12px 10px;text-align:center;border-right:1px solid #e8e8e8;">
      <p style="margin:0;font-size:16px;font-weight:bold;color:#c0392b;">${winLoss.overall.lostCount}</p>
      <p style="margin:2px 0 0;font-size:10px;color:#888888;text-transform:uppercase;">Lost &middot; ${f$(winLoss.overall.lostValue)}</p>
    </td>
    <td style="padding:12px 10px;text-align:center;">
      <p style="margin:0;font-size:16px;font-weight:bold;color:#555577;">${winLoss.overall.avgDealSize !== null ? f$(winLoss.overall.avgDealSize) : '—'}</p>
      <p style="margin:2px 0 0;font-size:10px;color:#888888;text-transform:uppercase;">Avg. Deal Size (Won)</p>
    </td>
  </tr></table>`;

  if (winLoss.salespersonRows.length) {
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
    <tr style="background-color:#f8f8f8;">
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;">Salesperson</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Win Rate</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Avg. Deal Size</td>
    </tr>`;
    winLoss.salespersonRows.forEach((sp, i) => {
      html += `<tr style="background-color:${i % 2 ? '#f8f8f8' : '#ffffff'};">
        <td style="padding:6px 6px;font-size:13px;color:#333333;">${sp.name}</td>
        <td style="padding:6px 6px;font-size:13px;font-weight:bold;color:${sp.winRate >= 50 ? '#1a6e1a' : '#b35900'};text-align:right;">${sp.winRate.toFixed(0)}%</td>
        <td style="padding:6px 6px;font-size:13px;color:#333333;text-align:right;white-space:nowrap;">${sp.avgDealSize !== null ? f$(sp.avgDealSize) : '—'}</td>
      </tr>`;
    });
    html += `</table>`;
  } else {
    html += `<p style="margin:0 0 16px;font-size:12px;color:#888888;font-style:italic;">Not enough decided estimates per salesperson yet this window to break out individually.</p>`;
  }

  // ── Honest data-gap note: response-time SLA ──────────────────────────────
  html += alertBox('#f4f4fb', '#555577', 'Not Included: Lead Response-Time SLA',
    `<p style="margin:0;font-size:12px;color:#333355;">The task calls for tracking how quickly new leads get a first response, but no field in the synced data marks when a lead first came in independently of the first human action taken on it. SA's inbound-lead ticket log (<code>sa_tickets</code>, <code>is_lead</code> flag) only carries a <code>last_updated</code> timestamp — no creation timestamp — and its <code>status</code> field is a numeric SA-internal code that hasn't been decoded (the same live-capture method used to reverse-engineer SA's tag endpoints would be needed first). Rather than compute a response-time metric from a field whose meaning isn't confirmed, this is flagged as a gap. The Follow-Up Call Queue above is the closest honest proxy this system can support today: it flags items overdue for a next action, using only the estimate created and sent dates.</p>`);

  html += `
</td></tr>
</table></td></tr></table>
</body></html>`;

  return html;
}

export async function generateAndSendSalesPipelineReport({ mode = 'followup', blockLabel } = {}) {
  const reportDate = todayISO();
  const effectiveBlockLabel = blockLabel || (mode === 'bd'
    ? 'the 2:00-3:00 PM Business Development block'
    : 'the 9:00-10:00 AM Lead Follow-Up block');

  const { rows, freshness } = await gatherPipelineData();
  const stageOverview = buildStageOverview(rows);
  const followUp = buildFollowUpQueue(rows);
  const winLoss = buildWinLossAndDealSize(rows);

  const { prior } = await gatherAndRecordTrend(
    mode,
    stageOverview.openValue,
    stageOverview.openCount,
    winLoss.overall.winRate,
    winLoss.overall.avgDealSize
  );
  const trend = {
    pipelineTrendLine: trendLine(stageOverview.openValue, prior?.open_pipeline_value ?? null, 'value', f$),
  };

  const body = buildEmail({ mode, blockLabel: effectiveBlockLabel, stageOverview, followUp, winLoss, trend, freshness, reportDate });

  const subject = mode === 'bd'
    ? `Business Development — ${stageOverview.openCount} open, ${f$(stageOverview.openValue)} pipeline | ${fD(reportDate)}`
    : `Lead Follow-Up — ${followUp.all.length} overdue | ${fD(reportDate)}`;

  await sendEmail({
    to: ['michael@jrboehlke.com'],
    subject,
    body,
  });

  logger.info('sales_pipeline_report: sent', {
    mode,
    reportDate,
    openCount: stageOverview.openCount,
    openValue: stageOverview.openValue,
    overdueCount: followUp.all.length,
    winRate: winLoss.overall.winRate,
  });

  return {
    mode,
    reportDate,
    openCount: stageOverview.openCount,
    openValue: stageOverview.openValue,
    overdueCount: followUp.all.length,
    winRate: winLoss.overall.winRate,
    avgDealSize: winLoss.overall.avgDealSize,
  };
}
