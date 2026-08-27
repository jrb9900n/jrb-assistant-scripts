// tools/impl/marketing-ads-flags.js — write bridge into the Google Ads agent's
// own flags table, for genuinely new Ads-side ideas the marketing-advisor
// persona wants to surface to Michael.
//
// Phase 1 of the marketing agent kept Google Ads integration read-only
// (google-ads.js). This closes that gap, but NOT by giving the
// marketing-advisor any path into the Ads agent's own approve/execute
// pipeline — every row this writes carries source: 'marketing_agent', set
// here server-side and never accepted as a caller-supplied field, since
// that's the one value the whole safety design rests on. The Google Ads
// agent's own inbox_checker.py / webhook_server.py structurally refuse to
// execute APPROVE/COMMENT against any flag whose source isn't native — see
// those files for the actual gate. This module cannot bypass it; it can only
// insert a row that gate will later refuse to act on.
//
// Follows the exact execFile-plus-JSON-stdout contract google-ads.js /
// google_ads_bridge.py already establish for the read side, pointed instead
// at google-ads-agent's own external_flag_bridge.py — that script reuses
// google-ads-agent's Database.save_flag() (its dedup-key upsert logic
// specifically) rather than reimplementing it against the raw schema, the
// same "the owning system's code handles the owning system's data"
// principle the SA/QBO bridges follow.
//
// COLLISION SAFETY: a dedupKey collision between a native flag (source NULL)
// and a marketing_agent flag can never merge across sources — fixed at the
// database layer in google-ads-agent's Database.save_flag(), whose
// dedup-key lookup is scoped by `source IS ?` (SQLite's NULL-safe equality),
// not just `dedup_key`. Verified live: same dedupKey, different sources ->
// two separate rows, no cross-contamination. No JS-side pre-write check is
// needed or attempted here — the guarantee lives where the actual race
// would occur (the SQL upsert itself), not in a separate read-then-write
// step on this side that couldn't be atomic with it anyway.

import { runPythonBridge } from './python-bridge.js';

// Hardcoded absolute path, unlike google-ads.js's fileURLToPath-relative
// BRIDGE_SCRIPT -- this script lives in a different repo (google-ads-agent),
// not co-located with this file, so a relative resolution isn't possible.
// python-bridge.js will throw an actionable error if this path doesn't exist
// at call time rather than producing an opaque spawn error.
const BRIDGE_SCRIPT = 'C:\\Users\\Assistant\\google-ads-agent\\tools\\external_flag_bridge.py';

const VALID_PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);
const REVIEW_ONLY_PREFIX = "For Michael's review only — not automatically executable. ";

async function runBridge(command, args = {}) {
  return runPythonBridge(BRIDGE_SCRIPT, command, args, { errorLabel: 'Ads flag bridge' });
}

export async function createAdsFlag({ priority, subject, details, recommendedAction, dedupKey } = {}) {
  if (!priority || !subject || !details || !recommendedAction) {
    throw new Error('createAdsFlag requires priority, subject, details, and recommendedAction');
  }
  if (!VALID_PRIORITIES.has(priority)) {
    throw new Error(`createAdsFlag: priority must be one of ${[...VALID_PRIORITIES].join('/')}, got '${priority}'`);
  }

  const result = await runBridge('create_flag', {
    priority,
    subject,
    details,
    recommended_action: `${REVIEW_ONLY_PREFIX}${recommendedAction}`,
    dedup_key: dedupKey,
    // Server-side only — never derived from caller input. This is what makes
    // the flag structurally non-executable via the Ads agent's own pipeline.
    source: 'marketing_agent',
  });

  // ── POST-WRITE SOURCE VERIFICATION ───────────────────────────────────────
  // Verify the bridge returned the full flag row with source populated.
  // If result.source is undefined, the bridge's data contract is wrong
  // (it returned only an ID or boolean rather than the full row). This is
  // a different failure mode from a collision and gets a distinct error.
  if (result?.source === undefined || result?.source === null) {
    throw new Error(
      `Ads flag bridge did not return a 'source' field in its response data ` +
      `(flag_id=${result?.flag_id ?? 'unknown'}). The bridge must return the full persisted ` +
      `flag row in its 'data' field so the source guard can verify the write. ` +
      `Check external_flag_bridge.py's create_flag response format.`
    );
  }
  if (result.source !== 'marketing_agent') {
    throw new Error(
      `Ads flag bridge reported success but the persisted row's source is '${result.source}', not 'marketing_agent' ` +
      `(flag_id=${result?.flag_id}) — refusing to report success since the flag may not actually be gated. ` +
      `This should be structurally impossible given the source-scoped dedup fix in database.py — if it happens, ` +
      `treat it as a regression in that fix, not just a dedupKey collision to work around.`
    );
  }
  // ── END POST-WRITE SOURCE VERIFICATION ───────────────────────────────────

  return result;
}
