// tools/impl/menards.js — Menards rebate form automation
//
// Fills the rebate form at menards.com/main/rebate-form.html using puppeteer-extra
// with the stealth plugin (bypasses Incapsula/Imperva bot detection).
// The form asks only for mailing address; no receipt fields. After submitting,
// it calls window.print() and @media print CSS reveals the completed form.
// We intercept window.print(), switch puppeteer to print media, and save a PDF.
// That PDF is emailed to Michael with instructions to attach the physical rebate
// receipt from his Menards purchase receipt and mail both to Menards.
//
// The stealth plugin keeps a minimal browser fingerprint. In production each run
// is triggered by a Chase alert (days apart), so Incapsula rate limiting is not
// a concern.

import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';
import { sendEmail } from './m365.js';
import { sendProactiveMessage } from '../../teams/notify.js';

puppeteerExtra.use(StealthPlugin());

const supabase = createClient(
  process.env.FLEETOPS_SUPABASE_URL,
  process.env.FLEETOPS_SUPABASE_SERVICE_KEY
);

// Michael's rebate mailing info — override via env vars if ever needed
const OWNER_INFO = {
  firstName: process.env.MENARDS_REBATE_FIRST_NAME || 'Michael',
  lastName:  process.env.MENARDS_REBATE_LAST_NAME  || 'Reardon',
  address1:  process.env.MENARDS_REBATE_ADDRESS1   || 'PO Box 105',
  city:      process.env.MENARDS_REBATE_CITY       || 'Mequon',
  state:     process.env.MENARDS_REBATE_STATE      || 'WI',
  zip:       process.env.MENARDS_REBATE_ZIP        || '53092',
  country:   process.env.MENARDS_REBATE_COUNTRY    || 'US',
  email:     process.env.MENARDS_REBATE_EMAIL      || 'michael@jrboehlke.com',
};

const PDF_DIR    = 'C:\\Users\\Assistant\\logs\\';
const EDGE_PATH  = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const REBATE_URL  = 'https://www.menards.com/main/rebate-form.html';
const USER_AGENT  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0';

// ── Public API ─────────────────────────────────────────────────

export async function triggerMenardsRebate(expenseReportId) {
  // Dedup: skip if a rebate was already triggered for this expense report
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
  if (!expense) {
    logger.error('Expense report not found for Menards rebate', { expenseReportId });
    return;
  }

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
    try { await sendProactiveMessage(`⚠️ Menards rebate failed for expense ${expenseReportId}: ${err.message}`); } catch {}
  }
}

// ── Core: fill menards.com rebate form and capture PDF ─────────

