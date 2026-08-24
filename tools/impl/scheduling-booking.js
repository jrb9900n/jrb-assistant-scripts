// tools/impl/scheduling-booking.js — Phase B of the privacy/calendar-tiering
// roadmap: lets an employee (or Michael himself) check Michael's availability
// and book real time on his calendar, with the block-schedule displacement
// mechanics from scheduling-visits.js doing the actual conflict resolution.
//
// checkMichaelAvailability() shows STANDARD/OCCASIONAL-covered time as
// available alongside genuinely free time (confirmed decision -- the real
// safety net is the cap/tier check at actual booking time, not hiding slots
// upfront). bookTimeWithMichael() re-checks for real at booking time via
// checkAndResolveDisplacement, and on a decline never reveals the real
// subject/tier/reason to an employee requester -- only to Michael.

import { getFreeBusy, createCalendarEvent } from './m365.js';
import { getCalendarViewWithCategories } from './m365.js';
import { BLOCK_CATEGORY } from './calendar-watch.js';
import { classifyBlockTier, checkAndResolveDisplacement } from './scheduling-visits.js';
import { logger } from '../../core/logger.js';

const MICHAEL_MAILBOX = 'michael@jrboehlke.com';

// v1 business-hours assumption -- not yet confirmed with Michael as a
// standing rule, just a reasonable default for "when would he take a
// meeting." Revisit if this needs to be configurable later.
const BUSINESS_START_HOUR = 8;
const BUSINESS_END_HOUR = 17;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function pad2(n) { return String(n).padStart(2, '0'); }
function toMs(dateTimeStr) { return new Date(dateTimeStr).getTime(); }
function overlaps(aStart, aEnd, bStart, bEnd) { return toMs(aStart) < toMs(bEnd) && toMs(bStart) < toMs(aEnd); }

function addMinutesLocal(dateTimeStr, minutes) {
  const d = new Date(dateTimeStr);
  d.setMinutes(d.getMinutes() + minutes);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function validateDate(date, fnName) {
  if (typeof date !== 'string' || !DATE_RE.test(date)) {
    throw new Error(`${fnName}: date must be a YYYY-MM-DD string, got ${JSON.stringify(date)}`);
  }
  const [y, mo, da] = date.split('-').map(Number);
  const check = new Date(y, mo - 1, da);
  if (check.getFullYear() !== y || check.getMonth() !== mo - 1 || check.getDate() !== da) {
    throw new Error(`${fnName}: "${date}" is not a valid calendar date`);
  }
}

function mergeIntervals(intervals) {
  if (!intervals.length) return [];
  const sorted = [...intervals].sort((a, b) => toMs(a.start) - toMs(b.start));
  const merged = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (toMs(sorted[i].start) <= toMs(last.end)) {
      if (toMs(sorted[i].end) > toMs(last.end)) last.end = sorted[i].end;
    } else {
      merged.push({ ...sorted[i] });
    }
  }
  return merged;
}

/**
 * Returns open windows within business hours on `date`, each at least
 * `durationMinutes` long. A window that's actually covered by a STANDARD or
 * OCCASIONAL block still shows as available -- displacing it is a normal,
 * expected outcome of booking there, not a conflict. A window covered by a
 * PROTECTED/DEEP_WORK block, or by a real (non-block) meeting, does not.
 */
export async function checkMichaelAvailability({ date, durationMinutes = 30, mailbox = MICHAEL_MAILBOX } = {}) {
  validateDate(date, 'checkMichaelAvailability');
  const duration = Number.isFinite(durationMinutes) && durationMinutes > 0
    ? Math.min(Math.floor(durationMinutes), 480)
    : 30;
  if (typeof mailbox !== 'string' || !mailbox.trim()) mailbox = MICHAEL_MAILBOX;

  const dayStart = `${date}T${pad2(BUSINESS_START_HOUR)}:00:00`;
  const dayEnd = `${date}T${pad2(BUSINESS_END_HOUR)}:00:00`;

  const [freeBusy, dayEvents] = await Promise.all([
    getFreeBusy({ userEmail: mailbox, startDateTime: dayStart, endDateTime: dayEnd, intervalMinutes: 15 }),
    getCalendarViewWithCategories({ userEmail: mailbox, startDateTime: `${date}T00:00:00`, endDateTime: `${date}T23:59:59` }),
  ]);

  const blocks = dayEvents.filter(e => e.categories.includes(BLOCK_CATEGORY));

  function isSoftBusy(slotStart, slotEnd) {
    return blocks.some(b => {
      const tier = classifyBlockTier(b.subject || '');
      return (tier === 'STANDARD' || tier === 'OCCASIONAL') && overlaps(slotStart, slotEnd, b.start, b.end);
    });
  }

  const hardBusy = mergeIntervals(
    freeBusy
      .filter(s => s.status === 'busy' || s.status === 'oof' || s.status === 'tentative')
      .filter(s => !isSoftBusy(s.start, s.end))
      .map(s => ({ start: s.start, end: s.end }))
  );

  const availableWindows = [];
  let cursor = dayStart;
  for (const b of hardBusy) {
    if (toMs(b.start) > toMs(cursor)) availableWindows.push({ start: cursor, end: b.start });
    if (toMs(b.end) > toMs(cursor)) cursor = b.end;
  }
  if (toMs(cursor) < toMs(dayEnd)) availableWindows.push({ start: cursor, end: dayEnd });

  const usable = availableWindows.filter(w => toMs(w.end) - toMs(w.start) >= duration * 60000);

  return { date, durationMinutes: duration, availableWindows: usable };
}

