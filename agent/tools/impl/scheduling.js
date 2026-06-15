// tools/impl/scheduling.js — Field operations scheduling tools
import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';

const FIELDOPS_URL = 'https://mzywmgesulyalevtzudw.supabase.co';
function db() {
  const key = process.env.FLEETOPS_SUPABASE_SERVICE_KEY;
  if (!key) throw new Error('FLEETOPS_SUPABASE_SERVICE_KEY env var not set');
  return createClient(FIELDOPS_URL, key);
}

export async function getCrews() {
  const { data, error } = await db()
    .from('crews')
    .select('id, name, display_name, work_types, daily_capacity, color, notes')
    .eq('active', true)
    .order('display_name');
  if (error) throw new Error(`get_crews: ${error.message}`);
  return data;
}

export async function getWaitingList({ service_filter, limit = 2000 } = {}) {
  const { data, error } = await db()
    .from('sa_waiting_list')
    .select('job_id,client_id,client_name,address,city,zip,service_code,category,date_added,amount,budgeted_hours,notes,internal_notes,target_date,sales_rep,service_timing,pavement_sf')
    .in('status', ['6', '7', '1'])
    .order('date_added', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`get_waiting_list: ${error.message}`);

  const today = new Date();
  let results = (data || []).map(j => ({
    ...j,
    days_waiting: j.date_added
      ? Math.floor((today - new Date(j.date_added)) / 86_400_000)
      : null,
  }));

  if (service_filter) {
    const kw = service_filter.toLowerCase();
    results = results.filter(j =>
      (j.service_code || '').toLowerCase().includes(kw) ||
      (j.internal_notes || j.notes || '').toLowerCase().includes(kw) ||
      (j.category    || '').toLowerCase().includes(kw)
    );
  }
  return results;
}

export async function getTreatmentHistory({ client_names, service_keywords } = {}) {
  if (!client_names?.length) return {};
  const keywords = service_keywords ?? ['app 1','app 2','app 3','app 4','app 5','fertiliz','mosquito'];

  const { data, error } = await db()
    .from('sa_jobs')
    .select('client, service, start_date')
    .in('client', client_names)
    .eq('status', 3)
    .order('start_date', { ascending: false });
  if (error) throw new Error(`get_treatment_history: ${error.message}`);

  const today = new Date();
  const history = {};
  for (const job of (data || [])) {
    const svc = (job.service || '').toLowerCase();
    const matchedKw = keywords.find(kw => svc.includes(kw.toLowerCase()));
    if (!matchedKw) continue;
    if (!history[job.client]) history[job.client] = {};
    if (!history[job.client][matchedKw]) {
      history[job.client][matchedKw] = {
        last_date: job.start_date,
        service:   job.service,
        days_ago:  Math.floor((today - new Date(job.start_date)) / 86_400_000),
      };
    }
  }
  return history;
}

export async function getWeatherForecast({ days = 14 } = {}) {
  const n = Math.min(Math.max(days, 1), 14);
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=43.0389&longitude=-87.9065` +
    `&hourly=precipitation_probability,precipitation,temperature_2m,weathercode` +
    `&daily=temperature_2m_max,temperature_2m_min,weathercode,windspeed_10m_max` +
    `&forecast_days=${n}&timezone=America%2FChicago`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather API HTTP ${res.status}`);
  const d = await res.json();

  const RAIN = new Set([51,53,55,57,61,63,65,67,80,81,82,95,96,99]);
  const SNOW = new Set([71,73,75,77,85,86]);
  const toF  = c => Math.round(c * 9/5 + 32);

  // Build hourly lookup by date string
  const hourlyByDate = {};
  d.hourly.time.forEach((ts, i) => {
    const [date, time] = ts.split('T');
    if (!hourlyByDate[date]) hourlyByDate[date] = [];
    hourlyByDate[date].push({
      hour: parseInt(time.split(':')[0]),
      precip_prob: d.hourly.precipitation_probability[i],
      precip_mm:   d.hourly.precipitation[i],
      temp_f:      toF(d.hourly.temperature_2m[i]),
      code:        d.hourly.weathercode[i],
    });
  });

  function slotSummary(hours, fromH, toH) {
    const slots = hours.filter(h => h.hour >= fromH && h.hour < toH);
    if (!slots.length) return null;
    const maxProb = Math.max(...slots.map(h => h.precip_prob));
    const totalMm = slots.reduce((s, h) => s + h.precip_mm, 0);
    const hasRain = slots.some(h => RAIN.has(h.code));
    const hasSnow = slots.some(h => SNOW.has(h.code));
    const avgTemp = Math.round(slots.reduce((s, h) => s + h.temp_f, 0) / slots.length);
    return {
      precip_prob: maxProb,
      precip_mm:   Math.round(totalMm * 10) / 10,
      condition:   hasSnow ? 'snow' : hasRain ? 'rain' : maxProb >= 40 ? 'chance_rain' : 'clear',
      avg_temp_f:  avgTemp,
    };
  }

  return d.daily.time.map((date, i) => {
    const hiF    = toF(d.daily.temperature_2m_max[i]);
    const loF    = toF(d.daily.temperature_2m_min[i]);
    const code   = d.daily.weathercode[i];
    const hours  = hourlyByDate[date] || [];
    const morning   = slotSummary(hours, 6, 12);   // 6am–noon
    const afternoon = slotSummary(hours, 12, 18);  // noon–6pm
    const evening   = slotSummary(hours, 18, 22);  // 6pm–10pm

    // safe_for_fert: morning OR afternoon slot has < 40% rain and temp in range
    const fertWindow = (morning?.precip_prob ?? 100) < 40 || (afternoon?.precip_prob ?? 100) < 40;
    return {
      date,
      temp_high:   hiF,
      temp_low:    loF,
      wind_mph:    Math.round(d.daily.windspeed_10m_max[i] * 0.621371),
      condition:   SNOW.has(code) ? 'snow' : RAIN.has(code) ? 'rain' : code <= 3 ? 'clear' : 'cloudy',
      morning,
      afternoon,
      evening,
      safe_for_fert: fertWindow && hiF >= 45 && hiF <= 95,
    };
  });
}

