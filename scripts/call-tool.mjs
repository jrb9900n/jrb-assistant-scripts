#!/usr/bin/env node
// scripts/call-tool.mjs — call any registered agent tool directly, without
// going through an LLM loop or a chat channel.
//
// Built so Claude Code sessions have the same one-call access to
// JRBAgent's tool registry that Teams and voice already get via
// dispatchTool() -- instead of each session hand-rolling its own throwaway
// probe script + PowerShell CredReader boilerplate (the pattern CLAUDE.md's
// "Bypassing the agent loop" section documents; this replaces the ad hoc
// version of it with one reusable entry point).
//
// The Credential Manager enumeration logic below is intentionally a
// self-contained copy of tools/impl/credential-backup.js's
// enumerateJRBCredentials(), not an import of it -- that module also
// (transitively, via teams/notify.js) imports memory/conversation.js, which
// constructs a Supabase client at module-load time from process.env. Since
// loading credentials IS how this script's env vars get set in the first
// place, importing that module before they exist crashes on the very first
// line of this file, before main() ever runs. A minimal, dependency-free
// copy sidesteps the ordering problem entirely rather than working around it.
//
// Runs as a full-trust Michael-identity caller, matching how the voice
// bridge's own handleFunctionCall() shapes a verified caller's context
// (teams/identity.js's resolveSender() shape) -- this is a local, already-
// autonomous Claude Code session per CLAUDE.md's Autonomy Rules, not a
// remote/untrusted channel, so it gets the same trust level dispatcher.js
// handlers like book_time_with_michael check via context.sender.isMichael.
//
// Usage:
//   node scripts/call-tool.mjs <tool_name> ['<json args>']
// Examples:
//   node scripts/call-tool.mjs sa_search_clients '{"query":"Boehlke"}'
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ENUMERATE_PS = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct CREDENTIAL_CT {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
}
public class CredEnumCT {
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool CredEnumerate(string filter, int flag, out int count, out IntPtr pCredentials);
    [DllImport("advapi32.dll")]
    public static extern void CredFree(IntPtr cred);
}
"@

$count = 0
$pCreds = [IntPtr]::Zero
$ok = [CredEnumCT]::CredEnumerate("JRBAgent:*", 0, [ref]$count, [ref]$pCreds)
if (-not $ok) { Write-Output "[]"; exit 0 }

$results = @()
for ($i = 0; $i -lt $count; $i++) {
    $credPtr = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($pCreds, $i * [IntPtr]::Size)
    $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($credPtr, [type]"CREDENTIAL_CT")
    $blob = $null
    if ($cred.CredentialBlobSize -gt 0) {
        $blob = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($cred.CredentialBlob, [int]($cred.CredentialBlobSize / 2))
    }
    $name = $cred.TargetName -replace '^JRBAgent:',''
    $results += [PSCustomObject]@{ name = $name; value = $blob }
}
[CredEnumCT]::CredFree($pCreds)
if ($results.Count -eq 1) { Write-Output "[$($results | ConvertTo-Json -Compress)]" }
else { $results | ConvertTo-Json -Compress }
`;

function loadCredentials() {
  const tmpFile = join(tmpdir(), `call-tool-creds-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  writeFileSync(tmpFile, ENUMERATE_PS, 'utf8');
  let out;
  try {
    out = execFileSync('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', tmpFile], {
      timeout: 20_000,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
  try {
    const parsed = JSON.parse(out.trim() || '[]');
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    throw new Error(`Credential Manager enumeration returned unparseable output: ${err.message}\nRaw output: ${out.slice(0, 500)}`);
  }
}

async function main() {
  const [, , toolName, argsJson] = process.argv;
  if (!toolName) {
    console.error("Usage: node scripts/call-tool.mjs <tool_name> ['<json args>']");
    process.exit(1);
  }

  for (const { name, value } of loadCredentials()) {
    if (value != null) process.env[name] = value;
  }
  // Literals start-agent.ps1 hardcodes rather than storing in Credential
  // Manager -- see launcher/start-agent.ps1 for the source of truth. Found
  // live while testing this script: SUPABASE_URL looked like a Credential
  // Manager key per CLAUDE.md's own credential list, but isn't -- the real
  // Credential Manager key is SUPABASE_JRBDB_URL/_KEY (a different project,
  // unused by this app), and SUPABASE_URL is a plain hardcoded literal here,
  // same as the other two.
  process.env.M365_USER_EMAIL ??= 'assistant@jrboehlke.com';
  process.env.SUPABASE_URL ??= 'https://znpahinyplccdyoekfeo.supabase.co';
  process.env.FLEETOPS_SUPABASE_URL ??= 'https://mzywmgesulyalevtzudw.supabase.co';

  let input = {};
  if (argsJson) {
    try {
      input = JSON.parse(argsJson);
    } catch (err) {
      console.error(`Malformed JSON args: ${err.message}`);
      process.exit(1);
    }
  }

  // Dynamic import, AFTER env vars are set -- dispatcher.js's own import
  // graph reaches modules (memory/conversation.js among them) that construct
  // clients from process.env at module-load time; a static top-of-file
  // import would hit the same ordering problem this file's header explains.
  const { dispatchTool } = await import('../tools/dispatcher.js');

  try {
    const result = await dispatchTool(toolName, input, {
      sender: { isMichael: true, aadId: null, name: 'Michael Reardon', email: 'michael@jrboehlke.com', employeeId: null },
      source: 'claude-code-cli',
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`Tool call failed: ${err.message}`);
    process.exit(1);
  }
}

main();
