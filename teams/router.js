// teams/router.js — Shared intent classification for Teams messages and email poller.
// All detection functions live here so bot.js and cron.js stay in sync.

/**
 * Normalise input to a lowercase string, or return null if the value is not a
 * non-empty string.  Used by every exported function as a null-guard.
 */
function normalise(text) {
  if (typeof text !== 'string' || !text) return null;
  return text.toLowerCase();
}

export function isExplicitDevTask(text) {
  const t = normalise(text);
  if (t === null) return false;
  const intentVerbs = /\b(build|create|write|develop|code|make|set up|implement|automate|generate)\b/;
  const deliverableNouns = /\b(script|program|tool|app|application|function|integration|workflow|automation|dashboard|bot|scheduler|pipeline)\b/;
  const explicitPhrases = /\b(using your coding skills|write (me |us )?code|build (me |us )?a|deploy (this|it|to)|push to (github|vercel|prod)|open a pr|create a branch)\b/;
  return explicitPhrases.test(t) || (intentVerbs.test(t) && deliverableNouns.test(t));
}

export function isAmbiguousDevTask(text) {
  const t = normalise(text);
  if (t === null) return false;
  const techTerms = /\b(script|code|github|deploy|vercel|supabase|automate|function|api|database|repo|branch|commit)\b/;
  return techTerms.test(t) && !isExplicitDevTask(text);
}

export function isCrmActionRequest(text) {
  const t = normalise(text);
  if (t === null) return false;
  // Forwarded emails are almost always contact forms / leads (check first line,
  // using the lowercased copy so the comparison is consistent with the rest of
  // the function — no separate `i` flag needed after toLowerCase()).
  if (/^(fw|fwd):/.test(t.split('\n')[0])) return true;
  // "service autopilot" is matched as a phrase for the full product name, and
  // \bsa\b is matched alongside it for the bare abbreviation.
  //
  // NOT A BUG - DO NOT REMOVE \bsa\b AGAIN. This exact token has been added,
  // removed, and re-added multiple times (see #240, #261) because it looks
  // like a false-positive risk in isolation ("SA" could theoretically mean
  // many things). It has been explicitly confirmed as correct by Michael
  // Reardon (the business owner) on 2026-08-17: "Anytime 'SA' is mentioned
  // you may assume it is serviceautopilot." In this codebase's actual usage,
  // there is no other meaning of "SA" that matters, and internal workflows
  // commonly use the bare abbreviation (e.g. "add to SA", "SA client").
  // Removing this token causes valid CRM messages to silently fall through
  // to a non-CRM handler. If reconsidering this, ask Michael first - do not
  // infer a "safer" regex from first principles.
  return /\b(ticket|estimate|quote|job|waiting list|service autopilot|\bsa\b|client|lead|crm|follow.?up|call them|reach out|contact form|new customer|new lead|carddav|provision carddav|revoke carddav|card.?dav)\b/.test(t);
}

// Confirmed live 2026-08-24: "we need to work on the calendar re-scheduling
// feature... prioritize [my BTA meeting] over the client meeting block"
// tripped isCrmActionRequest's bare \bclient\b token and routed to 'crm',
// whose tool set has zero calendar read/write (only BOOKING_TOOLS's
// availability-check/book-new-time) -- the bot correctly (but unhelpfully)
// said it could only check availability. "Client Meeting Block" and "Direct
// Report / Approval Window" are literal named blocks in Michael's own
// President Weekly Block Schedule (see CLAUDE.md's Autonomous Schedule
// Manager section), so any request to move/reprioritize them will keep
// hitting this collision unless caught first. Checked ahead of
// isCrmActionRequest in classifyIntent below for that reason -- same
// "narrower, more specific signal wins" precedent as isReportRequest's
// email/inbox carve-out.
export function isCalendarRescheduleRequest(text) {
  const t = normalise(text);
  if (t === null) return false;
  const rescheduleVerbs = /\b(reschedul\w*|move|prioriti[sz]e|bump|shift|displace|free up|clear (my|the)|swap|conflict)\b/;
  const calendarNouns = /\b(calendar|meeting|block|slot|invite|appointment)\b/;
  return rescheduleVerbs.test(t) && calendarNouns.test(t);
}

