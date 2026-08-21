// tools/impl/overnight-report.js — Daily morning SA activity report
// Sends at 6 AM to michael@jrboehlke.com via the scheduler/cron.js task.
// Also serves as the content for Michael's 8:00-8:25 AM "Operations Pulse"
// calendar block — the 6 AM send time already lands well before that block,
// so no second cron/send was added; see "Weather Watch" and "Overnight
// System Exceptions" below, added 2026-08-21 specifically for that block's
// needs (deliberately folded into this report rather than a new one, since
// today's dispatch/crew assignments were already fully covered by sections
// 6 & 7 below).
//
// Sections:
//   1. Weather Watch                    — today's forecast + a schedule-risk flag
//   2. Overnight System Exceptions      — failed agent_tasks rows + deduped agent.log errors
//   3. Jobs accepted since last report  — Won estimates first seen as Won in this run
//   4. Accepted — awaiting waiting list — Won estimates created ≤45 days ago, not on WL/dispatch
//   5. Estimates sent since last report — Sent estimates first seen as Sent in this run
//   6. Estimates created — not yet sent — Current Draft estimates, oldest first
//   7. Aging estimates                  — Sent 7+ days ago, no acceptance
//   8. Today's dispatch                 — sa_jobs for today, grouped by crew
//   9. Waiting list by crew             — sa_waiting_list with crew assignments
//
// Stage-change detection (sections 3 & 5):
//   Loads estimate IDs from sa_accepted_estimates / sa_sent_estimates BEFORE upserting.
//   Estimates not yet in the table = first time seen in that stage = transition happened
//   since the last report run. No QuoteDate dependency; no timestamp windows.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';
import { getEstimateList } from './serviceautopilot.js';
import { getWeatherForecast } from './scheduling.js';

// ── Supabase clients ──────────────────────────────────────────────────────────

function fleetops() {
  return createClient(
    process.env.FLEETOPS_SUPABASE_URL,
    process.env.FLEETOPS_SUPABASE_SERVICE_KEY,
  );
}

// agent_tasks lives in the main jrb-assistant Supabase project (SUPABASE_URL/
// SUPABASE_SERVICE_KEY), not fleetops — see scheduler/task-poller.js and
// CLAUDE.md's Supabase table list.
function mainDb() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
  );
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return startOfDay(d);
}

function today() { return startOfDay(new Date()); }
function yesterday() { return daysAgo(1); }

