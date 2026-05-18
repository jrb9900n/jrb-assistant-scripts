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

let _sessionCookies  = null;
let _sessionExpiry   = 0;
let _loginPromise    = null; // deduplicate concurrent login attempts
let _serviceTypesCache = null; // cached from browser context at login time

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

    // Navigate to V3Estimate.aspx — primes ASP.NET session for QuoteWs endpoints
    // AND allows us to fetch service types via page.evaluate (QuoteWs only works in-browser)
    await page.goto(`${SA_BASE}/V3Estimate.aspx`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    // Fetch + cache service types while we have a browser context
    try {
      const stResult = await page.evaluate(async () => {
        const r = await fetch('/WebServices/QuoteWs.asmx/GetServiceTypesListIncludeEstimateOnly', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: JSON.stringify({ Data: { SearchString: '' } }),
        });
        const t = await r.text();
        return (t.startsWith('{') || t.startsWith('[')) ? JSON.parse(t) : null;
      });
      _serviceTypesCache = Array.isArray(stResult?.d) ? stResult.d : [];
      logger.info('SA: service types cached', { count: _serviceTypesCache.length });
    } catch (e) {
      logger.warn('SA: could not cache service types', { err: e.message });
      _serviceTypesCache = [];
    }

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

// ── Helpers ──────────────────────────────────────────────────────────────────

// BrowserDate null value (sent for empty/unknown dates)
const BROWSER_DATE_NULL = { Month: -1, Day: -1, Year: -1 };

// Default QuoteStageID for new estimates (the browser's "Open" default stage)
const DEFAULT_QUOTE_STAGE = '44410183-e121-4313-93a1-7ea769bfee53';

function toBrowserDate(isoDateOrDate) {
  if (!isoDateOrDate) return BROWSER_DATE_NULL;
  const d = isoDateOrDate instanceof Date ? isoDateOrDate : new Date(isoDateOrDate);
  if (isNaN(d.getTime())) return BROWSER_DATE_NULL;
  return { Month: d.getMonth() + 1, Day: d.getDate(), Year: d.getFullYear() };
}

// Deep-sanitize BrowserDate fields: convert {Month:<=0} to BROWSER_DATE_NULL
function deepSanitizeDates(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(deepSanitizeDates);
  if ('Month' in obj && 'Day' in obj && 'Year' in obj) {
    return (obj.Month <= 0 || obj.Year <= 0) ? BROWSER_DATE_NULL : obj;
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = deepSanitizeDates(v);
  return out;
}

/**
 * Search SA service types by name keyword.
 * Service types are fetched once at login and cached in-process.
 * Returns [{ serviceTypeId, name, fullPath }]
 */
export async function searchServiceTypes({ query, limit = 20 }) {
  // Ensure session is active (and service types are cached)
  await getSession();

  const items = _serviceTypesCache || [];
  const lower = (query || '').toLowerCase();
  return items
    .filter(t => !lower || t.Name?.toLowerCase().includes(lower) || t.FullPath?.toLowerCase().includes(lower))
    .slice(0, limit)
    .map(t => ({
      serviceTypeId: t.ID,
      name:          t.Name,
      fullPath:      t.FullPath || t.Name,
    }));
}

// ── Estimate creation ─────────────────────────────────────────────────────────

// Extract [placeholder] tokens from a string
function extractPlaceholders(text) {
  if (!text) return [];
  const matches = text.match(/\[[^\]]+\]/g) || [];
  return [...new Set(matches)];
}

/**
 * Create a new SA estimate (quote) with line items.
 * lineItems = [{ serviceTypeId, rate, qty, notes? }]
 *   notes: if provided, REPLACES the service type template description.
 *          if omitted/null, the template's EstimateNote is preserved.
 * jobNotes: text written to the "Job Notes" tab of the estimate (e.g. PM follow-up questions)
 * Returns { quoteId, lineItems: [{ lineItemId, serviceTypeId, rate, qty }], placeholders: [...] }
 */
