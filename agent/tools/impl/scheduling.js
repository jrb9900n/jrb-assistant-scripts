// tools/impl/scheduling.js — Field operations scheduling tools
import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';

const FIELDOPS_URL = 'https://mzywmgesulyalevtzudw.supabase.co';
function db() {
  const key = process.env.FIELDOPS_SUPABASE_KEY;
  if (!key) throw new Error('FIELDOPS_SUPABASE_KEY env var not set');
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

export async function getWaitingList({ service_filter, limit = 500 } = {}) {
  const { data, error } = await db()
    .from('sa_waiting_list')
    .select('job_id,client_id,client_name,address,city,zip,service_code,category,date_added,days_waiting,amount,budgeted_hours,notes,internal_notes,target_date,sales_rep,service_timing')
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
    `&daily=precipitation_probability_max,temperature_2m_max,temperature_2m_min,weathercode,windspeed_10m_max` +
    `&forecast_days=${n}&timezone=America%2FChicago`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather API HTTP ${res.status}`);
  const d = await res.json();

  const RAIN = new Set([51,53,55,57,61,63,65,67,80,81,82,95,96,99]);
  const SNOW = new Set([71,73,75,77,85,86]);
  const toF  = c => Math.round(c * 9/5 + 32);

  return d.daily.time.map((date, i) => {
    const hiF  = toF(d.daily.temperature_2m_max[i]);
    const rain = d.daily.precipitation_probability_max[i];
    const code = d.daily.weathercode[i];
    return {
      date,
      temp_high:   hiF,
      temp_low:    toF(d.daily.temperature_2m_min[i]),
      precip_prob: rain,
      wind_mph:    Math.round(d.daily.windspeed_10m_max[i] * 0.621371),
      condition:   SNOW.has(code) ? 'snow' : RAIN.has(code) ? 'rain' : code <= 3 ? 'clear' : 'cloudy',
      safe_for_fert: rain < 40 && hiF >= 45 && hiF <= 95,
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