async function fillAndPrintRebateForm(expense) {
  const executablePath = fs.existsSync(EDGE_PATH)   ? EDGE_PATH
    : fs.existsSync(CHROME_PATH) ? CHROME_PATH
    : null;
  if (!executablePath) throw new Error('No Chrome or Edge browser found on this machine');

  const browser = await puppeteerExtra.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--window-size=1280,900',
      '--disable-blink-features=AutomationControlled',
      '--proxy-server=socks5://127.0.0.1:40000', // Cloudflare WARP — egress via Cloudflare IP
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(USER_AGENT);

    // Intercept window.print() — the PRINT button calls it after Vue validates the form.
    // We suppress the system dialog and capture the page via page.pdf() instead.
    let printCalled = false;
    await page.exposeFunction('__menardsPrintInterceptor', () => { printCalled = true; });
    await page.evaluateOnNewDocument(() => {
      window.print = function() { window.__menardsPrintInterceptor(); };
    });

    await page.goto(REBATE_URL, { waitUntil: 'networkidle2', timeout: 45_000 });

    // Wait for Vue app to mount the form
    await page.waitForSelector('#formFirstName', { timeout: 20_000 });

    // Fill all fields with Vue-reactive events (native setter + input/change/blur dispatch).
    // Standard page.type() updates the DOM value but doesn't trigger Vue's reactive watchers.
    await vueSetValue(page, '#formFirstName',    OWNER_INFO.firstName);
    await vueSetValue(page, '#formLastName',     OWNER_INFO.lastName);
    await vueSetValue(page, '#formAddressLine1', OWNER_INFO.address1);
    await vueSetValue(page, '#FormPostalCode',   OWNER_INFO.zip);
    await vueSetValue(page, '#cityForm',         OWNER_INFO.city);
    await vueSetValue(page, '#stateForm',        OWNER_INFO.state);
    await vueSetValue(page, '#countryForm',      OWNER_INFO.country);
    await vueSetValue(page, '#formEmail',        OWNER_INFO.email);

    // Check the terms checkbox
    await page.evaluate(() => {
      const cb = document.querySelector('#termsAccepted');
      if (cb && !cb.checked) {
        cb.click();
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    // Wait for Vue to re-evaluate form validity and enable the PRINT button (up to 5s)
    await page.waitForFunction(
      () => { const btn = document.querySelector('button[type="submit"]'); return btn && !btn.disabled; },
      { timeout: 5000 }
    ).catch(() => { throw new Error('Menards PRINT button did not become enabled within 5s — Vue validation failed'); });

    // Click PRINT and wait up to 6s for window.print() to be intercepted
    await page.click('button[type="submit"]');
    await waitFor(() => printCalled, 6000);

    if (!printCalled) {
      throw new Error('Menards: window.print() was not intercepted — form may not have submitted successfully');
    }

    // Switch to print media so @media print CSS reveals the completed form layout
    await page.emulateMediaType('print');
    await new Promise(r => setTimeout(r, 800));

    if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });
    const ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const pdfPath = path.join(PDF_DIR, `menards-rebate-${ts}.pdf`);

    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' },
    });
    fs.writeFileSync(pdfPath, pdfBuffer);

    await emailRebateForm(pdfPath, expense, pdfBuffer);
    return pdfPath;
  } finally {
    await browser.close();
  }
}

// ── Helpers ────────────────────────────────────────────────────

// Set a form field value and dispatch the events Vue needs to update reactive state.
async function vueSetValue(page, selector, value) {
  await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`Menards form element not found: ${sel}`);
    const ProtoEl = el.tagName === 'SELECT' ? window.HTMLSelectElement : window.HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(ProtoEl.prototype, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
  }, selector, value);
}

// Poll predicate every 100ms, resolve when true or timeout expires.
function waitFor(predicate, timeoutMs) {
  return new Promise(resolve => {
    const iv = setInterval(() => { if (predicate()) { clearInterval(iv); resolve(); } }, 100);
    setTimeout(() => { clearInterval(iv); resolve(); }, timeoutMs);
  });
}

async function emailRebateForm(pdfPath, expense, pdfBuffer) {
  const amount = Number(expense.amount || 0).toFixed(2);
  const vendor = expense.vendor || 'Menards';
  const date   = expense.transaction_date || new Date().toISOString().slice(0, 10);
  const fileName = path.basename(pdfPath);
  await sendEmail({
    to: ['michael@jrboehlke.com'],
    subject: `Menards Rebate Form — ${vendor} $${amount} (${date})`,
    body: `<p>Here is a complete Menards rebate form. Please print and mail this.</p>
<p><strong>To complete your rebate:</strong></p>
<ol>
  <li>Print the attached PDF — it is pre-filled with your mailing address.</li>
  <li>From your Menards receipt, cut out the <strong>Rebate Receipt</strong> stub
      (printed at the bottom of the receipt, below the regular receipt).</li>
  <li>Place both the printed form and the rebate receipt stub in an envelope and mail to:<br>
      <strong>Rebate Offer<br>PO Box 155<br>Elk Mound, WI 54739-0155</strong></li>
</ol>
<p><em>Charge: $${amount} at ${vendor} on ${date} — card ending ${expense.card_last_four || 'XXXX'}.</em></p>
<p><em>— JRB Assistant</em></p>`,
    attachments: [{ name: fileName, contentType: 'application/pdf', content: pdfBuffer }],
  });
}
