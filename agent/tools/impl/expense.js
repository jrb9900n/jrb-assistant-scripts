// tools/impl/expense.js — Credit card expense capture system
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';
import { getPurchase, uploadReceiptToQbo } from './quickbooks.js';
import { sendEmail } from './m365.js';
import { sendProactiveMessage } from '../../teams/notify.js';

const supabase = createClient(
  process.env.FLEETOPS_SUPABASE_URL,
  process.env.FLEETOPS_SUPABASE_SERVICE_KEY
);

const PORTAL_BASE = 'https://fieldops.jrboehlke.com';

// Categories that trigger Section 3 (asset required)
const ASSET_CATEGORIES = new Set([
  'Repair service for a specific vehicle or trailer',
  'Repair service for a specific tool or equipment',
  'Purchase of a tool or equipment',
  'Purchase of supplies or parts for a specific vehicle or trailer',
  'Purchase of supplies or parts for a specific tool or equipment',
  'Purchase of consumables for vehicles and equipment (grease, wiper fluid) excluding fuel',
  'Purchase of fuel',
]);

// Categories that trigger Section 2 (job number)
const JOB_CATEGORIES = new Set([
  'Purchase of material for a job',
  'Equipment rental for a job',
]);

// ── QBO Webhook ────────────────────────────────────────────────

export async function handleQboWebhook(rawBody, signature) {
  // Verify HMAC-SHA256 signature from QBO
  const verifierToken = process.env.QB_WEBHOOK_VERIFIER_TOKEN;
  if (verifierToken) {
    const expected = crypto
      .createHmac('sha256', verifierToken)
      .update(rawBody)
      .digest('base64');
    if (signature !== expected) {
      logger.warn('QBO webhook signature mismatch — ignoring');
      return;
    }
  }

  let payload;
  try { payload = JSON.parse(rawBody); } catch { return; }

  const events = payload?.eventNotifications ?? [];
  for (const event of events) {
    const entities = event?.dataChangeEvent?.entities ?? [];
    for (const entity of entities) {
      if (entity.name === 'Purchase' && entity.operation === 'Create') {
        processNewPurchase(entity.id).catch(err =>
          logger.error('Failed to process QBO purchase', { id: entity.id, err: err.message })
        );
      }
    }
  }
}

async function processNewPurchase(purchaseId) {
  // Check for duplicate before fetching from QBO
  const { data: existing } = await supabase
    .from('expense_reports')
    .select('id')
    .eq('qbo_transaction_id', purchaseId)
    .maybeSingle();
  if (existing) return;

  const purchase = await getPurchase(purchaseId);
  if (!purchase) return;

  const { amount, vendor, date, cardLastFour } = parsePurchase(purchase);
  if (!cardLastFour) {
    logger.warn('QBO purchase has no card last four — skipping', { purchaseId });
    return;
  }

  const { data: card } = await supabase
    .from('credit_cards')
    .select('*')
    .eq('last_four', cardLastFour)
    .eq('is_active', true)
    .maybeSingle();

  if (!card) {
    logger.warn('No active cardholder found for last four', { cardLastFour });
    return;
  }

  // Reconcile with a Chase-alert stub created before QBO settled
  const dayBefore = new Date(`${date}T12:00:00`); dayBefore.setDate(dayBefore.getDate() - 1);
  const dayAfter  = new Date(`${date}T12:00:00`); dayAfter.setDate(dayAfter.getDate() + 1);
  const { data: alertStub } = await supabase
    .from('expense_reports')
    .select('id, receipt_path, qbo_attachment_id')
    .eq('card_last_four', cardLastFour)
    .is('qbo_transaction_id', null)
    .gte('transaction_date', dayBefore.toISOString().slice(0, 10))
    .lte('transaction_date', dayAfter.toISOString().slice(0, 10))
    .gte('amount', amount - 0.02)
    .lte('amount', amount + 0.02)
    .maybeSingle();

  if (alertStub) {
    await supabase.from('expense_reports').update({ qbo_transaction_id: purchaseId }).eq('id', alertStub.id);
    if (alertStub.receipt_path && !alertStub.qbo_attachment_id) {
      uploadReceiptToQboAsync(alertStub.id, purchaseId, alertStub.receipt_path);
    }
    logger.info('QBO purchase reconciled with Chase alert stub', { reportId: alertStub.id, purchaseId });
    return;
  }

  const { data: report, error } = await supabase
    .from('expense_reports')
    .insert({
      qbo_transaction_id: purchaseId,
      profile_id: card.profile_id ?? null,
      card_last_four: cardLastFour,
      employee_name: card.employee_name,
      phone_number: card.phone_number,
      sms_gateway: card.sms_gateway,
      amount,
      vendor,
      transaction_date: date,
      status: 'pending_employee',
    })
    .select()
    .single();

  if (error) {
    logger.error('Failed to create expense report', { err: error.message });
    return;
  }

  if (card.sms_gateway) {
    await sendExpenseSms(card.sms_gateway, { report, amount, vendor, date, cardLastFour });
    await supabase
      .from('expense_reports')
      .update({ sms_sent_at: new Date().toISOString() })
      .eq('id', report.id);
  } else {
    logger.warn('Cardholder has no SMS gateway', { card: cardLastFour });
  }

  logger.info('Expense report created', { reportId: report.id, employee: card.employee_name, vendor, amount });
}

