// tools/impl/marketing-performance-report.js
// Marketing Performance Report — Monday 12:45 PM, ahead of the 1:00-2:00 PM
// "Marketing Performance" calendar block. Reuses the email template
// conventions from ar-report-helpers.js (see ar-collections-report.js for the
// reference implementation this mirrors).
//
// Data sources:
//   - Google Ads campaign performance: fetched by shelling out to
//     marketing-performance-ads-fetch.py, which imports the already-built,
//     already-authenticated GoogleAdsTools client from the separate
//     google-ads-agent Python daemon on this machine (see that script's
//     header comment for why — avoids re-implementing Google Ads OAuth in
//     Node and a second place for the token to go stale). Degrades to an
//     "unavailable" section rather than failing the whole report if the
//     daemon/venv/API is unreachable.
//   - Won-job counts/revenue: fleetops Supabase `sa_estimates_2026`
//     (stage_name = 'Closed - Won', won_date in the same trailing window as
//     the ad spend), used only for a blended cost-per-won-job estimate.
//
// Known, explicitly accepted gaps (documented here rather than faked):
//   - Lead-source mix (paid vs organic): NOT computable. Checked
//     sa_sent_estimates, sa_accepted_estimates, estimates, and
//     sa_estimates_2026 (fleetops Supabase) — none carry a lead-source,
//     referral, or UTM/channel field. The report says so explicitly instead
//     of guessing. Adding that field (e.g. a CRM intake question, or Google
//     Ads auto-tagging + a landing-page UTM capture) would be a separate,
//     larger project.
//   - Campaign-level ROAS: NOT computable for the same reason — no revenue
//     is attributed back to a specific campaign/click anywhere in the data
//     model. Per-campaign CPA (cost per conversion), which Google Ads does
//     track natively, is shown instead as the closest available proxy.
//   - "Cost per won job" is therefore a BLENDED estimate (total ad spend /
//     total SA-won jobs in the same window, across all lead sources, not
//     just ad-driven ones) — labeled as such in the email, not presented as
//     true attribution. Same "directional, not textbook" spirit as the
//     AR/Collections report's DSO estimate.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { logger } from '../../core/logger.js';
import { sendEmail } from './m365.js';
import { supabase, f$, fD, sectionHeader, alertBox, mondayOf } from './ar-report-helpers.js';
import { gatherWeeklyMarketingIdeas } from './marketing-ideas.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADS_FETCH_SCRIPT = path.join(__dirname, 'marketing-performance-ads-fetch.py');
const PYTHON_BIN = process.env.MARKETING_REPORT_PYTHON_BIN || 'python';
const ADS_FETCH_TIMEOUT_MS = 30_000;
const ADS_PERIOD_DAYS = 7;
const ESTIMATES_STALE_HOURS = 48;

// ── Google Ads fetch (shells out — see file header + the .py script's own
// header for why this isn't a native Node Google Ads client) ───────────────
async function fetchGoogleAdsPerformance(daysBack = ADS_PERIOD_DAYS) {
  try {
    const { stdout } = await execFileAsync(
      PYTHON_BIN,
      [ADS_FETCH_SCRIPT, String(daysBack)],
      { timeout: ADS_FETCH_TIMEOUT_MS }
    );
    const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
    if (!lastLine) throw new Error('empty output from ads fetch script');
    const parsed = JSON.parse(lastLine);
    if (parsed.error) throw new Error(parsed.error);
    return { available: true, campaigns: parsed.campaigns ?? [], periodDays: parsed.period_days ?? daysBack };
  } catch (err) {
    logger.warn('marketing_performance_report: Google Ads fetch failed — section will show unavailable', { err: err.message });
    return { available: false, campaigns: [], periodDays: daysBack, error: err.message };
  }
}

