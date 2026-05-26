// tools/impl/serviceautopilot.js — Service Autopilot read/write via browser session
// SA has no public API; we log in via puppeteer-core and call the internal BFF endpoints.
// Session cookies are cached in-process for 4 hours to avoid repeated browser launches.

import fs from 'fs';
import { fileURLToPath } from 'url';
import { logger } from '../../core/logger.js';

const SA_BASE    = 'https://my.serviceautopilot.com';
const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';
const EDGE_PATH  = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// State abbreviation → SA internal GUID (from GetStateList endpoint)
const STATE_IDS = {
  AK: '6f5d3313-ef62-4c63-bb58-718f8a8b7f74', AL: '33e6414e-8a1d-43a7-ae21-7eff401809bc',
  AR: '999f8d96-e314-4c5f-8725-680f5b785f0a', AZ: '3c56a8dc-0f7e-4595-bc55-4d79f3d5340c',
  CA: 'e94bceff-6c60-40dd-972e-1fa49d9e9f61', CO: '5ad7017c-8816-40e1-bb03-2fecf9285476',
  CT: 'fa8f172b-3067-4d81-9c40-a49ee9517e94', DC: 'bb52a6b8-c16f-4964-95e4-4436066b1aa1',
  DE: '359abdcc-2d33-4f8f-af80-e3835948f2ea', FL: '3ea93761-97d7-46af-8fc9-6fdbd44ffd0b',
  GA: 'efacc539-cce0-416c-89c8-674f168d83fb', HI: '81f3dc53-2b16-4f93-922d-3ee7c88b9a8c',
  IA: 'e158f4f9-8b88-4190-b0e9-7bb2524c5ba9', ID: 'd50aa8a0-5043-4cc8-b7fe-f6276f043cde',
  IL: 'd69c93c3-6850-402d-90c2-deed1e9ca73e', IN: '828e210f-ecfa-4f1d-b2d6-67731b3bcce8',
  KS: '3ebfac96-d522-4653-b022-edcb993f356b', KY: 'e4761e4a-7cfe-4215-a4ab-33acbaf95538',
  LA: '3ade1946-3ba9-4905-ad12-4759ee51094a', MA: 'af4039b2-bf71-4570-9a0e-1a48db3b1695',
  MD: 'b53877bf-f90f-472d-b49f-24f554db2a6a', ME: '3ae7aa48-d0d7-49e8-ad85-aedf09518113',
  MI: '65d3d984-6a77-45c5-9a3b-c5ab78490a74', MN: '98494a30-d613-45e5-9fa5-b8212c1ab3cd',
  MO: '7faf41e4-0a7c-434e-8261-1e11f9b0e0e7', MS: '09982d5f-ad46-46bf-ac8b-c98648ef25aa',
  MT: 'd2dafcc9-bfd4-4b97-ae0f-c112420748b8', NC: '3fb0dc25-e9ec-4d77-82b6-e0682b3f6fdb',
  ND: '7aa42c0a-b045-4059-9010-f3eb1a77bff3', NE: '8796b587-d72a-4e10-a9e4-0eb9b4219e77',
  NH: '07a08758-437d-4be9-8c76-3730aa9fa3ae', NJ: 'ec989a9d-3eee-4ec7-a536-d4c60c7c1443',
  NM: '1facfd3c-b234-4096-b1e4-cc86349d2244', NV: 'e5114a31-090f-46c6-932c-d50862cacd58',
  NY: 'fe66fd8d-425d-4a9f-8fc6-8073c6a69836', OH: '4bd2fdbd-e9d4-4dc9-aff8-d60a6399c417',
  OK: '56e4626a-f4b0-4690-b7da-c727db552203', OR: 'a8ad98bb-9784-4409-8516-40a7d103d8ac',
  PA: '533bfd24-3db3-483b-ad22-a8dc1b57b456', RI: '8d663ba2-37e6-4191-86bb-9841bde8321e',
  SC: '13aa12c7-a770-4bf0-a070-9d1fcfcf0954', SD: '1d3ef3a3-16b2-4d7a-862c-3f18c4decd3f',
  TN: 'bc4fc1b0-2be9-4c0c-967f-bc908f4881f9', TX: '247dc0a4-2f1d-473c-b27f-96c7e5503939',
  UT: '13380a63-fba6-4392-943e-8b40cbe0ad07', VA: 'e532a8a9-351e-4ec8-bcb9-4a49b6ce4a94',
  VT: 'd03a2e8b-f5b9-4213-bf04-d52aa28a375f', WA: '57f6a2e9-0411-44ae-9ccb-3cd11015a1b7',
  WI: 'ce81d562-a057-4d48-bd07-b4b70795dea8', WV: 'b85db182-b124-4a02-bac4-f21b208ae043',
  WY: '90f7e575-9148-4ade-8890-57fcc9fb8d77',
};

// SA ticket category IDs (from TicketEdit_TicketCategoryDropdown_GetByCompany)
const TICKET_CATEGORIES = {
  OTHER:            'e74cbced-0bf3-43ef-9fee-f7564af541da',
  ESTIMATE:         '13ea0f69-bb00-42a3-af41-7c4ee9737a0f',
  SCHEDULE_SERVICE: '35d51355-5fe7-4ccb-ab7b-7a48fe42980c',
  ACCOUNT_ISSUE:    '9fc6647e-0f19-4b30-8c5f-00bdf75b5938',
};

// JRB SA billing defaults — discovered 2026-05-22 via GetSalesTaxCodeListWithParams
const JRB_TAX_CODE_ID = 'c432e644-6f8f-4a78-b52f-ef93f05abf4e'; // "Tax" code

