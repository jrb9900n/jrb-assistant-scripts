// run-field-briefing-report.mjs
// Manual test/debug script for the Field / Client Meetings Briefing.
//
// SAFETY GUARD: this script must not run accidentally (e.g. via `node .` or a
// misconfigured task). Pass --run explicitly to execute against live systems.
// Without that flag it exits immediately with a clear error message.
//
// Usage:
//   node run-field-briefing-report.mjs --run
//   node run-field-briefing-report.mjs --run --date=2026-08-25
//
// --date is an optional YYYY-MM-DD override so this can be tested against a
// day known to have real Field/Client Meetings appointments, instead of
// whatever "today" happens to be. The production cron tasks (scheduler/cron.js)
// never pass this — they always use the real current date.

const isExplicitRun = process.argv.includes('--run');

if (!isExplicitRun) {
  console.error(
    '[run-field-briefing-report] ERROR: Refusing to run without an explicit --run flag.\n' +
    'This script calls live external services (Microsoft Graph calendar + Supabase + email).\n' +
    'If you really intend to run it, use: node run-field-briefing-report.mjs --run\n' +
    'Optionally add --date=YYYY-MM-DD to test against a specific day.'
  );
  process.exit(1);
}

const dateArg = process.argv.find(a => a.startsWith('--date='));
const date = dateArg ? dateArg.slice('--date='.length) : undefined;
if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error(`[run-field-briefing-report] ERROR: --date must be YYYY-MM-DD, got "${date}"`);
  process.exit(1);
}

import { generateAndSendFieldBriefing } from './tools/impl/field-briefing-report.js';

console.log(`[TEST] Generating Field/Client Meetings briefing... ${date ? `(date override: ${date})` : '(today)'}`);
const result = await generateAndSendFieldBriefing({ date });
console.log('[FIELD_BRIEFING]', JSON.stringify(result));