function formatDate(d) {
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function isoDate(d) { return d.toISOString().split('T')[0]; }

function daysBetween(a, b) {
  return Math.floor((b - a) / 86400000);
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmt$(amount) {
  if (amount == null || isNaN(amount) || amount === 0) return '—';
  return '$' + Number(amount).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function totalOf(rows) {
  return rows.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
}

// ── SA field extraction ───────────────────────────────────────────────────────
// V2EstimateList_Query BFF uses PascalCase fields; fall back across common variants.

function extractEstimate(e) {
  // V2EstimateList_Query actual field names confirmed via probe 2026-06-19
  const amount = parseFloat(e.EstimatedValue ?? 0);
  // SA QuoteDate.Month is 0-indexed (Month:5 = June) — use directly, no -1
  const quoteDate = e.QuoteDate?.IsValid
    ? new Date(e.QuoteDate.Year, e.QuoteDate.Month, e.QuoteDate.Day)
    : null;

  return {
    estimateId:   e.ID || '',
    estimateNum:  e.Number || '',
    clientName:   e.ClientName || '—',
    clientId:     e.ClientID || '',
    address:      e.ClientAddress || '—',
    salesRep:     e.SalesPersonName || '—',
    serviceType:  '—',
    amount,
    stage:        e.QuoteStageType || '',
    quoteDate,
    quoteDateStr: quoteDate ? isoDate(quoteDate) : null,
  };
}

// ── Section 1 & 2: Won estimates ─────────────────────────────────────────────
// Section 1 "Newly Accepted": estimates first detected as Won in THIS run.
//   Detection: load existing IDs from sa_accepted_estimates before upserting.
//   Estimates not previously tracked = transitioned to Won since last report.
// Section 2 "Awaiting WL": Won estimates created ≤45 days ago whose client
//   isn't on the waiting list or upcoming dispatch. The 45-day window prevents
//   old completed estimates from flooding the list.

// sa_accepted_estimates.resolved_at is never written anywhere else — this backlog
// otherwise grows unbounded (2,828+ rows observed, 0 ever resolved). Considers an
// estimate resolved once its client has a later job or waiting-list entry, proving
// the estimate actually turned into scheduled work. Uses maps instead of a nested
// scan since sa_jobs alone runs 25k+ rows.
async function resolveWonEstimates(db) {
  const { data: wlRows }  = await db.from('sa_waiting_list').select('client_id, date_added').not('client_id', 'is', null);
  const { data: jobRows } = await db.from('sa_jobs').select('customer_id, start_date').not('customer_id', 'is', null);
  const { data: pending } = await db.from('sa_accepted_estimates')
    .select('estimate_id, client_id, quote_date').is('resolved_at', null);

  if (!pending?.length) return;

  const maxJobDateByClient = new Map();
  for (const j of jobRows || []) {
    const prev = maxJobDateByClient.get(j.customer_id);
    if (!prev || j.start_date > prev) maxJobDateByClient.set(j.customer_id, j.start_date);
  }
  const maxWlDateByClient = new Map(); // missing date_added treated as "always qualifies" via a sentinel far-future date
  for (const w of wlRows || []) {
    const d = w.date_added || '9999-12-31';
    const prev = maxWlDateByClient.get(w.client_id);
    if (!prev || d > prev) maxWlDateByClient.set(w.client_id, d);
  }

  const toResolve = pending.filter(e => {
    const q = e.quote_date || '0000-01-01';
    const jobDate = maxJobDateByClient.get(e.client_id);
    const wlDate = maxWlDateByClient.get(e.client_id);
    return (jobDate && jobDate >= q) || (wlDate && wlDate >= q);
  }).map(e => e.estimate_id);

  if (toResolve.length > 0) {
    const { error } = await db.from('sa_accepted_estimates')
      .update({ resolved_at: new Date().toISOString(), resolved_reason: 'matched_job_or_wl' })
      .in('estimate_id', toResolve);
    if (error) { logger.warn('overnight-report: resolveWonEstimates update failed', { error: error.message }); return; }
  }
  logger.info('overnight-report: resolved stale estimates', { count: toResolve.length });
}

async function syncWonEstimates() {
  const db = fleetops();
  await resolveWonEstimates(db);

  const raw = await getEstimateList({ dateFrom: daysAgo(365), dateTo: today(), stages: ['Won'], max: 2000 });
  // Stage filter is ignored server-side — must filter client-side on QuoteStageType
  const estimates = raw.filter(e => e.QuoteStageType === 'Won').map(extractEstimate).filter(e => e.estimateId);
  logger.info('overnight-report: Won estimates from SA', { count: estimates.length });

  // Load IDs already in the tracker BEFORE upserting
  const { data: existing, error: readErr } = await db.from('sa_accepted_estimates').select('estimate_id');
  if (readErr) throw new Error(`sa_accepted_estimates read failed: ${readErr.message}`);
  const existingIds = new Set((existing || []).map(r => r.estimate_id));

  // Upsert all Won estimates — ignoreDuplicates preserves first_seen_at for known rows
  if (estimates.length > 0) {
    const rows = estimates.map(e => ({
      estimate_id:     e.estimateId,
      estimate_number: e.estimateNum,
      client_name:     e.clientName,
      client_id:       e.clientId,
      address:         e.address,
      sales_rep:       e.salesRep,
      service_type:    e.serviceType,
      amount:          e.amount,
      quote_date:      e.quoteDateStr,
    }));
    const { error } = await db
      .from('sa_accepted_estimates')
      .upsert(rows, { onConflict: 'estimate_id', ignoreDuplicates: true });
    if (error) logger.warn('overnight-report: sa_accepted_estimates upsert error', { error: error.message });
  }

  // Section 1: estimates not in DB before this run = first time seen as Won
  const acceptedYesterday = estimates
    .filter(e => !existingIds.has(e.estimateId))
    .sort((a, b) => (a.clientName || '').localeCompare(b.clientName || ''));

  // Section 2: Won estimates created ≤45 days ago, client not on WL or upcoming dispatch
  const { data: wlRows }   = await db.from('sa_waiting_list').select('client_id').not('client_id', 'is', null);
  const { data: dispRows } = await db.from('sa_jobs').select('customer_id').gte('start_date', isoDate(today())).not('customer_id', 'is', null);

  const coveredClientIds = new Set([
    ...(wlRows  || []).map(r => r.client_id),
    ...(dispRows || []).map(r => r.customer_id),
  ]);

  const cutoff45 = daysAgo(45);
  const outstanding = estimates
    .filter(e => e.clientId && !coveredClientIds.has(e.clientId) && e.quoteDate && e.quoteDate >= cutoff45)
    .sort((a, b) => (a.clientName || '').localeCompare(b.clientName || ''));

  return { acceptedYesterday, outstanding };
}

// ── Section 3: Estimates sent since last report ───────────────────────────────
// Uses sa_sent_estimates table. Estimates not previously tracked = first time
// seen as Sent = sent since the last report run.

async function syncSentEstimates() {
  const db = fleetops();

  const raw = await getEstimateList({ dateFrom: daysAgo(365), dateTo: today(), stages: ['Sent'], max: 2000 });
  // Stage filter is ignored server-side — must filter client-side on QuoteStageType
  const estimates = raw.filter(e => e.QuoteStageType === 'Sent').map(extractEstimate).filter(e => e.estimateId);
  logger.info('overnight-report: Sent estimates from SA', { count: estimates.length });

  // Load IDs already tracked BEFORE upserting
  const { data: existing, error: readErr } = await db.from('sa_sent_estimates').select('estimate_id');
  if (readErr) throw new Error(`sa_sent_estimates read failed: ${readErr.message}`);
  const existingIds = new Set((existing || []).map(r => r.estimate_id));

  if (estimates.length > 0) {
    const rows = estimates.map(e => ({
      estimate_id:     e.estimateId,
      estimate_number: e.estimateNum,
      client_name:     e.clientName,
      client_id:       e.clientId,
      address:         e.address,
      sales_rep:       e.salesRep,
      service_type:    e.serviceType,
      amount:          e.amount,
      quote_date:      e.quoteDateStr,
    }));
    const { error } = await db
      .from('sa_sent_estimates')
      .upsert(rows, { onConflict: 'estimate_id', ignoreDuplicates: true });
    if (error) logger.warn('overnight-report: sa_sent_estimates upsert error', { error: error.message });
  }

  // Return estimates not previously tracked = first time seen as Sent
  return estimates
    .filter(e => !existingIds.has(e.estimateId))
    .sort((a, b) => (a.salesRep || '').localeCompare(b.salesRep || '') || (a.clientName || '').localeCompare(b.clientName || ''));
}

// ── Draft estimates — created but not yet sent ────────────────────────────────

async function getDraftEstimates() {
  const raw = await getEstimateList({ dateFrom: daysAgo(90), dateTo: today(), stages: ['Draft'], max: 500 });
  // Stage filter is ignored server-side — must filter client-side on QuoteStageType
  const drafts = raw
    .filter(e => e.QuoteStageType === 'Draft')
    .map(extractEstimate)
    .filter(e => e.estimateId)
    .map(e => ({
      ...e,
      daysOld: e.quoteDate ? daysBetween(e.quoteDate, new Date()) : null,
    }));
  logger.info('overnight-report: Draft estimates from SA', { count: drafts.length });
  // Sort oldest first; null-date estimates go to bottom
  return drafts.sort((a, b) => (b.daysOld ?? -Infinity) - (a.daysOld ?? -Infinity));
}

// ── Section 4: Aging estimates ────────────────────────────────────────────────

async function getAgingEstimates() {
  const raw = await getEstimateList({
    dateFrom: daysAgo(60),
    dateTo:   daysAgo(7),
    stages:   ['Sent'],
    max:      200,
  });
  return raw
    .filter(e => e.QuoteStageType === 'Sent')
    .map(extractEstimate)
    .filter(e => e.estimateId)
    .map(e => ({
      ...e,
      daysOut: e.quoteDate ? daysBetween(e.quoteDate, new Date()) : null,
    }))
    .sort((a, b) => b.amount - a.amount);
}

// ── Section 5: Today's dispatch ───────────────────────────────────────────────

async function getTodayJobs() {
  const db = fleetops();
  const todayStr = isoDate(today());
  const { data, error } = await db
    .from('sa_jobs')
    .select('id, client, address, service, assigned, amount, status')
    .eq('start_date', todayStr)
    .order('assigned', { nullsFirst: false })
    .order('client');

  if (error) {
    logger.warn('overnight-report: sa_jobs query error', { error: error.message });
    return [];
  }

  // Deduplicate by job id (same job may appear twice from sync overlap)
  const seen = new Set();
  return (data || []).filter(r => {
    if (!r.id || seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

async function getAssignedWaitingListJobs() {
  const db = fleetops();
  const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';
  const { data, error } = await db
    .from('sa_waiting_list')
    .select('job_id, client_name, address, service_code, assigned, amount, target_date')
    .not('assigned', 'is', null)
    .neq('assigned', '')
    .neq('assigned', EMPTY_GUID)
    .order('assigned')
    .order('target_date', { nullsFirst: false })
    .order('client_name');
  if (error) {
    logger.warn('overnight-report: sa_waiting_list query error', { error: error.message });
    return [];
  }
  return data || [];
}

// ── Weather Watch ──────────────────────────────────────────────────────────────
// Reuses the existing Open-Meteo integration in scheduling.js (no API key, no
// new external dependency) rather than building a separate weather client.
// Degrades to null on any failure — same "nicety, not critical path" pattern
// google-maps.js uses for drive-time, per Michael's decision there.

async function getTodayWeather() {
  try {
    const days = await getWeatherForecast({ days: 1 });
    return days[0] || null;
  } catch (err) {
    logger.warn('overnight-report: weather fetch failed', { err: err.message });
    return null;
  }
}

// ── Overnight System Exceptions ─────────────────────────────────────────────
// Two independent, best-effort sources — neither blocks the report if it fails:
//   1. agent_tasks rows the poller marked status='error' in the last 24h
//      (covers e.g. a failed sa_add_ticket dispatched via the retry queue).
//   2. Deduped ERROR-level lines from logs/agent.log in the last 24h (covers
//      any other agent/system error, e.g. Menards/CardDAV/task-poller failures
//      already visible in that log today).
// This is a read of existing signals, not a new failure-tracking system.

async function getFailedTasks({ sinceHours = 24 } = {}) {
  try {
    const db = mainDb();
    const cutoff = new Date(Date.now() - sinceHours * 3600_000).toISOString();
    // Filtered on updated_at, not created_at: a task can sit `pending` for
    // days (re-queued repeatedly by SA's Incapsula backoff — see
    // task-poller.js's retry-count/backoff loop) before finally exhausting
    // its retries and landing on status='error' today. created_at would miss
    // that failure forever once it's more than sinceHours old. Confirmed
    // live 2026-08-21 that agent_tasks rows do carry a real, independently-
    // maintained updated_at (task-poller.js's PATCH never sets it itself).
    const { data, error } = await db.from('agent_tasks')
      .select('id, task, task_type, result, created_at, updated_at')
      .eq('status', 'error')
      .gte('updated_at', cutoff)
      .order('updated_at', { ascending: false })
      .limit(25);
    if (error) {
      logger.warn('overnight-report: agent_tasks error-lookup failed', { error: error.message });
      return [];
    }
    return data || [];
  } catch (err) {
    logger.warn('overnight-report: agent_tasks error-lookup threw', { err: err.message });
    return [];
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, '../../logs');
// winston's colorize() runs at logger-level format (core/logger.js), so even
// the File transport's lines carry ANSI escape codes around the level name —
// strip those before matching.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const LOG_LINE_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[(\w+)\] (.*)$/;

async function getOvernightLogErrors({ sinceHours = 24 } = {}) {
  // Read agent.log plus its first rotation (agent1.log — winston's File
  // transport rotates at 5MB/maxFiles:5). A busy day can rotate mid-window,
  // and without this the report would silently miss earlier errors that
  // already scrolled into agent1.log by the time this runs. Bounded to one
  // extra file (not all maxFiles:5) — enough to cover one rotation within a
  // 24h window without an unbounded multi-file scan.
  const candidates = [path.join(LOGS_DIR, 'agent.log'), path.join(LOGS_DIR, 'agent1.log')];
  const chunks = await Promise.all(candidates.map(async p => {
    try {
      return await fs.promises.readFile(p, 'utf8');
    } catch {
      return ''; // rotated file may not exist yet — not an error
    }
  }));
  const raw = chunks.join('\n');
  if (!raw.trim()) {
    logger.warn('overnight-report: could not read any agent.log file for error summary');
    return [];
  }

  const cutoffMs = Date.now() - sinceHours * 3600_000;
  const grouped = new Map();
  // \r?\n, not just \n: the log files are written with CRLF line endings, and
  // a bare '\n' split leaves a trailing \r on every line — which LOG_LINE_RE's
  // trailing (.*)  $ can never match through, since JS's `.` excludes \r as a
  // line-terminator char. That silently failed to match every single line
  // (confirmed live 2026-08-21 against the real agent.log: 0 matches with a
  // bare '\n' split vs. 11,546 with this fix), which would have made this
  // section report "no agent errors" even on a day full of them.
  for (const line of raw.split(/\r?\n/)) {
    const clean = line.replace(ANSI_RE, '');
    const m = clean.match(LOG_LINE_RE);
    if (!m) continue;
    const [, tsStr, level] = m;
    if (level.toLowerCase() !== 'error') continue;
    const ts = new Date(tsStr.replace(' ', 'T'));
    if (isNaN(ts.getTime()) || ts.getTime() < cutoffMs) continue;
    // Group by the message text alone (trailing {...} meta json stripped) so
    // e.g. 50 identical "body upload failed" lines with different reportIds
    // collapse into one row with a count, instead of flooding the email.
    const msg = m[3].replace(/\s*\{.*\}\s*$/, '').trim();
    const key = (msg || '(no message)').slice(0, 140);
    const entry = grouped.get(key) || { message: key, count: 0, lastSeen: tsStr };
    entry.count++;
    entry.lastSeen = tsStr;
    grouped.set(key, entry);
  }
  return [...grouped.values()].sort((a, b) => b.count - a.count);
}

// ── HTML builders — inline styles, email-safe, matches weekly finance report ──

// Style fragments
const _TD  = 'padding:6px 8px;font-size:13px;color:#333333;vertical-align:top;border-bottom:1px solid #f0f0f0;';
const _TH  = 'padding:6px 8px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;background-color:#f8f8f8;text-align:left;border-bottom:2px solid #e8e8e8;';
const _AMT = 'padding:6px 8px;font-size:13px;color:#333333;font-weight:bold;text-align:right;white-space:nowrap;border-bottom:1px solid #f0f0f0;';

function sectionTitle(label, count) {
  const badge = count != null
    ? ` <span style="background-color:#1a1a2e;color:#ffffff;border-radius:10px;padding:1px 8px;font-size:11px;font-weight:normal;">${count}</span>`
    : '';
  return `<p style="margin:28px 0 10px 0;font-size:13px;font-weight:bold;text-transform:uppercase;letter-spacing:0.8px;color:#888888;border-bottom:1px solid #e8e8e8;padding-bottom:6px;">${label}${badge}</p>`;
}

function emptyMsg(text) {
  return `<p style="margin:6px 0 16px;font-size:13px;color:#888888;font-style:italic;">${text}</p>`;
}

function groupRow(label, colSpan, amount) {
  return `<tr style="background-color:#1a1a2e;">
    <td colspan="${colSpan}" style="padding:6px 8px;font-size:13px;color:#ffffff;font-weight:bold;">${label}</td>
    <td style="padding:6px 8px;font-size:13px;color:#ffffff;font-weight:bold;text-align:right;white-space:nowrap;">${fmt$(amount)}</td>
  </tr>`;
}

function totalRow(colSpan, amount) {
  return `<tr style="background-color:#1a1a2e;">
    <td colspan="${colSpan}" style="padding:8px;font-size:13px;color:#aaaacc;font-weight:bold;text-align:right;">Total</td>
    <td style="padding:8px;font-size:15px;color:#ffffff;font-weight:bold;text-align:right;white-space:nowrap;">${fmt$(amount)}</td>
  </tr>`;
}

function dataTable(headers, body) {
  const ths = headers.map((h, i) => {
    const align = (i === headers.length - 1) ? `${_TH}text-align:right;` : _TH;
    return `<th style="${align}">${h}</th>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:4px;">
    <thead><tr>${ths}</tr></thead><tbody>${body}</tbody></table>`;
}

// Section 1 — receives live extractEstimate() objects (camelCase fields)
function wonEstimatesHtml(estimates) {
  if (!estimates.length) return emptyMsg('None.');
  let body = '';
  let grand = 0;
  for (const [i, e] of estimates.entries()) {
    const amt = parseFloat(e.amount) || 0;
    grand += amt;
    const bg = i % 2 ? 'background-color:#f8f8f8;' : '';
    body += `<tr style="${bg}">
      <td style="${_TD}">${e.clientName || '—'}</td>
      <td style="${_TD}">${e.salesRep || '—'}</td>
      <td style="${_TD}font-size:12px;color:#888888;">${e.estimateNum || '—'}</td>
      <td style="${_AMT}">${fmt$(amt)}</td>
    </tr>`;
  }
  body += totalRow(3, grand);
  return dataTable(['Client', 'Estimator', 'Est #', 'Amount'], body);
}

// Section 2 — receives live extractEstimate() objects; uses quoteDate (creation date) for age
function outstandingEstimatesHtml(estimates) {
  if (!estimates.length) return emptyMsg('All recent Won estimates are accounted for on the waiting list or dispatch board.');
  let body = '';
  for (const [i, e] of estimates.entries()) {
    const daysSince = e.quoteDate ? daysBetween(e.quoteDate, new Date()) : null;
    const bg = i % 2 ? 'background-color:#f8f8f8;' : '';
    body += `<tr style="${bg}">
      <td style="${_TD}">${e.clientName || '—'}</td>
      <td style="${_TD}">${e.salesRep || '—'}</td>
      <td style="${_TD}font-size:12px;color:#888888;">${daysSince != null ? `${daysSince}d` : '—'}</td>
      <td style="${_AMT}">${fmt$(e.amount)}</td>
    </tr>`;
  }
  const total = estimates.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  body += totalRow(3, total);
  return dataTable(['Client', 'Estimator', 'Days Since Created', 'Amount'], body);
}

// Draft estimates — new section
function draftEstimatesHtml(estimates) {
  if (!estimates.length) return emptyMsg('No draft estimates in the last 90 days.');
  let body = '';
  for (const [i, e] of estimates.entries()) {
    const bg = i % 2 ? 'background-color:#f8f8f8;' : '';
    const ageStyle = e.daysOld >= 7
      ? `${_TD}color:#b94a00;font-weight:bold;`
      : _TD;
    body += `<tr style="${bg}">
      <td style="${_TD}">${e.clientName || '—'}</td>
      <td style="${_TD}">${e.salesRep || '—'}</td>
      <td style="${_TD}font-size:12px;color:#888888;">${e.estimateNum || '—'}</td>
      <td style="${ageStyle}">${e.daysOld != null ? `${e.daysOld}d` : '—'}</td>
      <td style="${_AMT}">${fmt$(e.amount)}</td>
    </tr>`;
  }
  body += totalRow(4, totalOf(estimates));
  return dataTable(['Client', 'Estimator', 'Est #', 'Days Since Created', 'Amount'], body);
}

// Section 3 — receives live extractEstimate() objects (camelCase fields)
function sentEstimatesHtml(estimates) {
  if (!estimates.length) return emptyMsg('None.');
  const byRep = new Map();
  for (const e of estimates) {
    const rep = e.salesRep || '(Unassigned)';
    if (!byRep.has(rep)) byRep.set(rep, []);
    byRep.get(rep).push(e);
  }
  let body = '';
  for (const [rep, rows] of byRep) {
    body += groupRow(`${rep} — ${rows.length} estimate${rows.length !== 1 ? 's' : ''}`, 2, totalOf(rows));
    for (const [i, r] of rows.entries()) {
      const bg = i % 2 ? 'background-color:#f8f8f8;' : '';
      body += `<tr style="${bg}">
        <td style="${_TD}">${r.clientName || '—'}</td>
        <td style="${_TD}font-size:12px;color:#888888;">${r.estimateNum || '—'}</td>
        <td style="${_AMT}">${fmt$(r.amount)}</td>
      </tr>`;
    }
  }
  body += totalRow(2, totalOf(estimates));
  return dataTable(['Client', 'Est #', 'Amount'], body);
}

// Section 4
function agingEstimatesHtml(rows) {
  if (!rows.length) return emptyMsg('None.');
  let body = '';
  for (const [i, r] of rows.entries()) {
    const bg = i % 2 ? 'background-color:#f8f8f8;' : '';
    body += `<tr style="${bg}">
      <td style="${_TD}">${r.clientName || '—'}<br><span style="font-size:11px;color:#888888;">${r.address || ''}</span></td>
      <td style="${_TD}">${r.salesRep || '—'}</td>
      <td style="${_TD}font-size:12px;color:#888888;">${r.daysOut != null ? `${r.daysOut}d` : '—'}</td>
      <td style="${_AMT}">${fmt$(r.amount)}</td>
    </tr>`;
  }
  body += totalRow(3, totalOf(rows));
  return dataTable(['Client', 'Estimator', 'Days Out', 'Amount'], body);
}

// Section 5
function dispatchByCrewHtml(jobs) {
  if (!jobs.length) return emptyMsg('Nothing scheduled for today.');
  const byCrew = new Map();
  for (const j of jobs) {
    const crew = j.assigned || 'Unassigned';
    if (!byCrew.has(crew)) byCrew.set(crew, []);
    byCrew.get(crew).push(j);
  }
  const grand = jobs.reduce((s, j) => s + (parseFloat(j.amount) || 0), 0);
  let body = '';
  for (const [crew, rows] of byCrew) {
    const crewTotal = rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
    body += groupRow(`${crew} — ${rows.length} job${rows.length !== 1 ? 's' : ''}`, 3, crewTotal);
    for (const [i, r] of rows.entries()) {
      const bg = i % 2 ? 'background-color:#f8f8f8;' : '';
      body += `<tr style="${bg}">
        <td style="${_TD}">${r.client || '—'}</td>
        <td style="${_TD}font-size:12px;color:#888888;">${r.address || '—'}</td>
        <td style="${_TD}">${r.service || '—'}</td>
        <td style="${_AMT}">${fmt$(r.amount)}</td>
      </tr>`;
    }
  }
  body += totalRow(3, grand);
  return dataTable(['Client', 'Address', 'Service', 'Amount'], body);
}

// Section 6
function waitingListByCrewHtml(jobs) {
  if (!jobs.length) return emptyMsg('No crew-assigned waiting list jobs. (Crew assignments sync nightly.)');
  const byCrew = new Map();
  for (const j of jobs) {
    if (!byCrew.has(j.assigned)) byCrew.set(j.assigned, []);
    byCrew.get(j.assigned).push(j);
  }
  const grand = jobs.reduce((s, j) => s + (parseFloat(j.amount) || 0), 0);
  let body = '';
  for (const [crew, rows] of byCrew) {
    const crewTotal = rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
    body += groupRow(`${crew} — ${rows.length} job${rows.length !== 1 ? 's' : ''}`, 3, crewTotal);
    for (const [i, r] of rows.entries()) {
      const bg = i % 2 ? 'background-color:#f8f8f8;' : '';
      body += `<tr style="${bg}">
        <td style="${_TD}">${r.client_name || '—'}</td>
        <td style="${_TD}">${r.service_code || '—'}</td>
        <td style="${_TD}font-size:12px;color:#888888;">${r.target_date || '—'}</td>
        <td style="${_AMT}">${fmt$(r.amount)}</td>
      </tr>`;
    }
  }
  body += totalRow(3, grand);
  return dataTable(['Client', 'Service', 'Target Date', 'Amount'], body);
}

// escapeHtml — same convention as field-briefing-report.js. Needed here (and
// not needed by the file's other sections above) because these two new
// sections interpolate free-text sourced from agent.log lines and agent_tasks
// error results — unvalidated text that can contain '&'/'<'/'>' (a URL query
// string, an error message quoting a value in angle brackets, etc.) — unlike
// the SA-sourced client/service names elsewhere in this file, which are
// comparatively low-risk plain names/addresses.
function escapeHtml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Weather Watch
function weatherRiskHtml(day) {
  if (!day) return emptyMsg('Weather forecast unavailable.');
  const risky = day.condition === 'snow' || day.condition === 'rain' || day.wind_mph >= 25 || day.temp_low <= 20;
  const icon = day.condition === 'snow' ? '❄️' : day.condition === 'rain' ? '🌧️' : day.condition === 'cloudy' ? '☁️' : '☀️';
  const bg = risky ? '#fff8f0' : '#f0f4ff';
  const label = risky
    ? `${icon} ${day.condition === 'snow' ? 'Snow' : day.condition === 'rain' ? 'Rain' : 'Weather'} risk today &mdash; may affect crew scheduling.`
    : `${icon} No weather-driven schedule risk expected today.`;
  const precipBits = [];
  if (day.morning)   precipBits.push(`AM precip ${day.morning.precip_prob}%`);
  if (day.afternoon) precipBits.push(`PM precip ${day.afternoon.precip_prob}%`);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${bg};border-radius:4px;margin-bottom:6px;"><tr><td style="padding:12px 16px;font-size:13px;color:#1a1a2e;">
    <strong>${label}</strong><br>
    <span style="font-size:12px;color:#666666;">High ${day.temp_high}&deg;F / Low ${day.temp_low}&deg;F &bull; Wind ${day.wind_mph} mph${precipBits.length ? ` &bull; ${precipBits.join(' &bull; ')}` : ''}</span>
  </td></tr></table>`;
}

// Overnight System Exceptions
function systemExceptionsHtml(failedTasks, logErrors) {
  if (!failedTasks.length && !logErrors.length) {
    return emptyMsg('No agent errors or failed background tasks in the last 24 hours.');
  }
  let html = '';
  if (failedTasks.length) {
    html += `<p style="margin:4px 0 6px;font-size:12px;font-weight:bold;color:#555577;">Failed background tasks (${failedTasks.length})</p>`;
    let body = '';
    for (const [i, t] of failedTasks.entries()) {
      const bg = i % 2 ? 'background-color:#f8f8f8;' : '';
      const snippet = escapeHtml((t.result || '').replace(/^Error:\s*/, '').slice(0, 140)) || '—';
      const whenSrc = t.updated_at || t.created_at;
      const when = whenSrc
        ? new Date(whenSrc).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : '—';
      body += `<tr style="${bg}">
        <td style="${_TD}">${escapeHtml(t.task_type || 'general')}</td>
        <td style="${_TD}">${snippet}</td>
        <td style="${_TD}font-size:12px;color:#888888;white-space:nowrap;">${when}</td>
      </tr>`;
    }
    html += dataTable(['Task Type', 'Error', 'When'], body);
  }
  if (logErrors.length) {
    html += `<p style="margin:16px 0 6px;font-size:12px;font-weight:bold;color:#555577;">Agent/system log errors (${logErrors.length} distinct)</p>`;
    let body = '';
    for (const [i, e] of logErrors.entries()) {
      const bg = i % 2 ? 'background-color:#f8f8f8;' : '';
      body += `<tr style="${bg}">
        <td style="${_TD}">${escapeHtml(e.message)}</td>
        <td style="${_TD}font-size:12px;color:#888888;text-align:center;">${e.count}&times;</td>
        <td style="${_TD}font-size:12px;color:#888888;white-space:nowrap;">${e.lastSeen}</td>
      </tr>`;
    }
    html += dataTable(['Message', 'Count', 'Last Seen'], body);
  }
  return html;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function generateOvernightReport() {
  logger.info('overnight-report: starting');

  const [wonResult, sentResult, draftResult, agingResult, jobsResult, wlResult, weatherResult, failedTasksResult, logErrorsResult] = await Promise.allSettled([
    syncWonEstimates(),
    syncSentEstimates(),
    getDraftEstimates(),
    getAgingEstimates(),
    getTodayJobs(),
    getAssignedWaitingListJobs(),
    getTodayWeather(),
    getFailedTasks(),
    getOvernightLogErrors(),
  ]);

  const { acceptedYesterday = [], outstanding = [] } =
    wonResult.status === 'fulfilled' ? wonResult.value : {};
  const sentYesterday = sentResult.status === 'fulfilled'  ? sentResult.value : [];
  const draftEstimates = draftResult.status === 'fulfilled' ? draftResult.value : [];
  const aging         = agingResult.status === 'fulfilled' ? agingResult.value : [];
  const todayJobs     = jobsResult.status === 'fulfilled'  ? jobsResult.value : [];
  const wlJobs        = wlResult.status === 'fulfilled'    ? wlResult.value   : [];
  const weather       = weatherResult.status === 'fulfilled' ? weatherResult.value : null;
  const failedTasks   = failedTasksResult.status === 'fulfilled' ? failedTasksResult.value : [];
  const logErrors     = logErrorsResult.status === 'fulfilled' ? logErrorsResult.value : [];

  if (wonResult.status === 'rejected')
    logger.error('overnight-report: won sync failed',   { err: wonResult.reason?.message });
  if (sentResult.status === 'rejected')
    logger.error('overnight-report: sent sync failed',  { err: sentResult.reason?.message });
  if (draftResult.status === 'rejected')
    logger.error('overnight-report: draft fetch failed', { err: draftResult.reason?.message });
  if (agingResult.status === 'rejected')
    logger.error('overnight-report: aging failed',      { err: agingResult.reason?.message });
  if (jobsResult.status === 'rejected')
    logger.error('overnight-report: jobs failed',       { err: jobsResult.reason?.message });
  if (wlResult.status === 'rejected')
    logger.error('overnight-report: wl jobs failed',    { err: wlResult.reason?.message });
  if (weatherResult.status === 'rejected')
    logger.error('overnight-report: weather failed',    { err: weatherResult.reason?.message });
  if (failedTasksResult.status === 'rejected')
    logger.error('overnight-report: failed-tasks lookup failed', { err: failedTasksResult.reason?.message });
  if (logErrorsResult.status === 'rejected')
    logger.error('overnight-report: log-errors lookup failed',   { err: logErrorsResult.reason?.message });

  const dateLabel        = formatDate(yesterday());
  const outstandingTotal = outstanding.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  const crewSet          = new Set(todayJobs.map(j => j.assigned || 'Unassigned'));

  const outstandingAlert = outstanding.length > 0
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f4ff;border-radius:4px;margin-bottom:14px;"><tr><td style="padding:12px 16px;font-size:13px;color:#1a1a2e;">
        <strong style="font-size:15px;">${outstanding.length}</strong> won estimate${outstanding.length !== 1 ? 's' : ''} with no waiting-list or scheduled job &mdash; pipeline value: <strong>${fmt$(outstandingTotal)}</strong>
      </td></tr></table>`
    : '';

  const dispatchBadge = `${todayJobs.length} job${todayJobs.length !== 1 ? 's' : ''} &bull; ${crewSet.size} crew${crewSet.size !== 1 ? 's' : ''}`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;">
<tr><td align="center" style="padding:20px 0;">
<table role="presentation" width="100%" style="max-width:620px;background-color:#ffffff;border-radius:6px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

  <tr><td style="background-color:#1a1a2e;padding:24px 32px;">
    <p style="margin:0;color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:0.5px;">J.R. Boehlke, LLC</p>
    <p style="margin:4px 0 0;color:#aaaacc;font-size:13px;">Daily Morning Report &nbsp;|&nbsp; ${formatDate(new Date())} &nbsp;|&nbsp; Activity for ${dateLabel}</p>
  </td></tr>

  <tr><td style="padding:4px 32px 32px;">

    ${sectionTitle('Weather Watch — Today')}
    ${weatherRiskHtml(weather)}

    ${sectionTitle('Overnight System Exceptions', failedTasks.length + logErrors.length)}
    ${systemExceptionsHtml(failedTasks, logErrors)}

    ${sectionTitle('Jobs Accepted Since Yesterday\'s Report', acceptedYesterday.length)}
    ${wonEstimatesHtml(acceptedYesterday)}

    ${sectionTitle('Accepted — Awaiting Waiting List (Last 45 Days)', outstanding.length)}
    ${outstandingAlert}
    ${outstandingEstimatesHtml(outstanding)}

    ${sectionTitle('Estimates Sent Since Yesterday\'s Report', sentYesterday.length)}
    ${sentEstimatesHtml(sentYesterday)}

    ${sectionTitle('Estimates Created — Not Yet Sent', draftEstimates.length)}
    ${draftEstimatesHtml(draftEstimates)}

    ${sectionTitle('Aging Estimates — No Response (7+ Days)', aging.length)}
    ${agingEstimatesHtml(aging)}

    ${sectionTitle('Today\'s Dispatch', dispatchBadge)}
    ${dispatchByCrewHtml(todayJobs)}

    ${sectionTitle('Waiting List by Crew', wlJobs.length)}
    ${waitingListByCrewHtml(wlJobs)}

  </td></tr>

  <tr><td style="background-color:#f8f8f8;padding:12px 32px;text-align:center;font-size:11px;color:#888888;border-top:1px solid #e8e8e8;">
    Sent by JRB Executive Assistant &mdash; ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;

  const subject = `JRB Morning Report — ${dateLabel} | ${acceptedYesterday.length} accepted, ${sentYesterday.length} sent, ${outstanding.length} awaiting WL, ${todayJobs.length} dispatched`;

  logger.info('overnight-report: complete', {
    accepted:      acceptedYesterday.length,
    outstanding:   outstanding.length,
    sent:          sentYesterday.length,
    drafts:        draftEstimates.length,
    aging:         aging.length,
    todayJobs:     todayJobs.length,
    weather:       weather?.condition ?? 'unavailable',
    failedTasks:   failedTasks.length,
    logErrors:     logErrors.length,
  });

  return { subject, body: html };
}
