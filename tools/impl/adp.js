// tools/impl/adp.js — RUN Powered by ADP read/write connector (SCAFFOLD, not yet live)
//
// ============================================================================
// STATUS AS OF 2026-09-01: blocked on ADP-side setup, not a code problem.
// ============================================================================
//
// Unlike serviceautopilot.js (no public API, endpoints reverse-engineered live
// against a real logged-in session) or quickbooks.js (self-serve Intuit
// developer OAuth2, working same-day), ADP requires Michael to personally
// complete several steps on ADP's side before this file can do anything real:
//
//   1. Log in to ADP's API Central developer portal (developers.adp.com)
//      using his existing RUN Powered by ADP account credentials — a new
//      developer app can only be registered against an active subscription,
//      not created standalone.
//   2. Register a "connected app" / project, and request the specific API
//      products/scopes actually needed (worker/employee data, pay
//      statements, time-off — the exact product names are only visible
//      inside the portal once logged in).
//   3. Generate a client certificate (ADP issues or asks you to submit a
//      CSR — confirm which, inside the portal) and get it associated with
//      the app. Every API call, INCLUDING the OAuth2 token exchange, must
//      present this cert via mutual TLS (see adp-token.js) — this is on top
//      of the client_id/client_secret pair, not instead of it.
//   4. For RUN specifically, ADP's API catalog is narrower than — and
//      structured differently from — ADP Workforce Now's. RUN access has
//      historically been scoped toward certified marketplace/ISV
//      integrations rather than an open self-serve worker-data API. Confirm
//      directly in the portal (or with JRB's ADP account rep) exactly which
//      resources RUN actually exposes for this account before assuming any
//      endpoint shape below is correct — none of the paths in this file are
//      verified against a real ADP response.
//   5. Test everything against ADP's sandbox (synthetic data) before ever
//      pointing at production payroll data.
//
// Once steps 1-3 are done, save the four secrets this needs via
// launcher/save-adp-secrets.ps1: ADP_CLIENT_ID, ADP_CLIENT_SECRET,
// ADP_CLIENT_CERT (full PEM), ADP_CLIENT_KEY (full PEM). adp-token.js's
// isADPConfigured()/getADPAccessToken() are real, standards-based OAuth2+mTLS
// plumbing and should work as-is once those secrets exist — that part isn't
// a guess. The functions below ARE the guess: they define the tool-facing
// shape Michael asked for (read + low-risk write, no direct deposit / pay
// rate / tax-election writes — see the scope decision recorded in the PR this
// file shipped in), but every ADP endpoint path is a TODO, not a fact, until
// someone with real portal access fills it in against ADP's actual docs.
//
// ============================================================================

import { adpRequest, isADPConfigured } from './adp-token.js';
import { logger } from '../../core/logger.js';

function notYetImplemented(fnName, hint) {
  const msg = `adp.${fnName}: not yet implemented — ${hint} This requires ` +
    `Michael to complete ADP API Central registration first (see the header ` +
    `comment in tools/impl/adp.js), then filling in the real endpoint path ` +
    `and payload shape from ADP's docs/sandbox once access exists.`;
  logger.warn(msg);
  throw new Error(msg);
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

/**
 * Search employees/workers by name. Intended tool: adp_search_employees.
 * TODO: confirm RUN's actual worker-search resource + query param names in
 * API Central before wiring this to a real path.
 */
export async function searchEmployees({ query }) {
  if (!isADPConfigured()) return { configured: false, reason: 'ADP not connected yet — see tools/impl/adp.js header.' };
  return notYetImplemented('searchEmployees', `would search for workers matching "${query}".`);
}

/**
 * Fetch one employee's profile (name, contact info, job/department, hire
 * date — NOT bank/SSN/pay-rate fields, out of scope for this build).
 * Intended tool: adp_get_employee.
 */
export async function getEmployee({ employeeId }) {
  if (!isADPConfigured()) return { configured: false, reason: 'ADP not connected yet — see tools/impl/adp.js header.' };
  return notYetImplemented('getEmployee', `would fetch worker ${employeeId}'s profile.`);
}

/**
 * Fetch a pay statement (read-only — gross/net/deductions summary for a
 * given pay period). Intended tool: adp_get_pay_statement.
 */
export async function getPayStatement({ employeeId, payDate }) {
  if (!isADPConfigured()) return { configured: false, reason: 'ADP not connected yet — see tools/impl/adp.js header.' };
  return notYetImplemented('getPayStatement', `would fetch the pay statement for worker ${employeeId} dated ${payDate}.`);
}

/**
 * Fetch an employee's current time-off/PTO balances. Intended tool:
 * adp_get_timeoff_balance.
 */
export async function getTimeOffBalance({ employeeId }) {
  if (!isADPConfigured()) return { configured: false, reason: 'ADP not connected yet — see tools/impl/adp.js header.' };
  return notYetImplemented('getTimeOffBalance', `would fetch time-off balances for worker ${employeeId}.`);
}

// ---------------------------------------------------------------------------
// Write tools — deliberately low-risk only (Michael's explicit scope
// decision, 2026-09-01). Never add a write here that touches direct deposit,
// pay rate, or tax elections without a separate, explicit go-ahead — this
// isn't a technical limitation, it's a compliance boundary.
// ---------------------------------------------------------------------------

/**
 * Update an employee's contact info (phone/personal email/address) — not
 * financial, not a tax election. Intended tool: adp_update_employee_contact_info.
 */
export async function updateEmployeeContactInfo({ employeeId, phone, personalEmail, address }) {
  if (!isADPConfigured()) return { configured: false, reason: 'ADP not connected yet — see tools/impl/adp.js header.' };
  return notYetImplemented('updateEmployeeContactInfo', `would update contact info for worker ${employeeId}.`);
}

/**
 * Submit a time-off request on an employee's behalf. Intended tool:
 * adp_submit_time_off_request.
 */
export async function submitTimeOffRequest({ employeeId, startDate, endDate, type, notes }) {
  if (!isADPConfigured()) return { configured: false, reason: 'ADP not connected yet — see tools/impl/adp.js header.' };
  return notYetImplemented('submitTimeOffRequest', `would submit a ${type} time-off request for worker ${employeeId} from ${startDate} to ${endDate}.`);
}
