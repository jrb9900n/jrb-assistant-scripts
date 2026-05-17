// tools/impl/serviceautopilot.js — Service Autopilot read/write via browser session
// SA has no public API; we log in via puppeteer-core and call the internal BFF endpoints.
// Session cookies are cached in-process for 4 hours to avoid repeated browser launches.

import fs from 'fs';
import { logger } from '../../core/logger.js';

const SA_BASE    = 'https://my.serviceautopilot.com';
const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';
const EDGE_PATH  = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

let _sessionCookies = null;
let _sessionExpiry  = 0;
let _loginPromise   = null; // deduplicate concurrent login attempts

// ── Session management ───────────────────────────────────────────────────────

async function getSession(force = false) {
  if (!force && _sessionCookies && Date.now() < _sessionExpiry) {
    return _sessionCookies;
  }
  if (!_loginPromise) {
    _loginPromise = login()
      .then(cookies => {
        _sessionCookies = cookies;
        _sessionExpiry  = Date.now() + SESSION_TTL_MS;
        _loginPromise   = null;
        return cookies;
      })
      .catch(err => {
        _loginPromise = null;
        throw err;
      });
  }
  return _loginPromise;
}

async function login() {
  logger.info('SA: starting browser login');
  let puppeteer;
  try {
    puppeteer = (await import('puppeteer-core')).default;
  } catch {
    throw new Error('puppeteer-core not installed — run: npm install puppeteer-core');
  }

  const executablePath = fs.existsSync(EDGE_PATH)   ? EDGE_PATH
    : fs.existsSync(CHROME_PATH) ? CHROME_PATH
    : null;
  if (!executablePath) throw new Error('SA login: no Edge or Chrome browser found on this machine');

  const email    = process.env.SA_EMAIL    || '';
  const password = process.env.SA_PASSWORD || '';
  if (!email || !password) throw new Error('SA_EMAIL or SA_PASSWORD env vars not set');

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-blink-features=AutomationControlled'],
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    await page.goto(`${SA_BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#txtLogin', { timeout: 15000 });
    await page.type('#txtLogin', email);
    await page.type('#txtPassword', password);
    await page.click('#loginbtn');
    await page.waitForFunction(
      () => !window.location.href.includes('Login') && window.location.href !== 'https://my.serviceautopilot.com/',
      { timeout: 30000 }
    );
    await new Promise(r => setTimeout(r, 2000));

    const cookies = await page.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    logger.info('SA: login complete');
    return cookieStr;
  } finally {
    await browser.close();
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function apiHeaders(cookieStr, referer) {
  return {
    'Content-Type': 'application/json; charset=UTF-8',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': `${SA_BASE}/${referer || ''}`,
    'Origin': SA_BASE,
    'Cookie': cookieStr,
  };
}

async function saPost(cookieStr, path, body, referer) {
  const res = await fetch(`${SA_BASE}${path}`, {
    method: 'POST',
    headers: apiHeaders(cookieStr, referer),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const isJson = text.trim().startsWith('{') || text.trim().startsWith('[');
  return { status: res.status, data: isJson ? JSON.parse(text) : null, text };
}

function looksLikeLoginPage(res) {
  return res.status === 302 || res.status === 401
    || (res.data === null && typeof res.text === 'string' && res.text.includes('txtLogin'));
}

async function post(path, body, referer) {
  let cookies = await getSession();
  let res = await saPost(cookies, path, body, referer);
  if (looksLikeLoginPage(res)) {
    logger.info('SA: session expired, refreshing');
    cookies = await getSession(true);
    res = await saPost(cookies, path, body, referer);
  }
  return res;
}

// ── Public API ────────────────────────────────────────────────────────────────

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
      Max: limit,
      SortedColumns: [{ FieldName: '', Direction: 2, ColumnEnum: 0 }],
    },
  }, 'Clients.aspx');

  const accounts = (res.data?.d || res.data)?.Accounts || [];
  return accounts.map(a => ({
    clientId: a.ClientID,
    name:     a.ClientName,
    address:  a.Location || a.Address1 || '',
    type:     a.Type || '',
  }));
}

/**
 * Create a new client in SA.
 * Returns { clientId, name }
 */
export async function createClient({ firstName, lastName, address = '', city = '', zip = '', email = '', phone = '' }) {
  const res = await post('/WebServices/TodoEditorWs.asmx/AddClientLead', {
    NewClientLead: {
      FirstName:   firstName,
      LastName:    lastName,
      ClientName:  `${lastName}, ${firstName}`,
      Address:     address,
      City:        city,
      StateID:     EMPTY_GUID,
      Zip:         zip,
      Email:       email,
      Phone1:      phone,
      Phone1Type:  '1',
      Phone2: '', Phone2Type: '1',
      Phone3: '', Phone3Type: '1',
      Phone4: '', Phone4Type: '1',
      IsClient:    true,
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
