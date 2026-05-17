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
import { spawn } from 'child_process';
import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';

const supabase = createClient(
  process.env.FLEETOPS_SUPABASE_URL,
  process.env.FLEETOPS_SUPABASE_SERVICE_KEY
);

// Michael's rebate mailing info — set these in Credential Manager / env
const OWNER_INFO = {
  firstName: process.env.MENARDS_REBATE_FIRST_NAME || 'Michael',
  lastName:  process.env.MENARDS_REBATE_LAST_NAME  || 'Reardon',
  address1:  process.env.MENARDS_REBATE_ADDRESS1   || '',
  address2:  process.env.MENARDS_REBATE_ADDRESS2   || '',
  city:      process.env.MENARDS_REBATE_CITY       || '',
  state:     process.env.MENARDS_REBATE_STATE      || 'WI',
  zip:       process.env.MENARDS_REBATE_ZIP        || '',
  phone:     process.env.MENARDS_REBATE_PHONE      || '',
  email:     process.env.MENARDS_REBATE_EMAIL      || 'michael@jrboehlke.com',
};

const REBATE_URL   = 'https://www.menards.com/main/rebate-form.html';
const PDF_DIR      = 'C:\\Users\\Assistant\\logs\\';
const EDGE_PATH    = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CHROME_PATH  = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// ── Public API ─────────────────────────────────────────────────

export async function triggerMenardsRebate(expenseReportId) {
  // Create a tracking record
  const { data: rebate, error: insErr } = await supabase
    .from('menards_rebates')
    .insert({ expense_report_id: expenseReportId, status: 'pending' })
    .select()
    .single();
  if (insErr) { logger.error('Failed to create menards_rebates row', { err: insErr.message }); return; }

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

// ── Core: fill form, save PDF, print ──────────────────────────

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

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  try {
    await page.goto(REBATE_URL, { waitUntil: 'networkidle2', timeout: 30_000 });

    // Fill the form — selectors reflect the Menards rebate form as of 2026-05.
    // If the page structure changes, update the CSS selectors here.
    await fillField(page, '#firstName, input[name="firstName"], input[placeholder*="First"]', OWNER_INFO.firstName);
    await fillField(page, '#lastName, input[name="lastName"], input[placeholder*="Last"]',   OWNER_INFO.lastName);
    await fillField(page, '#address1, input[name="address1"], input[placeholder*="Address"]', OWNER_INFO.address1);
    await fillField(page, '#address2, input[name="address2"]',                               OWNER_INFO.address2);
    await fillField(page, '#city, input[name="city"]',                                       OWNER_INFO.city);
    await fillField(page, '#zip, input[name="zip"], input[name="zipCode"]',                  OWNER_INFO.zip);
    await fillField(page, '#phone, input[name="phone"], input[type="tel"]',                  OWNER_INFO.phone);
    await fillField(page, '#email, input[name="email"], input[type="email"]',                OWNER_INFO.email);

    // Purchase details from QBO
    const purchaseDate = expense.transaction_date || '';
    const amount = expense.amount ? String(Number(expense.amount).toFixed(2)) : '';
    await fillField(page, '#purchaseDate, input[name="purchaseDate"]', purchaseDate);
    await fillField(page, '#purchaseAmount, input[name="purchaseAmount"], input[name="amount"]', amount);

    // State dropdown (try select, fall back to text)
    try {
      await page.select('#state, select[name="state"]', OWNER_INFO.state);
    } catch { /* not a select element on this page version */ }

    // Give JS validators a moment to settle
    await new Promise(r => setTimeout(r, 800));

    // Save as PDF
    if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });
    const ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const pdfPath = path.join(PDF_DIR, `menards-rebate-${ts}.pdf`);
    await page.pdf({ path: pdfPath, format: 'Letter', printBackground: true, margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' } });

    // Print to default Windows printer
    await printPdf(pdfPath);

    return pdfPath;
  } finally {
    await browser.close();
  }
}

// ── Helpers ────────────────────────────────────────────────────

async function fillField(page, selector, value) {
  if (!value) return;
  try {
    await page.waitForSelector(selector, { timeout: 3_000 });
    await page.$eval(selector, (el, v) => {
      el.focus();
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  } catch {
    // Field not found on this page version — log but continue
    logger.warn('Menards rebate: field not found', { selector });
  }
}

function printPdf(pdfPath) {
  return new Promise((resolve, reject) => {
    // Windows: send to default printer via shell association
    const ps = spawn('powershell', [
      '-NonInteractive', '-Command',
      `Start-Process -FilePath "${pdfPath}" -Verb Print -PassThru | Out-Null`,
    ]);
    let stderr = '';
    ps.stderr.on('data', d => stderr += d.toString());
    ps.on('close', code => {
      if (code !== 0) reject(new Error(`Print command exited ${code}: ${stderr}`));
      else resolve();
    });
    // Give print spool time to receive the job
    setTimeout(resolve, 5000);
  });
}