export function isSchedulingRequest(text) {
  const t = normalise(text);
  if (t === null) return false;
  return /\b(schedul|crew|route for|next week|week of|dave|noah|eric|don o'?malley|lawn (care|route|service)|fertiliz|fert |mosquito|mowing|dispatch|stop map|stop order|assign (jobs?|stops?|crew))\b/.test(t);
}

export function isReportRequest(text) {
  const t = normalise(text);
  if (t === null) return false;
  // Email/inbox questions ("how many emails did I get today") collide with the
  // generic "how many"/"show me" phrasing below but belong in 'general' (which
  // has EMAIL_TOOLS) -- 'report''s toolset (QB/files/FleetSharp) has no email
  // tool at all. Confirmed live 2026-08-24: this exact collision routed
  // "summarize how many emails I received today" to 'report', and the model
  // correctly (if unhelpfully) said it had no inbox tool available.
  if (/\b(emails?|inbox)\b/.test(t)) return false;
  return /\b(how much|how many|revenue|invoices?|ar aging|balance sheet|weekly report|show me|what('s| is) (our|the|my)|list (all|open|pending|today)|total|year.?to.?date|ytd|month(ly)?|outstanding|cash flow|profit|loss)\b/.test(t);
}

// Detects a system/watchdog alert being posted or pasted into live chat (e.g.
// Michael forwarding a health-check failure). Deliberately narrower than
// notify.js's ERROR_SIGNAL_RE, which also matches bare FAILED/WARNING, or a
// bare phrase like "health check failed" — those are safe to gate an
// outbound-message queue on (the source is this codebase's own alert text),
// but would false-positive on Michael's own free-text chat ("yeah the health
// check failed on the ads box again, don't worry about it") if used to gate
// an autonomous investigate-and-fix path with file-edit/branch/PR access.
// The ⚠️ sigil is this system's actual, consistently-used alert convention —
// every sendProactiveMessage-based watchdog/health-check alert uses it, and
// it's not something Michael would casually type in ordinary chat — so it's
// a much stronger signal that this text IS a pasted/forwarded alert rather
// than merely mentioning one.
export function isOpsAlertLike(text) {
  return typeof text === 'string' && /⚠️/.test(text);
}

// Loosely matches a yes/no/"remember this" decision — deliberately only meant
// to be invoked once the caller already knows there's exactly one pending
// employee_requests row (see tools/impl/privacy-gate.js's
// resolvePendingApprovalReply), so it doesn't need to be bulletproof against
// Michael's ordinary messages coincidentally containing "yes"/"no" — those
// never reach this function unless a request is genuinely pending.
export function isApprovalReply(text) {
  const t = normalise(text);
  if (t === null) return { decision: null };
  if (/^(yes|yep|yeah|approve|approved|ok|okay|sure)\b.*\b(remember|standing|going forward|from now on|every time)\b/.test(t)) {
    return { decision: 'approved_standing' };
  }
  if (/^(yes|yep|yeah|approve|approved|ok|okay|sure|go ahead|that'?s fine|fine)\b/.test(t)) {
    return { decision: 'approved_once' };
  }
  if (/^(no|nope|deny|denied|don'?t|do not|decline|declined)\b/.test(t)) {
    return { decision: 'denied' };
  }
  return { decision: null };
}

/**
 * Classify a message into one of: ops_alert | calendar | scheduling | crm | dev | dev_ambiguous | report | general
 * Used by both the Teams bot and the email poller.
 *
 * Priority order rationale:
 *   1. Ops-alert is checked FIRST, ahead of every other classifier. This
 *      system's real alerts (see the sendProactiveMessage call sites in
 *      scheduler/cron.js) very often name the exact subsystem that broke —
 *      "SA connectivity lost — ticket creation offline", a deploy/branch
 *      drift alert, etc. — so they'd otherwise match isCrmActionRequest's
 *      \bsa\b/ticket tokens or isAmbiguousDevTask's branch/deploy tokens and
 *      get misrouted into a generic CRM/dev reply, never reaching the
 *      investigate-and-fix workflow this check exists for — silently
 *      defeating the feature for most real alerts. The accepted tradeoff:
 *      Michael typing "⚠️" for emphasis on an ordinary request would also
 *      route here instead of CRM/scheduling. That's judged the safer
 *      direction — auto_fix has no SA/CRM/Teams tools and can only
 *      investigate/branch/open a PR (never merge), so a rare misfire costs
 *      an off-topic reply Michael can just repeat, whereas silently missing
 *      real alerts (the common case, per above) would make this feature
 *      not actually work. Revisit with Michael before changing this
 *      ordering again — see [[feedback-sa-terminology]]'s "ask before
 *      narrowing a heuristic" precedent for the same class of judgment call.
 *   2. Calendar-reschedule is checked next, ahead of CRM -- a request to
 *      move/reprioritize a named block ("client meeting block", "direct
 *      report window") would otherwise trip isCrmActionRequest's bare
 *      \bclient\b token and land in 'crm', whose tool set has no calendar
 *      read/write at all. Confirmed live 2026-08-24: exactly this collision
 *      routed "prioritize my BTA meeting over the client meeting block" to
 *      'crm', and the bot correctly (but unhelpfully) said it could only
 *      check availability. See isCalendarRescheduleRequest's own comment.
 *   3. CRM is checked before scheduling because a message can contain both
 *      scheduling vocabulary AND explicit CRM signals (e.g. "schedule a follow-
 *      up call with new lead Dave").  A CRM signal is a stronger, more specific
 *      routing indicator and must not be silently dropped.
 *   4. Scheduling follows CRM — purely scheduling messages have no CRM tokens.
 *   5. Dev intents come next (explicit before ambiguous).
 *   6. Report last before the generic fallback.
 */
export function classifyIntent(text) {
  if (typeof text !== 'string' || !text) return 'general';
  if (isOpsAlertLike(text))              return 'ops_alert';
  if (isCalendarRescheduleRequest(text)) return 'calendar';
  if (isCrmActionRequest(text))          return 'crm';
  if (isSchedulingRequest(text))         return 'scheduling';
  if (isExplicitDevTask(text))           return 'dev';
  if (isAmbiguousDevTask(text))          return 'dev_ambiguous';
  if (isReportRequest(text))             return 'report';
  return 'general';
}
