// tools/impl/scheduling-visits.js — Phase 2 of the Autonomous Schedule Manager
// roadmap (see CLAUDE.md's "Autonomous Schedule Manager" section for Phase 1
// context and the decisions Michael already locked in).
//
// scheduleEstimateVisit() is the single orchestrator for "schedule an estimate
// visit with <client> at <time> on <date>":
//   1. Look up the client in Service Autopilot for address/phone.
//   2. Block the time on Michael's calendar -- no invite sent to the client,
//      blocked time only (confirmed decision).
//   3. Check that day's "JRB Block Schedule" blocks for overlap and
//      auto-resolve STANDARD-tier conflicts (delete/shrink a single
//      occurrence only, never the series, never PROTECTED/DEEP_WORK blocks).
//   4. Append a to-do note to the next "Estimating / Proposal Production"
//      deep-work occurrence on or after the visit date.
//
// Drive-time before/after blocks are explicitly OUT of scope here -- see the
// TODO(drive-time) comment below. Michael is setting up an Azure Maps
// credential separately.

import { searchClients, getClientDetails } from './serviceautopilot.js';
import {
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  getCalendarEvent,
  getCalendarViewWithCategories,
} from './m365.js';
import { BLOCK_CATEGORY } from './calendar-watch.js';
import { logger } from '../../core/logger.js';

const ESTIMATING_BLOCK_SUBJECT = 'Estimating / Proposal Production [PROTECTED DEEP WORK]';

// How far ahead to search for the next Estimating block. The block recurs
// weekly on (at least) Tuesday and Thursday, so 14 days always covers at
// least two occurrences of each -- generous margin against a single missed
// week for any reason.
const TODO_LOOKAHEAD_DAYS = 14;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ── Small local-time helpers ────────────────────────────────────────────────
// Every timestamp in this file is a naive "YYYY-MM-DDTHH:MM:SS" wall-clock
// string with no zone offset -- the same convention createCalendarEvent/
// updateCalendarEvent already use (a separate `timezone` field carries the
// zone). new Date(naiveString) parses that as local server time, and the
// getFullYear/getMonth/... accessors read it back out the same way, so
// arithmetic and formatting round-trip correctly regardless of what zone the
// Node process itself runs in -- as long as parsing and formatting both stay
// on the local-getter side and never cross through toISOString()/UTC.

function pad2(n) { return String(n).padStart(2, '0'); }

