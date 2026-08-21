// run-ar-collections-report.mjs
// Manual test/debug script for the AR/Collections report.
//
// SAFETY GUARD: this script must not run accidentally (e.g. via `node .` or a
// misconfigured task). Pass --run explicitly to execute against live systems.
// Without that flag it exits immediately with a clear error message.
//
// Usage:
//   node run-ar-collections-report.mjs --run

const isExplicitRun = process.argv.includes('--run');

if (!isExplicitRun) {
  console.error(
    '[run-ar-collections-report] ERROR: Refusing to run without an explicit --run flag.\n' +
    'This script calls live external services (Supabase + email).\n' +
    'If you really intend to run it, use: node run-ar-collections-report.mjs --run'
  );
  process.exit(1);
}

import { generateAndSendARCollectionsReport } from './tools/impl/ar-collections-report.js';

console.log('[TEST] Generating AR/Collections report...');
const result = await generateAndSendARCollectionsReport();
console.log('[AR_COLLECTIONS]', JSON.stringify(result));
