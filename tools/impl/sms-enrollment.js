// tools/impl/sms-enrollment.js — SMS opt-in enrollment and inbound webhook handler
import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';
import twilio from 'twilio';

function getSupabase() {
  return createClient(
    process.env.FLEETOPS_SUPABASE_URL,
    process.env.FLEETOPS_SUPABASE_SERVICE_KEY
  );
}

function toE164(phone) {
  const digits = String(phone).replace(/\D/g, '');
  return digits.startsWith('1') ? `+${digits}` : `+1${digits}`;
}

async function sendSms(to, body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const fromPhone  = process.env.TWILIO_FROM_PHONE;
  if (!accountSid || !authToken || !fromPhone) throw new Error('Twilio env vars not configured');
  const client = twilio(accountSid, authToken);
  const msg = await client.messages.create({ body, from: fromPhone, to });
  if (msg.errorCode) throw new Error(`Twilio error ${msg.errorCode}: ${msg.errorMessage}`);
  return msg;
}

export async function enrollPhone(phone, name, ipAddress, userAgent) {
  const e164 = toE164(phone);
  const supabase = getSupabase();

  const { data: existing } = await supabase
    .from('sms_enrollments')
    .select('id, status')
    .eq('phone_number', e164)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const record = {
    phone_number: e164,
    name: name || null,
    ip_address: ipAddress || null,
    user_agent: userAgent || null,
    status: 'pending',
    consented_at: new Date().toISOString(),
    confirmed_at: null,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    const { error } = await supabase
      .from('sms_enrollments')
      .update(record)
      .eq('id', existing.id);
    if (error) throw new Error(`Supabase error: ${error.message}`);
  } else {
    const { error } = await supabase
      .from('sms_enrollments')
      .insert(record);
    if (error) throw new Error(`Supabase error: ${error.message}`);
  }

  await sendSms(
    e164,
    'J.R. Boehlke: Reply YES to confirm company card SMS alerts. Msg & data rates may apply. Reply STOP to cancel.'
  );

  logger.info('SMS enrollment: opt-in SMS sent', { phone: e164 });
}

export async function handleInboundSms(fromPhone, messageBody) {
  const e164 = toE164(fromPhone);
  const text = (messageBody || '').trim().toUpperCase();
  const supabase = getSupabase();

  const { data: enrollment } = await supabase
    .from('sms_enrollments')
    .select('id, status, name')
    .eq('phone_number', e164)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (text === 'YES') {
    if (enrollment && enrollment.status === 'pending') {
      await supabase
        .from('sms_enrollments')
        .update({ status: 'confirmed', confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', enrollment.id);
    }
    logger.info('SMS enrollment: confirmed', { phone: e164 });
    const label = (enrollment && enrollment.name) ? enrollment.name : e164;
    sendSms('+14146593840', `JRB: ${label} (${e164}) enrolled for card SMS alerts.`).catch(() => {});
    return 'You are now enrolled in J.R. Boehlke company card alerts. Reply STOP anytime to opt out. Help: (262) 242-9924.';
  }

  if (['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(text)) {
    if (enrollment) {
      await supabase
        .from('sms_enrollments')
        .update({ status: 'opted_out', updated_at: new Date().toISOString() })
        .eq('id', enrollment.id);
    }
    logger.info('SMS enrollment: opted out', { phone: e164 });
    return 'You have been unsubscribed from J.R. Boehlke card alerts. No further messages will be sent. Reply START to re-enroll.';
  }

  if (['HELP', 'INFO'].includes(text)) {
    return 'J.R. Boehlke Card Alerts: card charge & receipt reminders. Msg & data rates may apply. Reply STOP to opt out. Help: (262) 242-9924 or michael@jrboehlke.com.';
  }

  if (['START', 'UNSTOP'].includes(text)) {
    if (enrollment) {
      await supabase
        .from('sms_enrollments')
        .update({ status: 'pending', confirmed_at: null, updated_at: new Date().toISOString() })
        .eq('id', enrollment.id);
    }
    logger.info('SMS enrollment: restart', { phone: e164 });
    return 'Reply YES to confirm enrollment in J.R. Boehlke company card alerts.';
  }

  logger.info('SMS enrollment: unrecognized inbound', { phone: e164, text: text.slice(0, 20) });
  return null;
}
