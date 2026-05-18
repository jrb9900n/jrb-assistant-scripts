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
 * Add a ticket (task/follow-up) to an SA client.
 * ticketType: 'Task' | 'Call' | 'Email' | 'Note' (default 'Task')
 * Returns { ticketId, clientId }
 */
export async function addTicket({ clientId, subject, body = '', ticketType = 'Task', dueDate }) {
  const details = await getClientDetails({ clientId });

  const typeMap = { Task: 2, Call: 3, Email: 4, Note: 1 };
  const ticketEventType = typeMap[ticketType] ?? 2;

  const res = await post('/CRMBFF/TicketEdit/TicketEdit_Ticket_PostAsync', {
    Ticket: {
      CategoryID:   null,
      TicketStatus: 0,
      EntityID:     details.customerJobId,
      EntityType:   'Account',
      DueDate:      dueDate ? new Date(dueDate).toISOString() : '',
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
