// tools/impl/adp-token.js — ADP (RUN Powered by ADP) OAuth2 + mutual-TLS token management
//
// ADP's API Central layers mutual TLS (mTLS) on top of a standard OAuth2
// client_credentials grant: EVERY request, including the initial token
// exchange itself, must present a client certificate ADP has already
// associated with the registered app, on top of the client_id/client_secret.
// This is a materially different auth model from QuickBooks (qb-token.js) or
// M365 (plain OAuth2, no client cert) — do not copy either of those patterns
// here without accounting for the cert requirement.
//
// STATUS (2026-09-01): not yet usable. JRB has no ADP developer account, no
// registered connected app, and no issued client certificate — none of which
// this code can create. Michael must complete ADP's own onboarding first (see
// the checklist in this file's companion PR description / adp.js header)
// before any of this can be exercised against a real ADP sandbox or account.
// Every exported function here is real, standards-based OAuth2+mTLS plumbing,
// not a guess — but it has never been run against ADP's actual servers.

import https from 'https';
import axios from 'axios';
import { logger } from '../../core/logger.js';

// ADP's token endpoint is the same for sandbox and production; which
// environment you reach depends entirely on which cert/client_id ADP issued.
const ADP_TOKEN_URL = 'https://accounts.adp.com/auth/oauth/v2/token';

let cachedToken = null;   // { accessToken, expiresAt }
let refreshPromise = null; // in-flight de-dupe, same pattern as qb-token.js's per-company mutex

export function isADPConfigured() {
  return Boolean(
    process.env.ADP_CLIENT_ID &&
    process.env.ADP_CLIENT_SECRET &&
    process.env.ADP_CLIENT_CERT &&
    process.env.ADP_CLIENT_KEY
  );
}

function requireADPConfig() {
  if (!isADPConfigured()) {
    throw new Error(
      'ADP is not configured yet. Requires ADP_CLIENT_ID, ADP_CLIENT_SECRET, ' +
      'ADP_CLIENT_CERT, and ADP_CLIENT_KEY in Credential Manager (JRBAgent:ADP_*), ' +
      'which in turn requires Michael to complete ADP API Central developer ' +
      'registration for the RUN Powered by ADP account and receive a signed ' +
      'client certificate. See tools/impl/adp.js header for the full checklist.'
    );
  }
}

// Builds the mTLS-capable HTTPS agent from the cert/key pair. Both are full
// PEM text (not file paths) so Credential Manager can hold them as single
// string values — see launcher/save-adp-secrets.ps1.
function buildMtlsAgent() {
  return new https.Agent({
    cert: process.env.ADP_CLIENT_CERT,
    key: process.env.ADP_CLIENT_KEY,
  });
}

/**
 * Returns a valid ADP access token, refreshing if expired or absent.
 * ADP's client_credentials tokens are short-lived (documented ~1 hour) and
 * carry no refresh token of their own — unlike QBO, there's nothing to
 * rotate/persist between process restarts; just re-request when expired.
 */
export async function getADPAccessToken() {
  requireADPConfig();

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const agent = buildMtlsAgent();
      const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.ADP_CLIENT_ID,
        client_secret: process.env.ADP_CLIENT_SECRET,
      });
      const resp = await axios.post(ADP_TOKEN_URL, params.toString(), {
        httpsAgent: agent,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const { access_token: accessToken, expires_in: expiresIn } = resp.data;
      cachedToken = { accessToken, expiresAt: Date.now() + (expiresIn ?? 3600) * 1000 };
      logger.info('adp-token: obtained new ADP access token');
      return accessToken;
    } catch (err) {
      logger.error(`adp-token: token request failed: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
      throw err;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/**
 * Generic authenticated ADP API request. `path` is relative to
 * https://api.adp.com (ADP's API Central base for both sandbox and
 * production — environment again follows from which cert was issued).
 *
 * Callers in adp.js should NOT hardcode endpoint paths without first
 * confirming them against ADP's actual API Central docs/sandbox for the RUN
 * product specifically — RUN's API catalog is narrower than, and diverges
 * from, ADP Workforce Now's, and guessing a Workforce-Now-shaped path here
 * would silently 404 or (worse) hit the wrong resource.
 */
export async function adpRequest(method, path, { params, data } = {}) {
  requireADPConfig();
  const accessToken = await getADPAccessToken();
  const agent = buildMtlsAgent();
  const resp = await axios({
    method,
    url: `https://api.adp.com${path}`,
    params,
    data,
    httpsAgent: agent,
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return resp.data;
}
