// tools/impl/block-schedule-reconciler.js — Phase 3 of the Autonomous Schedule
// Manager roadmap: general auto-displacement, but for a different trigger and
// a different rule than scheduling-visits.js's checkAndResolveDisplacement.
//
// checkAndResolveDisplacement (scheduling-visits.js) fires when THIS agent is
// about to create a new visit/booking, and deliberately never touches
// PROTECTED/DEEP_WORK blocks -- that invariant stays exactly as-is for that
// flow (scheduleEstimateVisit, book_time_with_michael).
//
// This module fires the opposite direction: a REAL, already-existing (or
// newly landed) calendar item -- a meeting invite Michael accepted, a webinar,
// a recurring series like Breakthrough Academy ("BTA") -- takes priority over
// ANY block, PROTECTED/DEEP_WORK included. Confirmed by Michael 2026-08-24:
// "as a general rule, move to accommodate real invites." The block schedule is
// scaffolding for unstructured time; a real commitment always wins over it.
//
// One named exception, also confirmed live 2026-08-24: the recurring "JRB
// weekly status" call sitting inside "Legal / Lawsuit [PROTECTED DEEP WORK]"
// is intentional (the two are related -- the status call IS about the
// lawsuit), not a conflict. EXEMPTIONS below is deliberately a short,
// explicit list rather than a heuristic, since guessing wrong here either
// direction is bad: silently displacing an intentional co-location, or
// silently leaving a genuine conflict unresolved.

import { getCalendarViewWithCategories, updateCalendarEvent, deleteCalendarEvent, acceptCalendarEvent, toLocalNaiveFromUtc } from './m365.js';
import { BLOCK_CATEGORY } from './calendar-watch.js';
import { classifyBlockTier } from './scheduling-visits.js';
import { logger } from '../../core/logger.js';

export const BTA_DOMAIN = 'btacademy.com';

// Explicit, named exceptions -- real items that overlap a block on purpose and
// must never be "resolved." Matched on the block subject substring + either
// the real event's organizer or its subject (whichever is the more stable
// identifier for that specific case).
const EXEMPTIONS = [
  {
    label: 'JRB weekly status inside Legal/Lawsuit (confirmed intentional 2026-08-24)',
    blockSubjectIncludes: 'Legal / Lawsuit',
    realEventOrganizer: 'bdn@hallingcayo.com',
  },
];

function isExempt(block, realEvent) {
  return EXEMPTIONS.some(ex =>
    block.subject?.includes(ex.blockSubjectIncludes) &&
    (ex.realEventOrganizer ? realEvent.organizer === ex.realEventOrganizer : true) &&
    (ex.realEventSubject ? realEvent.subject === ex.realEventSubject : true)
  );
}

function toMs(s) { return new Date(s).getTime(); }
function overlaps(aStart, aEnd, bStart, bEnd) { return toMs(aStart) < toMs(bEnd) && toMs(bStart) < toMs(aEnd); }

// Same delete/shrink-start/shrink-end mechanics as scheduling-visits.js's
// resolveDisplaceableBlock, generalized for a fourth case that function
// deliberately leaves unresolved: a real event falling in the MIDDLE of a
// block (neither edge touched). True splitting (keep a before-piece AND an
// after-piece as two separate occurrences) is possible but adds real
// complexity for a case that's usually a short meeting inside a long block --
// this keeps whichever remaining side (before vs. after) is longer and drops
// the shorter one, which is what a person would do by hand for a 5-10 minute
// remainder (confirmed as the right call against two real cases 2026-08-24:
// the Sept 2 webinar and the recurring BTA 1:1, both left a <15-min remainder
// on one side).
async function resolveBlockAgainstRealEvent({ block, realStart, realEnd, mailbox }) {
  const vs = toMs(realStart), ve = toMs(realEnd), bs = toMs(block.start), be = toMs(block.end);

  if (vs <= bs && ve >= be) {
    await deleteCalendarEvent({ userEmail: mailbox, event_id: block.id });
    return { action: 'deleted_occurrence', before: { start: block.start, end: block.end } };
  }
  if (vs <= bs && ve < be) {
    await updateCalendarEvent({ userEmail: mailbox, event_id: block.id, start: realEnd });
    return { action: 'shrunk_start', before: { start: block.start, end: block.end }, after: { start: realEnd, end: block.end } };
  }
  if (vs > bs && ve >= be) {
    await updateCalendarEvent({ userEmail: mailbox, event_id: block.id, end: realStart });
    return { action: 'shrunk_end', before: { start: block.start, end: block.end }, after: { start: block.start, end: realStart } };
  }
  // Middle overlap -- keep the larger remaining side, drop the smaller one.
  const beforeMinutes = (vs - bs) / 60000;
  const afterMinutes = (be - ve) / 60000;
  if (beforeMinutes >= afterMinutes) {
    await updateCalendarEvent({ userEmail: mailbox, event_id: block.id, end: realStart });
    return { action: 'shrunk_to_before', before: { start: block.start, end: block.end }, after: { start: block.start, end: realStart }, droppedMinutes: Math.round(afterMinutes) };
  }
  await updateCalendarEvent({ userEmail: mailbox, event_id: block.id, start: realEnd });
  return { action: 'shrunk_to_after', before: { start: block.start, end: block.end }, after: { start: realEnd, end: block.end }, droppedMinutes: Math.round(beforeMinutes) };
}

