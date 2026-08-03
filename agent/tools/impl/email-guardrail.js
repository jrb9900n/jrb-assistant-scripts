// tools/impl/email-guardrail.js — Outbound email safety checks
//
// RECONSTRUCTED 2026-08-03: this file was never tracked in git (confirmed via
// `git log --all -- '**/email-guardrail.js'` returning nothing on any branch)
// and was found missing from disk, crashing the Teams bot on startup with
// ERR_MODULE_NOT_FOUND from dispatcher.js's import. Its three exports are
// imported by dispatcher.js but — confirmed via a repo-wide grep — never
// actually called anywhere else in the codebase, so there is no real spec to
// match. This restores the behavior CLAUDE.md documents for this file
// ("outbound email safety checks") plus the two related names dispatcher.js
// expects, using the same rule already enforced in core/agent.js's system
// prompt ("Outbound: only send to michael@jrboehlke.com unless explicitly
// told otherwise. Inbound non-promotional: flag for Michael, never
// auto-reply") as the source of truth for intended behavior.

const ALLOWED_DOMAIN = 'jrboehlke.com';
const DEFAULT_RECIPIENT = 'michael@jrboehlke.com';

// Guard an outbound send before it goes out. Returns a verdict rather than
// throwing, so a caller can decide whether to block, redirect, or just log —
// matches the non-throwing style of the rest of this codebase's guard/check
// helpers (e.g. serviceautopilot.js's checkProxyHealth).
export function guardOutbound({ to, explicitOverride = false } = {}) {
  const recipients = Array.isArray(to) ? to : [to].filter(Boolean);
  if (!recipients.length) {
    return { allowed: false, reason: 'No recipient specified' };
  }
  if (explicitOverride) {
    return { allowed: true, reason: 'Explicit override — sending as requested' };
  }
  const disallowed = recipients.filter(addr => {
    const lower = String(addr).toLowerCase();
    return lower !== DEFAULT_RECIPIENT && !lower.endsWith(`@${ALLOWED_DOMAIN}`);
  });
  if (disallowed.length) {
    return {
      allowed: false,
      reason: `Outbound recipient(s) outside the default allowlist (${DEFAULT_RECIPIENT} or @${ALLOWED_DOMAIN}) without an explicit override: ${disallowed.join(', ')}`,
    };
  }
  return { allowed: true, reason: 'Recipient within default allowlist' };
}

// Cheap heuristic classification of an inbound message — enough to decide
// whether it needs a human flag. Not a replacement for the fuller category
// taxonomy in skills/definitions/inbox-management.md; this is just the
// promotional/non-promotional split CLAUDE.md's email rules actually need.
const PROMOTIONAL_PATTERNS = /\bunsubscribe\b|\bnewsletter\b|\bpromo(tion)?\b|\bsale\b|\bmarketing\b|\bdeals?\b|\bwebinar\b/i;

export function classifyInbound({ subject = '', body = '', from = '' } = {}) {
  const text = `${subject} ${body}`;
  if (PROMOTIONAL_PATTERNS.test(text)) {
    return { category: 'promotional', flagForHuman: false };
  }
  return { category: 'non_promotional', flagForHuman: true, from, subject };
}

// Shape a flag entry for "needs human review" — mirrors the plain, minimal
// structure used elsewhere in this codebase for review-queue entries (e.g.
// the Google Ads Agent's flags table: id/timestamp/reason/details).
export function buildFlagEntry({ reason, details = {}, source = 'email' }) {
  return {
    id: `flag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    source,
    reason,
    details,
    created_at: new Date().toISOString(),
    resolved: false,
  };
}
