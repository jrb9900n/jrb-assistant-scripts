// tools/impl/field-briefing-report.js
// Field / Client Meetings Briefing — sent ~15-45 min before each occurrence of
// Michael's recurring "Field / Client Meetings" calendar block (Tue 9:00-11:30,
// Thu 10:00-11:30, Fri 9:00-11:30, America/Chicago — see the President Weekly
// Block Schedule in CLAUDE.md's Autonomous Schedule Manager section).
//
// Unlike the other cron reports (AR/Collections, weekly finance, etc.) this
// one is fundamentally calendar-driven, not just a business-data query: it
// reads Michael's ACTUAL calendar for the day, keeps only REAL appointments
// (filtering out the "JRB Block Schedule" scaffolding event itself — see
// calendar-watch.js's BLOCK_CATEGORY sentinel), then cross-references each one
// against synced SA data (sa_jobs/sa_tickets/sa_invoices/sa_sent_estimates/
// sa_accepted_estimates in the fleetops Supabase project) for recent job
// history, recent CRM tickets, open AR, and pending estimate status.
//
// Client-name matching is intentionally conservative: a calendar event only
// carries free text (subject/body), never a stored SA client_id, so matching
// it to a specific SA client record is inherently fuzzy. Zero or multiple
// matches are surfaced as-is (with a confidence caveat) rather than guessed —
// same convention scheduleEstimateVisit uses for its own candidate list (see
// tools/impl/scheduling-visits.js).
//
// Read-only against the calendar: this file never creates, updates, or
// deletes a calendar event.

import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';
import { sendEmail, getCalendarViewWithCategories, getCalendarEvent } from './m365.js';
import { BLOCK_CATEGORY } from './calendar-watch.js';
import { sectionHeader, alertBox } from './ar-report-helpers.js';

function supabase() {
  return createClient(process.env.FLEETOPS_SUPABASE_URL, process.env.FLEETOPS_SUPABASE_SERVICE_KEY);
}

const MAILBOX = 'michael@jrboehlke.com';
const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';

// Known recurring "Field / Client Meetings" block windows (America/Chicago
// wall-clock, matching createCalendarEvent's default timezone convention),
// keyed by JS Date#getDay() (0=Sun). Mirrors ar-collections-report.js's own
// choice to hardcode the block's known time rather than re-deriving it live
// from the calendar every run — the cron entries below only ever fire on the
// correct weekday, so this always matches production reality.
export const FIELD_BLOCK_WINDOWS = {
  2: { start: '09:00', end: '11:30' }, // Tuesday
  4: { start: '10:00', end: '11:30' }, // Thursday
  5: { start: '09:00', end: '11:30' }, // Friday
};

// Fallback window used only when a manual test run (run-field-briefing-report.mjs
// --date=...) passes an override date that doesn't fall on one of the three
// real block days above — keeps the test script usable against an arbitrary
// date without special-casing the caller. Never used by the production cron
// calls, which always run on a real block day.
const FALLBACK_WINDOW = { start: '07:00', end: '18:00' };

const RECENT_JOBS_LIMIT = 5;
const RECENT_TICKETS_LIMIT = 5;
// Generous on purpose: this runs against a handful of appointments per cron
// call (a few times a week), not a hot path, so there's no real cost to
// erring high. A too-small cap combined with Postgres's unordered default
// scan order could otherwise silently truncate a distinct client_id out of
// the merged candidate list before dedup ever sees it -- collapsing a real
// "2+ ambiguous candidates" case into a false single "matched" result. The
// cap is still logged if actually hit (see searchTableByName) so a truncation
// is visible rather than silent.
const CANDIDATE_SEARCH_LIMIT = 200;

// ── Small date/time helpers ──────────────────────────────────────────────────
// Same naive-local-string convention as scheduling-visits.js: every timestamp
// here is a "YYYY-MM-DDTHH:MM:SS" wall-clock string with no zone offset.
// new Date(naiveString) parses it as local server time, and the getHours/
// getMonth/... accessors read it back the same way, so this round-trips
// correctly as long as it never crosses through toISOString()/UTC.

