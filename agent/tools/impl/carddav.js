// tools/impl/carddav.js — CardDAV server for JRB contacts
// Serves QBO customers + vendors as a read-only CardDAV addressbook.
// Employees add agent.jrboehlke.com/carddav as a CardDAV account on their phone.
// Revoking access: set active=false or delete row in carddav_credentials table.
// iOS:     Settings → Contacts → Accounts → Add Account → Other → Add CardDAV Account
// Android: Open Contacts app → Settings → Add account → Other → CardDAV

import axios from 'axios';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';
import { getQBAccessToken } from './qb-token.js';
import { getAllClients } from './serviceautopilot.js';

const QB_BASE = () => `https://quickbooks.api.intuit.com/v3/company/${process.env.QB_REALM_ID}`;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── QBO data fetch ────────────────────────────────────────────

async function fetchQBOEntities(entityType) {
  const token = await getQBAccessToken();
  const results = [];
  let pos = 1;
  while (true) {
    const res = await axios.get(`${QB_BASE()}/query`, {
      params: { query: `SELECT * FROM ${entityType} WHERE Active = true STARTPOSITION ${pos} MAXRESULTS 1000` },
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const rows = res.data.QueryResponse?.[entityType] ?? [];
    results.push(...rows);
    if (rows.length < 1000) break;
    pos += 1000;
  }
  return results;
}

// ── Contact cache (refreshed every 2 hours) ───────────────────

let _cache = null, _cacheTime = 0, _cacheEtag = null;
const CACHE_TTL = 2 * 60 * 60 * 1000;

export function invalidateContactCache() {
  _cache = null;
  _cacheTime = 0;
}

function normalizeName(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

async function getContacts() {
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) return _cache;

  logger.info('CardDAV: refreshing contact cache');
  const [customers, vendors, saClients] = await Promise.all([
    fetchQBOEntities('Customer'),
    fetchQBOEntities('Vendor'),
    getAllClients().catch(err => {
      logger.warn('CardDAV: SA fetch failed, proceeding without SA data', { err: err.message });
      return [];
    }),
  ]);

  // Build SA lookup maps (address overlay + SA-only detection)
  const saByQboId = new Map();
  const saByName  = new Map();
  for (const c of saClients) {
    const addr = c.address ? { Line1: c.address, City: c.city, State: c.state, Zip: c.zip } : null;
    if (!addr) continue;
    if (c.qboId) saByQboId.set(c.qboId, addr);
    const key = normalizeName(c.name);
    if (key) saByName.set(key, addr);
  }

  function saAddrFor(entity) {
    return saByQboId.get(String(entity.Id))
      || saByName.get(normalizeName(entity.DisplayName || ''))
      || null;
  }

  // Group QBO sub-customers under their parent so they appear as one contact
  // with multiple addresses instead of separate duplicate entries
  const customerIds = new Set(customers.map(c => String(c.Id)));
  const byParent = new Map();
  for (const c of customers) {
    if (c.Job && c.ParentRef?.value && customerIds.has(c.ParentRef.value)) {
      const pid = c.ParentRef.value;
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid).push(c);
    }
  }
  const childIds = new Set(
    customers
      .filter(c => c.Job && c.ParentRef?.value && customerIds.has(c.ParentRef.value))
      .map(c => String(c.Id))
  );

  const qboVcards = customers
    .filter(c => !childIds.has(String(c.Id)))
    .map(c => {
      const children = byParent.get(String(c.Id)) ?? [];
      const extraAddrs = children.flatMap(child => {
        const sa = saAddrFor(child);
        if (sa?.Line1) return [sa];
        const qbo = (child.ShipAddr?.Line1 ? child.ShipAddr : child.BillAddr) ?? {};
        return qbo.Line1
          ? [{ Line1: qbo.Line1, City: qbo.City, State: qbo.CountrySubDivisionCode, Zip: qbo.PostalCode }]
          : [];
      });
      return entityToVCard(c, 'customer', saAddrFor(c), extraAddrs);
    });

  // SA-only contacts: in SA but not linked to any active QBO customer
  const saOnlyVcards = saClients
    .filter(c => c.name && c.phone && (!c.qboId || !customerIds.has(String(c.qboId))))
    .map(saClientToVCard);

  _cache = [
    ...qboVcards,
    ...vendors.map(v => entityToVCard(v, 'vendor', null)),
    ...saOnlyVcards,
  ];
  _cacheTime = Date.now();
  _cacheEtag = crypto.createHash('md5').update(String(_cacheTime)).digest('hex');
  logger.info('CardDAV: cache refreshed', {
    qboCustomers: qboVcards.length,
    vendors: vendors.length,
    saOnly: saOnlyVcards.length,
  });
  return _cache;
}

// ── vCard builder ─────────────────────────────────────────────

function escapeVCard(s) {
  return (s ?? '').replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, '\\n');
}

