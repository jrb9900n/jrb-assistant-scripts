// tools/impl/serviceautopilot.js — Service Autopilot read/write via browser session
// SA has no public API; we log in via puppeteer-core and call the internal BFF endpoints.
// Session cookies are cached in-process for 4 hours to avoid repeated browser launches.

import fs from 'fs';
import net from 'net';
import tls from 'tls';
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

// SA TicketStatus values — TicketList default view filters for Status:1 (Open); Status:0 tickets are hidden
const TICKET_STATUS_OPEN = 1;

// SA tag TagType values — 1 = client tags, the only type confirmed so far (30/31 seen in the wild on
// existing tags are believed to be "automation"/"marketplace" tags per AddTagOverlay.js, unconfirmed).
const CLIENT_TAG_TYPE = 1;

// SA ticket category IDs (from TicketEdit_TicketCategoryDropdown_GetByCompany)
const TICKET_CATEGORIES = {
  OTHER:            'e74cbced-0bf3-43ef-9fee-f7564af541da',
  ESTIMATE:         '13ea0f69-bb00-42a3-af41-7c4ee9737a0f',
  SCHEDULE_SERVICE: '35d51355-5fe7-4ccb-ab7b-7a48fe42980c',
  ACCOUNT_ISSUE:    '9fc6647e-0f19-4b30-8c5f-00bdf75b5938',
};

// SA "Source" dropdown on the client edit form (ClientEditOverlay.js's
// self.CustomerSourceID / self.ListCustomerSource, saved as the client record's
// CustomerSourceID field). Reverse-engineered 2026-08-29 the same way as
// STATE_IDS/TICKET_CATEGORIES: the un-minified companion bundle
// /scripts/ClientEditOverlay.js shows the dropdown is populated by
// self.GetCustomerSourceList(), which calls /WebServices/ListsWs.asmx/GetSourcesList
// (body shape `{Data:{SearchString:'', BlankEntry:true}}`, matching every other
// autocomplete-style list call in that file). Confirmed live by calling that
// endpoint directly against the production account — this is the company's
// actual, currently-configured value set, not a guess.
//
// IMPORTANT: there is no "Website" option in Michael's account as of this date.
// The closest existing values are SEARCH_ENGINE or OTHER. Before wiring up the
// website-contact-form lead pipeline this map is meant to support, either (a)
// have Michael add a real "Website" source via SA Settings -> CRM -> Customer
// Sources and add its GUID here, or (b) deliberately pick one of the existing
// values (SEARCH_ENGINE reads closest, OTHER is the safe fallback) and document
// that choice — do not fabricate a GUID that doesn't exist in the account.
const CUSTOMER_SOURCE_IDS = {
  ALTA_VISTA:        'db22ade8-9efe-40cc-b440-6b12208fbc31',
  CUSTOMER_REFERRAL: '9f7dc089-0bc9-4fb7-8238-d7b72455bdd8',
  DOOR_HANGER:       '82441163-2dc6-41be-87d0-7be23810c43b',
  GOOGLE_ADWORDS:    '0955814a-a54b-4fd7-bbac-0fcf89b68377',
  OTHER:             '6dd7428e-47ae-4a45-b7f4-a553d496b502',
  POSTCARD:          '36977442-71e9-46ec-ae7c-602ac5f7773a',
  SEARCH_ENGINE:     'b22a73eb-ebe6-496a-84e1-037185962d67',
  WOLF_PAVING:       'ec504a10-0ac3-4793-a491-a8ffd6de12a8',
  YELLOW_PAGES:      'df8a48ae-b670-4fa3-ba35-47bbe7fe83ef',
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

const SESSION_TTL_MS       = 4 * 60 * 60 * 1000; // 4 hours
const INCAPSULA_BACKOFF_MS = 45 * 60 * 1000;    // 45 min backoff when IP is flagged

// Cookie cache: restore session on restart to avoid triggering a new login.
// Path resolves to agent/sa-session-cache.json (relative to this file's location).
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
let _accountRosterCache    = null; // last full getAllSAAccounts() pull, for searchClientsFull
let _accountRosterCachedAt = 0;    // epoch ms

// Closes the live SA browser session, if any. Exported so cron.js can call this
// from a process-exit handler — a live Chromium instance kept open for up to
// SESSION_TTL_MS otherwise becomes an orphaned OS process (leaked memory) if the
// Node process exits without cleaning it up first.
export async function closeSaSession() {
  if (_browser) {
    try { await _browser.close(); } catch {}
    _browser = null;
    _page = null;
  }
}

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

// Parses SA_PROXY_URL (http://user:pass@host:port) once, shared by login() (which
// launches Chromium through it) and checkProxyHealth() (which probes it directly) —
// so both agree on what "the proxy" means instead of drifting apart over time.
function parseProxyUrl(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    const u = new URL(proxyUrl);
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    return {
      hostname: u.hostname,
      port,
      server: `${u.protocol}//${u.host}`,
      auth: u.username
        ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }
        : null,
    };
  } catch {
    return null;
  }
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

  // Residential proxy support — set SA_PROXY_URL=http://user:pass@host:port to bypass Incapsula IP blocks
  const proxyUrl = process.env.SA_PROXY_URL || '';
  const proxy = parseProxyUrl(proxyUrl);
  if (proxyUrl && !proxy) logger.warn('SA: SA_PROXY_URL is malformed — launching without proxy', { url: proxyUrl });
  if (proxy) logger.info('SA: using residential proxy', { server: proxy.server });
  const proxyAuth = proxy?.auth || null;

  puppeteerExtra.use(StealthPlugin());
  const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'];
  if (proxy) launchArgs.push(`--proxy-server=${proxy.server}`);
  const browser = await puppeteerExtra.launch({
    executablePath,
    headless: true,
    args: launchArgs,
  });

  // newPage()/authenticate()/setUserAgent() used to run outside this try block —
  // if any of them threw (all three are real network/IPC calls that can fail,
  // especially with a flaky residential proxy), the freshly-launched browser was
  // never closed and never assigned to _browser, leaking an orphaned Chromium
  // process. Moved inside so the catch below covers them too.
  try {
    const page = await browser.newPage();
    if (proxyAuth) await page.authenticate(proxyAuth);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    // Try restoring from cached cookies first — avoids triggering a new login
    const restored = await tryRestoreSession(page);
    if (restored) {
      logger.info('SA: login complete (cookie restore)');
      return { browser, page };
    }

    // Check for Incapsula block on the login page itself before filling the form
    await page.goto(`${SA_BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const loginHtml = await page.content();
    if (loginHtml.includes('_Incapsula_Resource') && !loginHtml.includes('txtLogin')) {
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

// ── Proxy health probe ───────────────────────────────────────────────────────
// window.fetch() inside the browser collapses every network failure — proxy
// auth rejection, exhausted bandwidth, DNS, TLS — into the same generic
// "Failed to fetch" TypeError, by design (the Fetch spec hides the reason
// from page JS). That makes SA outages undiagnosable from the alert alone.
// This probes the proxy directly via a raw CONNECT tunnel, bypassing the
// browser, so a real proxy-layer status (e.g. 407) can be surfaced.
//
// Phase 1 (connectPhase) opens the CONNECT tunnel, exactly as before.
// Phase 2 (checkTunnelThroughput) is new: some proxy plans (including
// Webshare's Static Residential fair-use policy — the actual cause of the
// 2026-07-31 12-hour outage) throttle data AFTER a successful CONNECT rather
// than rejecting it outright, so a CONNECT-only check reads that failure
// mode as "ok: true". Phase 2 sends one real HTTPS request through the
// already-open tunnel and requires an actual response byte to arrive before
// calling it healthy — the exact signal a bandwidth-exhausted/throttled
// tunnel can't produce, since it opens but never carries real traffic.
async function connectPhase(proxy, targetHost, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!result.socket) { try { socket.destroy(); } catch {} }
      resolve(result);
    };

    const socket = net.connect({ host: proxy.hostname, port: proxy.port });
    const timer = setTimeout(() => finish({ checked: true, ok: false, detail: 'proxy CONNECT timed out' }), timeoutMs);

    socket.on('error', (err) => {
      finish({ checked: true, ok: false, detail: `proxy connection error: ${err.message}` });
    });

    // A graceful close (no bytes ever written) doesn't raise 'error' in Node —
    // without this, a proxy that silently drops the connection (e.g. a
    // suspended account) would misreport as "timed out" after the full wait.
    socket.on('close', () => {
      finish({ checked: true, ok: false, detail: 'proxy closed the connection without responding' });
    });

    socket.on('connect', () => {
      const authHeader = proxy.auth
        ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.auth.username}:${proxy.auth.password}`).toString('base64')}\r\n`
        : '';
      socket.write(
        `CONNECT ${targetHost}:443 HTTP/1.1\r\n` +
        `Host: ${targetHost}:443\r\n` +
        authHeader +
        `Connection: close\r\n\r\n`
      );
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (!buffer.includes('\r\n')) return; // status line hasn't fully arrived yet
      const statusLine = buffer.split('\r\n')[0];
      const match = statusLine.match(/HTTP\/\d\.\d (\d{3})/);
      const status = match ? Number(match[1]) : null;
      if (status === 200) {
        // Hand the live socket to phase 2 instead of destroying it. Strip every
        // listener this phase attached first — phase 2 installs its own
        // 'data'/'error'/'close' handlers on top of the TLS wrapper, and this
        // phase's copies would otherwise stay attached (harmless no-ops once
        // `settled` is true, but pointless dangling listeners on a socket
        // that's about to be reused for something else).
        socket.removeAllListeners();
        finish({ checked: true, ok: true, status, socket });
      } else if (status === 407) {
        finish({ checked: true, ok: false, status, detail: 'proxy rejected credentials (407) — check proxy provider account/bandwidth' });
      } else {
        finish({ checked: true, ok: false, status, detail: `proxy returned unexpected response: ${statusLine.trim() || '(empty)'}` });
      }
    });
  });
}

function checkTunnelThroughput(socket, host, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let tlsSocket;
    const startedAt = Date.now();
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { tlsSocket?.destroy(); } catch {}
      try { socket.destroy(); } catch {}
      resolve(result);
    };

    const timer = setTimeout(() => finish({
      ok: false,
      detail: `proxy accepted CONNECT but no response arrived within ${timeoutMs}ms — tunnel likely open but not carrying real traffic (bandwidth exhausted/throttled)`,
    }), timeoutMs);

    try {
      tlsSocket = tls.connect({ socket, host, servername: host, rejectUnauthorized: true }, () => {
        tlsSocket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nUser-Agent: JRBAgent-ProxyHealthCheck\r\n\r\n`);
      });
    } catch (err) {
      finish({ ok: false, detail: `TLS handshake over tunnel failed to start: ${err.message}` });
      return;
    }

    tlsSocket.on('data', () => {
      // First byte of a real response is enough — this only needs to distinguish
      // "the tunnel carries real traffic" from "it doesn't", not benchmark speed.
      finish({ ok: true, detail: `tunnel carries real traffic — first response byte after ${Date.now() - startedAt}ms` });
    });
    tlsSocket.on('error', (err) => {
      finish({ ok: false, detail: `error reading through tunnel: ${err.message}` });
    });
    tlsSocket.on('close', () => {
      finish({ ok: false, detail: 'tunnel closed without any data ever arriving — likely throttled to zero' });
    });
  });
}