function pad2(n) { return String(n).padStart(2, '0'); }

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function dayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

function windowFor(dateStr) {
  return FIELD_BLOCK_WINDOWS[dayOfWeek(dateStr)] ?? FALLBACK_WINDOW;
}

function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

function toMs(s) { return new Date(s).getTime(); }

function overlaps(aStart, aEnd, bStart, bEnd) {
  return toMs(aStart) < toMs(bEnd) && toMs(bStart) < toMs(aEnd);
}

function formatTime(naiveDateTimeStr) {
  const d = new Date(naiveDateTimeStr);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${pad2(m)} ${ampm}`;
}

function formatDateLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

function fmtDollars(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Step 1: real calendar appointments in today's block window ─────────────

/**
 * Fetches the day's calendar, keeps only events that (a) don't carry the
 * "JRB Block Schedule" sentinel (i.e. aren't the block scaffolding itself)
 * and (b) actually overlap the known block window for that weekday, then
 * fetches each surviving event's full (untruncated) body for the name/
 * address/phone extraction step below.
 */
export async function gatherRealAppointments(dateStr) {
  const win = windowFor(dateStr);
  const blockStart = `${dateStr}T${win.start}:00`;
  const blockEnd = `${dateStr}T${win.end}:00`;

  // Padded by a day on each side — same rationale documented in
  // scheduling-visits.js's checkAndResolveDisplacement: Graph's calendarView
  // startDateTime/endDateTime query params aren't reliably re-zoned the way
  // the *returned* start/end values are, so a same-local-day window can
  // silently exclude an edge event. The precise overlap filter below runs
  // against each event's correctly-zoned returned start/end, so widening the
  // fetch window can only pull in extra non-overlapping neighbors, never
  // cause a false match.
  const dayStart = `${addDaysToDateStr(dateStr, -1)}T00:00:00`;
  const dayEnd = `${addDaysToDateStr(dateStr, 1)}T23:59:59`;

  const dayEvents = await getCalendarViewWithCategories({ userEmail: MAILBOX, startDateTime: dayStart, endDateTime: dayEnd });

  const real = dayEvents.filter(e =>
    !(e.categories || []).includes(BLOCK_CATEGORY) &&
    overlaps(e.start, e.end, blockStart, blockEnd)
  );

  // getCalendarEvent's untruncated body is used instead of relying on a
  // truncated bodyPreview — a longer manually-typed note (address + phone +
  // extra context) could otherwise be silently cut off before the extraction
  // step below ever sees it.
  const withBodies = await Promise.all(real.map(async e => {
    try {
      const full = await getCalendarEvent({ event_id: e.id, userEmail: MAILBOX });
      return { ...e, body: full.content || '', bodyContentType: full.contentType };
    } catch (err) {
      logger.warn('field_briefing_report: getCalendarEvent failed for an appointment', { eventId: e.id, err: err.message });
      return { ...e, body: '', bodyContentType: 'text' };
    }
  }));

  return withBodies.sort((a, b) => toMs(a.start) - toMs(b.start));
}

// ── Step 2: extract a candidate client name / address / phone from the event ─

// Handles both "Label: Name" / "Label - Name" separator forms and bare
// "Meet with Name" / "Call Name" phrasing with no separator at all — the
// second group is intentionally short (a handful of very common human
// phrasings, not an attempt at general NLP), since anything this doesn't
// recognize just falls through to the full subject string and, most likely,
// a "no_match" result below — an honest surfaced outcome, not a silent wrong
// guess (see findClientCandidates' AND-token matching).
const SUBJECT_PREFIX_RE = /^(?:(?:estimate visit|site visit|client visit|job walk(?:through)?|meeting|visit)\s*[:\-–]\s*|(?:meet(?:ing)?|follow[\s-]?up)\s+with\s+|call(?:\s+with)?\s+)/i;
// Trailing descriptive words stripped one at a time (not just once) so a
// subject like "Smith Residence Walkthrough" or "ABC Property Site Visit"
// reduces down to just the name — leaving a generic word like "Residence" in
// the candidate string would otherwise cost that token in the AND-matched
// ILIKE search below and produce a false "no_match" even though the actual
// name half would have matched fine.
const SUBJECT_SUFFIX_RE = /\s*(walkthrough|walk|visit|meeting|residence|property|home|house|office|site|job)\s*$/i;

// Only strips a trailing descriptor if at least 2 real name tokens would
// still remain afterward (or the input was already down to 1 token, in which
// case there's nothing left to protect). Without this floor, a 2-word input
// like "Lake House" would strip down to the single generic word "Lake" —
// findClientCandidates would then AND-match on that one token alone, and if
// exactly one unrelated client happens to contain "Lake" as a substring
// (e.g. "Blue Lake Construction"), that becomes a false high-confidence
// "matched" result with the wrong client's history silently attached — the
// exact wrong-guess failure mode this file's header explicitly avoids
// elsewhere. Stopping at 2 tokens instead trades that risk for the much
// safer failure mode of an occasional false "no_match" (a word like
// "Residence" surviving into the AND search, which real client names almost
// never contain) — an honest, surfaced outcome rather than a silent wrong one.
function stripTrailingDescriptors(s) {
  let prev;
  do {
    prev = s;
    const candidate = s.replace(SUBJECT_SUFFIX_RE, '');
    if (candidate !== s && candidate.trim().split(/\s+/).filter(Boolean).length >= 2) {
      s = candidate;
    }
  } while (s !== prev && s.length > 0);
  return s;
}

export function extractCandidateName(subject = '') {
  let s = (subject || '').trim();
  s = s.replace(SUBJECT_PREFIX_RE, '');
  s = stripTrailingDescriptors(s).trim();
  return s;
}

function stripHtml(s = '') {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

export function extractFromBody(body = '', contentType = 'text') {
  const plain = contentType === 'html' ? stripHtml(body) : body;
  const addressMatch = plain.match(/Address:\s*([^\n<]+)/i);
  const phoneMatch = plain.match(/Phone:\s*([^\n<]+)/i);
  return {
    address: addressMatch ? addressMatch[1].trim() : null,
    phone: phoneMatch ? phoneMatch[1].trim() : null,
  };
}

// ── Step 3: match candidate name against synced SA client data ─────────────
// Queries sa_jobs/sa_tickets/sa_invoices directly (ILIKE, name tokens ANDed)
// rather than loading full client lists into memory or calling SA's live
// browser session — per the guidance to prefer already-synced Supabase data,
// since SA's live API needs a slow puppeteer session and carries Incapsula
// backoff risk. Zero or multiple distinct client_ids come back as-is; the
// caller surfaces that ambiguity to Michael rather than guessing, same
// convention as scheduleEstimateVisit's candidate list.

function tokensOf(name) {
  return (name || '').split(/\s+/).map(t => t.trim()).filter(t => t.length >= 2);
}

async function searchTableByName(db, table, idCol, nameCol, tokens) {
  let q = db.from(table).select(`${idCol}, ${nameCol}`).order(nameCol);
  for (const t of tokens) q = q.ilike(nameCol, `%${t}%`);
  const { data, error } = await q.limit(CANDIDATE_SEARCH_LIMIT);
  if (error) {
    logger.warn(`field_briefing_report: ${table} name search failed`, { err: error.message });
    return [];
  }
  if ((data ?? []).length === CANDIDATE_SEARCH_LIMIT) {
    // Hit the cap -- there may be more distinct matches this query never saw.
    // Not fatal (the caller still surfaces whatever it found as either a
    // single match or an ambiguous list), but worth a visible signal since a
    // hidden truncation here could otherwise mask a real ambiguous case as a
    // false single match.
    logger.warn(`field_briefing_report: ${table} name search hit CANDIDATE_SEARCH_LIMIT — results may be incomplete`, { tokens });
  }
  return (data ?? []).map(r => ({ clientId: String(r[idCol] ?? ''), name: r[nameCol] }));
}

export async function findClientCandidates(db, candidateName) {
  const tokens = tokensOf(candidateName);
  if (!tokens.length) return [];

  const [fromJobs, fromTickets, fromInvoices] = await Promise.all([
    searchTableByName(db, 'sa_jobs', 'customer_id', 'client', tokens),
    searchTableByName(db, 'sa_tickets', 'client_id', 'client_name', tokens),
    searchTableByName(db, 'sa_invoices', 'customer_id', 'client', tokens),
  ]);

  const byId = new Map();
  for (const r of [...fromJobs, ...fromTickets, ...fromInvoices]) {
    if (!r.clientId || r.clientId === EMPTY_GUID) continue;
    if (!byId.has(r.clientId)) byId.set(r.clientId, r.name);
  }
  return [...byId.entries()].map(([clientId, name]) => ({ clientId, name }));
}

// ── Step 4: gather SA history for a resolved client ─────────────────────────
// Job "status" is a raw SA-internal numeric code with no confirmed label
// mapping anywhere in this codebase (probed live 2026-08 — sa_jobs.status
// takes values 1/2/3/5 with no documented meaning) — rather than guess a
// Scheduled/Completed/Cancelled label that could be wrong, this uses the
// unambiguous `date_completed` column instead: present = completed on that
// date, absent = still scheduled/outstanding as of `start_date`. Same reason
// sa_tickets' own status/ticket_type codes (1/4, etc.) are shown as plain
// recent entries below rather than labeled open/closed.
//
// `sa_tickets` (fleetops project) has no writer anywhere in this repo —
// confirmed live 2026-08-20 that it holds real, current data (1,897 rows,
// entries updated as recently as today), so it's synced by something
// outside this codebase (most likely the separate, non-git BTA Reporting
// scraper pipeline, or a one-off historical sync from the SA Client
// Categorization effort — see CLAUDE.md). Read-only here, same as every
// other sa_* table this file touches.
async function gatherClientHistory(db, clientId) {
  const [jobsRes, ticketsRes, invRes, sentRes, acceptedRes] = await Promise.all([
    db.from('sa_jobs').select('start_date, service, amount, address, date_completed')
      .eq('customer_id', clientId).order('start_date', { ascending: false }).limit(RECENT_JOBS_LIMIT),
    db.from('sa_tickets').select('subject, ticket_category, last_updated')
      .eq('client_id', clientId).eq('deleted', false).order('last_updated', { ascending: false }).limit(RECENT_TICKETS_LIMIT),
    db.from('sa_invoices').select('invoice_number, invoice_balance, days_past_due, date')
      .eq('customer_id', clientId).gt('invoice_balance', 0).eq('deleted', false),
    db.from('sa_sent_estimates').select('estimate_id, estimate_number, amount, quote_date')
      .eq('client_id', clientId).order('quote_date', { ascending: false }),
    db.from('sa_accepted_estimates').select('estimate_id')
      .eq('client_id', clientId),
  ]);

  for (const [label, res] of [['sa_jobs', jobsRes], ['sa_tickets', ticketsRes], ['sa_invoices', invRes], ['sa_sent_estimates', sentRes], ['sa_accepted_estimates', acceptedRes]]) {
    if (res.error) logger.warn(`field_briefing_report: ${label} history query failed`, { clientId, err: res.error.message });
  }

  const recentJobs = jobsRes.error ? [] : (jobsRes.data ?? []);
  const recentTickets = ticketsRes.error ? [] : (ticketsRes.data ?? []);
  const openInvoices = invRes.error ? [] : (invRes.data ?? []);
  const acceptedIds = new Set((acceptedRes.error ? [] : (acceptedRes.data ?? [])).map(r => r.estimate_id));
  // "Pending" = sent but not (yet) won — a sent estimate whose id already
  // shows up in sa_accepted_estimates has been won, so it's excluded here.
  const pendingEstimates = (sentRes.error ? [] : (sentRes.data ?? [])).filter(e => !acceptedIds.has(e.estimate_id));

  return {
    recentJobs,
    recentTickets,
    openInvoices,
    openBalance: openInvoices.reduce((s, r) => s + Number(r.invoice_balance ?? 0), 0),
    pendingEstimates,
  };
}

// ── Per-appointment orchestration ───────────────────────────────────────────

async function buildAppointmentBriefing(db, appt) {
  const candidateName = extractCandidateName(appt.subject);
  const { address, phone } = extractFromBody(appt.body, appt.bodyContentType);

  if (!candidateName) {
    return { appt, candidateName: null, address, phone, matchStatus: 'no_name_extracted', candidates: [], history: null };
  }

  const candidates = await findClientCandidates(db, candidateName);

  if (candidates.length === 1) {
    const history = await gatherClientHistory(db, candidates[0].clientId);
    return { appt, candidateName, address, phone, matchStatus: 'matched', matchedClient: candidates[0], candidates, history };
  }
  if (candidates.length === 0) {
    return { appt, candidateName, address, phone, matchStatus: 'no_match', candidates: [], history: null };
  }
  return { appt, candidateName, address, phone, matchStatus: 'ambiguous', candidates, history: null };
}

// ── HTML builders — reuses ar-report-helpers.js's sectionHeader/alertBox for
//    a consistent look across every JRB report email ─────────────────────────

function escapeHtml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function subheading(text) {
  return `<p style="margin:14px 0 6px;font-size:12px;font-weight:bold;color:#555577;text-transform:uppercase;letter-spacing:0.4px;">${text}</p>`;
}

function emptyMsg(text) {
  return `<p style="margin:0 0 10px;font-size:12px;color:#888888;font-style:italic;">${text}</p>`;
}

function jobHistoryHtml(jobs) {
  if (!jobs.length) return emptyMsg('No job history found in synced SA data.');
  const rows = jobs.map(j => {
    const statusLabel = j.date_completed
      ? `<span style="color:#1a6e1a;">Completed ${j.date_completed}</span>`
      : `<span style="color:#888888;">Scheduled ${j.start_date || '—'}</span>`;
    return `<tr>
      <td style="padding:4px 6px;font-size:12px;color:#333333;">${escapeHtml(j.service || '—')}</td>
      <td style="padding:4px 6px;font-size:12px;color:#888888;">${escapeHtml(j.address || '—')}</td>
      <td style="padding:4px 6px;font-size:12px;">${statusLabel}</td>
      <td style="padding:4px 6px;font-size:12px;font-weight:bold;text-align:right;white-space:nowrap;">${fmtDollars(j.amount)}</td>
    </tr>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:6px;">${rows}</table>`;
}

