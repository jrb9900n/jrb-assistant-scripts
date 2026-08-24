// tools/impl/sa-client-classification.js — Client account-type + service-line
// tagging: taxonomy setup, signal-based classification, dry-run report, and
// the backfill executor. See CLAUDE.md "Client Categorization" for the design.

import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';
import { logger } from '../../core/logger.js';
import {
  getTagCategories, findOrCreateTagCategory, findOrCreateTag, listTags,
  getClientsByTag, getAllSAAccounts, addTagToClient, saveClientFields,
} from './serviceautopilot.js';
import { HISTORY_SERVICE_CODE_MAP, getHistoryServiceMap, matchHistoryAccountsToCurrent, mergeHistoryIntoServiceMap } from './sa-history-match.js';
import { normalizeAddress, normalizeEmail } from './fuzzy-match.js';

const fleetops = createClient(
  process.env.FLEETOPS_SUPABASE_URL,
  process.env.FLEETOPS_SUPABASE_SERVICE_KEY
);

const CLIENT_TYPE_CATEGORY_NAME = 'Client Type';
const SERVICE_LINE_CATEGORY_NAME = 'Service Line';

// "Commercial - HOA" already exists in production (created by Michael before this
// system existed) — reused as-is rather than duplicated under a new name.
// "Commercial - General Contractor" added 2026-08-19 per Michael's manual review —
// distinct from "GC Subcontract" (a client referred TO us BY a GC) — this is for
// clients whose own business IS general contracting/architecture (e.g. "Abacus
// Architects", "Arco/Murray").
const ACCOUNT_TYPE_TAGS = ['Residential', 'Commercial - Direct', 'Commercial - HOA', 'Commercial - Property Mgmt', 'Municipal/Government', 'GC Subcontract', 'Commercial - General Contractor'];
const SERVICE_LINE_TAGS = ['Snow', 'Lawn/Landscape', 'Paving', 'Concrete'];

// SA's native AccountType dropdown only has two real values (confirmed live 2026-08-19
// via GetAccountTypeList) — no HOA/Municipal/GC granularity exists there. It gets the
// coarse split; the detailed segment always lives in tags.
const NATIVE_ACCOUNT_TYPE_IDS = {
  Commercial: '93e8b1da-6584-4b6b-b743-4401e50a877e',
  Residential: 'c8f53624-0366-462d-843e-f185a7028da8',
};

// sa_jobs.service holds short internal codes, not descriptive text (confirmed live
// 2026-08-19 by pulling the full distinct vocabulary — 78 codes / 27,950 rows). An
// explicit code map beats keyword regex here since the codes don't spell out their
// meaning (e.g. "App1"-"App7" are lawn fertilization program rounds, "3\" G&P"/
// "3\" R&R" are asphalt grind-and-pave/remove-and-replace jobs). Unmapped/ambiguous
// codes (INSPECT, MIXED, R&R with no material prefix, RETA, GRAD, DRAIN, EXCAV, etc.)
// are deliberately left out rather than guessed — they contribute no service tag.
const SERVICE_CODE_MAP = {
  // Snow
  'PLOW - 2"': 'Snow', 'PLOW -1"': 'Snow', SHOVEL: 'Snow', SALT: 'Snow', ICE: 'Snow',
  // Lawn/Landscape
  MOW: 'Lawn/Landscape', BEDM: 'Lawn/Landscape', MOSQU: 'Lawn/Landscape', AERA: 'Lawn/Landscape',
  FALL: 'Lawn/Landscape', BedPreE: 'Lawn/Landscape', DUOC: 'Lawn/Landscape', SHRUB: 'Lawn/Landscape',
  LawnEdge: 'Lawn/Landscape', SPRI: 'Lawn/Landscape', DETHATCH: 'Lawn/Landscape', PMM1: 'Lawn/Landscape',
  PMM2: 'Lawn/Landscape', EDGIN: 'Lawn/Landscape', 'TURF REPAIR': 'Lawn/Landscape', LAND: 'Lawn/Landscape',
  WEED: 'Lawn/Landscape', OVERSEED: 'Lawn/Landscape', 'Aer&Overseed': 'Lawn/Landscape', ROLL: 'Lawn/Landscape',
  SLIT: 'Lawn/Landscape', CRAB: 'Lawn/Landscape', TOPS: 'Lawn/Landscape', IRRI: 'Lawn/Landscape',
  SODI: 'Lawn/Landscape', PlantFert: 'Lawn/Landscape', 'TOPSOIL & SEED': 'Lawn/Landscape', 'PondM.': 'Lawn/Landscape',
  BrnMULC: 'Lawn/Landscape', HemMULC: 'Lawn/Landscape', BlkMULC: 'Lawn/Landscape', RedMULC: 'Lawn/Landscape',
  App1: 'Lawn/Landscape', App2: 'Lawn/Landscape', App3: 'Lawn/Landscape', App4: 'Lawn/Landscape',
  App5: 'Lawn/Landscape', App6: 'Lawn/Landscape', App7: 'Lawn/Landscape',
  // Paving (asphalt) — "Crackfill" is confirmed elsewhere in this codebase as a
  // pavement-specific field (setClientCrackfill), so CRACK belongs here, not Concrete.
  '3" G&P': 'Paving', '3" R&R': 'Paving', 'PAVE R&R': 'Paving', 'Pave RRR': 'Paving',
  ASPH: 'Paving', CRACK: 'Paving', BUMP: 'Paving', Undercutting: 'Paving',
  // Concrete
  CONC: 'Concrete',
};

