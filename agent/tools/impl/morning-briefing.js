// tools/impl/morning-briefing.js
// Generates the daily 7:30 AM morning briefing for Michael Reardon.
//
// Output:
//   teamsMessage  — short punchy Teams message (plain text, under 40 lines)
//   emailSubject  — subject for the email version
//   emailBody     — full HTML email with tables and detail

import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';
import { listCalendarEvents } from './m365.js';

const MICHAEL = 'michael@jrboehlke.com';

function supabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// ── Date helpers ─────────────────────────────────────────────────────────────

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function hoursAgo(n) {
  return new Date(Date.now() - n * 60 * 60 * 1000);
}

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function formatTime(isoString, tz = 'America/Chicago') {
  return new Date(isoString).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: tz, hour12: true,
  });
}

function formatDateLong(d = new Date()) {
  return d.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

// ── Data fetchers ────────────────────────────────────────────────────────────

async function getEmailStats() {
  const db = supabase();
  const since = hoursAgo(24).toISOString();

  const { data, error } = await db
    .from('email_triage')
    .select('priority, category, intent, subject, from_address, from_name, hot_trigger, meeting_detected, draft_id, action_items')
    .eq('mailbox', MICHAEL)
    .gte('processed_at', since)
    .order('priority', { ascending: true });

  if (error) {
    logger.warn('morning-briefing: email_triage query failed', { error: error.message });
    return { total: 0, p1: [], p2: [], p3: [], meetings: [] };
  }

  const rows = data ?? [];
  return {
    total:    rows.length,
    p1:       rows.filter(r => r.priority === 'p1'),
    p2:       rows.filter(r => r.priority === 'p2'),
    p3:       rows.filter(r => r.priority === 'p3'),
    meetings: rows.filter(r => r.meeting_detected),
  };
}

async function getOverdueFollowups() {
  const db = supabase();
  const { data, error } = await db
    .from('email_followup_tracker')
    .select('subject, to_address, sent_at, followup_after')
    .is('resolved_at', null)
    .lte('followup_after', new Date().toISOString())
    .order('sent_at', { ascending: true })
    .limit(10);

  if (error) {
    logger.warn('morning-briefing: followup_tracker query failed', { error: error.message });
    return [];
  }
  return (data ?? []).map(r => ({
    subject:    r.subject,
    to:         r.to_address,
    days:       Math.floor((Date.now() - new Date(r.sent_at).getTime()) / 86400000),
  }));
}

async function getTodayCalendar() {
  const todayStart = startOfToday().toISOString();
  const todayEnd   = new Date(startOfToday().getTime() + 24 * 60 * 60 * 1000).toISOString();
  try {
    const events = await listCalendarEvents({
      userEmail:     MICHAEL,
      startDateTime: todayStart,
      endDateTime:   todayEnd,
      limit:         10,
    });
    return events.filter(e => !e.all_day);
  } catch (err) {
    logger.warn('morning-briefing: calendar fetch failed', { err: err.message });
    return [];
  }
}

// ── CSS shared between both reports ──────────────────────────────────────────

const CSS = `
  body { font-family: Segoe UI, Arial, sans-serif; font-size: 14px; color: #1a1a1a; margin: 0; padding: 0; background: #f4f4f4; }
  .wrap { max-width: 700px; margin: 20px auto; background: #fff; border-radius: 6px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
  .header { background: #1a3a5c; color: #fff; padding: 18px 24px; }
  .header h1 { margin: 0; font-size: 18px; font-weight: 600; }
  .header p  { margin: 4px 0 0; font-size: 12px; color: #aac4e0; }
  .section { padding: 16px 24px; border-bottom: 1px solid #eee; }
  .section:last-child { border-bottom: none; }
  .section-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: #555; margin: 0 0 10px; display: flex; align-items: center; gap: 8px; }
  .badge { background: #1a3a5c; color: #fff; border-radius: 10px; padding: 1px 8px; font-size: 11px; font-weight: 600; }
  .badge.red    { background: #a00; }
  .badge.orange { background: #c96800; }
  .badge.green  { background: #1a7a3c; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: #f0f4f8; text-align: left; padding: 6px 8px; font-weight: 600; color: #444; border-bottom: 2px solid #dde3ea; }
  td { padding: 6px 8px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .pill { display: inline-block; border-radius: 10px; padding: 1px 8px; font-size: 11px; font-weight: 600; white-space: nowrap; }
  .pill-red    { background: #fee2e2; color: #a00; }
  .pill-orange { background: #fff3cd; color: #856404; }
  .pill-green  { background: #d1fae5; color: #065f46; }
  .empty { color: #888; font-size: 13px; padding: 6px 0; }
  .footer { background: #f8f9fa; padding: 10px 24px; font-size: 11px; color: #888; text-align: center; }
  .draft-note { font-size: 11px; color: #555; font-style: italic; }
`;

// ── HTML builders ─────────────────────────────────────────────────────────────

function priorityPill(priority) {
  const map = {
    p1: ['pill-red',    'Respond Today'],
    p2: ['pill-orange', 'This Week'],
    p3: ['pill-green',  'Filed/FYI'],
  };
  const [cls, label] = map[priority] ?? ['pill-green', priority];
  return `<span class="pill ${cls}">${label}</span>`;
}

function emailTriageTable(rows) {
  if (!rows.length) return '<p class="empty">None in the last 24 hours.</p>';
  return `<table>
    <thead><tr>
      <th>Priority</th><th>From</th><th>Subject</th><th>Intent</th><th></th>
    </tr></thead>
    <tbody>
    ${rows.map(r => `<tr>
      <td>${priorityPill(r.priority)}</td>
      <td style="white-space:nowrap">${r.from_name ? `${r.from_name}<br><span style="color:#888;font-size:11px">${r.from_address}</span>` : (r.from_address ?? '—')}</td>
      <td>${r.subject ?? '—'}</td>
      <td style="color:#555;font-size:12px">${r.intent ?? ''}</td>
      <td>${r.draft_id ? '<span class="draft-note">✍️ draft ready</span>' : ''}${r.meeting_detected ? '<span style="font-size:12px">📅</span>' : ''}</td>
    </tr>`).join('')}
    </tbody>
  </table>`;
}

function calendarTable(events) {
  if (!events.length) return '<p class="empty">Nothing scheduled today.</p>';
  return `<table>
    <thead><tr><th>Time</th><th>Event</th><th>Location</th></tr></thead>
    <tbody>
    ${events.map(e => `<tr>
      <td style="white-space:nowrap;font-weight:600">${formatTime(e.start)}</td>
      <td>${e.subject ?? '—'}</td>
      <td style="color:#555;font-size:12px">${e.location ?? ''}</td>
    </tr>`).join('')}
    </tbody>
  </table>`;
}

function followupTable(rows) {
  if (!rows.length) return '<p class="empty">No overdue follow-ups.</p>';
  return `<table>
    <thead><tr><th>Subject</th><th>To</th><th>Days Ago</th></tr></thead>
    <tbody>
    ${rows.map(r => `<tr>
      <td>${r.subject ?? '—'}</td>
      <td style="font-size:12px;color:#555">${r.to ?? '—'}</td>
      <td><span style="color:#a00;font-weight:600">${r.days}d</span></td>
    </tr>`).join('')}
    </tbody>
  </table>`;
}

// ── Teams message (plain text, short) ────────────────────────────────────────

function buildTeamsMessage(stats, calendar, followups) {
  const dateStr = formatDateLong();
  const lines = [`📬 Morning Brief — ${dateStr}`, ''];

  // Email summary
  lines.push(`📧 Inbox (last 24h): ${stats.total} emails`);
  if (stats.p1.length) lines.push(`   🔴 Respond Today: ${stats.p1.length}`);
  if (stats.p2.length) lines.push(`   🟡 This Week: ${stats.p2.length}`);
  if (stats.p3.length) lines.push(`   🟢 Filed/FYI: ${stats.p3.length}`);

  // P1 detail (first 5)
  if (stats.p1.length) {
    lines.push('');
    lines.push('🔴 Respond Today:');
    for (const e of stats.p1.slice(0, 5)) {
      const name = e.from_name || e.from_address || '?';
      const draft = e.draft_id ? ' ✍️' : '';
      lines.push(`  • [${name}] ${e.subject ?? '(no subject)'}${draft}`);
      if (e.intent) lines.push(`    → ${e.intent}`);
    }
    if (stats.p1.length > 5) lines.push(`  … and ${stats.p1.length - 5} more`);
  }

  // Calendar
  if (calendar.length) {
    lines.push('');
    lines.push('📅 Today:');
    for (const e of calendar) {
      lines.push(`  • ${formatTime(e.start)} — ${e.subject}`);
    }
  } else {
    lines.push('');
    lines.push('📅 Today: No meetings scheduled');
  }

  // Follow-ups
  if (followups.length) {
    lines.push('');
    lines.push(`🔄 Follow-ups Overdue (${followups.length}):`);
    for (const f of followups.slice(0, 5)) {
      lines.push(`  • ${f.subject} — sent ${f.days}d ago, no reply`);
    }
  }

  // Action items from P1 emails
  const actionItems = stats.p1
    .flatMap(e => e.action_items ?? [])
    .slice(0, 5);
  if (actionItems.length) {
    lines.push('');
    lines.push('⚡ Action Items:');
    for (const item of actionItems) lines.push(`  • ${item}`);
  }

  lines.push('');
  lines.push('─────────────────────────────────');
  lines.push('Full detail in your morning email.');

  return lines.join('\n');
}

// ── HTML email body ──────────────────────────────────────────────────────────

function buildEmailBody(stats, calendar, followups) {
  const dateStr = formatDateLong();
  const allEmails = [...stats.p1, ...stats.p2, ...stats.p3];

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="wrap">

  <div class="header">
    <h1>JRB Morning Brief</h1>
    <p>${dateStr}</p>
  </div>

  <!-- Email Triage Summary -->
  <div class="section">
    <div class="section-title">
      📧 Inbox — Last 24 Hours
      <span class="badge">${stats.total}</span>
      ${stats.p1.length ? `<span class="badge red">${stats.p1.length} need reply today</span>` : ''}
    </div>
    ${emailTriageTable(allEmails)}
  </div>

  <!-- Today's Calendar -->
  <div class="section">
    <div class="section-title">
      📅 Today's Calendar
      <span class="badge">${calendar.length} event${calendar.length !== 1 ? 's' : ''}</span>
    </div>
    ${calendarTable(calendar)}
  </div>

  <!-- Follow-ups -->
  <div class="section">
    <div class="section-title">
      🔄 Follow-ups Overdue
      ${followups.length ? `<span class="badge orange">${followups.length}</span>` : '<span class="badge green">0</span>'}
    </div>
    ${followupTable(followups)}
  </div>

  <!-- Action Items from P1 emails -->
  ${stats.p1.flatMap(e => e.action_items ?? []).length > 0 ? `
  <div class="section">
    <div class="section-title">⚡ Action Items Detected</div>
    <ul style="margin:0;padding:0 0 0 20px;font-size:13px">
      ${stats.p1.flatMap(e => e.action_items ?? []).map(item => `<li style="padding:3px 0">${item}</li>`).join('')}
    </ul>
  </div>` : ''}

  <div class="footer">
    JRB Executive Assistant &mdash; ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT
    &mdash; Reply drafts saved to your Drafts folder in Outlook
  </div>
</div>
</body></html>`;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateMorningBriefing() {
  logger.info('morning-briefing: generating');

  const [statsResult, calendarResult, followupsResult] = await Promise.allSettled([
    getEmailStats(),
    getTodayCalendar(),
    getOverdueFollowups(),
  ]);

  const stats    = statsResult.status    === 'fulfilled' ? statsResult.value    : { total: 0, p1: [], p2: [], p3: [], meetings: [] };
  const calendar = calendarResult.status === 'fulfilled' ? calendarResult.value : [];
  const followups = followupsResult.status === 'fulfilled' ? followupsResult.value : [];

  if (statsResult.status    === 'rejected') logger.error('morning-briefing: email stats failed',    { err: statsResult.reason?.message });
  if (calendarResult.status === 'rejected') logger.error('morning-briefing: calendar fetch failed', { err: calendarResult.reason?.message });
  if (followupsResult.status === 'rejected') logger.error('morning-briefing: followup query failed', { err: followupsResult.reason?.message });

  const teamsMessage = buildTeamsMessage(stats, calendar, followups);
  const emailBody    = buildEmailBody(stats, calendar, followups);
  const dateStr      = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const emailSubject = `Morning Brief — ${dateStr} | ${stats.p1.length} to respond, ${calendar.length} events`;

  logger.info('morning-briefing: complete', {
    p1: stats.p1.length, p2: stats.p2.length, p3: stats.p3.length,
    calendar: calendar.length, followups: followups.length,
  });

  return { teamsMessage, emailSubject, emailBody };
}
