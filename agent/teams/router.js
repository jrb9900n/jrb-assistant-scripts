// teams/router.js — Shared intent classification for Teams messages and email poller.
// All detection functions live here so bot.js and cron.js stay in sync.

export function isExplicitDevTask(text) {
  const t = text.toLowerCase();
  const intentVerbs = /\b(build|create|write|develop|code|make|set up|implement|automate|generate)\b/;
  const deliverableNouns = /\b(script|program|tool|app|application|function|integration|workflow|automation|dashboard|bot|scheduler|pipeline)\b/;
  const explicitPhrases = /\b(using your coding skills|write (me |us )?code|build (me |us )?a|deploy (this|it|to)|push to (github|vercel|prod)|open a pr|create a branch)\b/;
  return explicitPhrases.test(t) || (intentVerbs.test(t) && deliverableNouns.test(t));
}

export function isAmbiguousDevTask(text) {
  const t = text.toLowerCase();
  const techTerms = /\b(script|code|github|deploy|vercel|supabase|automate|function|api|database|repo|branch|commit)\b/;
  return techTerms.test(t) && !isExplicitDevTask(text);
}

export function isCrmActionRequest(text) {
  const t = text.toLowerCase();
  // Forwarded emails are almost always contact forms / leads (email subject context only)
  if (/^(fw|fwd):/i.test(text.split('\n')[0])) return true;
  return /\b(ticket|estimate|quote|job|waiting list|service autopilot|\bsa\b|client|lead|crm|follow.?up|call them|reach out|contact form|new customer|new lead)\b/.test(t);
}

export function isSchedulingRequest(text) {
  const t = text.toLowerCase();
  return /\b(schedul|crew|route for|next week|week of|dave|noah|eric|don o'?malley|lawn (care|route|service)|fertiliz|fert |mosquito|mowing|dispatch|stop map|stop order|assign (jobs?|stops?|crew))\b/.test(t);
}

export function isReportRequest(text) {
  const t = text.toLowerCase();
  return /\b(how much|how many|revenue|invoices?|ar aging|balance sheet|weekly report|show me|what('s| is) (our|the|my)|list (all|open|pending|today)|total|year.?to.?date|ytd|month(ly)?|outstanding|cash flow|profit|loss)\b/.test(t);
}

/**
 * Classify a message into one of: scheduling | crm | dev | dev_ambiguous | report | general
 * Used by both the Teams bot and the email poller.
 */
export function classifyIntent(text) {
  if (isSchedulingRequest(text)) return 'scheduling';
  if (isCrmActionRequest(text))  return 'crm';
  if (isExplicitDevTask(text))   return 'dev';
  if (isAmbiguousDevTask(text))  return 'dev_ambiguous';
  if (isReportRequest(text))     return 'report';
  return 'general';
}
