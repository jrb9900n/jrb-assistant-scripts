// tools/impl/menards.js — Menards rebate form automation
//
// Fills the rebate form at menards.com/main/rebate-form.html using a full browser
// session (puppeteer-extra + stealth plugin) so it behaves like a real user
// visiting the page. This is automation of your own legitimate rebate submission.
//
// Architecture: automation-first, manual-fallback.
//   1. Try to fill and submit the rebate form automatically.
//   2. If the page is blocked or the form changes, mark the rebate as 'blocked'
//      and send Michael a Teams alert + email with manual submission instructions.
//
// Failure modes detected:
//   - Incapsula/Imperva challenge page (_Incapsula_Resource in HTML)
//   - Form selector timeout (page structure changed — save screenshot + HTML)
//   - submit.ajx timeout (form did not submit)
//   - PDF too small (wrong content captured)

import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import fs from 'fs';
import https from 'https';
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
  // Dedup check: skip completed/in-progress rows; retry if retry window has passed.
  const { data: existing, error: dedupErr } = await supabase
    .from('menards_rebates')
    .select('id, status, retry_after, attempts')
    .eq('expense_report_id', expenseReportId)
    .maybeSingle();

  let rebate;

  if (dedupErr) {
    logger.warn('Menards rebate dedup check failed — proceeding with insert', { expenseReportId, err: dedupErr.message });
  } else if (existing) {
    if (existing.status === 'retry_pending' && existing.retry_after && new Date(existing.retry_after) <= new Date()) {
      // Retry window has passed — reset status and re-run
      await supabase.from('menards_rebates').update({ status: 'pending' }).eq('id', existing.id);
      rebate = existing;
      logger.info('Menards rebate: retrying after delay', { expenseReportId, attempts: existing.attempts });
    } else {
      logger.info('Menards rebate already exists, skipping', { expenseReportId, status: existing.status });
      return;
    }
  }

  if (!rebate) {
    // First attempt — create the tracking row
    const { data: newRebate, error: insErr } = await supabase
      .from('menards_rebates')
      .insert({ expense_report_id: expenseReportId, status: 'pending', attempts: 1 })
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
    rebate = newRebate;
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
      .update({ pdf_path: pdfPath, emailed_at: new Date().toISOString(), status: 'emailed' })
      .eq('id', rebate.id);
    logger.info('Menards rebate emailed', { expenseReportId, pdfPath });
  } catch (err) {
    const isBlocked  = err.name === 'MenardsBlockedError';
    const attemptNum = rebate.attempts || 1;

    // Transient failures (network blocks, USPS timeouts) get one automatic retry after 2 hours.
    // Only blocked status (Incapsula JS challenge) and persistent errors send the fallback email.
    const shouldRetry = !isBlocked && attemptNum < 2;
    const newStatus   = shouldRetry ? 'retry_pending' : (isBlocked ? 'blocked' : 'error');
    const retryAfter  = shouldRetry ? new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() : null;

    await supabase
      .from('menards_rebates')
      .update({
        status:          newStatus,
        error_message:   err.message,
        egress_ip:       err.egressIp       ?? null,
        screenshot_path: err.screenshotPath ?? null,
        ...(retryAfter ? { retry_after: retryAfter, attempts: attemptNum + 1 } : {}),
      })
      .eq('id', rebate.id);

    logger.error(`Menards rebate ${newStatus}`, { expenseReportId, err: err.message, shouldRetry, retryAfter });

    if (!shouldRetry) {
      await sendManualFallback(expense, isBlocked
        ? `Menards rebate automation was blocked (possible bot challenge). Manual submission required.`
        : `Menards rebate automation failed after ${attemptNum} attempt(s): ${err.message}`
      ).catch(e => logger.warn('Menards: failed to send manual fallback', { err: e.message }));
    }
  }
}

// ── Core: fill menards.com rebate form and capture PDF ─────────