// Municipality SalesTaxRef GUIDs — discovered 2026-05-22 by scanning 500 real SA client records.
// GetSalesTaxList endpoint returns null-Company error (broken). Default fallback: Ozaukee County.
const JRB_TAX_REF_DEFAULT = '97608201-5377-4e0f-acaa-1aeee550dd32'; // Ozaukee County
const JRB_TAX_REF_BY_CITY = {
  // City of Milwaukee (separate rate from county suburbs)
  'milwaukee':           '6adcb6c0-b0b0-42be-8afb-08627f3561b1',
  'city of milwaukee':   '6adcb6c0-b0b0-42be-8afb-08627f3561b1',
  // Milwaukee County suburbs
  'shorewood':           '43974a35-2806-4010-98a5-d14ae1393884',
  'whitefish bay':       '43974a35-2806-4010-98a5-d14ae1393884',
  'river hills':         '43974a35-2806-4010-98a5-d14ae1393884',
  'bayside':             '43974a35-2806-4010-98a5-d14ae1393884',
  'glendale':            '43974a35-2806-4010-98a5-d14ae1393884',
  'south milwaukee':     '43974a35-2806-4010-98a5-d14ae1393884',
  'cudahy':              '43974a35-2806-4010-98a5-d14ae1393884',
  'st. francis':         '43974a35-2806-4010-98a5-d14ae1393884',
  'hales corners':       '43974a35-2806-4010-98a5-d14ae1393884',
  'west allis':          '43974a35-2806-4010-98a5-d14ae1393884',
  'wauwatosa':           '43974a35-2806-4010-98a5-d14ae1393884',
  'greenfield':          '43974a35-2806-4010-98a5-d14ae1393884',
  'franklin':            '43974a35-2806-4010-98a5-d14ae1393884',
  // City-specific Milwaukee rates
  'brown deer':          'ec76dd4b-b7eb-468e-bd0b-8246bdeedb9c',
  'oak creek':           '80f64212-06c7-46f3-840b-e14873895504',
  // Ozaukee County
  'mequon':              '97608201-5377-4e0f-acaa-1aeee550dd32',
  'cedarburg':           '97608201-5377-4e0f-acaa-1aeee550dd32',
  'thiensville':         '97608201-5377-4e0f-acaa-1aeee550dd32',
  'grafton':             '97608201-5377-4e0f-acaa-1aeee550dd32',
  'port washington':     '97608201-5377-4e0f-acaa-1aeee550dd32',
  'saukville':           '97608201-5377-4e0f-acaa-1aeee550dd32',
  'fredonia':            '97608201-5377-4e0f-acaa-1aeee550dd32',
  'belgium':             '97608201-5377-4e0f-acaa-1aeee550dd32',
  'newburg':             '97608201-5377-4e0f-acaa-1aeee550dd32',
  // Washington County
  'jackson':             '6955686a-5b1d-4684-92cd-becd890b562d',
  'hartford':            '6955686a-5b1d-4684-92cd-becd890b562d',
  'colgate':             '6955686a-5b1d-4684-92cd-becd890b562d',
  'slinger':             '6955686a-5b1d-4684-92cd-becd890b562d',
  'addison':             '6955686a-5b1d-4684-92cd-becd890b562d',
  // Waukesha County
  'new berlin':          '50b742c7-66ba-4034-b602-9552d5f2e77e',
  'elm grove':           '50b742c7-66ba-4034-b602-9552d5f2e77e',
  'lisbon':              '50b742c7-66ba-4034-b602-9552d5f2e77e',
  'waukesha':            '50b742c7-66ba-4034-b602-9552d5f2e77e',
  'pewaukee':            '50b742c7-66ba-4034-b602-9552d5f2e77e',
  'mukwonago':           '50b742c7-66ba-4034-b602-9552d5f2e77e',
  'menomonee falls':     '50b742c7-66ba-4034-b602-9552d5f2e77e',
  'brookfield':          '50b742c7-66ba-4034-b602-9552d5f2e77e',
  'hartland':            '50b742c7-66ba-4034-b602-9552d5f2e77e',
  'sussex':              '50b742c7-66ba-4034-b602-9552d5f2e77e',
  // Walworth County
  'elkhorn':             'f6f4fc4a-a05c-49f7-84c6-e5cc7d06b6f0',
  'lake geneva':         'f6f4fc4a-a05c-49f7-84c6-e5cc7d06b6f0',
};

const SESSION_TTL_MS      = 4 * 60 * 60 * 1000; // 4 hours
const INCAPSULA_BACKOFF_MS = 45 * 60 * 1000;    // 45 min backoff when IP is flagged

// Cookie cache: restore session on restart to avoid triggering a new login.
// Path resolves to sa-session-cache.json at the repo root (relative to this file's location).
const SESSION_CACHE_PATH  = fileURLToPath(new URL('../../sa-session-cache.json', import.meta.url));
// Shared across all scheduler instances — whichever process hits the block first writes this,
// and all other instances read it before attempting a login so they don't pile on.
const BACKOFF_FILE        = fileURLToPath(new URL('../../sa-incapsula-backoff.json', import.meta.url));

function readSharedBackoff() {
  try {
    if (!fs.existsSync(BACKOFF_FILE)) return;
    const { until } = JSON.parse(fs.readFileSync(BACKOFF_FILE, 'utf8'));
    if (typeof until === 'number' && until > _incapsulaBackoffUntil) {
      _incapsulaBackoffUntil = until;
    }
  } catch { /* ignore corrupt file */ }
}

function writeSharedBackoff(until) {
  try {
    fs.writeFileSync(BACKOFF_FILE, JSON.stringify({ until, setAt: new Date().toISOString() }), 'utf8');
  } catch (e) {
    logger.warn('SA: could not write shared backoff file', { error: e.message });
  }
}

// Browser kept open for session lifetime so all API calls run inside Chromium.
// Node.js fetch() has a different TLS fingerprint (JA3) that Incapsula detects as
// non-browser traffic after repeated rapid logins. Routing via page.evaluate() is
// indistinguishable from real user XHR requests.
let _browser             = null;
let _page                = null;
let _sessionExpiry       = 0;
let _loginPromise        = null; // deduplicate concurrent login attempts
let _incapsulaBackoffUntil = 0;  // epoch ms; refuse SA calls until this clears

// ── Session management ───────────────────────────────────────────────────────

async function saveSessionCookies(page) {
  try {
    const cookies = await page.cookies();
    logger.info('SA: saving session cookies', { count: cookies.length, path: SESSION_CACHE_PATH });
    if (cookies.length === 0) {
      logger.warn('SA: cookie list empty — skipping cache write');
      return;
    }
    fs.writeFileSync(SESSION_CACHE_PATH, JSON.stringify(cookies), 'utf8');
    logger.info('SA: session cookies saved to cache', { count: cookies.length });
  } catch (e) {
    logger.warn('SA: could not save session cookies', { error: e.message, path: SESSION_CACHE_PATH });
  }
}

