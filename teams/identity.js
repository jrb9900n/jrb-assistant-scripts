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

/**
 * Resolves the sender of a Teams activity.
 *
 * @param {object} activity - The raw Teams Bot Framework activity.
 * @returns {Promise<{isMichael: boolean, aadId: string|null, name: string|null, email: string|null, employeeId: string|null}>}
 *
 * Michael is identified by comparing `activity.from.aadObjectId` against the
 * TEAMS_MICHAEL_AAD_ID env var. **Deliberately fails open (treats the sender
 * as Michael) whenever that env var isn't set** — this is what lets the
 * whole privacy system ship with zero behavior change today (only Michael
 * uses the bot) and get activated later by simply setting one credential,
 * rather than needing a second deploy. Once set, this is the hard identity
 * boundary the rest of the system (teams/bot.js's employee-vs-Michael
 * branch, tools/dispatcher.js's trusted context) relies on — get this env
 * var right before relying on any of the rest.
 */
export async function resolveSender(activity) {
  const aadId = activity.from?.aadObjectId ?? null;
  const name  = activity.from?.name ?? null;
  const michaelAadId = process.env.TEAMS_MICHAEL_AAD_ID;

  if (!michaelAadId) {
    // Not yet configured — ship safe by treating every sender as Michael,
    // exactly like the pre-existing behavior before this file existed.
    return { isMichael: true, aadId, name, email: MICHAEL_EMAIL, employeeId: null };
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
