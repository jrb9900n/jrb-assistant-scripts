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
  // "service autopilot" is matched as a phrase for the full name.  \bsa\b is
  // retained alongside it because internal workflows commonly use the bare
  // abbreviation (e.g. "add to SA", "SA client") and silently dropping those
  // signals would cause valid CRM messages to fall through to a non-CRM handler.
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

/**
 * Classify a message into one of: scheduling | crm | dev | dev_ambiguous | report | general
 * Used by both the Teams bot and the email poller.
 *
 * Priority order rationale:
 *   1. CRM is checked before scheduling because a message can contain both
 *      scheduling vocabulary AND explicit CRM signals (e.g. "schedule a follow-
 *      up call with new lead Dave").  A CRM signal is a stronger, more specific
 *      routing indicator and must not be silently dropped.
 *   2. Scheduling follows CRM — purely scheduling messages have no CRM tokens.
 *   3. Dev intents come next (explicit before ambiguous).
 *   4. Report last before the generic fallback.
 */
export function classifyIntent(text) {
  if (typeof text !== 'string' || !text) return 'general';
  if (isCrmActionRequest(text))  return 'crm';
  if (isSchedulingRequest(text)) return 'scheduling';
  if (isExplicitDevTask(text))   return 'dev';
  if (isAmbiguousDevTask(text))  return 'dev_ambiguous';
  if (isReportRequest(text))     return 'report';
  return 'general';
}