function parsePurchase(purchase) {
  const amount = purchase.TotalAmt;
  const date = purchase.TxnDate;
  const rawVendor =
    purchase.EntityRef?.name ??
    purchase.PayeeRef?.name ??
    'Unknown Vendor';
  const vendor = rawVendor.replace(/\s*This transaction is above the level you set\.?/i, '').trim();

  // Card last four: typically in AccountRef name e.g. "Chase Visa ...1234" or "Chase ...1234"
  const accountName = purchase.AccountRef?.name ?? '';
  const cardLastFour = accountName.match(/(\d{4})\s*$$/)?.[1] ?? null;

  return { amount, vendor, date, cardLastFour };
}

// ── SMS via email-to-carrier gateway ──────────────────────────

async function sendExpenseSms(gateway, { report, amount, vendor, date, cardLastFour }) {
  const fmtAmount = `$${Number(amount).toFixed(2)}`;
  const fmtDate   = new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const link      = `${PORTAL_BASE}/expense/${report.id}`;
  const text      = `JRB: New charge on card ...${cardLastFour}: ${fmtAmount} at ${vendor} on ${fmtDate}. Submit receipt: ${link} Or email photo to assistant@jrboehlke.com (include card/amount in subject).`;

  await sendEmail({ to: [gateway], subject: '', body: text, contentType: 'Text' });
  logger.info('SMS sent via gateway', { gateway, reportId: report.id });

  const teamsMsg = `New charge on card ...${cardLastFour}: ${fmtAmount} at ${vendor} on ${fmtDate}\nSubmit receipt: ${link}`;
  sendProactiveMessage(teamsMsg).catch(err =>
    logger.warn('Teams expense notification failed', { err: err.message, reportId: report.id })
  );
}

// ── Expense Data (read) ────────────────────────────────────────

export async function getExpenseData(token) {
  const { data: report } = await supabase
    .from('expense_reports')
    .select('*')
    .eq('id', token)
    .maybeSingle();

  if (!report) return null;

  const { data: assets } = await supabase
    .from('assets')
    .select('id, name, category, type, make, model, year, status')
    .in('status', ['active', 'maintenance'])
    .order('name');

  return { report, assets: assets ?? [] };
}

// ── Form Submission ────────────────────────────────────────────

