// tools/impl/qb-token.js — Shared QuickBooks OAuth token management
//
// Intuit rotates the refresh token on every access token refresh.
// The old refresh token is immediately invalidated, so we must save the new one
// back to Credential Manager after each rotation or the connection breaks within 1 hour.
//
// All QB code (quickbooks.js, carddav.js, etc.) should import getQBAccessToken()
// from here instead of implementing their own token refresh.
//
// Multi-company (added 2026-08-21): one Intuit developer app (QB_CLIENT_ID/
// QB_CLIENT_SECRET) can be authorized against more than one QBO company file —
// each authorization gets its own realm ID + refresh token, but shares the
// same client credentials. Every function here takes an optional `company`
// key (defaults to 'jrb' for backward compatibility with the original
// single-company env vars/Credential Manager target) so callers can address
// a second company (e.g. JRB Transport LLC) without duplicating this module.

import axios from 'axios';
import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { logger } from '../../core/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../../data');

// QB refresh tokens expire 101 days after last rotation (Intuit policy).
// We record the rotation timestamp so the reminder cron can warn 14 days before expiry.
export const QB_TOKEN_TTL_DAYS = 101;

const QB_REDIRECT_URI = 'https://agent.jrboehlke.com/qb-callback';

// Per-company static config. 'jrb' keeps the original env var names / Credential
// Manager target so nothing changes for existing callers that don't pass a company.
const QB_COMPANIES = {
  jrb: {
    label: 'J.R. Boehlke, LLC',
    credTarget: 'JRBAgent:QB_REFRESH_TOKEN',
    refreshEnvVar: 'QB_REFRESH_TOKEN',
    realmEnvVar: 'QB_REALM_ID',
    metaFile: join(DATA_DIR, 'qb-token-meta.json'),
  },
  transport: {
    label: 'JRB Transport LLC',
    credTarget: 'JRBAgent:QB_REFRESH_TOKEN_TRANSPORT',
    refreshEnvVar: 'QB_REFRESH_TOKEN_TRANSPORT',
    realmEnvVar: 'QB_REALM_ID_TRANSPORT',
    metaFile: join(DATA_DIR, 'qb-token-meta-transport.json'),
  },
  propco: {
    label: 'JRB Granville Propco',
    credTarget: 'JRBAgent:QB_REFRESH_TOKEN_PROPCO',
    refreshEnvVar: 'QB_REFRESH_TOKEN_PROPCO',
    realmEnvVar: 'QB_REALM_ID_PROPCO',
    metaFile: join(DATA_DIR, 'qb-token-meta-propco.json'),
  },
};

export function listQBCompanies() {
  return Object.keys(QB_COMPANIES);
}

// Display label for a company key (e.g. 'transport' -> 'JRB Transport LLC'),
// for callers that need to build a company list without hardcoding names
// (e.g. a report covering "every configured company" generically).
export function getQBCompanyLabel(company) {
  return companyConfig(company).label;
}

/**
 * Runs `fetchFn(company)` for every configured QB company in parallel and
 * normalizes the three outcomes a multi-entity report needs to distinguish:
 *   - not yet OAuth-authorized: `{ connected: false }` — silently omit, this
 *     is expected until Michael finishes /qb-reauth for that company
 *   - connected but the live call failed: `{ connected: true, error }` —
 *     must be surfaced, never silently dropped from a total (a company that
 *     fails to fetch is not the same as a company with $0)
 *   - success: `{ connected: true, ...whatever fetchFn returned }`
 * Used by cash-forecast-report.js and weekly-scorecard-report.js.
 * ap-report.js/bank-monthly-report.js predate this helper and use their own
 * per-company fetch pattern (each entity independently try/caught) — not
 * retrofitted here to avoid touching already-live, already-tested code for a
 * cosmetic consistency pass.
 */
