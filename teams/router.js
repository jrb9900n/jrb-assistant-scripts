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

export function isSchedulingRequest(text) {
  const t = normalise(text);
  if (t === null) return false;
  return /\b(schedul|crew|route for|next week|week of|dave|noah|eric|don o'?malley|lawn (care|route|service)|fertiliz|fert |mosquito|mowing|dispatch|stop map|stop order|assign (jobs?|stops?|crew))\b/.test(t);
}

export function isReportRequest(text) {
  const t = normalise(text);
  if (t === null) return false;
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

/**
 * Classify a message into one of: ops_alert | scheduling | crm | dev | dev_ambiguous | report | general
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
 *   2. CRM is checked before scheduling because a message can contain both
 *      scheduling vocabulary AND explicit CRM signals (e.g. "schedule a follow-
 *      up call with new lead Dave").  A CRM signal is a stronger, more specific
 *      routing indicator and must not be silently dropped.
 *   3. Scheduling follows CRM — purely scheduling messages have no CRM tokens.
 *   4. Dev intents come next (explicit before ambiguous).
 *   5. Report last before the generic fallback.
 */
export function classifyIntent(text) {
  if (typeof text !== 'string' || !text) return 'general';
  if (isOpsAlertLike(text))      return 'ops_alert';
  if (isCrmActionRequest(text))  return 'crm';
  if (isSchedulingRequest(text)) return 'scheduling';
  if (isExplicitDevTask(text))   return 'dev';
  if (isAmbiguousDevTask(text))  return 'dev_ambiguous';
  if (isReportRequest(text))     return 'report';
  return 'general';
}
