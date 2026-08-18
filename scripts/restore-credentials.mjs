#!/usr/bin/env node
// scripts/restore-credentials.mjs — restore JRBAgent:* Credential Manager entries
// from the encrypted backup written by tools/impl/credential-backup.js.
//
// Usage:
//   node scripts/restore-credentials.mjs              (dry run - lists what would be restored)
//   node scripts/restore-credentials.mjs --confirm    (actually writes to Credential Manager)
//
// Never prints credential values - only names, counts, and pass/fail status.

import 'dotenv/config';
import { restoreCredentialsFromBackup } from '../tools/impl/credential-backup.js';

const confirm = process.argv.includes('--confirm');

const result = await restoreCredentialsFromBackup({ dryRun: !confirm });

if (result.dryRun) {
  console.log(`Backup source: ${result.source}`);
  console.log(`Backup saved at: ${result.savedAt}`);
  console.log(`Entries found: ${result.count}`);
  console.log('Keys:');
  for (const name of result.names) console.log(`  - ${name}`);
  console.log('\nThis was a dry run - nothing was written. Re-run with --confirm to restore for real.');
} else {
  console.log(`Backup source: ${result.source}`);
  console.log(`Backup saved at: ${result.savedAt}`);
  console.log(`Restored: ${result.total - result.failed.length} / ${result.total}`);
  if (result.failed.length > 0) {
    console.log('Failed:');
    for (const f of result.failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exitCode = 1;
  } else {
    console.log('All credentials restored successfully.');
  }
}