export async function submitExpenseReport(token, fields) {
  const { category, job_number, asset_id, item_description, receipt_path, receipt_url } = fields;

  const { data: report } = await supabase
    .from('expense_reports')
    .select('*')
    .eq('id', token)
    .maybeSingle();

  if (!report) return { error: 'Expense report not found' };
  if (report.status !== 'pending_employee') return { error: 'Already submitted' };

  const isAssetRelated = ASSET_CATEGORIES.has(category);
  let maintenance_log_id = null;

  if (isAssetRelated && asset_id) {
    const { data: maintLog, error: maintErr } = await supabase
      .from('maintenance_logs')
      .insert({
        asset_id,
        date: report.transaction_date,
        title: `${category} — ${report.vendor}`,
        type: inferMaintenanceType(category),
        vendor: report.vendor,
        external_cost: report.amount,
        notes: item_description || null,
        receipt_path: receipt_path || null,
        receipt_name: receipt_path ? receipt_path.split('/').pop() : null,
      })
      .select()
      .single();

    if (maintErr) {
      logger.error('Failed to create maintenance log', { err: maintErr.message });
    } else {
      maintenance_log_id = maintLog.id;
    }
  }

  const newStatus = isAssetRelated && asset_id
    ? 'pending_maintenance_log'
    : 'complete';

  await supabase
    .from('expense_reports')
    .update({
      category,
      job_number: job_number || null,
      asset_id: asset_id || null,
      item_description,
      receipt_path: receipt_path || null,
      receipt_url: receipt_url || null,
      maintenance_log_id,
      status: newStatus,
      submitted_at: new Date().toISOString(),
    })
    .eq('id', token);

  // Trigger Menards rebate flow if applicable
  if (report.vendor?.toLowerCase().includes('menard')) {
    import('./menards.js')
      .then(m => m.triggerMenardsRebate(report.id))
      .catch(err => logger.error('Menards rebate trigger failed', { err: err.message }));
  }

  // Backload receipt to QBO — fire-and-forget so it never blocks the submission
  const receiptStoragePath = receipt_path || report.receipt_path;
  if (receiptStoragePath && report.qbo_transaction_id) {
    uploadReceiptToQboAsync(report.id, report.qbo_transaction_id, receiptStoragePath);
  }

  const maintLogUrl = maintenance_log_id
    ? `${PORTAL_BASE}/log?log=${maintenance_log_id}`
    : null;

  logger.info('Expense report submitted', {
    reportId: token,
    status: newStatus,
    category,
    maintenance_log_id,
  });

  return { success: true, status: newStatus, maintenance_log_id, maintenance_log_url: maintLogUrl };
}

async function uploadReceiptToQboAsync(reportId, qboTransactionId, storagePath) {
  try {
    const { data: blob, error } = await supabase.storage
      .from('expense-receipts')
      .download(storagePath);
    if (error) throw error;

    const arrayBuffer = await blob.arrayBuffer();
    const fileBuffer  = Buffer.from(arrayBuffer);
    const fileName    = storagePath.split('/').pop();
    const ext         = fileName.split('.').pop().toLowerCase();
    const contentType = ext === 'pdf' ? 'application/pdf'
                      : ext === 'png' ? 'image/png'
                      : 'image/jpeg';

    const attachableId = await uploadReceiptToQbo(qboTransactionId, fileBuffer, contentType, fileName);

    await supabase
      .from('expense_reports')
      .update({ qbo_attachment_id: attachableId })
      .eq('id', reportId);
  } catch (err) {
    logger.error('QBO receipt upload failed', { reportId, err: err.message });
  }
}

function inferMaintenanceType(category) {
  if (category.includes('Repair')) return 'corrective';
  if (category.includes('fuel') || category.includes('Fuel')) return 'preventive';
  if (category.includes('supplies or parts') || category.includes('consumables')) return 'preventive';
  return 'other';
}

// ── Email Receipt Processing ───────────────────────────────────

const RECEIPT_MIME_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
  'image/heic', 'image/heif', 'application/pdf',
]);

/**
 * Called by the email poller when an employee emails a receipt to
 * assistant@jrboehlke.com. Matches by card last four + dollar amount
 * parsed from the email subject/body (both are in the original SMS the
 * employee received). Uploads the attachment, then sends a confirmation
 * SMS + email reply with the portal link.
 *
 * Returns true if the email was handled as a receipt, false if it should
 * fall through to normal email processing.
 */
