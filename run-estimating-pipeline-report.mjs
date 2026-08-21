// run-estimating-pipeline-report.mjs
// Manual test/debug script for the Estimating Pipeline report.
//
// SAFETY GUARD: this script must not run accidentally (e.g. via `node .` or a
// misconfigured task). Pass --run explicitly to execute against live systems.
// Without that flag it exits immediately with a clear error message.
//
// Usage:
//   node run-estimating-pipeline-report.mjs --run

const isExplicitRun = process.argv.includes('--run');

if (!isExplicitRun) {
  console.error(
    '[run-estimating-pipeline-report] ERROR: Refusing to run without an explicit --run flag.\n' +
    'This script calls live external services (Supabase + email).\n' +
    'If you really intend to run it, use: node run-estimating-pipeline-report.mjs --run'
  );
  process.exit(1);
}

import { generateAndSendEstimatingPipelineReport } from './tools/impl/estimating-pipeline-report.js';

console.log('[TEST] Generating Estimating Pipeline report...');
const result = await generateAndSendEstimatingPipelineReport();
console.log('[ESTIMATING_PIPELINE]', JSON.stringify(result));
