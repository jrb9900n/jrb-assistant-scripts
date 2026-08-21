// run-weekly-scorecard-report.mjs
// Manual test/debug script for the Weekly Business Scorecard report.
//
// SAFETY GUARD: this script must not run accidentally (e.g. via `node .` or a
// misconfigured task). Pass --run explicitly to execute against live systems.
// Without that flag it exits immediately with a clear error message.
//
// Usage:
//   node run-weekly-scorecard-report.mjs --run

const isExplicitRun = process.argv.includes('--run');

if (!isExplicitRun) {
  console.error(
    '[run-weekly-scorecard-report] ERROR: Refusing to run without an explicit --run flag.\n' +
    'This script calls live external services (Supabase, QuickBooks + email).\n' +
    'If you really intend to run it, use: node run-weekly-scorecard-report.mjs --run'
  );
  process.exit(1);
}

import { generateAndSendWeeklyScorecardReport } from './tools/impl/weekly-scorecard-report.js';

console.log('[TEST] Generating Weekly Business Scorecard report...');
const result = await generateAndSendWeeklyScorecardReport();
console.log('[WEEKLY_SCORECARD]', JSON.stringify(result));