export async function processEmailedReceipt(email, { listEmailAttachments, getEmailAttachmentBytes, sendEmail }) {
  // Check for image/PDF attachments first — no attachment = not a receipt email
  const attachments = await listEmailAttachments({ email_id: email.id });
  const receiptAttachment = attachments.find(a => RECEIPT_MIME_TYPES.has(a.contentType?.toLowerCase()));
  if (!receiptAttachment) return false;

  // Parse card last four and dollar amount from subject + snippet
  // The original SMS contains both: "card ...1234: $45.99 at Vendor"
  // Employees typically forward/quote the SMS, so these are reliably present.
  const searchText = `${email.subject ?? ''} ${email.snippet ?? ''}`;
  const { cardLastFour, amount } = parseCardAndAmount(searchText);

  if (!cardLastFour) {
    // Can't identify which card — reply asking for more info
    await sendEmail({
      to: [email.from],
      subject: `Re: ${email.subject}`,
      body: `<p>Thanks for sending your receipt. To match it to the right expense, please reply and include the last 4 digits of the card and the charge amount (both are in the original text we sent you).</p><p><em>— JRB Assistant</em></p>`,
    });
    return true;
  }

  // Find matching pending expense report by card last four
  const { data: candidates } = await supabase
    .from('expense_reports')
    .select('*')
    .eq('card_last_four', cardLastFour)
    .eq('status', 'pending_employee')
    .order('created_at', { ascending: false });

  if (!candidates?.length) {
    await sendEmail({
      to: [email.from],
      subject: `Re: ${email.subject}`,
      body: `<p>We received your receipt but couldn't find a pending expense report for card ending ${cardLastFour}. If the charge was just made, please try again in a few minutes.</p><p><em>— JRB Assistant</em></p>`,
    });
    return true;
  }

  // Narrow by amount if parsed; otherwise take most recent
  let report = candidates[0];
  if (amount !== null && candidates.length > 1) {
    const match = candidates.find(r => Math.abs(Number(r.amount) - amount) < 0.02);
    if (match) report = match;
  }

  // Download and upload to Supabase Storage
  const bytes = await getEmailAttachmentBytes({ email_id: email.id, attachment_id: receiptAttachment.id });
  const ext   = receiptAttachment.name?.split('.').pop() || 'jpg';
  const storagePath = `${report.id}/${Date.now()}-email.${ext}`;

  const { error: uploadErr } = await supabase.storage
    .from('expense-receipts')
    .upload(storagePath, bytes, { contentType: receiptAttachment.contentType, upsert: false });

  if (uploadErr) {
    logger.error('Failed to upload emailed receipt', { err: uploadErr.message, reportId: report.id });
    return true;
  }

  await supabase
    .from('expense_reports')
    .update({ receipt_path: storagePath })
    .eq('id', report.id);

  // Backload to QBO immediately — receipt is now in Storage
  if (report.qbo_transaction_id) {
    uploadReceiptToQboAsync(report.id, report.qbo_transaction_id, storagePath);
  }

  logger.info('Emailed receipt uploaded', { reportId: report.id, card: cardLastFour, amount });

  const fmtAmount = `$${Number(report.amount).toFixed(2)}`;
  const fmtVendor = report.vendor || 'your recent charge';
  const portalUrl = `${PORTAL_BASE}/expense/${report.id}`;

  // Confirmation SMS to the cardholder via gateway
  if (report.sms_gateway) {
    const confirmText = `JRB: Got your receipt for ${fmtAmount} at ${fmtVendor}. Please complete the form: ${portalUrl}`;
    await sendEmail({ to: [report.sms_gateway], subject: '', body: confirmText, contentType: 'Text' });
  }

  // Reply email (back to whoever sent it)
  await sendEmail({
    to: [email.from],
    subject: `Re: ${email.subject}`,
    body: `<p>Got it — your receipt for <strong>${fmtAmount} at ${fmtVendor}</strong> has been received and attached to the expense report for card ending ${cardLastFour}.</p>
<p>Please tap below to complete the remaining fields (what the purchase was for, description, etc.):</p>
<p><a href="${portalUrl}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold">Complete Expense Report →</a></p>
<p><em>— JRB Assistant</em></p>`,
  });

  return true;
}

// ── Chase Transaction Alert Processing ────────────────────────

/**
 * Called by the email poller for every unread email before the michael-only filter.
 * Detects forwarded/auto-forwarded Chase transaction alerts, creates an expense
 * report stub immediately (days before QBO settles the charge), and sends the
 * receipt request SMS.
 *
 * Returns true if handled as a Chase alert, false to fall through to normal processing.
 *
 * NOTE: Chase email formats vary. The parser handles the known patterns as of
 * 2026-05-20. Update parseChaseAlert() once real Chase emails are observed.
 */