function entityToVCard(entity, type, saAddr, extraAddrs = []) {
  const uid = `JRB-${type.toUpperCase()}-${entity.Id}@jrboehlke.com`;
  const name = escapeVCard(entity.DisplayName || [entity.GivenName, entity.FamilyName].filter(Boolean).join(' ') || 'Unknown');
  const givenName = escapeVCard(entity.GivenName ?? '');
  const familyName = escapeVCard(entity.FamilyName ?? '');
  const company = escapeVCard(entity.CompanyName ?? '');

  const primaryPhone = entity.PrimaryPhone?.FreeFormNumber ?? '';
  const mobilePhone  = entity.Mobile?.FreeFormNumber ?? '';
  const altPhone     = entity.AlternatePhone?.FreeFormNumber ?? '';
  const faxPhone     = entity.Fax?.FreeFormNumber ?? '';

  const email = entity.PrimaryEmailAddr?.Address ?? '';

  // Primary address: SA service address takes priority over QBO ShipAddr/BillAddr
  let primaryAddr;
  if (saAddr?.Line1) {
    primaryAddr = saAddr;
  } else {
    const qbo = (type === 'customer' ? (entity.ShipAddr?.Line1 ? entity.ShipAddr : entity.BillAddr) : entity.BillAddr) ?? {};
    primaryAddr = qbo.Line1 ? { Line1: qbo.Line1, City: qbo.City, State: qbo.CountrySubDivisionCode, Zip: qbo.PostalCode } : null;
  }

  // Collect all unique addresses (primary + sub-customer extras)
  const allAddrs = [];
  const seenAddrs = new Set();
  for (const a of [primaryAddr, ...extraAddrs]) {
    if (a?.Line1 && !seenAddrs.has(a.Line1)) {
      allAddrs.push(a);
      seenAddrs.add(a.Line1);
    }
  }

  const category = type === 'customer' ? 'JRB Customer' : 'JRB Vendor';

  // Deduplicate phone entries so the same number doesn't appear twice
  const seen = new Set();
  function tel(number, telType) {
    const n = (number || '').trim();
    if (!n || seen.has(n)) return null;
    seen.add(n);
    return `TEL;TYPE=${telType}:${escapeVCard(n)}`;
  }

  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `UID:${uid}`,
    `FN:${name}`,
    `N:${familyName};${givenName};;;`,
    company ? `ORG:${company}` : null,
    tel(primaryPhone, 'WORK,VOICE'),
    tel(mobilePhone, 'CELL,VOICE'),
    tel(altPhone, 'WORK,VOICE'),
    tel(faxPhone, 'WORK,FAX'),
    email ? `EMAIL;TYPE=WORK:${escapeVCard(email)}` : null,
    ...allAddrs.map(a => `ADR;TYPE=WORK:;;${escapeVCard(a.Line1)};${escapeVCard(a.City ?? '')};${escapeVCard(a.State ?? '')};${escapeVCard(a.Zip ?? '')};US`),
    `CATEGORIES:${category}`,
    `NOTE:${uid}`,
    'END:VCARD',
  ].filter(Boolean).join('\r\n');

  const etag = crypto.createHash('md5').update(uid + name + primaryPhone + mobilePhone + altPhone + email + allAddrs.map(a => a.Line1).join('|')).digest('hex');
  return { uid, etag, vcard: lines };
}

