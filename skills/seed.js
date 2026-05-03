// skills/seed.js — Pre-built skills for J.R. Boehlke, LLC
// Run once: node skills/seed.js

import 'dotenv/config';
import { saveSkill } from './library.js';

const SKILLS = [

  {
    name: 'daily-email-digest',
    description: 'Triage inbox from the last 24h and save a summary to OneDrive.',
    taskType: 'email',
    tags: ['email', 'daily'],
    defaultVars: { HOURS: '24', OUTPUT_FOLDER: '/Agent Reports/Email Digests' },
    task: `
List unread emails from the past {{HOURS}} hours.
Group them by urgency: URGENT (reply today), PENDING (reply this week), FYI (no reply needed).
For URGENT emails, draft a brief reply or note the required action.
Produce a concise summary readable in under 2 minutes.
Save to OneDrive at {{OUTPUT_FOLDER}}/{{DATE}}.md where DATE is today's date YYYY-MM-DD.
    `.trim(),
  },

  {
    name: 'weekly-crm-report',
    description: 'HubSpot pipeline + QB invoices rolled into an executive summary.',
    taskType: 'report',
    tags: ['crm', 'weekly'],
    defaultVars: { OUTPUT_FOLDER: '/Agent Reports/Weekly CRM' },
    task: `
Pull HubSpot deals data for this week.
Identify: new deals opened, stage progressions, deals at risk (no activity > 7 days), closed won/lost.
Pull QuickBooks: outstanding invoices, payments received this week, AR aging.
Write an executive summary: headline metrics, 3-5 action items, deals needing attention.
Save to OneDrive at {{OUTPUT_FOLDER}}/{{YEAR_WEEK}}.md where YEAR_WEEK is e.g. 2025-W23.
    `.trim(),
  },

  {
    name: 'invoice-aging-check',
    description: 'Find overdue invoices and prepare draft reminder emails.',
    taskType: 'crm',
    tags: ['finance', 'invoices'],
    defaultVars: { DAYS_OVERDUE: '14' },
    task: `
Query QuickBooks for all open invoices with Balance > 0.
Flag invoices where DueDate is more than {{DAYS_OVERDUE}} days ago.
For each flagged invoice, draft a polite payment reminder email to the customer.
Save all drafts to M365 Drafts — do NOT send.
Return a summary list: customer name, invoice number, amount, days overdue.
    `.trim(),
  },

  {
    name: 'playwright-run',
    description: 'Run a named Playwright script and report results.',
    taskType: 'code',
    tags: ['automation', 'playwright'],
    defaultVars: { SCRIPT_PATH: './scripts/playwright/', TIMEOUT_MS: '60000' },
    task: `
Run the Playwright script at {{SCRIPT_PATH}}{{SCRIPT_NAME}}.js with timeout {{TIMEOUT_MS}}ms.
Report: success/failure, any errors, key output data.
If it fails, diagnose the error and suggest a fix.
If it succeeds, save the output to OneDrive at /Agent Reports/Playwright/{{SCRIPT_NAME}}-{{DATE}}.json.
    `.trim(),
  },

  {
    name: 'new-script',
    description: 'Write a new script, save locally, and push to GitHub.',
    taskType: 'code',
    tags: ['code'],
    defaultVars: { LANGUAGE: 'node', GITHUB_REPO: 'scripts' },
    task: `
Write a {{LANGUAGE}} script that: {{DESCRIPTION}}
Save it to ./scripts/{{FILENAME}}.
Push it to GitHub repo {{GITHUB_REPO}} at scripts/{{FILENAME}} with a descriptive commit message.
After pushing, confirm the file is accessible and describe how to run it.
    `.trim(),
  },

  {
    name: 'onedrive-save',
    description: 'Save content or a generated file to a specific OneDrive path.',
    taskType: 'file',
    tags: ['file', 'onedrive'],
    defaultVars: { FOLDER: '/Agent Reports' },
    task: `
Save the following content to OneDrive at {{FOLDER}}/{{FILENAME}}:

{{CONTENT}}

Do not overwrite if the file already exists — use a timestamp suffix if needed.
Confirm the save was successful and return the final path.
    `.trim(),
  },

];

for (const skill of SKILLS) {
  await saveSkill(skill);
  console.log(`✓ ${skill.name}`);
}
console.log(`\n${SKILLS.length} skills seeded.`);
