// run-marketing-performance-report.mjs
// Manual test/debug script for the Marketing Performance report.
//
// SAFETY GUARD: this script must not run accidentally (e.g. via `node .` or a
// misconfigured task). Pass --run explicitly to execute against live systems.
// Without that flag it exits immediately with a clear error message.
//
// Usage:
//   node run-marketing-performance-report.mjs --run

const isExplicitRun = process.argv.includes('--run');

if (!isExplicitRun) {
  console.error(
    '[run-marketing-performance-report] ERROR: Refusing to run without an explicit --run flag.\n' +
    'This script calls live external services (Google Ads via a Python subprocess, Supabase, and email).\n' +
    'If you really intend to run it, use: node run-marketing-performance-report.mjs --run'
  );
  process.exit(1);
}

import { generateAndSendMarketingPerformanceReport } from './tools/impl/marketing-performance-report.js';

console.log('[TEST] Generating Marketing Performance report...');
const result = await generateAndSendMarketingPerformanceReport();
console.log('[MARKETING_PERFORMANCE]', JSON.stringify(result));