function saClientToVCard(client) {
  const uid = `JRB-SA-${client.clientId}@jrboehlke.com`;
  // SA stores names as "Last, First" — reformat to "First Last" for FN field
  const raw = client.name || '';
  const parts = raw.split(',');
  let givenName = '', familyName = '', fn;
  if (parts.length === 2) {
    familyName = escapeVCard(parts[0].trim());
    givenName  = escapeVCard(parts[1].trim());
    fn = escapeVCard(`${parts[1].trim()} ${parts[0].trim()}`);
  } else {
    fn = escapeVCard(raw);
  }

  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `UID:${uid}`,
    `FN:${fn}`,
    `N:${familyName};${givenName};;;`,
    client.phone ? `TEL;TYPE=WORK,VOICE:${escapeVCard(client.phone)}` : null,
    client.address ? `ADR;TYPE=WORK:;;${escapeVCard(client.address)};${escapeVCard(client.city ?? '')};${escapeVCard(client.state ?? '')};${escapeVCard(client.zip ?? '')};US` : null,
    'CATEGORIES:JRB Customer',
    `NOTE:${uid}`,
    'END:VCARD',
  ].filter(Boolean).join('\r\n');

  const etag = crypto.createHash('md5').update(uid + fn + (client.phone ?? '') + (client.address ?? '')).digest('hex');
  return { uid, etag, vcard: lines };
}

// ── Credential check ──────────────────────────────────────────

export async function checkCredentials(username, password) {
  const { data } = await supabase
    .from('carddav_credentials')
    .select('id, name, active')
    .eq('email', username.toLowerCase())
    .eq('token', password)
    .single();

  if (!data || !data.active) return null;

  // Update last_used async (don't await)
  supabase.from('carddav_credentials').update({ last_used: new Date().toISOString() }).eq('id', data.id).then(() => {});
  return data;
}

// ── XML helpers ───────────────────────────────────────────────

function xmlResponse(status, body) {
  return { status, headers: { 'Content-Type': 'application/xml; charset=utf-8' }, body: `<?xml version="1.0" encoding="utf-8"?>\n${body}` };
}

// ── CardDAV request handler ───────────────────────────────────
// Called from teams/bot.js for requests under /carddav/