export async function processChaseAlert(email, { getEmail, sendEmail }) {
  // Quick pre-filter — avoid fetching body for every email
  const fromAddr = (email.from || '').toLowerCase();
  const subject  = (email.subject || '').toLowerCase();

  const isFromChase = /chase\.com/.test(fromAddr);
  // Match: direct Chase alerts, "You made a $X.XX transaction", or any "$X.XX ... transaction" subject
  const subjectLooksLikeAlert =
    (subject.includes('chase') && /alert|transaction|purchase|charge/.test(subject)) ||
    /you made a .{0,20}\$[\d,]+\.\d{2}/.test(subject) ||
    (/\$[\d,]+\.\d{2}/.test(subject) && subject.includes('transaction'));

  if (!isFromChase && !subjectLooksLikeAlert) return false;

  // Fetch full body for parsing
  const full = await getEmail({ email_id: email.id });
  const bodyText = (full.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
  const searchText = `${email.subject || ''} ${bodyText}`;

  // If not directly from Chase, confirm the body also looks like a Chase alert
  if (!isFromChase && !/chase|card ending|ink business|sapphire|freedom/i.test(searchText)) {
    return false;
  }

  const parsed = parseChaseAlert(searchText);
  if (!parsed) {
    logger.warn('Chase alert: could not parse transaction details — will need format update', { subject: email.subject });
    return false;
  }

  const { cardLastFour, amount, merchant, transactionDate } = parsed;

  const { data: card } = await supabase
    .from('credit_cards')
    .select('*')
    .eq('last_four', cardLastFour)
    .eq('is_active', true)
    .maybeSingle();

  if (!card) {
    logger.warn('Chase alert: no active card found for last four', { cardLastFour, subject: email.subject });
    return true; // handled — don't let it fall through to general email reply
  }

  // Dedup: existing report within ±1 day with same card + amount
  const dayBefore = new Date(`${transactionDate}T12:00:00`); dayBefore.setDate(dayBefore.getDate() - 1);
  const dayAfter  = new Date(`${transactionDate}T12:00:00`); dayAfter.setDate(dayAfter.getDate() + 1);
  const { data: dup } = await supabase
    .from('expense_reports')
    .select('id')
    .eq('card_last_four', cardLastFour)
    .gte('transaction_date', dayBefore.toISOString().slice(0, 10))
    .lte('transaction_date', dayAfter.toISOString().slice(0, 10))
    .gte('amount', amount - 0.02)
    .lte('amount', amount + 0.02)
    .maybeSingle();

  if (dup) {
    logger.info('Chase alert: duplicate report already exists, skipping', { reportId: dup.id });
    return true;
  }

  const { data: report, error } = await supabase
    .from('expense_reports')
    .insert({
      card_last_four: cardLastFour,
      employee_name: card.employee_name,
      phone_number: card.phone_number,
      sms_gateway: card.sms_gateway,
      profile_id: card.profile_id ?? null,
      amount,
      vendor: merchant,
      transaction_date: transactionDate,
      status: 'pending_employee',
    })
    .select()
    .single();

  if (error) {
    logger.error('Chase alert: failed to create expense report', { err: error.message });
    return true;
  }

  if (card.sms_gateway) {
    await sendExpenseSms(card.sms_gateway, { report, amount, vendor: merchant, date: transactionDate, cardLastFour });
    await supabase.from('expense_reports').update({ sms_sent_at: new Date().toISOString() }).eq('id', report.id);
  }

  logger.info('Chase alert: expense report created', { reportId: report.id, employee: card.employee_name, merchant, amount });
  return true;
}

function parseChaseAlert(text) {
  // Card last four — "card ending in 3468", "ending in 3468", "...3468", "(...3468)"
  const cardMatch = text.match(
    /(?:card\s+ending\s+(?:in\s+)?|ending\s+in\s+|\(\.*|\.{2,})\s*(\d{4})/i
  );
  if (!cardMatch) return null;
  const cardLastFour = cardMatch[1];

  // Amount — "$47.23", "$1,200.00"
  const amountMatch = text.match(/\$\s*([\d,]+\.\d{2})/);
  if (!amountMatch) return null;
  const amount = parseFloat(amountMatch[1].replace(',', ''));

  // Merchant — subject: "You made a $X.XX transaction with MERCHANT NAME"
  // or body: "at HOME DEPOT on", "transaction at ...", etc.
  let merchant = 'Unknown Merchant';
  const merchantPatterns = [
    /transaction\s+with\s+([A-Z][A-Z0-9 &'.,#\-*]+?)(?:\s*$|\s+on\s|\s+using\s|\s+for\s|\.|,)/im,
    /\bat\s+([A-Z][A-Z0-9 &'.,#\-*]+?)\s+(?:on\s+\d|using\s+your|for\s+\$|\.|$)/i,
    /transaction\s+at\s+(.+?)(?:\s+on\s+|\s+for\s+|\.|$)/i,
    /purchase\s+at\s+(.+?)(?:\s+on\s+|\.|$)/i,
  ];
  for (const pat of merchantPatterns) {
    const m = text.match(pat);
    if (m && m[1].trim().length > 1) { merchant = m[1].trim(); break; }
  }

  // Date — "05/20/2026", "May 20, 2026", "May 20 2026"
  let transactionDate = new Date().toISOString().slice(0, 10);
  const datePatterns = [
    /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/,
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i,
  ];
  for (const pat of datePatterns) {
    const m = text.match(pat);
    if (m) {
      const d = new Date(m[0]);
      if (!isNaN(d.getTime())) { transactionDate = d.toISOString().slice(0, 10); break; }
    }
  }

  return { cardLastFour, amount, merchant, transactionDate };
}

function parseCardAndAmount(text) {
  // Card last four: "...1234", "****1234", "card ending 1234", "card ending in 1234",
  // "card ...1234", "last 4: 1234", or just a bare 4-digit group after common keywords
  const cardMatch = text.match(
    /(?:\.{2,3}|[*]{3,4}|card\s+ending(?:\s+in)?\s+|last\s*(?:4|four)(?:\s+digits?)?:?\s*)(\d{4})/i
  );
  const cardLastFour = cardMatch?.[1] ?? null;

  // Dollar amount: "$45.99", "$ 45.99", "$1,200", "45.99" near "charge" or "amount"
  const amountMatch = text.match(/\$\s*([\d,]+\.?\d{0,2})/);
  const amount = amountMatch ? parseFloat(amountMatch[1].replace(',', '')) : null;

  return { cardLastFour, amount };
}


// ── Reminder Flow ─────────────────────────────────────────────

const FIRST_REMINDER_AFTER_HOURS      = 24;   // 1 day after initial SMS
const SUBSEQUENT_REMINDER_AFTER_HOURS = 72;   // 3 days between follow-ups
const MAX_REMINDERS                   = 3;    // stop after 3 reminders (escalate via weekly report)

export async function sendExpenseReminders() {
  const now = new Date();

  const { data: reports, error } = await supabase
    .from('expense_reports')
    .select('id, amount, vendor, transaction_date, card_last_four, sms_gateway, sms_sent_at, reminder_count, last_reminder_sent_at')
    .eq('status', 'pending_employee')
    .not('sms_sent_at', 'is', null)
    .lt('reminder_count', MAX_REMINDERS);

  if (error) { logger.error('sendExpenseReminders query failed', { err: error.message }); return; }

  let sent = 0;
  for (const report of reports ?? []) {
    const lastContact = report.last_reminder_sent_at ?? report.sms_sent_at;
    const hoursSince  = (now - new Date(lastContact)) / 3_600_000;
    const waitHours   = report.reminder_count === 0
      ? FIRST_REMINDER_AFTER_HOURS
      : SUBSEQUENT_REMINDER_AFTER_HOURS;

    if (hoursSince < waitHours) continue;

    const gateway = report.sms_gateway;
    if (!gateway) continue;

    const fmtAmount = `$${Number(report.amount).toFixed(2)}`;
    const fmtDate   = report.transaction_date
      ? new Date(`${report.transaction_date}T12:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
      : 'recent';
    const portalUrl = `${PORTAL_BASE}/expense/${report.id}`;

    const message = `The expense report for the ${fmtAmount} charge ${fmtDate} is not complete. Please follow this link to complete: ${portalUrl}`;

    try {
      await sendEmail({ to: [gateway], subject: '', body: message, contentType: 'Text' });
      await supabase
        .from('expense_reports')
        .update({
          last_reminder_sent_at: now.toISOString(),
          reminder_count: (report.reminder_count ?? 0) + 1,
        })
        .eq('id', report.id);
      sent++;
      logger.info('Expense reminder sent', { reportId: report.id, reminderCount: report.reminder_count + 1 });
    } catch (err) {
      logger.error('Failed to send expense reminder', { reportId: report.id, err: err.message });
    }
  }

  logger.info('Expense reminder run complete', { sent, checked: reports?.length ?? 0 });
  return { sent, checked: reports?.length ?? 0 };
}

// ── Weekly Expense Report ──────────────────────────────────────

export async function generateWeeklyExpenseReport() {
  // Build Mon–Sun window for the prior week
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon
  const daysToLastMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const thisMonday = new Date(now); thisMonday.setDate(now.getDate() - daysToLastMonday); thisMonday.setHours(0, 0, 0, 0);
  const lastMonday = new Date(thisMonday); lastMonday.setDate(thisMonday.getDate() - 7);
  const lastSunday = new Date(thisMonday); lastSunday.setDate(thisMonday.getDate() - 1); lastSunday.setHours(23, 59, 59, 999);

  const weekLabel = lastMonday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' – ' + lastSunday.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const { data: reports, error } = await supabase
    .from('expense_reports')
    .select('*')
    .gte('created_at', lastMonday.toISOString())
    .lte('created_at', lastSunday.toISOString())
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Supabase query failed: ${error.message}`);
  if (!reports?.length) return { subject: `Weekly Expense Report — ${weekLabel}`, body: `<p>No credit card charges were detected this week (${weekLabel}).</p>` };

  // Group by employee
  const byEmployee = {};
  for (const r of reports) {
    const name = r.employee_name || r.card_last_four || 'Unknown';
    if (!byEmployee[name]) byEmployee[name] = [];
    byEmployee[name].push(r);
  }

  const totalAmount = reports.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const submitted   = reports.filter(r => r.status !== 'pending_employee');
  const pending     = reports.filter(r => r.status === 'pending_employee');
  const pendingMaint = reports.filter(r => r.status === 'pending_maintenance_log');

  // Red flag detection
  const flags = detectRedFlags(reports);

  // ── Build HTML email ───────────────────────────────────────
  const css = `
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #0f172a; max-width: 700px; margin: 0 auto; padding: 24px 16px; }
    h1 { font-size: 20px; margin: 0 0 4px; } .sub { color: #64748b; font-size: 14px; margin: 0 0 24px; }
    h2 { font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #64748b; margin: 28px 0 10px; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { background: #f8fafc; text-align: left; padding: 8px 10px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: #64748b; border-bottom: 2px solid #e2e8f0; }
    td { padding: 8px 10px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    .kpi { display: inline-block; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 18px; margin: 0 8px 8px 0; text-align: center; }
    .kpi-val { font-size: 22px; font-weight: 800; color: #0f172a; display: block; }
    .kpi-lbl { font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: .06em; }
    .badge-ok { color: #16a34a; font-weight: 700; } .badge-warn { color: #d97706; font-weight: 700; } .badge-err { color: #dc2626; font-weight: 700; }
    .flag-box { background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 12px 14px; margin: 8px 0; }
    .flag-item { font-size: 13px; color: #dc2626; margin: 4px 0; }
    .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; }
  `;

  const f$ = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fD = iso => iso ? new Date(iso + (iso.length === 10 ? 'T12:00:00' : '')).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';

  const statusBadge = s => {
    if (s === 'complete')               return '<span class="badge-ok">✅ Complete</span>';
    if (s === 'pending_maintenance_log') return '<span class="badge-warn">🔧 Needs Maint Log</span>';
    if (s === 'pending_employee')        return '<span class="badge-err">⏳ Not Submitted</span>';
    if (s === 'flagged')                 return '<span class="badge-err">🚩 Flagged</span>';
    return s;
  };

  // Summary KPIs
  let html = `<style>${css}</style>
<h1>Weekly Expense Report</h1>
<p class="sub">Week of ${weekLabel}</p>

<div>
  <div class="kpi"><span class="kpi-val">${f$(totalAmount)}</span><span class="kpi-lbl">Total Spend</span></div>
  <div class="kpi"><span class="kpi-val">${reports.length}</span><span class="kpi-lbl">Charges</span></div>
  <div class="kpi"><span class="kpi-val">${submitted.length}/${reports.length}</span><span class="kpi-lbl">Submitted</span></div>
  ${pending.length ? `<div class="kpi" style="border-color:#fca5a5"><span class="kpi-val" style="color:#dc2626">${pending.length}</span><span class="kpi-lbl">Pending</span></div>` : ''}
  ${flags.length ? `<div class="kpi" style="border-color:#fca5a5"><span class="kpi-val" style="color:#dc2626">${flags.length}</span><span class="kpi-lbl">Red Flags</span></div>` : ''}
</div>`;

  // Red flags
  if (flags.length) {
    html += `<h2>⚠️ Red Flags</h2><div class="flag-box">`;
    for (const f of flags) html += `<div class="flag-item">• ${f}</div>`;
    html += `</div>`;
  }

  // Per-employee breakdown
  html += `<h2>By Employee</h2>
<table>
  <thead><tr><th>Employee</th><th>Charges</th><th>Amount</th><th>Submitted</th><th>Pending</th></tr></thead>
  <tbody>`;
  for (const [name, rows] of Object.entries(byEmployee)) {
    const tot = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const sub = rows.filter(r => r.status !== 'pending_employee').length;
    const pnd = rows.filter(r => r.status === 'pending_employee').length;
    html += `<tr>
      <td><strong>${name}</strong></td>
      <td>${rows.length}</td>
      <td>${f$(tot)}</td>
      <td class="${sub === rows.length ? 'badge-ok' : ''}">${sub}</td>
      <td class="${pnd > 0 ? 'badge-err' : ''}">${pnd}</td>
    </tr>`;
  }
  html += `</tbody></table>`;

  // Submitted expense detail
  if (submitted.length) {
    html += `<h2>Submitted Expenses</h2>
<table>
  <thead><tr><th>Date</th><th>Employee</th><th>Vendor</th><th>Amount</th><th>Category</th><th>Job / Asset</th><th>Status</th></tr></thead>
  <tbody>`;
    for (const r of submitted) {
      const jobAsset = r.job_number || r.asset_id || '—';
      html += `<tr>
        <td>${fD(r.transaction_date)}</td>
        <td>${r.employee_name || '—'}</td>
        <td>${r.vendor || '—'}</td>
        <td>${f$(r.amount)}</td>
        <td style="font-size:11px">${r.category ? r.category.slice(0, 50) + (r.category.length > 50 ? '…' : '') : '—'}</td>
        <td style="font-size:11px">${jobAsset}</td>
        <td>${statusBadge(r.status)}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
  }

  // Pending (not submitted)
  if (pending.length) {
    html += `<h2>Not Yet Submitted</h2>
<table>
  <thead><tr><th>Employee</th><th>Date</th><th>Vendor</th><th>Amount</th><th>SMS Sent</th></tr></thead>
  <tbody>`;
    for (const r of pending) {
      html += `<tr>
        <td>${r.employee_name || '—'}</td>
        <td>${fD(r.transaction_date)}</td>
        <td>${r.vendor || '—'}</td>
        <td>${f$(r.amount)}</td>
        <td>${r.sms_sent_at ? fD(r.sms_sent_at.slice(0, 10)) : '<span class="badge-err">Not sent</span>'}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
  }

  // Needs maintenance log
  if (pendingMaint.length) {
    html += `<h2>Maintenance Logs Needed</h2>
<table>
  <thead><tr><th>Employee</th><th>Vendor</th><th>Amount</th><th>Asset</th></tr></thead>
  <tbody>`;
    for (const r of pendingMaint) {
      html += `<tr>
        <td>${r.employee_name || '—'}</td>
        <td>${r.vendor || '—'}</td>
        <td>${f$(r.amount)}</td>
        <td>${r.asset_id || '—'}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
  }

  html += `<p class="footer">Generated by JRB Executive Agent &middot; ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })}</p>`;

  return {
    subject: `Weekly Expense Report — ${weekLabel} (${f$(totalAmount)}, ${reports.length} charges)`,
    body: html,
  };
}

function detectRedFlags(reports) {
  const flags = [];
  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  // Charge over $500
  for (const r of reports) {
    if (Number(r.amount) > 500) {
      flags.push(`Large charge: ${r.employee_name || r.card_last_four} — ${r.vendor} ${formatDollar(r.amount)}`);
    }
  }

  // Pending > 3 days
  for (const r of reports) {
    if (r.status === 'pending_employee' && r.sms_sent_at) {
      const age = now - new Date(r.sms_sent_at).getTime();
      if (age > THREE_DAYS_MS) {
        flags.push(`No submission after ${Math.floor(age / 86400000)} days: ${r.employee_name || r.card_last_four} — ${r.vendor} ${formatDollar(r.amount)} (sent ${new Date(r.sms_sent_at).toLocaleDateString()})`);
      }
    }
  }

  // Same employee, same vendor, same day — possible duplicate
  const seen = new Map();
  for (const r of reports) {
    const key = `${r.profile_id}|${(r.vendor || '').toLowerCase()}|${r.transaction_date}`;
    if (seen.has(key)) {
      flags.push(`Possible duplicate: ${r.employee_name || r.card_last_four} has 2+ charges at ${r.vendor} on ${r.transaction_date}`);
    } else {
      seen.set(key, true);
    }
  }

  return flags;
}

function formatDollar(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
