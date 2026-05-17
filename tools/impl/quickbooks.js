// tools/impl/quickbooks.js — QuickBooks Online v3 API
// Reuses the refresh pattern from the existing AuditMatchingEngine project.

import axios from 'axios';
import { cacheGet, cacheSet } from '../../memory/memory.js';
import { logger } from '../../core/logger.js';

const BASE = `https://quickbooks.api.intuit.com/v3/company/${process.env.QB_REALM_ID}`;

// ── Token refresh ─────────────────────────────────────────────
let _qbToken = null;
let _qbTokenExpiry = 0;

async function getToken() {
  if (_qbToken && Date.now() < _qbTokenExpiry - 60_000) return _qbToken;

  const creds = Buffer.from(
    `${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`
  ).toString('base64');

  const res = await axios.post(
    'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    `grant_type=refresh_token&refresh_token=${encodeURIComponent(process.env.QB_REFRESH_TOKEN)}`,
    {
      headers: {
        Authorization: `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  _qbToken = res.data.access_token;
  _qbTokenExpiry = Date.now() + res.data.expires_in * 1000;
  return _qbToken;
}

// ── Query ─────────────────────────────────────────────────────

/**
 * Run a QBO SQL-like query. Results are cached by query string.
 * @param {object} opts
 * @param {string} opts.query - e.g. "SELECT * FROM Invoice STARTPOSITION 1 MAXRESULTS 100"
 */
export async function query({ query: qStr }) {
  // Cache check — avoids re-hitting QB on every scheduler tick
  const cacheKey = `qb:${Buffer.from(qStr).toString('base64').slice(0, 60)}`;
  const cached = await cacheGet(cacheKey);
  if (cached) {
    logger.debug('QB cache hit', { query: qStr.slice(0, 60) });
    return JSON.parse(cached);
  }

  const token = await getToken();
  const res = await axios.get(`${BASE}/query`, {
    params: { query: qStr },
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });

  const result = res.data.QueryResponse;
  await cacheSet(cacheKey, result);
  return result;
}

/**
 * Fetch a single Purchase entity by ID from QBO.
 * Used by the expense capture webhook handler.
 */
export async function getPurchase(id) {
  const token = await getToken();
  const res = await axios.get(
    `${BASE}/purchase/${id}`,
    {
      params: { minorversion: 65 },
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }
  );
  return res.data?.Purchase ?? null;
}
