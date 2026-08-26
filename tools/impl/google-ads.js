// tools/impl/google-ads.js — Google Ads API, read-only reporting access
//
// Google's REST interface 404s ("Method not found") on every canonical
// method as of 2026-08-26 -- confirmed live against a real OAuth token with
// the correct 'adwords' scope, across every currently-supported version
// (v22-v26). The officially-supported path is the google-ads Python client
// (gRPC-based), already proven live in the sibling google-ads-agent project.
// This module shells out to tools/impl/google_ads_bridge.py, a small
// dedicated read-only script, rather than reimplementing a REST client that
// doesn't actually work or importing google-ads-agent's own GoogleAdsTools
// class (which also exposes mutate methods -- pause/bid/budget/create --
// used by that project's own autonomous loop).
//
// Reuses the OAuth grant already live for that standalone project (same
// developer token/client/refresh token, migrated into Credential Manager as
// JRBAgent:GOOGLE_ADS_*) instead of requesting a new authorization. That
// token also has write access (Google Ads API has only one OAuth scope
// covering both read and write) -- the safety boundary here is the bridge
// script's function list, not the token itself. Do not add a mutate call to
// google_ads_bridge.py without a separate explicit scope decision, since
// this module is reachable from Teams/report task types.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);

const BRIDGE_SCRIPT = fileURLToPath(new URL('./google_ads_bridge.py', import.meta.url));

// Same fallback pattern as fleetsharp.js's EDGE_PATH/CHROME_PATH -- absolute
// path first (matches this machine's actual install), falling back to
// whatever "python" resolves to on PATH (e.g. a different machine/profile).
const PYTHON_PATH = 'C:\\Users\\Assistant\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const PYTHON_EXE = existsSync(PYTHON_PATH) ? PYTHON_PATH : 'python';

async function runBridge(command, args = {}) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(PYTHON_EXE, [BRIDGE_SCRIPT, command, JSON.stringify(args)], {
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    }));
  } catch (err) {
    // execFile rejects on non-zero exit, but the bridge still prints a JSON
    // error to stdout before exiting 1 -- prefer that structured message
    // over the generic "Command failed" error execFile throws.
    stdout = err.stdout;
    if (!stdout) throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Google Ads bridge returned non-JSON output: ${stdout.slice(0, 500)}`);
  }
  if (!parsed.ok) throw new Error(parsed.error || 'Google Ads bridge failed with no error message');
  return parsed.data;
}

// ── Public read-only report functions ──────────────────────────

export async function listCampaigns({ nameContains } = {}) {
  return runBridge('list_campaigns', { nameContains });
}

export async function getCampaignMetrics({ nameContains, startDate, endDate } = {}) {
  if (!startDate || !endDate) throw new Error('getCampaignMetrics requires startDate and endDate (YYYY-MM-DD)');
  return runBridge('get_campaign_metrics', { nameContains, startDate, endDate });
}

export async function getKeywordPerformance({ nameContains, startDate, endDate } = {}) {
  if (!startDate || !endDate) throw new Error('getKeywordPerformance requires startDate and endDate (YYYY-MM-DD)');
  return runBridge('get_keyword_performance', { nameContains, startDate, endDate });
}

export async function getLeadConversions({ nameContains, startDate, endDate } = {}) {
  if (!startDate || !endDate) throw new Error('getLeadConversions requires startDate and endDate (YYYY-MM-DD)');
  return runBridge('get_lead_conversions', { nameContains, startDate, endDate });
}
