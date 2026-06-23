// tools/impl/menards.js — Menards rebate form automation
// Uses puppeteer-core with the system Edge browser (no Chromium download).
// After filling the rebate form, saves to PDF and sends to the default printer.
//
// NOTE: Form field selectors were written against the Menards rebate page
// structure as of 2026-05. Run triggerMenardsRebate() on a test charge and
// check C:\Users\Assistant\logs\menards-rebate-*.pdf to verify the output
// before relying on it. Adjust selectors in FORM_FIELDS if Menards updates
// their site.

import path from 'path';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';
import { sendEmail } from './m365.js';

const supabase = createClient(
  process.env.FLEETOPS_SUPABASE_URL,
  process.env.FLEETOPS_SUPABASE_SERVICE_KEY
);

// Michael's rebate mailing info — override via env vars if needed, otherwise uses JRB mailing address
const OWNER_INFO = {
  firstName: process.env.MENARDS_REBATE_FIRST_NAME || 'Michael',
  lastName:  process.env.MENARDS_REBATE_LAST_NAME  || 'Reardon',
  address1:  process.env.MENARDS_REBATE_ADDRESS1   || 'PO Box 105',
  address2:  process.env.MENARDS_REBATE_ADDRESS2   || '',
  city:      process.env.MENARDS_REBATE_CITY       || 'Mequon',
  state:     process.env.MENARDS_REBATE_STATE      || 'WI',
  zip:       process.env.MENARDS_REBATE_ZIP        || '53092',
  phone:     process.env.MENARDS_REBATE_PHONE      || '2622429924',
  email:     process.env.MENARDS_REBATE_EMAIL      || 'michael@jrboehlke.com',
};

const PDF_DIR      = 'C:\\Users\\Assistant\\logs\\';
const EDGE_PATH    = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CHROME_PATH  = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// ── Public API ─────────────────────────────────────────────────

export async function triggerMenardsRebate(expenseReportId) {
  // Dedup: skip if a rebate was already triggered (e.g. Chase alert path fired
  // then portal submission also fired for the same expense report)
  const { data: existing, error: dedupErr } = await supabase
    .from('menards_rebates')
    .select('id, status')
    .eq('expense_report_id', expenseReportId)
    .maybeSingle();
  if (dedupErr) {
    logger.warn('Menards rebate dedup check failed — proceeding with insert', { expenseReportId, err: dedupErr.message });
  } else if (existing) {
    logger.info('Menards rebate already exists for this expense report, skipping', { expenseReportId, status: existing.status });
    return;
  }

  // Create a tracking record
  const { data: rebate, error: insErr } = await supabase
    .from('menards_rebates')
    .insert({ expense_report_id: expenseReportId, status: 'pending' })
    .select()
    .single();
  if (insErr) {
    if (insErr.code === '23505') {
      // Unique constraint violation — concurrent trigger already created this row
      logger.info('Menards rebate concurrent insert detected, skipping', { expenseReportId });
      return;
    }
    logger.error('Failed to create menards_rebates row', { err: insErr.message });
    return;
  }

  // Fetch expense details
  const { data: expense } = await supabase
    .from('expense_reports')
    .select('*')
    .eq('id', expenseReportId)
    .single();
  if (!expense) { logger.error('Expense report not found for Menards rebate', { expenseReportId }); return; }

  try {
    const pdfPath = await fillAndPrintRebateForm(expense);
    await supabase
      .from('menards_rebates')
      .update({ pdf_path: pdfPath, printed_at: new Date().toISOString(), status: 'printed' })
      .eq('id', rebate.id);
    logger.info('Menards rebate completed', { expenseReportId, pdfPath });
  } catch (err) {
    await supabase
      .from('menards_rebates')
      .update({ status: 'error', error_message: err.message })
      .eq('id', rebate.id);
    logger.error('Menards rebate failed', { expenseReportId, err: err.message });
  }
}

// ── Core: generate rebate PDF locally and email it ────────────
// The Menards rebate form website (menards.com/rebate-form.html) blocks headless
// browsers with Incapsula/hCaptcha. We generate a clean local PDF instead —
// same data, ready for Michael to submit at menards.com/rebate-center or
// print + attach the receipt + mail.

