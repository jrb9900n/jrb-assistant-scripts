// tools/impl/qbo-sync-watchdog.js — SA <-> QBO sync error watchdog.
//
// Reads SA's own "QuickBooks Online Sync Errors" report (Settings gear -> Accounting
// -> Integrations -> QuickBooks, or directly at SA's QBOSyncErrors.aspx) each run and:
//   1. Blanket Unauthorized-401 cluster (SA's own QBO OAuth connection has lapsed) —
//      attempts SA's real "Actions -> Re-Send" action once per distinct signature, then
//      alerts Michael once per open incident if it's still broken after SA's own batch
//      cycle has had a chance to run.
//   2. Two confirmed-safe auto-fixable categories (malformed semicolon-joined email,
//      oversized ClientTitle) — fixed via saveClientFields (metadata-only, never
//      touches billing).
//   3. Everything else — a one-time diagnosed Teams alert per new signature, no
//      auto-write, because the SA-QBO sync playbook marks those fixes as unconfirmed
//      or higher-risk (deleted QBO customer reference, parent-not-found, payment
//      required-param-missing, etc.).
//
// State (dedup across runs) is a local JSON file — this only needs to persist a
// handful of signatures with timestamps between scheduler ticks on this one machine,
// so a Supabase round-trip (audit_runs/audit_issues pattern) would be overkill here.
//
// Guardrails (see project-sa-qbo-sync-playbook memory):
//   - Never calls triggerQboInitialSync automatically (has caused real QBO customers
//     to silently vanish in past investigations).
//   - Never auto-creates QBO customers or auto-edits a client's QboID.
//   - Never touches invoice line items, amounts, rates, quantities, tax, or totals —
//     saveClientFields itself refuses billing-sensitive fields as defense in depth.

import { fileURLToPath } from 'url';
import fs from 'fs';
import { logger } from '../../core/logger.js';
import { getQboSyncErrors, resendQboSyncErrors, saveClientFields, getClientEmail } from './serviceautopilot.js';
import { sendProactiveMessage, writeFileAtomic } from '../../teams/notify.js';

const STATE_PATH = fileURLToPath(new URL('../../qbo-sync-watchdog-state.json', import.meta.url));

// SA's own batch cycle runs on a ~30 min cadence (confirmed in prior investigations) —
// don't judge a resend/fix as "didn't take" until at least this long has passed.
const BATCH_CYCLE_MS = 35 * 60 * 1000;
// Don't re-alert about the same still-open 401 cluster more often than this.
const CLUSTER_ALERT_COOLDOWN_MS = 20 * 60 * 60 * 1000;
// Re-attempt an auto-fix if the same signature is still sitting in the error list this
// long after we last "fixed" it (covers the case where the fix silently didn't take).
const FIX_RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const CLUSTER_KEY = 'oauth_401_cluster';

function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return { entries: {}, cluster: {} };
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8').replace(/^﻿/, ''));
    return { entries: raw.entries || {}, cluster: raw.cluster || {} };
  } catch (e) {
    logger.warn('qbo-sync-watchdog: state file unreadable — starting fresh', { error: e.message });
    return { entries: {}, cluster: {} };
  }
}

