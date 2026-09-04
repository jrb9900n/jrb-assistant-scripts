// tools/impl/fleetsharp.js — FleetSharp GPS/telematics read-only access via browser session
// FleetSharp has no public API. Discovered 2026-08-19 by capturing network traffic through a
// real login: cookie-session auth (no visible bot protection, unlike Incapsula-guarded SA), a
// classic ExtJS/Sencha portal at <api-origin>/ng/portal, and a REST layer at /ibis/rest/* that
// white-labels the Linxup telematics platform. See CLAUDE.md "FleetSharp" section for endpoint
// notes. Read-only by design — no write/POST-mutation endpoints have been probed or wired up.

import fs from 'fs';
import { fileURLToPath } from 'url';
import { logger } from '../../core/logger.js';

const LOGIN_PATH = '/login';
const EDGE_PATH   = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours — matches SA convention
const SESSION_CACHE_PATH = fileURLToPath(new URL('../../fleetsharp-session-cache.json', import.meta.url));

let _browser = null;
let _page = null;
let _apiBase = null;      // origin the portal lands on post-login (e.g. https://app02.fleetsharp.com) — captured live, not hardcoded, since it can vary per account
let _sessionExpiry = 0;
let _loginPromise = null; // dedupe concurrent login attempts

export async function closeFleetSharpSession() {
  if (_browser) {
    try { await _browser.close(); } catch {}
    _browser = null;
    _page = null;
  }
}

async function saveSessionCookies(page, apiBase) {
  try {
    const cookies = await page.cookies();
    if (cookies.length === 0) return;
    fs.writeFileSync(SESSION_CACHE_PATH, JSON.stringify({ apiBase, cookies }), 'utf8');
  } catch (e) {
    logger.warn('FleetSharp: could not save session cookies', { error: e.message });
  }
}

async function tryRestoreSession(page) {
  try {
    if (!fs.existsSync(SESSION_CACHE_PATH)) return null;
    const { apiBase, cookies } = JSON.parse(fs.readFileSync(SESSION_CACHE_PATH, 'utf8'));
    if (!apiBase || !Array.isArray(cookies) || cookies.length === 0) return null;
    await page.setCookie(...cookies);
    // networkidle2 (not domcontentloaded) — the SPA fires its own bootstrap calls after
    // load, including /authentication/v2/refresh which mints the short-lived token our
    // direct fetch() calls need. Returning before that settles causes real API calls
    // (not just the page load) to 401 even though the portal shell renders fine.
    await page.goto(`${apiBase}/ng/portal/index.html`, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    if (/\/login/i.test(page.url())) {
      logger.info('FleetSharp: cached cookies expired, will do full login');
      return null;
    }
    logger.info('FleetSharp: session restored from cookie cache — skipped login form');
    return apiBase;
  } catch (e) {
    logger.warn('FleetSharp: cookie restore failed, will do full login', { error: e.message });
    return null;
  }
}

async function login(skipRestore = false) {
  let puppeteerExtra, StealthPlugin;
  try {
    puppeteerExtra = (await import('puppeteer-extra')).default;
    StealthPlugin  = (await import('puppeteer-extra-plugin-stealth')).default;
  } catch {
    throw new Error('puppeteer-extra or puppeteer-extra-plugin-stealth not installed');
  }

  const executablePath = fs.existsSync(EDGE_PATH) ? EDGE_PATH
    : fs.existsSync(CHROME_PATH) ? CHROME_PATH
    : null;
  if (!executablePath) throw new Error('FleetSharp login: no Edge or Chrome browser found on this machine');

  const baseUrl  = process.env.FLEETSHARP_URL || '';
  const email    = process.env.FLEETSHARP_EMAIL || '';
  const password = process.env.FLEETSHARP_PASSWORD || '';
  if (!baseUrl || !email || !password) throw new Error('FLEETSHARP_URL/FLEETSHARP_EMAIL/FLEETSHARP_PASSWORD env vars not set');

  puppeteerExtra.use(StealthPlugin());
  const browser = await puppeteerExtra.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    // skipRestore=true on a forced re-login (401 from a live API call) — the cookies
    // that just failed are exactly what tryRestoreSession would try again, so retrying
    // via cache here would silently loop on the same stale session instead of getting
    // a fresh one from the real login form.
    const restoredApiBase = skipRestore ? null : await tryRestoreSession(page);
    if (restoredApiBase) {
      return { browser, page, apiBase: restoredApiBase };
    }

    // tryRestoreSession may have loaded stale cookies onto the page before
    // determining they're expired.  Those cookies would be sent alongside the
    // login POST and can cause FleetSharp to reject the credentials (staying on
    // the login page) even when the username/password are correct.  Clear them
    // now so the fresh login form sees a clean browser state.
    try {
      const staleCookies = await page.cookies();
      if (staleCookies.length > 0) await page.deleteCookie(...staleCookies);
    } catch {}

    logger.info('FleetSharp: starting browser login');
    const loginUrl = baseUrl.includes(LOGIN_PATH) ? baseUrl : `${baseUrl.replace(/\/$/, '')}${LOGIN_PATH}`;
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#username', { timeout: 15000 });
    await page.type('#username', email);
    await page.type('#password', password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null),
      page.click('button[type="submit"], input[type="submit"]'),
    ]);
    await new Promise(r => setTimeout(r, 2000));

    if (/\/login/i.test(page.url())) {
      // Delete the session cache so the next attempt doesn't try loading the
      // same expired cookies again — it would restore them, fail, then hit the
      // exact same fresh-login path with the same stale cookies already set.
      // Skip the delete on skipRestore=true (forced re-login after a 401): the
      // cache was never consulted in that path and may still hold valid cookies
      // a future non-forced attempt could use.
      if (!skipRestore) { try { fs.unlinkSync(SESSION_CACHE_PATH); } catch {} }
      throw new Error('FleetSharp login failed — still on login page after submit (bad credentials or form changed)');
    }

    const apiBase = new URL(page.url()).origin;
    await saveSessionCookies(page, apiBase);
    logger.info('FleetSharp: login complete', { apiBase });
    return { browser, page, apiBase };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