function ticketsHtml(tickets) {
  if (!tickets.length) return emptyMsg('No recent CRM tickets found in synced SA data.');
  const rows = tickets.map(t => `<tr>
      <td style="padding:4px 6px;font-size:12px;color:#333333;">${escapeHtml(t.subject || '—')}</td>
      <td style="padding:4px 6px;font-size:12px;color:#888888;">${escapeHtml(t.ticket_category || '—')}</td>
      <td style="padding:4px 6px;font-size:12px;color:#888888;text-align:right;white-space:nowrap;">${t.last_updated || '—'}</td>
    </tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:2px;">${rows}</table>
    <p style="margin:0 0 10px;font-size:11px;color:#aaaaaa;font-style:italic;">SA ticket status codes aren't decoded here (no confirmed open/closed mapping) — shown as the most recent entries, not filtered by status.</p>`;
}

function pendingEstimatesHtml(estimates) {
  if (!estimates.length) return emptyMsg('No pending (sent, not yet won) estimates.');
  const rows = estimates.map(e => `<tr>
      <td style="padding:4px 6px;font-size:12px;color:#333333;">Est #${escapeHtml(e.estimate_number || e.estimate_id)}</td>
      <td style="padding:4px 6px;font-size:12px;color:#888888;">sent ${e.quote_date || '—'}</td>
      <td style="padding:4px 6px;font-size:12px;font-weight:bold;text-align:right;white-space:nowrap;">${fmtDollars(e.amount)}</td>
    </tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;">${rows}</table>`;
}

function openArHtml(invoices, balance) {
  if (!invoices.length) return emptyMsg('No open balance.');
  const rows = invoices.map(i => `<tr>
      <td style="padding:4px 6px;font-size:12px;color:#333333;">Inv #${escapeHtml(i.invoice_number || '—')}</td>
      <td style="padding:4px 6px;font-size:12px;color:#888888;">${i.days_past_due > 0 ? `${i.days_past_due}d past due` : (i.date || '—')}</td>
      <td style="padding:4px 6px;font-size:12px;font-weight:bold;text-align:right;color:#b35900;white-space:nowrap;">${fmtDollars(i.invoice_balance)}</td>
    </tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:2px;">${rows}</table>
    <p style="margin:0 0 10px;font-size:12px;font-weight:bold;color:#b35900;">Total open: ${fmtDollars(balance)}</p>`;
}

function appointmentCardHtml(b, index) {
  const { appt, candidateName, address, phone } = b;
  let html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8f9fc;border-radius:6px;margin-bottom:16px;"><tr><td style="padding:16px 18px;">`;
  html += `<p style="margin:0 0 2px;font-size:15px;font-weight:bold;color:#1a1a2e;">${index}. ${formatTime(appt.start)} &ndash; ${formatTime(appt.end)} &mdash; ${escapeHtml(appt.subject || '(no subject)')}</p>`;

  const contactBits = [];
  if (address) contactBits.push(escapeHtml(address));
  if (phone) contactBits.push(escapeHtml(phone));
  if (contactBits.length) {
    html += `<p style="margin:0 0 10px;font-size:12px;color:#888888;">${contactBits.join(' &nbsp;|&nbsp; ')}</p>`;
  } else {
    html += `<p style="margin:0 0 10px;"></p>`;
  }

  if (b.matchStatus === 'no_name_extracted') {
    html += alertBox('#fff8f0', '#e6a817', 'No Client Name Extracted',
      `<p style="margin:0;font-size:12px;color:#533f03;">Couldn't parse a client name out of this event's subject. Check SA manually before the visit.</p>`);
  } else if (b.matchStatus === 'no_match') {
    html += alertBox('#fff8f0', '#e6a817', `No SA Client Match For "${escapeHtml(candidateName)}"`,
      `<p style="margin:0;font-size:12px;color:#533f03;">No client matching this name was found in synced SA data (sa_jobs/sa_tickets/sa_invoices). Could be a new client, a name that doesn't match SA's spelling, or SA data that hasn't synced yet — verify manually.</p>`);
  } else if (b.matchStatus === 'ambiguous') {
    const list = b.candidates.map(c => `<li style="margin:2px 0;">${escapeHtml(c.name)}</li>`).join('');
    html += alertBox('#fff8f0', '#e6a817', `${b.candidates.length} Possible SA Matches For "${escapeHtml(candidateName)}"`,
      `<p style="margin:0 0 6px;font-size:12px;color:#533f03;">Couldn't narrow this to a single client — showing job/ticket/invoice history was skipped to avoid attaching the wrong client's data. Candidates:</p><ul style="margin:0;padding-left:18px;font-size:12px;color:#533f03;">${list}</ul>`);
  } else if (b.matchStatus === 'matched') {
    html += `<p style="margin:0 0 10px;font-size:12px;color:#1a6e1a;">Matched to SA client: <strong>${escapeHtml(b.matchedClient.name)}</strong></p>`;
    html += subheading('Recent Jobs');
    html += jobHistoryHtml(b.history.recentJobs);
    html += subheading('Recent CRM Tickets');
    html += ticketsHtml(b.history.recentTickets);
    html += subheading('Pending Estimates');
    html += pendingEstimatesHtml(b.history.pendingEstimates);
    html += subheading('Open AR Balance');
    html += openArHtml(b.history.openInvoices, b.history.openBalance);
  }

  html += `</td></tr></table>`;
  return html;
}

function buildEmail({ dateStr, briefings }) {
  const win = windowFor(dateStr);
  let html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Field / Client Meetings Briefing ${dateStr}</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" style="max-width:640px;background-color:#ffffff;border-radius:6px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

<!-- HEADER -->
<tr><td style="background-color:#1a1a2e;padding:24px 32px;">
  <p style="margin:0;color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:0.5px;">J.R. Boehlke, LLC</p>
  <p style="margin:4px 0 0;color:#aaaacc;font-size:13px;">Field / Client Meetings Briefing &nbsp;|&nbsp; ${formatDateLabel(dateStr)}, ${win.start}&ndash;${win.end}</p>
</td></tr>

<!-- BODY -->
<tr><td style="padding:28px 32px;">`;

  if (!briefings.length) {
    html += `<p style="margin:0;font-size:13px;color:#888888;font-style:italic;">Nothing on the calendar for today's Field / Client Meetings block.</p>`;
  } else {
    html += sectionHeader(`${briefings.length} Scheduled Visit${briefings.length === 1 ? '' : 's'}`);
    briefings.forEach((b, i) => { html += appointmentCardHtml(b, i + 1); });
  }

  html += `<p style="margin:20px 0 0;font-size:11px;color:#aaaaaa;font-style:italic;">Client matching is name-based against synced SA data (sa_jobs/sa_tickets/sa_invoices) — a calendar event has no stored SA client ID, so ambiguous or missing matches are shown as-is rather than guessed.</p>`;

  html += `
</td></tr>
</table></td></tr></table>
</body></html>`;

  return html;
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * @param {object} [opts]
 * @param {string} [opts.date] - YYYY-MM-DD override for manual testing against
 *   a day known to have real appointments. Production cron calls never pass
 *   this — they always use the real current date.
 */
export async function generateAndSendFieldBriefing({ date } = {}) {
  const dateStr = date ?? todayStr();
  const db = supabase();

  const appts = await gatherRealAppointments(dateStr);
  // Each appointment's briefing is independent (its own SA name search + its
  // own set of history queries once resolved) — a real day only ever has a
  // handful of these, but there's no reason to serialize them. Promise.all
  // preserves appts' order (already chronological, from gatherRealAppointments)
  // regardless of which lookup actually finishes first.
  const briefings = await Promise.all(appts.map(appt => buildAppointmentBriefing(db, appt)));

  const body = buildEmail({ dateStr, briefings });
  const matchedCount = briefings.filter(b => b.matchStatus === 'matched').length;
  const unresolvedCount = briefings.length - matchedCount;

  await sendEmail({
    to: ['michael@jrboehlke.com'],
    subject: `Field / Client Meetings — ${formatDateLabel(dateStr)} | ${briefings.length} visit${briefings.length === 1 ? '' : 's'}${unresolvedCount ? `, ${unresolvedCount} need${unresolvedCount === 1 ? 's' : ''} review` : ''}`,
    body,
  });

  logger.info('field_briefing_report: sent', { dateStr, appointmentCount: briefings.length, matchedCount, unresolvedCount });
  return { dateStr, appointmentCount: briefings.length, matchedCount, unresolvedCount };
}
