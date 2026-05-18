// tools/impl/contacts-sync.js — QBO → Outlook contacts sync
// Syncs all active QBO customers and vendors into each employee's
// "JRB Customers" and "JRB Vendors" contact folders in Outlook.
// Requires Graph API app permission: Contacts.ReadWrite

import axios from 'axios';
import { logger } from '../../core/logger.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const QB_BASE = `https://quickbooks.api.intuit.com/v3/company/${process.env.QB_REALM_ID}`;

// ── Auth ──────────────────────────────────────────────────────

let _graphToken = { token: null, expiresAt: 0 };
let _qbToken = null;
let _qbTokenExpiry = 0;

async function getGraphToken() {
  if (_graphToken.token && Date.now() < _graphToken.expiresAt - 60_000) return _graphToken.token;
  const res = await axios.post(
    `https://login.microsoftonline.com/${process.env.M365_TENANT_ID}/oauth2/v2.0/token`,
    new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     process.env.M365_CLIENT_ID,
      client_secret: process.env.M365_CLIENT_SECRET,
      scope:         'https://graph.microsoft.com/.default',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  _graphToken = { token: res.data.access_token, expiresAt: Date.now() + res.data.expires_in * 1000 };
  return _graphToken.token;
}

async function getQBToken() {
  if (_qbToken && Date.now() < _qbTokenExpiry - 60_000) return _qbToken;
  const creds = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const res = await axios.post(
    'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    `grant_type=refresh_token&refresh_token=${encodeURIComponent(process.env.QB_REFRESH_TOKEN)}`,
    { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  _qbToken = res.data.access_token;
  _qbTokenExpiry = Date.now() + res.data.expires_in * 1000;
  return _qbToken;
}

async function graph(method, path, data) {
  const token = await getGraphToken();
  const url = path.startsWith('http') ? path : `${GRAPH}${path}`;
  const res = await axios({ method, url, data, headers: { Authorization: `Bearer ${token}` } });
  return res.data;
}

// ── QBO data ──────────────────────────────────────────────────

async function qboQuery(entityType) {
  const token = await getQBToken();
  const results = [];
  let startPosition = 1;

  while (true) {
    const q = `SELECT * FROM ${entityType} WHERE Active = true STARTPOSITION ${startPosition} MAXRESULTS 1000`;
    const res = await axios.get(`${QB_BASE}/query`, {
      params: { query: q },
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const rows = res.data.QueryResponse?.[entityType] ?? [];
    results.push(...rows);
    if (rows.length < 1000) break;
    startPosition += 1000;
  }
  return results;
}

// ── QBO → Graph field mapping ─────────────────────────────────

function customerToContact(c) {
  // Prefer ShipAddr (property/service address); fall back to BillAddr
  const addr = c.ShipAddr?.Line1 ? c.ShipAddr : (c.BillAddr ?? {});
  return {
    displayName:    c.DisplayName || [c.GivenName, c.FamilyName].filter(Boolean).join(' ') || 'Unknown',
    givenName:      c.GivenName  ?? '',
    surname:        c.FamilyName ?? '',
    companyName:    c.CompanyName ?? '',
    businessPhones: c.PrimaryPhone?.FreeFormNumber ? [c.PrimaryPhone.FreeFormNumber] : [],
    emailAddresses: c.PrimaryEmailAddr?.Address
      ? [{ address: c.PrimaryEmailAddr.Address, name: c.DisplayName }]
      : [],
    homeAddress: {
      street:          addr.Line1 ?? '',
      city:            addr.City  ?? '',
      state:           addr.CountrySubDivisionCode ?? '',
      postalCode:      addr.PostalCode ?? '',
      countryOrRegion: 'US',
    },
    categories:    ['JRB Customer'],
    personalNotes: `QBO-CUST-${c.Id}`,
  };
}

function vendorToContact(v) {
  const addr = v.BillAddr ?? {};
  return {
    displayName:    v.DisplayName || [v.GivenName, v.FamilyName].filter(Boolean).join(' ') || 'Unknown',
    givenName:      v.GivenName  ?? '',
    surname:        v.FamilyName ?? '',
    companyName:    v.CompanyName ?? '',
    businessPhones: v.PrimaryPhone?.FreeFormNumber ? [v.PrimaryPhone.FreeFormNumber] : [],
    emailAddresses: v.PrimaryEmailAddr?.Address
      ? [{ address: v.PrimaryEmailAddr.Address, name: v.DisplayName }]
      : [],
    businessAddress: {
      street:          addr.Line1 ?? '',
      city:            addr.City  ?? '',
      state:           addr.CountrySubDivisionCode ?? '',
      postalCode:      addr.PostalCode ?? '',
      countryOrRegion: 'US',
    },
    categories:    ['JRB Vendor'],
    personalNotes: `QBO-VEND-${v.Id}`,
  };
}

// ── Contact folder helpers ────────────────────────────────────

async function getOrCreateContactFolder(userEmail, folderName) {
  const data = await graph('GET', `/users/${userEmail}/contactFolders?$top=100&$select=id,displayName`);
  const found = (data.value ?? []).find(f => f.displayName === folderName);
  if (found) return found.id;

  const created = await graph('POST', `/users/${userEmail}/contactFolders`, { displayName: folderName });
  logger.info('Contact folder created', { userEmail, folderName, id: created.id });
  return created.id;
}

// Returns Map<qboKey, graphContactId> for contacts we previously synced
async function listSyncedContacts(userEmail, folderId) {
  const map = new Map();
  let nextLink = `/users/${userEmail}/contactFolders/${folderId}/contacts?$top=100&$select=id,personalNotes`;

  while (nextLink) {
    const data = await graph('GET', nextLink);
    for (const c of (data.value ?? [])) {
      if (/^QBO-(CUST|VEND)-\w+$/.test(c.personalNotes ?? '')) {
        map.set(c.personalNotes, c.id);
      }
    }
    nextLink = data['@odata.nextLink'] ?? null;
  }
  return map;
}

// ── Per-user sync ─────────────────────────────────────────────

async function syncUserContacts(userEmail, customers, vendors) {
  const [custFolderId, vendFolderId] = await Promise.all([
    getOrCreateContactFolder(userEmail, 'JRB Customers'),
    getOrCreateContactFolder(userEmail, 'JRB Vendors'),
  ]);

  const [existingCust, existingVend] = await Promise.all([
    listSyncedContacts(userEmail, custFolderId),
    listSyncedContacts(userEmail, vendFolderId),
  ]);

  const activeCustKeys = new Set();
  const activeVendKeys = new Set();

  for (const c of customers) {
    const key = `QBO-CUST-${c.Id}`;
    activeCustKeys.add(key);
    const contact = customerToContact(c);
    const existingId = existingCust.get(key);
    if (existingId) {
      await graph('PATCH', `/users/${userEmail}/contactFolders/${custFolderId}/contacts/${existingId}`, contact);
    } else {
      await graph('POST', `/users/${userEmail}/contactFolders/${custFolderId}/contacts`, contact);
    }
  }

  for (const v of vendors) {
    const key = `QBO-VEND-${v.Id}`;
    activeVendKeys.add(key);
    const contact = vendorToContact(v);
    const existingId = existingVend.get(key);
    if (existingId) {
      await graph('PATCH', `/users/${userEmail}/contactFolders/${vendFolderId}/contacts/${existingId}`, contact);
    } else {
      await graph('POST', `/users/${userEmail}/contactFolders/${vendFolderId}/contacts`, contact);
    }
  }

  // Remove contacts that are no longer active in QBO
  let deletedCust = 0, deletedVend = 0;
  for (const [key, id] of existingCust) {
    if (!activeCustKeys.has(key)) {
      await graph('DELETE', `/users/${userEmail}/contactFolders/${custFolderId}/contacts/${id}`);
      deletedCust++;
    }
  }
  for (const [key, id] of existingVend) {
    if (!activeVendKeys.has(key)) {
      await graph('DELETE', `/users/${userEmail}/contactFolders/${vendFolderId}/contacts/${id}`);
      deletedVend++;
    }
  }

  return {
    customers:        customers.length,
    vendors:          vendors.length,
    deletedCustomers: deletedCust,
    deletedVendors:   deletedVend,
  };
}

// ── Employee discovery ────────────────────────────────────────

async function getActiveEmployees() {
  const data = await graph(
    'GET',
    `/users?$filter=accountEnabled eq true and userType eq 'Member'&$select=userPrincipalName,displayName,mail&$top=100`
  );
  return (data.value ?? [])
    .filter(u => u.mail)
    .map(u => u.userPrincipalName);
}

// ── Entry point ───────────────────────────────────────────────

export async function runContactsSync() {
  logger.info('QBO → Outlook contacts sync starting');

  const [customers, vendors, employees] = await Promise.all([
    qboQuery('Customer'),
    qboQuery('Vendor'),
    getActiveEmployees(),
  ]);

  logger.info('Sync data fetched', {
    customers: customers.length,
    vendors:   vendors.length,
    employees: employees.length,
  });

  const results = [];
  for (const userEmail of employees) {
    try {
      const r = await syncUserContacts(userEmail, customers, vendors);
      results.push({ userEmail, ...r, success: true });
      logger.info('Contact sync complete for user', { userEmail, ...r });
    } catch (err) {
      logger.error('Contact sync failed for user', { userEmail, err: err.message });
      results.push({ userEmail, success: false, error: err.message });
    }
  }

  const succeeded = results.filter(r => r.success).length;
  logger.info('QBO → Outlook contacts sync finished', {
    total:     results.length,
    succeeded,
    failed:    results.length - succeeded,
  });

  return { results, succeeded, failed: results.length - succeeded };
}