// Old SA (2015-Aug 2023) used a different vocabulary for the same 4 service lines
// (e.g. "Lawn" instead of "MOW", "Snow Remov" instead of "PLOW - 2\""). No key
// collisions between the two maps carry different values, so a flat merge is safe.
const ALL_SERVICE_CODE_MAP = { ...SERVICE_CODE_MAP, ...HISTORY_SERVICE_CODE_MAP };

const MUNICIPAL_RE = /^(city|village|town) of\b|\bcounty\b/i;
const MILITARY_GOV_RE = /\b(battalion|regiment|squadron|brigade|army|navy|air force|marine corps|national guard|va medical|veterans affairs|department of|school district|public works)\b/i;
// Plural forms ("Condos", "Condominiums") didn't match the original singular-only
// regex — confirmed live 2026-08-19 via Michael's manual corrections ("Apple Orchard
// Condos", "Apple Valley Gardens Condominiums" both fell through uncaught).
const HOA_RE = /\b(hoa|condo(minium)?s?|association|homeowners)\b/i;
const PROPERTY_MGMT_RE = /\b(property management|realty|realtors?|management (co|company|group)|apartments?|leasing)\b/i;
// Split out from the generic business list (2026-08-19, per Michael's correction of
// "Abacus Architects (Chappa Construction)" and "Arco/Murray") — a client whose own
// trade IS general contracting/architecture gets its own segment, distinct from
// "GC Subcontract" (a client referred TO us BY a GC). Checked before the generic
// business fallback so these don't fall into plain "Commercial - Direct".
const GENERAL_CONTRACTOR_RE = /\b(general contractor|architects?|construction|contractors?|builders?)\b/i;
// A broad "this looks like a business/institution, not a person" signal — company
// suffixes and entity-type words covering trades, professional services, retail,
// religious/nonprofit, and finance. Broadened 2026-08-19 per Michael's request to
// guess more aggressively rather than leave ambiguous names unclassified — tuned
// against the actual low-confidence sample from the first dry run (e.g. "A+
// Environmental", "Abundance of Life", "A-1 Stor-All").
//
// Structural limitation (found 2026-08-20 on "Diamond Communications"): this is a
// keyword list, not a real business-name detector — PERSON_NAME_RE below matches
// ANY 2-4 plain alphabetic tokens, so any business name whose defining word isn't
// in this list silently falls through to Residential. Expect more misses; when one
// turns up, add the keyword here AND re-scan the current Residential-tagged
// population for the same gap (see the reclassifyResidentialMisses export below)
// rather than just hand-fixing the one account. Batch below added 2026-08-20 after
// the Diamond Communications miss, covering media/comms, logistics, professional
// trades, and hospitality/personal-care categories not previously represented.
const BUSINESS_NAME_RE = /\b(llc|inc|corp|co\.|company|services?|group|properties|enterprises|holdings|roofing|electric(al)?|plumbing|landscap(e|ing)|design|engineer(s|ing)?|insurance|bank|credit union|solutions|systems|technologies|technology|industries|partners|associates|assoc|foundation|institute|agency|agencies|club|center|centre|storage|stor|rental|leasing|manufacturing|supply|supplies|distributors?|wholesale|restaurant|cafe|salon|spa|clinic|medical|dental|health|hospital|pharmacy|automotive|motors|dealership|financial|investments|capital|ventures|church|ministr(y|ies)|chapel|parish|fellowship|congregation|temple|ymca|academy|studio|communications?|media|network(s|ing)?|consulting|logistics|transport(ation)?|freight|trucking|shipping|warehous(e|ing)|digital|software|data|analytics|marketing|advertising|publishing|printing|graphics|photography|productions?|entertainment|broadcasting|veterinary|chiropractic|orthodontic|urgent care|imaging|laboratory|labs|fitness|wellness|hotel|motel|inn|resort|catering|hospitality|brewing|brewery|distillery|winery|bakery|fabrication|machining|welding|foundry|hardware|equipment|realty|mortgage|accounting|bookkeeping|attorneys?|law firm)\b/i;
const ACRONYM_ONLY_RE = /^[A-Z]{2,6}$/;
// "First Last", "First Middle Last" (up to 4 tokens), an optional trailing Sr/Jr/
// roman-numeral suffix, or "Last, First" — broadened 2026-08-19 from a strict
// 2-token-only match after Michael's corrections showed 3-token names ("Ann Marie
// Schulz"), "Last, First" entries ("ahern, kevin"), and "Sr."/"Jr." suffixes
// ("Andy Wheeler Sr.") were all being missed and falling through to the business
// fallback.
const PERSON_NAME_RE = /^[a-z'-]+(\s+[a-z'-]+){1,3}\s*(,?\s*(sr|jr|ii|iii|iv)\.?)?$/i;
const LAST_COMMA_FIRST_RE = /^[a-z'-]+,\s*[a-z'-]+\.?$/i;
// A couple — "First & First Last", "First and First Last", "First + First Last".
const COUPLE_NAME_RE = /^[a-z'-]+\s*(&|and|\+)\s*[a-z'-]+\s+[a-z'-]+\.?$/i;
// Trailing administrative annotations that aren't part of the account's identity —
// confirmed live 2026-08-19 from Michael's corrections: status/lifecycle notes
// ("MOVED", "- Cancelled", "NO LONGER RESIDENT?", "DO NOT CONTACT", "or current
// resident") and stray punctuation (trailing "*", trailing ",") were blocking
// PERSON_NAME_RE from matching the real name underneath.
const TRAILING_ANNOTATION_RE = /\s*[-–]?\s*(moved\??|cancelled|do not contact|no longer resident\??|or (current )?resident)\s*$/i;

/**
 * Idempotently ensures every account-type and service-line tag (and the
 * Service Line category) exists, creating only what's missing. Safe to call
 * repeatedly — never touches any client, only the master tag/category lists.
 * Returns { accountTypeTagIds: {name: tagId}, serviceLineTagIds: {name: tagId} }.
 */
export async function ensureTaxonomy() {
  const categories = await getTagCategories();
  const clientTypeCategory = categories.find(c => c.name === CLIENT_TYPE_CATEGORY_NAME);
  if (!clientTypeCategory) throw new Error(`ensureTaxonomy: "${CLIENT_TYPE_CATEGORY_NAME}" category not found — expected to already exist in SA`);

  const serviceLineCategory = await findOrCreateTagCategory({ name: SERVICE_LINE_CATEGORY_NAME });

  const accountTypeTagIds = {};
  for (const name of ACCOUNT_TYPE_TAGS) {
    const tag = await findOrCreateTag({ name, categoryId: clientTypeCategory.categoryId });
    accountTypeTagIds[name] = tag.tagId;
  }

  const serviceLineTagIds = {};
  for (const name of SERVICE_LINE_TAGS) {
    const tag = await findOrCreateTag({ name, categoryId: serviceLineCategory.categoryId });
    serviceLineTagIds[name] = tag.tagId;
  }

  logger.info('SA classification: taxonomy ensured', { accountTypeTagIds, serviceLineTagIds });
  return { accountTypeTagIds, serviceLineTagIds };
}

/**
 * Bulk-discovers which clients already carry a "GC: <company>" tag, using
 * getClientsByTag once per existing GC tag (cheap — ~50 calls total, not
 * one per client). Returns Map<clientId, gcCompanyName>.
 */
export async function getGcSubcontractMap() {
  const allTags = await listTags();
  const gcTags = allTags.filter(t => /^GC:\s*/i.test(t.name));
  const map = new Map();
  for (const tag of gcTags) {
    const clients = await getClientsByTag({ tagId: tag.tagId });
    const gcName = tag.name.replace(/^GC:\s*/i, '').trim();
    for (const c of clients) {
      if (!map.has(c.clientId)) map.set(c.clientId, gcName);
    }
  }
  logger.info('SA classification: GC subcontract map built', { gcTagCount: gcTags.length, clientCount: map.size });
  return map;
}

/** Bulk-discovers which clients already carry the "Commercial - HOA" tag. Returns Set<clientId>. */
export async function getHoaTaggedClientIds() {
  const allTags = await listTags();
  const hoaTag = allTags.find(t => t.name === 'Commercial - HOA');
  if (!hoaTag) return new Set();
  const clients = await getClientsByTag({ tagId: hoaTag.tagId });
  return new Set(clients.map(c => c.clientId));
}

/**
 * Key used to match "same underlying property/contact" across two separate
 * SA client records — normalized address + city + zip + email. Address alone
 * is NOT enough: found live 2026-08-24 that individual condo unit owners
 * routinely share their whole building's street address with the complex's
 * own HOA/association master record (a multi-unit building only has one
 * street address), and are genuinely distinct residential clients with their
 * own separate email — reclassifying them as HOA off address alone produced
 * real false positives (e.g. "Janet Thompson" at the same address as
 * "Claremont Village Condos" but a completely different email — she's a
 * real individual owner, not a duplicate of the association's own record).
 * Requiring the email to ALSO match is what correctly separates the genuine
 * duplicate-record cases (same person/board-member's contact info reused
 * across two differently-named SA client records for the same property —
 * "Village Estates"/"Village Estate Condos", "Bill Bauer"/"Ancient Oaks HOA",
 * "David Charney"/"Hidden River Condos", "Millard Johnson"/"Lake Park Forest
 * Condominiums", all confirmed live with an exact email match) from the
 * false positives above (confirmed live with a different email each).
 * Returns null (never matches) if either address or email is missing.
 */
function addressKey(account) {
  const addr = normalizeAddress(account.address || '');
  const email = normalizeEmail(account.email || '');
  if (!addr || !email) return null;
  return `${addr}|${(account.city || '').toLowerCase()}|${(account.zip || '').toLowerCase()}|${email}`;
}

/**
 * Found live 2026-08-24 ("Village Estates" vs. the already-correctly-tagged
 * "Village Estate Condos" — same address, same contact email, two separate
 * SA client records for the same physical HOA property). HOA_RE only catches
 * names that literally contain "HOA"/"condo"/"association"/"homeowners" — a
 * duplicate/renamed record for the same property that drops the qualifying
 * word falls straight through to the Residential default with zero signal
 * that anything's wrong. Builds Set<addressKey> (address+email combined —
 * see addressKey) for every account whose clientId is already in `hoaSet`,
 * so `classifyAccountType` can catch "this is the same underlying contact as
 * a known HOA, just a different-named duplicate record" even when the name
 * itself gives no textual hint. Cheap — reuses accounts/hoaSet already
 * fetched by the caller, no extra SA round trip.
 */
function buildHoaAddressSet(accounts, hoaSet) {
  const keys = new Set();
  for (const account of accounts) {
    if (!hoaSet.has(account.clientId)) continue;
    const key = addressKey(account);
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * Classify one account's segment from name/address signals plus the
 * bulk-discovered GC/HOA tag maps. Returns { segment, confidence, reason }.
 * confidence: 'high' | 'medium' | 'low' (low = flagged for manual review,
 * no tag applied automatically by the backfill).
 */
function cleanNameSegment(seg) {
  return seg
    .replace(/^\[[^\]]*\]\s*/, '')     // leading archival tag, e.g. "[Old] "
    .replace(/\([^)]*\)/g, '')          // any parenthetical annotation
    .replace(TRAILING_ANNOTATION_RE, '') // "MOVED", "- Cancelled", "or current resident", etc.
    .replace(/[*,]\s*$/, '')            // trailing "*" or ","
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Splits a "Master:Sub" style name (e.g. "Andres Elejalde (MASTER):Andres
 * Elejalde (HOME)", "Belgium Village Office (master):Village of Belgium
 * (Community Park)") on ":" and cleans each segment — confirmed live 2026-08-19
 * from Michael's corrections that the identifying info (a municipal match, or
 * just the real underlying name) can live in either segment.
 */
function nameSegments(rawName) {
  return rawName.split(':').map(cleanNameSegment).filter(Boolean);
}

// SA's approved write-testing account (per CLAUDE.md) — not a real client. Michael
// explicitly marked this back to unclassified during manual review 2026-08-19
// rather than have it swept into a real segment by the regex fallback.
const TEST_ACCOUNT_CLIENT_ID = 'e2a7420a-930c-4908-90aa-67ba158e0921';

export function classifyAccountType(account, { gcMap, hoaSet, hoaAddresses }) {
  if (account.clientId === TEST_ACCOUNT_CLIENT_ID) {
    return { segment: null, confidence: 'low', reason: 'SA test account (APIProbe, JRBTest) — excluded from classification' };
  }
  const rawName = account.name || '';
  const segments = nameSegments(rawName).length ? nameSegments(rawName) : [''];
  const name = segments[0];
  const fullText = `${rawName} ${account.address || ''}`;

  if (gcMap.has(account.clientId)) {
    return { segment: 'GC Subcontract', confidence: 'high', reason: `existing tag: GC: ${gcMap.get(account.clientId)}` };
  }
  if (hoaSet.has(account.clientId)) {
    return { segment: 'Commercial - HOA', confidence: 'high', reason: 'existing tag: Commercial - HOA' };
  }
  if (HOA_RE.test(fullText)) {
    return { segment: 'Commercial - HOA', confidence: 'high', reason: 'name/address matches HOA/condo pattern' };
  }
  // Same underlying contact (address AND email both match) as a client already
  // tagged Commercial - HOA — a separate/duplicate SA record for the same
  // property whose name happens to drop the qualifying word (e.g. "Village
  // Estates" vs. the correctly-tagged "Village Estate Condos", same email) —
  // found live 2026-08-24, see buildHoaAddressSet/addressKey. Address alone is
  // deliberately NOT enough here — individual condo unit owners legitimately
  // share their building's address with the complex's own HOA record.
  if (hoaAddresses && hoaAddresses.has(addressKey(account))) {
    return { segment: 'Commercial - HOA', confidence: 'high', reason: 'shares an address AND contact email with an existing Commercial - HOA account (duplicate client record for the same property)' };
  }
  // Check every colon-separated segment against municipal/military patterns — the
  // matching segment isn't always the first one (e.g. "Belgium Village Office
  // (master):Village of Belgium (Community Park)" only matches on the second).
  if (segments.some(s => MUNICIPAL_RE.test(s) || MILITARY_GOV_RE.test(s))) {
    return { segment: 'Municipal/Government', confidence: 'high', reason: 'name matches a government/municipal/military pattern' };
  }
  if (PROPERTY_MGMT_RE.test(fullText)) {
    return { segment: 'Commercial - Property Mgmt', confidence: 'medium', reason: 'name matches property management pattern' };
  }
  if (GENERAL_CONTRACTOR_RE.test(name)) {
    return { segment: 'Commercial - General Contractor', confidence: 'medium', reason: 'name matches a general-contractor/architecture pattern' };
  }
  if (BUSINESS_NAME_RE.test(name)) {
    return { segment: 'Commercial - Direct', confidence: 'medium', reason: 'name matches business/institution pattern' };
  }
  if (COUPLE_NAME_RE.test(name)) {
    return { segment: 'Residential', confidence: 'high', reason: 'name matches a couple pattern ("First & First Last")' };
  }
  if (PERSON_NAME_RE.test(name) || LAST_COMMA_FIRST_RE.test(name)) {
    return { segment: 'Residential', confidence: 'high', reason: 'name matches a person-name pattern' };
  }
  // A large share of accounts are named after the property's street address rather
  // than an owner (confirmed live 2026-08-19 — e.g. "2600 Lake Vista"), most likely
  // from address-keyed lead imports that were never renamed after converting to a
  // client. These read as residential far more often than commercial, but a bare
  // street address is a much weaker signal than an actual name match, hence 'medium'
  // (not 'high') — worth a spot-check before trusting this bucket at full scale.
  if (/^\d+\s/.test(name)) {
    return { segment: 'Residential', confidence: 'medium', reason: 'name is a bare street address (likely an unrenamed lead import)' };
  }
  // A short all-caps acronym paired with a parenthetical site/location (e.g. "ACG
  // (Division Rd. - Germantown)", "ACG (Pick N Save - Mayfair)") reads as one brand
  // managing several named properties — a property-management portfolio pattern,
  // corrected live 2026-08-19 from an earlier guess of plain "Commercial - Direct".
  // A bare acronym with NO parenthetical is kept as generic commercial — there's no
  // portfolio signal to lean on.
  if (ACRONYM_ONLY_RE.test(name)) {
    return /\(/.test(rawName)
      ? { segment: 'Commercial - Property Mgmt', confidence: 'medium', reason: 'acronym name with a site/location parenthetical (portfolio pattern)' }
      : { segment: 'Commercial - Direct', confidence: 'medium', reason: 'name is a bare acronym, not a person-name shape' };
  }
  // Last resort: anything that reaches here matched no business/institution keyword,
  // no municipal/HOA pattern, and no address pattern either. Michael's manual
  // corrections (2026-08-19) showed this bucket is overwhelmingly residential in
  // practice — informal or annotated person names the regexes above still miss
  // (single first names, nicknames, family descriptions like "Anne Skalmoskis moms
  // house") — NOT businesses. Defaulting to Residential here (flipped from an
  // earlier version of this function that defaulted to Commercial - Direct, which
  // Michael corrected in 48 of 71 manually-reviewed rows).
  return { segment: 'Residential', confidence: 'medium', reason: "no specific pattern matched, but most unmatched names turned out residential on manual review — defaulting to residential" };
}

/** Pulls sa_jobs service history, grouped by customer_id. Returns Map<customerId, Set<rawServiceStrings>>. */
export async function getServiceHistoryMap() {
  const map = new Map();
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await fleetops
      .from('sa_jobs')
      .select('customer_id, service')
      .not('customer_id', 'is', null)
      .not('service', 'is', null)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`getServiceHistoryMap: Supabase error: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) {
      if (!map.has(row.customer_id)) map.set(row.customer_id, new Set());
      map.get(row.customer_id).add(row.service);
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }
  logger.info('SA classification: service history map built', { clientCount: map.size });
  return map;
}

/**
 * Classify a client's service lines from its job-history service strings.
 * A client can match multiple lines. Returns [{ service, confidence, reason }].
 */
export function classifyServiceLines(clientId, serviceHistoryMap) {
  const rawServices = serviceHistoryMap.get(clientId);
  if (!rawServices || rawServices.size === 0) return [];

  const matchedLines = new Set();
  const matched = [];
  for (const raw of rawServices) {
    const service = ALL_SERVICE_CODE_MAP[raw];
    if (service && !matchedLines.has(service)) {
      matchedLines.add(service);
      matched.push({ service, confidence: 'high', reason: `job history code: "${raw}"` });
    }
  }
  return matched;
}

/**
 * Read-only dry run: classifies every SA account without writing anything.
 * Returns a report: { total, byAccountType, byService, ambiguous, rows }.
 * `rows` is the full per-client classification — save/inspect before ever
 * calling applyClassificationBackfill with it.
 */
export async function runClassificationDryRun({ max = 12000, includeHistory = true } = {}) {
  const [accounts, gcMap, hoaSet, serviceHistoryMap] = await Promise.all([
    getAllSAAccounts({ max }),
    getGcSubcontractMap(),
    getHoaTaggedClientIds(),
    getServiceHistoryMap(),
  ]);

  // Enrich with Old SA (2015-Aug 2023) service history where a confident match
  // exists — additive only, never overwrites current data. Old SA and current SA
  // use unrelated client_id namespaces (a prior platform migration regenerated
  // every GUID — confirmed live 2026-08-19, zero direct ID overlap), so accounts
  // are matched by email/name/address first (see sa-history-match.js).
  if (includeHistory) {
    const [historyServiceMap, { matched, stats }] = await Promise.all([
      getHistoryServiceMap(),
      matchHistoryAccountsToCurrent(accounts),
    ]);
    mergeHistoryIntoServiceMap(serviceHistoryMap, historyServiceMap, matched);
    logger.info('SA classification: history enrichment applied', stats);
  }

  const hoaAddresses = buildHoaAddressSet(accounts, hoaSet);
  const rows = accounts.map(account => {
    const accountType = classifyAccountType(account, { gcMap, hoaSet, hoaAddresses });
    const services = classifyServiceLines(account.clientId, serviceHistoryMap);
    return { clientId: account.clientId, name: account.name, isLead: account.isLead, accountType, services };
  });

  const byAccountType = {};
  const byService = {};
  const ambiguous = [];
  for (const row of rows) {
    const key = row.accountType.segment || 'UNCLASSIFIED';
    byAccountType[key] = (byAccountType[key] || 0) + 1;
    if (row.accountType.confidence === 'low') ambiguous.push(row);
    for (const s of row.services) byService[s.service] = (byService[s.service] || 0) + 1;
  }

  logger.info('SA classification: dry run complete', { total: rows.length, byAccountType, byService, ambiguousCount: ambiguous.length });
  return { total: rows.length, byAccountType, byService, ambiguous, rows };
}

/**
 * Actually writes tags (and native AccountType for Commercial/Residential
 * segments) from a dry-run report. Only call this after a human has reviewed
 * the report — this is the one function in this module that mutates
 * production client records, and no tag-removal endpoint is confirmed to
 * exist, so there's no clean undo for a bad run.
 *
 * skipLowConfidence (default true): rows with accountType.confidence 'low'
 * are skipped entirely (no tag written) rather than guessed. Service-line
 * tags are always 'high' confidence by construction (real job history) so
 * there's no equivalent skip for those.
 *
 * Returns { tagged, skipped, failed } — failed includes the clientId/error
 * for anything that threw, so a partial run can be diagnosed and resumed.
 */
export async function applyClassificationBackfill(dryRunReport, { skipLowConfidence = true, tagMaps } = {}) {
  // Accept pre-fetched tag maps (runIncrementalClassification already calls
  // ensureTaxonomy() once to build its "already classified" set — without this,
  // every call here repeats the same ~11 SA round trips for no behavioral benefit).
  const { accountTypeTagIds, serviceLineTagIds } = tagMaps ?? await ensureTaxonomy();

  let tagged = 0;
  let partial = 0;
  let skipped = 0;
  const failed = [];

  for (const row of dryRunReport.rows) {
    if (row.accountType.confidence === 'low' && skipLowConfidence) {
      skipped++;
      continue;
    }
    // The account-type tag write and the native AccountType field write are
    // tracked separately — saveClientFields throwing (e.g. a client missing
    // state/city/postal code, a common pre-existing data-quality gap) doesn't
    // mean the tag write above it failed too. Conflating the two into one
    // failure previously mislabeled "tag succeeded, native field didn't" rows
    // as full failures, undercounting `tagged` and never surfacing the
    // distinction CLAUDE.md's backfill-results section describes.
    let tagWriteFailed = false;
    let nativeFieldFailed = false;
    let lastError = null;
    try {
      if (row.accountType.segment) {
        const tagId = accountTypeTagIds[row.accountType.segment];
        await addTagToClient({ clientId: row.clientId, tagId });

        const nativeType = row.accountType.segment === 'Residential' ? 'Residential'
          : row.accountType.segment.startsWith('Commercial') || row.accountType.segment === 'Municipal/Government' || row.accountType.segment === 'GC Subcontract' ? 'Commercial'
          : null;
        if (nativeType) {
          try {
            await saveClientFields({ clientId: row.clientId, overrides: { AccountTypeID: NATIVE_ACCOUNT_TYPE_IDS[nativeType] } });
          } catch (err) {
            nativeFieldFailed = true;
            lastError = err;
          }
        }
      }
      for (const s of row.services) {
        await addTagToClient({ clientId: row.clientId, tagId: serviceLineTagIds[s.service] });
      }
    } catch (err) {
      tagWriteFailed = true;
      lastError = err;
    }

    if (tagWriteFailed) {
      failed.push({ clientId: row.clientId, name: row.name, error: lastError.message, taggedOk: false });
      logger.warn('SA classification backfill: client failed', { clientId: row.clientId, error: lastError.message });
    } else if (nativeFieldFailed) {
      partial++;
      failed.push({ clientId: row.clientId, name: row.name, error: lastError.message, taggedOk: true });
      logger.warn('SA classification backfill: native field write failed (tag applied ok)', { clientId: row.clientId, error: lastError.message });
    } else {
      tagged++;
    }
  }

  logger.info('SA classification backfill complete', { tagged, partial, skipped, failed: failed.length });
  return { tagged, partial, skipped, failed };
}

/**
 * Writes a dry-run report to an .xlsx file for human review before running
 * applyClassificationBackfill — one row per account, one sheet per confidence
 * tier so high/medium/low are easy to scan separately, plus a Summary sheet.
 */
export function exportDryRunToXlsx(report, filePath) {
  const toRow = (row) => ({
    Name: row.name,
    IsLead: row.isLead,
    AccountType: row.accountType.segment || '',
    Confidence: row.accountType.confidence,
    Reason: row.accountType.reason,
    Services: row.services.map(s => s.service).join(', '),
  });

  const high = report.rows.filter(r => r.accountType.confidence === 'high').map(toRow);
  const medium = report.rows.filter(r => r.accountType.confidence === 'medium').map(toRow);
  const low = report.rows.filter(r => r.accountType.confidence === 'low').map(toRow);

  const summaryRows = [
    { Metric: 'Total accounts', Value: report.total },
    { Metric: '', Value: '' },
    ...Object.entries(report.byAccountType).map(([k, v]) => ({ Metric: `Account type: ${k}`, Value: v })),
    { Metric: '', Value: '' },
    ...Object.entries(report.byService).map(([k, v]) => ({ Metric: `Service: ${k}`, Value: v })),
  ];

  // One workbook per confidence tier (plus Summary in each) rather than one giant
  // combined file — keeps each file well under SharePoint's single-call upload
  // size limit without losing any row. ClientID is left out of the export itself
  // (Name is enough for a visual scan); the full JSON report alongside these
  // files still has clientId for anything that needs to look a record up directly.
  const tiers = [
    { key: 'high', label: 'High', rows: high },
    { key: 'medium', label: 'Medium', rows: medium },
    { key: 'low', label: 'Low-review', rows: low },
  ];
  const written = [];
  for (const tier of tiers) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Summary');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tier.rows), `${tier.label} (${tier.rows.length})`.slice(0, 31));
    const tierPath = filePath.replace(/(\.xlsx)$/i, `-${tier.key}$1`);
    XLSX.writeFile(wb, tierPath, { compression: true });
    written.push(tierPath);
  }

  logger.info('SA classification: dry-run exported to xlsx', { written, high: high.length, medium: medium.length, low: low.length });
  return written;
}

/**
 * Going-forward companion to the one-time historical backfill (2026-08-19):
 * finds SA accounts that don't yet carry ANY account-type tag — i.e. clients
 * created since the backfill ran — classifies just those, and applies tags
 * directly (no dry-run/review step, since this runs unattended on a schedule
 * and each new client is a single low-stakes row rather than a bulk write).
 *
 * Does NOT re-run the Old SA history match (matchHistoryAccountsToCurrent) —
 * a brand-new client can't have Old SA (pre-Aug-2023) history by definition,
 * and re-matching the full ~8,152-account history set on every run would be
 * wasteful. Service-line tags here come from current sa_jobs only, same as
 * everyone else once they've been active long enough to accumulate history.
 *
 * `max` caps how many accounts one run will touch (default 300) — a safety
 * ceiling in case the "already classified" detection ever lags and this
 * would otherwise try to reprocess a large chunk of the account base.
 * Returns { classified, tagged, skipped, failed }.
 */
export async function runIncrementalClassification({ max = 300 } = {}) {
  const { accountTypeTagIds, serviceLineTagIds } = await ensureTaxonomy();

  // Union of clientIds already carrying any account-type tag, via the same
  // bulk tag-filter trick used for GC/HOA detection — 7 cheap calls total,
  // not one GetSavedTags round-trip per client.
  const classifiedIds = new Set();
  for (const tagId of Object.values(accountTypeTagIds)) {
    // getClientsByTag defaults to max:5000 — "Residential" alone now covers ~8,700+
    // clients after the 2026-08-19/20 backfill, so the default would silently
    // truncate and misclassify thousands of already-tagged clients as "new".
    // 20000 comfortably covers the full ~10,250-account base with headroom to grow.
    const clients = await getClientsByTag({ tagId, max: 20000 });
    for (const c of clients) classifiedIds.add(c.clientId);
  }

  const [accounts, gcMap, hoaSet, serviceHistoryMap] = await Promise.all([
    getAllSAAccounts({ max: 15000 }),
    getGcSubcontractMap(),
    getHoaTaggedClientIds(),
    getServiceHistoryMap(),
  ]);

  const newAccounts = accounts.filter(a => !classifiedIds.has(a.clientId)).slice(0, max);
  if (newAccounts.length === 0) {
    logger.info('SA classification: incremental run found no new/unclassified accounts');
    return { classified: 0, tagged: 0, skipped: 0, failed: [] };
  }

  // Built from the FULL account list (not just newAccounts) — a brand-new
  // duplicate record needs to match against every existing HOA property's
  // address, not just other new ones.
  const hoaAddresses = buildHoaAddressSet(accounts, hoaSet);
  const rows = newAccounts.map(account => {
    const accountType = classifyAccountType(account, { gcMap, hoaSet, hoaAddresses });
    const services = classifyServiceLines(account.clientId, serviceHistoryMap);
    return { clientId: account.clientId, name: account.name, isLead: account.isLead, accountType, services };
  });

  // Pass the tag maps already fetched above — applyClassificationBackfill would
  // otherwise call ensureTaxonomy() again and repeat all ~11 SA round trips.
  const result = await applyClassificationBackfill({ rows }, { tagMaps: { accountTypeTagIds, serviceLineTagIds } });
  logger.info('SA classification: incremental run complete', { found: newAccounts.length, ...result });
  return { classified: newAccounts.length, ...result };
}
