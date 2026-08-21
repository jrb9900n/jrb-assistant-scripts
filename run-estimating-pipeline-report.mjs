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

// Dynamic import keeps this truly conditional — a static `import` declaration is
// hoisted and resolved before any runtime code runs (including the guard above),
// meaning the module graph is always loaded regardless of the --run flag. A CJS
// loader or misconfigured runner that ignores the .mjs extension would silently
// execute the module body. The dynamic import here ensures the module is only
// loaded when we have confirmed the --run flag is present.
const { generateAndSendEstimatingPipelineReport } = await import('./tools/impl/estimating-pipeline-report.js');

console.log('[TEST] Generating Estimating Pipeline report...');
const result = await generateAndSendEstimatingPipelineReport();
console.log('[ESTIMATING_PIPELINE]', JSON.stringify(result));
