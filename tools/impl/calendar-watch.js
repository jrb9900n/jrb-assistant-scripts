// tools/impl/calendar-watch.js — Detects real (non-block) changes on a
// calendar via Microsoft Graph delta queries, so later phases (auto
// displacement, estimate-visit scheduling) can react to new meetings or
// accepted invites without polling and diffing raw snapshots ourselves.
//
// Block-schedule events are tagged with the 'JRB Block Schedule' Outlook
// category at creation time and are filtered out here -- they're not
// "real life" showing up on the calendar, they're our own scaffolding.
// Reserved sentinel: callers creating a real meeting should never pass
// this exact category string, or calendar-watch.js will wrongly treat it
// as one of ours and silently exclude it from detection.
//
// getCalendarChanges() is deliberately NOT exposed as an agent tool in
// tools/registry.js/dispatcher.js, unlike most tools/impl/*.js functions.
// Every call consumes and advances the stored delta cursor as a side
// effect -- an ad hoc conversational invocation would either steal changes
// the next scheduled poll was about to report, or vice versa, corrupting
// the cron task's own view of "what's new since last time." This is a
// cron-only primitive by design, not an oversight.

import { createClient } from '@supabase/supabase-js';
import { graph } from './m365.js';
import { logger } from '../../core/logger.js';

// Exported so other Phase 2+ modules (e.g. scheduling-visits.js's displacement
// check) reference this exact literal instead of re-declaring their own copy
// that could silently drift out of sync with this one.
export const BLOCK_CATEGORY = 'JRB Block Schedule';

function supabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// Graph's calendarView/delta is windowed at bootstrap time -- the
// startDateTime/endDateTime given on the FIRST request get baked into the
// token, and continuing to call the returned deltaLink keeps reporting
// changes only within that original window. It does not slide forward as
// real time advances. Left unhandled, the feature would silently go dark
// once "now" approaches the original endDateTime -- no error, no alert,
// just zero results forever. REBOOTSTRAP_MARGIN_MS re-bootstraps with a
// fresh window well before that boundary is ever reached.
const REBOOTSTRAP_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;

async function getDeltaState(mailbox) {
  const { data, error } = await supabase()
    .from('calendar_delta_state')
    .select('delta_link, window_end')
    .eq('mailbox', mailbox)
    .maybeSingle();
  // Throw rather than swallow -- a transient read failure here silently
  // forces bootstrap mode (which itself returns [] unconditionally), so a
  // persistent problem would otherwise run forever, every 10 minutes,
  // logging nothing and detecting nothing. Same failure class already hit
  // twice in this project (feedback-capture.js's rules-table 400s).
  if (error) throw new Error(`calendar-watch: getDeltaState failed for ${mailbox}: ${error.message}`, { cause: error });
  return data ?? null;
}

async function saveDeltaState(mailbox, deltaLink, windowEnd) {
  const { error } = await supabase()
    .from('calendar_delta_state')
    .upsert({ mailbox, delta_link: deltaLink, window_end: windowEnd, updated_at: new Date().toISOString() }, { onConflict: 'mailbox' });
  // Throw, don't warn-and-continue -- if this write silently fails, the next
  // call finds no stored cursor and re-bootstraps forever, returning []
  // every run with no visible symptom other than "nothing is ever detected."
  if (error) throw new Error(`calendar-watch: saveDeltaState failed for ${mailbox}: ${error.message}`, { cause: error });
}

// $select is required here, not optional -- confirmed live 2026-08-24 that
// Graph's calendarView/delta returns a minimal payload for expanded
// occurrences of a long-running recurring series (id/start/end/
// lastModifiedDateTime only), omitting inherited fields like `subject` and
// `categories` unless explicitly selected. Two real symptoms traced to this:
// (1) notifications rendering "**undefined**" as the event title, and (2)
// our own JRB-Block-Schedule-tagged events (e.g. the President Weekly Block
// Schedule's "Operations Pulse" occurrences) slipping past the
// categories.includes(BLOCK_CATEGORY) filter below and firing as if they
// were new real-life changes, because `e.categories` came back undefined
// and `(undefined || []).includes(...)` is always false. A plain
// calendarView query with the same $select (m365.js's listCalendarEvents)
// already returns these fields correctly for the same events -- this is a
// delta-endpoint-specific default, not a data problem on the events
// themselves. Selecting the fields the mapping below actually reads fixes
// both at once. Applied only in bootstrapUrl -- Graph's deltaLink preserves
// the $select scope from the request that created it, so a stored cursor
// created before this fix keeps running the old (unselected) query until it
// re-bootstraps -- which otherwise wouldn't happen for ~53 more days (the
// 60-day window vs. the 7-day REBOOTSTRAP_MARGIN_MS). The michael@jrboehlke.com
// row that was actively producing the undefined-subject spam was manually
// deleted from calendar_delta_state as a one-off action when this bug was
// diagnosed (2026-08-24), forcing an immediate re-bootstrap on this fix's
// first post-deploy poll. That was a manual DB operation, not something this
// code does -- if this same class of bug recurs on a different mailbox, or
// this fix merges long after that manual clear, the row needs clearing again
// (or wait out the natural re-bootstrap) before the fix actually takes effect.
function bootstrapUrl(mailbox, lookAheadDays) {
  const start = new Date().toISOString();
  const end = new Date(Date.now() + lookAheadDays * 24 * 60 * 60 * 1000).toISOString();
  const select = 'id,subject,start,end,isOrganizer,organizer,responseStatus,isCancelled,categories,lastModifiedDateTime,seriesMasterId,type';
  return { url: `/users/${mailbox}/calendarView/delta?startDateTime=${start}&endDateTime=${end}&$select=${select}`, windowEnd: end };
}