async function fillAndPrintRebateForm(expense) {
  let puppeteer;
  try {
    puppeteer = (await import('puppeteer-core')).default;
  } catch {
    throw new Error('puppeteer-core not installed. Run: npm install puppeteer-core --prefix C:\\Users\\Assistant\\JRBAgent\\agent');
  }

  const executablePath = fs.existsSync(EDGE_PATH)   ? EDGE_PATH
    : fs.existsSync(CHROME_PATH) ? CHROME_PATH
    : null;
  if (!executablePath) throw new Error('No Chrome or Edge browser found on this machine');

  const amount      = Number(expense.amount || 0).toFixed(2);
  const vendor      = expense.vendor || 'Menards';
  const date        = expense.transaction_date || new Date().toISOString().slice(0, 10);
  const phoneFormatted = OWNER_INFO.phone
    ? `(${OWNER_INFO.phone.slice(0,3)}) ${OWNER_INFO.phone.slice(3,6)}-${OWNER_INFO.phone.slice(6)}`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: Arial, sans-serif; font-size: 12pt; color: #111; margin: 0; padding: 0; }
  .page { padding: 0.5in; max-width: 7.5in; }
  h1 { font-size: 18pt; color: #c8102e; margin: 0 0 4px 0; }
  h2 { font-size: 12pt; color: #333; border-bottom: 1px solid #c8102e; padding-bottom: 4px; margin: 20px 0 10px 0; }
  .logo-bar { display: flex; align-items: center; margin-bottom: 18px; border-bottom: 3px solid #c8102e; padding-bottom: 12px; }
  .logo-bar h1 { margin: 0; }
  .logo-bar .tag { font-size: 9pt; color: #666; margin-left: 12px; margin-top: 2px; }
  table.fields { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  table.fields td { padding: 6px 8px; vertical-align: top; }
  table.fields td.label { width: 160px; font-weight: bold; color: #444; white-space: nowrap; }
  table.fields td.value { border-bottom: 1px solid #ccc; min-width: 200px; }
  .instructions { background: #f9f9f9; border: 1px solid #ddd; border-radius: 4px; padding: 12px 16px; margin-top: 20px; font-size: 10pt; }
  .instructions p { margin: 6px 0; }
  .instructions strong { color: #c8102e; }
  .footer { font-size: 8pt; color: #999; margin-top: 30px; border-top: 1px solid #eee; padding-top: 8px; }
  .highlight { background: #fffbe6; border: 1px solid #f0d000; border-radius: 3px; padding: 2px 6px; }
</style>
</head>
<body>
<div class="page">
  <div class="logo-bar">
    <h1>Menards&reg; Rebate Submission</h1>
    <span class="tag">Generated by JRB Assistant &mdash; ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
  </div>

  <h2>Mailing Address (Rebate Check Recipient)</h2>
  <table class="fields">
    <tr><td class="label">Name</td><td class="value">${OWNER_INFO.firstName} ${OWNER_INFO.lastName}</td></tr>
    <tr><td class="label">Address</td><td class="value">${OWNER_INFO.address1}${OWNER_INFO.address2 ? ', ' + OWNER_INFO.address2 : ''}</td></tr>
    <tr><td class="label">City, State ZIP</td><td class="value">${OWNER_INFO.city}, ${OWNER_INFO.state} ${OWNER_INFO.zip}</td></tr>
    <tr><td class="label">Phone</td><td class="value">${phoneFormatted}</td></tr>
    <tr><td class="label">Email</td><td class="value">${OWNER_INFO.email}</td></tr>
  </table>

  <h2>Purchase Details</h2>
  <table class="fields">
    <tr><td class="label">Store / Vendor</td><td class="value">${vendor}</td></tr>
    <tr><td class="label">Purchase Date</td><td class="value">${date}</td></tr>
    <tr><td class="label">Total Amount</td><td class="value"><span class="highlight"><strong>$${amount}</strong></span></td></tr>
  </table>

  <div class="instructions">
    <p><strong>How to submit your Menards rebate:</strong></p>
    <p>&#9312; &nbsp; Go to <strong>www.menards.com/rebate-center</strong> and submit online using the information above.</p>
    <p>&#9313; &nbsp; <em>Or</em> print this form, attach the <strong>original receipt</strong>, and mail to the address on your Menards rebate form.</p>
    <p>&nbsp;</p>
    <p>The rebate check will be mailed to: <strong>${OWNER_INFO.firstName} ${OWNER_INFO.lastName}, ${OWNER_INFO.address1}, ${OWNER_INFO.city} ${OWNER_INFO.state} ${OWNER_INFO.zip}</strong></p>
  </div>

  <div class="footer">
    Auto-generated from Chase alert &mdash; Expense Report for card ending in ${expense.card_last_four || 'XXXX'} &mdash; Amount: $${amount} &mdash; Vendor: ${vendor}
  </div>
</div>
</body>
</html>`;

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });

  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });

    if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });
    const ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const pdfPath = path.join(PDF_DIR, `menards-rebate-${ts}.pdf`);
    await page.pdf({ path: pdfPath, format: 'Letter', printBackground: true, margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' } });

    const pdfBuffer = fs.readFileSync(pdfPath);
    const fileName  = path.basename(pdfPath);
    await sendEmail({
      to: ['michael@jrboehlke.com'],
      subject: `Menards Rebate — ${vendor} $${amount} (${date})`,
      body: `<p>Menards rebate submission document for the <strong>$${amount}</strong> charge at <strong>${vendor}</strong> on ${date}.</p>
<p>To submit your rebate:</p>
<ol>
  <li>Submit online at <a href="https://www.menards.com/rebate-center">www.menards.com/rebate-center</a> using the information in the attached PDF.</li>
  <li><em>Or</em> print the attached PDF, attach the original receipt, and mail it in.</li>
</ol>
<p>The rebate check will be sent to: <strong>${OWNER_INFO.firstName} ${OWNER_INFO.lastName}, ${OWNER_INFO.address1}, ${OWNER_INFO.city} ${OWNER_INFO.state} ${OWNER_INFO.zip}</strong></p>
<p><em>— JRB Assistant</em></p>`,
      attachments: [{ name: fileName, contentType: 'application/pdf', content: pdfBuffer }],
    });

    return pdfPath;
  } finally {
    await browser.close();
  }
}


