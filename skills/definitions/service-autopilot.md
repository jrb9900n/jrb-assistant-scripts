---
name: service-autopilot
description: >
  Use this skill whenever the user wants to download, sync, or work with data
  from Service Autopilot (SA). Covers both the NEW account (active, primary)
  and the OLD/pre-acquisition account. Triggers include: "sync SA data",
  "pull invoices from Service Autopilot", "get SA payments", "download SA
  records", "update Supabase from SA", "re-sync old SA account", "get SA
  estimates", "scrape SA estimates", "get quote data from SA", "extract line
  items", "sync tickets", "waiting list", "audit trail", or any task involving
  the .asmx endpoints or Playwright-based SA scripts. Always use this skill
  when the user mentions Service Autopilot in the context of data access,
  syncing, or scripting — even if they just say "SA". Also use for BTA
  Reporting, weekly-sync, estimate-scraper, ticket-scraper, or any scripts in
  the AuditMatchingEngine or BTA Reporting repos that touch SA data.
---

# Service Autopilot Data Skill

## Overview

Service Autopilot (SA) does not have a public REST API. Data is accessed by
logging in via Playwright (headless Chromium), establishing a browser session,
and calling internal `.asmx` (SOAP-style JSON) or BFF endpoints that the web
app itself uses. All sync scripts live either in the `AuditMatchingEngine`
GitHub repo under `sync/` or in the `BTA Reporting` folder under `scripts/`.

---

## Accounts

### NEW Account (Primary / Active)
| Field | Value |
|---|---|
| URL | `https://my.serviceautopilot.com` |
| Email env var | `SA_EMAIL` |
| Password env var | `SA_PASSWORD` |
| Supabase tables | `sa_invoices`, `sa_payments`, `sa_payment_applications`, `sa_estimates_2026`, `sa_waiting_list` |
| Date range used | 1/1/2015 → today (full history) |
| Notes | Current operating account post-acquisition |

### OLD Account (Pre-Acquisition)
| Field | Value |
|---|---|
| URL | `https://my.serviceautopilot.com` (same domain) |
| Email env var | `SA_EMAIL_OLD` |
| Password env var | `SA_PASSWORD_OLD` |
| Supabase tables | `sa_invoices_old`, `sa_payments_old`, `sa_payment_applications_old` |
| Date range used | 1/1/2022 → today (overlap + pre-acquisition period) |
| Notes | Kept strictly separate; never comingled with new account data |

Credentials are stored in `.env` in the project root. Do NOT hardcode
credentials in scripts or log them.

---

## Authentication Pattern

SA uses ASP.NET Forms Authentication (`.ASPXAUTH` cookie) plus Incapsula WAF
cookies. Direct HTTP calls are blocked — all requests must originate from
within an authenticated Playwright browser context.

**Login selectors (confirmed working):**
```javascript
async function login(page, email, password) {
  await page.goto('https://my.serviceautopilot.com/', {
    waitUntil: 'domcontentloaded',  // NOT 'networkidle' — SA never fully idles
    timeout: 60000,
  });
  await page.waitForSelector('#txtLogin', { timeout: 15000 });
  await page.fill('#txtLogin', email);       // NOT input[type="email"]
  await page.fill('#txtPassword', password); // NOT input[type="password"]
  await page.click('#loginbtn');             // NOT button[type="submit"]
  await page.waitForNavigation({
    waitUntil: 'domcontentloaded', // CRITICAL: use domcontentloaded, not networkidle
    timeout: 30000,
  });
}
```

> ⚠️ **Common mistake:** Using `waitUntil: 'networkidle'` causes timeouts
> because SA's post-login page never fully stops requesting resources.
> Always use `'domcontentloaded'` for both the initial navigation and
> post-login wait.

**Browser fingerprint required to bypass Incapsula WAF:**
```javascript
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 800 },
});
const page = await context.newPage();
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
```

**Session warmup:** After login, navigate to a warmup page before calling
estimate or invoice endpoints:
```javascript
// For estimates (NEW account):
await page.goto(`${SA_BASE}/QuoteList.aspx`, { waitUntil: 'domcontentloaded' });

// For invoices / general warmup:
// Call AlertsWs or PaymentListWs first (see endpoints below)
```

**Session expiry mid-sync:** On large syncs SA will expire the session.
Detect HTML responses and re-login:
```javascript
if (result?.__html_response || typeof result === 'string') {
  await login(page);
  await delay(2000);
  // retry the request
}
```

