// teams/identity.js — resolves WHO is messaging the Teams bot.
//
// Built 2026-08-24 as the foundation for the privacy/access-control system
// (see tools/impl/privacy-gate.js): Michael's inbox/personal data must only
// ever be shared with Michael, and the bot needs to actually know who's
// asking before it can enforce that. Confirmed live before this file existed:
// `activity.from` was never read anywhere in this codebase — every Teams
// message was treated identically regardless of sender.

import { createClient } from '@supabase/supabase-js';
import { logger } from '../core/logger.js';
import { graph } from '../tools/impl/m365.js';

function supabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

const MICHAEL_EMAIL = 'michael@jrboehlke.com';

// Emit a loud startup warning the first time resolveSender is called without
// TEAMS_MICHAEL_AAD_ID configured.  A module-level flag ensures we only log
// once per process rather than once per message.
let _warnedMissingAadId = false;

/**
 * Resolves the sender of a Teams activity.
 *
 * @param {object} activity - The raw Teams Bot Framework activity.
 * @returns {Promise<{isMichael: boolean, aadId: string|null, name: string|null, email: string|null, employeeId: string|null}>}
 *
 * Michael is identified by comparing `activity.from.aadObjectId` against the
 * TEAMS_MICHAEL_AAD_ID env var.
 *
 * SECURITY: When TEAMS_MICHAEL_AAD_ID is not set this function FAILS CLOSED —
 * every sender is treated as a non-Michael employee, not as Michael.  The
 * original fail-open behaviour (treating every sender as Michael when the env
 * var was absent) silently eliminated the entire access-control boundary under
 * a common misconfiguration condition.  Set TEAMS_MICHAEL_AAD_ID before
 * deploying; the warning logged below will fire on every incoming message
 * until it is configured.
 */
export async function resolveSender(activity) {
  const aadId = activity.from?.aadObjectId ?? null;
  const name  = activity.from?.name ?? null;
  const michaelAadId = process.env.TEAMS_MICHAEL_AAD_ID;

  if (!michaelAadId) {
    // Fail CLOSED: without a configured Michael AAD ID we cannot verify
    // identity, so we must not grant elevated access to anyone.
    if (!_warnedMissingAadId) {
      _warnedMissingAadId = true;
      logger.error(
        '[SECURITY] TEAMS_MICHAEL_AAD_ID is not set. ' +
        'resolveSender cannot verify Michael\'s identity and will treat ALL ' +
        'senders as non-Michael employees until this env var is configured. ' +
        'Set TEAMS_MICHAEL_AAD_ID to Michael\'s Azure AD object ID and restart ' +
        'the bot before relying on any privacy or access-control features.'
      );
    }
    // Treat as a non-Michael employee — fail closed.
    const employee = await getOrSyncEmployee(aadId, name);
    return { isMichael: false, aadId, name, email: employee?.email ?? null, employeeId: employee?.id ?? null };
  }

  if (aadId && aadId === michaelAadId) {
    return { isMichael: true, aadId, name, email: MICHAEL_EMAIL, employeeId: null };
  }

  const employee = await getOrSyncEmployee(aadId, name);
  return { isMichael: false, aadId, name, email: employee?.email ?? null, employeeId: employee?.id ?? null };
}

/**
 * Looks up (or lazily creates) the `employees` row for a non-Michael sender.
 * Resolves their email via Graph on first sight (reusing this app's existing
 * User.Read.All permission) purely to attach a friendly identity for
 * Michael's approval notifications — never required for the access-control
 * gate itself, which only needs "this isn't Michael."
 */
async function getOrSyncEmployee(aadId, name) {
  if (!aadId) {
    logger.warn('identity: non-Michael sender has no aadObjectId — cannot track as an employee', { name });
    return null;
  }

  const db = supabase();
  const { data: existing, error: selectErr } = await db
    .from('employees')
    .select('id, email, name, active')
    .eq('aad_object_id', aadId)
    .maybeSingle();

  if (selectErr) {
    logger.warn('identity: employees lookup failed', { err: selectErr.message });
    return null;
  }

  if (existing) {
    db.from('employees').update({ last_seen_at: new Date().toISOString() }).eq('aad_object_id', aadId)
      .then(() => {}, err => logger.warn('identity: last_seen_at update failed', { err: err?.message }));
    return existing;
  }

  let email = null;
  try {
    const user = await graph('GET', `/users/${aadId}?$select=mail,userPrincipalName`);
    email = user.mail ?? user.userPrincipalName ?? null;
  } catch (err) {
    logger.warn('identity: could not resolve employee email via Graph', { aadId, err: err.message });
  }

  const { data: inserted, error: insertErr } = await db
    .from('employees')
    .insert({ aad_object_id: aadId, email, name })
    .select('id, email, name, active')
    .single();

  if (insertErr) {
    logger.warn('identity: employees insert failed', { err: insertErr.message });
    return null;
  }
  logger.info('identity: new employee seen', { aadId, name, email });
  return inserted;
}
