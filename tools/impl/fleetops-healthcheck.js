// tools/impl/fleetops-healthcheck.js — Fleetops Supabase self-healing checks
// Runs hourly via cron. Detects and repairs known auth schema drift issues.

import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';
import { sendProactiveMessage } from '../../teams/notify.js';

const fleetops = createClient(
  process.env.FLEETOPS_SUPABASE_URL,
  process.env.FLEETOPS_SUPABASE_SERVICE_KEY
);

// Checks whether auth.refresh_tokens_id_seq is behind MAX(id) and fixes it.
// Root cause: rows inserted with explicit IDs (e.g. data migrations) advance
// the table's max ID without advancing the sequence, causing duplicate key
// violations on the next login ("database error granting user").
export async function checkAuthRefreshTokenSequence() {
  const { data, error } = await fleetops.rpc('check_and_fix_auth_refresh_token_sequence');
  if (error) throw new Error(`sequence check RPC failed: ${error.message}`);

  if (data.fixed) {
    const msg = `⚠️ Auto-fixed: fleetops auth.refresh_tokens sequence was behind (was ${data.was}, max ID was ${data.now}). Logins would have failed. Sequence reset to ${data.now}.`;
    logger.warn('fleetops_healthcheck: sequence fixed', data);
    try { await sendProactiveMessage(msg); } catch (e) {
      logger.warn('fleetops_healthcheck: Teams notify failed', { err: e.message });
    }
  } else {
    logger.info('fleetops_healthcheck: sequence ok', data);
  }

  return data;
}

export async function runFleetopsHealthcheck() {
  const results = {};
  results.authSequence = await checkAuthRefreshTokenSequence();
  return results;
}