export async function createEstimate({ clientId, lineItems, salesPersonId = EMPTY_GUID, title = '', jobNotes = '' }) {
  // Step 1: Call Query to establish customer context on the server.
  // This is required — without it, Save returns a BrowserDate error.
  await post('/WebServices/QuoteWs.asmx/Query', {
    InputData: { ID: EMPTY_GUID, CustomerID: clientId, IsTemplate: false },
  }, 'V3Estimate.aspx');

  // Step 2: Get default sales rep if none specified
  let resolvedSalesRep = salesPersonId;
  if (salesPersonId === EMPTY_GUID) {
    const srRes = await post('/WebServices/QuoteWs.asmx/GetDefaultSalesRep', {
      InputData: { CustomerID: clientId },
    }, 'V3Estimate.aspx');
    resolvedSalesRep = srRes.data?.d?.ID ?? EMPTY_GUID;
  }

  // Step 3: Get AddService template for each line item
  const builtItems = [];
  const allPlaceholders = [];
  for (const li of lineItems) {
    const tmplRes = await post('/WebServices/QuoteWs.asmx/AddService', {
      InputData: { ServiceTypeID: li.serviceTypeId, QuoteID: EMPTY_GUID },
    }, 'V3Estimate.aspx');

    // AddService returns d.QuoteLineItemModel.Service
    const svc = tmplRes.data?.d?.QuoteLineItemModel?.Service;
    if (!svc) throw new Error(`SA createEstimate: AddService returned no template for ${li.serviceTypeId}`);

    // Deep-sanitize BrowserDate fields from template (converts {Month:0} to BROWSER_DATE_NULL)
    const sanitized = deepSanitizeDates(JSON.parse(JSON.stringify(svc)));

    const qty  = li.qty ?? 1;
    const rate = li.rate ?? svc.Rate ?? 0;
    // Preserve template EstimateNote unless caller explicitly provides notes
    const estimateNote = (li.notes != null) ? li.notes : (svc.EstimateNote ?? '');
    // Collect any [placeholder] tokens so the agent can ask PM for clarification
    extractPlaceholders(estimateNote).forEach(p => allPlaceholders.push(p));

    // Override only the fields we need to change; keep all other template fields intact
    sanitized.StatusEnum  = 1;   // Must be Won for scheduling
    sanitized.Rate        = rate;
    sanitized.Qty         = qty;
    sanitized.Total       = (rate * qty).toFixed(2);
    sanitized.EstimateNote = estimateNote;

    builtItems.push({ Service: sanitized });
  }

  // Step 4: Build valid date range (ValidFrom = today, ValidTo = today + 30 days)
  const today = new Date();
  const expiry = new Date(today); expiry.setDate(expiry.getDate() + 30);
  const validFrom = toBrowserDate(today);
  const validTo   = toBrowserDate(expiry);

  // Step 5: Save with the correct schema (discovered by intercepting browser's own save)
  const saveRes = await post('/WebServices/QuoteWs.asmx/Save', {
    InputData: {
      QuoteID:      EMPTY_GUID,
      IsTemplate:   false,
      SaveAs:       false,
      SaveAsType:   '',
      TemplateType: '1',
      ProjectID:    EMPTY_GUID,
      DetailsTab: {
        ClientLeadID:        clientId,
        Description:         title || `Estimate - ${today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`,
        PONumber:            '',
        WorkOrderNumber:     '',
        NumberOfInstallments: '1',
        ValidFromDate:       validFrom,
        ValidToDate:         validTo,
        SalesRepID:          resolvedSalesRep,
        SourceID:            EMPTY_GUID,
        DocumentID:          EMPTY_GUID,
        StatusEnum:          0,
        QuoteStageID:        DEFAULT_QUOTE_STAGE,
        ReasonID:            EMPTY_GUID,
        ShowDiscountInGrid:  false,
        ServiceLineItems:    builtItems,
        DeletedServiceLineItems: [],
        PackageLineItems:    [],
        KitLineItems:        [],
        DirectCost: { JobCostings: [], DeletedJobCostings: [] },
      },
      NotesTab: { Notes: jobNotes },
    },
  }, 'V3Estimate.aspx');

  const quoteId = saveRes.data?.d?.QuoteID ?? saveRes.data?.d?.ID;
  if (!quoteId || quoteId === EMPTY_GUID) {
    const errors = saveRes.data?.d?.Errors;
    const msg    = saveRes.data?.Message; // server exception message
    throw new Error(`SA createEstimate: Save failed — ${msg || (errors ? JSON.stringify(errors) : saveRes.text?.slice(0, 300))}`);
  }

  // Fetch saved line items — must use ID (not QuoteID) to get results
  const qliRes = await post('/WebServices/QuoteWs.asmx/QueryLineItems', {
    InputData: { ID: quoteId },
  }, 'V3Estimate.aspx');

  const savedItems = qliRes.data?.d?.ServiceLineItems ?? [];
  logger.info('SA: estimate created', { quoteId, itemCount: savedItems.length });
  return {
    quoteId,
    lineItems: savedItems.map(li => ({
      lineItemId:    li.Service?.ID,
      serviceTypeId: li.Service?.ServiceTypeID,
      rate:          li.Service?.Rate,
      qty:           li.Service?.Qty,
    })),
    // [ ] tokens found in line item descriptions — ask PM to fill these in
    placeholders: [...new Set(allPlaceholders)],
  };
}

