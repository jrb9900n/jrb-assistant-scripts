// tools/impl/credential-backup.js — Windows Credential Manager backup/restore/healthcheck
//
// Built after the 2026-08-12 KB5121003 incident wiped every JRBAgent:* Credential
// Manager entry with no warning and no backup, costing hours of forensic recovery
// from scattered .env files and PM2 dumps (see memory:
// project-kb5121003-credential-wipe-2026-08-12). This closes that gap:
//   - Daily encrypted backup of every JRBAgent:* entry, stored locally AND on
//     OneDrive (survives a local-disk-only disaster, not just a vault wipe)
//   - Frequent healthcheck that detects missing credentials within ~20 minutes
//     instead of the hours it took last time
//   - A tested, dry-run-by-default restore path
//
// Encryption: DPAPI (CurrentUser scope) — ties the ciphertext to this Windows
// user's DPAPI master key, which is a SEPARATE store from Credential Manager
// and is confirmed to have survived the actual 2026-08-12 incident intact.
// Limitation: this does NOT protect against loss of the entire Windows profile/
// machine (DPAPI master key would be gone too) — only against a Credential
// Manager-specific wipe, which is the failure mode that actually happened.

import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync, mkdirSync, readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { logger } from '../../core/logger.js';
import { saveToOneDrive, readFromOneDrive } from './m365.js';
import { sendProactiveMessage } from '../../teams/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = 'C:\\Users\\Assistant\\CredentialBackups';
const ONEDRIVE_PATH = '/JRBAgent-Ops/CredentialBackups/latest.enc';
const HEALTHCHECK_STATE_FILE = join(__dirname, '../../data/credential-healthcheck-state.json');
const RETENTION_DAYS = 30;

