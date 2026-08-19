// tools/impl/fleetops-odometer-sync.js — daily FleetSharp -> FleetOps odometer sync
// Runs once daily via cron. Matches FleetSharp trackers named "Truck N" to FleetOps
// assets by ID convention (FLV + zero-padded truck number, e.g. "Truck 18" -> FLV018),
// confirmed against the live assets table 2026-08-19. Trackers that aren't numbered
// trucks (2 CAT skid steers, 3 person-named trackers) are intentionally skipped for
// now, pending a manual mapping from Michael.
//
// Supersedes the old Vercel-cron-based sync (api/sync-odometer.js in the FleetOps
// repo), which called a FleetSharp REST API/token auth model that never existed and
// silently synced 0 readings for 5 months. This job uses the real browser-session
// FleetSharp client in fleetsharp.js instead.

import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';
import { getVehicleList } from './fleetsharp.js';

// Lazy singleton — defer client construction until first use so that env vars
// injected by the credential manager at startup are guaranteed to be present.
// Constructing at module load time (before injection completes) would silently
// pass `undefined` to createClient and cause all subsequent calls to fail with
// confusing errors rather than a clear missing-credential message.
let _fleetops = null;
function getFleetOpsClient() {
  if (!_fleetops) {
    const url = process.env.FLEETOPS_SUPABASE_URL;
    const key = process.env.FLEETOPS_SUPABASE_SERVICE_KEY;
    if (!url || !key) {
      throw new Error(
        'FLEETOPS_SUPABASE_URL and FLEETOPS_SUPABASE_SERVICE_KEY must be set before running the odometer sync'
      );
    }
    _fleetops = createClient(url, key);
  }
  return _fleetops;
}

const TRUCK_NAME_RE = /^Truck\s+(\d+)$/i;

function truckNameToAssetId(vehicleName) {
  const m = TRUCK_NAME_RE.exec((vehicleName || '').trim());
  if (!m) return null;
  return 'FLV' + m[1].padStart(3, '0');
}

export async function syncOdometerToFleetOps() {
  const fleetops = getFleetOpsClient();
  const result = { assetsSynced: 0, assetsSkipped: 0, readingsWritten: 0 };

  const vehicles = await getVehicleList();

  const { data: assets, error: assetsErr } = await fleetops
    .from('assets')
    .select('id, odometer')
    .like('id', 'FLV%');
  if (assetsErr) throw new Error(`FleetOps assets fetch failed: ${assetsErr.message}`);
  // Guard against Supabase returning null data alongside a null error on edge conditions
  const assetById = new Map((assets || []).map(a => [a.id, a]));

  const today = new Date().toISOString().split('T')[0];
  const readingsToInsert = [];

  for (const v of vehicles) {
    const assetId = truckNameToAssetId(v.vehicleName);
    if (!assetId || !assetById.has(assetId)) {
      result.assetsSkipped++;
      continue;
    }
    // Treat null, undefined, and zero/negative values as invalid — a zero odometer
    // is almost certainly a FleetSharp glitch (no real truck has 0 miles) and would
    // overwrite valid historical data if allowed through.
    if (v.odometer === null || v.odometer === undefined || v.odometer <= 0) {
      logger.info('fleetops_odometer_sync: no odometer reading from FleetSharp', { assetId, vehicleName: v.vehicleName });
      result.assetsSkipped++;
      continue;
    }

    const asset = assetById.get(assetId);
    const existingOdo = parseFloat((asset.odometer || '').toString().replace(/,/g, ''));
    if (!isNaN(existingOdo) && v.odometer < existingOdo) {
      // A lower reading than what's on file is more likely a FleetSharp glitch than
      // a real decrease — skip the snapshot overwrite but still log the raw reading.
      logger.warn('fleetops_odometer_sync: new odometer is lower than existing, skipping snapshot update', {
        assetId, existing: existingOdo, incoming: v.odometer,
      });
    } else {
      const { error: updateErr } = await fleetops
        .from('assets')
        .update({ odometer: String(v.odometer), odometer_date: today })
        .eq('id', assetId);
      if (updateErr) {
        logger.error('fleetops_odometer_sync: asset update failed', { assetId, err: updateErr.message });
        result.assetsSkipped++;
        continue;
      }
    }

    readingsToInsert.push({
      asset_id: assetId,
      reading_miles: v.odometer,
      recorded_at: v.lastUpdate || new Date().toISOString(),
      source: 'fleetsharp',
      fleetsharp_device_id: String(v.deviceId ?? ''),
    });
    result.assetsSynced++;
  }

  if (readingsToInsert.length > 0) {
    const { error: insertErr } = await fleetops.from('odometer_readings').insert(readingsToInsert);
    if (insertErr) throw new Error(`odometer_readings insert failed: ${insertErr.message}`);
    result.readingsWritten = readingsToInsert.length;
  }

  return result;
}

export async function runOdometerSync() {
  const fleetops = getFleetOpsClient();
  try {
    const result = await syncOdometerToFleetOps();
    await fleetops.from('odometer_sync_log').insert({
      assets_synced: result.assetsSynced,
      assets_skipped: result.assetsSkipped,
      readings_written: result.readingsWritten,
    });
    logger.info('fleetops_odometer_sync complete', result);
    return result;
  } catch (err) {
    logger.error('fleetops_odometer_sync failed', { err: err.message });
    await fleetops.from('odometer_sync_log').insert({
      assets_synced: 0,
      assets_skipped: 0,
      readings_written: 0,
      error_message: err.message,
    }).catch(() => {});
    throw err;
  }
}
