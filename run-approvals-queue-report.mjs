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

// Dynamic import ensures module-level side effects (Supabase client init,
// credential loading, etc.) only occur when --run is explicitly passed.
// A static import would be hoisted and execute those side effects before
// the guard above runs, defeating the safety check.
const { generateAndSendApprovalsQueueReport } = await import('./tools/impl/approvals-queue-report.js');

console.log('[TEST] Generating Approvals Queue report...');
const result = await generateAndSendApprovalsQueueReport();
console.log('[APPROVALS_QUEUE]', JSON.stringify(result));