async function getSession(force = false) {
  if (!force && _page && Date.now() < _sessionExpiry) {
    return { page: _page, apiBase: _apiBase };
  }
  if (!_loginPromise) {
    _loginPromise = (async () => {
      if (_browser) {
        try { await _browser.close(); } catch {}
        _browser = null;
        _page = null;
      }
      return login(force);
    })()
      .then(({ browser, page, apiBase }) => {
        _browser = browser;
        _page = page;
        _apiBase = apiBase;
        _sessionExpiry = Date.now() + SESSION_TTL_MS;
        _loginPromise = null;
        return { page, apiBase };
      })
      .catch(err => {
        _loginPromise = null;
        throw err;
      });
  }
  return _loginPromise;
}

// FleetSharp signals an expired session two different ways depending on which
// layer notices: a stale portal-page cookie redirects to the HTML login page,
// but a stale API-auth token (refreshed separately by the SPA's own bootstrap
// JS — see tryRestoreSession) instead returns a 401 JSON error with the portal
// shell still loaded. Both must trigger a forced re-login, or a cookie-restore
// that "succeeds" at loading the page but can't actually call any API silently
// fails every real request.
function sessionExpired(res) {
  if (res.status === 401 || res.status === 403) return true;
  return typeof res.text === 'string' && /name="username"/i.test(res.text) && /name="password"/i.test(res.text);
}

async function fsGet(path) {
  let { page, apiBase } = await getSession();
  let res = await rawGet(page, `${apiBase}${path}`);
  if (sessionExpired(res)) {
    ({ page, apiBase } = await getSession(true));
    res = await rawGet(page, `${apiBase}${path}`);
  }
  return parseJson(res, path);
}

async function fsPost(path, formBody) {
  let { page, apiBase } = await getSession();
  let res = await rawPost(page, `${apiBase}${path}`, formBody);
  if (sessionExpired(res)) {
    ({ page, apiBase } = await getSession(true));
    res = await rawPost(page, `${apiBase}${path}`, formBody);
  }
  return parseJson(res, path);
}

function parseJson(res, path) {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`FleetSharp ${path} returned HTTP ${res.status}: ${res.text?.slice(0, 300)}`);
  }
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(`FleetSharp ${path} returned non-JSON response: ${res.text?.slice(0, 300)}`);
  }
}

async function rawGet(page, url) {
  return page.evaluate(async (url) => {
    const res = await window.fetch(url, { credentials: 'include' });
    const text = await res.text();
    return { status: res.status, text };
  }, url);
}

async function rawPost(page, url, formBody) {
  return page.evaluate(async ({ url, formBody }) => {
    const res = await window.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: formBody,
    });
    const text = await res.text();
    return { status: res.status, text };
  }, { url, formBody });
}

// getLinxupTripsReport/getFleetActivityDispatch take application/x-www-form-urlencoded,
// but runAsyncReport (used by getAdvancedTripsExport) takes a raw JSON body instead —
// a separate content-type from the rest of this module's POST calls.
async function fsPostJson(path, jsonBody) {
  let { page, apiBase } = await getSession();
  let res = await rawPostJson(page, `${apiBase}${path}`, jsonBody);
  if (sessionExpired(res)) {
    ({ page, apiBase } = await getSession(true));
    res = await rawPostJson(page, `${apiBase}${path}`, jsonBody);
  }
  return parseJson(res, path);
}

