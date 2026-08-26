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

  // Marketing agent skills (built 2026-08-25) — two distinct, human-gated
  // steps, deliberately never auto-chained. See tools/impl/marketing-segments.js
  // for the methodology and the real bugs this encodes fixes for.
  {
    name: 'identify-reengagement-segment',
    description: 'Read-only: identify a client re-engagement segment for a service category and present it for review. Makes no writes to SA or Supabase.',
    taskType: 'marketing',
    tags: ['marketing', 'segmentation', 'crm'],
    defaultVars: { RECENCY_THRESHOLD_DAYS: '365', EXCLUDE_CURRENT_YEAR_ESTIMATES: 'true' },
    task: `
Call identify_marketing_segment with serviceCategory "{{SERVICE_CATEGORY}}", recencyThresholdDays {{RECENCY_THRESHOLD_DAYS}}, and excludeCurrentYearEstimates {{EXCLUDE_CURRENT_YEAR_ESTIMATES}}.

Do NOT reimplement this logic yourself by querying SA/Supabase data directly and reasoning about recency or name-matching freehand — identify_marketing_segment already encodes fixes for three real bugs found doing exactly that (a binary-cutoff recency check that hid a $1.2M account, a name normalizer that collapsed a client's distinct properties into false matches, and a missing current-year-estimate cross-check that would have double-marketed to an already-served client). Always call the tool.

Before reporting anything, call list_marketing_campaigns to check whether a campaign already exists for this service category recently (status applied or completed within the last few months) — if so, say so and ask whether Michael still wants a new one rather than assuming.

Then present: how many clean candidates were found, how many were flagged for review and why (subcontractor/GC-looking name, roster collision, or no live SA match — list a few examples of each, don't just give counts), and how many were excluded because they already have a current-year estimate (list a few examples). Do not tag anyone or draft anything — this skill only identifies and reports. Stop after presenting the summary and wait for Michael's decision on which candidates to proceed with.
    `.trim(),
  },

  {
    name: 'apply-reengagement-campaign',
    description: 'Write path: tag an approved client list in SA, log the campaign, and draft (never send) re-engagement emails. Only ever run after Michael has approved a specific candidate list from identify-reengagement-segment — never run on its own against an unreviewed segment.',
    taskType: 'marketing',
    tags: ['marketing', 'campaign', 'crm'],
    task: `
Michael has approved the following clients for the "{{CAMPAIGN_NAME}}" campaign targeting {{SERVICE_CATEGORY}}: {{APPROVED_CLIENT_IDS}}.

Steps, in order:
1. Call sa_find_or_create_tag_category with name "Marketing Campaign" (reuses the category if it already exists).
2. Call sa_find_or_create_tag with name "{{CAMPAIGN_TAG_NAME}}" under that category.
3. For each approved client, call sa_add_tag_to_client with that tag.
4. Call create_marketing_campaign with campaignName "{{CAMPAIGN_NAME}}", description "{{CAMPAIGN_DESCRIPTION}}", saTagNames ["{{CAMPAIGN_TAG_NAME}}"], saTagCategory "Marketing Campaign", and clientCount set to how many clients were actually tagged (not the count originally proposed, if any failed).
5. Call get_marketing_business_context and use it to ground the email's tone, positioning, and any relevant seasonal framing.
6. Draft (via draft_email — never send_email, which isn't available in this taskType anyway) a re-engagement email. Save the draft to michael@jrboehlke.com's own inbox for his review — do NOT address it to the actual clients yet; that happens only when Michael sends it himself after review, the same pattern used for prior campaigns this account.

Report back: how many clients were successfully tagged (and any that failed, with why), the campaign's id from create_marketing_campaign, and where the draft landed.
    `.trim(),
  },

];

for (const skill of SKILLS) {
  await saveSkill(skill);
  console.log(`✓ ${skill.name}`);
}
console.log(`\n${SKILLS.length} skills seeded.`);
