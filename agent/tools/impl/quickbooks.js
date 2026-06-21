// tools/impl/quickbooks.js — QuickBooks Online v3 API
// Reuses the refresh pattern from the existing AuditMatchingEngine project.

import axios from 'axios';
import { cacheGet, cacheSet } from '../../memory/memory.js';
import { logger } from '../../core/logger.js';
import { getQBAccessToken } from './qb-token.js';

const BASE = `https://quickbooks.api.intuit.com/v3/company/${process.env.QB_REALM_ID}`;

const getToken = getQBAccessToken;

// ── Query ─────────────────────────────────────────────────────

/**
 * Run a QBO SQL-like query. Results are cached by query string.
 * @param {object} opts
 * @param {string} opts.query - e.g. "SELECT * FROM Invoice STARTPOSITION 1 MAXRESULTS 100"
 */
export async function query({ query: qStr }) {
  // Cache check — avoids re-hitting QB on every scheduler tick
  const cacheKey = `qb:${Buffer.from(qStr).toString('base64').slice(0, 60)}`;
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