export async function handleCardDAV(req, res) {
  const method = req.method.toUpperCase();
  const path = req.path;

  // Basic auth
  const authHeader = req.headers.authorization ?? '';
  const [scheme, encoded] = authHeader.split(' ');
  if (scheme?.toLowerCase() !== 'basic' || !encoded) {
    res.set('WWW-Authenticate', 'Basic realm="JRB Contacts"');
    return res.status(401).send('Authentication required');
  }

  const [username, ...rest] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
  const password = rest.join(':');
  const user = await checkCredentials(username, password);

  if (!user) {
    res.set('WWW-Authenticate', 'Basic realm="JRB Contacts"');
    return res.status(401).send('Invalid credentials');
  }

  // OPTIONS — announce CardDAV support
  if (method === 'OPTIONS') {
    res.set('DAV', '1, 3, addressbook');
    res.set('Allow', 'OPTIONS, GET, HEAD, PROPFIND, REPORT');
    return res.status(200).send('');
  }

  // Well-known redirect → principal
  if (method === 'GET' && path === '/carddav') {
    return res.redirect(301, '/carddav/');
  }

  // PROPFIND on principal or root → point to addressbook home
  if (method === 'PROPFIND' && (path === '/carddav/' || path === '/carddav')) {
    res.set('DAV', '1, 3, addressbook');
    const xml = `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:response>
    <D:href>/carddav/</D:href>
    <D:propstat>
      <D:prop>
        <D:current-user-principal><D:href>/carddav/principal/</D:href></D:current-user-principal>
        <D:resourcetype><D:collection/></D:resourcetype>
        <C:addressbook-home-set><D:href>/carddav/addressbooks/</D:href></C:addressbook-home-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
    return res.status(207).set('Content-Type', 'application/xml; charset=utf-8').send(`<?xml version="1.0" encoding="utf-8"?>\n${xml}`);
  }

  // PROPFIND on principal
  if (method === 'PROPFIND' && path.startsWith('/carddav/principal')) {
    res.set('DAV', '1, 3, addressbook');
    const xml = `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:response>
    <D:href>/carddav/principal/</D:href>
    <D:propstat>
      <D:prop>
        <D:current-user-principal><D:href>/carddav/principal/</D:href></D:current-user-principal>
        <C:addressbook-home-set><D:href>/carddav/addressbooks/</D:href></C:addressbook-home-set>
        <D:displayname>${escapeVCard(user.name)}</D:displayname>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
    return res.status(207).set('Content-Type', 'application/xml; charset=utf-8').send(`<?xml version="1.0" encoding="utf-8"?>\n${xml}`);
  }

  // PROPFIND on addressbook home → list addressbooks
  if (method === 'PROPFIND' && path.startsWith('/carddav/addressbooks')) {
    res.set('DAV', '1, 3, addressbook');
    const contacts = await getContacts();
    const xml = `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:response>
    <D:href>/carddav/addressbooks/jrb/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>
        <D:displayname>JRB Contacts</D:displayname>
        <D:getctag>${_cacheEtag ?? 'init'}</D:getctag>
        <D:sync-token>/carddav/sync/${_cacheEtag ?? 'init'}</D:sync-token>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
    return res.status(207).set('Content-Type', 'application/xml; charset=utf-8').send(`<?xml version="1.0" encoding="utf-8"?>\n${xml}`);
  }

  // REPORT or PROPFIND on addressbook itself — return all contact ETags + hrefs
  if ((method === 'REPORT' || method === 'PROPFIND') && path.startsWith('/carddav/addressbooks/jrb')) {
    // Check if this is a request for full vcard data or just props
    const bodyStr = req.body?.toString?.() ?? '';
    const wantsAddressData = bodyStr.includes('address-data') || bodyStr.includes('addressbook-multiget');

    res.set('DAV', '1, 3, addressbook');
    const contacts = await getContacts();

    const responses = contacts.map(c => {
      const vcardBlock = wantsAddressData
        ? `<C:address-data>${c.vcard.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</C:address-data>`
        : '';
      return `  <D:response>
    <D:href>/carddav/addressbooks/jrb/${c.uid}.vcf</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag>"${c.etag}"</D:getetag>
        ${vcardBlock}
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
    }).join('\n');

    const xml = `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
${responses}
</D:multistatus>`;
    return res.status(207).set('Content-Type', 'application/xml; charset=utf-8').send(`<?xml version="1.0" encoding="utf-8"?>\n${xml}`);
  }

  // GET individual vCard
  const vcfMatch = path.match(/\/carddav\/addressbooks\/jrb\/(.+)\.vcf$/);
  if (method === 'GET' && vcfMatch) {
    const uid = decodeURIComponent(vcfMatch[1]);
    const contacts = await getContacts();
    const contact = contacts.find(c => c.uid === uid);
    if (!contact) return res.status(404).send('Not found');
    return res.status(200)
      .set('Content-Type', 'text/vcard; charset=utf-8')
      .set('ETag', `"${contact.etag}"`)
      .send(contact.vcard);
  }

  return res.status(404).send('Not found');
}

// ── Credential management helpers (called from agent tools) ───

export async function provisionCredential({ email, name }) {
  const token = crypto.randomBytes(9).toString('base64url'); // 12 chars, easier to type on phone
  const { data, error } = await supabase
    .from('carddav_credentials')
    .upsert({ email: email.toLowerCase(), name, token, active: true }, { onConflict: 'email' })
    .select()
    .single();
  if (error) throw error;
  return { email, name, token, server: 'https://agent.jrboehlke.com/carddav/' };
}

export async function revokeCredential(email) {
  const { error } = await supabase
    .from('carddav_credentials')
    .update({ active: false })
    .eq('email', email.toLowerCase());
  if (error) throw error;
  return { revoked: email };
}

export async function listCredentials() {
  const { data, error } = await supabase
    .from('carddav_credentials')
    .select('email, name, active, created_at, last_used')
    .order('name');
  if (error) throw error;
  return data;
}
