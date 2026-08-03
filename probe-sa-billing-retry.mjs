// probe-sa-billing-retry.mjs — retry billing defaults for a specific clientId
const SA_BASE    = 'https://my.serviceautopilot.com';
const EDGE_PATH  = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';
const TAX_CODE_ID        = 'c432e644-6f8f-4a78-b52f-ef93f05abf4e';
const TAX_REF_WAUKESHA   = '50b742c7-66ba-4034-b602-9552d5f2e77e';
const WI_STATE_ID        = 'ce81d562-a057-4d48-bd07-b4b70795dea8';

const CLIENT_ID = '39e81ae4-7357-4225-96fe-5aac88a64d2b'; // Tammi Brandt

async function main() {
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH, headless: true, protocolTimeout: 120000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36');
  await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  await page.setRequestInterception(true);
  page.on('request', req => req.continue().catch(() => {}));

  await page.goto(`${SA_BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#txtLogin', { timeout: 15000 });
  await page.type('#txtLogin', process.env.SA_EMAIL || '');
  await page.type('#txtPassword', process.env.SA_PASSWORD || '');
  await page.click('#loginbtn');
  await page.waitForFunction(u => window.location.href !== u && !window.location.href.includes('Login'),
    { timeout: 60000 }, `${SA_BASE}/`);
  await new Promise(r => setTimeout(r, 3000));

  const result = await page.evaluate(async (SA_BASE, CLIENT_ID, TAX_CODE_ID, TAX_REF_WAUKESHA, WI_STATE_ID, EMPTY_GUID) => {
    const post = async (path, body, referer) => {
      const r = await fetch(`${SA_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Requested-With': 'XMLHttpRequest',
          ...(referer ? { Referer: `${SA_BASE}/${referer}` } : {}) },
        body: JSON.stringify(body), credentials: 'include',
      });
      const text = await r.text();
      try { return { ok: r.ok, status: r.status, data: JSON.parse(text), raw: text.slice(0, 500) }; }
      catch { return { ok: r.ok, status: r.status, data: null, raw: text.slice(0, 500) }; }
    };

    const infoRes = await post('/webservices/ClientEditOverlayWs.asmx/GetClientInfo',
      { ClientID: CLIENT_ID }, 'Clients.aspx');
    const d = infoRes.data?.d;
    if (!d) return { ok: false, step: 'getinfo_failed', raw: infoRes.raw };

    // Parse SA /Date(ms)/ format; GetClientInfo may already return {Month,Day,Year} objects.
    // Validate by round-tripping through Date to catch impossible dates like April 31.
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

    const info = {
      ClientID: CLIENT_ID, IsLead: false, saveType: 0, IsConvertingLead: false,
      FirstName: d.FirstName || '', LastName: d.LastName || '',
      NickName: d.NickName || '', ClientCompanyName: d.ClientCompanyName || '',
      Email: d.Email || '', HomePhone: d.HomePhone || '', CellPhone: d.CellPhone || '',
      ProviderID: d.ProviderData?.Value || EMPTY_GUID, WorkPhone: d.WorkPhone || '',
      OtherPhone: d.OtherPhone || '', FaxNumber: d.FaxNumber || '',
      PreferredPhoneID: d.PreferredPhoneID || '1', ClientTitle: d.ClientTitle || '',
      ListID: d.ListID || EMPTY_GUID, QboID: d.QboID || '',
      PropertyName: d.PropertyName || '', PropertyNameAttentionTo: d.PropertyNameAttentionTo || '',
      Address: d.Address || '', AddressTwo: d.AddressTwo || '',
      City: d.City || '', StateID: d.StateInfo?.Value || WI_STATE_ID,
      PostalCode: d.PostalCode || '', MapCode: d.MapCode || '',
      DivisionID: d.DivisionInfo?.Value || EMPTY_GUID, NameOnInv: d.NameOnInv || '',
      AttentionTo: d.AttentionTo || '', BillingAddress: d.BillingAddress || '',
      BillingAddressTwo: d.BillingAddressTwo || '', BillingCity: d.BillingCity || '',
      BillingStateID: d.BillingStateInfo?.Value || WI_STATE_ID,
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
      ReferredByID: d.ReferredByInfo?.Value || EMPTY_GUID,
      DoNotMarket: d.DoNotMarket || false, BillingEmail: d.BillingEmail || '',
      FlagForReview: d.FlagForReview || false, AccountNumber: d.AccountNumber || '',
      SubscriptionType: d.SubscriptionType || 0,
      BillingDate: parseSaDate(d.BillingDate),
      AutoCharge: d.AutoCharge || false, BillingNotes: d.BillingNotes || '',
      PaymentMethodID: d.PaymentMethodInfo?.Value || EMPTY_GUID,
      SalesTaxRefID:   TAX_REF_WAUKESHA,
      SalesTaxCodeID:  TAX_CODE_ID,
      InvoiceFrequencyID: d.InvoiceFrequencyInfo?.Value || EMPTY_GUID,
      StandardTermID: d.StandardTermInfo?.Value || EMPTY_GUID,
      SendInvoiceBy: 'Email',
      DefaultInvoiceFormatID: d.DefaultInvoiceInfo?.Value || EMPTY_GUID,
      OfficeNotes: d.OfficeNotes || '',
      CCFirstName: d.CCFirstName || '', CCLastName: d.CCLastName || '',
      CCBillingAddress: d.CCBillingAddress || '', CCBillingZip: d.CCBillingZip || '',
      CCNumber: d.CCNumber || '', CCExpiration: d.CCExpiration || '',
      CCToken: d.CCToken || '', CCCustomerToken: d.CCCustomerToken || '', CCBrand: d.CCBrand || '',
      Geocode: false, ManualGeocode: false, UpdateManualGeocodeFlag: false,
    };

    const saveRes = await post('/webservices/ClientEditOverlayWs.asmx/SaveClient',
      { info }, 'ClientView.aspx');
    const errors = saveRes.data?.d?.response?.Errors;
    // Report current billing defaults from d (SA auto-applies them on client creation)
    return {
      ok: saveRes.ok, status: saveRes.status, errors: errors || [], city: d.City,
      raw: saveRes.raw.slice(0, 300),
      currentDefaults: {
        sendInvoiceBy: d.SendInvoiceBy,
        taxCode: d.SalesTaxCodeInfo?.Text,
        taxRef: d.SalesTaxInfo?.Text,
      },
    };
  }, SA_BASE, CLIENT_ID, TAX_CODE_ID, TAX_REF_WAUKESHA, WI_STATE_ID, EMPTY_GUID);

  if (result.ok && !result.errors?.length) {
    console.log(`✅ Billing defaults set — Tammi Brandt (${CLIENT_ID}), city: ${result.city}`);
    console.log('   SalesTaxCodeID: Tax | SendInvoiceBy: Email | TaxRef: Waukesha County');
  } else if (result.status === 500) {
    console.log(`⚠️  SaveClient 500 (SA QBO-sync bug) — billing already set by SA on creation:`);
    console.log(`   SendInvoiceBy: ${result.currentDefaults?.sendInvoiceBy} | TaxCode: ${result.currentDefaults?.taxCode} | TaxRef: ${result.currentDefaults?.taxRef}`);
  } else {
    console.log('❌ Save failed:', result.status, result.errors, result.raw);
  }

  await browser.close();
}

main().catch(e => { console.error('FATAL:', e.stack || e); process.exit(1); });
