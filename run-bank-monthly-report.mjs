// run-bank-monthly-report.mjs
// Manual test/debug script for the Monthly Bank AR/AP Report.
//
// SAFETY GUARD: this script must not run accidentally (e.g. via `node .` or a
// misconfigured task). Pass --run explicitly to execute against live systems.
// Without that flag it exits immediately with a clear error message.
//
// Usage:
//   node run-bank-monthly-report.mjs --run
//   node run-bank-monthly-report.mjs --run --asof=2026-07-31   (override the
//     as-of date instead of using last month's end — useful for testing
//     against a specific historical closing date without waiting for the
//     real calendar to catch up)

const isExplicitRun = process.argv.includes('--run');

if (!isExplicitRun) {
  console.error(
    '[run-bank-monthly-report] ERROR: Refusing to run without an explicit --run flag.\n' +
    'This script calls live external services (QuickBooks + email).\n' +
    'If you really intend to run it, use: node run-bank-monthly-report.mjs --run'
  );
  process.exit(1);
}

const asOfArg = process.argv.find(a => a.startsWith('--asof='));
const asOfDate = asOfArg ? asOfArg.split('=')[1] : undefined;

import { generateAndSendBankMonthlyReport } from './tools/impl/bank-monthly-report.js';

console.log('[TEST] Generating Monthly Bank Report...', asOfDate ? `(as of ${asOfDate})` : '(as of last month end)');
const result = await generateAndSendBankMonthlyReport(asOfDate ? { asOfDate } : {});
console.log('[BANK_MONTHLY_REPORT]', JSON.stringify(result));