/**
 * Books real time on Michael's calendar with a genuine Outlook invite to the
 * requester. `isEmployeeRequester`/`requesterIdentity` are deliberately NOT
 * meant to be LLM-fillable -- tools/dispatcher.js's handler for
 * book_time_with_michael passes them in from the trusted `context` object
 * Phase A threads through, never from the tool's own JSON input schema, so a
 * requester can't claim to be Michael or spoof another employee's identity.
 */
export async function bookTimeWithMichael({
  requesterName, requesterEmail, date, startTime, durationMinutes = 30, subject,
  mailbox = MICHAEL_MAILBOX, isEmployeeRequester = false, requesterIdentity = null,
} = {}) {
  if (typeof requesterName !== 'string' || !requesterName.trim()) {
    throw new Error(`bookTimeWithMichael: requesterName is required and must be a non-empty string, got ${JSON.stringify(requesterName)}`);
  }
  if (typeof requesterEmail !== 'string' || !requesterEmail.trim()) {
    throw new Error(`bookTimeWithMichael: requesterEmail is required and must be a non-empty string, got ${JSON.stringify(requesterEmail)}`);
  }
  validateDate(date, 'bookTimeWithMichael');
  if (typeof startTime !== 'string' || !TIME_RE.test(startTime)) {
    throw new Error(`bookTimeWithMichael: startTime must be an "HH:MM" (24h) string, got ${JSON.stringify(startTime)}`);
  }
  const duration = Number.isFinite(durationMinutes) && durationMinutes > 0
    ? Math.min(Math.floor(durationMinutes), 480)
    : 30;
  if (typeof mailbox !== 'string' || !mailbox.trim()) mailbox = MICHAEL_MAILBOX;

  const visitStart = `${date}T${startTime}:00`;
  const visitEnd = addMinutesLocal(visitStart, duration);

  // Real conflict/cap check happens here, at actual booking time -- not just
  // at checkMichaelAvailability time. A slot that looked open a minute ago
  // can still be declined here (an OCCASIONAL block's cap used up by a
  // different booking in between, or a real meeting added in the interim).
  let disp;
  try {
    disp = await checkAndResolveDisplacement({
      mailbox, date, visitStart, visitEnd,
      callerTag: 'book_time_with_michael',
      requesterIdentity: requesterIdentity ?? requesterEmail,
    });
  } catch (err) {
    logger.error('bookTimeWithMichael: displacement check failed', { error: err.message, requesterEmail, date, startTime });
    throw err;
  }

  if (disp.status === 'manual_review_needed') {
    logger.info('bookTimeWithMichael: declined -- conflict needs manual review', {
      requesterEmail, date, startTime, conflicts: disp.conflicts,
    });
    // An employee requester never sees the real subject/tier/reason -- only
    // a generic decline. Michael gets the full detail (this function's own
    // return value, used when isEmployeeRequester is false, e.g. Michael
    // booking on someone else's behalf via chat).
    return {
      status: 'declined',
      reason: isEmployeeRequester
        ? 'That time is not available. Please try a different time.'
        : `Conflict needs manual review: ${disp.conflicts.map(c => c.reason).join('; ')}`,
      conflicts: isEmployeeRequester ? undefined : disp.conflicts,
    };
  }

  const created = await createCalendarEvent({
    subject: (typeof subject === 'string' && subject.trim()) || `Meeting with ${requesterName}`,
    start: visitStart,
    end: visitEnd,
    body: `Booked via JRB Agent${isEmployeeRequester ? ' (employee booking request)' : ''}.`,
    userEmail: mailbox,
    attendees: [{ email: requesterEmail, name: requesterName }],
  });

  return {
    status: 'booked',
    eventId: created.event_id,
    date, startTime, durationMinutes: duration,
    start: visitStart, end: visitEnd,
    resolvedActions: disp.resolvedActions,
  };
}
