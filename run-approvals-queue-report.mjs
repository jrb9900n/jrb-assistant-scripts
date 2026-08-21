// run-approvals-queue-report.mjs
// Manual test/debug script for the Approvals Queue report.
//
// SAFETY GUARD: this script must not run accidentally (e.g. via `node .` or a
// misconfigured task). Pass --run explicitly to execute against live systems.
// Without that flag it exits immediately with a clear error message.
//
// Usage:
//   node run-approvals-queue-report.mjs --run

const isExplicitRun = process.argv.includes('--run');

if (!isExplicitRun) {
  console.error(
    '[run-approvals-queue-report] ERROR: Refusing to run without an explicit --run flag.\n' +
    'This script calls live external services (Supabase + email).\n' +
    'If you really intend to run it, use: node run-approvals-queue-report.mjs --run'
  );
  process.exit(1);
}

import { generateAndSendApprovalsQueueReport } from './tools/impl/approvals-queue-report.js';

console.log('[TEST] Generating Approvals Queue report...');
const result = await generateAndSendApprovalsQueueReport();
console.log('[APPROVALS_QUEUE]', JSON.stringify(result));
