// tools/impl/expense.js — Credit card expense capture system
import crypto from 'crypto';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';
import { getPurchase } from './quickbooks.js';

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
    .select('*, profiles(id, full_name, phone_number)')
    .eq('last_four', cardLastFour)
    .eq('is_active', true)
    .maybeSingle();

  if (!card?.profiles) {
    logger.warn('No active cardholder found for last four', { cardLastFour });
    return;
  }

  const profile = card.profiles;

  const { data: report, error } = await supabase
    .from('expense_reports')
    .insert({
      qbo_transaction_id: purchaseId,
      profile_id: profile.id,
      card_last_four: cardLastFour,
      employee_name: profile.full_name,
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

  if (profile.phone_number) {
    await sendExpenseSms(profile.phone_number, { report, amount, vendor, date, cardLastFour });
    await supabase
      .from('expense_reports')
      .update({ sms_sent_at: new Date().toISOString() })
      .eq('id', report.id);
  } else {
    logger.warn('Cardholder has no phone number', { profileId: profile.id });
  }

  logger.info('Expense report created', { reportId: report.id, employee: profile.full_name, vendor, amount });
}

function parsePurchase(purchase) {
  const amount = purchase.TotalAmt;
  const date = purchase.TxnDate;
  const vendor =
    purchase.EntityRef?.name ??
    purchase.PayeeRef?.name ??
    'Unknown Vendor';

  // Card last four: typically in AccountRef name e.g. "Chase Visa ...1234" or "Chase ...1234"
  const accountName = purchase.AccountRef?.name ?? '';
  const cardLastFour = accountName.match(/(\d{4})\s*$$/)?.[1] ?? null;

  return { amount, vendor, date, cardLastFour };
}

// ── SMS via Twilio ─────────────────────────────────────────────

async function sendExpenseSms(phoneNumber, { report, amount, vendor, date, cardLastFour }) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    logger.warn('Twilio not configured — SMS skipped', { phoneNumber });
    return;
  }

  const fmtAmount = `$${Number(amount).toFixed(2)}`;
  const fmtDate   = new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const link      = `${PORTAL_BASE}/expense/${report.id}`;

  const body = `JRB: New charge on card ...${cardLastFour}: ${fmtAmount} at ${vendor} on ${fmtDate}. Submit your receipt: ${link}`;

  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    new URLSearchParams({ To: phoneNumber, From: fromNumber, Body: body }).toString(),
    {
      auth: { username: accountSid, password: authToken },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );

  logger.info('SMS sent', { to: phoneNumber, reportId: report.id });
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

function inferMaintenanceType(category) {
  if (category.includes('Repair')) return 'corrective';
  if (category.includes('fuel') || category.includes('Fuel')) return 'preventive';
  if (category.includes('supplies or parts') || category.includes('consumables')) return 'preventive';
  return 'other';
}