**API call pattern** (used for all endpoints after login):
```javascript
async function _post(page, path, body) {
  const response = await page.evaluate(
    async ({ url, payload }) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return { __html_response: true, body: text.slice(0, 200) };
      }
    },
    { url: `https://my.serviceautopilot.com${path}`, payload: body }
  );
  return response?.d ?? response;
}
```

> All SA responses are wrapped in a `d` property (standard ASP.NET
> ScriptManager pattern): `{ "d": { ... } }`. Always unwrap with `?.d`.

---

## Confirmed Working Endpoints

### Invoices (NEW account)
```
POST /AccountingBFF/InvoiceList/V2InvoiceList_Query
{ "startDate": "1/1/2015", "endDate": "4/25/2026", "pageSize": 100, "pageNumber": 1 }
```
~8,355 records as of April 2026.

**Key fields:** `ID`, `InvoiceNumber`, `QboID`, `Status` (Open/Paid/Past Due),
`InvoiceTotal`, `InvoiceBalance`, `AccountBalance`, `Client`, `CustomerID`,
`Address`, `Date`, `InvoiceDueDate`, `DaysPastDue`, `IsPastDue`,
`PaymentType`, `Frequency`, `PrepaymentBalance`, `CreditBalance`,
`Deleted`, `ContractID`, `QBStatus`

### Payments (NEW account)
```
POST /WebServices/PaymentListWs.asmx/Query
{ "startDate": "1/1/2015", "endDate": "4/25/2026", "pageSize": 100, "pageNumber": 1 }
```
~6,090 records as of April 2026.

**Key fields:** `ID`, `CustomerID`, `PaymentDate`, `PaymentAmount`, `Client`,
`Address`, `UnusedAmount`, `RefundedAmount`, `Reference`, `Type`, `Notes`,
`Deleted`, `Unrestorable`

> Payments do NOT include `InvoiceID`. Matching to invoices is done via
> the payment applications endpoint below.

### Payment Applications (invoice-to-payment linking)
```
POST /WebServices/PaymentWs.asmx/GetPaymentApplications
{ "paymentId": "<SA payment GUID>" }
```
Returns `d.Invoices[]`. Called per-payment (not bulk) — iterate all payments.

### Estimates / Quotes
```
POST /AccountingBFF/EstimateList/V2EstimateList_Query
{
  "startRow": 1,
  "pageSize": 400,
  "stageName": "",
  "sortField": "QuoteDate",
  "sortDirection": "desc"
}
```
Returns up to 400 estimates per page. Filter by year client-side using
`QuoteDate.Year` field. SA date objects use a custom format:
```javascript
// SA QuoteDate format: { Year: 2026, Month: 4, Day: 15, IsValid: true }
function saDateToISO(d) {
  if (!d || !d.IsValid) return null;
  return `${d.Year}-${String(d.Month).padStart(2,'0')}-${String(d.Day).padStart(2,'0')}`;
}
```

**Pagination strategy for estimates:**
```javascript
async function getAllEstimates(year = 2026) {
  const PAGE_SIZE = 400;
  let startRow = 1, allEstimates = [], keepGoing = true;
  const seen = new Set();

  while (keepGoing) {
    const page = await getEstimatePage(startRow, PAGE_SIZE);
    if (page.length === 0) break;

    for (const e of page) {
      if (e.QuoteDate?.Year === year && !seen.has(e.ID)) {
        seen.add(e.ID);
        allEstimates.push(e);
      }
    }

    const lastYear = page[page.length - 1]?.QuoteDate?.Year;
    if (page.length < PAGE_SIZE || (lastYear && lastYear < year)) {
      keepGoing = false;
    } else {
      startRow += PAGE_SIZE;
      await delay(300);
    }
  }
  return allEstimates;
}
```

**Key estimate fields:** `ID`, `Number`, `ClientID`, `ClientName`,
`ClientAddress`, `QuoteStageType`, `QuoteStageName`, `SalesPersonName`,
`EstimateDocumentName`, `EstimatedValue`, `EstimatedGrossProfit`, `Margin`,
`QuoteDate`

### Estimate Line Items
```
POST /CRMBFF/Quote/GetQuoteLineItems
{ "request": { "ID": "<estimate GUID>", "CustomerID": "<client GUID>", "IsTemplate": false } }
```
Returns `Items[]`. Each item has a `Service` sub-object.

**Key line item fields:**
- `Service.ID` — line item GUID
- `Service.ServiceTypeName` — service description (use for division categorization)
- `Service.Total` — dollar amount
- `Service.Qty`, `Service.Rate`, `Service.Visits`
- `Service.StatusName` — `"Quote"`, `"Won"`, `"Scheduled"`, `"Closed"`, etc.
- `Service.StatusEnum` — numeric status
- `Service.Include` — boolean

> **$ Booked = sum of line items where StatusName === "Won"** (not the full
> estimate total). Individual line items can have different statuses.

### Estimate Audit Trail (dates: created, sent, won)
```
POST /WebServices/AuditTrailsWs.asmx/GetAuditTrailData
{ "InputData": { "EntityID": "<estimate GUID>", "Type": "Quote" } }
```
Returns `OutputRecords[]`. Parse `Note` field to extract key dates:
```javascript
function parseAuditTrail(records) {
  const result = { createdDate: null, sentDate: null, wonDate: null, lineItemsWon: [] };
  for (const r of records) {
    const note = r.Note || '';
    const ts = parseNetDate(r.DateCreated);
    if (note.includes('Estimate was created'))                                result.createdDate = ts;
    else if (note.includes('status changed from Draft to Sent'))              result.sentDate = ts;
    else if (note.includes('estimate status changed from Sent to Won'))       result.wonDate = ts;
    else if (note.includes('line item') && note.includes('status was changed from Quote to Won')) {
      const match = note.match(/\(([^)]+)\)/);
      result.lineItemsWon.push({ serviceName: match?.[1] || 'Unknown', wonDate: ts });
    }
  }
  return result;
}