/**
 * Returns newly-added-or-modified events on `mailbox`'s calendar since the
 * last call, excluding JRB block-schedule events. On the very first call
 * for a mailbox (or once the stored window is close to expiring, or if
 * Graph rejects the stored cursor outright) there's no usable "since last
 * time" cursor -- this bootstraps a fresh one scoped to `lookAheadDays`
 * and returns an empty array for that call.
 *
 * @param {object} opts
 * @param {string} opts.mailbox
 * @param {number} [opts.lookAheadDays] - only used when bootstrapping (default 60)
 */
export async function getCalendarChanges({ mailbox, lookAheadDays = 60 }) {
  // A lookAheadDays <= REBOOTSTRAP_MARGIN_MS's 7-day equivalent would make
  // windowStale true on effectively every call, permanently re-bootstrapping
  // (which always returns [] by design) with zero visible symptom -- the
  // task would look healthy forever while detecting nothing. Not reachable
  // by the current caller (cron.js always uses the 60-day default), but
  // guard it so a future caller can't silently hit this.
  if (lookAheadDays * 24 * 60 * 60 * 1000 <= REBOOTSTRAP_MARGIN_MS) {
    throw new Error(`getCalendarChanges: lookAheadDays (${lookAheadDays}) must exceed the ${REBOOTSTRAP_MARGIN_MS / 86400000}-day re-bootstrap margin, or every call would permanently re-bootstrap and never detect a change`);
  }
  const state = await getDeltaState(mailbox);
  const windowStale = state?.window_end && (new Date(state.window_end).getTime() - Date.now() < REBOOTSTRAP_MARGIN_MS);

  let url, bootstrapping, windowEnd;
  if (state && !windowStale) {
    url = state.delta_link;
    windowEnd = state.window_end; // preserve -- must survive to the save call below unchanged
    bootstrapping = false;
  } else {
    bootstrapping = true;
    ({ url, windowEnd } = bootstrapUrl(mailbox, lookAheadDays));
  }

  const raw = [];
  let recoveredFromInvalidCursor = false;
  while (url) {
    let data;
    try {
      data = await graph('GET', url);
    } catch (err) {
      // A stored cursor Graph no longer accepts (expired, mailbox change,
      // etc.) surfaces as a 410 from the graph() wrapper, whose message
      // format is "Graph GET <path> → <status>: <body-derived text>" --
      // matching "→ 410:" specifically (not a bare /410/ anywhere in the
      // string) avoids a false match on an opaque nextLink/deltaLink token
      // that happens to contain the digits "410". Also matches Graph's
      // known error codes for this case (resyncRequired, SyncStateNotFound)
      // in case the body text itself carries one of those instead.
      if (!bootstrapping && !recoveredFromInvalidCursor && /→ 410:|resyncrequired|syncstatenotfound/i.test(err.message)) {
        logger.warn('calendar-watch: stored delta cursor invalidated by Graph, re-bootstrapping', { mailbox, err: err.message });
        recoveredFromInvalidCursor = true;
        bootstrapping = true;
        ({ url, windowEnd } = bootstrapUrl(mailbox, lookAheadDays));
        continue;
      }
      throw err;
    }
    raw.push(...(data.value ?? []));
    if (data['@odata.nextLink']) {
      url = data['@odata.nextLink'];
    } else {
      if (data['@odata.deltaLink']) await saveDeltaState(mailbox, data['@odata.deltaLink'], windowEnd);
      url = null;
    }
  }

  // If a 410 hit mid-pagination (after some pages already pushed real delta
  // results into `raw`), those results are intentionally discarded here too,
  // not just the fresh bootstrap's own snapshot -- a 410 invalidates the
  // whole delta session per Graph's own contract, so partial results
  // obtained under that now-invalid session aren't trustworthy either.
  // Accepted gap: any real change that happened strictly between the old
  // cursor's last-good point and this re-bootstrap moment is genuinely not
  // reported -- it's already baked into the fresh snapshot indistinguishably
  // from pre-existing events, and bootstrap always returns [] for its own
  // call. Same class of narrow, rare-window tradeoff as the other Phase 1
  // accepted limitations documented in this file and in teams/bot.js.
  if (bootstrapping) {
    logger.info('calendar-watch: bootstrapped delta cursor', { mailbox, lookAheadDays, initialEvents: raw.length, recoveredFromInvalidCursor });
    return [];
  }

  return raw
    .filter(e => !e['@removed'])
    .filter(e => !(e.categories || []).includes(BLOCK_CATEGORY))
    .map(e => ({
      id: e.id,
      // Callers should dedupe on `id + lastModifiedDateTime`, not `id` alone --
      // the same event id legitimately reappears across polls whenever it's
      // modified again (a reschedule, a new acceptance, an edit), and that's
      // exactly the kind of follow-up change this exists to surface.
      lastModifiedDateTime: e.lastModifiedDateTime,
      subject: e.subject,
      start: e.start?.dateTime,
      end: e.end?.dateTime,
      isOrganizer: e.isOrganizer,
      organizer: e.organizer?.emailAddress?.address,
      responseStatus: e.responseStatus?.response,
      isCancelled: e.isCancelled,
    }));
}
