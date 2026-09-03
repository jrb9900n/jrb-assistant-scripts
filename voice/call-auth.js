// voice/call-auth.js — caller authorization for the live voice bridge.
//
// Two independent layers, deliberately not conflated:
//   1. Caller-ID allowlist (checkCallerAllowlist) — advisory only. Caller ID
//      is trivially spoofable over the PSTN; this exists purely to cut off
//      obvious misdials/robocall traffic before it ever reaches the PIN
//      challenge, not as a real security boundary.
//   2. Spoken PIN (matchSpokenPin) — the real gate. Tool access is not
//      attached to the OpenAI Realtime session at all until this matches
//      (see openai-realtime-client.js) — the model has no vocabulary for
//      calendar/email actions pre-verification, not just an instruction not
//      to use them.
//
// isTrustedNoPinCallerId() (added 2026-09-03, Michael's explicit request) is
// a THIRD, separate thing: a specific caller ID that skips the PIN challenge
// entirely. This deliberately weakens the real security boundary above --
// caller ID is spoofable, and for this one number, spoofing it is now
// equivalent to knowing the PIN. Accepted knowingly, Michael's own call, for
// his own known number. Do not extend this list casually; every entry here
// is a caller who never has to prove anything beyond what the phone network
// (unverified) claims their number is.

function checkCallerAllowlist(fromE164) {
  const raw = process.env.VOICE_ALLOWED_CALLER_IDS || '';
  const allowed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  // An empty allowlist is treated as "not configured" -> deny, not allow.
  // Silently accepting every caller because a secret was never set is the
  // wrong failure mode for a channel that can read Michael's calendar/email.
  if (allowed.length === 0) return false;
  return allowed.includes(fromE164);
}

// Confirmed by Michael 2026-09-03: calls from this number skip the spoken-PIN
// challenge outright. Not sourced from Credential Manager like
// VOICE_ALLOWED_CALLER_IDS/VOICE_CALL_PIN -- it's not a secret, it's a phone
// number, and hardcoding it here (rather than another env var) makes the
// bypass grep-able and obvious to the next person reading this file, instead
// of one more opaque entry in an env-var list that reads like the merely-
// advisory allowlist above.
const TRUSTED_NO_PIN_CALLER_ID = '+14146593840';

function isTrustedNoPinCallerId(fromE164) {
  return fromE164 === TRUSTED_NO_PIN_CALLER_ID;
}

const DIGIT_WORDS = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};

function normalizeSpokenDigits(transcript) {
  return (transcript || '')
    .toLowerCase()
    .split(/[\s,.-]+/)
    .map((w) => DIGIT_WORDS[w] ?? w)
    .join('')
    .replace(/\D/g, '');
}

function matchSpokenPin(transcript, storedPin) {
  if (!storedPin) return false;
  const spokenDigits = normalizeSpokenDigits(transcript);
  const rawDigits = (transcript || '').replace(/\D/g, '');
  return spokenDigits === storedPin || rawDigits === storedPin;
}

export { checkCallerAllowlist, normalizeSpokenDigits, matchSpokenPin, isTrustedNoPinCallerId };