// ── Job creation ──────────────────────────────────────────────────────────────

/**
 * Create a job from an existing estimate.
 * jobType: 'WaitingList' | 'OneTime' | 'Recurring'
 * resourceIds: array of SA resource GUIDs to assign
 * startDate / completeByDate: ISO date strings (YYYY-MM-DD)
 * For WaitingList: startDate = target start, completeByDate = deadline
 * Returns { scheduledServiceId }
 */
export async function createJob({
  quoteId, lineItemIds, jobType = 'WaitingList',
  clientId, customerJobId,
  resourceIds = [], salesPersonId = EMPTY_GUID,
  startDate, completeByDate,
}) {
  const details = customerJobId
    ? await getClientDetails({ clientId }).catch(() => ({ clientId, customerJobId, currentUserId: EMPTY_GUID }))
    : await getClientDetails({ clientId });

  // Step 1: Initialize job from quote — returns pre-filled template
  const initRes = await post('/WebServices/ServiceEditorWs.asmx/CreateServiceJobFromQuote', {
    InputData: { QuoteID: quoteId, SelectedLineItemIds: lineItemIds, JobType: jobType },
  }, 'V3Estimate.aspx');

  const template = initRes.data?.d;
  if (!template) throw new Error(`SA createJob: CreateServiceJobFromQuote returned no data`);

  const resolvedSalesPerson = salesPersonId !== EMPTY_GUID ? salesPersonId : (template.SalesPersonID ?? EMPTY_GUID);
  const assignedIds = resourceIds.length > 0 ? resourceIds : [];

  const startBD = toBrowserDate(startDate);
  const endBD   = toBrowserDate(completeByDate);

  // Step 2: Build ServiceDetails from template
  const serviceDetails = (template.ServiceDetails || []).map((sd, i) => {
    const det = sd.ServiceDetail;
    const sStart = det.StartDate?.Year > 0 ? det.StartDate : startBD;
    const sEnd   = endBD.Year > 0 ? endBD : (det.EndDate?.Year > 0 ? det.EndDate : sStart);
    return {
      Detail: {
        ID:                    EMPTY_GUID,
        ServiceTypeID:         det.ServiceTypeID,
        AssignedResourceIDs:   assignedIds,
        Quantity:              det.Quantity,
        Rate:                  det.Rate,
        Hours:                 det.Hours ?? 0,
        BillableHours:         det.BillableHours ?? 0,
        NumberOfMen:           det.NumberOfMen ?? 0,
        NumberOfDays:          det.NumberOfDays ?? 0,
        InvoiceNotes:          det.InvoiceNotes ?? '',
        StartDate:             sStart,
        EndDate:               sEnd,
        Include:               false,
        QuoteLineItemID:       det.QuoteLineItemID ?? EMPTY_GUID,
        DiscountID:            EMPTY_GUID,
        DiscountType:          0,
        DiscountAmount:        0,
        DisplayOrder:          i,
        PushMultidayAssignments: false,
      },
      Products: [],
    };
  });

  const firstServiceTypeId = serviceDetails[0]?.Detail?.ServiceTypeID ?? EMPTY_GUID;

  // Step 3: Choose endpoint by job type
  const endpointMap = {
    WaitingList: '/WebServices/ServiceEditorWs.asmx/SaveWaitingListService',
    OneTime:     '/WebServices/ServiceEditorWs.asmx/SaveOneTimeService',
    Recurring:   '/WebServices/ServiceEditorWs.asmx/SaveRecurringService',
  };
  const endpoint = endpointMap[jobType] ?? endpointMap.WaitingList;

  const payload = {
    UserID:                details.currentUserId ?? EMPTY_GUID,
    JobID:                 details.customerJobId,
    CustomerID:            details.clientId ?? clientId,
    CustomerSourceID:      EMPTY_GUID,
    ContractID:            EMPTY_GUID,
    ServiceID:             EMPTY_GUID,
    SalesPersonID:         resolvedSalesPerson,
    CSRID:                 EMPTY_GUID,
    InvoiceFreq:           1,
    InvoiceAsWorkOrder:    false,
    PaymentType:           1,
    CallAhead:             false,
    ArrivalWindow:         0,
    DontApplyMinimumAmount: false,
    UseAnnualPricing:      false,
    PONumber:              '',
    DateSold:              BROWSER_DATE_NULL,
    WorkOrderNumber:       '',
    AreaTreatedIDs:        [],
    GroupJobs:             false,
    GroupName:             '',
    MaximumManHoursPerDay: 0,
    CommissionType:        0,
    InternalNote:          '',
    ShowInternalNoteRow:   false,
    AssignedResourceIDs:   assignedIds,
    ServiceDetails:        serviceDetails,
    CustomPackageID:       EMPTY_GUID,
    IsRenewable:           false,
    RenewStartDate:        BROWSER_DATE_NULL,
    RenewEndDate:          BROWSER_DATE_NULL,
    RenewServices:         false,
    PushMultidayAssignments: false,
    ServiceTypeID:         firstServiceTypeId,
  };

  // OneTime jobs also need IsComplete + QuoteID
  if (jobType === 'OneTime') {
    payload.IsComplete = false;
    payload.QuoteID    = quoteId;
  }

  // ServiceEditorWs uses 'Input' as the parameter name (not 'InputData')
  const saveRes = await post(endpoint, { Input: payload }, 'V3Estimate.aspx');

  const savedId = saveRes.data?.d?.ScheduledServiceID ?? saveRes.data?.d?.ID;
  if (!savedId || savedId === EMPTY_GUID) {
    const errors = saveRes.data?.d?.Errors;
    throw new Error(`SA createJob: ${endpoint.split('/').pop()} failed — ${errors ? JSON.stringify(errors) : saveRes.text?.slice(0, 300)}`);
  }

  logger.info('SA: job created', { scheduledServiceId: savedId, jobType, quoteId });
  return { scheduledServiceId: savedId, jobType, quoteId };
}