async function fillAndPrintRebateForm(expense) {
  const executablePath = fs.existsSync(EDGE_PATH)   ? EDGE_PATH
    : fs.existsSync(CHROME_PATH) ? CHROME_PATH
    : null;
  if (!executablePath) throw new Error('No Chrome or Edge browser found on this machine');

  // Log the outbound IP used for this attempt so we know which exit node was active.
  // The --proxy-server flag below routes ONLY the Puppeteer browser through the proxy;
  // the rest of the agent (axios, Supabase, etc.) continues on the machine's default route.
  const egressIp = await getEgressIp().catch(() => 'unknown');
  logger.info('Menards: starting rebate attempt', { egressIp });

  const browser = await puppeteerExtra.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--window-size=1280,900',
      '--disable-blink-features=AutomationControlled',
      // Use direct connection (no WARP proxy) — WARP exit IP may be rate-limited after
      // rapid test runs. Re-enable with --proxy-server=socks5://127.0.0.1:40000 if needed.
      // '--proxy-server=socks5://127.0.0.1:40000',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(USER_AGENT);

    // Capture the submit.ajx PDF from inside the browser as an ArrayBuffer, then pass
    // it back as base64. Puppeteer's resp.buffer() goes through CDP Network.getResponseBody
    // which returns the body as a string when base64Encoded=false — Node.js then re-encodes
    // it as UTF-8, corrupting every byte >= 0x80 into a 3-byte replacement sequence.
    // Reading via XHR responseType='arraybuffer' inside the browser context is binary-safe.
    let submitPdfBuffer = null;
    const xhrLog = [];
    await page.exposeFunction('__captureSubmitAjxPdf', (base64) => {
      submitPdfBuffer = Buffer.from(base64, 'base64');
      logger.info('Menards: submit.ajx PDF captured via in-browser XHR', { bytes: submitPdfBuffer.length });
    });
    await page.exposeFunction('__logXhrActivity', (info) => {
      xhrLog.push(info);
      logger.info('Menards: XHR', info);
    });
    await page.evaluateOnNewDocument(() => {
      function b64FromArrayBuffer(ab) {
        const bytes = new Uint8Array(ab);
        let b64 = '';
        const CHUNK = 8192;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          b64 += btoa(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
        }
        return b64;
      }

      // Intercept XHR (axios uses this by default in Vue apps).
      // Force arraybuffer so the browser never decodes bytes as text.
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this.__xhrUrl    = url;
        this.__xhrMethod = method;
        if (typeof url === 'string' && url.includes('submit.ajx')) {
          this.__isSubmitAjx = true;
        }
        return origOpen.call(this, method, url, ...rest);
      };
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function(...args) {
        const self = this;
        if (this.__isSubmitAjx) {
          this.responseType = 'arraybuffer';
          this.addEventListener('load', function() {
            window.__logXhrActivity({ tag: 'submit.ajx', url: self.__xhrUrl, status: this.status, bytes: this.response?.byteLength ?? 0 });
            if (this.status === 200 && this.response instanceof ArrayBuffer) {
              window.__captureSubmitAjxPdf(b64FromArrayBuffer(this.response));
            }
          });
        } else {
          // Log any XHR that looks related to rebate/address so we can trace the form flow.
          this.addEventListener('load', function() {
            const url = self.__xhrUrl || '';
            if (/\.ajx|rebate|submit|usps|address/i.test(url)) {
              window.__logXhrActivity({ tag: 'xhr', url, method: self.__xhrMethod, status: this.status });
            }
          });
        }
        return origSend.call(this, ...args);
      };

      // Also intercept fetch in case the Vue app uses it instead of XHR.
      const origFetch = window.fetch;
      window.fetch = async function(input, init) {
        const url = typeof input === 'string' ? input : (input?.url ?? '');
        const resp = await origFetch.call(this, input, init);
        if (url.includes('submit.ajx') && resp.ok) {
          const clone = resp.clone();
          clone.arrayBuffer().then(ab => {
            window.__logXhrActivity({ tag: 'fetch-submit.ajx', url, status: resp.status, bytes: ab.byteLength });
            window.__captureSubmitAjxPdf(b64FromArrayBuffer(ab));
          }).catch(() => {});
          return resp;
        }
        return resp;
      };

      // Intercept window.open — the page may open the PDF blob URL in a new tab.
      const origWindowOpen = window.open;
      window.open = function(url, target, features) {
        if (typeof url === 'string' && url.startsWith('blob:')) {
          window.__logXhrActivity({ tag: 'window.open-blob', url });
          fetch(url)
            .then(r => r.arrayBuffer())
            .then(ab => window.__captureSubmitAjxPdf(b64FromArrayBuffer(ab)))
            .catch(() => {});
        }
        return origWindowOpen ? origWindowOpen.call(this, url, target, features) : null;
      };

      // Suppress window.print() — the main page calls it after submitting
      window.print = function() {};
    });

    await page.goto(REBATE_URL, { waitUntil: 'networkidle2', timeout: 45_000 });

    // Detect bot-challenge page before attempting to fill the form.
    // Incapsula/Imperva challenge pages include _Incapsula_Resource in the HTML.
    const pageHtml = await page.content();
    if (pageHtml.includes('_Incapsula_Resource') || pageHtml.includes('Request unsuccessful')) {
      const screenshotPath = path.join(PDF_DIR, `menards-block-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath }).catch(() => {});
      const err = new Error('Menards page returned a bot-challenge response — rebate requires manual submission');
      err.name          = 'MenardsBlockedError';
      err.egressIp      = egressIp;
      err.screenshotPath = screenshotPath;
      throw err;
    }

    // Wait for Vue app to mount the form.
    // If this times out, the page structure may have changed — save a diagnostic snapshot.
    await page.waitForSelector('#formFirstName', { timeout: 20_000 }).catch(async () => {
      const screenshotPath = path.join(PDF_DIR, `menards-form-missing-${Date.now()}.png`);
      const htmlPath       = path.join(PDF_DIR, `menards-form-missing-${Date.now()}.html`);
      await page.screenshot({ path: screenshotPath }).catch(() => {});
      fs.writeFileSync(htmlPath, await page.content().catch(() => ''), 'utf8');
      throw new Error(`Menards: #formFirstName not found after 20s — form may have changed. Screenshot: ${screenshotPath}`);
    });

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

    // Click PRINT (first time) — Menards calls USPS API to validate the address (~1-3s).
    // If the address is non-standard, a modal appears. After confirming, the form
    // reloads with the USPS-corrected address and PRINT must be clicked a second time.
    // On the second click, submit.ajx is called and the server returns the filled PDF.
    await page.click('button[type="submit"]');
    logger.info('Menards: first PRINT click sent, waiting for USPS modal or direct submission');

    // Detect the address-validation modal by waiting for the "Use Original Address"
    // button to appear. Using button text rather than a Vue scoped-attribute selector
    // (data-v-HASH) — Vue hashes change on every build and would silently break detection
    // when Menards deploys a frontend update.
    // Timeout is 12s (not 5s) — PO Box addresses often take 5-8s for USPS to respond.
    const modalDetected = await page.waitForFunction(
      () => Array.from(document.querySelectorAll('button'))
              .some(b => b.textContent.trim() === 'Use Original Address'),
      { timeout: 12000 }
    ).then(() => true).catch(() => false);
    logger.info('Menards: address modal detection complete', { modalDetected });

    if (modalDetected) {
      // Find the rendered "Continue" button using bounding-rect dimensions.
      // getComputedStyle() on a child of display:none returns the child's own value
      // (not 'none'), so we use getBoundingClientRect() which returns {0,0,0,0} for
      // elements inside hidden containers (e.g. Bootstrap d-flex.d-md-none at 1280px).
      const coords = await page.evaluate(() => {
        const cont = Array.from(document.querySelectorAll('button')).find(b => {
          if (b.textContent.trim() !== 'Continue') return false;
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (!cont) return null;
        cont.scrollIntoView({ block: 'center' });
        const r = cont.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });

      if (coords) {
        await page.mouse.click(coords.x, coords.y);
        logger.info('Menards: address validation modal confirmed via mouse click');
      } else {
        await page.evaluate(() => {
          Array.from(document.querySelectorAll('button'))
            .filter(b => b.textContent.trim() === 'Continue')
            .forEach(b => b.click());
        });
        logger.info('Menards: address validation modal confirmed via synthetic click');
      }

      // After Continue, the form reloads with the USPS-corrected address.
      // Wait for the PRINT button to re-enable, then click it a second time.
      await page.waitForFunction(
        () => { const btn = document.querySelector('button[type="submit"]'); return btn && !btn.disabled; },
        { timeout: 8000 }
      ).catch(() => { throw new Error('Menards: PRINT button did not reappear after address confirmation'); });

      await page.click('button[type="submit"]');
      logger.info('Menards: clicked PRINT after address confirmation (step 2)');
    }

    logger.info('Menards: waiting for submit.ajx PDF', { modalDetected });
    // Wait for submit.ajx to return the server-generated PDF (up to 15s)
    await waitFor(() => submitPdfBuffer !== null, 15000);

    // Fallback: look for a blob URL the page opened after submission.
    // submit.ajx returns the PDF bytes; the Vue app typically calls window.open(blobUrl)
    // or embeds the result in an iframe — our window.open interceptor handles the former;
    // this handles the latter and any case the XHR interceptor missed.
    if (!submitPdfBuffer) {
      const snapPath = path.join(PDF_DIR, `menards-timeout-${Date.now()}.png`);
      await page.screenshot({ path: snapPath }).catch(() => {});
      logger.warn('Menards: primary capture timed out, trying blob URL fallback', {
        xhrLog: xhrLog.slice(-20),
        snapPath,
      });

      const blobB64 = await page.evaluate(() => new Promise((resolve) => {
        const el = [...document.querySelectorAll('iframe, object, embed')]
          .find(e => (e.src || e.data || '').startsWith('blob:'));
        const blobUrl = el ? (el.src || el.data) : null;
        if (!blobUrl) { resolve(null); return; }
        fetch(blobUrl)
          .then(r => r.arrayBuffer())
          .then(ab => {
            const bytes = new Uint8Array(ab);
            let b64 = '';
            for (let i = 0; i < bytes.length; i += 8192) {
              b64 += btoa(String.fromCharCode(...bytes.subarray(i, i + 8192)));
            }
            resolve(b64);
          })
          .catch(() => resolve(null));
      })).catch(() => null);

      if (blobB64) {
        submitPdfBuffer = Buffer.from(blobB64, 'base64');
        logger.info('Menards: PDF captured via blob URL fallback', { bytes: submitPdfBuffer.length });
      }
    }

    if (!submitPdfBuffer) {
      throw new Error('Menards: submit.ajx did not return a PDF within 15s — form submission may have failed');
    }
    if (!submitPdfBuffer.slice(0, 4).toString('ascii').startsWith('%PDF')) {
      throw new Error('Menards: submit.ajx response is not a valid PDF (wrong magic bytes)');
    }
    // The Menards InDesign-generated rebate PDF is ~1.5MB. Any PDF under 100KB is almost
    // certainly wrong content (e.g., a puppeteer page render of the instructions screen).
    const MIN_PDF_BYTES = 100 * 1024;
    if (submitPdfBuffer.length < MIN_PDF_BYTES) {
      throw new Error(`Menards: PDF too small (${submitPdfBuffer.length} bytes < ${MIN_PDF_BYTES} minimum) — likely wrong content`);
    }

    if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });
    const ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const pdfPath = path.join(PDF_DIR, `menards-rebate-${ts}.pdf`);

    fs.writeFileSync(pdfPath, submitPdfBuffer);
    logger.info('Menards: PDF saved', { pdfPath, bytes: submitPdfBuffer.length });

    await emailRebateForm(pdfPath, expense, submitPdfBuffer);
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
  const amount   = Number(expense.amount || 0).toFixed(2);
  const vendor   = expense.vendor || 'Menards';
  const date     = expense.transaction_date || new Date().toISOString().slice(0, 10);
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

