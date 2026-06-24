// tools/impl/qb-token.js — Shared QuickBooks OAuth token management
//
// Intuit rotates the refresh token on every access token refresh.
// The old refresh token is immediately invalidated, so we must save the new one
// back to Credential Manager after each rotation or the connection breaks within 1 hour.
//
// All QB code (quickbooks.js, carddav.js, etc.) should import getQBAccessToken()
// from here instead of implementing their own token refresh.

import axios from 'axios';
import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../../core/logger.js';

const QB_REDIRECT_URI = 'https://agent.jrboehlke.com/qb-callback';

// In-process cache
let _accessToken = null;
let _accessTokenExpiry = 0;
let _refreshToken = null; // populated lazily from process.env

// Mutex: prevents concurrent callers from each firing a refresh with the same
// stale refresh token. Intuit invalidates the old token the moment the first
// rotation succeeds, so the second concurrent caller would receive HTTP 400.
let _refreshPromise = null;

function currentRefreshToken() {
  if (!_refreshToken) _refreshToken = process.env.QB_REFRESH_TOKEN;
  return _refreshToken;
}

// ── Access token (auto-refresh + rotation) ───────────────────

export async function getQBAccessToken() {
  if (_accessToken && Date.now() < _accessTokenExpiry - 60_000) return _accessToken;

  // Serialize concurrent refresh attempts behind a single promise.
  // Any caller that arrives while a refresh is already in flight waits for it
  // instead of launching a second one with the same (now-invalid) refresh token.
  if (_refreshPromise) return _refreshPromise;

  _refreshPromise = _doRefresh().finally(() => { _refreshPromise = null; });
  return _refreshPromise;
}

async function _doRefresh() {
  const rt = currentRefreshToken();
  if (!rt) throw new Error('QB_REFRESH_TOKEN not set — run QB re-auth at /qb-reauth');

  const creds = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const res = await axios.post(
    'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    `grant_type=refresh_token&refresh_token=${encodeURIComponent(rt)}`,
    { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  _accessToken = res.data.access_token;
  _accessTokenExpiry = Date.now() + res.data.expires_in * 1000;

  // Intuit rotates the refresh token on every call — persist it immediately
  if (res.data.refresh_token && res.data.refresh_token !== _refreshToken) {
    const newRt = res.data.refresh_token;
    _refreshToken = newRt;
    process.env.QB_REFRESH_TOKEN = newRt;
    saveRefreshToken(newRt).then(
      () => logger.info('QB: refresh token rotated and saved to Credential Manager'),
      err => logger.warn('QB: refresh token rotation — Credential Manager save failed (token updated in memory only)', { err: err.message })
    );
  }

  return _accessToken;
}

// ── OAuth code exchange (initial auth + re-auth) ──────────────

export async function exchangeQBAuthCode(code) {
  const creds = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const res = await axios.post(
    'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(QB_REDIRECT_URI)}`,
    { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  if (!res.data.access_token || !res.data.refresh_token) {
    throw new Error(`QB code exchange failed: ${JSON.stringify(res.data)}`);
  }

  _accessToken = res.data.access_token;
  _accessTokenExpiry = Date.now() + res.data.expires_in * 1000;
  _refreshToken = res.data.refresh_token;
  process.env.QB_REFRESH_TOKEN = _refreshToken;

  await saveRefreshToken(_refreshToken);
  logger.info('QB: OAuth code exchanged, tokens saved');
  return { accessToken: _accessToken, refreshToken: _refreshToken };
}

// ── Build Intuit authorization URL ────────────────────────────

export function buildQBAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.QB_CLIENT_ID,
    redirect_uri: QB_REDIRECT_URI,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    state: state || 'qb-reauth',
  });
  return `https://appcenter.intuit.com/connect/oauth2?${params}`;
}

// ── Persist rotated refresh token to Credential Manager ───────

async function saveRefreshToken(token) {
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
$ok = [CredSaver]::Write('JRBAgent:QB_REFRESH_TOKEN', 'JRBAgent', $Token)
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
        execFileSync('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', tmpFile, '-Token', token], {
          timeout: 15_000,
        });
        return; // success
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_ATTEMPTS) {
          logger.warn(`QB: saveRefreshToken attempt ${attempt} failed, retrying`, { err: err.message });
          await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      }
    }
    throw lastErr;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}