function aggregateAdsMetrics(campaigns, periodDays) {
  const totalSpend = campaigns.reduce((s, c) => s + Number(c.spend_usd ?? 0), 0);
  const totalImpressions = campaigns.reduce((s, c) => s + Number(c.impressions ?? 0), 0);
  const totalClicks = campaigns.reduce((s, c) => s + Number(c.clicks ?? 0), 0);
  const totalConversions = campaigns.reduce((s, c) => s + Number(c.conversions ?? 0), 0);
  const blendedCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
  const blendedCpc = totalClicks > 0 ? totalSpend / totalClicks : 0;
  const costPerLead = totalConversions > 0 ? totalSpend / totalConversions : null;
  // Budget pacing is scoped to ENABLED campaigns only — a paused campaign's
  // daily_budget_usd still exists in the API response but it isn't spending,
  // so including it would understate pacing against real committed spend.
  const dailyBudgetTotal = campaigns
    .filter(c => c.status === 'ENABLED')
    .reduce((s, c) => s + Number(c.daily_budget_usd ?? 0), 0);
  const budgetTotal = dailyBudgetTotal * periodDays;
  const pacingPct = budgetTotal > 0 ? (totalSpend / budgetTotal) * 100 : null;

  return { totalSpend, totalImpressions, totalClicks, totalConversions, blendedCtr, blendedCpc, costPerLead, budgetTotal, pacingPct };
}

// ── SA won-jobs (blended cost-per-won-job — see file header caveat) ───────
// Filters on `stage` = 'Won' (short code), matching how every other consumer
// of sa_estimates_2026 in the BTA Reporting scripts (estimate-scraper.js,
// lead-matcher.js, sheets-formatter.js) filters — `stage_name` = 'Closed - Won'
// is the equivalent display-label value today (confirmed 1:1, 498/498 rows)
// but `stage` is the more robust column to key off if the display label ever
// changes. Known accepted gap: ~2% of 'Won' rows in the live data have a null
// won_date (can't be placed in a date-range window at all, e.g. an estimate
// whose won_date was never backfilled) — these are silently excluded from
// both the count and revenue sum here, same as any other date-range query
// would exclude an undated row. Not fixed here; a data-quality issue in the
// upstream SA scrape, out of scope for this report.
async function gatherWonJobs(periodStartISO, periodEndISO) {
  try {
    const { data, error } = await supabase
      .from('sa_estimates_2026')
      .select('estimate_id, estimated_value, won_date, extracted_at')
      .eq('stage', 'Won')
      .gte('won_date', periodStartISO)
      .lt('won_date', periodEndISO);
    if (error) throw error;
    const rows = data ?? [];
    const wonJobCount = rows.length;
    const wonRevenue = rows.reduce((s, r) => s + Number(r.estimated_value ?? 0), 0);
    return { available: true, wonJobCount, wonRevenue };
  } catch (err) {
    logger.warn('marketing_performance_report: won-jobs query failed — cost-per-won-job will be unavailable', { err: err.message });
    return { available: false, wonJobCount: 0, wonRevenue: 0, error: err.message };
  }
}

// Single source of truth for the blended cost-per-won-job formula, shared by
// the snapshot writer and the email body so the two can never desync.
function computeCostPerWonJob(metrics, wonJobs) {
  return wonJobs.available && wonJobs.wonJobCount > 0 ? metrics.totalSpend / wonJobs.wonJobCount : null;
}