export async function gatherAcrossCompanies(fetchFn) {
  return Promise.all(listQBCompanies().map(async company => {
    const label = getQBCompanyLabel(company);
    if (!getQBRealmId(company)) return { company, label, connected: false };
    try {
      const data = await fetchFn(company);
      return { company, label, connected: true, ...data };
    } catch (err) {
      // Guaranteed non-empty so every consumer's plain truthiness check
      // (`if (e.error)`) can't be fooled by an Error with an empty/missing
      // message (e.g. `new Error()`, or a non-Error rejection value) into
      // treating a real failure as a success with no data.
      return { company, label, connected: true, error: err.message || 'Unknown error' };
    }
  }));
}

/**
 * Sums `pick(result)` across every company that both succeeded (`connected`
 * and no `error`) AND has that field present (`pick` returns a finite
 * number) — derives a combined total plus an "is any real data available at
 * all" flag from `gatherAcrossCompanies`' results. `available` is false when
 * NO company contributed a number, whether that's because none are
 * connected yet or because every connected one's query failed — callers
 * that need to tell those two cases apart for wording should check
 * `results.some(r => r.connected)` themselves; this helper only answers "do
 * I have a real number to show."
 */
export function summarizeAcrossCompanies(results, pick) {
  const ok = results.filter(r => r.connected && !r.error && Number.isFinite(pick(r)));
  return { ok, combinedTotal: ok.reduce((s, r) => s + pick(r), 0), available: ok.length > 0 };
}

function companyConfig(company) {
  const cfg = QB_COMPANIES[company];
  if (!cfg) throw new Error(`Unknown QB company "${company}" — expected one of: ${listQBCompanies().join(', ')}`);
  return cfg;
}

// Per-company mutable state (access token cache, in-flight refresh promise,
// in-memory refresh token/realm ID overrides). Kept in a Map rather than
// module-level scalars so a refresh/rotation for one company can never race
// or clobber the other's state.
const _state = new Map();
function stateFor(company) {
  if (!_state.has(company)) {
    _state.set(company, { accessToken: null, accessTokenExpiry: 0, refreshToken: null, refreshPromise: null, realmId: null });
  }
  return _state.get(company);
}

function currentRefreshToken(company) {
  const s = stateFor(company);
  if (!s.refreshToken) s.refreshToken = process.env[companyConfig(company).refreshEnvVar];
  return s.refreshToken;
}

// ── Realm ID (mostly static, but settable at re-auth time) ────

/**
 * Realm ID for a company. Prefers the env var (set by the launcher from
 * Credential Manager at boot) but falls back to the value captured live
 * during the most recent exchangeQBAuthCode() in this process — so a fresh
 * re-auth works immediately without requiring an agent restart first.
 */
export function getQBRealmId(company = 'jrb') {
  const cfg = companyConfig(company);
  return process.env[cfg.realmEnvVar] || stateFor(company).realmId || getPersistedRealmId(company);
}

function getPersistedRealmId(company) {
  return getQBTokenMeta(company)?.realmId ?? null;
}

// ── Token rotation metadata (per company) ──────────────────────

function saveTokenMeta(company, extra = {}) {
  const cfg = companyConfig(company);
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const prior = getQBTokenMeta(company) || {};
    writeFileSync(cfg.metaFile, JSON.stringify({ ...prior, lastRotatedAt: new Date().toISOString(), ...extra }), 'utf8');
  } catch (err) {
    logger.warn('QB: failed to save token meta', { company, err: err.message });
  }
}

