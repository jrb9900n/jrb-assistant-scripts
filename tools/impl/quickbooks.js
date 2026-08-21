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
 * Pages through a QBO query for a given entity + WHERE clause, following the
 * same STARTPOSITION/PAGE_SIZE/MAX_PAGES defensive-cap pattern that
 * getVendorBillsForPeriod (below) originally hand-rolled just for Bill —
 * generalized here so getARAgingReport/getAPAgingReport (Balance > '0') and
 * getVendorBillsForPeriod (TxnDate range) share one pagination implementation
 * instead of drifting apart. Confirmed live 2026-08-21 that the *unpaginated*
 * single-query version getARAgingReport/getAPAgingReport used before this
 * (a single MAXRESULTS 300 call) was already silently hitting that exact cap
 * in production for AR (bucket counts summed to precisely 300), meaning the
 * weekly AR/Collections email had been under-reporting total AR for some
 * unknown period. Fixed by routing both through this paginated helper.
 */
async function paginatedQuery(entity, whereClause) {
  const PAGE_SIZE = 300;
  const MAX_PAGES = 100; // real bill/invoice volume for one company never legitimately needs more pages than this
  let rows = [];
  let pageCount = 0;
  for (let start = 1; ; start += PAGE_SIZE) {
    if (++pageCount > MAX_PAGES) {
      logger.warn('paginatedQuery: hit MAX_PAGES safety cap, stopping', { entity, whereClause, rowsSoFar: rows.length });
      break;
    }
    const q = `SELECT * FROM ${entity} WHERE ${whereClause} STARTPOSITION ${start} MAXRESULTS ${PAGE_SIZE}`;
    const res = await query({ query: q });
    const page = res?.[entity] ?? [];
    rows = rows.concat(page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function fetchAllOpenBalance(entity) {
  return paginatedQuery(entity, "Balance > '0'");
}

/**
 * Shared aging-bucket mechanics for getARAgingReport/getAPAgingReport: given
 * an array of records that already carry { balance, ageDays }, buckets them
 * by age, sorts each bucket by balance desc, and derives the $500+/60d+
 * "flagged" list. Extracted so the AR and AP aging paths can't silently drift
 * apart on bucket boundaries, sort order, or the flag threshold.
 */
function bucketOpenTransactionsByAge(records) {
  const buckets = { current: [], d30: [], d60: [], d90: [], d120plus: [] };
  let total = 0;

  for (const record of records) {
    total += record.balance;
    if (record.ageDays <= 0)        buckets.current.push(record);
    else if (record.ageDays <= 30)  buckets.d30.push(record);
    else if (record.ageDays <= 60)  buckets.d60.push(record);
    else if (record.ageDays <= 90)  buckets.d90.push(record);
    else                             buckets.d120plus.push(record);
  }

  for (const b of Object.values(buckets)) b.sort((a, c) => c.balance - a.balance);

  const flagged = [...buckets.d60, ...buckets.d90, ...buckets.d120plus]
    .filter(r => r.balance >= 500)
    .sort((a, b) => b.balance - a.balance);

  return { buckets, flagged, total };
}

/**
 * Fetch all open QB invoices and bucket them by age.
 * Returns { buckets: { current, d30, d60, d90, d120plus }, flagged: [], total }
 * buckets contain arrays of invoice summaries.
 */
export async function getARAgingReport() {
  const invoices = await fetchAllOpenBalance('Invoice');
  const today = new Date();

  const records = [];
  for (const inv of invoices) {
    const balance = Number(inv.Balance ?? 0);
    if (balance <= 0) continue;

    const dueDate = inv.DueDate ? new Date(inv.DueDate) : new Date(inv.TxnDate);
    const ageDays = Math.floor((today - dueDate) / 86400000);

    records.push({
      id: inv.Id,
      invoiceNum: inv.DocNumber,
      customer: inv.CustomerRef?.name ?? '—',
      balance,
      dueDate: inv.DueDate ?? inv.TxnDate,
      txnDate: inv.TxnDate,
      ageDays,
      memo: inv.PrivateNote ?? '',
    });
  }

  return bucketOpenTransactionsByAge(records);
}

/**
 * Fetch all open QB vendor Bills and bucket them by age, mirroring
 * getARAgingReport()'s exact bucket-and-return-shape convention above (AP's
 * equivalent of Invoice). Also surfaces each bill's DocNumber, per-line
 * amount total (lineTotal), and separately-tracked sales tax (taxAmt) so
 * callers can detect duplicate bills / bills whose line items + tax don't
 * sum to TotalAmt without a second QB round-trip. (QBO Bills carry sales tax
 * in TxnTaxDetail.TotalTax, never as part of the Line array itself — a
 * lineTotal-vs-TotalAmt comparison that ignores this would flag every
 * legitimately taxed bill as a false "discrepancy".)
 * Returns { buckets: { current, d30, d60, d90, d120plus }, flagged: [], total }
 * buckets contain arrays of bill summaries.
 */
export async function getAPAgingReport() {
  const bills = await fetchAllOpenBalance('Bill');
  // Truncated to UTC midnight (not a raw "now" instant) so ageDays lines up
  // exactly with callers that compute "today" the same way (e.g. ap-report.js's
  // "bills due in the coming week" filter) — both then agree on what counts
  // as "today" regardless of what hour the cron/manual run fires at.
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const records = [];
  for (const b of bills) {
    const balance = Number(b.Balance ?? 0);
    if (balance <= 0) continue;

    const dueDate = b.DueDate ? new Date(b.DueDate) : new Date(b.TxnDate);
    const ageDays = Math.floor((today - dueDate) / 86400000);
    const totalAmt = Number(b.TotalAmt ?? 0);
    const lineTotal = (b.Line ?? []).reduce((s, l) => s + Number(l.Amount ?? 0), 0);
    const taxAmt = Number(b.TxnTaxDetail?.TotalTax ?? 0);

    records.push({
      id: b.Id,
      docNumber: b.DocNumber ?? null,
      vendor: b.VendorRef?.name ?? '—',
      balance,
      totalAmt,
      lineTotal,
      taxAmt,
      dueDate: b.DueDate ?? b.TxnDate,
      txnDate: b.TxnDate,
      ageDays,
      memo: b.PrivateNote ?? '',
    });
  }

  return bucketOpenTransactionsByAge(records);
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
  // Defensive cap on page count lives in the shared paginatedQuery() helper
  // now (see its comment above) — this loop previously ran unbounded
  // (crashed the process with an OOM) when a cache-key collision made every
  // "page" replay the same cached first page forever, so page.length <
  // PAGE_SIZE never fired. That root cause is fixed (see query()'s cache
  // key), but real vendor bill volume for one company never legitimately
  // needs more pages than the shared cap allows.
  const bills = await paginatedQuery('Bill', `TxnDate >= '${startDate}' AND TxnDate <= '${endDate}'`);

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