// ── Ticket creation ───────────────────────────────────────────────────────────

/**
 * Add a support ticket (task/follow-up) to a client record.
 * Uses the CRM ticket endpoint — ticket appears in client timeline and Tickets HUD.
 * Returns { ticketId, clientId }
 */
export async function addTicket({ clientId, subject, notes = '', dueDate = '' }) {
  const details = await getClientDetails({ clientId });

  const res = await post('/CRMBFF/TicketEdit/TicketEdit_Ticket_PostAsync', {
    Ticket: {
      CategoryID:   null,
      TicketStatus: 0,
      EntityID:     details.customerJobId,
      EntityType:   'Account',
      DueDate:      dueDate,
      TicketDetail: {
        TicketEventType: 4, // Task/Ticket (1=Note, 2=Email, 3=Call, 4=Task)
        Subject:         subject,
        Body:            notes,
        CreatedByID:     details.currentUserId,
        CreatedByType:   details.currentUserType,
      },
    },
  }, 'ClientView.aspx');

  const ticketId = res.data?.ID;
  if (!ticketId || ticketId === EMPTY_GUID) {
    // TicketEventType 4 may not exist — fall back to generic note type
    const res2 = await post('/CRMBFF/TicketEdit/TicketEdit_Ticket_PostAsync', {
      Ticket: {
        CategoryID:   null,
        TicketStatus: 0,
        EntityID:     details.customerJobId,
        EntityType:   'Account',
        DueDate:      dueDate,
        TicketDetail: {
          TicketEventType: 1,
          Subject:         subject,
          Body:            notes,
          CreatedByID:     details.currentUserId,
          CreatedByType:   details.currentUserType,
        },
      },
    }, 'ClientView.aspx');

    const ticketId2 = res2.data?.ID;
    if (!ticketId2 || ticketId2 === EMPTY_GUID) {
      const errors = res2.data?.Errors;
      throw new Error(`SA addTicket failed: ${errors?.length ? errors.join(', ') : res2.text?.slice(0, 300)}`);
    }
    logger.info('SA: ticket created (type=Note fallback)', { ticketId: ticketId2, clientId });
    return { ticketId: ticketId2, clientId };
  }

  logger.info('SA: ticket created', { ticketId, clientId });
  return { ticketId, clientId };
}