async function gatherFreshnessStatus() {
  try {
    const { data, error } = await supabase
      .from('sa_estimates_2026')
      .select('extracted_at')
      .order('extracted_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    const ts = data?.[0]?.extracted_at ? new Date(data[0].extracted_at).getTime() : 0;
    if (!ts) return { stale: true, ageHours: 999 };
    const ageHours = Math.round((Date.now() - ts) / 3600000);
    return { stale: ageHours > ESTIMATES_STALE_HOURS, ageHours };
  } catch (err) {
    logger.warn('marketing_performance_report: freshness check failed', { err: err.message });
    return { stale: true, ageHours: 999 };
  }
}

// Reads last week's snapshot for the WoW trend, writes this week's row.
// The marketing_performance_snapshots table may not exist yet if its
// migration hasn't been applied — degrades to "no trend" rather than
// failing the whole report (same pattern as ar_dso_snapshots).
//
// If the won-jobs query itself failed (wonJobs.available === false), the
// week is NOT persisted at all — won_job_count/won_revenue are NOT NULL
// columns, so writing them as 0 on a query failure would fabricate a "zero
// wins this week" data point that corrupts every future week's trend
// comparison. Better to have a missing week than a wrong one.
async function gatherAndRecordSnapshot(weekStart, metrics, wonJobs) {
  let previous = null;
  try {
    const { data: prior, error: priorErr } = await supabase
      .from('marketing_performance_snapshots')
      .select('week_start, total_spend, cost_per_lead, conversions')
      .lt('week_start', weekStart)
      .order('week_start', { ascending: false })
      .limit(1);
    if (priorErr) throw priorErr;
    previous = prior?.[0] ?? null;

    if (!wonJobs.available) {
      logger.warn('marketing_performance_report: skipping snapshot write — won-jobs data unavailable this run');
      return previous;
    }

    const { error: upsertErr } = await supabase
      .from('marketing_performance_snapshots')
      .upsert({
        week_start: weekStart,
        total_spend: metrics.totalSpend,
        impressions: metrics.totalImpressions,
        clicks: metrics.totalClicks,
        ctr: metrics.blendedCtr,
        avg_cpc: metrics.blendedCpc,
        conversions: metrics.totalConversions,
        cost_per_lead: metrics.costPerLead,
        budget_total: metrics.budgetTotal,
        pacing_pct: metrics.pacingPct,
        won_job_count: wonJobs.wonJobCount,
        won_revenue: wonJobs.wonRevenue,
        cost_per_won_job: computeCostPerWonJob(metrics, wonJobs),
      }, { onConflict: 'week_start' });
    if (upsertErr) throw upsertErr;
  } catch (err) {
    logger.warn('marketing_performance_report: snapshot read/write failed — reporting current week only', { err: err.message });
  }
  return previous;
}

// neutral:true renders the arrow without a good/bad color judgment — spend
// going up or down isn't inherently "better" or "worse" the way DSO or
// cost-per-lead are, so it would be misleading to paint it green/red.
function trendLine(label, current, previous, { lowerIsBetter = false, neutral = false, fmt = f$ } = {}) {
  if (previous === null || previous === undefined) {
    return `<span style="color:#888888;">${label} trend available starting next week (no prior snapshot yet).</span>`;
  }
  const delta = current - previous;
  const arrow = delta > 0 ? '&#9650;' : delta < 0 ? '&#9660;' : '&#9679;';
  let color = '#888888';
  if (!neutral) {
    const improved = lowerIsBetter ? delta < 0 : delta > 0;
    const worsened = lowerIsBetter ? delta > 0 : delta < 0;
    color = improved ? '#1a6e1a' : worsened ? '#c0392b' : '#888888';
  }
  return `<span style="color:${color};font-weight:bold;">${arrow} ${fmt(Math.abs(delta))}</span> ${label} vs last week (${fmt(previous)})`;
}

// Cost-per-lead needs its own trend logic rather than reusing trendLine
// directly: both the current and prior period can legitimately be null
// (zero conversions that week), and null must never be silently coerced to
// 0 -- that would read "no leads generated" as "leads got free," rendering
// a false green improvement arrow. Also distinguishes "no prior snapshot
// row at all" from "a prior row exists but it also had zero conversions."
function costPerLeadTrendLine(current, previousRow) {
  if (previousRow === null || previousRow === undefined) {
    return `<span style="color:#888888;">Cost/Lead trend available starting next week (no prior snapshot yet).</span>`;
  }
  const previous = previousRow.cost_per_lead;
  if (current === null && (previous === null || previous === undefined)) {
    return `<span style="color:#888888;">Cost/Lead trend unavailable — no conversions this week or last week.</span>`;
  }
  if (current === null) {
    return `<span style="color:#c0392b;font-weight:bold;">No leads generated this week</span> (last week: ${f$(previous)}/lead)`;
  }
  if (previous === null || previous === undefined) {
    return `<span style="color:#888888;">Cost/Lead trend unavailable — last week had no conversions to compare against.</span>`;
  }
  return trendLine('Cost/Lead', current, previous, { lowerIsBetter: true });
}

function statusBadge(status) {
  const color = status === 'ENABLED' ? '#1a6e1a' : status === 'PAUSED' ? '#888888' : '#b35900';
  return `<span style="font-size:10px;font-weight:bold;color:${color};text-transform:uppercase;">${status}</span>`;
}

function buildEmail({ weekStart, ads, metrics, previous, wonJobs, freshness, periodDays, ideas }) {
  const costPerWonJob = computeCostPerWonJob(metrics, wonJobs);

  let html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Marketing Performance Report ${weekStart}</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" style="max-width:640px;background-color:#ffffff;border-radius:6px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

<!-- HEADER -->
<tr><td style="background-color:#1a1a2e;padding:24px 32px;">
  <p style="margin:0;color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:0.5px;">J.R. Boehlke, LLC</p>
  <p style="margin:4px 0 0;color:#aaaacc;font-size:13px;">Marketing Performance Report &nbsp;|&nbsp; Trailing ${periodDays} Days Ending ${fD(new Date().toISOString().slice(0, 10))}</p>
</td></tr>

<!-- BODY -->
<tr><td style="padding:28px 32px;">`;

  if (!ads.available) {
    html += alertBox('#fff0f0', '#c0392b', 'Google Ads Data Unavailable',
      `<p style="margin:0;font-size:13px;color:#533f03;">Could not reach the Google Ads data source this run — spend/campaign figures below are all zero/blank rather than real. Error: ${(ads.error || 'unknown').slice(0, 200)}</p>`);
  }
  if (!wonJobs.available) {
    html += alertBox('#fff0f0', '#c0392b', 'Won-Job Data Unavailable',
      `<p style="margin:0;font-size:13px;color:#533f03;">Could not read won-job figures from SA data this run — "Business Outcomes" below shows 0/blank rather than real numbers, and this week was NOT recorded to the trend history. Error: ${(wonJobs.error || 'unknown').slice(0, 200)}</p>`);
  } else if (freshness?.stale) {
    html += alertBox('#fff8f0', '#e6a817', `SA Estimate Data May Be Stale (${freshness.ageHours}h Since Last Sync)`,
      `<p style="margin:0;font-size:13px;color:#533f03;">Won-job counts/revenue below may not reflect the most recent wins.</p>`);
  }

  // ── Top metrics bar ──────────────────────────────────────────────────────
  html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eef1fa;border-radius:4px;margin-bottom:6px;"><tr>
  <td style="padding:14px 10px;text-align:center;border-right:1px solid #d8e0f0;">
    <p style="margin:0;font-size:19px;font-weight:bold;color:#b35900;">${f$(metrics.totalSpend)}</p>
    <p style="margin:2px 0 0;font-size:10px;color:#555577;text-transform:uppercase;letter-spacing:0.5px;">Ad Spend</p>
  </td>
  <td style="padding:14px 10px;text-align:center;border-right:1px solid #d8e0f0;">
    <p style="margin:0;font-size:19px;font-weight:bold;color:#1a1a2e;">${metrics.costPerLead !== null ? f$(metrics.costPerLead) : '—'}</p>
    <p style="margin:2px 0 0;font-size:10px;color:#555577;text-transform:uppercase;letter-spacing:0.5px;">Cost / Lead</p>
  </td>
  <td style="padding:14px 10px;text-align:center;">
    <p style="margin:0;font-size:19px;font-weight:bold;color:${metrics.pacingPct !== null && metrics.pacingPct > 110 ? '#c0392b' : '#1a1a2e'};">${metrics.pacingPct !== null ? metrics.pacingPct.toFixed(0) + '%' : '—'}</p>
    <p style="margin:2px 0 0;font-size:10px;color:#555577;text-transform:uppercase;letter-spacing:0.5px;">Budget Pacing</p>
  </td>
</tr></table>`;
  html += `<p style="margin:0 0 4px;font-size:12px;text-align:center;">${trendLine('Spend', metrics.totalSpend, previous?.total_spend ?? null, { neutral: true })}</p>`;
  html += `<p style="margin:0 0 20px;font-size:12px;text-align:center;">${costPerLeadTrendLine(metrics.costPerLead, previous)}</p>`;

  // ── Spend & efficiency snapshot ──────────────────────────────────────────
  html += sectionHeader('Spend & Efficiency Snapshot');
  const snapshotRows = [
    ['Impressions', metrics.totalImpressions.toLocaleString('en-US')],
    ['Clicks', metrics.totalClicks.toLocaleString('en-US')],
    ['CTR (blended)', metrics.blendedCtr.toFixed(2) + '%'],
    ['Avg. CPC (blended)', f$(metrics.blendedCpc)],
    ['Conversions (leads)', metrics.totalConversions.toFixed(1)],
  ];
  html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">`;
  for (const [label, value] of snapshotRows) {
    html += `<tr>
      <td style="padding:5px 6px;font-size:13px;color:#444444;">${label}</td>
      <td style="padding:5px 6px;font-size:13px;font-weight:bold;color:#1a1a2e;text-align:right;white-space:nowrap;">${value}</td>
    </tr>`;
  }
  html += `</table>`;

  // ── Budget pacing detail ─────────────────────────────────────────────────
  html += sectionHeader('Budget Pacing');
  if (metrics.budgetTotal > 0) {
    const pacingNote = metrics.pacingPct > 110
      ? `<span style="color:#c0392b;font-weight:bold;">Over pace</span> — spend is running ahead of the combined daily budgets for the period.`
      : metrics.pacingPct < 80
        ? `<span style="color:#b35900;font-weight:bold;">Under pace</span> — budget is being left on the table; consider whether bids/targeting are limiting delivery.`
        : `<span style="color:#1a6e1a;font-weight:bold;">On pace</span>.`;
    html += `<p style="margin:0 0 16px;font-size:13px;color:#444444;">${f$(metrics.totalSpend)} spent against ${f$(metrics.budgetTotal)} of combined daily budget for enabled campaigns over ${periodDays} days (${metrics.pacingPct.toFixed(0)}%). ${pacingNote}</p>`;
  } else {
    html += `<p style="margin:0 0 16px;font-size:13px;color:#888888;font-style:italic;">No enabled-campaign budget data available this run.</p>`;
  }

  // ── Campaign performance table ───────────────────────────────────────────
  html += sectionHeader('Campaign Performance');
  if (!ads.campaigns.length) {
    html += `<p style="margin:0 0 16px;font-size:13px;color:#888888;font-style:italic;">No campaign data available this run.</p>`;
  } else {
    const sorted = [...ads.campaigns].sort((a, b) => (b.spend_usd ?? 0) - (a.spend_usd ?? 0));
    html += `<div style="overflow-x:auto;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;min-width:560px;">
    <tr style="background-color:#f8f8f8;">
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;">Campaign</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Spend</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Impr.</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">CTR</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">CPC</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Conv.</td>
      <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">CPA</td>
    </tr>`;
    sorted.forEach((c, i) => {
      html += `<tr style="background-color:${i % 2 ? '#f8f8f8' : '#ffffff'};">
        <td style="padding:6px 6px;font-size:12px;color:#333333;">${c.name}<br>${statusBadge(c.status)}</td>
        <td style="padding:6px 6px;font-size:12px;font-weight:bold;color:#b35900;text-align:right;white-space:nowrap;">${f$(c.spend_usd ?? 0)}</td>
        <td style="padding:6px 6px;font-size:12px;color:#444444;text-align:right;">${Number(c.impressions ?? 0).toLocaleString('en-US')}</td>
        <td style="padding:6px 6px;font-size:12px;color:#444444;text-align:right;">${Number(c.ctr ?? 0).toFixed(2)}%</td>
        <td style="padding:6px 6px;font-size:12px;color:#444444;text-align:right;">${f$(c.avg_cpc_usd ?? 0)}</td>
        <td style="padding:6px 6px;font-size:12px;color:#444444;text-align:right;">${Number(c.conversions ?? 0).toFixed(1)}</td>
        <td style="padding:6px 6px;font-size:12px;color:#444444;text-align:right;">${c.cpa_usd !== null && c.cpa_usd !== undefined ? f$(c.cpa_usd) : '—'}</td>
      </tr>`;
    });
    html += `</table></div>`;
    html += `<p style="margin:-4px 0 16px;font-size:11px;color:#888888;">Campaign-level ROAS not shown — no revenue is attributed back to a specific campaign anywhere in the data model. CPA (cost per conversion) is the closest available proxy.</p>`;
  }

  // ── Business outcomes ────────────────────────────────────────────────────
  html += sectionHeader('Business Outcomes (Blended, Not Ad-Attributed)');
  html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:4px;"><tr>
    <td style="padding:5px 6px;font-size:13px;color:#444444;">SA jobs won this period</td>
    <td style="padding:5px 6px;font-size:13px;font-weight:bold;color:#1a1a2e;text-align:right;">${wonJobs.wonJobCount}</td>
  </tr><tr>
    <td style="padding:5px 6px;font-size:13px;color:#444444;">Won revenue this period</td>
    <td style="padding:5px 6px;font-size:13px;font-weight:bold;color:#1a1a2e;text-align:right;">${f$(wonJobs.wonRevenue)}</td>
  </tr><tr>
    <td style="padding:5px 6px;font-size:13px;color:#444444;">Blended cost per won job</td>
    <td style="padding:5px 6px;font-size:13px;font-weight:bold;color:#1a1a2e;text-align:right;">${costPerWonJob !== null ? f$(costPerWonJob) : '—'}</td>
  </tr></table>`;
  html += `<p style="margin:0 0 16px;font-size:11px;color:#888888;">"Blended" = total ad spend ÷ all SA-won jobs in the period, across every lead source (referral, repeat, organic, and paid) — not just ad-driven wins. There is no click/lead-to-job attribution link in the data today, so this is a directional efficiency ratio, not true ROAS.</p>`;

  // ── Lead source mix (explicit gap) ───────────────────────────────────────
  html += sectionHeader('Lead Source Mix (Paid vs. Organic)');
  html += alertBox('#fff8f0', '#e6a817', 'Not Currently Computable',
    `<p style="margin:0;font-size:13px;color:#533f03;">No lead-source, referral, or UTM/channel field exists yet on the SA estimate/lead records this report can see (checked <code>sa_sent_estimates</code>, <code>sa_accepted_estimates</code>, <code>estimates</code>, <code>sa_estimates_2026</code>). Adding one — e.g. a CRM intake question or landing-page UTM capture — would let a future version of this report split paid vs. organic leads and jobs.</p>`);

  // ── Marketing ideas (segment scan + pending campaigns) ───────────────────
  html += buildMarketingIdeasSection(ideas);

  html += `
</td></tr>
</table></td></tr></table>
</body></html>`;

  return html;
}

// Built 2026-08-25 alongside the new marketing-agent taskType/tools. Reads
// back this week's already-computed segment scan + pending campaign
// proposals — see marketing-ideas.js's header for why this doesn't run
// identifySegment() live inside this time-sensitive send. Ideas/drafts only
// — nothing here sends an email or touches SA; that only happens once
// Michael reviews and tells the marketing-advisor agent to proceed.
function buildMarketingIdeasSection(ideas) {
  let html = sectionHeader('Marketing Ideas');

  if (!ideas.available) {
    return html + alertBox('#fff0f0', '#c0392b', 'Marketing Ideas Unavailable',
      `<p style="margin:0;font-size:13px;color:#533f03;">Could not read this week's segment scan or pending campaigns. Error: ${(ideas.error || 'unknown').slice(0, 200)}</p>`);
  }

  if (ideas.segmentsByCategory.length === 0 && ideas.pendingCampaigns.length === 0) {
    return html + `<p style="margin:0 0 16px;font-size:13px;color:#888888;font-style:italic;">No new segment scan results or pending campaign proposals this week.</p>`;
  }

  if (ideas.segmentsByCategory.length > 0) {
    html += `<p style="margin:0 0 8px;font-size:13px;color:#444444;">This week's re-engagement segment scan:</p>`;
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">`;
    for (const s of ideas.segmentsByCategory) {
      html += `<tr>
        <td style="padding:5px 6px;font-size:13px;color:#444444;">${s.serviceCategory}</td>
        <td style="padding:5px 6px;font-size:13px;color:#1a1a2e;text-align:right;">${s.clean} candidates${s.flagged ? `, ${s.flagged} flagged for review` : ''}</td>
      </tr>`;
    }
    html += `</table>`;
    html += `<p style="margin:-8px 0 16px;font-size:11px;color:#888888;">Ask the marketing-advisor agent (taskType "marketing") to walk through a category via the identify-reengagement-segment skill for the full candidate list before deciding whether to run a campaign.</p>`;
  }

  if (ideas.pendingCampaigns.length > 0) {
    html += `<p style="margin:0 0 8px;font-size:13px;color:#444444;">Campaigns proposed but not yet approved:</p>`;
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">`;
    for (const c of ideas.pendingCampaigns) {
      html += `<tr>
        <td style="padding:5px 6px;font-size:13px;color:#444444;">${c.campaign_name}</td>
        <td style="padding:5px 6px;font-size:13px;color:#1a1a2e;text-align:right;">${c.client_count ?? '—'} clients</td>
      </tr>`;
    }
    html += `</table>`;
  }

  return html;
}