// SA .NET date format: /Date(1776780203813)/
function parseNetDate(val) {
  if (!val) return null;
  const match = String(val).match(/\/Date\((\d+)\)\//);
  if (match) return new Date(parseInt(match[1], 10));
  const d = new Date(val);
  return isNaN(d) ? null : d;
}
```

### CRM Tickets / Leads
```
POST /WebServices/CRMTicketWs.asmx/Query   (or /CRMBFF/CRM/TicketList)
{ "startDate": "1/1/2026", "endDate": "4/25/2026", "pageSize": 400, "startRow": 1 }
```
Returns ticket objects with client, status, description, and service info.

### Scheduled Work / Jobs
```
POST /WebServices/ScheduledWorkWs.asmx/Query
{
  "StartDate": "2026-04-01",
  "EndDate": "2026-04-30",
  "Divisions": [],
  "ServiceIDs": [],
  "ScheduleStatus": "0"
}
```
Returns `d.ScheduledWork[]`. Each job has `TotalAmount`, `StartDate`,
`ScheduledDate`, `ID`, `HasNotes`, `NoteCount`.

### Waiting List
The waiting list is accessed via the SA web UI at `/WaitingList.aspx`. Items
are extracted via DOM or a BFF endpoint. Each item has: client name, address,
service code, amount, date added, target date, sales rep, notes, status.

### Session Warmup / Health Check
```
POST /WebServices/AlertsWs.asmx/GetUserAlertCount
```
Lightweight call to confirm session is alive. Use before cold-starting
invoice or estimate endpoints.

---

## Division / Service Categorization

Map `ServiceTypeName` (from line items) or description text to the four
business divisions:

```javascript
function categorizeService(name = '') {
  const desc = name.toLowerCase();
  if (desc.includes('concrete'))                                          return 'Concrete Construction';
  if (desc.match(/grading|retaining wall|hardscap|landscap|landscape/))  return 'Landscape Construction';
  if (desc.match(/sealcoat|asphalt|paving|patching|striping/))           return 'Commercial Asphalt Maintenance';
  return 'Everything Else';
}
```

---

## Supabase Schema

### Invoices / Payments / Payment Applications (existing)
```sql
CREATE TABLE sa_invoices (
  id bigserial PRIMARY KEY, sa_id TEXT UNIQUE NOT NULL,
  invoice_number INTEGER, status TEXT, date TEXT, due_date TEXT,
  client TEXT, customer_id TEXT, address TEXT, frequency TEXT,
  payment_type TEXT, prepayment_balance NUMERIC, credit_balance NUMERIC,
  invoice_balance NUMERIC, invoice_total NUMERIC, account_balance NUMERIC,
  days_past_due INTEGER, is_past_due BOOLEAN, qb_status TEXT,
  qbo_id TEXT, contract_id TEXT, deleted BOOLEAN,
  raw_data JSONB, synced_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE sa_payments (
  id bigserial PRIMARY KEY, sa_id TEXT UNIQUE NOT NULL,
  amount NUMERIC, date TEXT, client TEXT, customer_id TEXT,
  payment_type TEXT, reference TEXT, qb_status TEXT, qbo_id TEXT,
  raw_data JSONB, synced_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE sa_payment_applications (
  id bigserial PRIMARY KEY, payment_sa_id TEXT NOT NULL,
  invoice_sa_id TEXT NOT NULL, amount NUMERIC, raw_data JSONB,
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(payment_sa_id, invoice_sa_id)
);
-- OLD account: mirror with _old suffix
```

### Estimates (BTA Reporting)
```sql
CREATE TABLE sa_estimates_2026 (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id         text UNIQUE,
  estimate_number     text,
  client_id           text,
  client_name         text,
  client_address      text,
  stage               text,
  stage_name          text,
  salesperson         text,
  template_name       text,
  estimated_value     numeric,
  gross_profit        numeric,
  margin              numeric,
  quote_date          date,
  created_date        timestamptz,
  sent_date           timestamptz,
  won_date            timestamptz,
  line_items          jsonb,
  landscape_quoted    numeric,
  landscape_won       numeric,
  asphalt_quoted      numeric,
  asphalt_won         numeric,
  concrete_quoted     numeric,
  concrete_won        numeric,
  other_quoted        numeric,
  other_won           numeric,
  extracted_at        timestamptz DEFAULT now()
);
```

### Waiting List (BTA Reporting)
```sql
CREATE TABLE sa_waiting_list (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          text UNIQUE,
  client_id       text, client_name text, address text,
  city text, state text, zip text,
  service_code    text, amount numeric,
  date_added      date, target_date date,
  sales_rep       text, notes text, status text,
  service_timing  text, category text, categorized_by text,
  extracted_at    timestamptz DEFAULT now()
);
```

---

## Scripts Reference

### AuditMatchingEngine (`sync/`)
| Script | Account | Writes to |
|---|---|---|
| `sa-invoice-sync.js` | NEW | `sa_invoices` |
| `sa-payment-sync.js` | NEW | `sa_payments` |
| `sa-payment-applications-sync.js` | NEW | `sa_payment_applications` |
| `sa-invoice-sync-old.js` | OLD | `sa_invoices_old` |
| `sa-payment-sync-old.js` | OLD | `sa_payments_old` |
| `sa-payment-applications-sync-old.js` | OLD | `sa_payment_applications_old` |

```json
// package.json run scripts
"sync:invoices":         "node sync/sa-invoice-sync.js",
"sync:payments":         "node sync/sa-payment-sync.js",
"sync:applications":     "node sync/sa-payment-applications-sync.js",
"sync:sa":               "npm run sync:invoices && npm run sync:payments && npm run sync:applications",
"sync:invoices:old":     "node sync/sa-invoice-sync-old.js",
"sync:payments:old":     "node sync/sa-payment-sync-old.js",
"sync:applications:old": "node sync/sa-payment-applications-sync-old.js",
"sync:sa:old":           "npm run sync:invoices:old && npm run sync:payments:old && npm run sync:applications:old"
```

### BTA Reporting (`scripts/`)
| Script | Writes to |
|---|---|
| `sa-api-client.js` | (shared client, no direct DB write) |
| `estimate-scraper.js` | `sa_estimates_2026` + `Output/sa-estimates-YYYY-MM-DD.json` |
| `ticket-scraper.js` | `sa_tickets_2026` + `Output/sa-tickets-YYYY-MM-DD.json` |
| `waiting-list-scraper.js` | `sa_waiting_list` + `Output/sa-waiting-list-YYYY-MM-DD.json` |
| `lead-matcher.js` | reads estimate JSON, outputs weekly lead matches |
| `weekly-sync.js` | orchestrates all scrapers in sequence |

```json
// package.json run scripts (BTA Reporting)
"sync:estimates":  "node scripts/estimate-scraper.js",
"sync:tickets":    "node scripts/ticket-scraper.js",
"sync:waiting":    "node scripts/waiting-list-scraper.js",
"sync:all":        "node scripts/weekly-sync.js"
```

**CLI flags for `estimate-scraper.js`:**
```
node estimate-scraper.js                  # 2026, full run
node estimate-scraper.js --year=2025      # override year
node estimate-scraper.js --no-audit       # skip audit trail (faster)
node estimate-scraper.js --json-only      # skip Supabase, write JSON only
```

**Output directory:** `Output/` (relative to script location) — NOT the
parent directory. Always use `path.join(__dirname, 'Output')`.

---

## Script Template (all sync scripts follow this pattern)

```javascript
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SA_BASE     = 'https://my.serviceautopilot.com';
const BATCH_SIZE  = 100;
const DELAY_MS    = 300;   // be polite; Incapsula blocks aggressive requests
const MAX_RETRIES = 3;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // or SUPABASE_KEY for BTA scripts
);

// 1. Launch browser with correct UA + fingerprint (see Authentication)
// 2. Login using #txtLogin / #txtPassword / #loginbtn selectors
// 3. Warmup (navigate to relevant list page OR call AlertsWs)
// 4. Paginate through all records (check for session expiry each response)
// 5. Upsert to Supabase in batches (onConflict: 'sa_id' or unique field)
// 6. Save JSON backup to Output/
// 7. Log progress every 100 records
// 8. Close browser

// Upsert pattern (avoids duplicates on re-runs):
await supabase.from('sa_invoices').upsert(records, { onConflict: 'sa_id' });
```

---

## Known Issues & Workarounds

| Issue | Symptom | Fix |
|---|---|---|
| `waitUntil: 'networkidle'` timeout | Login hangs after clicking submit | Use `'domcontentloaded'` everywhere |
| Wrong login selectors | "Element not found" on `input[type=email]` | Use `#txtLogin`, `#txtPassword`, `#loginbtn` |
| `/Invoices.aspx` errors on OLD account | Error when navigating to that page | Skip the page; use payment endpoint for warmup instead |
| Session expiry mid-sync | Response is HTML instead of JSON | Check `__html_response`, re-login, retry |
| Cold-start on invoice/estimate endpoints | Empty results or 500 error on first call | Navigate to list page (e.g. QuoteList.aspx) before calling endpoint |
| Incapsula WAF bot detection | 403 or CAPTCHA | Use correct UA string; `headless: true` with `AutomationControlled` disabled; ≥300ms delays |
| Estimate pagination misses records | Year-filtered count doesn't match SA UI | Use `seen` Set to deduplicate; add a mop-up unfiltered pass at end |
| Output files in wrong folder | Files saved one level up from project | Use `path.join(__dirname, 'Output')` not `path.join(__dirname, '..', ...)` |
| `sa_waiting_list` Supabase error | "table not found in schema cache" | Run the CREATE TABLE SQL above; table must exist before first insert |
| Lead matcher can't find JSON | "No estimate JSON found" | Check that `estimate-scraper.js` ran first; fix path to use `Output/` subdir |

---

## Data Relationships for Matching Engine

```
sa_invoices.qbo_id       ←→  qb_invoices.qb_id           (direct QB link)
sa_invoices.invoice_number ←→ qb_invoices.invoice_number  (fallback match)
sa_payments.sa_id        ←→  sa_payment_applications.payment_sa_id
sa_payment_applications.invoice_sa_id ←→ sa_invoices.sa_id

sa_estimates_2026.client_id ←→ sa_invoices.customer_id    (estimate→invoice)
```

When a payment exists in the new SA but links to an invoice only found in
`sa_invoices_old`, flag it as a **pre-acquisition cross-account payment**.

---

## .env Variables Required

```
# Service Autopilot - NEW account
SA_EMAIL=michael@jrboehlke.com
SA_PASSWORD=<current password>

# Service Autopilot - OLD account
SA_EMAIL_OLD=oldmichael@jrboehlke.com
SA_PASSWORD_OLD=<current password>

# Supabase (AuditMatchingEngine uses SUPABASE_SERVICE_KEY)
SUPABASE_URL=https://mzywmgesulyalevtzudw.supabase.co
SUPABASE_SERVICE_KEY=<service role key>
SUPABASE_KEY=<service role key>   # alias used by BTA Reporting scripts
```

---

## Quick Reference: Adding a New Data Type

1. Log in to SA manually; open DevTools Network tab; filter by `.asmx` or
   `/BFF/`. Navigate to the relevant page and capture the POST request.
2. Note the request payload structure and all response field names.
3. Determine if the endpoint paginates (most do) or is single-record.
4. Add a Supabase table (mirror with `_old` suffix if needed for old account).
5. Copy the closest existing sync script and adapt endpoint + field mapping.
6. Add npm run scripts for both accounts if applicable.
7. Test with a small page limit (`pageSize: 5`) before a full sync.
8. Add the warmup step (AlertsWs or relevant list page) before the endpoint.