export async function checkProxyHealth(timeoutMs = 15000, throughputTimeoutMs = 10000) {
  // NOTE: deliberately does NOT skip during an active Incapsula backoff. This probe
  // is a raw CONNECT tunnel to the proxy itself — it never touches SA/Incapsula — so
  // an Incapsula backoff has no bearing on whether the proxy is healthy. Skipping it
  // during backoff (the previous behavior) suppressed exactly the diagnostic info
  // needed to tell "is this outage proxy-caused or Incapsula-caused" during the
  // window when that question matters most. The backoff state is still surfaced
  // below (via incapsulaBackoffActive) so callers have full context either way.
  readSharedBackoff();
  const incapsulaBackoffActive = Date.now() < _incapsulaBackoffUntil;

  const proxyUrl = process.env.SA_PROXY_URL || '';
  if (!proxyUrl) return { checked: false, detail: 'SA_PROXY_URL not set — SA calls go direct', incapsulaBackoffActive };
  const proxy = parseProxyUrl(proxyUrl);
  if (!proxy) return { checked: false, detail: 'SA_PROXY_URL is malformed', incapsulaBackoffActive };
  const targetHost = new URL(SA_BASE).hostname;

  const connectResult = await connectPhase(proxy, targetHost, timeoutMs);
  if (!connectResult.ok) {
    return { ...connectResult, incapsulaBackoffActive };
  }

  const throughputResult = await checkTunnelThroughput(connectResult.socket, targetHost, throughputTimeoutMs);
  return {
    checked: true,
    ok: throughputResult.ok,
    status: connectResult.status,
    detail: throughputResult.ok
      ? `proxy accepted the connection and real traffic flows through it — ${throughputResult.detail}`
      : `proxy accepted the CONNECT handshake, but ${throughputResult.detail}`,
    incapsulaBackoffActive,
  };
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

async function saGet(page, url) {
  const result = await page.evaluate(async (url) => {
    const res = await window.fetch(url, { credentials: 'include' });
    const text = await res.text();
    return { status: res.status, text };
  }, url);
  return result;
}

/**
 * Read-only raw GET fetch inside the live SA browser session (same TLS/cookie
 * context as post()). Used for investigative work — e.g. pulling down SA's own
 * minified JS bundles to search for endpoint names not otherwise documented.
 */
export async function fetchRawUrl({ url }) {
  const page = await getSession();
  return saGet(page, url);
}

/**
 * Actually navigates the live browser tab to a client's ClientView.aspx page
 * (a real page.goto(), not just a spoofed Referer header). Some SA endpoints
 * (confirmed: GetQboCompanyData) throw a server-side NullReferenceException
 * unless the ASP.NET session has real per-session state from having loaded
 * that specific customer's page first — a plain XHR with a Referer header
 * alone isn't enough for those. Call this before such endpoints.
 */
export async function navigateToClientView({ clientId }) {
  const page = await getSession();
  await page.goto(`${SA_BASE}/ClientView.aspx?ID=${clientId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Give the page's own onload JS (which establishes server-side session context) a moment to run.
  await new Promise(r => setTimeout(r, 3000));
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

// SA's ScheduledWork response gives StartDate/EndDate/DateCompleted as "M/D/YYYY" strings
function parseSaMdy(s) {
  if (!s) return null;
  const [m, d, y] = String(s).split('/').map(Number);
  if (!m || !d || !y) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Maps a raw ScheduledWorkWs.asmx/Query item to the sa_jobs table schema (fleetops Supabase)
function mapScheduledWorkItem(item) {
  const now = new Date().toISOString();
  return {
    id: item.ID,
    start_date: parseSaMdy(item.StartDate),
    customer_id: item.CustomerID || null,
    invoice_id: item.InvoiceID || null,
    client: item.Client || '',
    address: item.Address || null,
    city: item.City || null,
    state: item.State || null,
    zip: item.Zip || null,
    service: item.Service || null,
    assigned: item.Assigned || null,
    assigned_resource_id: item.AssignedResourceID || null,
    sales_rep: item.SalesRep || null,
    end_date: parseSaMdy(item.EndDate),
    start_time: item.StartTime || null,
    end_time: item.EndTime || null,
    date_completed: parseSaMdy(item.DateCompleted),
    completed_username: item.CompletedUsername || null,
    status: item.Status ?? null,
    sub_status: item.SubStatus || null,
    priority: item.Priority ?? null,
    schedule_type: item.ScheduleType || null,
    is_rescheduled: !!item.IsRescheduled,
    amount: item.Amount ?? null,
    rate: item.Rate ?? null,
    hours: item.Hours ?? null,
    total_man_hours: item.TotalManHours ?? null,
    budgeted_hours: item.BudgetedHours ?? null,
    latitude: item.Latitude ?? null,
    longitude: item.Longitude ?? null,
    internal_scheduling_notes: item.InternalSchedulingNotes || null,
    has_route_sheet_notes: !!item.HasRouteSheetNotes,
    has_comments: !!item.HasComments,
    job_comments: item.JobComments || [],
    raw_json: item,
    first_seen_at: now,
    last_synced_at: now,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Returns the epoch ms timestamp when the Incapsula backoff clears (0 if not active). */
export function getSABackoffUntil() { return _incapsulaBackoffUntil; }

/** Generic authenticated POST for investigative use — returns raw {status, data, text}. */
export async function postRaw({ path, body, referer }) {
  return post(path, body, referer || 'ClientView.aspx');
}

/** Fetches SA's own payment record — the only known way to inspect a payment's QBO sync state. */
export async function getPaymentData({ paymentId }) {
  const res = await post('/WebServices/PaymentOverlayWs.asmx/GetPaymentData', { PaymentID: paymentId }, 'ClientView.aspx');
  const d = res.data?.d || res.data;
  if (!d) throw new Error(`SA getPaymentData failed for ${paymentId}: ${res.text?.slice(0, 200)}`);
  return d;
}

/**
 * Search SA clients by name.
 * Returns [{ clientId, name, address, type }]
 *
 * maxScan bounds how many total accounts get paged through client-side before
 * giving up. Defaults small (matches this function's old effective behavior)
 * so low-stakes/high-frequency callers like the connectivity-check ping stay
 * cheap. scheduling-visits.js's client lookup and the sa_search_clients tool
 * used to pass a much higher maxScan directly; both now call searchClientsFull
 * below instead, which tries this function first (same maxScan:3000 fast path)
 * and only falls back to a full-roster scan when this returns nothing.
 */
export async function searchClients({ name, limit = 10, maxScan = 30 }) {
  // QuerySelection:3 returns Clients + Leads + Closed Leads (0 = Clients only, misses newly created Leads).
  // FieldColumn:"28"/ContainOperator:"7" enables all-statuses filter required for QS:3.
  //
  // Confirmed live 2026-08-24 (Michael's "Village Estates"/"Doedens" accounts
  // came back as zero results across every name variant tried, even though
  // both genuinely exist in SA): FieldColumn:'1' (name) is a server-side
  // no-op regardless of ContainOperator -- SA always returns the same
  // "recent clients" list no matter what name is filtered on. There is no
  // real server-side name search to call, so this pages through the actual
  // account population itself (same pattern as getClientsByTag) and matches
  // client-side, instead of trusting a filter that doesn't filter.
  const filterData = JSON.stringify({
    FilterData: [
      { FieldColumn: '28', ContainOperator: '7', FieldItems: [], Order: 0, SCFilterID: EMPTY_GUID },
    ],
    CustomFields: [],
    QuerySelection: 3,
  });

  const term = name.toLowerCase();
  const matches = [];
  let startRow = 1;
  let scanned = 0;
  const pageSize = 500;
  while (matches.length < limit && scanned < maxScan) {
    const res = await post('/CRMBFF/AccountList/V2AccountList_Query', {
      QueryInput: {
        Settings: { FilterData: filterData },
        StartRow: startRow,
        Max: Math.min(pageSize, maxScan - scanned),
        SortedColumns: [{ FieldName: '', Direction: 2, ColumnEnum: 0 }],
      },
    }, 'Clients.aspx');
    const accounts = (res.data?.d || res.data)?.Accounts || [];
    if (accounts.length === 0) break;
    scanned += accounts.length;
    for (const a of accounts) {
      if ((a.ClientName || '').toLowerCase().includes(term)) {
        matches.push({
          clientId: a.ClientID,
          name:     a.ClientName,
          address:  a.Location || a.Address1 || '',
          type:     a.Type || '',
          isLead:   a.Type === 'Lead',
        });
        if (matches.length >= limit) break;
      }
    }
    if (accounts.length < pageSize) break;
    startRow += pageSize;
  }
  return matches;
}

const ACCOUNT_ROSTER_TTL_MS = 10 * 60_000;

// Dedupe concurrent full-roster fetches (same reasoning as _loginPromise above) --
// the LLM can issue parallel tool_use calls in one turn, and without this two
// simultaneous cold-cache searches would each kick off their own ~30-40s
// getAllSAAccounts pull, doubling SA session load for no benefit.
let _accountRosterPromise = null;

async function getFreshAccountRoster() {
  const now = Date.now();
  if (_accountRosterCache && now - _accountRosterCachedAt <= ACCOUNT_ROSTER_TTL_MS) {
    return _accountRosterCache;
  }
  if (!_accountRosterPromise) {
    _accountRosterPromise = getAllSAAccounts({ max: 20000 })
      .then(accounts => {
        _accountRosterCache = accounts;
        _accountRosterCachedAt = Date.now();
        return accounts;
      })
      .finally(() => { _accountRosterPromise = null; });
  }
  return _accountRosterPromise;
}

/**
 * Reliable client name search: tries searchClients' cheap maxScan:3000 partial scan
 * first (fast path -- covers most searches, since most accounts do sort within the
 * first 3000 rows), and only falls back to a full-roster scan when that returns
 * nothing.
 *
 * Confirmed live 2026-08-28: even at maxScan:3000, searchClients can still miss
 * real, active accounts -- reproduced directly with "Palzewicz" returning 0 matches
 * despite 2 real live client records existing, out of SA's ~10,300-account
 * population. SortedColumns' actual sort key (`{FieldName:'', ...}`) doesn't
 * correlate with recency or anything else useful for prioritizing a partial scan,
 * so any fixed maxScan below the full account count will keep missing accounts
 * that happen to sort past the cutoff for some names -- not a tunable threshold,
 * a structural gap in the partial-scan approach. The fallback scans the entire
 * live roster instead (one getAllSAAccounts pass, cached for ACCOUNT_ROSTER_TTL_MS)
 * and matches client-side, same as searchClients -- but only pays that ~30-40s cost
 * on the exact case that used to return a false "not found."
 *
 * Cache invalidation: createClient() below clears the cache on a successful create,
 * so a client search immediately after creating one doesn't hit stale data and
 * risk a duplicate create.
 */
export async function searchClientsFull({ name, limit = 10 }) {
  const quick = await searchClients({ name, limit, maxScan: 3000 });
  if (quick.length > 0) return quick;

  const roster = await getFreshAccountRoster();
  const term = name.toLowerCase();
  return roster
    .filter(a => (a.name || '').toLowerCase().includes(term))
    .slice(0, limit);
}

// ── Duplicate-client safety net ──────────────────────────────────────────────
//
// Michael's explicit standing rule (the reason this whole section exists):
// "For anything that touches SA, you will need to check to make sure there is
// not a duplicate client or lead entry -- checking things like address, email,
// phone number, etc and ensuring that a client is not accidentally
// duplicated." A website-lead pipeline runs unattended, so it cannot rely on
// SA's own name search (searchClients/searchClientsFull) alone -- that filter
// is a confirmed server-side no-op (see searchClientsFull's own comment above)
// and only ever matches on name, never email/phone/address.
//
// Known limitation, not fixed here: findDuplicateClient()/createClientSafe()
// are check-then-act, not atomic -- there's no server-side unique constraint
// or distributed lock to enforce this against. Two calls landing close enough
// together (both reading the roster before either's createClient() call
// invalidates the cache) could each pass the check and both create a record
// for the same lead. Acceptable for now given the expected call pattern (one
// lead at a time from a single pipeline, not a burst of concurrent creates),
// but worth revisiting with a real lock/queue if that assumption changes.

/**
 * Digit-only phone normalization. Strips +1 country code and any non-digit
 * characters, storing as a 10-digit string. Shared by createClient (so a
 * client's own stored phone is normalized the same way) and
 * findDuplicateClient (so an incoming phone is compared apples-to-apples
 * against phone data fetched from SA).
 */
function normalizePhoneDigits(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

/**
 * Case/whitespace/punctuation-insensitive address comparison key, plus
 * collapsing the handful of common street-suffix and directional
 * abbreviations SA data uses inconsistently (e.g. "123 Main St" vs "123 Main
 * Street", "N Main St" vs "North Main St") so those aren't treated as
 * different addresses. Deliberately simple -- not a full USPS
 * address-standardization pass, per the "don't over-engineer" scope for this.
 */
const ADDRESS_TOKEN_MAP = {
  street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', lane: 'ln',
  court: 'ct', boulevard: 'blvd', circle: 'cir', place: 'pl', terrace: 'ter',
  parkway: 'pkwy', highway: 'hwy', trail: 'trl', square: 'sq',
  north: 'n', south: 's', east: 'e', west: 'w',
};
function normalizeAddress(address) {
  if (!address) return '';
  return address
    .toLowerCase()
    .replace(/[.,#]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map(tok => ADDRESS_TOKEN_MAP[tok] || tok)
    .join(' ')
    .trim();
}

/** Case/whitespace/punctuation-insensitive name comparison key. */
function normalizeName(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * SA's Email field sometimes holds more than one address joined by ";"/","
 * (see getClientEmail's own comment on malformed Email values) -- split
 * defensively so a duplicate check doesn't miss a match sitting behind a
 * second address on the SA side.
 */
function normalizeEmailList(raw) {
  return (raw || '').split(/[;,]/).map(s => s.trim().toLowerCase()).filter(Boolean);
}

// Bounds how many roster candidates get a live per-account phone lookup (SA's
// bulk account-list response has no phone field at all -- confirmed live
// 2026-08-29 against 2,004 real accounts, 0 had a non-empty phone from
// getAllSAAccounts, matching what getSAClientPhone's own comment already
// said). Phone confirmation therefore only ever runs against whatever
// candidate set the cheap roster-level signals (email/address/name) already
// narrowed down to, never as an independent full-roster scan -- that would be
// 10,000+ sequential GetClientInfo calls, far too slow and a real Incapsula-
// lockout risk for what should be a quick pre-create check.
const DUPLICATE_PHONE_CONFIRM_CAP = 15;

// Bounds the *phone-only* fallback below (no email/address/name given at
// all). Re-confirmed live 2026-08-29, more exhaustively than the note above:
// dumped every raw key V2AccountList_Query returns across a live sample (full
// key list, not just the fields mapSAAccount happens to extract) -- there is
// no phone field under any name. Also checked the dispatch board's bulk list
// endpoint (WebServices/ScheduledWorkWs.asmx/Query, ~144 real live jobs) on
// the theory crews might need phone for route calls -- same result, full key
// dump has no phone field there either (only a `HasEmail` boolean). This is a
// genuine, structural gap across every bulk/list SA endpoint found so far,
// not a mapping bug -- phone only ever comes back from a *per-client* detail
// call (GetClientInfo / GetCustomerDataAsync, both confirmed live to return
// real phone data on real accounts).
//
// A phone-only dedup check therefore has no way to search all ~10,300
// accounts cheaply. But the realistic risk for an unattended lead pipeline
// isn't an arbitrary old account -- it's a duplicate of something created
// RECENTLY (the same lead resubmitting a form, a callback reaching an
// already-created record). mapSAAccount's `createdDate` (from
// ClientSince/LeadSince, present on every roster row even though phone isn't)
// lets this fallback scan just the N most-recently-created accounts via a
// bounded set of live GetClientInfo calls, instead of giving up outright.
// Confirmed live: the 30/60/90-day-old account counts are 12/164/228 out of
// 10,291 total, so a fixed count cap (rather than a date window, which could
// spike unboundedly during a real onboarding burst) keeps this a predictable,
// bounded cost regardless of how many accounts were recently created.
//
// Re-checked again 2026-08-29 after Michael named the exact field names
// (CellPhone/HomePhone/WorkPhone/OtherPhone) as a specific lead to chase.
// Those names are real -- GetClientInfo's full raw response was dumped (all
// 113 keys) and contains exactly HomePhone/CellPhone/WorkPhone/OtherPhone
// (plus PreferredPhoneID), matching Michael's casing precisely. But a fresh
// live V2AccountList_Query pull that same day still had zero "phone"-matching
// keys (case-insensitive grep across all 50 returned keys), and neither did
// four speculative request-body mutations tried against the live endpoint --
// CustomFields:[the four names] (CustomFields is SA's user-defined
// CustomField1-6 mechanism, not a general column selector -- confirmed from
// the live client-side ClientList.js source itself), Settings.SelectedColumns,
// Settings.Columns, and a top-level Fields array -- all four came back with
// the identical 50-key shape, no phone key gained. The live
// /scripts/ClientList.js bundle (the actual client-side code that builds this
// exact V2AccountList_Query request and renders its response, fetched fresh
// that day, not a stale archived copy) contains zero occurrences of the
// substring "phone" anywhere in 171KB of source. Conclusion stands: this is a
// hardcoded, fixed server-side response shape with no hidden request
// parameter to unlock phone data, not an undiscovered configuration option --
// the bounded recent-scan fallback below is the right permanent approach, not
// a placeholder pending a better answer.
const PHONE_ONLY_RECENT_SCAN_CAP = 50;

/**
 * Checks SA for a likely-existing client/lead before a new one gets created,
 * using independent signals instead of trusting SA's own broken name search
 * (see searchClientsFull's comment). Every signal is checked against the
 * cached full account roster (getFreshAccountRoster/getAllSAAccounts) except
 * phone, which the roster doesn't carry at all -- phone gets a bounded set of
 * live GetClientInfo confirmations against whatever email/address/name
 * already surfaced as candidates (see DUPLICATE_PHONE_CONFIRM_CAP above).
 *
 * A phone-only check (no email/address/name given) can't scan the full
 * ~10,300-account population -- no bulk SA endpoint carries phone at all (see
 * PHONE_ONLY_RECENT_SCAN_CAP's comment for what was actually tried live).
 * Instead of returning "unsupported" and doing nothing, this bounds the scan
 * to the PHONE_ONLY_RECENT_SCAN_CAP most-recently-created accounts (by
 * ClientSince/LeadSince) -- covers the realistic case (a duplicate of
 * something created recently) at a predictable cost, and says so plainly via
 * the returned `note` when it can't guarantee full-population coverage.
 *
 * Confidence rules (mirrors the lesson already learned the hard way in the SA
 * Client Categorization HOA-dedup work -- see CLAUDE.md's "Address alone is
 * deliberately not enough" note, where condo unit owners legitimately share
 * one building's street address with the HOA's own record):
 *   - 'high': an exact email match, OR a confirmed phone match, OR 2+
 *     independent signals agreeing on the same candidate (e.g. name+address).
 *     Strong identity signals or corroborated weak ones -- highest confidence.
 *   - 'medium': exactly one weaker signal alone (address-only, or name-only).
 *     Real false-positive patterns exist for both (shared-building addresses;
 *     common person/business names) but Michael was explicit that missing a
 *     real duplicate is not acceptable for an unattended pipeline, so this is
 *     still reported as isDuplicate:true -- a false-positive block just costs
 *     one human glance, a missed duplicate corrupts the CRM.
 *   - 'none': no candidates found at all.
 *
 * Returns { isDuplicate, confidence, matches: [{clientId, name, address,
 * email, isLead, matchedOn}], note? }. `note` is only present when the phone
 * check couldn't cover the full account population (see above). Never throws
 * for "not found" -- only throws if literally no identifying field was passed
 * at all.
 */
export async function findDuplicateClient({ email = '', phone = '', address = '', city = '', zip = '', firstName = '', lastName = '', companyName = '' } = {}) {
  const normEmails = normalizeEmailList(email);
  const normPhone  = normalizePhoneDigits(phone);
  const normAddr   = normalizeAddress(address);
  const normZip    = (zip || '').trim();
  const nameForMatch = companyName || `${firstName} ${lastName}`.trim();
  const normName   = normalizeName(nameForMatch);

  if (!normEmails.length && !normPhone && !normAddr && !normName) {
    throw new Error('SA findDuplicateClient: provide at least one of email, phone, address, or firstName/lastName/companyName to check against');
  }

  const roster = await getFreshAccountRoster();

  const candidates = new Map(); // clientId -> { ...fields, matchedOn: Set }
  function addCandidate(a, signal) {
    if (!candidates.has(a.clientId)) {
      candidates.set(a.clientId, {
        clientId: a.clientId,
        name: a.name,
        address: [a.address, a.city, a.state, a.zip].filter(Boolean).join(', '),
        email: a.email,
        isLead: a.isLead,
        matchedOn: new Set(),
      });
    }
    candidates.get(a.clientId).matchedOn.add(signal);
  }

  if (normEmails.length) {
    for (const a of roster) {
      const rosterEmails = normalizeEmailList(a.email);
      if (rosterEmails.some(e => normEmails.includes(e))) addCandidate(a, 'email');
    }
  }
  if (normAddr) {
    for (const a of roster) {
      if (normalizeAddress(a.address) === normAddr && (!normZip || (a.zip || '').trim() === normZip)) {
        addCandidate(a, 'address');
      }
    }
  }
  if (normName) {
    for (const a of roster) {
      if (normalizeName(a.name) === normName) addCandidate(a, 'name');
    }
  }

  let phoneCoverageNote = null;
  if (normPhone) {
    if (candidates.size === 0) {
      // No email/address/name to narrow the search -- fall back to a bounded
      // scan of the most-recently-created accounts (see
      // PHONE_ONLY_RECENT_SCAN_CAP's comment for why this is the practical
      // substitute for a full-population phone search, which no bulk SA
      // endpoint supports).
      const recentSorted = roster
        .filter(a => a.createdDate)
        .sort((a, b) => (a.createdDate < b.createdDate ? 1 : a.createdDate > b.createdDate ? -1 : 0))
        .slice(0, PHONE_ONLY_RECENT_SCAN_CAP);
      for (const a of recentSorted) {
        try {
          const candidatePhone = await getSAClientPhone(a.clientId);
          if (normalizePhoneDigits(candidatePhone) === normPhone) {
            addCandidate(a, 'phone');
          }
        } catch (e) {
          logger.warn('SA findDuplicateClient: phone-only recent-scan lookup failed', { clientId: a.clientId, error: e.message });
        }
      }
      phoneCoverageNote = `Phone-only check: no email/address/name given to narrow the search, so only the ${recentSorted.length} most-recently-created SA accounts (out of ~${roster.length} total) were checked against this phone number -- not the full population. Provide email, address, or a name for full-population coverage instead.`;
    } else {
      const toCheck = [...candidates.values()].slice(0, DUPLICATE_PHONE_CONFIRM_CAP);
      if (candidates.size > DUPLICATE_PHONE_CONFIRM_CAP) {
        logger.warn('SA findDuplicateClient: candidate set larger than the phone-confirmation cap, checking only the first N', {
          total: candidates.size, checked: DUPLICATE_PHONE_CONFIRM_CAP,
        });
      }
      for (const c of toCheck) {
        try {
          const candidatePhone = await getSAClientPhone(c.clientId);
          if (normalizePhoneDigits(candidatePhone) === normPhone) {
            candidates.get(c.clientId).matchedOn.add('phone');
          }
        } catch (e) {
          logger.warn('SA findDuplicateClient: phone confirmation lookup failed', { clientId: c.clientId, error: e.message });
        }
      }
    }
  }

  const matches = [...candidates.values()].map(c => ({
    clientId: c.clientId,
    name: c.name,
    address: c.address,
    email: c.email,
    isLead: c.isLead,
    matchedOn: [...c.matchedOn],
  }));

  let confidence = 'none';
  for (const m of matches) {
    const hasStrongSignal = m.matchedOn.includes('email') || m.matchedOn.includes('phone');
    if (hasStrongSignal || m.matchedOn.length >= 2) { confidence = 'high'; break; }
    if (m.matchedOn.length === 1) confidence = 'medium';
  }

  return {
    isDuplicate: matches.length > 0,
    confidence,
    matches,
    ...(phoneCoverageNote ? { note: phoneCoverageNote } : {}),
  };
}

/**
 * Create a new client in SA.
 * companyName: use for business clients (overrides ClientName to company name).
 * state: 2-letter abbreviation, e.g. "WI".
 * Returns { clientId, name }
 */
export async function createClient({ firstName, lastName, companyName = '', address = '', city = '', state = '', zip = '', email = '', phone = '' }) {
  const normalizedPhone = normalizePhoneDigits(phone);

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
      Phone1:         normalizedPhone,
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
  // Invalidate the searchClientsFull roster cache -- otherwise a search-before-create
  // duplicate check run again within ACCOUNT_ROSTER_TTL_MS would hit the stale
  // pre-creation roster, find nothing, and let a caller create a real duplicate.
  _accountRosterCache = null;
  return { clientId: id, name };
}

/**
 * Safe, source-attributed client/lead creation -- the version an unattended
 * pipeline (e.g. website contact-form leads) should actually call, never
 * createClient() directly. Runs findDuplicateClient() first and refuses to
 * create anything if a likely match turns up; only on a clean check does it
 * call createClient(), then records the lead source two ways:
 *   - the native CustomerSourceID field, via the same GetClientInfo ->
 *     override -> SaveClient round trip setClientBillingDefaults/
 *     saveClientFields already use elsewhere in this file (AddClientLead has
 *     no field for this, confirmed from its own payload shape above)
 *   - a "Lead Source: <label>" client tag, via the existing tag primitives --
 *     the native Source field is real but not very discoverable in SA's UI,
 *     so the tag makes it visible on the client's own Tags panel too
 *
 * `leadSource` is a key into CUSTOMER_SOURCE_IDS (e.g. 'SEARCH_ENGINE',
 * 'OTHER') -- see that constant's own comment for why there's currently no
 * 'WEBSITE' entry. Case-insensitive and space/underscore-insensitive ('search
 * engine' matches SEARCH_ENGINE); an unrecognized key skips the native
 * field (logged) but still applies the tag with whatever label was passed, so
 * a real value isn't silently lost while CUSTOMER_SOURCE_IDS catches up.
 *
 * Returns one of:
 *   { created: true, clientId, name, leadSourceApplied }
 *   { created: false, duplicate: <findDuplicateClient's return> }
 * -- never creates a duplicate silently. Callers (and any human reviewing a
 * `created: false` result) should look at `duplicate.confidence` and
 * `duplicate.matches[].matchedOn` to judge whether it's a real duplicate or a
 * false positive worth overriding by calling createClient() directly.
 */
export async function createClientSafe({ firstName, lastName, companyName = '', address = '', city = '', state = '', zip = '', email = '', phone = '', leadSource = '' } = {}) {
  const dup = await findDuplicateClient({ email, phone, address, city, zip, firstName, lastName, companyName });
  if (dup.isDuplicate) {
    logger.warn('SA createClientSafe: refusing to create — likely duplicate found', {
      confidence: dup.confidence, matchCount: dup.matches.length,
    });
    return { created: false, duplicate: dup };
  }

  const { clientId, name } = await createClient({ firstName, lastName, companyName, address, city, state, zip, email, phone });

  let leadSourceApplied = null;
  if (leadSource) {
    const sourceId = CUSTOMER_SOURCE_IDS[String(leadSource).toUpperCase().trim().replace(/\s+/g, '_')];
    if (sourceId) {
      try {
        // Not using saveClientFields's `expect` param here: it does a flat
        // verify[field] comparison, but GetClientInfo never returns a flat
        // CustomerSourceID -- only CustomerSourceInfo.Value (same
        // Field vs. FieldInfo.Value split as StateID/StateInfo.Value
        // elsewhere in this file). Confirmed live 2026-08-29: passing
        // expect:{CustomerSourceID: sourceId} always "failed" (verify.
        // CustomerSourceID read back undefined) even on a save that had
        // actually succeeded, because it was comparing against a key that
        // doesn't exist in GetClientInfo's response shape. Check the real
        // nested field instead, and only warn (don't throw) on a mismatch --
        // losing lead-source attribution isn't worth failing the whole
        // client creation over.
        const verify = await saveClientFields({ clientId, overrides: { CustomerSourceID: sourceId } });
        if (verify?.CustomerSourceInfo?.Value !== sourceId) {
          logger.warn('SA createClientSafe: CustomerSourceID did not verify after save', {
            clientId, sourceId, verifiedValue: verify?.CustomerSourceInfo?.Value,
          });
        }
      } catch (e) {
        logger.warn('SA createClientSafe: failed to set native CustomerSourceID', { clientId, leadSource, error: e.message });
      }
    } else {
      logger.warn('SA createClientSafe: leadSource not found in CUSTOMER_SOURCE_IDS — native Source field left unset', {
        leadSource, known: Object.keys(CUSTOMER_SOURCE_IDS),
      });
    }
    try {
      const category = await findOrCreateTagCategory({ name: 'Lead Source' });
      await addTagToClientByName({ clientId, tagName: `Lead Source: ${leadSource}`, categoryId: category.categoryId });
      leadSourceApplied = leadSource;
    } catch (e) {
      logger.warn('SA createClientSafe: failed to apply Lead Source tag', { clientId, leadSource, error: e.message });
    }
  }

  return { created: true, clientId, name, leadSourceApplied };
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
    // GetClientInfo returns dates as {Month, Day, Year} objects — validate before round-tripping
    // (SA can store invalid dates like April 31 which the server rejects on save)
    if (typeof v === 'object' && 'Month' in v && 'Day' in v && 'Year' in v) {
      const { Month, Day, Year } = v;
      if (Month > 0 && Day > 0 && Year > 0) {
        const dt = new Date(Year, Month - 1, Day);
        if (dt.getMonth() + 1 === Month && dt.getDate() === Day) return { Month, Day, Year };
      }
      return { Month: -1, Day: -1, Year: -1 };
    }
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
  // SA returns 500 for QBO-synced clients with valid data due to a server-side bug in post-save
  // QBO sync code. SA auto-applies company billing defaults on client creation, so the defaults
  // are already correct even when SaveClient fails. Report current defaults from GetClientInfo.
  const city = (d.City || '').toLowerCase().trim();
  const taxRefId = JRB_TAX_REF_BY_CITY[city] || JRB_TAX_REF_DEFAULT;
  if (saveRes.status === 500) {
    logger.warn('SA: SaveClient returned 500 (SA QBO-sync bug) — billing defaults read from GetClientInfo', {
      clientId, city: d.City,
      sendInvoiceBy: d.SendInvoiceBy,
      taxCode: d.SalesTaxCodeInfo?.Text,
      taxRef: d.SalesTaxInfo?.Text,
    });
    return {
      clientId,
      sendInvoiceBy: d.SendInvoiceBy || 'unknown',
      taxable: !!(d.SalesTaxCodeInfo?.Value && d.SalesTaxCodeInfo.Value !== EMPTY_GUID),
      city: d.City,
      taxRefId: d.SalesTaxInfo?.Value || taxRefId,
      savedViaApi: false,
    };
  }
  logger.info('SA: billing defaults set', { clientId, city: d.City, taxRefId });
  return { clientId, sendInvoiceBy: 'Email', taxable: true, city: d.City, taxRefId, savedViaApi: true };
}

/**
 * Set (or correct) the QboID link on an existing SA client record — the field SA
 * uses to know which QBO customer an invoice should sync to. Round-trips every
 * other field unchanged via GetClientInfo -> SaveClient (same pattern as
 * setClientBillingDefaults) so this touches nothing else on the client record —
 * no billing values, no invoice/line-item data. Never creates a new SA client.
 * Returns { clientId, previousQboId, newQboId, savedViaApi }
 */
function parseSaDate(v) {
  if (!v) return { Month: -1, Day: -1, Year: -1 };
  if (typeof v === 'object' && 'Month' in v && 'Day' in v && 'Year' in v) {
    const { Month, Day, Year } = v;
    if (Month > 0 && Day > 0 && Year > 0) {
      const dt = new Date(Year, Month - 1, Day);
      if (dt.getMonth() + 1 === Month && dt.getDate() === Day) return { Month, Day, Year };
    }
    return { Month: -1, Day: -1, Year: -1 };
  }
  const ms = String(v).match(/\/Date\((-?\d+)\)\//);
  const dt = ms ? new Date(parseInt(ms[1])) : new Date(v);
  if (isNaN(dt.getTime())) return { Month: -1, Day: -1, Year: -1 };
  return { Month: dt.getMonth() + 1, Day: dt.getDate(), Year: dt.getFullYear() };
}

/**
 * Read-modify-write an SA client via ClientEditOverlayWs.asmx, round-tripping
 * the full record from GetClientInfo unchanged except for whatever's in
 * `overrides`. Full field list confirmed from a real SaveClient capture
 * 2026-07-31/08-03 (setClientQboId, setClientBillingDefaults). `expect` is an
 * optional {field: expectedValue} map checked against a fresh GetClientInfo
 * read after saving — SA returns HTTP 500 for QBO-linked clients on a known
 * server-side post-save-sync bug even when the write succeeded, so the
 * response status is never trusted, only a fresh read.
 */
export async function saveClientFields({ clientId, overrides = {}, expect = {} }) {
  const infoRes = await post('/webservices/ClientEditOverlayWs.asmx/GetClientInfo',
    { ClientID: clientId }, 'Clients.aspx');
  const d = infoRes.data?.d;
  if (!d) throw new Error(`SA saveClientFields: GetClientInfo failed for ${clientId}: ${infoRes.text?.slice(0, 200)}`);

  const info = {
    ClientID: clientId, IsLead: false, saveType: 0, IsConvertingLead: false,
    FirstName: d.FirstName || '', LastName: d.LastName || '', NickName: d.NickName || '',
    ClientCompanyName: d.ClientCompanyName || '', Email: d.Email || '',
    HomePhone: d.HomePhone || '', CellPhone: d.CellPhone || '',
    ProviderID: d.ProviderData?.Value || EMPTY_GUID,
    WorkPhone: d.WorkPhone || '', OtherPhone: d.OtherPhone || '', FaxNumber: d.FaxNumber || '',
    PreferredPhoneID: d.PreferredPhoneID || '1', ClientTitle: d.ClientTitle || '',
    ListID: d.ListID || EMPTY_GUID,
    QboID: d.QboID || '',
    PropertyName: d.PropertyName || '', PropertyNameAttentionTo: d.PropertyNameAttentionTo || '',
    Address: d.Address || '', AddressTwo: d.AddressTwo || '', City: d.City || '',
    StateID: d.StateInfo?.Value || EMPTY_GUID, PostalCode: d.PostalCode || '',
    MapCode: d.MapCode || '', DivisionID: d.DivisionInfo?.Value || EMPTY_GUID,
    NameOnInv: d.NameOnInv || '', AttentionTo: d.AttentionTo || '',
    BillingAddress: d.BillingAddress || '', BillingAddressTwo: d.BillingAddressTwo || '',
    BillingCity: d.BillingCity || '', BillingStateID: d.BillingStateInfo?.Value || EMPTY_GUID,
    BillingPostalCode: d.BillingPostalCode || '',
    MasterPropertyClientID: d.MasterPropertyClientInfo?.Value || EMPTY_GUID,
    CountryID: d.CountryInfo?.Value || EMPTY_GUID,
    DefaultBillingUnderID: d.BillingUnderInfo?.Value || EMPTY_GUID,
    ClientSinceDate: parseSaDate(d.ClientSinceDate),
    CSRId: d.CSRInfo?.Value || EMPTY_GUID, AccountTypeID: d.AccountTypeInfo?.Value || EMPTY_GUID,
    PriorityID: d.PriorityID || 0, UserName: d.UserName || '', Password: d.Password || '',
    Latitude: d.Latitude || '', Longitude: d.Longitude || '',
    SalesPersonID: d.SalesPersonInfo?.Value || EMPTY_GUID,
    CustomerSourceID: d.CustomerSourceInfo?.Value || EMPTY_GUID,
    ReferredByID: d.ReferredByInfo?.Value || EMPTY_GUID, DoNotMarket: d.DoNotMarket || false,
    BillingEmail: d.BillingEmail || '', FlagForReview: d.FlagForReview || false,
    AccountNumber: d.AccountNumber || '', SubscriptionType: d.SubscriptionType || 0,
    BillingDate: parseSaDate(d.BillingDate), AutoCharge: d.AutoCharge || false,
    BillingNotes: d.BillingNotes || '', PaymentMethodID: d.PaymentMethodInfo?.Value || EMPTY_GUID,
    // SA rejects ANY SaveClient call with empty tax fields ("Please select a
    // sales tax reference"/"Please select a tax code") -- confirmed live
    // 2026-08-29 calling this on a client created moments earlier, whose own
    // GetClientInfo still read back the LITERAL EMPTY_GUID STRING for both
    // (SA hadn't applied its own account-level tax defaults to the record
    // yet). Note this is a real, non-empty string ("000...0000"), not
    // undefined/null/'' -- a plain `|| fallback` does NOT catch it (confirmed
    // live: an earlier version of this fix used exactly that and still 400'd
    // with the same two errors, because `'00000000-...' || x` short-circuits
    // to the left side). Must explicitly compare against EMPTY_GUID. Falls
    // back to the same JRB defaults setClientBillingDefaults uses; never
    // overrides a real existing value, only fills the gap when SA's own
    // read-back is the empty-GUID placeholder.
    SalesTaxRefID: (d.SalesTaxInfo?.Value && d.SalesTaxInfo.Value !== EMPTY_GUID)
      ? d.SalesTaxInfo.Value
      : (JRB_TAX_REF_BY_CITY[(d.City || '').toLowerCase().trim()] || JRB_TAX_REF_DEFAULT),
    SalesTaxCodeID: (d.SalesTaxCodeInfo?.Value && d.SalesTaxCodeInfo.Value !== EMPTY_GUID)
      ? d.SalesTaxCodeInfo.Value
      : JRB_TAX_CODE_ID,
    InvoiceFrequencyID: d.InvoiceFrequencyInfo?.Value || EMPTY_GUID,
    StandardTermID: d.StandardTermInfo?.Value || EMPTY_GUID,
    SendInvoiceBy: d.SendInvoiceBy || 'Email',
    DefaultInvoiceFormatID: d.DefaultInvoiceInfo?.Value || EMPTY_GUID,
    OfficeNotes: d.OfficeNotes || '',
    CCFirstName: d.CCFirstName || '', CCLastName: d.CCLastName || '',
    CCBillingAddress: d.CCBillingAddress || '', CCBillingZip: d.CCBillingZip || '',
    CCNumber: d.CCNumber || '', CCExpiration: d.CCExpiration || '', CCToken: d.CCToken || '',
    CCCustomerToken: d.CCCustomerToken || '', CCBrand: d.CCBrand || '',
    Geocode: false, ManualGeocode: false, UpdateManualGeocodeFlag: false,
    ...overrides,
  };

  const saveRes = await post('/webservices/ClientEditOverlayWs.asmx/SaveClient', { info }, 'ClientView.aspx');
  const result = saveRes.data?.d;
  if (result?.response?.Errors?.length > 0) {
    throw new Error(`SA saveClientFields SaveClient errors: ${JSON.stringify(result.response.Errors)}`);
  }

  const verifyRes = await post('/webservices/ClientEditOverlayWs.asmx/GetClientInfo',
    { ClientID: clientId }, 'Clients.aspx');
  const verify = verifyRes.data?.d || {};
  const savedViaApi = saveRes.status !== 500;
  if (!savedViaApi) {
    logger.warn('SA: SaveClient returned 500 (known SA QBO-sync bug) — verified via GetClientInfo instead', { clientId });
  }
  for (const [field, expected] of Object.entries(expect)) {
    if (verify[field] !== expected) {
      throw new Error(`SA saveClientFields: verification failed — expected ${field}="${expected}", GetClientInfo shows "${verify[field]}"`);
    }
  }
  return verify;
}

/** Thin wrapper over saveClientFields for the single QboID field. */
export async function setClientQboId({ clientId, qboId }) {
  const before = await post('/webservices/ClientEditOverlayWs.asmx/GetClientInfo', { ClientID: clientId }, 'Clients.aspx');
  const previousQboId = before.data?.d?.QboID || '';
  await saveClientFields({ clientId, overrides: { QboID: qboId }, expect: { QboID: qboId } });
  logger.info('SA: QboID set and verified', { clientId, previousQboId, newQboId: qboId });
  return { clientId, previousQboId, newQboId: qboId };
}

/**
 * SA's own real "QBO Catchup Sync" feature, reverse-engineered from
 * QboCompanyOverlay.js (the client page's "Link to QuickBooks" panel,
 * opened via ClientView's ShowQboCompany()). `doInitialSync: true` is what
 * the UI sends when no catch-up date is chosen — the option meant for a
 * client that's never synced before. This is a first-class, documented SA
 * UI action, not a workaround.
 */
export async function triggerQboInitialSync({ clientId }) {
  const res = await post('/v3/WebServices/Shared/UtilitiesWs.asmx/TriggerQBOInitialSync', {
    SAPCustomerID: clientId,
    browserDate: { Month: 1, Day: 1, Year: 2014 },
    doInitialSync: true,
  }, 'ClientView.aspx');
  const d = res.data?.d;
  if (!d) {
    throw new Error(`SA triggerQboInitialSync: no response (status=${res.status}). Raw: ${res.text?.slice(0, 300)}`);
  }
  const errors = d.Errors || [];
  if (errors.length > 0) {
    throw new Error(`SA triggerQboInitialSync failed: ${JSON.stringify(errors)}`);
  }
  logger.info('SA: QBO initial sync triggered', { clientId });
  return { clientId, errors };
}

/**
 * Read-only status check for SA's QBO company-sync overlay — last sync
 * time, subscription status, sync step, and error code for a given client.
 */
export async function getQboCompanyData({ clientId }) {
  const res = await post('/WebServices/ClientViewWs.asmx/GetQboCompanyData',
    { customerId: clientId }, 'ClientView.aspx');
  const result = res.data?.d?.Result;
  if (!result) {
    throw new Error(`SA getQboCompanyData: no response (status=${res.status}). Raw: ${res.text?.slice(0, 300)}`);
  }
  return result;
}

/**
 * Read-only check of the SA client's own QboID link (the field that gates
 * whether SA's automatic invoice sync has a QBO customer to push to).
 * Returns the raw field set — SA doesn't reliably use one consistent key
 * name across responses, so callers should check all of them.
 */
export async function getClientQboLink({ clientId }) {
  const res = await post('/webservices/ClientEditOverlayWs.asmx/GetClientInfo',
    { ClientID: clientId }, 'ClientView.aspx');
  const d = res.data?.d;
  if (!d) throw new Error(`SA getClientQboLink: no data returned for clientId ${clientId}`);
  return {
    clientId,
    name: d.PropertyName || `${d.FirstName || ''} ${d.LastName || ''}`.trim(),
    QboID: d.QboID ?? null,
    QboId: d.QboId ?? null,
    HasQBO: d.HasQBO ?? null,
  };
}

/**
 * Read-only fetch of a client's raw Email field (as stored — may be malformed, e.g.
 * multiple addresses joined by ";"). Needed to inspect the current value before
 * deciding how to clean it up via saveClientFields, without the extra unnecessary
 * write a saveClientFields({overrides:{}}) round-trip would otherwise cause.
 */
export async function getClientEmail({ clientId }) {
  const res = await post('/webservices/ClientEditOverlayWs.asmx/GetClientInfo',
    { ClientID: clientId }, 'ClientView.aspx');
  const d = res.data?.d;
  if (!d) throw new Error(`SA getClientEmail: no data returned for clientId ${clientId}`);
  return { clientId, email: d.Email || '' };
}

/**
 * SA's own "QuickBooks Online Sync Errors" report (Settings gear -> Accounting ->
 * Integrations -> QuickBooks, or directly at /QBOSyncErrors.aspx — not linked from the
 * Accounting or Reports top-nav menus, which is why it took live network capture of
 * QBOSyncErrors.aspx + its page script (scripts/QBoSyncErrors.js) to find). Reverse-
 * engineered 2026-08-08. Real endpoint, confirmed via live capture — not a guess.
 *
 * `Import` on each raw row indicates direction from SA's point of view: `false` means
 * SA pushed the record out ("Sent to QuickBooks Online"); `true` means QBO pushed data
 * back into SA ("Sent to Service Autopilot"). SA's own UI (QBoSyncErrors.js) computes
 * the human-readable direction string exactly this way — mirrored here.
 *
 * `max` follows the UI's own off-by-one convention (it sends `MaxRows: PageSize - 1`).
 * Returns rows newest-ish first (SA's own default sort), each with a stable `id`
 * (QBOSyncErrorID guid) plus the fields needed to classify and act on it.
 */
export async function getQboSyncErrors({ max = 500 } = {}) {
  const res = await post('/webservices/QBOSyncErrorsWs.asmx/GetQBOSyncErrors',
    { Input: { StartRow: 1, MaxRows: Math.max(0, max - 1) } }, 'QBOSyncErrors.aspx');
  const d = res.data?.d;
  if (!d) {
    throw new Error(`SA getQboSyncErrors: no response (status=${res.status}). Raw: ${res.text?.slice(0, 300)}`);
  }
  if (d.Errors?.length > 0) {
    throw new Error(`SA getQboSyncErrors errors: ${JSON.stringify(d.Errors)}`);
  }
  const rows = (d.QBOSyncErrorList || []).map(e => ({
    id:            e.QBOSyncErrorID,
    name:          e.EntityName || '',
    type:          e.EntityTypeName || String(e.EntityType ?? ''),
    entityType:    e.EntityType,
    entityId:      e.EntityID,
    message:       e.ErrorMessage || '',
    // Mirrors QBOSyncErrors.js's SyncErrorModel.Direction exactly (Import === false => SA -> QBO).
    direction:     e.Import === false ? 'Sent to QuickBooks Online' : 'Sent to Service Autopilot',
    errorDateTime: e.DateCreated ?? null,
    qboErrorCode:  e.QBOErrorCode ?? null,
  }));
  return {
    rows,
    total: d.QBOSyncErrorsTotal ?? rows.length,
    lastSyncDate: d.LastSyncDate ?? null,
  };
}

/**
 * SA's real "Actions -> Re-Send" action on the QuickBooks Online Sync Errors report
 * (`self.ReSendSyncEntity` / `ReSendSyncEntityConfirmed` in QBoSyncErrors.js — this IS
 * the button Michael saw in the screenshot, not an approximation). Accepts one or more
 * `QBOSyncErrorID`s (the `id` field from getQboSyncErrors rows).
 *
 * IMPORTANT: a clean response here only means SA *accepted the resend request* — it
 * does NOT mean the underlying sync succeeded. SA's own UI just reloads the error list
 * (self.ReQuery) on success; it never asserts the error actually cleared. Callers must
 * re-check via getQboSyncErrors after SA's own ~30 min batch cycle to see whether the
 * same signature is still present.
 */
export async function resendQboSyncErrors({ ids }) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('SA resendQboSyncErrors: ids must be a non-empty array of QBOSyncErrorID values');
  }
  const res = await post('/webservices/QBOSyncErrorsWs.asmx/ReSendSyncEntity',
    { QBOSyncErrorIDs: ids }, 'QBOSyncErrors.aspx');
  const d = res.data?.d;
  if (!d) {
    throw new Error(`SA resendQboSyncErrors: no response (status=${res.status}). Raw: ${res.text?.slice(0, 300)}`);
  }
  if (d.Errors?.length > 0) {
    throw new Error(`SA resendQboSyncErrors errors: ${JSON.stringify(d.Errors)}`);
  }
  logger.info('SA: resendQboSyncErrors accepted', { count: ids.length });
  return { requested: ids.length, accepted: true };
}

/**
 * Fetch the full editable record for an SA invoice, via the InvoiceOverlay.asmx
 * service (distinct from ClientViewWs.asmx / ClientEditOverlayWs.asmx — invoices
 * have their own overlay service). Endpoint/payload shape confirmed 2026-07-31
 * from a live browser network capture, not guessed.
 * Returns the raw `d` object (InvoiceID, CustomerData, InvoiceNumber, LineItems
 * with full rate/quantity/tax detail, etc.) exactly as SA returns it.
 */
export async function getInvoice({ invoiceId }) {
  const res = await post('/WebServices/InvoiceOverlay.asmx/GetInvoice',
    { InvoiceID: invoiceId }, 'ClientView.aspx');
  const d = res.data?.d;
  if (!d) throw new Error(`SA getInvoice: no data returned for invoiceId ${invoiceId}: ${res.text?.slice(0, 200)}`);
  return d;
}

/**
 * Batch-fetch the `Status`/`Action` fields for a known set of SA invoice IDs, via
 * InvoiceList.asmx/QueryModified — the exact endpoint InvoiceList.aspx itself calls
 * to refresh a row's delivery state after Send/Print. Confirmed 2026-08-19 from a
 * live browser network capture (not guessed).
 *
 * This is a batch-by-ID lookup, NOT a date-range list — `{ IDs: [] }` requires a
 * known set of invoice IDs (e.g. pulled from the `sa_invoices` Supabase table).
 * `Action` ("Sent" | "Email" | "Print" | "Print & Email") tracks delivery/queue
 * state and is distinct from `Status` (payment state: Open/Paid/Past Due) — the
 * bulk date-range endpoint (`V2InvoiceList_Query`, see getEstimateList-style
 * callers) does not expose `Action` at all; this is the only known place it lives.
 *
 * "Sent" means the invoice has been emailed and delivered (confirm exact timestamp/
 * delivery/open receipts via getAuditTrail). "Email"/"Print"/"Print & Email" mean
 * still queued/pending — not yet actually sent by SA's send batch job.
 */
export async function getInvoiceStatuses({ invoiceIds }) {
  const res = await post('/WebServices/InvoiceList.asmx/QueryModified',
    { IDs: invoiceIds }, 'InvoiceList.aspx');
  const d = res.data?.d;
  if (!d) throw new Error(`SA getInvoiceStatuses: no data returned: ${res.text?.slice(0, 200)}`);
  return (d.Invoices || []).map(inv => ({
    invoiceId:      inv.ID,
    invoiceNumber:  inv.InvoiceNumber,
    status:         inv.Status,
    action:         inv.Action,
    client:         inv.Client,
    date:           inv.Date,
    invoiceTotal:   inv.InvoiceTotal,
    invoiceBalance: inv.InvoiceBalance,
  }));
}

/**
 * Bulk date-range invoice list — the real fix for V2InvoiceList_Query, which
 * previously silently ignored a naive {startDate,endDate} body (returned
 * count:0, no error). Confirmed 2026-08-19 from a live browser capture of the
 * v3/accounting/invoices page changing its date filter: the working shape is
 * a QueryInput wrapper with a ScreenViewFilterType:76 entry (same numeric code
 * getEstimateList() already uses for estimates) — the key gotcha is the *open*
 * end of a date range is `{Month:-1,Day:-1,Year:-1}`, NOT a real date; a naive
 * caller supplying a real end date for "no upper bound" gets nothing back.
 *
 * This is an MVC/BFF action, not a classic .asmx web method — its response has
 * NO `d` wrapper (`res.data` IS `{Invoices:[...]}` directly), unlike most other
 * SA endpoints in this file.
 *
 * Response fields are richer than getInvoiceStatuses()/QueryModified's — this
 * includes `Action`, `NeedToPrint`, `NeedToEmail` per invoice directly, so it
 * can answer "which invoices in this date range are unsent/emailed" in one
 * bulk call without needing IDs already in hand (unlike getInvoiceStatuses,
 * which requires known IDs). `Status` can contain raw HTML for past-due rows
 * (e.g. `<span style="color:red;">Past Due<br />(1 Days)</span>`) — prefer
 * `isPastDue`/`daysPastDue` for clean parsing instead of the `status` string.
 *
 * The `ActiveTab: 'OpenInvoices'` value and the two extra filter types (89, 6)
 * were captured as-is from a real request on that tab and are NOT understood —
 * they're reproduced unchanged rather than guessed at, since removing them
 * hasn't been tested and blind variation risks Incapsula. If a caller ever
 * needs Paid/all invoices (not just Open), this function will need revisiting
 * with a fresh capture from that other tab.
 */
export async function getInvoiceList({ dateFrom, dateTo, max = 500 } = {}) {
  const toBrowserDate = (d) => d
    ? { Month: d.getMonth() + 1, Day: d.getDate(), Year: d.getFullYear() }
    : { Month: -1, Day: -1, Year: -1 };

  const filterTypes = [
    { ScreenViewFilterType: 89, ScreenViewFilterObjects: [], ScreenViewFilterTypeItems: [{ Value: '2' }, { Value: '0' }] },
    { ScreenViewFilterType: 6,  ScreenViewFilterObjects: [], ScreenViewFilterTypeItems: [{ Value: '4' }] },
  ];
  if (dateFrom || dateTo) {
    filterTypes.push({
      ScreenViewFilterType: 76,
      ScreenViewFilterObjects: [],
      ScreenViewFilterTypeItems: [
        { Value: '6' },
        { Value: JSON.stringify(toBrowserDate(dateFrom)) },
        { Value: JSON.stringify(toBrowserDate(dateTo)) },
      ],
    });
  }

  const body = {
    QueryInput: {
      StartRow: 1,
      Max: max,
      ActiveTab: 'OpenInvoices',
      ScreenViewFilterTypes: filterTypes,
      SortedColumns: [{ FieldName: 'Date', Direction: 1, ColumnEnum: 3 }],
    },
  };

  const res = await post('/AccountingBFF/InvoiceList/V2InvoiceList_Query', body, 'v3/accounting/invoices');
  const invoices = res.data?.Invoices;
  if (!invoices) throw new Error(`SA getInvoiceList: no data returned: ${res.text?.slice(0, 200)}`);

  return invoices.map(inv => ({
    invoiceId:      inv.ID,
    invoiceNumber:  inv.InvoiceNumber,
    status:         inv.Status,
    action:         inv.Action,
    client:         inv.Client,
    date:           inv.Date,
    invoiceDueDate: inv.InvoiceDueDate,
    invoiceTotal:   inv.InvoiceTotal,
    invoiceBalance: inv.InvoiceBalance,
    accountBalance: inv.AccountBalance,
    isPastDue:      inv.IsPastDue,
    daysPastDue:    inv.DaysPastDue,
    needToPrint:    inv.NeedToPrint,
    needToEmail:    inv.NeedToEmail,
    qboId:          inv.QboID,
    qbStatus:       inv.QBStatus,
  }));
}

// ── Audit trail — AuditTrailsWs.asmx ─────────────────────────────────────────

// SA's per-record "view history" dialog (ShowAuditTrailDialog) always passes one
// of these literal Type strings as EntityID's Type. Confirmed by reading SA's own
// minified frontend JS call sites:
//   - "Quote"            → sa-js-cache/service-autopilot.md doc (estimates)
//   - "Invoice"           → sa-js-cache-InvoiceOverlay.js:1213
//   - "ScheduledService"  → sa-js-cache-ClientView-minified.js (job.ID / ServiceItem.ID)
//   - "Customer"          → sa-js-cache-ClientView-minified.js (_clientView.customerID)
//   - "Ticket"            → sa-js-cache-ClientView-minified.js / sa-minified.js
//   - "Payment"           → sa-js-cache-sa-minified.js
// "job"/"payment"/"client" below are our own friendly aliases — pass either the
// alias or the raw SA Type string directly.
const AUDIT_TRAIL_TYPES = {
  estimate: 'Quote',
  quote:    'Quote',
  invoice:  'Invoice',
  job:      'ScheduledService',
  payment:  'Payment',
  client:   'Customer',
  ticket:   'Ticket',
};

// SA .NET date format: "/Date(1776780203813)/"
function parseNetDate(val) {
  if (!val) return null;
  const match = String(val).match(/\/Date\((\d+)\)\//);
  if (match) return new Date(parseInt(match[1], 10));
  const d = new Date(val);
  return isNaN(d) ? null : d;
}

/**
 * Pull the audit trail (who/what/when history log) for a single SA record —
 * invoice, estimate, job, payment, client, or ticket. `type` accepts either a
 * friendly alias (estimate/invoice/job/payment/client/ticket) or a raw SA Type
 * string (e.g. "ScheduledService"). Only "Quote" and "Invoice" have been
 * confirmed against real records; the other type strings are taken directly
 * from SA's own frontend JS but haven't been exercised live yet — verify the
 * response shape the first time you use a new type.
 *
 * Returns the raw OutputRecords[] plus a `Note`/`DateCreated` parsed to a JS
 * Date for convenience (`when`).
 */
export async function getAuditTrail({ entityId, type }) {
  const saType = AUDIT_TRAIL_TYPES[type?.toLowerCase?.()] || type;
  if (!saType) {
    throw new Error(`SA getAuditTrail: type is required (one of ${Object.keys(AUDIT_TRAIL_TYPES).join(', ')}, or a raw SA Type string)`);
  }
  const res = await post('/WebServices/AuditTrailsWs.asmx/GetAuditTrailData',
    { InputData: { EntityID: entityId, Type: saType } }, 'ClientView.aspx');
  const d = res.data?.d;
  if (!d) {
    throw new Error(`SA getAuditTrail: no response (status=${res.status}). Raw: ${res.text?.slice(0, 300)}`);
  }
  const records = (d.OutputRecords || []).map(r => ({
    ...r,
    when: parseNetDate(r.DateCreated),
  }));
  return records;
}

/** Converts GetInvoice's 0-indexed Month to the 1-indexed shape SaveInvoice expects. */
function toSaveInvoiceDate(dateObj) {
  if (!dateObj || typeof dateObj !== 'object') return dateObj;
  return { Month: dateObj.Month + 1, Day: dateObj.Day, Year: dateObj.Year };
}

/**
 * Read-modify-write an SA invoice via InvoiceOverlay.asmx, round-tripping the
 * full record from GetInvoice unchanged except for whatever's in `overrides`.
 * Converts InvoiceDate/InvoiceDueDate/LineItems[].Date to SaveInvoice's
 * 1-indexed-month shape automatically (see toSaveInvoiceDate) — GetInvoice
 * returns Month 0-indexed but SaveInvoice expects it 1-indexed; skipping this
 * conversion corrupts the invoice's dates on every save (confirmed incident,
 * Kettle Moraine invoice #33351, 2026-07-31 — fully reverted same day).
 * `overrides` are applied last and are NOT auto-converted — pass already-
 * 1-indexed months there. `expect` is an optional {field: expectedValue} map
 * checked against a fresh GetInvoice read after saving; throws if mismatched.
 */
export async function saveInvoiceFields({ invoiceId, overrides = {}, expect = {} }) {
  const d = await getInvoice({ invoiceId });
  const invoiceData = {
    ...d,
    TxnID: d.TxnID ?? '',
    DeletedLineItems: d.DeletedLineItems ?? [],
    InvoiceDate: toSaveInvoiceDate(d.InvoiceDate),
    InvoiceDueDate: toSaveInvoiceDate(d.InvoiceDueDate),
    LineItems: (d.LineItems || []).map(li => ({ ...li, Date: toSaveInvoiceDate(li.Date) })),
    ...overrides,
  };

  const saveRes = await post('/WebServices/InvoiceOverlay.asmx/SaveInvoice',
    { InvoiceData: invoiceData }, 'ClientView.aspx');
  const result = saveRes.data?.d;
  if (result?.Errors?.length > 0) {
    throw new Error(`SA saveInvoiceFields errors: ${JSON.stringify(result.Errors)}`);
  }

  const verify = await getInvoice({ invoiceId });
  for (const [field, expected] of Object.entries(expect)) {
    if (verify[field] !== expected) {
      throw new Error(`SA saveInvoiceFields: verification failed — expected ${field}="${expected}", GetInvoice shows "${verify[field]}"`);
    }
  }
  return verify;
}

/**
 * Toggle an invoice's number — the established manual technique for forcing
 * SA to re-attempt its one-way sync to QBO. Round-trips the invoice unchanged
 * except InvoiceNumber. Uses saveInvoiceFields (date-safe) rather than a bare
 * spread-and-save, unlike the previous implementation of this function.
 */
export async function setInvoiceNumber({ invoiceId, newNumber }) {
  return saveInvoiceFields({
    invoiceId,
    overrides: { InvoiceNumber: newNumber },
    expect: { InvoiceNumber: newNumber },
  });
}

/**
 * Toggles an invoice's number to force SA's backend to re-attempt its QBO
 * sync, polls for a resulting QboID, then reverts the number/lock state
 * regardless of outcome. Safe and non-destructive — never touches rate,
 * quantity, line items, or totals. Confirmed via live testing (2026-08-03)
 * that a valid client-level QBO link is necessary for this to work; on an
 * unlinked/stale-linked client it will safely no-op (revert with synced:false).
 */
export async function resyncInvoiceToQbo({ invoiceId, pollIntervalMs = 15_000, maxPolls = 8 }) {
  const before = await getInvoice({ invoiceId });
  const originalNumber = before.InvoiceNumber;
  const originalLocked = !!before.IsLocked;
  const alreadyQboId = before.QboID || null;

  logger.info('SA: resyncInvoiceToQbo starting', { invoiceId, originalNumber, originalLocked, alreadyQboId });

  await saveInvoiceFields({
    invoiceId,
    overrides: { InvoiceNumber: `${originalNumber}z`, IsLocked: false },
    expect: { InvoiceNumber: `${originalNumber}z` },
  });

  let qboId = null;
  let attempts = 0;
  for (let i = 0; i < maxPolls; i++) {
    attempts++;
    await new Promise(r => setTimeout(r, pollIntervalMs));
    const check = await getInvoice({ invoiceId });
    if (check.QboID) {
      qboId = check.QboID;
      break;
    }
  }

  await saveInvoiceFields({
    invoiceId,
    overrides: { InvoiceNumber: originalNumber, IsLocked: originalLocked },
    expect: { InvoiceNumber: originalNumber },
  });
  attempts++;

  const synced = !!qboId;
  if (!synced) {
    logger.warn('SA: resyncInvoiceToQbo did not observe a QboID within poll budget — reverted, not retrying further', { invoiceId, maxPolls });
  } else {
    logger.info('SA: resyncInvoiceToQbo synced successfully', { invoiceId, qboId });
  }

  return { invoiceId, synced, qboId, originalNumber, originalLocked, attempts };
}

/**
 * Permanently delete SA client records via the bulk-delete action from the
 * Clients list view. Endpoint/payload confirmed from SA's own ClientList.js
 * 2026-07-31 (not guessed) — this is the real "select clients, click Delete"
 * feature, not a workaround. DESTRUCTIVE AND IRREVERSIBLE — callers must
 * verify each clientId has no attached jobs/invoices/estimates/history before
 * calling this. SA itself may also refuse (returned per-id in `errors`) if a
 * client has attached records it won't let go.
 * Returns { requested, removedIds, errors }
 */
export async function deleteClients({ clientIds }) {
  const res = await post('/webservices/ClientList.asmx/DeleteClients',
    { DeleteItems: clientIds }, 'ClientList.aspx');
  const d = res.data?.d;
  if (!d) {
    throw new Error(`SA deleteClients: no response (status=${res.status}). Raw: ${res.text?.slice(0, 300)}`);
  }
  const errors = d.Errors || [];
  if (errors.length > 0) {
    throw new Error(`SA deleteClients failed: ${JSON.stringify(errors)}`);
  }
  logger.info('SA: clients deleted', { requested: clientIds.length, removed: (d.RemovedIndexes || []).length });
  return { requested: clientIds.length, removedIds: clientIds, errors };
}

/**
 * Fetch SA client details needed to post tickets.
 * Returns { clientId, customerJobId, currentUserId, currentUserType, name, address, phone }
 *
 * `phone` confirmed live 2026-08-20 against the APIProbe test account: the
 * GetCustomerDataAsync Client object DOES carry phone fields directly
 * (ContactPhone/ContactCellPhone/ContactHomePhone/ContactOtherPhone) — all
 * empty on that particular test account, but the fields themselves are real,
 * so this doesn't need the separate GetClientInfo round-trip that
 * getSAClientPhone/getSAClientDetails use for the *bulk* account list (which
 * genuinely has no phone columns at all). Priority: ContactPhone (SA's own
 * computed "preferred" phone) first, then Cell (most reachable ahead of a
 * site visit), then Home, then Other. Empty string, never fabricated, when
 * none are set.
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
    address: [client.Address1, client.CityStateZip].filter(Boolean).join(', '),
    phone:   client.ContactPhone || client.ContactCellPhone || client.ContactHomePhone || client.ContactOtherPhone || '',
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
  const savedItems = queryRes.data?.d?.ServiceLineItems || [];

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
 * Fetch the service line items for an existing estimate.
 * Returns [{ serviceId, name, amount, note }]
 */
export async function getEstimateLineItems(quoteId) {
  const res = await post('/WebServices/QuoteWs.asmx/QueryLineItems', {
    InputData: { ID: quoteId },
  }, 'V3Estimate.aspx');
  const items = res.data?.d?.ServiceLineItems || [];
  return items.map(item => {
    const svc = item.Service || item;
    const rate = parseFloat(svc.Rate || 0);
    const qty  = parseFloat(svc.Qty  || svc.Quantity || 1);
    const amount = parseFloat(svc.TotalCost ?? svc.TotalAmount ?? svc.Amount ?? (rate * qty) ?? 0);
    return {
      serviceId: svc.ID || '',
      name:      svc.Name || svc.ServiceName || svc.Description || '—',
      amount,
      note:      svc.EstimateNote || '',
    };
  });
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
    const items = liRes.data?.d?.ServiceLineItems || [];
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
      CategoryID:   TICKET_CATEGORIES.OTHER,
      TicketStatus: TICKET_STATUS_OPEN,
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
export async function addTicket({ clientId, subject, body = '', ticketType = 'Task', dueDate, category = 'Estimate' }) {
  const details = await getClientDetails({ clientId });

  const typeMap = { Task: 2, Call: 3, Email: 4, Note: 1 };
  const ticketEventType = typeMap[ticketType] ?? 2;

  // category maps to SA's TICKET_CATEGORIES; default Estimate so CRM leads appear in the Estimate TicketList view
  const categoryId = TICKET_CATEGORIES[category.toUpperCase().replace(/ /g, '_')] ?? TICKET_CATEGORIES.ESTIMATE;

  // SA's MyDay view only shows tickets DueDate = today. Default to today so
  // new tickets are immediately visible in the SA ticket queue.
  const effectiveDueDate = dueDate ? new Date(dueDate) : new Date();
  effectiveDueDate.setHours(23, 59, 0, 0);

  // GetByCompany always returns {List:[], Total:N} — the List field is consistently empty (SA bug).
  // currentUserId from getClientDetails = CurrentUserID = Michael's resource ID (confirmed via
  // MainSite_ResourcePermissions_GetAsync probe); currentUserType = CurrentUserResourceType = 2.
  const assignedResourceId   = details.currentUserId;
  const assignedResourceType = details.currentUserType;
  logger.info('SA: addTicket resource', { assignedResourceId, assignedResourceType });

  const res = await post('/CRMBFF/TicketEdit/TicketEdit_Ticket_PostAsync', {
    Ticket: {
      CategoryID:        categoryId,
      TicketStatus:      TICKET_STATUS_OPEN,
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
 * List SA's tag categories (e.g. "Client Type", "General", "GC Information").
 * Source: webservices/TagsWs.asmx/GetAllTagCategories (confirmed via live
 * capture 2026-08-19 — DevTools network log while adding a tag in the SA UI).
 * Returns [{ categoryId, name }].
 */
export async function getTagCategories() {
  const res = await post('/webservices/TagsWs.asmx/GetAllTagCategories', {}, 'Clients.aspx');
  const items = res.data?.d || [];
  return items.map(c => ({ categoryId: c.Value, name: c.Text }));
}

/**
 * List all defined client tags (the master tag list, not what's applied to
 * any one client). Source: CRMBFF/TagsAppliedManager/GetTagsByType, body
 * {TagTypes: [n], AddAutomationTags: bool} — param names confirmed live
 * 2026-08-19 by reading the MVC binder's own "null entry for parameter"
 * error message off a deliberately-wrong probe call. tagType 1 = client tags
 * (the only type confirmed so far).
 * Returns [{ tagId, name, categoryId }].
 */
export async function listTags({ tagType = CLIENT_TAG_TYPE } = {}) {
  const res = await post('/CRMBFF/TagsAppliedManager/GetTagsByType', { TagTypes: [tagType], AddAutomationTags: false }, 'ClientView.aspx');
  const items = res.data?.Items || [];
  return items.map(t => ({ tagId: t.ID, name: t.Name, categoryId: t.CategoryID }));
}

/**
 * Find an existing tag by exact name (case-insensitive), or create it if it
 * doesn't exist yet. AddTag's response never echoes the new tag's ID (only
 * {Errors:[]}), so after creating we re-list tags and look the new one up by
 * name — same read-after-write pattern as getTicket/saveClientFields.
 * Returns { tagId, name, categoryId, created }.
 */
function findTagByName(tags, name) {
  return tags.find(t => t.name.toLowerCase() === name.toLowerCase());
}

/**
 * Find an existing tag category by exact name (case-insensitive), or create
 * it. Source: webservices/TagsWs.asmx/AddCategory, body {CategoryName},
 * response {CategoryID, Errors} — found in AddTagOverlay.js's self.AddCategory
 * (the "+ New Category" path in SA's own "Add Tag" dialog). Unlike AddTag,
 * this one DOES echo back the new ID directly, so no re-list-and-match-by-
 * name step is needed.
 * Returns { categoryId, name, created }.
 */
export async function findOrCreateTagCategory({ name }) {
  const existing = (await getTagCategories()).find(c => c.name.toLowerCase() === name.toLowerCase());
  if (existing) return { ...existing, created: false };

  const res = await post('/webservices/TagsWs.asmx/AddCategory', { CategoryName: name }, 'ClientView.aspx');
  const categoryId = res.data?.d?.CategoryID;
  if (!categoryId || categoryId === EMPTY_GUID) {
    throw new Error(`SA findOrCreateTagCategory: AddCategory failed for "${name}" — you do not have permission, or: ${res.text?.slice(0, 300)}`);
  }
  logger.info('SA: tag category created', { categoryId, name });
  return { categoryId, name, created: true };
}

export async function findOrCreateTag({ name, categoryId, tagType = CLIENT_TAG_TYPE }) {
  const existing = findTagByName(await listTags({ tagType }), name);
  if (existing) return { ...existing, created: false };

  if (!categoryId) throw new Error(`SA findOrCreateTag: tag "${name}" doesn't exist yet — categoryId is required to create it`);

  const res = await post('/webservices/TagsWs.asmx/AddTag', {
    Tag: { ID: EMPTY_GUID, CategoryID: categoryId, Name: name, TagType: tagType },
  }, 'ClientView.aspx');
  const errors = res.data?.d?.Errors;
  if (errors?.length > 0) {
    throw new Error(`SA findOrCreateTag AddTag errors: ${JSON.stringify(errors)}`);
  }

  const created = findTagByName(await listTags({ tagType }), name);
  if (!created) throw new Error(`SA findOrCreateTag: AddTag reported success but "${name}" isn't in GetTagsByType afterward`);
  logger.info('SA: tag created', { tagId: created.tagId, name, categoryId });
  return { ...created, created: true };
}

/**
 * Read the tags currently applied to a client. Source:
 * CRMBFF/TagsAppliedManager/GetSavedTags(Guid parentID, Boolean viewAutomationTag)
 * — this is an MVC action, not a TagsWs.asmx web method (its JSON response has
 * no "d" wrapper), confirmed live 2026-08-19 the same way as listTags: the
 * exact param name ("parentID", then "viewAutomationTag") came from the MVC
 * binder's own null-parameter error message on a deliberately-wrong probe call.
 * Returns [{ tagId, name }].
 */
export async function getClientTags({ clientId }) {
  const res = await post('/CRMBFF/TagsAppliedManager/GetSavedTags', { parentID: clientId, viewAutomationTag: false }, 'ClientView.aspx');
  const items = res.data?.Items || [];
  return items.map(t => ({ tagId: t.Value, name: t.Text }));
}

/**
 * Attach an existing tag to a client account. clientId is the SA client GUID
 * (same value as the `rk` param on ClientView.aspx and as CustomerID here —
 * confirmed by matching both against a live capture 2026-08-19). Pass an
 * existing tagId (from listTags/findOrCreateTag) — this call does not create
 * tag definitions, only applies one.
 *
 * Source endpoint: webservices/TagsWs.asmx/AddTagToClient, body
 * {CustomerTag: {TagID, CustomerID}}. Response is just {Errors:[]} with no
 * confirmation of what changed, so this always verifies via getClientTags
 * afterward — same "never trust the write response alone" rule as
 * saveClientFields. Validates clientId exists first (same convention as
 * addNote/addTicket/saveClientFields) — AddTagToClient doesn't reject a
 * bad CustomerID on its own, so without this check a wrong clientId would
 * otherwise only surface as an unhelpful "verification failed" error below.
 */
export async function addTagToClient({ clientId, tagId }) {
  await getClientDetails({ clientId });

  const res = await post('/webservices/TagsWs.asmx/AddTagToClient', {
    CustomerTag: { TagID: tagId, CustomerID: clientId },
  }, 'ClientView.aspx');
  const errors = res.data?.d?.Errors;
  if (errors?.length > 0) {
    throw new Error(`SA addTagToClient failed: ${JSON.stringify(errors)}`);
  }

  const applied = await getClientTags({ clientId });
  if (!applied.some(t => t.tagId === tagId)) {
    throw new Error(`SA addTagToClient: verification failed — tag ${tagId} not present in GetSavedTags after saving`);
  }
  logger.info('SA: tag applied to client', { clientId, tagId });
  return { clientId, tagId, tags: applied };
}

/**
 * Bulk-find every client/lead carrying a given tag, via V2AccountList_Query's
 * FieldColumn:31 (Tags) filter — confirmed live 2026-08-19 by filtering on
 * the "Commercial - HOA" tag's ID and getting back exactly the one real
 * client known to carry it. ContainOperator:'7' is the one that actually
 * filters (matches the "enable all statuses" flag elsewhere in this file,
 * which also uses op 7) — '1' and '8' silently no-op and return the
 * unfiltered default list instead, so don't change this without re-testing.
 * This lets classification work (e.g. "who already has a GC: <company>
 * tag") run as one cheap query per tag instead of one GetSavedTags call per
 * client — critical at the ~9,900-account scale, where per-client calls
 * would be too slow and risk another Incapsula lockout.
 * Returns [{ clientId, name }].
 */
export async function getClientsByTag({ tagId, max = 5000 }) {
  const filterData = JSON.stringify({
    FilterData: [
      { FieldColumn: '31', ContainOperator: '7', FieldItems: [tagId], Order: 0, SCFilterID: EMPTY_GUID },
      { FieldColumn: '28', ContainOperator: '7', FieldItems: [], Order: 0, SCFilterID: EMPTY_GUID },
    ],
    CustomFields: [],
    QuerySelection: 3,
  });

  const results = [];
  let startRow = 1;
  const pageSize = 500;
  while (results.length < max) {
    const res = await post('/CRMBFF/AccountList/V2AccountList_Query', {
      QueryInput: {
        Settings: { FilterData: filterData },
        StartRow: startRow,
        Max: pageSize,
        SortedColumns: [{ FieldName: '', Direction: 2, ColumnEnum: 0 }],
      },
    }, 'Clients.aspx');
    const accounts = (res.data?.d || res.data)?.Accounts || [];
    if (accounts.length === 0) break;
    // Trim the final page so a caller's `max` is a real ceiling, not just a
    // loop-continuation check — without this, results could overshoot max by
    // up to pageSize-1 whenever the last page pushed it past the limit.
    results.push(...accounts.slice(0, max - results.length).map(a => ({ clientId: a.ClientID, name: a.ClientName })));
    if (accounts.length < pageSize) break;
    startRow += pageSize;
  }
  return results;
}

/**
 * Remove a tag from a client account (the tag definition itself is untouched —
 * only the client's application of it is removed). clientId is passed twice in
 * the request body under two different names (CustomerID and ParentID) — both
 * confirmed equal to the same client GUID in a live DevTools capture 2026-08-19
 * (Michael manually removing a tag in the SA UI). Mirrors addTagToClient's
 * conventions: never trusts the write response alone, always re-verifies via
 * getClientTags afterward.
 *
 * Source endpoint: webservices/TagsWs.asmx/RemoveTag, body
 * {TagData: {CustomerID, ParentID, TagID}}.
 */
export async function removeTagFromClient({ clientId, tagId }) {
  await getClientDetails({ clientId });

  const res = await post('/webservices/TagsWs.asmx/RemoveTag', {
    TagData: { CustomerID: clientId, ParentID: clientId, TagID: tagId },
  }, 'ClientView.aspx');
  const errors = res.data?.d?.Errors;
  if (errors?.length > 0) {
    throw new Error(`SA removeTagFromClient failed: ${JSON.stringify(errors)}`);
  }

  const remaining = await getClientTags({ clientId });
  if (remaining.some(t => t.tagId === tagId)) {
    throw new Error(`SA removeTagFromClient: verification failed — tag ${tagId} still present in GetSavedTags after removal`);
  }
  logger.info('SA: tag removed from client', { clientId, tagId });
  return { clientId, tagId, tags: remaining };
}

/**
 * Convenience wrapper: find-or-create a tag by name, then apply it to a
 * client in one call. Returns { clientId, tagId, tagName, created, tags }.
 */
export async function addTagToClientByName({ clientId, tagName, categoryId, tagType = CLIENT_TAG_TYPE }) {
  const tag = await findOrCreateTag({ name: tagName, categoryId, tagType });
  const result = await addTagToClient({ clientId, tagId: tag.tagId });
  return { ...result, tagName: tag.name, created: tag.created };
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

function mapSAAccount(a) {
  return {
    clientId: a.ClientID || '',
    name:     a.ClientName || '',
    address:  a.Address1 || '',
    city:     a.City || '',
    state:    a.State || a.StateAbbr || '',
    zip:      a.Zip || a.ZipCode || a.PostalCode || '',
    phone:    a.HomePhone || a.CellPhone || a.WorkPhone || a.OtherPhone || a.Phone1 || a.PhoneNumber || '',
    email:    a.Email || '',
    qboId:    a.QboID || a.QboId || '',
    isLead:   a.Type === 'Lead',
    type:     a.Type || '',
    // ISO "YYYY-MM-DD" (string-sortable) or null. V2AccountList_Query's raw
    // response carries ClientSince/LeadSince even though it carries no phone
    // field at all -- used by findDuplicateClient's phone-only fallback to
    // bound a live per-account phone scan to the most-recently-created
    // accounts instead of the full ~10,300-account population. Confirmed live
    // 2026-08-29: both fields are populated (often identically) on real
    // accounts of either Type.
    createdDate: parseSaMdy(a.ClientSince) || parseSaMdy(a.LeadSince) || null,
  };
}

async function paginateAccountList(referer, max = 10000) {
  const results = [];
  let startRow = 1;
  const pageSize = 500;

  // QuerySelection:3 returns Clients + Leads + Closed Leads (vs 0 = Clients only).
  // FilterData mirrors the exact browser request captured from SA's Leads view —
  // FieldColumn 28/ContainOperator 7 enables all statuses; FieldColumn 1/ContainOperator 8
  // targets the SA-side "All Accounts" saved list GUID.
  const filterData = JSON.stringify({
    FilterData: [
      { FieldColumn: '28', ContainOperator: '7', FieldItems: [], Order: 0, SCFilterID: EMPTY_GUID },
      { FieldColumn: '1', ContainOperator: '8', FieldItems: ['408bb07e-0d58-4a26-8b32-8f4190443a22'], Order: 1, SCFilterID: EMPTY_GUID },
    ],
    CustomFields: [],
    QuerySelection: 3,
  });

  while (results.length < max) {
    const res = await post('/CRMBFF/AccountList/V2AccountList_Query', {
      QueryInput: {
        Settings: { FilterData: filterData },
        StartRow: startRow,
        Max: pageSize,
        SortedColumns: [{ FieldName: '', Direction: 2, ColumnEnum: 0 }],
      },
    }, referer);

    const accounts = (res.data?.d || res.data)?.Accounts || [];
    if (accounts.length === 0) break;
    results.push(...accounts);
    if (accounts.length < pageSize) break;
    startRow += pageSize;
  }

  return results;
}

/**
 * Bulk-fetch all SA accounts (clients + leads) in a single paginated call.
 * Returns [{ clientId, name, address, city, state, zip, phone, qboId, isLead }]
 */
export async function getAllSAAccounts({ max = 10000 } = {}) {
  const accounts = await paginateAccountList('Clients.aspx', max);
  logger.info('SA: bulk account fetch complete', { count: accounts.length });
  return accounts.map(mapSAAccount);
}

// Kept for backward compatibility — returns only non-lead accounts
export async function getAllClients({ max = 10000 } = {}) {
  const all = await getAllSAAccounts({ max });
  return all.filter(a => !a.isLead);
}

/**
 * Fetch the phone number for a single SA account via GetClientInfo.
 * The bulk account list has no phone fields; this per-account call is required.
 * Returns the first non-empty phone found (HomePhone → CellPhone → WorkPhone → OtherPhone).
 */
export async function getSAClientPhone(clientId) {
  const res = await post('/WebServices/ClientEditOverlayWs.asmx/GetClientInfo', { ClientID: clientId }, 'ClientView.aspx');
  const d = res.data?.d;
  if (!d) return '';
  return d.HomePhone || d.CellPhone || d.WorkPhone || d.OtherPhone || '';
}

/**
 * Fetch phone AND address for a single SA account via GetClientInfo in one call.
 * Same endpoint as getSAClientPhone; returns the full contact detail needed for CardDAV vCards.
 * Returns { phone, address, city, state, zip } — empty strings where SA has no data.
 *
 * preferredPhoneId added 2026-08-29 for the SA phone cache backfill
 * (tools/impl/sa-phone-cache.js) — additive only, existing callers (carddav.js)
 * destructure only the fields they need and are unaffected.
 */
export async function getSAClientDetails(clientId) {
  const res = await post('/WebServices/ClientEditOverlayWs.asmx/GetClientInfo', { ClientID: clientId }, 'ClientView.aspx');
  const d = res.data?.d;
  if (!d) return { homePhone: '', cellPhone: '', workPhone: '', otherPhone: '', preferredPhoneId: '', address: '', city: '', state: '', zip: '' };
  return {
    homePhone:  d.HomePhone  || '',
    cellPhone:  d.CellPhone  || '',
    workPhone:  d.WorkPhone  || '',
    otherPhone: d.OtherPhone || '',
    preferredPhoneId: d.PreferredPhoneID || '',
    address:    d.Address    || '',
    city:       d.City       || '',
    state:      d.State || d.StateAbbr || '',
    zip:        d.PostalCode || d.Zip || '',
  };
}

/**
 * Fetch scheduling-relevant client profile: OfficeNotes (gate codes, property access,
 * special instructions), BillingNotes, contact info, and custom fields (CustomField1-6)
 * if configured in SA Admin → Account Settings → Custom Fields.
 */
export async function getClientProfile({ clientId }) {
  const res = await post('/webservices/ClientEditOverlayWs.asmx/GetClientInfo',
    { ClientID: clientId }, 'ClientView.aspx');
  const d = res.data?.d;
  if (!d) throw new Error(`SA getClientProfile: no data returned for clientId ${clientId}`);

  logger.info('SA: getClientProfile complete', { clientId });
  return {
    clientId,
    name:         d.PropertyName || `${d.FirstName || ''} ${d.LastName || ''}`.trim(),
    address:      [d.Address, d.City, d.PostalCode].filter(Boolean).join(', '),
    phone:        d.HomePhone || d.CellPhone || d.WorkPhone || d.OtherPhone || '',
    officeNotes:  d.OfficeNotes  || '',
    billingNotes: d.BillingNotes || '',
  };
}

/**
 * Fetch the Pavement Size custom field value for a single SA client.
 * Uses GetCustomerDataAsync to get the CustomerJobID, then GetCustomFields to read
 * the "Pavement Size" field by Description. Returns sq ft as a number, or null.
 */
export async function fetchClientPavementSf(clientId) {
  const dataRes = await post('/WebServices/ClientViewWs.asmx/GetCustomerDataAsync',
    { customerId: clientId }, 'ClientView.aspx');
  const customerJobId = dataRes.data?.d?.Result?.Client?.CustomerJobID;
  if (!customerJobId) return null;

  const cfRes = await post('/WebServices/ClientViewWs.asmx/GetCustomFields',
    { CustomerJobID: customerJobId }, 'ClientView.aspx');
  const fields = cfRes.data?.d;
  if (!Array.isArray(fields)) return null;

  const field = fields.find(f => f.Description === 'Pavement Size');
  const val = parseFloat(field?.Value);
  return isNaN(val) ? null : val;
}

/**
 * Read, calculate, and write the "Lbs of Crackfill" custom field for an SA client.
 * Lbs of Crackfill = Math.round(Pavement Size × 0.015)
 *
 * Mechanism: GetCustomFieldList returns field GUIDs + current values. SaveClient accepts a
 * CustomFields array of { CustomFieldValue, CustomFieldDate: null, CustomFieldID } objects
 * that overwrites all custom fields atomically. Confirmed via reverse-engineering SA's Knockout
 * overlay save (probe-cf-saveclicked.mjs, 2026-07-21).
 */
export async function setClientCrackfill({ clientId, pavementSf: pavementSfArg }) {
  // 1. Get custom field list (IDs + current values)
  const gcflRes = await post('/webservices/ClientEditOverlayWs.asmx/GetCustomFieldList',
    { ClientID: clientId }, 'Clients.aspx');
  const fields = gcflRes.data?.d;
  if (!Array.isArray(fields)) {
    throw new Error(`SA setClientCrackfill: GetCustomFieldList failed for ${clientId}: ${gcflRes.text?.slice(0, 200)}`);
  }

  const pavementField   = fields.find(f => f.CustomFieldName === 'Pavement Size');
  const crackfillField  = fields.find(f => f.CustomFieldName === 'Lbs of Crackfill');

  if (!pavementField || !crackfillField) {
    const missing = [!pavementField && 'Pavement Size', !crackfillField && 'Lbs of Crackfill'].filter(Boolean);
    throw new Error(`SA setClientCrackfill: custom field(s) not found: ${missing.join(', ')}`);
  }

  // Use caller-supplied value (intake path) or read from SA (reconciliation path)
  const pavementRaw = pavementSfArg != null ? String(pavementSfArg) : (pavementField.CustomFieldValue || '');
  const pavementSf  = parseFloat(pavementRaw);
  if (!pavementRaw || isNaN(pavementSf) || pavementSf <= 0) {
    return { clientId, skipped: true, reason: `Pavement Size "${pavementRaw}" is not a valid positive number` };
  }

  const lbsCrackfill = Math.round(pavementSf * 0.015);
  if (lbsCrackfill === 0) {
    return { clientId, skipped: true, reason: `Pavement Size ${pavementSf} sq ft rounds to 0 lbs crackfill` };
  }

  // 2. Get full client record for SaveClient
  const ciRes = await post('/webservices/ClientEditOverlayWs.asmx/GetClientInfo',
    { ClientID: clientId }, 'Clients.aspx');
  const d = ciRes.data?.d;
  if (!d) throw new Error(`SA setClientCrackfill: GetClientInfo failed for ${clientId}: ${ciRes.text?.slice(0, 200)}`);

  function parseSaDate(v) {
    if (!v) return { Month: -1, Day: -1, Year: -1 };
    if (typeof v === 'object' && 'Month' in v && 'Day' in v && 'Year' in v) {
      const { Month, Day, Year } = v;
      if (Month > 0 && Day > 0 && Year > 0) {
        const dt = new Date(Year, Month - 1, Day);
        if (dt.getMonth() + 1 === Month && dt.getDate() === Day) return { Month, Day, Year };
      }
      return { Month: -1, Day: -1, Year: -1 };
    }
    const ms = String(v).match(/\/Date\((-?\d+)\)\//);
    const dt = ms ? new Date(parseInt(ms[1])) : new Date(v);
    if (isNaN(dt.getTime())) return { Month: -1, Day: -1, Year: -1 };
    return { Month: dt.getMonth() + 1, Day: dt.getDate(), Year: dt.getFullYear() };
  }

  // 3. Build CustomFields array — crackfill updated; pavement size written if caller supplied it
  const customFields = fields.map(f => {
    if (f.CustomFieldName === 'Lbs of Crackfill')
      return { CustomFieldValue: String(lbsCrackfill), CustomFieldDate: null, CustomFieldID: f.CustomFieldID };
    if (f.CustomFieldName === 'Pavement Size' && pavementSfArg != null)
      return { CustomFieldValue: String(pavementSfArg), CustomFieldDate: null, CustomFieldID: f.CustomFieldID };
    return { CustomFieldValue: f.CustomFieldValue || '', CustomFieldDate: null, CustomFieldID: f.CustomFieldID };
  });

  // 4. Build SaveClient info — preserve all existing client values, only add CustomFields
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
    SalesTaxCodeID:          d.SalesTaxCodeInfo?.Value          || EMPTY_GUID,
    InvoiceFrequencyID:      d.InvoiceFrequencyInfo?.Value      || EMPTY_GUID,
    StandardTermID:          d.StandardTermInfo?.Value          || EMPTY_GUID,
    SendInvoiceBy:           d.SendInvoiceBy                    || 'Email',
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
    CustomFields:            customFields,
  };

  // 5. Save
  const saveRes = await post('/webservices/ClientEditOverlayWs.asmx/SaveClient',
    { info }, 'ClientView.aspx');
  const result = saveRes.data?.d;
  const errors = result?.response?.Errors;

  if (errors?.length > 0) {
    throw new Error(`SA setClientCrackfill SaveClient errors: ${JSON.stringify(errors)}`);
  }
  if (saveRes.status === 500) {
    // QBO-sync bug: server saves OK then crashes in post-save QBO sync — custom fields persisted
    logger.warn('SA setClientCrackfill: SaveClient 500 (QBO sync bug) — field likely saved', { clientId, lbsCrackfill });
    return { clientId, pavementSf, lbsCrackfill, savedViaApi: false };
  }

  logger.info('SA: setClientCrackfill complete', { clientId, pavementSf, lbsCrackfill });
  return { clientId, pavementSf, lbsCrackfill, savedViaApi: true };
}

/**
 * Fetch recent CRM notes/tickets for a client — call history, site visits, consultation notes.
 * Uses MyDay_GetTickets with CustomerJobID filter (discovered 2026-06-13).
 * Returns newest first, limited to `limit` entries.
 */
/**
 * Fetch recent CRM notes/tickets for a client — call history, site visits, consultation notes.
 *
 * FIX 2026-08-25 (two bugs corrected):
 *
 * Bug 1 — getClientDetails was called as getClientDetails(clientId) (raw string), not
 * getClientDetails({ clientId }) (object). getClientDetails() destructures { clientId }
 * from its argument, so a raw string produced clientId=undefined inside the function,
 * which caused SA to return "no data returned for clientId undefined".
 *
 * Bug 2 — MyDay_GetTickets with AllTickets:true completely ignores the CustomerJobID
 * filter server-side and returns SA's global/company-wide ticket feed (confirmed live
 * 2026-08-25: probing with Behzad Shabahang's customerJobId returned Dan McCoy's
 * ticket as the first result). The fix is to fetch with a large page size (fetch enough
 * to cover the per-client window) and then filter client-side by EntityID === customerJobId,
 * which is the field SA itself uses to associate a ticket with a specific account.
 *
 * Returns newest first, limited to `limit` per-client entries.
 */
export async function getClientNotes({ clientId, limit = 10 }) {
  // Bug 1 fix: pass object, not raw string
  const details = await getClientDetails({ clientId });
  const { customerJobId } = details;

  // Bug 2 fix: fetch a broad window (global feed), then filter by EntityID client-side.
  // Fetch more than `limit` so filtering still yields up to `limit` per-client results.
  const fetchSize = Math.max(limit * 20, 200);
  const res = await post('/CRMBFF/TicketList/MyDay_GetTickets', {
    QueryInput: { MaxRows: fetchSize, AllTickets: true, StartingRow: 0, CustomerJobID: customerJobId },
  }, 'ClientView.aspx');

  const allTickets = res.data?.Tickets || [];

  // Filter to only tickets belonging to this client (EntityID === customerJobId).
  // AllTickets:true ignores CustomerJobID server-side; this is the client-side guard.
  const tickets = allTickets
    .filter(t => t.EntityID === customerJobId)
    .slice(0, limit);

  logger.info('SA: getClientNotes complete', { clientId, customerJobId, fetchedGlobal: allTickets.length, perClient: tickets.length });

  return tickets.map(t => {
    const d = t.RequestDate || t.StartDate || {};
    const date = (d.Year > 0)
      ? `${d.Year}-${String(d.Month).padStart(2, '0')}-${String(d.Day).padStart(2, '0')}`
      : '';
    return {
      ticketId:   t.ID,
      date,
      type:       t.TicketTypeDescription || '',
      subject:    t.Notes    || '',
      comment:    t.Comment  || '',
      assignedTo: t.AssignedResourceName || '',
      status:     t.TicketStatus === 1 ? 'open' : 'closed',
    };
  });
}


export async function syncWaitingList() {
  const today = new Date();
  const body = {
    OnNewDispatchBoard: true,
    QueryData: {
      IsWaitingList: true,
      StartDate: { Month: 1, Day: 1, Year: today.getFullYear() + 1 },
      EndDate:   { Month: today.getMonth() + 1, Day: today.getDate(), Year: today.getFullYear() },
      ServiceIDs: [], CrewIDs: [], CustomFields: [], Divisions: [],
      Tags: [], TicketTypes: [], DOW: -1,
      DispatchID: EMPTY_GUID, DispatchedOnly: false, FilterProximity: false,
      IncludeUnassignedWork: false, IsCloseOutDay: false, IsSnow: false,
      LoadAppointmentTimes: false, MapCode: '', MapCodeOperator: '0', MultiDay: false,
      Priority: '0', ProximityAddress: '', ProximityMiles: '5.00',
      ResourceID: 1, ResourceTags: '', ScheduleStatus: '0',
      ScreenViewID: EMPTY_GUID, ShowProductTotals: true, UseMinDays: true,
      Address: '', City: '', Client: '', Zip: '',
    },
  };

  const res = await post('/WebServices/ScheduledWorkWs.asmx/Query', body, 'DispatchBoard.aspx');
  const items = res.data?.d?.ScheduledItems || res.data?.ScheduledItems || [];
  logger.info('SA syncWaitingList: fetched from SA', { count: items.length });

  if (items.length === 0) return { synced: 0, extractedAt: today.toISOString() };

  function parseWLDate(str) {
    if (!str) return null;
    const clean = str.replace(/<[^>]+>/g, '').trim().split('\n')[0].trim();
    const parts = clean.split('/');
    if (parts.length < 3) return null;
    const [m, d, y] = parts;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  function parseWLStartDate(str) {
    if (!str) return { targetDate: null, addedDate: null };
    const stripped = str.replace(/<br\/>/gi, '|').replace(/<[^>]+>/g, '');
    const parts = stripped.split('|').map(s => s.replace(/[()]/g, '').trim());
    return { targetDate: parseWLDate(parts[0]), addedDate: parseWLDate(parts[1]) };
  }

  const records = items.map(item => {
    const { targetDate, addedDate } = parseWLStartDate(item.StartDate);
    const dateAddedStr = parseWLDate(item.DateAdded) || addedDate;
    const daysWaiting  = dateAddedStr ? Math.floor((today - new Date(dateAddedStr)) / 86400000) : null;
    return {
      job_id: item.ID, sa_job_id: item.ID, client_id: item.CustomerID,
      client_name: item.Client, address: item.Address, city: item.City,
      state: item.State, zip: item.Zip, service_code: item.Service,
      amount: item.Amount, date_added: dateAddedStr, target_date: targetDate,
      sales_rep: item.SalesRep,
      internal_notes: item.InternalSchedulingNotes || null,
      notes:          item.InternalSchedulingNotes || null,
      status: String(item.Status), service_timing: item.ServiceTiming,
      latitude: item.Latitude || null, longitude: item.Longitude || null,
      budgeted_hours: item.BudgetedHours || null, days_waiting: daysWaiting,
      extracted_at: today.toISOString(),
    };
  });

  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient(
    'https://mzywmgesulyalevtzudw.supabase.co',
    process.env.FLEETOPS_SUPABASE_SERVICE_KEY,
  );

  const BATCH = 500;
  let upserted = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const { error } = await db.from('sa_waiting_list').upsert(records.slice(i, i + BATCH), { onConflict: 'job_id' });
    if (error) throw new Error(`syncWaitingList upsert batch ${i}: ${error.message}`);
    upserted += Math.min(BATCH, records.length - i);
  }

  // Remove rows SA no longer reports on the waiting list (completed, invoiced, removed).
  // Only runs when SA returned a non-empty response so a connectivity glitch doesn't wipe the table.
  const freshIds = records.map(r => r.job_id);
  const { error: pruneErr, count: pruned } = await db
    .from('sa_waiting_list')
    .delete({ count: 'exact' })
    .not('job_id', 'in', `(${freshIds.join(',')})`);
  if (pruneErr) logger.warn('syncWaitingList: prune failed', { err: pruneErr.message });
  else logger.info('SA syncWaitingList complete', { returned: items.length, upserted, pruned: pruned ?? 0 });

  return { synced: upserted, pruned: pruned ?? 0, extractedAt: today.toISOString() };
}

/**
 * Pull the SA dispatch board's ScheduledWork for a date range and upsert to sa_jobs
 * (fleetops Supabase). Unlike syncWaitingList, this never prunes — sa_jobs is a
 * historical record (invoiced/completed jobs must persist), not a live snapshot.
 */
export async function syncScheduledWork({ startDate, endDate }) {
  // Date-only strings ("2026-07-01") parse as UTC midnight — normalize to local noon first
  // so a Central-time host doesn't read the range back as shifted a day earlier.
  const normalizeDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T12:00:00`) : d;
  const start = toSaBrowserDate(normalizeDate(startDate));
  const end   = toSaBrowserDate(normalizeDate(endDate));
  const isMulti = !(start.Month === end.Month && start.Day === end.Day && start.Year === end.Year);

  const body = {
    OnNewDispatchBoard: true,
    QueryData: {
      IsWaitingList: false,
      StartDate: start, EndDate: end,
      ServiceIDs: [], CrewIDs: [], CustomFields: [], Divisions: [],
      Tags: [], TicketTypes: [], DOW: -1,
      DispatchID: EMPTY_GUID, DispatchedOnly: false, FilterProximity: false,
      IncludeUnassignedWork: false, IsCloseOutDay: false, IsSnow: false,
      LoadAppointmentTimes: false, MapCode: '', MapCodeOperator: '0', MultiDay: isMulti,
      Priority: '0', ProximityAddress: '', ProximityMiles: '5.00',
      ResourceID: 1, ResourceTags: '', ScheduleStatus: '0',
      ScreenViewID: EMPTY_GUID, ShowProductTotals: true, UseMinDays: true,
      Address: '', City: '', Client: '', Zip: '',
    },
  };

  const res = await post('/WebServices/ScheduledWorkWs.asmx/Query', body, 'DispatchBoard.aspx');
  const items = res.data?.d?.ScheduledItems || res.data?.ScheduledItems || [];
  logger.info('SA syncScheduledWork: fetched from SA', { count: items.length, startDate, endDate });

  if (items.length === 0) return { synced: 0 };

  // start_date is half of the upsert's dedup key (id, start_date) — a null here means
  // re-syncing the same item creates a duplicate row instead of updating it.
  const skipped = items.filter(item => !parseSaMdy(item.StartDate)).length;
  if (skipped > 0) logger.warn('SA syncScheduledWork: dropping items with unparseable StartDate', { skipped });
  const records = items.filter(item => parseSaMdy(item.StartDate)).map(mapScheduledWorkItem);

  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient(
    'https://mzywmgesulyalevtzudw.supabase.co',
    process.env.FLEETOPS_SUPABASE_SERVICE_KEY,
  );

  const BATCH = 500;

  // Preserve the true first_seen_at for rows that already exist — an upsert otherwise
  // resets it to "now" on every re-sync.
  const keys = records.map(r => `and(id.eq.${r.id},start_date.eq.${r.start_date})`);
  const existingFirstSeen = new Map();
  for (let i = 0; i < keys.length; i += BATCH) {
    const { data, error } = await db
      .from('sa_jobs')
      .select('id, start_date, first_seen_at')
      .or(keys.slice(i, i + BATCH).join(','));
    if (error) throw new Error(`syncScheduledWork first_seen_at lookup: ${error.message}`);
    for (const row of data || []) existingFirstSeen.set(`${row.id}|${row.start_date}`, row.first_seen_at);
  }
  for (const r of records) {
    const existing = existingFirstSeen.get(`${r.id}|${r.start_date}`);
    if (existing) r.first_seen_at = existing;
  }

  let upserted = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const { error } = await db.from('sa_jobs').upsert(records.slice(i, i + BATCH), { onConflict: 'id,start_date' });
    if (error) throw new Error(`syncScheduledWork upsert batch ${i}: ${error.message}`);
    upserted += Math.min(BATCH, records.length - i);
  }
  logger.info('SA syncScheduledWork complete', { returned: items.length, upserted, skipped });
  return { synced: upserted, skipped };
}

/**
 * List SA dispatch board resources (crews) available for assignment.
 * Returns [{ id, name }]
 */
export async function listSAResources() {
  const res = await post('/WebServices/ListsWs.asmx/GetMoveToResourceList', {}, 'DispatchBoard.aspx');
  const list = res.data?.d || res.data || [];
  if (!Array.isArray(list)) throw new Error(`SA listSAResources: unexpected response — ${res.text?.slice(0, 200)}`);
  return list.map(r => ({ id: r.ID || r.Value || '', name: r.Name || r.Text || '' })).filter(r => r.id);
}

/**
 * Dispatch a waiting list job to a specific date and crew in SA.
 *
 * @param {object} opts
 * @param {string} opts.wlItemId     SA waiting list item UUID (sa_waiting_list.job_id)
 * @param {string} opts.scheduleDate ISO date YYYY-MM-DD
 * @param {string} opts.resourceId   SA resource/crew GUID
 * @returns {{ success: boolean, wlItemId: string, scheduleDate: string, removedFromWL: boolean }}
 */
export async function dispatchWaitingListJob({ wlItemId, scheduleDate, resourceId }) {
  // 1. Get current assignment data for this WL item
  const getRes = await post('/WebServices/ScheduledWorkWs.asmx/GetAssignmentData', {
    AssignmentRequest: { ID: wlItemId, Type: 'S' },
  }, 'DispatchBoard.aspx');

  const current = getRes.data?.d;
  if (!current) {
    throw new Error(`SA dispatchWaitingListJob: GetAssignmentData failed — ${getRes.text?.slice(0, 200)}`);
  }

  // 2. Parse target date
  const dt = new Date(scheduleDate + 'T12:00:00');
  const today = new Date();
  const svcDate  = toSaBrowserDate(dt);
  const svcDateTime = { ...svcDate, Hour: 0, Minute: 0, Second: 0 };
  const viewStart = toSaBrowserDate(today);
  const viewEnd   = toSaBrowserDate(new Date(today.getTime() + 14 * 86400000));

  // 3. Build save payload — change status to route, set date + crew
  const saveData = {
    ...current,
    ScheduleStatus: '2',        // 2 = Route (dispatched)
    ServiceDate: svcDate,
    AssignedResourceIDs: [resourceId],
    StartDate: svcDateTime,    // SA expects BrowserDateTime (includes Hour/Minute/Second)
    EndDate:   svcDateTime,
    ViewStartDate: viewStart,
    ViewEndDate:   viewEnd,
  };

  // 4. Save — moves the job off the waiting list and onto the schedule
  const saveRes = await post('/WebServices/ScheduledWorkWs.asmx/SaveAssignmentData', {
    AssignmentData: saveData,
  }, 'DispatchBoard.aspx');

  const response = saveRes.data?.d;
  if (!response) {
    throw new Error(`SA dispatchWaitingListJob: empty response from SaveAssignmentData (status=${saveRes.status})`);
  }
  const errors = response?.Errors || [];
  if (errors.length > 0) {
    throw new Error(`SA dispatchWaitingListJob failed: ${JSON.stringify(errors)}`);
  }

  logger.info('SA: WL job dispatched', { wlItemId, scheduleDate, resourceId });
  return {
    success: true,
    wlItemId,
    scheduleDate,
    resourceId,
    removedFromWL: response?.RemoveFromList === true,
  };
}

/**
 * Set the route stop order for a set of jobs already on the SA dispatch board.
 * Must be called after all jobs for the day+crew have been dispatched.
 *
 * Payload structure confirmed via browser DevTools (2026-06-14):
 *   RouteOrderData.Items = [{id, order, Type:"S", Mileage:"0.00", ScheduledServiceAssignmentID: EMPTY_GUID}]
 *   RouteOrderData.Mode = "1"
 *   RouteOrderData.StartDate = BrowserDate {Month, Day, Year}  (NOT BrowserDateTime)
 *   OnNewDispatchBoard = true
 *   No ResourceID — SA infers resource from the item GUIDs.
 *
 * @param {object} opts
 * @param {string}   opts.scheduleDate  ISO date YYYY-MM-DD
 * @param {string[]} opts.jobIds        Job IDs in desired stop order (index 0 = stop 1)
 */
export async function updateRouteOrder({ scheduleDate, jobIds }) {
  if (!jobIds?.length) return { success: true, count: 0 };

  const dt = new Date(scheduleDate + 'T12:00:00');
  const startDate = toSaBrowserDate(dt);

  const res = await post('/WebServices/ScheduledWorkWs.asmx/UpdateRouteOrder', {
    RouteOrderData: {
      Items: jobIds.map((id, i) => ({
        id,
        order: i + 1,
        Type: 'S',
        Mileage: '0.00',
        ScheduledServiceAssignmentID: EMPTY_GUID,
      })),
      Mode: '1',
      StartDate: startDate,
    },
    OnNewDispatchBoard: true,
  }, 'DispatchBoard.aspx');

  const d = res.data?.d;
  if (!d) {
    throw new Error(`SA updateRouteOrder: no response (status=${res.status}). Raw: ${res.text?.slice(0, 300)}`);
  }
  const errors = d.Errors || [];
  if (errors.length > 0) {
    throw new Error(`SA updateRouteOrder failed: ${JSON.stringify(errors)}`);
  }

  logger.info('SA: route order updated', { scheduleDate, count: jobIds.length });
  return { success: true, count: jobIds.length };
}