export function getQBTokenMeta(company = 'jrb') {
  try {
    return JSON.parse(readFileSync(companyConfig(company).metaFile, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

// ── Access token (auto-refresh + rotation) ───────────────────

export async function getQBAccessToken(company = 'jrb') {
  const s = stateFor(company);
  if (s.accessToken && Date.now() < s.accessTokenExpiry - 60_000) return s.accessToken;

  // Serialize concurrent refresh attempts behind a single promise.
  // Any caller that arrives while a refresh is already in flight waits for it
  // instead of launching a second one with the same (now-invalid) refresh token.
  if (s.refreshPromise) return s.refreshPromise;

  s.refreshPromise = _doRefresh(company).finally(() => { s.refreshPromise = null; });
  return s.refreshPromise;
}

async function _doRefresh(company) {
  const cfg = companyConfig(company);
  const s = stateFor(company);
  let rt = currentRefreshToken(company);
  if (!rt) throw new Error(`${cfg.refreshEnvVar} not set — run QB re-auth at /qb-reauth?company=${company}`);

  const creds = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');

  async function callIntuit(token) {
    return axios.post(
      'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
      `grant_type=refresh_token&refresh_token=${encodeURIComponent(token)}`,
      { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
  }

  let res;
  try {
    res = await callIntuit(rt);
  } catch (err) {
    // 400 (invalid_grant) means another process already rotated this token.
    // Re-read the current token from Credential Manager and retry once.
    if (err.response?.status === 400) {
      const latestRt = await readCredential(cfg.credTarget);
      if (!latestRt) {
        logger.warn('QB: CredMgr re-read returned null — cannot recover from 400', { company, err: err.message });
        throw err;
      }
      if (latestRt === rt) {
        logger.warn('QB: CredMgr token matches in-memory token — not a cross-process race; re-auth required', { company, err: err.message });
        throw err;
      }
      logger.info('QB: stale token detected — retrying with current Credential Manager token', { company });
      s.refreshToken = latestRt;
      process.env[cfg.refreshEnvVar] = latestRt;
      res = await callIntuit(latestRt); // throws if still invalid
    } else {
      throw err;
    }
  }

  s.accessToken = res.data.access_token;
  s.accessTokenExpiry = Date.now() + res.data.expires_in * 1000;

  // Intuit rotates the refresh token on every call — persist it immediately
  if (res.data.refresh_token && res.data.refresh_token !== s.refreshToken) {
    const newRt = res.data.refresh_token;
    s.refreshToken = newRt;
    process.env[cfg.refreshEnvVar] = newRt;
    saveCredential(cfg.credTarget, newRt).then(
      () => logger.info('QB: refresh token rotated and saved to Credential Manager', { company }),
      err => logger.warn('QB: refresh token rotation — Credential Manager save failed (token updated in memory only)', { company, err: err.message })
    );
  }
  saveTokenMeta(company);

  return s.accessToken;
}

// ── OAuth code exchange (initial auth + re-auth) ──────────────

export async function exchangeQBAuthCode(code, company = 'jrb', realmId = null) {
  const cfg = companyConfig(company);
  const s = stateFor(company);
  const creds = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const res = await axios.post(
    'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(QB_REDIRECT_URI)}`,
    { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  if (!res.data.access_token || !res.data.refresh_token) {
    throw new Error(`QB code exchange failed: ${JSON.stringify(res.data)}`);
  }

  s.accessToken = res.data.access_token;
  s.accessTokenExpiry = Date.now() + res.data.expires_in * 1000;
  s.refreshToken = res.data.refresh_token;
  process.env[cfg.refreshEnvVar] = s.refreshToken;

  await saveCredential(cfg.credTarget, s.refreshToken);

  // Realm ID doesn't rotate, but capture it at auth time so the connection
  // works this process without waiting for a launcher restart to pick up a
  // newly-saved QB_REALM_ID_* env var. Not secret, so it lives in the plain
  // JSON meta file rather than Credential Manager.
  if (realmId) {
    s.realmId = realmId;
    saveTokenMeta(company, { realmId });
  } else {
    saveTokenMeta(company);
  }

  logger.info('QB: OAuth code exchanged, tokens saved', { company, realmId: realmId || undefined });
  return { accessToken: s.accessToken, refreshToken: s.refreshToken, realmId: realmId || getQBRealmId(company) };
}

// ── Build Intuit authorization URL ────────────────────────────

/**
 * @param {string} company - 'jrb' (default) or 'transport'
 * @param {string} [state] - opaque suffix; the company is always encoded as
 *   the state's prefix ("company:suffix") so /qb-callback knows which
 *   company's tokens to save without any other side channel.
 */
export function buildQBAuthUrl(company = 'jrb', state) {
  companyConfig(company); // validates company, throws on unknown key
  const params = new URLSearchParams({
    client_id: process.env.QB_CLIENT_ID,
    redirect_uri: QB_REDIRECT_URI,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    state: `${company}:${state || 'qb-reauth-' + Date.now()}`,
  });
  return `https://appcenter.intuit.com/connect/oauth2?${params}`;
}

/**
 * Recovers the company key encoded by buildQBAuthUrl from the callback's `state` param.
 * Throws on anything that isn't a recognized company prefix -- this used to silently
 * default to 'jrb', which meant a mangled/dropped state param (confirmed live 2026-08-25:
 * a propco reauth's state didn't survive the redirect on a second machine) got treated as
 * a legitimate 'jrb' reauth and overwrote production JRB's refresh token with one scoped
 * to a different QBO realm, breaking the live jrb connection until manually caught and
 * re-authorized. Guessing wrong here is a production incident, not a graceful fallback --
 * an ambiguous state must fail loudly so the reauth can be retried, never silently land on
 * whichever company happens to be the default.
 */
export function parseQBAuthState(state) {
  const prefix = String(state || '').split(':')[0];
  if (!QB_COMPANIES[prefix]) {
    throw new Error(`QB reauth state param missing or unrecognized ("${state}") -- refusing to guess which company this belongs to. Retry the reauth link; if this keeps happening, the state param is being dropped/altered before it reaches the callback.`);
  }
  return prefix;
}

// ── Read current refresh token from Credential Manager ────────

async function readCredential(target) {
  const tmpFile = join(tmpdir(), `qb-cred-read-${Date.now()}.ps1`);
  const ps = `Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CredReader {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags; public uint Type; public string TargetName; public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
        public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
    }
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll")]
    public static extern void CredFree(IntPtr buffer);
    public static string Read(string target) {
        IntPtr ptr = IntPtr.Zero;
        if (!CredRead(target, 1, 0, out ptr)) return null;
        var cred = Marshal.PtrToStructure<CREDENTIAL>(ptr);
        var password = Marshal.PtrToStringUni(cred.CredentialBlob, (int)(cred.CredentialBlobSize / 2));
        CredFree(ptr);
        return password;
    }
}
"@
Write-Output ([CredReader]::Read('${target}'))
`;
  try {
    writeFileSync(tmpFile, ps, 'utf8');
    const out = execFileSync('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', tmpFile], {
      timeout: 10_000,
      encoding: 'utf8',
    });
    return out.trim() || null;
  } catch {
    return null;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

// ── Persist rotated refresh token to Credential Manager ───────

async function saveCredential(target, value) {
  // Write a temp PS1 script that uses Win32 CredWrite (handles long tokens
  // that cmdkey silently truncates).
  // IMPORTANT: check CredWrite return value and exit 1 on failure so
  // execFileSync throws — previously | Out-Null discarded the result and
  // silent failures were logged as successes, leaving Credential Manager stale.
  const tmpFile = join(tmpdir(), `qb-cred-save-${Date.now()}.ps1`);
  const ps = `param([string]$Token)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CredSaver {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags; public uint Type; public string TargetName; public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
        public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
    }
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool CredWrite([In] ref CREDENTIAL credential, uint flags);
    public static bool Write(string target, string user, string pass) {
        var blob = Marshal.StringToCoTaskMemUni(pass);
        var c = new CREDENTIAL { Type=1, TargetName=target, UserName=user,
            CredentialBlob=blob, CredentialBlobSize=(uint)(pass.Length*2), Persist=2 };
        bool ok = CredWrite(ref c, 0);
        Marshal.FreeCoTaskMem(blob);
        return ok;
    }
}
"@
$ok = [CredSaver]::Write('${target}', 'JRBAgent', $Token)
if (-not $ok) {
    $errCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Error "CredWrite failed with Win32 error $errCode"
    exit 1
}
`;

  writeFileSync(tmpFile, ps, 'utf8');
  // Outer finally guarantees the token-containing PS1 is removed on every exit path
  // (success on attempt 1, success on attempt 2, all retries exhausted, or early throw).
  try {
    const MAX_ATTEMPTS = 3;
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        execFileSync('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', tmpFile, '-Token', value], {
          timeout: 15_000,
        });
        return; // success
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_ATTEMPTS) {
          logger.warn(`QB: saveCredential attempt ${attempt} failed, retrying`, { target, err: err.message });
          await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      }
    }
    throw lastErr;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}
