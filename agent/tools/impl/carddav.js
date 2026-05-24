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

function normalizeName(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

async function buildSAAddressMap() {
  try {
    const clients = await getAllClients();
    const byQboId = new Map();
    const byName  = new Map();
    for (const c of clients) {
      const addr = c.address ? { Line1: c.address, City: c.city, State: c.state, Zip: c.zip } : null;
      if (!addr) continue;
      if (c.qboId) byQboId.set(c.qboId, addr);
      const key = normalizeName(c.name);
      if (key) byName.set(key, addr);
    }
    logger.info('CardDAV: SA address map built', { byQboId: byQboId.size, byName: byName.size });
    return { byQboId, byName };
  } catch (err) {
    logger.warn('CardDAV: SA address fetch failed, proceeding without SA addresses', { err: err.message });
    return { byQboId: new Map(), byName: new Map() };
  }
}

async function getContacts() {
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) return _cache;

  logger.info('CardDAV: refreshing contact cache');
  const [customers, vendors, saMap] = await Promise.all([
    fetchQBOEntities('Customer'),
    fetchQBOEntities('Vendor'),
    buildSAAddressMap(),
  ]);

  function saAddrFor(entity) {
    return saMap.byQboId.get(String(entity.Id))
      || saMap.byName.get(normalizeName(entity.DisplayName || ''))
      || null;
  }

  _cache = [
    ...customers.map(c => entityToVCard(c, 'customer', saAddrFor(c))),
    ...vendors.map(v => entityToVCard(v, 'vendor', null)),
  ];
  _cacheTime = Date.now();
  _cacheEtag = crypto.createHash('md5').update(String(_cacheTime)).digest('hex');
  logger.info('CardDAV: cache refreshed', { customers: customers.length, vendors: vendors.length });
  return _cache;
}

// ── vCard builder ─────────────────────────────────────────────

function escapeVCard(s) {
  return (s ?? '').replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, '\\n');
}

function entityToVCard(entity, type, saAddr) {
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

  // Address: SA service address takes priority over QBO ShipAddr/BillAddr
  let addr;
  if (saAddr?.Line1) {
    addr = saAddr;
  } else {
    const qbo = (type === 'customer' ? (entity.ShipAddr?.Line1 ? entity.ShipAddr : entity.BillAddr) : entity.BillAddr) ?? {};
    addr = qbo.Line1 ? { Line1: qbo.Line1, City: qbo.City, State: qbo.CountrySubDivisionCode, Zip: qbo.PostalCode } : null;
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
    addr?.Line1 ? `ADR;TYPE=WORK:;;${escapeVCard(addr.Line1)};${escapeVCard(addr.City ?? '')};${escapeVCard(addr.State ?? '')};${escapeVCard(addr.Zip ?? '')};US` : null,
    `CATEGORIES:${category}`,
    `NOTE:${uid}`,
    'END:VCARD',
  ].filter(Boolean).join('\r\n');

  const etag = crypto.createHash('md5').update(uid + name + primaryPhone + mobilePhone + altPhone + email + (addr?.Line1 ?? '')).digest('hex');
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
