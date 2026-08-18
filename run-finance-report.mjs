// run-finance-report.mjs
// Manual test/debug script for the audit and weekly finance report flows.
//
// SAFETY GUARD: this script must not run accidentally (e.g. via `node .` or a
// misconfigured task). Pass --run explicitly to execute against live systems.
// Without that flag it exits immediately with a clear error message.
//
// Usage:
//   node run-finance-report.mjs --run

const isExplicitRun = process.argv.includes('--run');

if (!isExplicitRun) {
  console.error(
    '[run-finance-report] ERROR: Refusing to run without an explicit --run flag.\n' +
    'This script calls live external services (audit + finance report email).\n' +
    'If you really intend to run it, use: node run-finance-report.mjs --run'
  );
  process.exit(1);
}

import { runAudit } from './tools/impl/audit.js';
import { generateAndSendWeeklyFinanceReport } from './tools/impl/weekly-finance-report.js';

console.log('[TEST] Running audit...');
await runAudit();
console.log('[TEST] Audit complete. Generating finance report...');
const result = await generateAndSendWeeklyFinanceReport({});
console.log('[FINANCE]', JSON.stringify(result));
