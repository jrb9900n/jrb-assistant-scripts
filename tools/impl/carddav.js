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
import { getAllSAAccounts } from './serviceautopilot.js';
import { getAllCachedPhones } from './sa-phone-cache.js';
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

// Exported (in addition to being called internally by handleCardDAV) so it can be
// exercised directly in tests with the external I/O (QBO/SA/Supabase/Graph) mocked
// at the module boundary, without needing a live SA browser session or QBO tokens.
export async function getContacts() {
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) return _cache;

  logger.info('CardDAV: refreshing contact cache');
  let customers, vendors, saAccounts, qboEmployees, empDirectory, saPhoneCache;
  try {
    [customers, vendors, saAccounts, qboEmployees, empDirectory, saPhoneCache] = await Promise.all([
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
      // sa_client_phone_cache (built by PR #362) replaces the old live,
      // capped-at-150 per-account GetClientInfo loop below with one bulk
      // Supabase query covering the full SA account population. Degrades to
      // an empty Map (not a thrown error) on failure — SA-only contacts then
      // fall back to the bulk roster's own single collapsed phone field,
      // same as an account the cache hasn't reached yet.
      getAllCachedPhones().catch(err => {
        logger.warn('CardDAV: SA phone cache load failed — SA-only contacts will fall back to bulk-roster phone data', { err: err.message });
        return new Map();
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
  // (A name-based non-match here doesn't mean "never merged with QBO" —
  // groupCandidates below also unions by phone/email/name across every
  // candidate, so an SA account that slips past this filter under a
  // different display name can still land in the same merged vCard as its
  // QBO counterpart if a phone or email matches.)
  const qboNormalizedNames = new Set(customers.map(c => normalizeName(c.DisplayName || '')));
  const saOnlyRaw = saAccounts
    .filter(c => c.name && !qboNormalizedNames.has(normalizeName(c.name)) && !c.type.toLowerCase().includes('closed'));

  // Phone source: sa_client_phone_cache (bulk-loaded above via
  // getAllCachedPhones), built by the daily backfill/incremental cron in
  // tools/impl/sa-phone-cache.js — a single Supabase query already covering
  // the full ~10,300-account population, replacing the old live, capped
  // (150 accounts/refresh) per-account GetClientInfo loop this file used to
  // run on every 2-hour cache refresh. Every SA-only contact gets a cache
  // lookup now, not just the first 150 — the one real limitation is cache
  // staleness: an account created after the last incremental cron run
  // (daily, 300 accounts/run) simply isn't in the Map yet and falls back to
  // the bulk roster's own single collapsed phone field below, same as
  // before.
  //
  // Address: sourced entirely from the bulk roster (saAccounts) rather than
  // a live per-account call — the cache table has no address columns, and
  // fetching address via a fresh GetClientInfo call per contact would
  // reintroduce the exact live-SA-load problem the phone cache exists to
  // remove. The bulk roster's Address1/City/State/Zip are the same
  // underlying SA record, just possibly a refresh cycle behind if an
  // account's address changed very recently.
  const saCandidates = saOnlyRaw
    .map(c => {
      const cached = saPhoneCache.get(c.clientId);
      const homePhone  = cached?.homePhone  || null;
      const cellPhone  = cached?.cellPhone  || null;
      const workPhone  = cached?.workPhone  || null;
      const otherPhone = cached?.otherPhone || null;
      // Bulk-roster fallback only when the cache has nothing for this account at all
      // (not yet backfilled) — same "collapse to homePhone slot" convention the old
      // per-account fallback used, since the roster only carries one phone field.
      const effectiveHomePhone = homePhone || (!(cellPhone || workPhone || otherPhone) ? (c.phone || null) : null);
      return {
        ...c,
        homePhone: effectiveHomePhone, cellPhone, workPhone, otherPhone,
        address: c.address || null, city: c.city, state: c.state, zip: c.zip,
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
    saPhoneCacheSize: saPhoneCache.size,
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
  // mapSAAccount (serviceautopilot.js) carries Email straight off the bulk roster —
  // populating it here (previously always []) lets groupCandidates below match this
  // SA account against a QBO customer/vendor by email, not just phone/name. isLead
  // feeds mergeCandidateGroup's category choice ("JRB SA Client" vs "JRB SA Lead")
  // for a group that ends up with no QBO customer/vendor member at all.
  const emails = client.email ? [client.email] : [];
  return { key: `sa:${client.clientId}`, source: 'sa', id: client.clientId, givenName, familyName, personName, displayName: raw, companyName, phones, emails, addresses, isLead: !!client.isLead };
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
  const byEmail = new Map();
  const byName = new Map();
  candidates.forEach((cand, i) => {
    for (const { number } of cand.phones) {
      const n = normalizePhone(number);
      if (n.length < 7) continue;
      if (byPhone.has(n)) uf.union(i, byPhone.get(n)); else byPhone.set(n, i);
    }
    // Email is as strong an identity signal as phone (same confidence tier
    // findDuplicateClient uses in serviceautopilot.js) — added so an SA
    // client/lead whose display name doesn't match its QBO counterpart (a
    // legal-name variant, a nickname, a "Last, First" vs. company-name
    // mismatch) can still merge into the same vCard via a shared email,
    // rather than only ever merging on phone or an exact name match.
    for (const e of cand.emails) {
      const key = e.toLowerCase();
      if (!key) continue;
      if (byEmail.has(key)) uf.union(i, byEmail.get(key)); else byEmail.set(key, i);
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

  // A merged group that includes any QBO customer/vendor record keeps the existing
  // "JRB Customer"/"JRB Vendor" grouping (QBO is the billed-relationship source of
  // truth) — this only differs for a group made up entirely of SA candidates, i.e. a
  // lead/client SA knows about that has never been invoiced in QBO at all. Those get
  // their own category, mirroring the existing "JRB Customer"/"JRB Vendor" naming
  // convention: "JRB SA Client" for an active SA client, "JRB SA Lead" for a
  // still-in-pipeline lead. If the group somehow mixes an SA client and an SA lead
  // (e.g. two duplicate SA records for the same person merged by phone/email), the
  // client status wins — an active client relationship is the more specific fact.
  const category = sorted.some(m => m.source === 'customer') ? 'JRB Customer'
    : sorted.some(m => m.source === 'vendor') ? 'JRB Vendor'
    : sorted.some(m => m.source === 'sa' && !m.isLead) ? 'JRB SA Client'
    : sorted.some(m => m.source === 'sa' && m.isLead) ? 'JRB SA Lead'
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