function runPS(script, args = []) {
  const tmpFile = join(tmpdir(), `cred-backup-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  writeFileSync(tmpFile, script, 'utf8');
  try {
    return execFileSync('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', tmpFile, ...args], {
      timeout: 20_000,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

// ── Enumerate every JRBAgent:* Credential Manager entry ───────

const ENUMERATE_PS = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct CREDENTIAL_BK {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
}
public class CredEnumBK {
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool CredEnumerate(string filter, int flag, out int count, out IntPtr pCredentials);
    [DllImport("advapi32.dll")]
    public static extern void CredFree(IntPtr cred);
}
"@

$count = 0
$pCreds = [IntPtr]::Zero
$ok = [CredEnumBK]::CredEnumerate("JRBAgent:*", 0, [ref]$count, [ref]$pCreds)
if (-not $ok) { Write-Output "[]"; exit 0 }

$results = @()
for ($i = 0; $i -lt $count; $i++) {
    $credPtr = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($pCreds, $i * [IntPtr]::Size)
    $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($credPtr, [type]"CREDENTIAL_BK")
    $blob = $null
    if ($cred.CredentialBlobSize -gt 0) {
        $blob = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($cred.CredentialBlob, [int]($cred.CredentialBlobSize / 2))
    }
    $name = $cred.TargetName -replace '^JRBAgent:',''
    $results += [PSCustomObject]@{ name = $name; value = $blob }
}
[CredEnumBK]::CredFree($pCreds)
if ($results.Count -eq 1) { Write-Output "[$($results | ConvertTo-Json -Compress)]" }
else { $results | ConvertTo-Json -Compress }
`;

export function enumerateJRBCredentials() {
  const out = runPS(ENUMERATE_PS);
  const parsed = JSON.parse(out.trim() || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

// ── Write a single credential back to Credential Manager ──────

function writeCredential(name, value) {
  const ps = `param([string]$Name, [string]$Value)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CredWriterBK {
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
$ok = [CredWriterBK]::Write("JRBAgent:$Name", "JRBAgent", $Value)
if (-not $ok) {
    $errCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Error "CredWrite failed for $Name with Win32 error $errCode"
    exit 1
}
`;
  const tmpFile = join(tmpdir(), `cred-write-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  writeFileSync(tmpFile, ps, 'utf8');
  try {
    execFileSync('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', tmpFile, '-Name', name, '-Value', value], {
      timeout: 15_000,
    });
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

// ── DPAPI encrypt/decrypt (CurrentUser scope) ──────────────────

function encryptForBackup(plaintext) {
  const tmpIn = join(tmpdir(), `cred-plain-${Date.now()}.txt`);
  writeFileSync(tmpIn, plaintext, 'utf8');
  const ps = `param([string]$InPath)
Add-Type -AssemblyName System.Security
$bytes = [System.IO.File]::ReadAllBytes($InPath)
$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($enc)
`;
  const tmpFile = join(tmpdir(), `cred-encrypt-${Date.now()}.ps1`);
  writeFileSync(tmpFile, ps, 'utf8');
  try {
    const out = execFileSync('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', tmpFile, '-InPath', tmpIn], {
      timeout: 15_000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
    });
    return out.trim();
  } finally {
    try { unlinkSync(tmpFile); } catch {}
    try { unlinkSync(tmpIn); } catch {}
  }
}

function decryptBackup(base64) {
  const ps = `param([string]$B64)
Add-Type -AssemblyName System.Security
$enc = [Convert]::FromBase64String($B64)
$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[System.Text.Encoding]::UTF8.GetString($dec)
`;
  const tmpFile = join(tmpdir(), `cred-decrypt-${Date.now()}.ps1`);
  writeFileSync(tmpFile, ps, 'utf8');
  try {
    return execFileSync('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', tmpFile, '-B64', base64], {
      timeout: 15_000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

// ── Backup ──────────────────────────────────────────────────────

export async function runCredentialBackup() {
  const entries = enumerateJRBCredentials();
  if (entries.length === 0) {
    logger.warn('credential_backup: enumerate returned 0 entries — refusing to write an empty backup');
    await sendProactiveMessage('⚠️ Credential backup found 0 JRBAgent:* entries in Credential Manager — this is almost certainly wrong (there should be 35+). Skipped writing a backup to avoid overwriting a good one with an empty snapshot. Check Credential Manager immediately.').catch(() => {});
    return { ok: false, count: 0 };
  }

  const payload = JSON.stringify({ savedAt: new Date().toISOString(), entries });
  const encrypted = encryptForBackup(payload);

  mkdirSync(BACKUP_DIR, { recursive: true });
  const dateStamp = new Date().toISOString().slice(0, 10);
  const localPath = join(BACKUP_DIR, `jrbagent-creds-${dateStamp}.enc`);
  writeFileSync(localPath, encrypted, 'utf8');

  // Prune local backups older than RETENTION_DAYS
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  for (const f of readdirSync(BACKUP_DIR)) {
    if (!f.startsWith('jrbagent-creds-') || !f.endsWith('.enc')) continue;
    const full = join(BACKUP_DIR, f);
    if (statSync(full).mtimeMs < cutoff) {
      try { unlinkSync(full); } catch {}
    }
  }

  let oneDriveOk = false;
  try {
    await saveToOneDrive({ path: ONEDRIVE_PATH, content: encrypted, encoding: 'utf8', overwrite: true });
    oneDriveOk = true;
  } catch (err) {
    logger.warn('credential_backup: OneDrive upload failed', { err: err.message });
  }

  // Record the key list as the "expected" baseline for the healthcheck.
  const keyList = entries.map(e => e.name).sort();
  mkdirSync(dirname(HEALTHCHECK_STATE_FILE), { recursive: true });
  let priorState = {};
  try { priorState = JSON.parse(readFileSync(HEALTHCHECK_STATE_FILE, 'utf8')); } catch {}
  writeFileSync(HEALTHCHECK_STATE_FILE, JSON.stringify({
    ...priorState,
    expectedKeys: keyList,
    lastBackupAt: new Date().toISOString(),
    lastBackupCount: keyList.length,
  }, null, 2), 'utf8');

  logger.info('credential_backup: complete', { count: entries.length, oneDriveOk, localPath });
  return { ok: true, count: entries.length, oneDriveOk, localPath };
}

// ── Healthcheck ──────────────────────────────────────────────────

export async function runCredentialHealthcheck() {
  let state = {};
  try { state = JSON.parse(readFileSync(HEALTHCHECK_STATE_FILE, 'utf8')); } catch {}
  const expectedKeys = state.expectedKeys || [];
  if (expectedKeys.length === 0) return { ok: true, skipped: true }; // no baseline yet — first backup hasn't run

  const current = enumerateJRBCredentials().map(e => e.name);
  const currentSet = new Set(current);
  const missing = expectedKeys.filter(k => !currentSet.has(k));

  const wasAlerting = !!state.alerting;

  if (missing.length > 0) {
    logger.warn('credential_healthcheck: missing credentials detected', { missing, expectedCount: expectedKeys.length, currentCount: current.length });
    if (!wasAlerting) {
      await sendProactiveMessage(
        `🚨 Credential Manager is missing ${missing.length} of ${expectedKeys.length} expected JRBAgent:* entries: ${missing.join(', ')}. ` +
        `This matches the failure mode from the 2026-08-12 KB5121003 incident. A DPAPI-encrypted backup exists at ` +
        `${BACKUP_DIR} and on OneDrive (${ONEDRIVE_PATH}) — run the restore script to recover: ` +
        `node C:\\Users\\Assistant\\JRBAgent\\scripts\\restore-credentials.mjs --confirm`
      ).catch(() => {});
    }
    state.alerting = true;
  } else if (wasAlerting) {
    await sendProactiveMessage('✅ Credential Manager healthcheck: all expected JRBAgent:* entries are present again.').catch(() => {});
    state.alerting = false;
  }

  writeFileSync(HEALTHCHECK_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  return { ok: missing.length === 0, missing, expectedCount: expectedKeys.length, currentCount: current.length };
}

// ── Restore ──────────────────────────────────────────────────────

async function loadLatestBackupBlob() {
  // Prefer local (fastest, no network dependency) — fall back to OneDrive if
  // local is missing (e.g. the same disaster that wiped Credential Manager
  // also took the local backup directory).
  if (existsSync(BACKUP_DIR)) {
    const files = readdirSync(BACKUP_DIR).filter(f => f.startsWith('jrbagent-creds-') && f.endsWith('.enc'));
    if (files.length > 0) {
      files.sort();
      const latest = files[files.length - 1];
      return { source: `local:${latest}`, blob: readFileSync(join(BACKUP_DIR, latest), 'utf8').trim() };
    }
  }
  const { content } = await readFromOneDrive({ path: ONEDRIVE_PATH });
  return { source: `onedrive:${ONEDRIVE_PATH}`, blob: content.trim() };
}

export async function restoreCredentialsFromBackup({ dryRun = true } = {}) {
  const { source, blob } = await loadLatestBackupBlob();
  const decrypted = decryptBackup(blob);
  const data = JSON.parse(decrypted);
  const entries = data.entries || [];

  if (dryRun) {
    return {
      dryRun: true,
      source,
      savedAt: data.savedAt,
      count: entries.length,
      names: entries.map(e => e.name).sort(),
    };
  }

  const results = [];
  for (const { name, value } of entries) {
    try {
      writeCredential(name, value);
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, error: err.message });
    }
  }
  const failed = results.filter(r => !r.ok);
  logger.info('restoreCredentialsFromBackup: complete', { source, total: results.length, failed: failed.length });
  return { dryRun: false, source, savedAt: data.savedAt, total: results.length, failed };
}
