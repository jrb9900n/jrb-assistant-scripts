// tools/impl/google-ads.js — Google Ads API: reporting + a narrow, deliberate
// set of mutate operations
//
// Google's REST interface 404s ("Method not found") on every canonical
// method as of 2026-08-26 -- confirmed live against a real OAuth token with
// the correct 'adwords' scope, across every currently-supported version
// (v22-v26). The officially-supported path is the google-ads Python client
// (gRPC-based), already proven live in the sibling google-ads-agent project.
// This module shells out to tools/impl/google_ads_bridge.py rather than
// reimplementing a REST client that doesn't actually work or importing
// google-ads-agent's own GoogleAdsTools class directly (that class's mutate
// methods are used here as a reference implementation, not imported).
//
// Reuses the OAuth grant already live for that standalone project (same
// developer token/client/refresh token, migrated into Credential Manager as
// JRBAgent:GOOGLE_ADS_*) instead of requesting a new authorization. That
// token also has write access (Google Ads API has only one OAuth scope
// covering both read and write) -- the safety boundary here is the bridge
// script's function list, not the token itself.
//
// 2026-09-03 scope decision (Michael: "google ads mutate is fine"): this
// module used to be read-only by explicit design -- a live incident showed
// the bot could identify exactly which 7 keywords to pause but had no tool
// to do it, and had to ask Michael to do it manually in the Ads UI. Added
// pauseKeyword/enableKeyword/adjustCampaignBudget (ported from
// google-ads-agent's already-proven pause_keyword/enable_keyword/
// adjust_campaign_budget). Deliberately does NOT add bid changes or
// campaign/ad group/ad creation -- those are separate, larger-blast-radius
// decisions with no immediate driving need; re-evaluate before adding more
// to google_ads_bridge.py's COMMANDS dict, since this module is reachable
// from Teams/report/general task types.

import { fileURLToPath } from 'url';
import { runPythonBridge } from './python-bridge.js';
import { logObservation } from './feedback.js';
import { logger } from '../../core/logger.js';

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

// ── Mutate operations (real-money actions -- see the 2026-09-03 scope
// decision in this file's header) ────────────────────────────────────────

// logObservation calls below are fire-and-forget and only reached once a
// mutate actually executes (after code-approval.js's gate has released it,
// or on retry) -- never on a merely-requested-but-unconfirmed call.

export async function pauseKeyword({ keywordId, reason } = {}) {
  if (!keywordId) throw new Error('pauseKeyword requires keywordId (see getKeywordPerformance\'s keywordId field)');
  if (!reason) throw new Error('pauseKeyword requires reason (for the Knowledge Log / audit trail)');
  const result = await runBridge('pause_keyword', { keywordId, reason });
  logObservation({ agentName: 'google_ads', actionTaken: `Paused keyword ${keywordId}`, rawContext: reason })
    .catch(err => logger.warn("google-ads: logObservation failed (non-fatal)", { err: err.message }));
  return result;
}

export async function enableKeyword({ keywordId, reason } = {}) {
  if (!keywordId) throw new Error('enableKeyword requires keywordId (see getKeywordPerformance\'s keywordId field)');
  if (!reason) throw new Error('enableKeyword requires reason (for the Knowledge Log / audit trail)');
  const result = await runBridge('enable_keyword', { keywordId, reason });
  logObservation({ agentName: 'google_ads', actionTaken: `Re-enabled keyword ${keywordId}`, rawContext: reason })
    .catch(err => logger.warn("google-ads: logObservation failed (non-fatal)", { err: err.message }));
  return result;
}

export async function adjustCampaignBudget({ campaignId, newDailyBudgetUsd, reason } = {}) {
  if (!campaignId) throw new Error('adjustCampaignBudget requires campaignId (see listCampaigns\' id field)');
  if (typeof newDailyBudgetUsd !== 'number' || newDailyBudgetUsd <= 0) {
    throw new Error('adjustCampaignBudget requires a positive newDailyBudgetUsd');
  }
  if (!reason) throw new Error('adjustCampaignBudget requires reason (for the Knowledge Log / audit trail)');
  // No override for the shared-budget check google_ads_bridge.py's
  // adjust_campaign_budget does before mutating, deliberately -- the model's
  // tool_use input isn't a trusted channel (see dispatchTool()'s own JSDoc),
  // so any override flag here would just be something the model could set
  // on its very first call, before Michael ever saw a shared-budget warning
  // to confirm. If a shared-budget change is ever genuinely wanted, that's
  // a manual Ads UI action, not this tool.
  const result = await runBridge('adjust_campaign_budget', { campaignId, newDailyBudgetUsd, reason });
  logObservation({ agentName: 'google_ads', actionTaken: `Changed campaign ${campaignId} daily budget to $${newDailyBudgetUsd}`, rawContext: reason })
    .catch(err => logger.warn("google-ads: logObservation failed (non-fatal)", { err: err.message }));
  return result;
}