async function tryRestoreSession(page) {
  try {
    if (!fs.existsSync(SESSION_CACHE_PATH)) return false;
    const cookies = JSON.parse(fs.readFileSync(SESSION_CACHE_PATH, 'utf8'));
    if (!Array.isArray(cookies) || cookies.length === 0) return false;
    await page.setCookie(...cookies);
    await page.goto(`${SA_BASE}/Home.aspx`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const url = page.url();
    if (url.includes('Login') || url === `${SA_BASE}/` || url === `${SA_BASE}`) {
      logger.info('SA: cached cookies expired, will do full login');
      return false;
    }
    logger.info('SA: session restored from cookie cache — skipped login form');
    return true;
  } catch (e) {
    logger.warn('SA: cookie restore failed, will do full login', { error: e.message });
    return false;
  }
}

async function getSession(force = false) {
  if (Date.now() < _incapsulaBackoffUntil) {
    const remainingMin = Math.ceil((_incapsulaBackoffUntil - Date.now()) / 60000);
    throw new Error(`SA Incapsula backoff active — ${remainingMin} min remaining before SA operations resume`);
  }
  if (!force && _page && Date.now() < _sessionExpiry) {
    return _page;
  }
  if (!_loginPromise) {
    _loginPromise = (async () => {
      if (_browser) {
        try { await _browser.close(); } catch {}
        _browser = null;
        _page = null;
      }
      return login();
    })()
      .then(({ browser, page }) => {
        _browser = browser;
        _page    = page;
        _sessionExpiry = Date.now() + SESSION_TTL_MS;
        _loginPromise  = null;
        return page;
      })
      .catch(err => {
        _loginPromise = null;
        throw err;
      });
  }
  return _loginPromise;
}

async function login() {
  readSharedBackoff();
  if (Date.now() < _incapsulaBackoffUntil) {
    const remainingMin = Math.ceil((_incapsulaBackoffUntil - Date.now()) / 60000);
    throw new Error(`SA Incapsula backoff active — ${remainingMin} min remaining before SA operations resume`);
  }
  logger.info('SA: starting browser login');
  let puppeteerExtra, StealthPlugin;
  try {
    puppeteerExtra = (await import('puppeteer-extra')).default;
    StealthPlugin  = (await import('puppeteer-extra-plugin-stealth')).default;
  } catch {
    throw new Error('puppeteer-extra or puppeteer-extra-plugin-stealth not installed — run: npm install puppeteer-extra puppeteer-extra-plugin-stealth');
  }

  const executablePath = fs.existsSync(EDGE_PATH)   ? EDGE_PATH
    : fs.existsSync(CHROME_PATH) ? CHROME_PATH
    : null;
  if (!executablePath) throw new Error('SA login: no Edge or Chrome browser found on this machine');

  const email    = process.env.SA_EMAIL    || '';
  const password = process.env.SA_PASSWORD || '';
  if (!email || !password) throw new Error('SA_EMAIL or SA_PASSWORD env vars not set');

  puppeteerExtra.use(StealthPlugin());
  const browser = await puppeteerExtra.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

  try {
    // Try restoring from cached cookies first — avoids triggering a new login
    const restored = await tryRestoreSession(page);
    if (restored) {
      logger.info('SA: login complete (cookie restore)');
      return { browser, page };
    }

    // Check for Incapsula block on the login page itself before filling the form
    await page.goto(`${SA_BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const loginHtml = await page.content();
    if (loginHtml.includes('_Incapsula_Resource')) {
      _incapsulaBackoffUntil = Date.now() + INCAPSULA_BACKOFF_MS;
      writeSharedBackoff(_incapsulaBackoffUntil);
      const clearAt = new Date(_incapsulaBackoffUntil).toLocaleTimeString();
      logger.error('SA: Incapsula block on login page — setting 45-min backoff', { clearAt });
      await browser.close();
      throw new Error(`SA login page blocked by Incapsula bot protection. All SA operations paused until ${clearAt}.`);
    }

    await page.waitForSelector('#txtLogin', { timeout: 15000 });
    await page.type('#txtLogin', email);
    await page.type('#txtPassword', password);
    await page.click('#loginbtn');
    await page.waitForFunction(
      () => !window.location.href.includes('Login') && window.location.href !== 'https://my.serviceautopilot.com/',
      { timeout: 30000 }
    );
    await new Promise(r => setTimeout(r, 2000));
    await saveSessionCookies(page);
    logger.info('SA: login complete');
    return { browser, page }; // keep browser open — API calls route through this page
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function saPost(page, path, body, referer) {
  const url   = `${SA_BASE}${path}`;
  const saBase = SA_BASE;
  // Run fetch inside the Puppeteer browser so Incapsula sees real-browser TLS/cookies
  const result = await page.evaluate(async ({ url, body, referer, saBase }) => {
    const res = await window.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `${saBase}/${referer || ''}`,
        'Origin': saBase,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text };
  }, { url, body, referer, saBase });

  const isJson = result.text.trim().startsWith('{') || result.text.trim().startsWith('[');
  return { status: result.status, data: isJson ? JSON.parse(result.text) : null, text: result.text };
}

function looksLikeLoginPage(res) {
  return res.status === 302 || res.status === 401
    || (res.data === null && typeof res.text === 'string' && res.text.includes('txtLogin'));
}

function looksLikeIncapsula(res) {
  if (typeof res.text !== 'string') return false;
  const t = res.text.toLowerCase();
  return (
    t.includes('_incapsula_resource') ||
    t.includes('incapsula')           ||
    t.includes('imperva')             ||
    (res.status === 403 && res.data === null)
  );
}

async function post(path, body, referer) {
  readSharedBackoff();
  if (Date.now() < _incapsulaBackoffUntil) {
    const remainingMin = Math.ceil((_incapsulaBackoffUntil - Date.now()) / 60000);
    throw new Error(`SA Incapsula backoff active — ${remainingMin} min remaining before SA operations resume`);
  }
  let page = await getSession();
  let res = await saPost(page, path, body, referer);
  if (looksLikeLoginPage(res)) {
    logger.info('SA: session expired, refreshing');
    page = await getSession(true);
    res = await saPost(page, path, body, referer);
  }
  // Log any null-data response so we can see the raw content if detection misses
  if (res.data === null) {
    logger.warn('SA: null response from API', { path, status: res.status, textSlice: res.text?.slice(0, 300) });
  }
  if (looksLikeIncapsula(res)) {
    // Don't retry with another login — that adds another flagged login and makes it worse.
    // Set the backoff timer and broadcast to all other scheduler instances via shared file.
    _incapsulaBackoffUntil = Date.now() + INCAPSULA_BACKOFF_MS;
    writeSharedBackoff(_incapsulaBackoffUntil);
    const clearAt = new Date(_incapsulaBackoffUntil).toLocaleTimeString();
    logger.error('SA: Incapsula block on API call — setting 45-min backoff', { clearAt });
    throw new Error(`SA blocked by Incapsula bot protection. All SA operations paused until ${clearAt}. No further login attempts will be made.`);
  }
  return res;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toSaBrowserDate(d) {
  if (!d) return { Month: -1, Day: -1, Year: -1 };
  const dt = d instanceof Date ? d : new Date(d);
  return { Month: dt.getMonth() + 1, Day: dt.getDate(), Year: dt.getFullYear() };
}

function todayPlusDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

function sanitizeDates(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeDates);
  if ('Month' in obj && 'Day' in obj && 'Year' in obj) {
    return (obj.Month <= 0 || obj.Year <= 0) ? { Month: -1, Day: -1, Year: -1 } : obj;
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = sanitizeDates(v);
  return out;
}

function extractPlaceholders(text) {
  if (!text) return [];
  const matches = text.match(/\[[^\]]+\]/g);
  return [...new Set(matches || [])];
}


// ── Public API ────────────────────────────────────────────────────────────────

/** Returns the epoch ms timestamp when the Incapsula backoff clears (0 if not active). */
export function getSABackoffUntil() { return _incapsulaBackoffUntil; }

/**
 * Search SA clients by name.
 * Returns [{ clientId, name, address, type }]
 */
export async function searchClients({ name, limit = 10 }) {
  const filterData = JSON.stringify({
    FilterData: [{
      FieldColumn: '1',
      ContainOperator: '1',
      FieldItems: [name],
      Order: 0,
      SCFilterID: EMPTY_GUID,
    }],
    CustomFields: [],
    QuerySelection: 0,
  });

  const res = await post('/CRMBFF/AccountList/V2AccountList_Query', {
    QueryInput: {
      Settings: { FilterData: filterData },
      StartRow: 1,
      Max: limit * 3,
      SortedColumns: [{ FieldName: '', Direction: 2, ColumnEnum: 0 }],
    },
  }, 'Clients.aspx');

  const accounts = (res.data?.d || res.data)?.Accounts || [];
  const term = name.toLowerCase();
  // SA returns its "recent clients" list when no filter matches — filter client-side
  // to ensure only genuinely matching records are returned.
  return accounts
    .filter(a => (a.ClientName || '').toLowerCase().includes(term))
    .slice(0, limit)
    .map(a => ({
      clientId: a.ClientID,
      name:     a.ClientName,
      address:  a.Location || a.Address1 || '',
      type:     a.Type || '',
    }));
}

/**
 * Create a new client in SA.
 * companyName: use for business clients (overrides ClientName to company name).
 * state: 2-letter abbreviation, e.g. "WI".
 * Returns { clientId, name }
 */
export async function createClient({ firstName, lastName, companyName = '', address = '', city = '', state = '', zip = '', email = '', phone = '' }) {
  const clientName = companyName ? companyName : `${firstName} ${lastName}`;
  const stateAbbr = (state || 'WI').toUpperCase();
  const stateId   = STATE_IDS[stateAbbr] || STATE_IDS['WI'];
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const aiNote = `This entry was created by AI on ${today}. Please check the contact information for accuracy.`;

  const res = await post('/WebServices/TodoEditorWs.asmx/AddClientLead', {
    NewClientLead: {
      FirstName:      firstName,
      LastName:       lastName,
      ClientName:     clientName,
      Address:        address,
      City:           city,
      State:          stateAbbr,
      StateID:        stateId,
      Zip:            zip,
      Email:          email,
      Phone1:         phone,
      Phone1Type:     '1',
      Phone2: '', Phone2Type: '1',
      Phone3: '', Phone3Type: '1',
      Phone4: '', Phone4Type: '1',
      IsClient:       true,
      OfficeNotes:    aiNote,
      // Mirror primary address to billing address
      BillingAddress1: address,
      BillingAddress2: '',
      BillingCity:     city,
      BillingState:    stateAbbr,
      BillingStateID:  stateId,
      BillingZip:      zip,
    },
  }, 'Clients.aspx');

  const id   = res.data?.d?.ID;
  const name = res.data?.d?.Name;
  if (!id || id === EMPTY_GUID) {
    const errors = res.data?.d?.Errors;
    throw new Error(`SA createClient failed: ${errors ? JSON.stringify(errors) : res.text?.slice(0, 300)}`);
  }
  logger.info('SA: client created', { id, name });
  return { clientId: id, name };
}

/**
 * Set billing defaults: Taxable=Tax, InvoiceDelivery=Email.
 * Uses GetClientInfo → SaveClient (no puppeteer UI clicks needed).
 * Call ~5 minutes after createClient to allow SA to finish indexing.
 * Returns { clientId, sendInvoiceBy, taxable }
 */
export async function setClientBillingDefaults({ clientId }) {
  const infoRes = await post('/webservices/ClientEditOverlayWs.asmx/GetClientInfo',
    { ClientID: clientId }, 'Clients.aspx');
  const d = infoRes.data?.d;
  if (!d) throw new Error(`SA setClientBillingDefaults: GetClientInfo failed for ${clientId}: ${infoRes.text?.slice(0, 200)}`);

  function parseSaDate(v) {
    if (!v) return { Month: -1, Day: -1, Year: -1 };
    const ms = String(v).match(/\/Date\((-?\d+)\)\//);
    const dt = ms ? new Date(parseInt(ms[1])) : new Date(v);
    if (isNaN(dt.getTime())) return { Month: -1, Day: -1, Year: -1 };
    return { Month: dt.getMonth() + 1, Day: dt.getDate(), Year: dt.getFullYear() };
  }

  const info = {
    ClientID:                clientId,
    IsLead:                  false,
    saveType:                0,
    IsConvertingLead:        false,
    FirstName:               d.FirstName                        || '',
    LastName:                d.LastName                         || '',
    NickName:                d.NickName                         || '',
    ClientCompanyName:       d.ClientCompanyName                || '',
    Email:                   d.Email                            || '',
    HomePhone:               d.HomePhone                        || '',
    CellPhone:               d.CellPhone                        || '',
    ProviderID:              d.ProviderData?.Value              || EMPTY_GUID,
    WorkPhone:               d.WorkPhone                        || '',
    OtherPhone:              d.OtherPhone                       || '',
    FaxNumber:               d.FaxNumber                        || '',
    PreferredPhoneID:        d.PreferredPhoneID                 || '1',
    ClientTitle:             d.ClientTitle                      || '',
    ListID:                  d.ListID                           || EMPTY_GUID,
    QboID:                   d.QboID                            || '',
    PropertyName:            d.PropertyName                     || '',
    PropertyNameAttentionTo: d.PropertyNameAttentionTo          || '',
    Address:                 d.Address                          || '',
    AddressTwo:              d.AddressTwo                       || '',
    City:                    d.City                             || '',
    StateID:                 d.StateInfo?.Value                 || EMPTY_GUID,
    PostalCode:              d.PostalCode                       || '',
    MapCode:                 d.MapCode                          || '',
    DivisionID:              d.DivisionInfo?.Value              || EMPTY_GUID,
    NameOnInv:               d.NameOnInv                        || '',
    AttentionTo:             d.AttentionTo                      || '',
    BillingAddress:          d.BillingAddress                   || '',
    BillingAddressTwo:       d.BillingAddressTwo                || '',
    BillingCity:             d.BillingCity                      || '',
    BillingStateID:          d.BillingStateInfo?.Value          || EMPTY_GUID,
    BillingPostalCode:       d.BillingPostalCode                || '',
    SalesTaxRefID:           d.SalesTaxInfo?.Value              || EMPTY_GUID,
    MasterPropertyClientID:  d.MasterPropertyClientInfo?.Value  || EMPTY_GUID,
    CountryID:               d.CountryInfo?.Value               || EMPTY_GUID,
    DefaultBillingUnderID:   d.BillingUnderInfo?.Value          || EMPTY_GUID,
    ClientSinceDate:         parseSaDate(d.ClientSinceDate),
    CSRId:                   d.CSRInfo?.Value                   || EMPTY_GUID,
    AccountTypeID:           d.AccountTypeInfo?.Value           || EMPTY_GUID,
    PriorityID:              d.PriorityID                       || 0,
    UserName:                d.UserName                         || '',
    Password:                d.Password                         || '',
    Latitude:                d.Latitude                         || '',
    Longitude:               d.Longitude                        || '',
    SalesPersonID:           d.SalesPersonInfo?.Value           || EMPTY_GUID,
    CustomerSourceID:        d.CustomerSourceInfo?.Value        || EMPTY_GUID,
    ReferredByID:            d.ReferredByInfo?.Value            || EMPTY_GUID,
    DoNotMarket:             d.DoNotMarket                      || false,
    BillingEmail:            d.BillingEmail                     || '',
    FlagForReview:           d.FlagForReview                    || false,
    AccountNumber:           d.AccountNumber                    || '',
    SubscriptionType:        d.SubscriptionType                 || 0,
    BillingDate:             parseSaDate(d.BillingDate),
    AutoCharge:              d.AutoCharge                       || false,
    BillingNotes:            d.BillingNotes                     || '',
    PaymentMethodID:         d.PaymentMethodInfo?.Value         || EMPTY_GUID,
    SalesTaxRefID:           JRB_TAX_REF_BY_CITY[(d.City || '').toLowerCase().trim()] || JRB_TAX_REF_DEFAULT,
    SalesTaxCodeID:          JRB_TAX_CODE_ID,                                // "Tax" — taxable
    InvoiceFrequencyID:      d.InvoiceFrequencyInfo?.Value      || EMPTY_GUID,
    StandardTermID:          d.StandardTermInfo?.Value          || EMPTY_GUID,
    SendInvoiceBy:           'Email',                                         // always Email
    DefaultInvoiceFormatID:  d.DefaultInvoiceInfo?.Value        || EMPTY_GUID,
    OfficeNotes:             d.OfficeNotes                      || '',
    CCFirstName:             d.CCFirstName                      || '',
    CCLastName:              d.CCLastName                       || '',
    CCBillingAddress:        d.CCBillingAddress                 || '',
    CCBillingZip:            d.CCBillingZip                     || '',
    CCNumber:                d.CCNumber                         || '',
    CCExpiration:            d.CCExpiration                     || '',
    CCToken:                 d.CCToken                          || '',
    CCCustomerToken:         d.CCCustomerToken                  || '',
    CCBrand:                 d.CCBrand                          || '',
    Geocode:                 false,
    ManualGeocode:           false,
    UpdateManualGeocodeFlag: false,
  };

  const saveRes = await post('/webservices/ClientEditOverlayWs.asmx/SaveClient',
    { info }, 'ClientView.aspx');
  const result = saveRes.data?.d;
  if (result?.response?.Errors?.length > 0) {
    throw new Error(`SA setClientBillingDefaults SaveClient errors: ${JSON.stringify(result.response.Errors)}`);
  }
  const city = (d.City || '').toLowerCase().trim();
  const taxRefId = JRB_TAX_REF_BY_CITY[city] || JRB_TAX_REF_DEFAULT;
  logger.info('SA: billing defaults set', { clientId, city: d.City, taxRefId });
  return { clientId, sendInvoiceBy: 'Email', taxable: true, city: d.City, taxRefId };
}

/**
 * Fetch SA client details needed to post tickets.
 * Returns { clientId, customerJobId, currentUserId, currentUserType, name, address }
 */
export async function getClientDetails({ clientId }) {
  const res = await post('/WebServices/ClientViewWs.asmx/GetCustomerDataAsync', {
    customerId: clientId,
  }, 'ClientView.aspx');

  const client = res.data?.d?.Result?.Client;
  if (!client) throw new Error(`SA getClientDetails: no data returned for clientId ${clientId}`);

  return {
    clientId,
    customerJobId:    client.CustomerJobID,
    currentUserId:    client.CurrentUserID,
    currentUserType:  client.CurrentUserResourceType,
    name:    `${client.ContactFirstName || ''} ${client.ContactLastName || ''}`.trim(),
    address: client.Address1 || '',
  };
}

/**
 * Search SA service types by name.
 * Returns [{ serviceTypeId, name }]
 */
export async function searchServiceTypes({ name, limit = 20 }) {
  const res = await post('/WebServices/ListsWs.asmx/GetServiceTypes', {
    InputData: { Filter: name || '' },
  }, 'Clients.aspx');

  const items = res.data?.d?.Result || res.data?.d || [];
  const list = Array.isArray(items) ? items : (items.ServiceTypes || []);
  return list
    .filter(s => !name || s.Name?.toLowerCase().includes(name.toLowerCase()))
    .slice(0, limit)
    .map(s => ({ serviceTypeId: s.ID || s.ServiceTypeID, name: s.Name }));
}

/**
 * Create an estimate in SA.
 * lineItems: [{ serviceTypeId, qty, rate, note }]
 * Returns { quoteId, quoteNumber, lineItems: [{serviceId, serviceTypeId, note}], placeholders: ['[x]', ...] }
 */
export async function createEstimate({ clientId, title = '', lineItems = [], validFromDate, validToDays = 30 }) {
  // 1. Init blank quote
  const initRes = await post('/WebServices/QuoteWs.asmx/Query', {
    InputData: { ID: EMPTY_GUID, CustomerID: clientId, IsTemplate: false },
  }, 'V3Estimate.aspx');
  const quote = initRes.data?.d?.Result;
  if (!quote) throw new Error(`SA createEstimate: failed to init quote — ${initRes.text?.slice(0, 200)}`);

  // 2. Get default sales rep
  const repRes = await post('/WebServices/QuoteWs.asmx/GetDefaultSalesRep', {
    InputData: { CustomerID: clientId },
  }, 'V3Estimate.aspx');
  const salesRepId = repRes.data?.d?.Result?.SalesRepID || EMPTY_GUID;

  // 3. Add each service line item
  const builtItems = [];
  const allPlaceholders = [];

  for (const item of lineItems) {
    const addRes = await post('/WebServices/QuoteWs.asmx/AddService', {
      InputData: { ServiceTypeID: item.serviceTypeId, QuoteID: EMPTY_GUID },
    }, 'V3Estimate.aspx');
    const svc = addRes.data?.d?.Result;
    if (!svc) throw new Error(`SA createEstimate: AddService failed for ${item.serviceTypeId}`);

    const noteText = item.note || svc.EstimateNote || '';
    const placeholders = extractPlaceholders(noteText);
    allPlaceholders.push(...placeholders);

    const sanitized = sanitizeDates(svc);
    builtItems.push({
      ...sanitized,
      StatusEnum: 1,
      Rate: item.rate ?? svc.Rate ?? 0,
      Qty: item.qty ?? svc.Qty ?? 1,
      Total: String((item.rate ?? svc.Rate ?? 0) * (item.qty ?? svc.Qty ?? 1)),
      EstimateNote: noteText,
    });
  }

  // 4. Build save payload
  const fromDate = validFromDate ? toSaBrowserDate(validFromDate) : toSaBrowserDate(new Date());
  const toDate   = toSaBrowserDate(todayPlusDays(validToDays));

  const saveRes = await post('/WebServices/QuoteWs.asmx/Save', {
    InputData: {
      QuoteID:    EMPTY_GUID,
      IsTemplate: false,
      SaveAs:     false,
      SaveAsType: '',
      TemplateType: '1',
      ProjectID:  EMPTY_GUID,
      DetailsTab: {
        ClientLeadID:           clientId,
        Description:            title,
        PONumber:               '',
        WorkOrderNumber:        '',
        NumberOfInstallments:   '1',
        ValidFromDate:          fromDate,
        ValidToDate:            toDate,
        SalesRepID:             salesRepId,
        SourceID:               EMPTY_GUID,
        DocumentID:             EMPTY_GUID,
        StatusEnum:             0,
        QuoteStageID:           '44410183-e121-4313-93a1-7ea769bfee53',
        ReasonID:               EMPTY_GUID,
        ShowDiscountInGrid:     false,
        ServiceLineItems:       builtItems.map(s => ({ Service: s })),
        DeletedServiceLineItems:[],
        PackageLineItems:       [],
        KitLineItems:           [],
        DirectCost:             { JobCostings: [], DeletedJobCostings: [] },
      },
      NotesTab: { Notes: '' },
    },
  }, 'V3Estimate.aspx');

  const quoteId = saveRes.data?.d?.Result?.QuoteID || saveRes.data?.d?.QuoteID;
  if (!quoteId || quoteId === EMPTY_GUID) {
    const errs = saveRes.data?.d?.Errors;
    throw new Error(`SA createEstimate save failed: ${errs ? JSON.stringify(errs) : saveRes.text?.slice(0, 300)}`);
  }

  // 5. Re-query to get assigned service IDs + quote number
  const queryRes = await post('/WebServices/QuoteWs.asmx/QueryLineItems', {
    InputData: { ID: quoteId },
  }, 'V3Estimate.aspx');
  const savedItems = queryRes.data?.d?.Result?.ServiceLineItems || [];

  const returnedItems = savedItems.map((s, i) => ({
    serviceId:     s.Service?.ID || s.ID,
    serviceTypeId: s.Service?.ServiceTypeID || lineItems[i]?.serviceTypeId,
    note:          s.Service?.EstimateNote || builtItems[i]?.EstimateNote || '',
    rate:          s.Service?.Rate,
    qty:           s.Service?.Qty,
  }));

  const quoteNumber = queryRes.data?.d?.Result?.QuoteNumber || saveRes.data?.d?.Result?.QuoteNumber || '';
  const uniquePlaceholders = [...new Set(allPlaceholders)];
  logger.info('SA: estimate created', { quoteId, quoteNumber, placeholders: uniquePlaceholders });
  return { quoteId, quoteNumber, lineItems: returnedItems, placeholders: uniquePlaceholders };
}

/**
 * Update an existing estimate's line item notes (for filling in placeholders).
 * updates: [{ serviceId, note }]
 * Returns { quoteId }
 */
export async function updateEstimateNotes({ quoteId, updates = [] }) {
  const queryRes = await post('/WebServices/QuoteWs.asmx/QueryLineItems', {
    InputData: { ID: quoteId },
  }, 'V3Estimate.aspx');
  const result = queryRes.data?.d?.Result;
  if (!result) throw new Error(`SA updateEstimateNotes: could not load estimate ${quoteId}`);

  const updatedItems = (result.ServiceLineItems || []).map(item => {
    const svc = item.Service || item;
    const match = updates.find(u => u.serviceId === svc.ID);
    if (match) svc.EstimateNote = match.note;
    return { Service: sanitizeDates(svc) };
  });

  const saveRes = await post('/WebServices/QuoteWs.asmx/Save', {
    InputData: {
      QuoteID:    quoteId,
      IsTemplate: false,
      SaveAs:     false,
      SaveAsType: '',
      TemplateType: '1',
      ProjectID:  EMPTY_GUID,
      DetailsTab: {
        ClientLeadID:           result.ClientLeadID || result.CustomerID || EMPTY_GUID,
        Description:            result.Description || '',
        PONumber:               result.PONumber || '',
        WorkOrderNumber:        result.WorkOrderNumber || '',
        NumberOfInstallments:   String(result.NumberOfInstallments || '1'),
        ValidFromDate:          sanitizeDates(result.ValidFromDate) || toSaBrowserDate(new Date()),
        ValidToDate:            sanitizeDates(result.ValidToDate) || toSaBrowserDate(todayPlusDays(30)),
        SalesRepID:             result.SalesRepID || EMPTY_GUID,
        SourceID:               result.SourceID || EMPTY_GUID,
        DocumentID:             result.DocumentID || EMPTY_GUID,
        StatusEnum:             result.StatusEnum ?? 0,
        QuoteStageID:           result.QuoteStageID || '44410183-e121-4313-93a1-7ea769bfee53',
        ReasonID:               result.ReasonID || EMPTY_GUID,
        ShowDiscountInGrid:     result.ShowDiscountInGrid || false,
        ServiceLineItems:       updatedItems,
        DeletedServiceLineItems:[],
        PackageLineItems:       result.PackageLineItems || [],
        KitLineItems:           result.KitLineItems || [],
        DirectCost:             result.DirectCost || { JobCostings: [], DeletedJobCostings: [] },
      },
      NotesTab: { Notes: result.Notes || '' },
    },
  }, 'V3Estimate.aspx');

  const savedId = saveRes.data?.d?.Result?.QuoteID || saveRes.data?.d?.QuoteID;
  if (!savedId) {
    const errs = saveRes.data?.d?.Errors;
    throw new Error(`SA updateEstimateNotes failed: ${errs ? JSON.stringify(errs) : saveRes.text?.slice(0, 300)}`);
  }
  logger.info('SA: estimate notes updated', { quoteId });
  return { quoteId };
}

/**
 * Schedule a waiting-list job from an estimate.
 * serviceIds: array of line-item service IDs to schedule (or omit to schedule all)
 * Returns { jobId, clientId, quoteId }
 */
export async function createJob({ clientId, quoteId, serviceIds, startDate, invoiceNotes = '' }) {
  // 1. Get line items if serviceIds not provided
  let selectedIds = serviceIds;
  if (!selectedIds || selectedIds.length === 0) {
    const liRes = await post('/WebServices/QuoteWs.asmx/QueryLineItems', {
      InputData: { ID: quoteId },
    }, 'V3Estimate.aspx');
    const items = liRes.data?.d?.Result?.ServiceLineItems || [];
    selectedIds = items.map(i => i.Service?.ID || i.ID).filter(Boolean);
  }
  if (selectedIds.length === 0) throw new Error('SA createJob: no service line items found on estimate');

  // 2. Get job template from SA
  const templateRes = await post('/WebServices/ServiceEditorWs.asmx/CreateServiceJobFromQuote', {
    InputData: {
      QuoteID:            quoteId,
      SelectedLineItemIds: selectedIds,
      JobType:            'WaitingList',
      CustomerID:         clientId,
    },
  }, 'V3Estimate.aspx');
  const template = templateRes.data?.d;
  if (!template) throw new Error(`SA createJob: CreateServiceJobFromQuote failed — ${templateRes.text?.slice(0, 200)}`);

  // 3. Build ServiceDetails from template
  const startBrowserDate = startDate ? toSaBrowserDate(startDate) : toSaBrowserDate(todayPlusDays(7));
  const serviceDetails = (template.ServiceDetails || []).map(sd => {
    const detail = sd.ServiceDetail || sd;
    return {
      ServiceDetail: {
        ID:                    EMPTY_GUID,
        ServiceTypeID:         detail.ServiceTypeID,
        Quantity:              detail.Quantity ?? 1,
        Rate:                  detail.Rate ?? 0,
        Hours:                 detail.Hours ?? 0,
        BillableHours:         detail.BillableHours ?? 0,
        NumberOfMen:           detail.NumberOfMen ?? 0,
        BudgetedNumberOfMen:   detail.BudgetedNumberOfMen ?? 0,
        NumberOfDays:          detail.NumberOfDays ?? 0,
        InvoiceNotes:          invoiceNotes || detail.InvoiceNotes || '',
        StartDate:             startBrowserDate,
        EndDate:               { Month: -1, Day: -1, Year: -1 },
        Status:                1,
        IsUpsell:              false,
        AssignedResourceIDs:   [],
        QuoteLineItemID:       detail.QuoteLineItemID || EMPTY_GUID,
        EstimateLineItemID:    EMPTY_GUID,
        RouteSheetNote:        '',
        ProductsRate:          0,
      },
      Products:            sd.Products || [],
      InstalledProducts:   sd.InstalledProducts || [],
      BudgetedHourOverrides: sd.BudgetedHourOverrides || [],
      Appointments:        sd.Appointments || [],
      CustomPackageOrder:  sd.CustomPackageOrder ?? 0,
    };
  });

  // 4. Save waiting list job
  const saveRes = await post('/WebServices/ServiceEditorWs.asmx/SaveWaitingListService', {
    Input: {
      UserID:               EMPTY_GUID,
      JobID:                EMPTY_GUID,
      CustomerID:           clientId,
      Timing:               'WaitingList',
      QuoteID:              quoteId,
      SalesPersonID:        EMPTY_GUID,
      CSRID:                EMPTY_GUID,
      InvoiceFrequency:     1,
      InvoiceAsWorkOrder:   false,
      PaymentType:          1,
      CallAhead:            false,
      ArrivalWindow:        0,
      DontApplyMinimumAmount: false,
      PONumber:             '',
      CommissionType:       0,
      PayUsingBudgetedHours: false,
      GroupJobs:            false,
      GroupName:            '',
      RouteSheetNotes:      [],
      ServiceDetails:       serviceDetails,
    },
  }, 'V3Estimate.aspx');

  const errors = saveRes.data?.Errors || saveRes.data?.d?.Errors || [];
  if (errors.length > 0) {
    const msg = errors.join(', ');
    if (msg.includes('Object reference not set')) {
      throw new Error('SA createJob: account lacks commission configuration — contact SA support or configure commission rules in SA settings');
    }
    throw new Error(`SA createJob failed: ${msg}`);
  }

  const jobId = saveRes.data?.ProjectID || saveRes.data?.d?.ProjectID;
  if (!jobId || jobId === EMPTY_GUID) {
    throw new Error(`SA createJob: no job ID in response — ${saveRes.text?.slice(0, 300)}`);
  }
  logger.info('SA: job created', { jobId, clientId, quoteId });
  return { jobId, clientId, quoteId };
}

/**
 * Add a note (CRM ticket) to an SA client.
 * Returns { noteId, clientId }
 */
export async function addNote({ clientId, noteText }) {
  const details = await getClientDetails({ clientId });

  const res = await post('/CRMBFF/TicketEdit/TicketEdit_Ticket_PostAsync', {
    Ticket: {
      CategoryID:   null,
      TicketStatus: 0,
      EntityID:     details.customerJobId,
      EntityType:   'Account',
      DueDate:      '',
      TicketDetail: {
        TicketEventType: 1,
        Subject:         'Note',
        Body:            noteText,
        CreatedByID:     details.currentUserId,
        CreatedByType:   details.currentUserType,
      },
    },
  }, 'ClientView.aspx');

  const noteId = res.data?.ID;
  if (!noteId || noteId === EMPTY_GUID) {
    const errors = res.data?.Errors;
    throw new Error(`SA addNote failed: ${errors?.length ? errors.join(', ') : res.text?.slice(0, 300)}`);
  }
  logger.info('SA: note created', { noteId, clientId });
  return { noteId, clientId };
}

/**
 * Verify a ticket was saved in SA. SA has no ticket read endpoint; verification
 * relies on the ticketId being a valid non-empty GUID returned by addTicket.
 * addTicket only returns a GUID when SA confirms the save — this is the source of truth.
 * Returns { ticketId } if valid, null if the ID is missing or looks like an error.
 */
export async function getTicket({ ticketId }) {
  const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!ticketId || ticketId === EMPTY_GUID || !GUID_RE.test(ticketId)) return null;
  logger.info('SA: ticket verified via creation ID', { ticketId });
  return { ticketId };
}


/**
 * Add a ticket (task/follow-up) to an SA client.
 * ticketType: 'Task' | 'Call' | 'Email' | 'Note' (default 'Task')
 * Returns { ticketId, clientId }
 */
export async function addTicket({ clientId, subject, body = '', ticketType = 'Task', dueDate }) {
  const details = await getClientDetails({ clientId });

  const typeMap = { Task: 2, Call: 3, Email: 4, Note: 1 };
  const ticketEventType = typeMap[ticketType] ?? 2;

  // SA's MyDay view only shows tickets DueDate = today. Default to today so
  // new tickets are immediately visible in the SA ticket queue.
  const effectiveDueDate = dueDate ? new Date(dueDate) : new Date();
  effectiveDueDate.setHours(23, 59, 0, 0);

  // Fetch a valid resource for ticket assignment via TicketEdit_AssignedResources_GetByCompany.
  // GetCurrentResource was unreliable (returned null ID when browser wasn't on ClientView page).
  // AssignedResources is required for the ticket to appear in the company-wide MyDay queue.
  let assignedResourceId   = details.currentUserId;
  let assignedResourceType = details.currentUserType;
  logger.info('SA: addTicket fallback resource', { assignedResourceId, assignedResourceType });
  try {
    const rRes  = await post('/CRMBFF/TicketEdit/TicketEdit_AssignedResources_GetByCompany', {}, 'ClientView.aspx');
    const items = rRes.data?.Result ?? rRes.data?.d?.Result ?? rRes.data;
    logger.info('SA: company resources raw', { status: rRes.status, isArray: Array.isArray(items), count: Array.isArray(items) ? items.length : null, sample: JSON.stringify(items)?.slice(0, 300) });
    const resources = Array.isArray(items) ? items : (items?.Resources ?? items?.Items ?? []);
    if (resources.length > 0) {
      const r = resources[0];
      assignedResourceId   = r.ID   ?? r.ResourceID   ?? r.Id   ?? assignedResourceId;
      assignedResourceType = r.Type ?? r.ResourceType ?? r.ResourceTypeID ?? assignedResourceType;
      logger.info('SA: assigned resource selected', { assignedResourceId, assignedResourceType, resourceName: r.Name ?? r.DisplayName ?? r.FullName });
    } else {
      logger.warn('SA: no company resources returned, using currentUserId fallback');
    }
  } catch (e) {
    logger.warn('SA: TicketEdit_AssignedResources_GetByCompany failed', { error: e.message });
  }

  const res = await post('/CRMBFF/TicketEdit/TicketEdit_Ticket_PostAsync', {
    Ticket: {
      CategoryID:        TICKET_CATEGORIES.OTHER,
      TicketStatus:      0,
      EntityID:          details.customerJobId,
      EntityType:        'Account',
      DueDate:           effectiveDueDate.toISOString(),
      AssignedResources: [{ ResourceID: assignedResourceId, ResourceType: assignedResourceType }],
      TicketDetail: {
        TicketEventType: ticketEventType,
        Subject:         subject,
        Body:            body,
        CreatedByID:     details.currentUserId,
        CreatedByType:   details.currentUserType,
      },
    },
  }, 'ClientView.aspx');

  const ticketId = res.data?.ID;
  if (!ticketId || ticketId === EMPTY_GUID) {
    const errors = res.data?.Errors;
    throw new Error(`SA addTicket failed: ${errors?.length ? errors.join(', ') : res.text?.slice(0, 300)}`);
  }
  logger.info('SA: ticket created', { ticketId, clientId, ticketType });
  return { ticketId, clientId };
}

/**
 * Query the SA estimate list for a date range and/or stage filter.
 * stages: array of 'Draft' | 'Sent' | 'Won' | 'Lost'
 * dateFrom / dateTo: JS Date objects (filter on QuoteDate)
 * Returns raw estimate objects from the BFF response.
 */
export async function getEstimateList({ dateFrom, dateTo, stages, max = 500 } = {}) {
  const filterTypes = [];

  if (dateFrom && dateTo) {
    filterTypes.push({
      ScreenViewFilterType:      76,
      ScreenViewFilterObjects:   [],
      ScreenViewFilterTypeItems: [
        { Value: '6' },
        { Value: JSON.stringify({ Month: dateFrom.getMonth() + 1, Day: dateFrom.getDate(), Year: dateFrom.getFullYear() }) },
        { Value: JSON.stringify({ Month: dateTo.getMonth() + 1,   Day: dateTo.getDate(),   Year: dateTo.getFullYear()   }) },
      ],
    });
  }

  const body = {
    QueryInput: {
      ActiveTab:             'Results',
      StartRow:              1,
      Max:                   max,
      SortedColumns:         [{ FieldName: 'EstimateNumber', Direction: 2, ColumnEnum: 11 }],
      ScreenViewFilterTypes: filterTypes,
      ...(stages && stages.length > 0 ? { QuoteStageTypes: stages } : {}),
    },
  };

  const res = await post('/CRMBFF/Estimate/V2EstimateList_Query', body, 'QuoteList.aspx');
  const estimates = (res.data?.d || res.data)?.Estimates || [];
  logger.info('SA: estimate list fetched', { count: estimates.length, stages, dateFrom, dateTo });
  return estimates;
}