export async function saveScheduleDraft({ session_id, directive, week_start, schedule_data, draft_id }) {
  if (draft_id) {
    const { data, error } = await db()
      .from('schedule_drafts')
      .update({ schedule_data, directive, week_start: week_start || null, updated_at: new Date().toISOString() })
      .eq('id', draft_id)
      .select()
      .single();
    if (error) throw new Error(`save_schedule_draft update: ${error.message}`);
    logger.info('Schedule draft updated', { draft_id });
    return data;
  }
  // No draft_id — check for existing draft to upsert into (preserves session_notes)
  const { data: existing } = await db()
    .from('schedule_drafts')
    .select('id')
    .eq('session_id', session_id)
    .eq('status', 'draft')
    .order('updated_at', { ascending: false })
    .limit(1);
  if (existing?.[0]?.id) {
    const { data, error } = await db()
      .from('schedule_drafts')
      .update({ schedule_data, directive, week_start: week_start || null, updated_at: new Date().toISOString() })
      .eq('id', existing[0].id)
      .select()
      .single();
    if (error) throw new Error(`save_schedule_draft upsert: ${error.message}`);
    logger.info('Schedule draft upserted', { id: existing[0].id, session_id });
    return data;
  }
  const { data, error } = await db()
    .from('schedule_drafts')
    .insert({ session_id, directive, week_start: week_start || null, schedule_data, status: 'draft' })
    .select()
    .single();
  if (error) throw new Error(`save_schedule_draft insert: ${error.message}`);
  logger.info('Schedule draft created', { id: data.id, session_id });
  return data;
}

export async function getScheduleDraft({ session_id, draft_id }) {
  if (draft_id) {
    const { data, error } = await db().from('schedule_drafts').select('*').eq('id', draft_id).single();
    if (error) return null;
    return data;
  }
  const { data, error } = await db()
    .from('schedule_drafts')
    .select('*')
    .eq('session_id', session_id)
    .eq('status', 'draft')
    .order('updated_at', { ascending: false })
    .limit(1);
  if (error || !data?.length) return null;
  return data[0];
}

/**
 * Sync Pavement Size custom field from SA into sa_waiting_list.pavement_sf.
 * Fetches GetClientInfo for each unique PMM client missing the value (or all if force=true).
 * Throttles requests at 300ms intervals to avoid SA rate limiting.
 */
export async function syncPavementSizes({ force = false } = {}) {
  const { fetchClientPavementSf } = await import('./serviceautopilot.js');

  let query = db()
    .from('sa_waiting_list')
    .select('client_id')
    .ilike('service_code', 'PMM%')
    .not('client_id', 'is', null);
  if (!force) query = query.is('pavement_sf', null);

  const { data: rows, error } = await query;
  if (error) throw new Error(`syncPavementSizes query: ${error.message}`);

  const clientIds = [...new Set((rows || []).map(r => r.client_id).filter(Boolean))];
  logger.info('syncPavementSizes: starting', { total: clientIds.length, force });

  let synced = 0;
  let skipped = 0;
  let failed = 0;
  for (const clientId of clientIds) {
    try {
      const pavementSf = await fetchClientPavementSf(clientId);
      if (pavementSf !== null) {
        const { error: updateErr } = await db()
          .from('sa_waiting_list')
          .update({ pavement_sf: pavementSf })
          .eq('client_id', clientId)
          .ilike('service_code', 'PMM%');
        if (updateErr) {
          logger.warn('syncPavementSizes: update failed', { clientId, err: updateErr.message });
          failed++;
        } else {
          synced++;
        }
      } else {
        skipped++;
      }
    } catch (e) {
      logger.warn('syncPavementSizes: failed for client', { clientId, err: e.message });
      failed++;
    }
    await new Promise(r => setTimeout(r, 300));
  }

  logger.info('syncPavementSizes: complete', { synced, skipped, failed, total: clientIds.length });
  return { synced, skipped, failed, total: clientIds.length };
}

export async function recordDecision({ session_id, decision }) {
  // Find existing draft for this session (draft status only — avoids appending to confirmed rows)
  const { data: existing } = await db()
    .from('schedule_drafts')
    .select('id, session_notes')
    .eq('session_id', session_id)
    .eq('status', 'draft')
    .order('updated_at', { ascending: false })
    .limit(1);

  const row = existing?.[0];
  const notes = Array.isArray(row?.session_notes) ? [...row.session_notes] : [];
  notes.push(decision);

  if (row?.id) {
    const { error } = await db()
      .from('schedule_drafts')
      .update({ session_notes: notes, updated_at: new Date().toISOString() })
      .eq('id', row.id);
    if (error) throw new Error(`record_decision update: ${error.message}`);
  } else {
    // No draft yet — create a stub to hold session notes until a real draft is saved
    const { error } = await db()
      .from('schedule_drafts')
      .insert({ session_id, session_notes: notes, status: 'draft', schedule_data: {}, directive: '(session notes)' });
    if (error) throw new Error(`record_decision insert: ${error.message}`);
  }
  logger.info('Session decision recorded', { session_id, decision: String(decision).slice(0, 80) });
  return `Recorded: "${decision}"`;
}
