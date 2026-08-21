// run-ap-report.mjs
// Manual test/debug script for the Accounts Payable report.
//
// SAFETY GUARD: this script must not run accidentally (e.g. via `node .` or a
// misconfigured task). Pass --run explicitly to execute against live systems.
// Without that flag it exits immediately with a clear error message.
//
// Usage:
//   node run-ap-report.mjs --run

const isExplicitRun = process.argv.includes('--run');

if (!isExplicitRun) {
  console.error(
    '[run-ap-report] ERROR: Refusing to run without an explicit --run flag.\n' +
    'This script calls live external services (QuickBooks Online + email).\n' +
    'If you really intend to run it, use: node run-ap-report.mjs --run'
  );
  process.exit(1);
}

// Dynamic import so the module (and its transitive dependencies — QBO auth,
// email credentials, etc.) is only loaded when --run is explicitly passed.
// A static top-level import is hoisted and evaluated before any code runs,
// which means it would fire unconditionally regardless of the guard above.
const { generateAndSendAPReport } = await import('./tools/impl/ap-report.js');

console.log('[TEST] Generating Accounts Payable report...');
const result = await generateAndSendAPReport();
console.log('[AP_REPORT]', JSON.stringify(result));