/**
 * Reconciles ONE real (non-block) calendar event against that day's block
 * schedule: auto-accepts it if it's a not-yet-responded BTA invite, then
 * resolves every overlapping block in favor of the real event -- any tier,
 * per Michael's confirmed general rule -- except the named EXEMPTIONS above.
 *
 * @param {object} opts
 * @param {string} opts.mailbox
 * @param {object} opts.realEvent - one item from calendar-watch.js's getCalendarChanges()
 * @returns {Promise<{skipped: string|null, accepted: boolean, resolvedActions: object[], exempted: object[]}>}
 */
export async function reconcileRealEventAgainstBlocks({ mailbox, realEvent }) {
  // All-day markers (holidays, "Jojo Goes to Work Early"-style personal
  // reminders that happen to span midnight-to-midnight) aren't real time
  // commitments needing a slot -- they trivially "overlap" every block that
  // day and would otherwise be treated as a conflict against literally
  // everything.
  if (realEvent.isAllDay) return { skipped: 'all_day', accepted: false, resolvedActions: [], exempted: [] };
  // A declined meeting isn't actually happening for Michael -- nothing to
  // accommodate.
  if (realEvent.responseStatus === 'declined') return { skipped: 'declined', accepted: false, resolvedActions: [], exempted: [] };
  if (!realEvent.start || !realEvent.end) return { skipped: 'no_time', accepted: false, resolvedActions: [], exempted: [] };

  // calendar-watch.js's getCalendarChanges() returns bare UTC dateTime strings
  // (confirmed live -- no Prefer: outlook.timezone header on that delta query,
  // unlike getCalendarViewWithCategories below, which DOES send that header
  // and returns local-wall-clock strings). Comparing the two conventions
  // directly would silently reproduce the exact bug just fixed in getFreeBusy
  // (m365.js) -- a several-hour offset between "real event" and "block" times
  // that never throws, just quietly mismatches.
  const realStart = toLocalNaiveFromUtc(realEvent.start);
  const realEnd = toLocalNaiveFromUtc(realEvent.end);

  let accepted = false;
  const isBta = (realEvent.organizer || '').toLowerCase().includes(BTA_DOMAIN);
  if (isBta && realEvent.responseStatus !== 'accepted' && !realEvent.isOrganizer) {
    try {
      await acceptCalendarEvent({ userEmail: mailbox, event_id: realEvent.id });
      accepted = true;
    } catch (err) {
      // Non-fatal -- the block-vs-real-event resolution below is the more
      // important half of this function and should still run even if the
      // accept call fails (e.g. Graph transiently unavailable).
      logger.warn('block-schedule-reconciler: auto-accept failed', { eventId: realEvent.id, err: err.message });
    }
  }

  // Uses the LOCAL (post-conversion) date -- realEvent.start's raw UTC date
  // can legitimately differ from its local calendar date near midnight (e.g.
  // an 11pm Central event is already the next day in UTC), and the block
  // schedule is defined in local wall-clock terms.
  const date = realStart.slice(0, 10);
  const dayEvents = await getCalendarViewWithCategories({
    userEmail: mailbox,
    startDateTime: `${date}T00:00:00`,
    endDateTime: `${date}T23:59:59`,
  });
  const blocks = [...new Map(
    dayEvents
      .filter(e => e.categories.includes(BLOCK_CATEGORY) && overlaps(realStart, realEnd, e.start, e.end))
      .map(e => [e.id, e])
  ).values()];

  const resolvedActions = [];
  const exempted = [];
  for (const block of blocks) {
    if (isExempt(block, realEvent)) {
      exempted.push({ blockSubject: block.subject, blockStart: block.start, blockEnd: block.end });
      continue;
    }
    const tier = classifyBlockTier(block.subject || '');
    const outcome = await resolveBlockAgainstRealEvent({ block, realStart, realEnd, mailbox });
    resolvedActions.push({ blockSubject: block.subject, tier, ...outcome });
  }

  return { skipped: null, accepted, resolvedActions, exempted };
}
