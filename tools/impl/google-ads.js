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

import { fileURLToPath } from 'url';
import { runPythonBridge } from './python-bridge.js';

const BRIDGE_SCRIPT = fileURLToPath(new URL('./google_ads_bridge.py', import.meta.url));

async function runBridge(command, args = {}) {
  return runPythonBridge(BRIDGE_SCRIPT, command, args, { errorLabel: 'Google Ads bridge' });
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