// Send Michael a Teams alert + email with manual submission instructions.
// Called whenever automation fails so the rebate opportunity is never silently lost.
async function sendManualFallback(expense, reason) {
  const amount = Number(expense.amount || 0).toFixed(2);
  const vendor = expense.vendor || 'Menards';
  const date   = expense.transaction_date || new Date().toISOString().slice(0, 10);
  const card   = expense.card_last_four   || 'XXXX';

  const instructions = `Menards rebate requires manual submission.\n` +
    `Charge: $${amount} at ${vendor} on ${date} (card ${card})\n` +
    `Reason: ${reason}\n\n` +
    `To submit manually:\n` +
    `1. Visit https://www.menards.com/main/rebate-form.html\n` +
    `2. Fill in your mailing address (Michael Reardon, PO Box 105, Mequon WI 53092)\n` +
    `3. Print the form, attach the Rebate Receipt stub from your Menards receipt,\n` +
    `   and mail to: Rebate Offer, PO Box 155, Elk Mound, WI 54739-0155`;

  try { await sendProactiveMessage(`⚠️ ${instructions}`); } catch {}

  await sendEmail({
    to: ['michael@jrboehlke.com'],
    subject: `Action Required: Menards Rebate Manual Submission — ${vendor} $${amount} (${date})`,
    body: `<p><strong>Menards rebate automation could not complete this rebate automatically.</strong></p>
<p><em>${reason}</em></p>
<p><strong>Charge:</strong> $${amount} at ${vendor} on ${date} (card ending ${card})</p>
<p><strong>To submit manually:</strong></p>
<ol>
  <li>Visit <a href="https://www.menards.com/main/rebate-form.html">https://www.menards.com/main/rebate-form.html</a></li>
  <li>Fill in your mailing address: Michael Reardon, PO Box 105, Mequon WI 53092</li>
  <li>Click PRINT to download the completed rebate form PDF</li>
  <li>Print it, attach the <strong>Rebate Receipt stub</strong> from the bottom of your Menards receipt,
      and mail both to:<br><strong>Rebate Offer<br>PO Box 155<br>Elk Mound, WI 54739-0155</strong></li>
</ol>
<p><em>— JRB Assistant</em></p>`,
  });
  logger.info('Menards: manual fallback instructions sent', { vendor, amount, date });
}

// Fetch the machine's outbound IP via a lightweight HTTPS probe.
// Times out after 5s — used only for logging, never blocks the rebate flow.
function getEgressIp() {
  return new Promise((resolve, reject) => {
    const req = https.get('https://api.ipify.org', { timeout: 5000 }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(data.trim()));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}
