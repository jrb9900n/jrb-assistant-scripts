// tools/impl/quickbooks.js — QuickBooks Online v3 API
// Reuses the refresh pattern from the existing AuditMatchingEngine project.

import axios from 'axios';
import { createHash } from 'crypto';
import { cacheGet, cacheSet } from '../../memory/memory.js';
import { logger } from '../../core/logger.js';
import { getQBAccessToken } from './qb-token.js';

const BASE = `https://quickbooks.api.intuit.com/v3/company/${process.env.QB_REALM_ID}`;

const getToken = getQBAccessToken;

// ── Payment method cleanup ────────────────────────────────────

/**
 * Deactivates a QBO PaymentMethod list entry via sparse update. Used to
 * retire a duplicate entry (e.g. "Visa***DUP") without deleting it —
 * QBO doesn't support hard-deleting list entries that may be referenced
 * by historical transactions, only deactivating them.
 */
export async function deactivatePaymentMethod({ id }) {
  const token = await getToken();
  const current = await query({ query: `SELECT Id, SyncToken FROM PaymentMethod WHERE Id = '${id}'` });
  const syncToken = current?.PaymentMethod?.[0]?.SyncToken;
  if (syncToken === undefined) throw new Error(`QB deactivatePaymentMethod: PaymentMethod ${id} not found`);

  const res = await axios.post(`${BASE}/paymentmethod`,
    { Id: id, SyncToken: syncToken, sparse: true, Active: false },
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' } });
  return res.data.PaymentMethod;
}

/**
 * Re-points a Payment's PaymentMethodRef via sparse update — a metadata-only
 * categorization change, never touches TotalAmt, TxnDate, or CustomerRef.
 */
export async function updatePaymentMethodRef({ paymentId, newPaymentMethodId }) {
  const token = await getToken();
  const current = await query({ query: `SELECT Id, SyncToken FROM Payment WHERE Id = '${paymentId}'` });
  const syncToken = current?.Payment?.[0]?.SyncToken;
  if (syncToken === undefined) throw new Error(`QB updatePaymentMethodRef: Payment ${paymentId} not found`);

  const res = await axios.post(`${BASE}/payment`,
    { Id: paymentId, SyncToken: syncToken, sparse: true, PaymentMethodRef: { value: newPaymentMethodId } },
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' } });
  return res.data.Payment;
}

/**
 * Re-points a Customer's ParentRef via sparse update — used to fix
 * incorrect sub-customer (Job) nesting without touching any transaction data.
 */
export async function updateCustomerParent({ customerId, newParentId }) {
  const token = await getToken();
  const current = await query({ query: `SELECT Id, SyncToken FROM Customer WHERE Id = '${customerId}'` });
  const syncToken = current?.Customer?.[0]?.SyncToken;
  if (syncToken === undefined) throw new Error(`QB updateCustomerParent: Customer ${customerId} not found`);

  const res = await axios.post(`${BASE}/customer`,
    { Id: customerId, SyncToken: syncToken, sparse: true, ParentRef: { value: newParentId }, Job: true },
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' } });
  return res.data.Customer;
}

/** Deactivates a QBO Customer via sparse update (QBO has no hard-delete for entities with history). */
export async function deactivateCustomer({ customerId }) {
  const token = await getToken();
  const current = await query({ query: `SELECT Id, SyncToken FROM Customer WHERE Id = '${customerId}'` });
  const syncToken = current?.Customer?.[0]?.SyncToken;
  if (syncToken === undefined) throw new Error(`QB deactivateCustomer: Customer ${customerId} not found`);

  const res = await axios.post(`${BASE}/customer`,
    { Id: customerId, SyncToken: syncToken, sparse: true, Active: false },
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' } });
  return res.data.Customer;
}

// ── Customer create ───────────────────────────────────────────

/**
 * Create a QBO customer. Pass parentId for a sub-customer (Job).
 */
export async function createCustomer({ displayName, parentId }) {
  const token = await getToken();
  const payload = { DisplayName: displayName };
  if (parentId) {
    payload.ParentRef = { value: parentId };
    payload.Job = true;
  }
  const res = await axios.post(`${BASE}/customer`, payload, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
  });
  return res.data.Customer;
}

// ── Query ─────────────────────────────────────────────────────

/**
 * Run a QBO SQL-like query. Results are cached by query string.
 * @param {object} opts
 * @param {string} opts.query - e.g. "SELECT * FROM Invoice STARTPOSITION 1 MAXRESULTS 100"
 */
export async function query({ query: qStr }) {
  // Cache check — avoids re-hitting QB on every scheduler tick.
  // Fixed 2026-07-31: a real bug, not just today's symptom — the old key
  // (base64(qStr).slice(0, 60)) only captures the first ~45 bytes of the
  // query string. Any two queries sharing that prefix collide on the same
  // cache key, e.g. every page of a paginated query differing only in
  // STARTPOSITION near the END of the string (STARTPOSITION for
  // getVendorBillsForPeriod's Bill query sits ~90 characters in — the whole
  // discriminating part was being silently dropped). This caused every
  // "page" of that query to replay the cached page-1 result from Supabase's
  // agent_cache (1hr TTL) for up to an hour, and the pagination loop never
  // saw page.length < PAGE_SIZE, so it looped until the process ran out of
  // heap concatenating the same 300 bills over and over. Hashing the whole
  // query string (not just its first 60 base64 chars) guarantees distinct
  // queries never share a key, regardless of where they differ.
  const cacheKey = `qb:${createHash('sha256').update(qStr).digest('hex')}`;
  const cached = await cacheGet(cacheKey);
  if (cached) {
    logger.debug('QB cache hit', { query: qStr.slice(0, 60) });
    return JSON.parse(cached);
  }

  const token = await getToken();
  const res = await axios.get(`${BASE}/query`, {
    params: { query: qStr },
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });

  const result = res.data.QueryResponse;
  await cacheSet(cacheKey, result);
  return result;
}

/**
 * Fetch all QB Payments in a date range, sorted by amount descending.
 * Returns array of { id, date, customerName, amount, paymentMethod, linkedInvoices }
 */
export async function getPaymentsForWeek(startDate, endDate) {
  const q = `SELECT * FROM Payment WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 300`;
  const res = await query({ query: q });
  const payments = res?.Payment ?? [];
  return payments
    .map(p => ({
      id: p.Id,
      date: p.TxnDate,
      customerName: p.CustomerRef?.name ?? '—',
      amount: Number(p.TotalAmt ?? 0),
      paymentMethod: p.PaymentMethodRef?.name ?? (p.PaymentType ?? '—'),
      memo: p.PrivateNote ?? '',
      linkedInvoices: (p.Line ?? []).flatMap(l => l.LinkedTxn ?? []).filter(t => t.TxnType === 'Invoice').map(t => t.TxnId),
    }))
    .sort((a, b) => b.amount - a.amount);
}

/**
 * Fetch all open QB invoices and bucket them by age.
 * Returns { buckets: { current, d30, d60, d90, d120plus }, flagged: [], total }
 * buckets contain arrays of invoice summaries.
 */
export async function getARAgingReport() {
  const res = await query({ query: 'SELECT * FROM Invoice WHERE Balance > \'0\' MAXRESULTS 300' });
  const invoices = res?.Invoice ?? [];
  const today = new Date();

  const buckets = { current: [], d30: [], d60: [], d90: [], d120plus: [] };
  let total = 0;

  for (const inv of invoices) {
    const balance = Number(inv.Balance ?? 0);
    if (balance <= 0) continue;
    total += balance;

    const dueDate = inv.DueDate ? new Date(inv.DueDate) : new Date(inv.TxnDate);
    const ageDays = Math.floor((today - dueDate) / 86400000);

    const record = {
      id: inv.Id,
      invoiceNum: inv.DocNumber,
      customer: inv.CustomerRef?.name ?? '—',
      balance,
      dueDate: inv.DueDate ?? inv.TxnDate,
      txnDate: inv.TxnDate,
      ageDays,
      memo: inv.PrivateNote ?? '',
    };

    if (ageDays <= 0)        buckets.current.push(record);
    else if (ageDays <= 30)  buckets.d30.push(record);
    else if (ageDays <= 60)  buckets.d60.push(record);
    else if (ageDays <= 90)  buckets.d90.push(record);
    else                     buckets.d120plus.push(record);
  }

  // Sort each bucket by balance desc
  for (const b of Object.values(buckets)) b.sort((a, c) => c.balance - a.balance);

  const flagged = [...buckets.d60, ...buckets.d90, ...buckets.d120plus]
    .filter(r => r.balance >= 500)
    .sort((a, b) => b.balance - a.balance);

  return { buckets, flagged, total };
}

/**
 * Fetch QB invoices issued in a date range for revenue-by-category reporting.
 * Returns array categorized using simplified QB description rules.
 */
export async function getInvoicesForWeek(startDate, endDate) {
  const q = `SELECT * FROM Invoice WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 300`;
  const res = await query({ query: q });
  const invoices = res?.Invoice ?? [];

  const QB_CATEGORY_RULES = [
    { cat: 'Snow',                   terms: ['snow removal','snow plow','snow service','ice melt','deicing','shoveling','rock salt'] },
    { cat: 'Landscape Maintenance',  terms: ['fertiliz','weed control','lawn care','lawn service','spring clean','fall clean','leaf removal','aeration','mulch','mowing','overseeding','monthly maintenance','seasonal contract','monthly landscape'] },
    { cat: 'Landscape Construction', terms: ['landscape install','landscaping','planting','retaining wall','sod install','irrigation','drainage','hardscape','patio','topsoil','grading and seeding','boulder'] },
    { cat: 'Concrete Construction',  terms: ['concrete','flatwork','sidewalk','curb','curbing','stamped'] },
    { cat: 'Asphalt',                terms: ['asphalt','paving','sealcoat','crack fill','milling','striping','parking lot'] },
    { cat: 'Other',                  terms: [] },
  ];

  function categorize(desc) {
    if (!desc) return 'Other';
    const d = desc.toLowerCase();
    for (const rule of QB_CATEGORY_RULES) {
      if (rule.terms.some(t => d.includes(t))) return rule.cat;
    }
    return 'Other';
  }

  const result = [];
  for (const inv of invoices) {
    const lines = inv.Line ?? [];
    // Scan all line descriptions and pick the first non-"Other" category found
    let cat = 'Other';
    for (const line of lines) {
      if (!line.Description) continue;
      const c = categorize(line.Description);
      if (c !== 'Other') { cat = c; break; }
    }
    const firstDesc = lines.find(l => l.Description)?.Description ?? '';
    result.push({
      id: inv.Id,
      invoiceNum: inv.DocNumber,
      customer: inv.CustomerRef?.name ?? '—',
      txnDate: inv.TxnDate,
      totalAmt: Number(inv.TotalAmt ?? 0),
      balance: Number(inv.Balance ?? 0),
      category: cat,
      description: firstDesc.slice(0, 80),
    });
  }
  return result;
}

/**
 * Fetch Deposit records for Old National Checking (account 423) for a date range.
 * Returns array of deposits, flagging any lines with no CustomerRef (potentially unidentified cash).
 */
export async function getOldNationalDeposits(startDate, endDate) {
  const q = `SELECT * FROM Deposit WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 200`;
  const res = await query({ query: q });
  const deposits = res?.Deposit ?? [];

  // Filter to Old National account (Id 423)
  const onDeposits = deposits.filter(d => d.DepositToAccountRef?.value === '423');

  return onDeposits.map(d => {
    const lines = d.Line ?? [];
    const linkedLines   = lines.filter(l => l.LinkedTxn?.length > 0 || l.Entity?.EntityRef);
    const unlinkedLines = lines.filter(l => !l.LinkedTxn?.length && !l.Entity?.EntityRef);
    const unlinkedTotal = unlinkedLines.reduce((s, l) => s + Number(l.Amount ?? 0), 0);

    return {
      id: d.Id,
      date: d.TxnDate,
      totalAmt: Number(d.TotalAmt ?? 0),
      linkedCount: linkedLines.length,
      unlinkedTotal,
      memo: d.PrivateNote ?? '',
      hasUnidentifiedCash: unlinkedTotal > 0,
    };
  });
}

/**
 * Fetch a single Purchase entity by ID from QBO.
 * Used by the expense capture webhook handler.
 */
export async function getPurchase(id) {
  const token = await getToken();
  const res = await axios.get(
    `${BASE}/purchase/${id}`,
    {
      params: { minorversion: 65 },
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }
  );
  return res.data?.Purchase ?? null;
}

/**
 * Upload a receipt image/PDF and attach it to a QBO Purchase transaction.
 * @param {string} transactionId  - QBO Purchase entity ID
 * @param {Buffer} fileBuffer     - raw file bytes
 * @param {string} contentType    - MIME type (e.g. 'image/jpeg')
 * @param {string} fileName       - display filename in QBO
 * @returns {string} QBO Attachable ID
 */
export async function uploadReceiptToQbo(transactionId, fileBuffer, contentType, fileName) {
  const token = await getToken();
  const boundary = `JRBBoundary${Date.now()}`;

  const metadata = JSON.stringify({
    AttachableRef: [{ EntityRef: { type: 'Purchase', value: String(transactionId) } }],
    ContentType: contentType,
    FileName: fileName,
  });

  // Build multipart/form-data manually — axios FormData doesn't handle mixed JSON+binary well
  const part1 = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file_metadata_01"\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${metadata}\r\n`
  );
  const part2Header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file_content_01"; filename="${fileName}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`
  );
  const end = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([part1, part2Header, fileBuffer, end]);

  const res = await axios.post(`${BASE}/upload`, body, {
    params: { minorversion: 65 },
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      Accept: 'application/json',
    },
    maxBodyLength: Infinity,
  });

  const attachable = res.data?.AttachableResponse?.[0]?.Attachable;
  if (!attachable?.Id) throw new Error('QBO upload returned no Attachable ID');
  logger.info('Receipt attached to QBO purchase', { transactionId, attachableId: attachable.Id, fileName });
  return attachable.Id;
}

// ── CC Sub-account creation ────────────────────────────────────

/**
 * Create a CreditCard sub-account under the Chase parent account in QBO.
 * Called when an unknown Chase card is identified and linked to an employee.
 */
export async function createQBCCSubAccount(employeeName, lastFour) {
  const token = await getToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  const parentRes = await axios.get(`${BASE}/query`, {
    params: { query: "SELECT * FROM Account WHERE AccountType = 'CreditCard' MAXRESULTS 50" },
    headers,
  });
  const accounts = parentRes.data.QueryResponse?.Account ?? [];
  // Parent account has no ParentRef; prefer one whose name includes 'Chase'
  const parent =
    accounts.find(a => !a.ParentRef && /chase/i.test(a.Name)) ??
    accounts.find(a => !a.ParentRef);
  if (!parent) throw new Error('No top-level CreditCard account found in QBO');

  const accountName = `${employeeName} ...${lastFour}`;
  const createRes = await axios.post(
    `${BASE}/account`,
    {
      Name: accountName,
      AccountType: 'CreditCard',
      AccountSubType: 'CreditCard',
      ParentRef: { value: parent.Id, name: parent.Name },
    },
    { headers }
  );

  if (createRes.data?.Fault) {
    const msg = createRes.data.Fault?.Error?.[0]?.Message ?? JSON.stringify(createRes.data.Fault);
    throw new Error(`QBO account creation failed: ${msg}`);
  }
  const created = createRes.data.Account;
  if (!created) throw new Error('QBO account creation returned no Account object');
  logger.info('QB CC sub-account created', { name: created.Name, id: created.Id });
  return { id: created.Id, name: created.Name };
}

// ── Vendor bill / subcontractor cost matching (commission engine) ──

/**
 * Fetch all QB vendor Bills in a date range, with per-line Customer:Job / Class
 * refs surfaced (when populated) — used to find candidate subcontractor costs
 * for a given job. No caller in this codebase queried Bill before this.
 */
export async function getVendorBillsForPeriod(startDate, endDate) {
  const PAGE_SIZE = 300;
  // Defensive cap — this loop previously ran unbounded (crashed the process
  // with an OOM) when a cache-key collision made every "page" replay the same
  // cached first page forever, so page.length < PAGE_SIZE never fired. That
  // root cause is fixed (see query()'s cache key), but this is real vendor
  // bill volume for one company; there's no legitimate scenario needing more
  // than this many pages, so bail loudly rather than risk the same failure
  // mode again from some other cause.
  const MAX_PAGES = 100;
  let bills = [];
  let pageCount = 0;
  for (let start = 1; ; start += PAGE_SIZE) {
    if (++pageCount > MAX_PAGES) {
      logger.warn('getVendorBillsForPeriod: hit MAX_PAGES safety cap, stopping', { startDate, endDate, billsSoFar: bills.length });
      break;
    }
    const q = `SELECT * FROM Bill WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' STARTPOSITION ${start} MAXRESULTS ${PAGE_SIZE}`;
    const res = await query({ query: q });
    const page = res?.Bill ?? [];
    bills = bills.concat(page);
    if (page.length < PAGE_SIZE) break;
  }

  return bills.map(b => ({
    id: b.Id,
    date: b.TxnDate,
    vendorName: b.VendorRef?.name ?? '—',
    amount: Number(b.TotalAmt ?? 0),
    balance: Number(b.Balance ?? 0),
    memo: b.PrivateNote ?? '',
    lines: (b.Line ?? []).map(l => {
      const detail = l.AccountBasedExpenseLineDetail ?? l.ItemBasedExpenseLineDetail ?? {};
      return {
        description: l.Description ?? '',
        amount: Number(l.Amount ?? 0),
        customerName: detail.CustomerRef?.name ?? null,
        className: detail.ClassRef?.name ?? null,
      };
    }),
  }));
}

function normalizeForMatch(s) {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Fuzzy-match candidate vendor bill lines to a job, for subcontractor-cost
 * flagging in the commission report. Not a final cost computation — surfaces
 * candidates for manual confirmation, since Customer:Job tracking isn't
 * reliably populated on every bill.
 *
 * getVendorBillsForPeriod also surfaces each line's Class ref (className), but
 * no caller here has a QBO Class to compare it against — SA data carries no
 * such reference — so a Class-based match tier isn't included. Add one if a
 * source for the job's own Class ref ever exists.
 *
 * Confidence tiers:
 *   'high'   — line's Customer:Job ref matches the job's client name directly
 *   'medium' — bill falls within the job's date window and a line description
 *              mentions the client name (no direct ref match)
 *
 * @param {{ clientName: string, dateStart: string, dateEnd: string }} job
 * @param {Array} bills - output of getVendorBillsForPeriod
 * @returns {Array<{ qboBillId, vendorName, billAmount, billDate, matchConfidence, billLineDescription }>}
 */
export function matchBillsToJob(job, bills) {
  const jobNameNorm = normalizeForMatch(job.clientName);
  const start = new Date(job.dateStart);
  const end = new Date(job.dateEnd);
  const matches = [];

  for (const bill of bills) {
    const billDate = new Date(bill.date);
    for (const line of bill.lines) {
      let confidence = null;

      if (line.customerName && normalizeForMatch(line.customerName) === jobNameNorm) {
        confidence = 'high';
      } else if (
        jobNameNorm &&
        billDate >= start && billDate <= end &&
        line.description && normalizeForMatch(line.description).includes(jobNameNorm)
      ) {
        confidence = 'medium';
      }

      if (confidence) {
        matches.push({
          qboBillId: bill.id,
          vendorName: bill.vendorName,
          billAmount: line.amount || bill.amount,
          billDate: bill.date,
          matchConfidence: confidence,
          // The matched bill line's own description — used to best-effort
          // attribute this subcontractor cost to a specific invoice line
          // (invoice lines carry no direct FK to a bill line).
          billLineDescription: line.description,
        });
      }
    }
  }
  return matches;
}

// ── Cash forecast support (12-Week Cash Forecast report) ───────────────────

/**
 * Real starting-cash figure for the cash forecast report: sums CurrentBalance
 * across every QBO Account with AccountType 'Bank' (checking/savings). This is
 * a real QBO balance, not a fabricated one — but NOT guaranteed to be
 * second-fresh: it goes through query()'s shared Supabase cache (see query()
 * above), so if anything else in this codebase issued the exact same query
 * within the last CACHE_TTL_SECONDS (1hr default), this returns that cached
 * result rather than re-hitting QBO. That's an intentional rate-limit
 * tradeoff shared by every other reporting function in this file — acceptable
 * for a weekly report, just not literally "as of this exact second."
 * Also deliberately does NOT attempt a full balance-sheet reconciliation
 * (e.g. outstanding/uncleared transactions, undeposited funds) — that's a
 * much larger effort than a directional weekly cash forecast needs.
 */
export async function getCashBalance() {
  const res = await query({ query: "SELECT * FROM Account WHERE AccountType = 'Bank'" });
  const accounts = (res?.Account ?? []).map(a => ({
    id: a.Id,
    name: a.Name,
    balance: Number(a.CurrentBalance ?? 0),
  }));
  const total = accounts.reduce((s, a) => s + a.balance, 0);
  return { total, accounts };
}

/**
 * Minimal standalone "bills due" query for the cash forecast report.
 *
 * Deliberately NOT the same thing as the fuller getAPAgingReport() being
 * built on the separate (unmerged, as of this writing) claude/ap-report
 * branch — this repo must stay independently mergeable, so this queries
 * open Bills directly rather than depending on that branch's helpers
 * (fetchAllOpenBalance/bucketOpenTransactionsByAge). Revisit whether this
 * should be replaced by getAPAgingReport() once that branch merges.
 *
 * Single-page query (MAXRESULTS 1000) — real open-bill volume for this
 * company is currently in the dozens (see getVendorBillsForPeriod's
 * paginated pattern above if that ever changes and this needs to grow up).
 */
export async function getOpenBillsForForecast() {
  const res = await query({ query: "SELECT * FROM Bill WHERE Balance > '0' MAXRESULTS 1000" });
  const bills = res?.Bill ?? [];
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);

  return bills.map(b => {
    const dueDate = b.DueDate ? new Date(b.DueDate) : new Date(b.TxnDate);
    const ageDays = Math.floor((today - dueDate) / 86400000);
    return {
      id: b.Id,
      vendor: b.VendorRef?.name ?? b.VendorAddr?.Line1 ?? '—',
      balance: Number(b.Balance ?? 0),
      dueDate: b.DueDate ?? b.TxnDate,
      ageDays, // positive = overdue, negative = not yet due
    };
  });
}

/**
 * Heuristic weekly payroll cash-outflow estimate for the cash forecast report.
 *
 * QuickBooks Payroll has its own separate API/scopes for pay schedules and
 * run history (payroll.tools.* on the Payroll product) — this integration's
 * QBO app is only authorized for the regular Accounting API, so there is no
 * direct read of ADP/QBO Payroll's actual pay calendar available here.
 *
 * Instead: every actual payroll run shows up as a real cash-ledger posting to
 * the "Payroll Payable" account (confirmed live against production data,
 * e.g. $13,996.66 on 2026-07-10, $20,987.99 on 2026-07-17, ... — the clearing
 * account for net wages actually paid out). Summing those postings over a
 * trailing window and dividing by the number of weeks gives a real-data-
 * derived average weekly payroll cash outflow — smoothed, not a real pay
 * calendar, and explicitly documented as such in the report email.
 *
 * Deliberately excludes employer payroll taxes / ADP fees / benefits lines
 * (posted to separate accounts like "Payroll Tax Expense") — those aren't
 * always cash-same-week as the net-pay run, and mixing them in would make
 * this number harder to sanity-check against a bank statement. If they're
 * billed via a vendor Bill they're already covered by getOpenBillsForForecast();
 * if not, they're a known gap (see report email assumptions).
 */
export async function getPayrollCashOutflowEstimate({ lookbackDays = 56 } = {}) {
  const cutoff = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);

  // Paginated like getVendorBillsForPeriod above — a single MAXRESULTS-300
  // page silently truncated real data here (confirmed live: JRB's card-heavy
  // Purchase volume, see the expense capture system, hit exactly 300 rows in
  // a 120-day window during development), which would have quietly
  // undercounted "Payroll Payable" postings and understated every week's
  // payroll line with no warning anywhere in the report.
  const PAGE_SIZE = 300;
  const MAX_PAGES = 20; // 6,000 purchases in an 8-week window would be a real anomaly, not legitimate volume
  let purchases = [];
  let pageCount = 0;
  for (let start = 1; ; start += PAGE_SIZE) {
    if (++pageCount > MAX_PAGES) {
      logger.warn('getPayrollCashOutflowEstimate: hit MAX_PAGES safety cap, stopping', { lookbackDays, purchasesSoFar: purchases.length });
      break;
    }
    const q = `SELECT * FROM Purchase WHERE TxnDate >= '${cutoff}' STARTPOSITION ${start} MAXRESULTS ${PAGE_SIZE}`;
    const res = await query({ query: q });
    const page = res?.Purchase ?? [];
    purchases = purchases.concat(page);
    if (page.length < PAGE_SIZE) break;
  }

  let sampleTotal = 0;
  let txnCount = 0;
  for (const p of purchases) {
    for (const l of (p.Line ?? [])) {
      if (l.AccountBasedExpenseLineDetail?.AccountRef?.name === 'Payroll Payable') {
        sampleTotal += Number(l.Amount ?? 0);
        txnCount += 1;
      }
    }
  }
  const lookbackWeeks = lookbackDays / 7;
  const weeklyAverage = txnCount > 0 ? sampleTotal / lookbackWeeks : 0;
  return { weeklyAverage, lookbackDays, lookbackWeeks, sampleTotal, txnCount };
}
