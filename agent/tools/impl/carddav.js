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
import { getAllSAAccounts, getSAClientDetails } from './serviceautopilot.js';
import { fetchEmployeeDirectory } from './m365.js';

const QB_BASE = () => `https://quickbooks.api.intuit.com/v3/company/${process.env.QB_REALM_ID}`;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── QBO data fetch ────────────────────────────────────────────

async function fetchQBOEntities(entityType) {
  let token;
  try {
    token = await getQBAccessToken();
  } catch (err) {
    logger.error('CardDAV: QB token refresh failed — re-auth required at /qb-reauth', {
      status: err.response?.status,
      err: err.message,
    });
    throw err;
  }
  const results = [];
  let pos = 1;
  while (true) {
    let res;
    try {
      res = await axios.get(`${QB_BASE()}/query`, {
        params: { query: `SELECT * FROM ${entityType} WHERE Active = true STARTPOSITION ${pos} MAXRESULTS 1000` },
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
    } catch (err) {
      logger.error('CardDAV: QBO fetch failed', {
        entity: entityType,
        status: err.response?.status,
        url: err.config?.url,
        data: err.response?.data,
        message: err.message,
      });
      throw err;
    }
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

const LEGAL_SUFFIXES = /\s+(inc|llc|corp|ltd|co|incorporated|corporation|limited)\s*$/;

function normalizeName(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(LEGAL_SUFFIXES, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePhone(p) {
  const digits = (p || '').replace(/\D/g, '');
  // Strip a leading US country code so "12622439924" and "2622439924" match as the
  // same number instead of silently missing a cross-source duplicate.
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

async function getContacts() {
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) return _cache;

  logger.info('CardDAV: refreshing contact cache');
  let customers, vendors, saAccounts, qboEmployees, empDirectory;
  try {
    [customers, vendors, saAccounts, qboEmployees, empDirectory] = await Promise.all([
      fetchQBOEntities('Customer'),
      fetchQBOEntities('Vendor'),
      getAllSAAccounts().catch(err => {
        logger.warn('CardDAV: SA account fetch failed', { err: err.message });
        return [];
      }),
      fetchQBOEntities('Employee').catch(err => {
        logger.warn('CardDAV: QBO Employee fetch failed — employees will be omitted from this refresh', { err: err.message });
        return [];
      }),
      fetchEmployeeDirectory().catch(err => {
        logger.warn('CardDAV: Employee Directory fetch failed — employees will appear without directory phones', { err: err.message });
        return [];
      }),
    ]);
  } catch (err) {
    if (_cache) {
      logger.warn('CardDAV: cache refresh failed — serving stale cache', { err: err.message });
      return _cache;
    }
    throw err;
  }

  // Build name→phone lookup from SharePoint Employee Directory (authoritative phone source)
  const dirPhoneByName = new Map();
  for (const emp of empDirectory) {
    const key = normalizeName(emp.name);
    if (key && emp.phone) dirPhoneByName.set(key, emp.phone);
  }

  // Employee personal phones — excluded from the merge pool below so an employee's
  // own SA/QBO record never gets pulled in as if it were a separate customer contact.
  const employeePhones = new Set();
  for (const e of qboEmployees) {
    for (const num of [e.PrimaryPhone?.FreeFormNumber, e.Mobile?.FreeFormNumber, e.AlternatePhone?.FreeFormNumber]) {
      const n = normalizePhone(num);
      if (n.length >= 7) employeePhones.add(n);
    }
  }

  // Build SA lookup maps (address overlay + SA-only detection)
  const saByQboId = new Map();
  const saByName  = new Map();
  for (const c of saAccounts) {
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

  // One candidate per top-level QBO customer, with sub-customers' phones/emails/addresses
  // folded in (rather than emitted as separate contacts) so a parent + its jobs appear
  // as one entry with everything on it.
  const customerCandidates = customers
    .filter(c => !childIds.has(String(c.Id)))
    .map(c => {
      const children = byParent.get(String(c.Id)) ?? [];
      const phones = qboPhoneList(c);
      const emails = qboEmailList(c);
      const addresses = qboAddressList(c, saAddrFor(c), 'customer');
      for (const child of children) {
        phones.push(...qboPhoneList(child));
        emails.push(...qboEmailList(child));
        addresses.push(...qboAddressList(child, saAddrFor(child), 'customer'));
      }
      return makeQboCandidate(c, 'customer', phones, emails, addresses);
    });

  const vendorCandidates = vendors.map(v =>
    makeQboCandidate(v, 'vendor', qboPhoneList(v), qboEmailList(v), qboAddressList(v, null, 'vendor'))
  );

  // SA-only contacts: in SA but not matched to any active QBO customer by name.
  // SA's QboID sync is not configured, so we name-match instead of ID-match.
  // SA bulk list has no phone fields — requires per-account GetClientInfo.
  // Leads are prioritized first so they always make it within the fetch cap.
  const qboNormalizedNames = new Set(customers.map(c => normalizeName(c.DisplayName || '')));
  const saOnlyRaw = saAccounts
    .filter(c => c.name && !qboNormalizedNames.has(normalizeName(c.name)) && !c.type.toLowerCase().includes('closed'))
    .sort((a, b) => (b.isLead ? 1 : 0) - (a.isLead ? 1 : 0));

  // Fetch per-account phone numbers for the top N SA-only contacts (leads first).
  // SA bulk list phone fields are often empty — GetClientInfo gives the definitive number.
  // Contacts beyond the cap fall back to the bulk-list phone (if populated) or appear
  // address-only. No contact is silently excluded just because it's past position N.
  const PHONE_FETCH_CAP = 150;
  const PHONE_CONCURRENCY = 5;
  const saOnlyForPhones = saOnlyRaw.slice(0, PHONE_FETCH_CAP);
  // saDetailById tracks every account that was attempted via GetClientInfo so the outer map
  // can distinguish "API returned no data" from "account was never fetched" and apply
  // bulk-list fallbacks only to beyond-cap accounts.
  // GetClientInfo returns both phone AND address in one call — no extra API cost.
  const saDetailById = new Map();
  try {
    for (let i = 0; i < saOnlyForPhones.length; i += PHONE_CONCURRENCY) {
      const batch = saOnlyForPhones.slice(i, i + PHONE_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async c => {
          try {
            const detail = await getSAClientDetails(c.clientId);
            return [c.clientId, {
              homePhone:  detail.homePhone  || null,
              cellPhone:  detail.cellPhone  || null,
              workPhone:  detail.workPhone  || null,
              otherPhone: detail.otherPhone || null,
              address: detail.address || null, city: detail.city, state: detail.state, zip: detail.zip,
            }];
          } catch {
            // API error — fall back to bulk-list data; bulk collapses to one phone so put it in homePhone
            return [c.clientId, {
              homePhone: c.phone || null, cellPhone: null, workPhone: null, otherPhone: null,
              address: c.address || null, city: c.city, state: c.state, zip: c.zip,
            }];
          }
        })
      );
      for (const [id, detail] of batchResults) saDetailById.set(id, detail); // Store null phone/addr to mark "fetched"
    }
  } catch (err) {
    logger.warn('CardDAV: SA detail fetch failed, using bulk-list data only', { err: err.message });
    // Preserve any API-fetched entries; add bulk data only for unfetched accounts.
    for (const c of saOnlyForPhones) {
      if (!saDetailById.has(c.clientId)) {
        saDetailById.set(c.clientId, {
          homePhone: c.phone || null, cellPhone: null, workPhone: null, otherPhone: null,
          address: c.address || null, city: c.city, state: c.state, zip: c.zip,
        });
      }
    }
  }

  // All SA-only contacts, not just those within the phone-fetch cap.
  // Within-cap: API phone+address (may be null/empty); beyond-cap: bulk-list data.
  // API address takes priority over bulk-list address when both exist.
  // These no longer get silently dropped when a phone matches a QBO contact — instead
  // they're fed into the same merge pool as QBO customers/vendors below, so any phone,
  // address, or email SA has that QBO doesn't gets folded into the merged contact
  // instead of being discarded.
  const saCandidates = saOnlyRaw
    .map(c => {
      const detail = saDetailById.get(c.clientId);
      const apiAddr = detail?.address || null;
      // API returns all four phone fields; bulk list collapses to one phone.
      // Fall back to bulk-list phone (in homePhone slot) when API returned no phones at all —
      // covers beyond-cap accounts (detail undefined) and accounts whose phones are only in
      // SA's Phone1/PhoneNumber fields that GetClientInfo doesn't check.
      const homePhone  = detail?.homePhone  || null;
      const cellPhone  = detail?.cellPhone  || null;
      const workPhone  = detail?.workPhone  || null;
      const otherPhone = detail?.otherPhone || null;
      const effectiveHomePhone = homePhone || (!(cellPhone || workPhone || otherPhone) ? (c.phone || null) : null);
      return {
        ...c,
        homePhone: effectiveHomePhone, cellPhone, workPhone, otherPhone,
        address: apiAddr || c.address || null,
        city:    apiAddr ? detail.city : c.city,
        state:   apiAddr ? detail.state : c.state,
        zip:     apiAddr ? detail.zip : c.zip,
      };
    })
    .filter(c => {
      if (!c.homePhone && !c.cellPhone && !c.workPhone && !c.otherPhone && !c.address) return false;
      // An employee's own personal number shouldn't surface as a separate customer contact
      for (const ph of [c.homePhone, c.cellPhone, c.workPhone, c.otherPhone]) {
        if (ph && employeePhones.has(normalizePhone(ph))) return false;
      }
      return true;
    })
    .map(makeSaCandidate);

  // Merge candidates that represent the same real-world entity — whether that's a QBO
  // customer + vendor record for the same business, or an SA client whose phone/name
  // matches a QBO contact — into one vCard carrying every phone, email, address, and
  // company name found across all matched source records.
  const mergedVcards = groupCandidates([...customerCandidates, ...vendorCandidates, ...saCandidates])
    .map(mergeCandidateGroup);

  // Build employee vCards: QBO active employees + SharePoint directory phone overlay
  const employeeVcards = qboEmployees.map(emp => {
    const nameKey = normalizeName([emp.GivenName, emp.FamilyName].filter(Boolean).join(' ') || emp.DisplayName || '');
    const dirPhone = dirPhoneByName.get(nameKey) ?? null;
    return employeeToVCard(emp, dirPhone);
  });

  _cache = [...mergedVcards, ...employeeVcards];
  _cacheTime = Date.now();
  _cacheEtag = crypto.createHash('md5').update(String(_cacheTime)).digest('hex');
  logger.info('CardDAV: cache refreshed', {
    customers: customerCandidates.length,
    vendors: vendorCandidates.length,
    saCandidates: saCandidates.length,
    saOnlyRaw: saOnlyRaw.length,
    mergedContacts: mergedVcards.length,
    employees: employeeVcards.length,
  });
  return _cache;
}

// ── vCard builder ─────────────────────────────────────────────

function escapeVCard(s) {
  return (s ?? '').replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, '\\n');
}

// A "candidate" is one source record (QBO customer, QBO vendor, or SA client) normalized
// into a common shape so records representing the same real-world entity — the same
// business listed as both a QBO customer and vendor, or an SA client that matches a QBO
// contact by phone or name — can be found and merged into a single vCard below.

function qboPhoneList(entity) {
  return [
    [entity.PrimaryPhone?.FreeFormNumber, 'WORK,VOICE'],
    [entity.Mobile?.FreeFormNumber, 'CELL,VOICE'],
    [entity.AlternatePhone?.FreeFormNumber, 'WORK,VOICE'],
    [entity.Fax?.FreeFormNumber, 'WORK,FAX'],
  ]
    .filter(([number]) => number)
    .map(([number, telType]) => ({ number, telType }));
}

function qboEmailList(entity) {
  return entity.PrimaryEmailAddr?.Address ? [entity.PrimaryEmailAddr.Address] : [];
}

function qboAddressList(entity, saAddr, type) {
  // SA service address takes priority over QBO ShipAddr/BillAddr
  if (saAddr?.Line1) return [saAddr];
  const qbo = (type === 'customer' ? (entity.ShipAddr?.Line1 ? entity.ShipAddr : entity.BillAddr) : entity.BillAddr) ?? {};
  return qbo.Line1 ? [{ Line1: qbo.Line1, City: qbo.City, State: qbo.CountrySubDivisionCode, Zip: qbo.PostalCode }] : [];
}

function makeQboCandidate(entity, source, phones, emails, addresses) {
  const givenName = entity.GivenName ?? '';
  const familyName = entity.FamilyName ?? '';
  const personName = [givenName, familyName].filter(Boolean).join(' ');
  const displayName = entity.DisplayName ?? '';
  // CompanyName is the authoritative company field. When it's blank but DisplayName is
  // clearly not just the contact person's name (e.g. QBO customer "City of Oconomowoc"
  // with GivenName/FamilyName "Heath"/"Brozovich"), treat DisplayName as the company name
  // so it still reaches the ORG field instead of being lost.
  const companyName = entity.CompanyName
    || (personName && displayName && normalizeName(displayName) !== normalizeName(personName) ? displayName : '');
  return { key: `${source}:${entity.Id}`, source, id: entity.Id, givenName, familyName, personName, displayName, companyName, phones, emails, addresses };
}

// Business names can contain exactly one comma too (e.g. "Smith, Jones & Associates",
// "A-1 Roofing, Inc") — treat a comma-split as a person only when neither side carries
// a business marker, so those aren't misparsed into a spurious "person name" that could
// then trigger a false name-match merge against an unrelated real person.
const BUSINESS_MARKER = /\b(llc|inc|corp|co|company|associates|group|partners|services|enterprises|holdings|ltd)\b|&/i;

function makeSaCandidate(client) {
  // SA stores individuals as "Last, First"; company-only accounts are stored as a plain name.
  const raw = client.name || '';
  const parts = raw.split(',');
  let givenName = '', familyName = '', companyName = '';
  if (parts.length === 2 && !BUSINESS_MARKER.test(parts[0]) && !BUSINESS_MARKER.test(parts[1])) {
    familyName = parts[0].trim();
    givenName = parts[1].trim();
  } else {
    companyName = raw.trim();
  }
  const personName = [givenName, familyName].filter(Boolean).join(' ');
  const phones = [
    [client.homePhone, 'HOME,VOICE'],
    [client.cellPhone, 'CELL,VOICE'],
    [client.workPhone, 'WORK,VOICE'],
    [client.otherPhone, 'VOICE'],
  ]
    .filter(([number]) => number)
    .map(([number, telType]) => ({ number, telType }));
  const addresses = client.address ? [{ Line1: client.address, City: client.city, State: client.state, Zip: client.zip }] : [];
  return { key: `sa:${client.clientId}`, source: 'sa', id: client.clientId, givenName, familyName, personName, displayName: raw, companyName, phones, emails: [], addresses };
}

// Union-find so any number of candidates chained together by a shared phone number or
// a matching name all end up in one group, not just pairs.
class UnionFind {
  constructor(n) { this.parent = Array.from({ length: n }, (_, i) => i); }
  find(x) { while (this.parent[x] !== x) { this.parent[x] = this.parent[this.parent[x]]; x = this.parent[x]; } return x; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent[ra] = rb; }
}

function groupCandidates(candidates) {
  const uf = new UnionFind(candidates.length);
  const byPhone = new Map();
  const byName = new Map();
  candidates.forEach((cand, i) => {
    for (const { number } of cand.phones) {
      const n = normalizePhone(number);
      if (n.length < 7) continue;
      if (byPhone.has(n)) uf.union(i, byPhone.get(n)); else byPhone.set(n, i);
    }
    // Require 2+ words before matching by name — a single generic token ("Kevin") is too
    // common to safely identify one real-world entity and would merge unrelated customers
    // who happen to share a first name with no phone number to disambiguate them.
    const nameKey = normalizeName(cand.personName || cand.companyName || cand.displayName || '');
    if (nameKey && nameKey.includes(' ')) {
      if (byName.has(nameKey)) uf.union(i, byName.get(nameKey)); else byName.set(nameKey, i);
    }
  });
  const groups = new Map();
  candidates.forEach((cand, i) => {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(cand);
  });
  return [...groups.values()];
}

// QBO customer records win ties for identity fields (name, UID) since QBO is the
// authoritative source; vendor, then SA, fill in gaps.
const SOURCE_PRIORITY = { customer: 0, vendor: 1, sa: 2 };

function mergeCandidateGroup(members) {
  const sorted = [...members].sort((a, b) =>
    (SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source]) || String(a.id).localeCompare(String(b.id))
  );
  const primary = sorted[0];
  const uid = `JRB-${primary.source.toUpperCase()}-${primary.id}@jrboehlke.com`;

  const withPersonName = sorted.find(m => m.personName);
  const givenName = withPersonName?.givenName ?? '';
  const familyName = withPersonName?.familyName ?? '';
  const personName = withPersonName?.personName ?? '';

  const companyName = sorted.map(m => m.companyName).find(Boolean) ?? '';
  const fn = personName || companyName || sorted.find(m => m.displayName)?.displayName || 'Unknown';

  const phones = [];
  const seenPhone = new Set();
  for (const m of sorted) for (const p of m.phones) {
    const n = normalizePhone(p.number);
    if (!n || seenPhone.has(n)) continue;
    seenPhone.add(n);
    phones.push(p);
  }

  const emails = [];
  const seenEmail = new Set();
  for (const m of sorted) for (const e of m.emails) {
    const key = e.toLowerCase();
    if (!key || seenEmail.has(key)) continue;
    seenEmail.add(key);
    emails.push(e);
  }

  const addresses = [];
  const seenAddr = new Set();
  for (const m of sorted) for (const a of m.addresses) {
    if (a?.Line1 && !seenAddr.has(a.Line1)) { seenAddr.add(a.Line1); addresses.push(a); }
  }

  const category = sorted.some(m => m.source === 'customer') ? 'JRB Customer'
    : sorted.some(m => m.source === 'vendor') ? 'JRB Vendor'
    : 'JRB Customer';

  // Lists every source record folded into this contact — makes it possible to trace,
  // for a given phone number, which QBO/SA records fed into what the phone displays.
  const sourceUids = sorted.map(m => `JRB-${m.source.toUpperCase()}-${m.id}`);

  return buildVCard({ uid, fn, givenName, familyName, companyName, phones, emails, addresses, category, sourceUids });
}

function buildVCard({ uid, fn, givenName, familyName, companyName, phones, emails, addresses, category, sourceUids }) {
  const seenTel = new Set();
  const telLines = phones
    .map(({ number, telType }) => {
      const n = (number || '').trim();
      if (!n || seenTel.has(n)) return null;
      seenTel.add(n);
      return `TEL;TYPE=${telType}:${escapeVCard(n)}`;
    })
    .filter(Boolean);

  const emailLines = emails.map(e => `EMAIL;TYPE=WORK:${escapeVCard(e)}`);
  const addrLines = addresses.map(a =>
    `ADR;TYPE=WORK:;;${escapeVCard(a.Line1)};${escapeVCard(a.City ?? '')};${escapeVCard(a.State ?? '')};${escapeVCard(a.Zip ?? '')};US`
  );

  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `UID:${uid}`,
    `FN:${escapeVCard(fn)}`,
    `N:${escapeVCard(familyName)};${escapeVCard(givenName)};;;`,
    companyName ? `ORG:${escapeVCard(companyName)}` : null,
    ...telLines,
    ...emailLines,
    ...addrLines,
    `CATEGORIES:${category}`,
    `NOTE:${sourceUids.join(', ')}`,
    'END:VCARD',
  ].filter(Boolean).join('\r\n');

  const etag = crypto.createHash('md5')
    .update(uid + fn + companyName + telLines.join('|') + emailLines.join('|') + addrLines.join('|') + category + sourceUids.join('|'))
    .digest('hex');
  return { uid, etag, vcard: lines };
}

function employeeToVCard(emp, dirPhone) {
  const uid = `JRB-EMPLOYEE-${emp.Id}@jrboehlke.com`;
  const givenName  = escapeVCard(emp.GivenName  ?? '');
  const familyName = escapeVCard(emp.FamilyName ?? '');
  const name = (givenName || familyName)
    ? escapeVCard([emp.GivenName, emp.FamilyName].filter(Boolean).join(' '))
    : escapeVCard(emp.DisplayName || 'Unknown');

  const primaryPhone = emp.PrimaryPhone?.FreeFormNumber ?? '';
  const mobilePhone  = emp.Mobile?.FreeFormNumber ?? '';
  const email = emp.PrimaryEmailAddr?.Address ?? '';

  const addr = emp.PrimaryAddr;

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
    'ORG:J.R. Boehlke',
    tel(dirPhone, 'CELL,VOICE'),
    tel(primaryPhone, 'WORK,VOICE'),
    tel(mobilePhone, 'CELL,VOICE'),
    email ? `EMAIL;TYPE=WORK:${escapeVCard(email)}` : null,
    addr?.Line1 ? `ADR;TYPE=WORK:;;${escapeVCard(addr.Line1)};${escapeVCard(addr.City ?? '')};${escapeVCard(addr.CountrySubDivisionCode ?? '')};${escapeVCard(addr.PostalCode ?? '')};US` : null,
    'CATEGORIES:JRB Employee',
    `NOTE:${uid}`,
    'END:VCARD',
  ].filter(Boolean).join('\r\n');

  const etag = crypto.createHash('md5').update(uid + name + (dirPhone ?? '') + primaryPhone + mobilePhone + email + (addr?.Line1 ?? '')).digest('hex');
  return { uid, etag, vcard: lines };
}

// ── Per-user exclusion list ───────────────────────────────────

async function getUserExclusions(credentialId) {
  const { data } = await supabase
    .from('carddav_exclusions')
    .select('uid')
    .eq('credential_id', credentialId);
  return new Set((data ?? []).map(r => r.uid));
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
    res.set('Allow', 'OPTIONS, GET, HEAD, PROPFIND, REPORT, DELETE');
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
    const [allContacts, exclusions] = await Promise.all([getContacts(), getUserExclusions(user.id)]);
    const contacts = allContacts.filter(c => !exclusions.has(c.uid));

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

  // GET / DELETE individual vCard
  const vcfMatch = path.match(/\/carddav\/addressbooks\/jrb\/(.+)\.vcf$/);
  if (vcfMatch) {
    const uid = decodeURIComponent(vcfMatch[1]);

    // DELETE — add to this user's exclusion list so it never comes back
    if (method === 'DELETE') {
      await supabase
        .from('carddav_exclusions')
        .upsert({ credential_id: user.id, uid }, { onConflict: 'credential_id,uid' });
      return res.status(204).send('');
    }

    if (method === 'GET') {
      const [contacts, exclusions] = await Promise.all([getContacts(), getUserExclusions(user.id)]);
      const contact = contacts.find(c => c.uid === uid && !exclusions.has(c.uid));
      if (!contact) return res.status(404).send('Not found');
      return res.status(200)
        .set('Content-Type', 'text/vcard; charset=utf-8')
        .set('ETag', `"${contact.etag}"`)
        .send(contact.vcard);
    }
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