function formatLocal(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function addMinutesLocal(dateTimeStr, minutes) {
  const d = new Date(dateTimeStr);
  d.setMinutes(d.getMinutes() + minutes);
  return formatLocal(d);
}

function addDaysToDateStr(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function toMs(dateTimeStr) { return new Date(dateTimeStr).getTime(); }

function overlaps(aStart, aEnd, bStart, bEnd) {
  return toMs(aStart) < toMs(bEnd) && toMs(bStart) < toMs(aEnd);
}

// ── Block classification (Phase 1's own established convention) ────────────
// Parses the subject suffix Phase 1's block-build already uses -- do not
// deviate from these exact literals without re-confirming with Michael, since
// the whole point is to match blocks he already built by hand.
// Exported (along with the two functions below) for direct unit/live testing
// without having to drive the full orchestrator end-to-end for every
// displacement scenario.
export function classifyBlockTier(subject = '') {
  if (subject.includes('PROTECTED DEEP WORK')) return 'DEEP_WORK';
  if (subject.includes('[PROTECTED]') || subject.includes('[FIXED WEEKLY BLOCK]')) return 'PROTECTED';
  return 'STANDARD';
}

// ── Body append helper (handles both text and html calendar bodies) ────────

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Appends `note` to an existing event body without clobbering it. Graph can
 * return either contentType -- events created via this codebase's own
 * `{contentType:'text'}` convention normally stay 'text', but Outlook clients
 * silently upgrade a body to 'html' the moment a human edits it in the app,
 * so this can't assume 'text' just because that's what we originally wrote.
 */
function appendNoteToBody({ content, contentType }, note) {
  if (contentType === 'html') {
    const safe = `<div>${escapeHtml(note)}</div>`;
    return /<\/body>/i.test(content) ? content.replace(/<\/body>/i, `${safe}</body>`) : `${content}${safe}`;
  }
  return content ? `${content}\n${note}` : note;
}

// ── Step 3: displacement check against the block schedule ──────────────────

export async function checkAndResolveDisplacement({ mailbox, date, visitStart, visitEnd }) {
  // Padded by a day on each side -- confirmed LIVE 2026-08-20 that Graph's
  // calendarView startDateTime/endDateTime query params are NOT reliably
  // reinterpreted into the Prefer: outlook.timezone zone the way the
  // *returned* event times are (an evening Chicago block whose UTC instant
  // rolls into the next UTC day was silently excluded by a same-day-string
  // window). The precise overlap filtering below still runs against each
  // event's correctly-zoned returned start/end, so widening the fetch window
  // only pulls in a few extra non-overlapping neighboring-day events -- it
  // can't cause a false conflict, only prevent a missed one.
  const dayStart = `${addDaysToDateStr(date, -1)}T00:00:00`;
  const dayEnd = `${addDaysToDateStr(date, 1)}T23:59:59`;
  const dayEvents = await getCalendarViewWithCategories({ userEmail: mailbox, startDateTime: dayStart, endDateTime: dayEnd });

  const overlapping = dayEvents.filter(e => e.categories.includes(BLOCK_CATEGORY) && overlaps(visitStart, visitEnd, e.start, e.end));

  if (overlapping.length === 0) {
    return { status: 'no_conflicts', resolvedActions: [], conflicts: [] };
  }

  const resolvedActions = [];
  const conflicts = [];

  for (const block of overlapping) {
    const tier = classifyBlockTier(block.subject || '');

    if (tier === 'DEEP_WORK' || tier === 'PROTECTED') {
      // Michael's explicit, confirmed decision: never silently touch a
      // PROTECTED/DEEP_WORK block. The visit itself is still created
      // regardless -- only the displacement is conditional.
      conflicts.push({
        eventId: block.id, subject: block.subject, tier,
        start: block.start, end: block.end,
        reason: `${tier} block -- never auto-touched, needs manual review`,
      });
      continue;
    }

    // STANDARD tier only, and only THIS occurrence (block.id here is the
    // calendarView-expanded occurrence id, distinct from the series
    // master's id -- PATCHing/DELETEing it creates a Graph exception for
    // just this date, confirmed live working in Phase 1).
    const vs = toMs(visitStart), ve = toMs(visitEnd), bs = toMs(block.start), be = toMs(block.end);

    if (vs <= bs && ve >= be) {
      // Visit fully contains the occurrence -- skip/delete just this one.
      await deleteCalendarEvent({ userEmail: mailbox, event_id: block.id });
      resolvedActions.push({
        eventId: block.id, subject: block.subject, tier, action: 'deleted_occurrence',
        before: { start: block.start, end: block.end },
      });
    } else if (vs <= bs && ve < be) {
      // Visit overlaps only the block's start edge -- shrink start forward
      // to the visit's end, leaving the remainder of the block intact.
      await updateCalendarEvent({ userEmail: mailbox, event_id: block.id, start: visitEnd });
      resolvedActions.push({
        eventId: block.id, subject: block.subject, tier, action: 'shrunk_start',
        before: { start: block.start, end: block.end },
        after:  { start: visitEnd, end: block.end },
      });
    } else if (vs > bs && ve >= be) {
      // Visit overlaps only the block's end edge -- shrink end backward to
      // the visit's start.
      await updateCalendarEvent({ userEmail: mailbox, event_id: block.id, end: visitStart });
      resolvedActions.push({
        eventId: block.id, subject: block.subject, tier, action: 'shrunk_end',
        before: { start: block.start, end: block.end },
        after:  { start: block.start, end: visitStart },
      });
    } else {
      // Visit falls strictly inside the middle of the block -- resolving
      // this automatically would require splitting the occurrence into two
      // separate pieces (a pre-visit remainder and a post-visit remainder).
      // ACCEPTED V1 SCOPE LIMIT: no automatic split. Flag for manual review
      // instead, same as a PROTECTED/DEEP_WORK conflict.
      conflicts.push({
        eventId: block.id, subject: block.subject, tier,
        start: block.start, end: block.end,
        reason: 'visit falls inside the middle of this STANDARD block -- would require splitting it into two pieces, not supported in v1',
      });
    }
  }

  const status = conflicts.length > 0 ? 'manual_review_needed' : 'auto_resolved';
  return { status, resolvedActions, conflicts };
}

// ── Step 4: to-do injection into the next Estimating block ─────────────────

export async function injectEstimateTodo({ mailbox, date, clientName, visitStart }) {
  const windowStart = `${date}T00:00:00`;
  const windowEndDate = addDaysToDateStr(date, TODO_LOOKAHEAD_DAYS);
  const windowEnd = `${windowEndDate}T23:59:59`;

  // Same query-window padding rationale as checkAndResolveDisplacement --
  // the fetch window is widened by a day on each side so a late-evening
  // occurrence near either boundary isn't silently excluded by Graph's
  // query-param zone handling; the dayStartMs filter below (based on the
  // *unpadded* intended start) still enforces "on or after the visit date"
  // using each event's correctly-zoned returned start time.
  const events = await getCalendarViewWithCategories({
    userEmail: mailbox,
    startDateTime: `${addDaysToDateStr(date, -1)}T00:00:00`,
    endDateTime: `${addDaysToDateStr(windowEndDate, 1)}T23:59:59`,
    limit: 200,
  });

  const dayStartMs = toMs(windowStart);
  const candidates = events
    .filter(e => e.subject === ESTIMATING_BLOCK_SUBJECT && toMs(e.start) >= dayStartMs)
    .sort((a, b) => toMs(a.start) - toMs(b.start));

  if (candidates.length === 0) {
    return {
      status: 'not_found',
      searchedThroughDate: windowEndDate,
      note: `No "${ESTIMATING_BLOCK_SUBJECT}" occurrence found on/after ${date} within ${TODO_LOOKAHEAD_DAYS} days.`,
    };
  }

  // Whichever comes first chronologically -- Tuesday or Thursday, doesn't
  // matter which (Michael's confirmed decision).
  const occurrence = candidates[0];
  const full = await getCalendarEvent({ event_id: occurrence.id, userEmail: mailbox });
  const note = `📍 Estimate needed: ${clientName} (site visit ${date})`;
  const newBody = appendNoteToBody(full, note);
  await updateCalendarEvent({
    userEmail: mailbox, event_id: occurrence.id, body: newBody, bodyContentType: full.contentType,
  });

  return {
    status: 'appended',
    occurrenceId: occurrence.id,
    occurrenceDate: occurrence.start.slice(0, 10),
    occurrenceSubject: occurrence.subject,
    noteAdded: note,
  };
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Schedules an estimate visit: SA lookup -> calendar block (no invite) ->
 * block-schedule displacement check/auto-resolve -> to-do note on the next
 * Estimating block. See file header for the full step breakdown.
 *
 * Returns a structured result the caller can relay to Michael directly:
 *   { status: 'needs_clarification', reason, candidates }
 * or
 *   { status: 'created', visit, displacement, todo, driveTime }
 */
export async function scheduleEstimateVisit({ clientName, date, startTime, durationMinutes = 30, mailbox = 'michael@jrboehlke.com' } = {}) {
  // Destructured defaults only cover `undefined`, not an explicit `null` --
  // an LLM-formed call passing `mailbox: null` should still fall back to the
  // default rather than fail validation below.
  if (mailbox === null) mailbox = 'michael@jrboehlke.com';

  // Every one of these is validated by TYPE first, not just truthiness --
  // dispatcher.js calls tool handlers with whatever JSON the LLM produced,
  // with no schema validation of its own before dispatch. A malformed call
  // (wrong type, not just a missing field) reaches this function directly,
  // so `typeof x !== 'string'` has to be checked before any string method
  // (.trim(), .split(), regex .test() with implicit ToString coercion) is
  // called on it, or a bad LLM-supplied value throws an unguarded TypeError
  // from deep inside this file instead of one clean, actionable error here.
  if (typeof clientName !== 'string' || !clientName.trim()) {
    throw new Error(`scheduleEstimateVisit: clientName is required and must be a non-empty string, got ${JSON.stringify(clientName)}`);
  }
  if (typeof date !== 'string' || !DATE_RE.test(date)) {
    throw new Error(`scheduleEstimateVisit: date must be a YYYY-MM-DD string, got ${JSON.stringify(date)}`);
  }
  // The regex alone accepts calendar nonsense like "2026-13-45" -- round-trip
  // through Date's own field getters to catch that before it reaches Graph
  // (which would otherwise 400 deep inside createCalendarEvent with a much
  // less useful error message pointing at the wrong layer).
  {
    const [y, mo, da] = date.split('-').map(Number);
    const check = new Date(y, mo - 1, da);
    if (check.getFullYear() !== y || check.getMonth() !== mo - 1 || check.getDate() !== da) {
      throw new Error(`scheduleEstimateVisit: "${date}" is not a valid calendar date`);
    }
  }
  if (typeof startTime !== 'string' || !TIME_RE.test(startTime)) {
    throw new Error(`scheduleEstimateVisit: startTime must be an "HH:MM" (24h) string, got ${JSON.stringify(startTime)}`);
  }
  if (typeof mailbox !== 'string' || !mailbox.trim()) {
    throw new Error(`scheduleEstimateVisit: mailbox must be a non-empty string, got ${JSON.stringify(mailbox)}`);
  }
  const duration = Number.isFinite(durationMinutes) && durationMinutes > 0
    ? Math.min(Math.floor(durationMinutes), 480)
    : 30;

  // Step 1: SA client lookup. Don't guess on zero or multiple matches --
  // hand it back for Michael to disambiguate.
  //
  // KNOWN LIMITATION (confirmed live 2026-08-20): SA's V2AccountList_Query
  // name filter (FieldColumn '1'/ContainOperator '1') appears to be a no-op
  // server-side -- it returns the same ~30-row default page regardless of
  // the search term, and searchClients only does a client-side substring
  // check over that page (see its own comment in serviceautopilot.js). For
  // a client base in the thousands, a specific client not already in that
  // arbitrary default page will come back as a false "not found" here even
  // though the account genuinely exists in SA. Not fixed in this build --
  // reverse-engineering SA's real full-text search endpoint is a separate,
  // substantial effort outside Phase 2's scope. Worth Michael knowing this
  // tool's "client not found" result isn't fully reliable yet.
  const matches = await searchClients({ name: clientName });
  if (matches.length !== 1) {
    return {
      status: 'needs_clarification',
      reason: matches.length === 0
        ? `No SA client found matching "${clientName}".`
        : `${matches.length} SA clients match "${clientName}" -- ask Michael which one he means.`,
      candidates: matches.map(m => ({ clientId: m.clientId, name: m.name, address: m.address, type: m.type })),
    };
  }
  const clientMatch = matches[0];
  const details = await getClientDetails({ clientId: clientMatch.clientId });

  // Step 2: create the calendar block. No attendees, no recurrence, no
  // "JRB Block Schedule" category (this is a real appointment, not
  // Phase 1's own scaffolding -- never tag it with that sentinel).
  const visitStart = `${date}T${startTime}:00`;
  const visitEnd = addMinutesLocal(visitStart, duration);

  const bodyLines = [];
  if (details.phone) bodyLines.push(`Phone: ${details.phone}`);
  if (details.address) bodyLines.push(`Address: ${details.address}`);
  bodyLines.push('Estimate visit scheduled via JRB Agent -- blocked time only, no invite sent to the client.');
  // TODO(drive-time): once the Azure Maps credential is set up, insert real
  // blocked before/after travel-time calendar events here, sized from the
  // drive time between Michael's prior stop and this address (confirmed
  // design: actual blocked calendar time, not just a text note). Deferred --
  // no Maps integration in this build.
  const body = bodyLines.join('\n');

  const created = await createCalendarEvent({
    subject: `Estimate Visit: ${clientMatch.name}`,
    start: visitStart,
    end: visitEnd,
    body,
    userEmail: mailbox,
    location: details.address || undefined,
  });

  const visit = {
    eventId: created.event_id,
    clientId: clientMatch.clientId,
    clientName: clientMatch.name,
    date, startTime,
    durationMinutes: duration,
    start: visitStart,
    end: visitEnd,
    address: details.address || null,
    phone: details.phone || null,
    mailbox,
  };

  // Steps 3 and 4 are best-effort from here -- the visit itself already
  // exists, so a failure in either must be reported back, never thrown away
  // silently (that would mean Michael never finds out the block schedule or
  // to-do note needs manual attention).
  let displacement;
  try {
    displacement = await checkAndResolveDisplacement({ mailbox, date, visitStart, visitEnd });
  } catch (err) {
    logger.error('scheduleEstimateVisit: displacement check failed', { error: err.message, eventId: created.event_id });
    displacement = { status: 'error', error: err.message, resolvedActions: [], conflicts: [] };
  }

  let todo;
  try {
    todo = await injectEstimateTodo({ mailbox, date, clientName: clientMatch.name, visitStart });
  } catch (err) {
    logger.error('scheduleEstimateVisit: to-do injection failed', { error: err.message, eventId: created.event_id });
    todo = { status: 'error', error: err.message };
  }

  logger.info('scheduleEstimateVisit: complete', {
    eventId: created.event_id, clientName: clientMatch.name, date, startTime,
    displacementStatus: displacement.status, todoStatus: todo.status,
  });

  return {
    status: 'created',
    visit,
    displacement,
    todo,
    driveTime: 'deferred -- Azure Maps drive-time blocks not yet built (see TODO(drive-time) in tools/impl/scheduling-visits.js)',
  };
}