function saveState(state) {
  try {
    writeFileAtomic(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    logger.warn('qbo-sync-watchdog: could not persist state', { error: e.message });
  }
}

/** Stable dedup key — signatures recur daily under new timestamps, so DateCreated is deliberately excluded. */
function signatureFor(row) {
  return `${row.entityType ?? 'x'}|${row.entityId || row.name}|${row.message}`;
}

const RE_UNAUTHORIZED       = /unauthorized|\b401\b/i;
const RE_MALFORMED_EMAIL    = /email address is not valid/i;
const RE_OVERSIZED_TITLE    = /string length is either shorter or longer than supported by specification/i;
const RE_DELETED_CUSTOMER   = /customer you have specified has been deleted/i;
const RE_PARENT_NOT_FOUND   = /parent not found|parent cannot be child/i;
const RE_REQUIRED_PARAM     = /required param|missing.*required value/i;

const CLIENT_ENTITY_TYPE = 1; // per QBoSyncErrors.js's ShowOverlay switch: case 1 = client

function classify(row) {
  if (RE_UNAUTHORIZED.test(row.message) && row.direction === 'Sent to QuickBooks Online') {
    return 'oauth_401_cluster';
  }
  if (row.entityType === CLIENT_ENTITY_TYPE && RE_MALFORMED_EMAIL.test(row.message)) {
    return 'malformed_email';
  }
  if (row.entityType === CLIENT_ENTITY_TYPE && RE_OVERSIZED_TITLE.test(row.message)) {
    return 'oversized_client_title';
  }
  return 'diagnosed_unfixable';
}

/** Reuses the SA-QBO sync playbook's root-cause catalog language for the alert body. */
function diagnosisFor(row) {
  if (RE_DELETED_CUSTOMER.test(row.message)) {
    return 'Stale/deleted QBO customer reference on this client/invoice — the linked QBO ' +
      'customer no longer exists. No confirmed automated fix (writes to QboID do not ' +
      'persist via the API). Options: reactivate the QBO customer directly in QBO\'s UI ' +
      'if it still has transaction history, or create a replacement and nudge SA to ' +
      're-match it — see the SA-QBO sync playbook.';
  }
  if (RE_PARENT_NOT_FOUND.test(row.message)) {
    return 'Sub-customer (Job) synced before its parent had a QBO link. Usually needs the ' +
      'parent client linked first, then a retry on the child — not guaranteed to resolve ' +
      'automatically.';
  }
  if (RE_REQUIRED_PARAM.test(row.message)) {
    return 'Likely a payment-to-invoice application failure (client/invoice sync fine, ' +
      'payment not linking) — root cause of the missing field is not confirmed in past ' +
      'investigations. Needs manual review.';
  }
  return 'Does not match a known root-cause pattern from the SA-QBO sync playbook. Needs manual investigation.';
}

function pruneCleared(entries, currentSignatures) {
  for (const sig of Object.keys(entries)) {
    if (!currentSignatures.has(sig)) delete entries[sig];
  }
}

/**
 * Single watchdog run. Safe to call repeatedly (idempotent per signature) and safe if
 * SA currently has zero errors (no-op). Never throws for a "no errors" or "nothing to
 * do" outcome — only throws if the SA fetch itself fails (caller's try/catch handles
 * that the same way other cron jobs do).
 */
export async function runQboSyncWatchdog() {
  const { rows } = await getQboSyncErrors({ max: 500 });
  const now = Date.now();
  const state = loadState();
  const summary = { total: rows.length, autoFixed: [], resendAttempted: [], alertsSent: [], stillOpen401: 0 };

  const currentSignatures = new Set(rows.map(signatureFor));
  const cluster401Rows = rows.filter(r => classify(r) === 'oauth_401_cluster');

  // ── 1. Blanket 401 cluster ────────────────────────────────────────────────
  if (cluster401Rows.length === 0) {
    // Fully cleared — reset so a future recurrence starts a fresh cooldown.
    if (state.cluster[CLUSTER_KEY]) delete state.cluster[CLUSTER_KEY];
  } else {
    const clusterState = state.cluster[CLUSTER_KEY] || { firstSeen: null, lastAlertAt: null };
    if (!clusterState.firstSeen) clusterState.firstSeen = new Date(now).toISOString();

    const stillOpenSignatures = [];
    for (const row of cluster401Rows) {
      const sig = signatureFor(row);
      const entry = state.entries[sig];
      if (!entry) {
        // First time we've seen this specific client+message — attempt the real resend once.
        try {
          await resendQboSyncErrors({ ids: [row.id] });
          state.entries[sig] = { category: 'oauth_401_cluster', resendAttemptedAt: new Date(now).toISOString(), name: row.name };
          summary.resendAttempted.push(row.name);
        } catch (e) {
          logger.warn('qbo-sync-watchdog: resend failed for 401 row', { name: row.name, error: e.message });
          state.entries[sig] = { category: 'oauth_401_cluster', resendAttemptedAt: new Date(now).toISOString(), resendFailed: true, name: row.name };
        }
      } else {
        const attemptedAt = entry.resendAttemptedAt ? new Date(entry.resendAttemptedAt).getTime() : 0;
        if (now - attemptedAt >= BATCH_CYCLE_MS) {
          // Same signature, still present well after both a resend attempt and a full
          // SA batch cycle — genuinely stuck, not just mid-cycle.
          stillOpenSignatures.push(sig);
        }
      }
    }

    summary.stillOpen401 = stillOpenSignatures.length;

    const cooledDown = !clusterState.lastAlertAt || (now - new Date(clusterState.lastAlertAt).getTime()) >= CLUSTER_ALERT_COOLDOWN_MS;
    if (stillOpenSignatures.length > 0 && cooledDown) {
      const sampleNames = cluster401Rows.slice(0, 5).map(r => r.name).join(', ');
      const msg = `⚠️ SA's QuickBooks Online integration looks disconnected. ${cluster401Rows.length} ` +
        `client record(s) are failing to sync to QBO with Unauthorized-401 errors (e.g. ${sampleNames}` +
        `${cluster401Rows.length > 5 ? ', ...' : ''}) and re-sending them did not clear the error after ` +
        `SA's own sync cycle. This means SA's own QuickBooks Online connection (Settings -> Accounting -> ` +
        `Integrations -> QuickBooks Online inside SA, not this agent's separate QBO connection) needs to be ` +
        `manually reconnected by signing in again — there is no API/agent fix for this. I'll keep retrying ` +
        `automatically and will only remind you again if it's still unresolved after ${Math.round(CLUSTER_ALERT_COOLDOWN_MS / 3_600_000)}h.`;
      try {
        await sendProactiveMessage(msg, { suppressSelfHeal: true });
        clusterState.lastAlertAt = new Date(now).toISOString();
        summary.alertsSent.push('oauth_401_cluster');
      } catch (e) {
        logger.warn('qbo-sync-watchdog: failed to send 401 cluster alert', { error: e.message });
      }
    }
    state.cluster[CLUSTER_KEY] = clusterState;
  }

  // ── 2 & 3. Per-row classification for everything else ────────────────────
  for (const row of rows) {
    const category = classify(row);
    if (category === 'oauth_401_cluster') continue; // handled above
    const sig = signatureFor(row);
    const entry = state.entries[sig];

    if (category === 'malformed_email' || category === 'oversized_client_title') {
      // Gate every attempt (success OR failure) behind the same cooldown — a fix that
      // already succeeded needs time for SA's own batch to clear the error row, and a
      // fix that failed (e.g. a real SA-side validation error unrelated to our change)
      // shouldn't be retried every single tick with no backoff.
      const lastAttemptAt = entry?.lastAttemptAt ? new Date(entry.lastAttemptAt).getTime() : 0;
      if (entry?.lastAttemptAt && (now - lastAttemptAt) < FIX_RETRY_COOLDOWN_MS) continue;

      try {
        if (category === 'malformed_email') {
          // Confirmed root cause: multiple addresses joined by ";" — keep just the first valid one.
          const { email: rawEmail } = await getClientEmail({ clientId: row.entityId });
          const cleaned = rawEmail.split(';')[0].trim();
          const EMAIL_RE = /^[^\s@;]+@[^\s@;]+\.[^\s@;]+$/;
          if (cleaned === rawEmail || !EMAIL_RE.test(cleaned)) {
            // Either there was no ";" to split on, or the extracted first segment isn't
            // itself a plausible address — this isn't the confirmed semicolon-join case,
            // so don't guess. Fall through to the diagnosed-alert path instead.
            throw new Error(`could not derive a single valid address from "${rawEmail}"`);
          }
          await saveClientFields({ clientId: row.entityId, overrides: { Email: cleaned }, expect: { Email: cleaned } });
          logger.info('qbo-sync-watchdog: auto-fixed malformed email', { clientId: row.entityId, name: row.name, from: rawEmail, to: cleaned });
        } else {
          // Confirmed root cause: ClientTitle exceeds QBO's ~16-char Title field limit — clear it.
          await saveClientFields({ clientId: row.entityId, overrides: { ClientTitle: '' }, expect: { ClientTitle: '' } });
          logger.info('qbo-sync-watchdog: auto-fixed oversized ClientTitle', { clientId: row.entityId, name: row.name });
        }
        state.entries[sig] = { category, lastAttemptAt: new Date(now).toISOString(), fixedAt: new Date(now).toISOString(), name: row.name };
        summary.autoFixed.push({ category, name: row.name });
      } catch (e) {
        logger.warn('qbo-sync-watchdog: auto-fix failed', { category, clientId: row.entityId, name: row.name, error: e.message });
        if (!entry?.fixFailedAlerted) {
          try {
            await sendProactiveMessage(
              `⚠️ SA-QBO sync watchdog: auto-fix failed for ${row.name} (${category === 'malformed_email' ? 'malformed email' : 'oversized ClientTitle'}). ` +
              `SA error: "${row.message}". Attempted fix error: ${e.message}. Needs manual review.`,
              { suppressSelfHeal: true }
            );
            summary.alertsSent.push(sig);
          } catch (alertErr) {
            logger.warn('qbo-sync-watchdog: failed to send auto-fix-failure alert', { error: alertErr.message });
          }
        }
        state.entries[sig] = { ...(entry || {}), category, lastAttemptAt: new Date(now).toISOString(), fixFailedAlerted: true, name: row.name };
      }
      continue;
    }

    // diagnosed_unfixable — alert once per new signature, never auto-write.
    if (!entry) {
      const msg = `⚠️ SA-QBO sync error needs attention: ${row.name} (${row.type || 'entity'}), ` +
        `direction: ${row.direction}. SA error: "${row.message}". ${diagnosisFor(row)}`;
      try {
        await sendProactiveMessage(msg, { suppressSelfHeal: true });
        summary.alertsSent.push(sig);
      } catch (e) {
        logger.warn('qbo-sync-watchdog: failed to send diagnosed alert', { error: e.message });
      }
      state.entries[sig] = { category: 'diagnosed_unfixable', alertedAt: new Date(now).toISOString(), name: row.name };
    }
  }

  // Signatures no longer present in the current fetch have cleared — forget them so a
  // future recurrence is treated fresh (matches "don't re-alert an already-alerted
  // still-open issue" while still catching genuinely new occurrences later).
  pruneCleared(state.entries, currentSignatures);

  saveState(state);
  logger.info('qbo-sync-watchdog: run complete', summary);
  return summary;
}