export async function generateAndSendMarketingPerformanceReport() {
  const weekStart = mondayOf();
  const now = new Date();
  const periodStart = new Date(now.getTime() - ADS_PERIOD_DAYS * 86400000);
  const periodStartISO = periodStart.toISOString();
  const periodEndISO = now.toISOString();

  const [ads, wonJobs, freshness, ideas] = await Promise.all([
    fetchGoogleAdsPerformance(ADS_PERIOD_DAYS),
    gatherWonJobs(periodStartISO, periodEndISO),
    gatherFreshnessStatus(),
    gatherWeeklyMarketingIdeas(),
  ]);

  const metrics = aggregateAdsMetrics(ads.campaigns, ads.periodDays);
  const previous = await gatherAndRecordSnapshot(weekStart, metrics, wonJobs);

  const body = buildEmail({ weekStart, ads, metrics, previous, wonJobs, freshness, periodDays: ads.periodDays, ideas });

  await sendEmail({
    to: ['michael@jrboehlke.com'],
    subject: `Marketing Performance — Week of ${fD(weekStart)} | ${f$(metrics.totalSpend)} spent, ${metrics.totalConversions.toFixed(0)} leads`,
    body,
  });

  logger.info('marketing_performance_report: sent', {
    weekStart,
    totalSpend: metrics.totalSpend,
    conversions: metrics.totalConversions,
    wonJobCount: wonJobs.wonJobCount,
    adsAvailable: ads.available,
  });
  return { weekStart, totalSpend: metrics.totalSpend, conversions: metrics.totalConversions, wonJobCount: wonJobs.wonJobCount, adsAvailable: ads.available };
}