async function rawPostJson(page, url, jsonBody) {
  return page.evaluate(async ({ url, jsonBody }) => {
    const res = await window.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(jsonBody),
    });
    const text = await res.text();
    return { status: res.status, text };
  }, { url, jsonBody });
}

// Downloads a signed GCS URL (from getAsyncReportStatus's excelSignedLink) as a Buffer.
// The signed URL carries its own auth (GoogleAccessId/Expires/Signature query params),
// so no FleetSharp session cookies are needed — and it must NOT be fetched via the
// page's own window.fetch(): storage.googleapis.com is a different origin than the
// FleetSharp page, and GCS signed URLs don't send permissive CORS headers, so a
// same-page fetch is blocked by the browser with a generic "Failed to fetch" (confirmed
// live 2026-08-19). Node's own fetch has no CORS enforcement — it's a browser-only
// restriction — so downloading directly in Node sidesteps the problem entirely.
async function downloadAsBuffer(signedUrl) {
  const res = await fetch(signedUrl);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function toFormBody(params) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? '')}`)
    .join('&');
}

// ── Public tool functions ────────────────────────────────────────────────────

/**
 * List all trackers/vehicles on the account, joining device inventory with
 * the live position snapshot (odometer, GPS, status).
 * Returns [{ deviceId, driverId, vehicleName, vin, deviceSerialNumber, status, lat, lng, odometer, speed, lastUpdate }]
 */
export async function getVehicleList() {
  const [setupRes, positionsRes] = await Promise.all([
    fsGet('/ibis/rest/setup/tracker-setup'),
    fsGet('/ibis/rest/linxup/map/getPositions'),
  ]);

  // Keyed by String(deviceId) — tracker-setup and getPositions are two independent
  // undocumented endpoints and there's no guarantee both serialize deviceId as the
  // same JS type (number vs numeric string), so a strict-equality Map lookup could
  // silently drop every match instead of erroring.
  const positionsByDevice = new Map(
    (positionsRes.data || []).map(p => [String(p.linxupPosition?.deviceId), p])
  );

  return (Array.isArray(setupRes) ? setupRes : []).map(t => {
    const pos = positionsByDevice.get(String(t.deviceId));
    const lp = pos?.linxupPosition;
    return {
      deviceId: t.deviceId,
      driverId: t.driverId,
      vehicleName: t.vehicleName,
      vin: t.vin || null,
      deviceSerialNumber: t.deviceSerialNumber,
      deviceTypeDescription: t.deviceTypeDescription,
      status: t.vehicleState,
      lat: lp?.lat ?? null,
      lng: lp?.lng ?? null,
      odometer: t.odo ?? lp?.odo ?? null,
      trueOdometer: lp?.trueOdometer ?? null,
      speed: lp?.speed ?? null,
      lastUpdate: lp?.positionDateTime ? new Date(lp.positionDateTime).toISOString() : null,
    };
  });
}

/**
 * Live GPS positions for every tracker, without the device-inventory join.
 * Cheaper than getVehicleList() when only current location/odometer is needed.
 */
export async function getLivePositions() {
  const res = await fsGet('/ibis/rest/linxup/map/getPositions');
  return (res.data || []).map(p => {
    const lp = p.linxupPosition || {};
    return {
      deviceId: lp.deviceId,
      driverId: lp.driverId,
      fleetId: lp.fleetId,
      status: p.connectionStatus,
      lat: lp.lat,
      lng: lp.lng,
      speed: lp.speed,
      odometer: lp.odo,
      trueOdometer: lp.trueOdometer,
      idleTimeLabel: p.idleTimeLabel,
      stopTimeLabel: p.stopTimeLabel,
      lastUpdate: lp.positionDateTime ? new Date(lp.positionDateTime).toISOString() : null,
    };
  });
}

/**
 * Daily mileage + activity per vehicle/driver over a date range.
 * startDate/endDate: 'YYYY-MM-DD'. driverIds: optional array of tracker/driver
 * IDs from getVehicleList()'s driverId field — omit for all vehicles.
 * Returns [{ driverId, date, milesDriven, kilometersDriven, idleTimeMin, driveTimeMin, stopTimeMin, score, grade }]
 */
export async function getDailyMileage({ startDate, endDate, driverIds = [] }) {
  if (!startDate || !endDate) throw new Error('getDailyMileage requires startDate and endDate (YYYY-MM-DD)');

  const toEpoch = (d, endOfDay = false) => {
    const dt = new Date(`${d}T${endOfDay ? '23:59:59' : '00:00:00'}`);
    return dt.getTime();
  };
  const toCompact = (d) => d.replace(/-/g, '');

  const body = toFormBody({
    startDate: toCompact(startDate),
    endDate: toCompact(endDate),
    driverIds: driverIds.join(','),
    appDriverIds: '',
    startEpoch: toEpoch(startDate, false),
    endEpoch: toEpoch(endDate, true),
    metricUnits: false,
    dispatch: true,
    safetyScoreHardwareType: 'ALL',
  });

  const res = await fsPost('/ibis/rest/linxup/reports/getFleetActivityDispatch', body);
  const rows = res.data?.dailyByDriver || [];

  // r.startDate is [year, month, day] with 1-based month — confirmed 2026-08-19 by
  // requesting a known 3-day window (2026-08-16..19) and checking the returned dates
  // landed in that exact range, ruling out 0-based (Jackson/LocalDate-style) month.
  return rows.map(r => ({
    driverId: r.driverId,
    date: Array.isArray(r.startDate)
      ? r.startDate.map((n, i) => i === 0 ? String(n) : String(n).padStart(2, '0')).join('-')
      : null,
    milesDriven: r.milesDriven,
    kilometersDriven: r.kilometersDriven,
    idleTimeMin: r.idleTime,
    driveTimeMin: r.driveTime,
    stopTimeMin: r.stopTime,
    stopCount: r.stopCount,
    score: r.score,
    grade: r.grade,
  }));
}

/**
 * Runs FleetSharp's "Advanced Trips" report for a date range and returns the
 * resulting per-event rows as an .xlsx Buffer — the same report + format the
 * manual monthly accounting workflow already pastes into a spreadsheet by hand
 * (Reports > Advanced Trips > Export). This is an async report on FleetSharp's
 * side: submit -> poll until COMPLETE -> download a signed result URL. Confirmed
 * 2026-08-19 via a live capture of that exact manual flow.
 *
 * startDate/endDate: 'YYYY-MM-DD'. Returns a Buffer (parse with the `xlsx` package).
 */
export async function getAdvancedTripsExport({ startDate, endDate, pollIntervalMs = 5000, maxPolls = 36 }) {
  if (!startDate || !endDate) throw new Error('getAdvancedTripsExport requires startDate and endDate (YYYY-MM-DD)');

  const startEpoch = new Date(`${startDate}T00:00:00`).getTime();
  const endEpoch = new Date(`${endDate}T23:59:59`).getTime();

  await fsPostJson('/ibis/rest/scheduled-reports/runAsyncReport', {
    reportType: 'ADVANCED_TRIPS',
    appDriverIds: [],
    sort: 'Tracker',
    startEpoch,
    endEpoch,
    driverIds: [],
    customerId: null,
    customerGroupId: null,
    dispatch: true,
    coordinatesLocation: false,
    metricUnits: false,
    tzName: 'America/Chicago',
    stopType: null,
    getGeofenceVisits: true,
    getAlerts: false,
    getCustomerVisits: false,
    emailReport: false,
    groupSummary: 'All',
    trackerSummary: 'All',
    appDriverSummary: 'All',
    alertTypeSummary: null,
    stopTypeSummary: '',
    alertType: null,
    geofenceId: null,
    bidVsActualStatus: 'MATCHED',
    safetyScoreHardwareType: 'ALL',
  });

  // Poll getAsyncReportStatus until it reports OUR job as COMPLETE. This endpoint
  // returns "the account's latest ADVANCED_TRIPS report" rather than something keyed
  // to a job ID from the submit call (which returns an empty body) — so a stale
  // completed report from a different date range could otherwise be mistaken for
  // ours. Guard against that by checking the embedded criteria's startEpoch/endEpoch
  // match what we actually requested before accepting a status as "ours."
  let status = null;
  for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, pollIntervalMs));
    const res = await fsGet('/ibis/rest/scheduled-reports/getAsyncReportStatus/ADVANCED_TRIPS');
    const data = res?.data;
    if (!data) continue;
    let criteria = null;
    try { criteria = JSON.parse(data.criteria); } catch {}
    if (criteria?.startEpoch === startEpoch && criteria?.endEpoch === endEpoch && data.status === 'COMPLETE') {
      status = data;
      break;
    }
  }
  if (!status) throw new Error(`FleetSharp Advanced Trips report did not complete within ${(pollIntervalMs * maxPolls) / 1000}s`);
  if (!status.excelSignedLink) throw new Error(`FleetSharp Advanced Trips report completed with no download link: ${status.errorMsg || 'unknown error'}`);

  return downloadAsBuffer(status.excelSignedLink);
}

/**
 * Tracker/driver ID -> display name map, used to label getDailyMileage()
 * and getLivePositions() rows (both key by driverId, not vehicle name).
 */
export async function getTrackerNames() {
  const res = await fsGet('/ibis/rest/linxup/reports/reportFilterTrackers');
  return (Array.isArray(res) ? res : [])
    .filter(t => t.id > 0)
    .map(t => ({ driverId: t.id, name: t.name, fleetId: t.fleetId, status: t.statusCode }));
}
