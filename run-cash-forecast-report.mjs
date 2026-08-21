// run-cash-forecast-report.mjs
// Manual test/debug script for the 12-Week Cash Forecast report.
//
// SAFETY GUARD: this script must not run accidentally (e.g. via `node .` or a
// misconfigured task). Pass --run explicitly to execute against live systems.
// Without that flag it exits immediately with a clear error message.
//
// Usage:
//   node run-cash-forecast-report.mjs --run

const isExplicitRun = process.argv.includes('--run');

if (!isExplicitRun) {
  console.error(
    '[run-cash-forecast-report] ERROR: Refusing to run without an explicit --run flag.\n' +
    'This script calls live external services (QuickBooks + Supabase + email).\n' +
    'If you really intend to run it, use: node run-cash-forecast-report.mjs --run'
  );
  process.exit(1);
}

import { generateAndSendCashForecastReport } from './tools/impl/cash-forecast-report.js';

console.log('[TEST] Generating 12-Week Cash Forecast report...');
const result = await generateAndSendCashForecastReport();
console.log('[CASH_FORECAST]', JSON.stringify(result));
