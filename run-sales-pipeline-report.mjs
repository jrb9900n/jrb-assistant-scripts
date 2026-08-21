// run-sales-pipeline-report.mjs
// Manual test/debug script for the Sales Pipeline / BD report.
//
// SAFETY GUARD: this script must not run accidentally (e.g. via `node .` or a
// misconfigured task). Pass --run explicitly to execute against live systems.
// Without that flag it exits immediately with a clear error message.
//
// Usage:
//   node run-sales-pipeline-report.mjs --run             (defaults to followup mode)
//   node run-sales-pipeline-report.mjs --run --mode=bd
//   node run-sales-pipeline-report.mjs --run --mode=followup

const isExplicitRun = process.argv.includes('--run');

if (!isExplicitRun) {
  console.error(
    '[run-sales-pipeline-report] ERROR: Refusing to run without an explicit --run flag.\n' +
    'This script calls live external services (Supabase + email).\n' +
    'If you really intend to run it, use: node run-sales-pipeline-report.mjs --run'
  );
  process.exit(1);
}

const modeArg = process.argv.find(a => a.startsWith('--mode='));
const mode = modeArg ? modeArg.split('=')[1] : 'followup';

// Dynamic import used intentionally: static `import` declarations are hoisted
// and evaluated at module link time, before any runtime code runs — including
// the safety guard above. Using dynamic import() here ensures the module (and
// any of its top-level side effects) is only loaded after the guard has
// confirmed --run was passed explicitly.
const { generateAndSendSalesPipelineReport } = await import('./tools/impl/sales-pipeline-report.js');

console.log(`[TEST] Generating Sales Pipeline / BD report (mode=${mode})...`);
const result = await generateAndSendSalesPipelineReport({ mode });
console.log('[SALES_PIPELINE]', JSON.stringify(result));
