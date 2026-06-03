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

// Inline style constants — no <style> block (email clients strip them)
const S = {
  body:        'margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;',
  outerTd:     'padding:24px 16px;',
  wrap:        'max-width:700px;background-color:#ffffff;border-radius:6px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.12);',
  header:      'background-color:#1a3a5c;padding:20px 28px;',
  headerTitle: 'margin:0;color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:0.5px;',
  headerDate:  'margin:5px 0 0 0;color:#aac4e0;font-size:12px;',
  section:     'padding:18px 28px;border-bottom:1px solid #eeeeee;',
  sectionLast: 'padding:18px 28px;',
  sTitle:      'margin:0 0 0 0;font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:0.6px;color:#555555;',
  badge:       'display:inline-block;background-color:#1a3a5c;color:#ffffff;border-radius:10px;padding:1px 9px;font-size:11px;font-weight:600;margin-left:8px;vertical-align:middle;',
  badgeRed:    'display:inline-block;background-color:#aa0000;color:#ffffff;border-radius:10px;padding:1px 9px;font-size:11px;font-weight:600;margin-left:4px;vertical-align:middle;',
  badgeOrange: 'display:inline-block;background-color:#c96800;color:#ffffff;border-radius:10px;padding:1px 9px;font-size:11px;font-weight:600;margin-left:8px;vertical-align:middle;',
  badgeGreen:  'display:inline-block;background-color:#1a7a3c;color:#ffffff;border-radius:10px;padding:1px 9px;font-size:11px;font-weight:600;margin-left:8px;vertical-align:middle;',
  table:       'margin-top:12px;border-collapse:collapse;font-size:13px;width:100%;',
  th:          'padding:7px 10px;text-align:left;font-weight:600;color:#444444;border-bottom:2px solid #dde3ea;background-color:#f0f4f8;',
  thNowrap:    'padding:7px 10px;text-align:left;font-weight:600;color:#444444;border-bottom:2px solid #dde3ea;background-color:#f0f4f8;white-space:nowrap;',
  td:          'padding:7px 10px;border-bottom:1px solid #f0f0f0;vertical-align:top;',
  tdLast:      'padding:7px 10px;vertical-align:top;',
  pillRed:     'display:inline-block;background-color:#fee2e2;color:#aa0000;border-radius:10px;padding:2px 9px;font-size:11px;font-weight:600;white-space:nowrap;',
  pillOrange:  'display:inline-block;background-color:#fff3cd;color:#856404;border-radius:10px;padding:2px 9px;font-size:11px;font-weight:600;white-space:nowrap;',
  pillGreen:   'display:inline-block;background-color:#d1fae5;color:#065f46;border-radius:10px;padding:2px 9px;font-size:11px;font-weight:600;white-space:nowrap;',
  empty:       'margin:6px 0 0 0;color:#888888;font-size:13px;',
  footer:      'background-color:#f8f9fa;padding:12px 28px;border-top:1px solid #eeeeee;',
  footerText:  'margin:0;font-size:11px;color:#888888;text-align:center;line-height:1.6;',
  draftNote:   'font-size:11px;color:#555555;font-style:italic;white-space:nowrap;',
};

// ── HTML builders (fully inline styles — no class refs) ────────────────────────

function priorityPill(priority) {
  const map = {
    p1: [S.pillRed,    'Respond Today'],
    p2: [S.pillOrange, 'This Week'],
    p3: [S.pillGreen,  'Filed/FYI'],
  };
  const [style, label] = map[priority] ?? [S.pillGreen, priority];
  return `<span style="${style}">${label}</span>`;
}

function emailTriageTable(rows) {
  if (!rows.length) return `<p style="${S.empty}">None in the last 24 hours.</p>`;
  const bodyRows = rows.map((r, i) => {
    const isLast = i === rows.length - 1;
    const tdStyle = isLast ? S.tdLast : S.td;
    const fromHtml = r.from_name
      ? `${r.from_name}<br><span style="color:#888888;font-size:11px;">${r.from_address}</span>`
      : (r.from_address ?? '—');
    const indicators = [
      r.draft_id        ? `<span style="${S.draftNote}">✍️ draft ready</span>` : '',
      r.meeting_detected ? `<span style="font-size:12px;">📅</span>` : '',
    ].join('');
    return `<tr>
      <td style="${tdStyle}">${priorityPill(r.priority)}</td>
      <td style="${tdStyle}white-space:nowrap;">${fromHtml}</td>
      <td style="${tdStyle}">${r.subject ?? '—'}</td>
      <td style="${tdStyle}color:#555555;font-size:12px;">${r.intent ?? ''}</td>
      <td style="${tdStyle}">${indicators}</td>
    </tr>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${S.table}">
    <thead><tr>
      <th style="${S.thNowrap}">Priority</th>
      <th style="${S.th}">From</th>
      <th style="${S.th}">Subject</th>
      <th style="${S.th}">Intent</th>
      <th style="${S.th}"></th>
    </tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>`;
}

function calendarTable(events) {
  if (!events.length) return `<p style="${S.empty}">Nothing scheduled today.</p>`;
  const bodyRows = events.map((e, i) => {
    const isLast = i === events.length - 1;
    const tdStyle = isLast ? S.tdLast : S.td;
    return `<tr>
      <td style="${tdStyle}font-weight:600;white-space:nowrap;font-family:'Courier New',monospace;">${formatTime(e.start)}</td>
      <td style="${tdStyle}">${e.subject ?? '—'}</td>
      <td style="${tdStyle}color:#555555;font-size:12px;">${e.location ?? ''}</td>
    </tr>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${S.table}">
    <thead><tr>
      <th style="${S.thNowrap}">Time</th>
      <th style="${S.th}">Event</th>
      <th style="${S.th}">Location</th>
    </tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>`;
}

function followupTable(rows) {
  if (!rows.length) return `<p style="${S.empty}">No overdue follow-ups.</p>`;
  const bodyRows = rows.map((r, i) => {
    const isLast = i === rows.length - 1;
    const tdStyle = isLast ? S.tdLast : S.td;
    return `<tr>
      <td style="${tdStyle}">${r.subject ?? '—'}</td>
      <td style="${tdStyle}font-size:12px;color:#555555;">${r.to ?? '—'}</td>
      <td style="${tdStyle}"><span style="color:#aa0000;font-weight:bold;">${r.days}d</span></td>
    </tr>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${S.table}">
    <thead><tr>
      <th style="${S.th}">Subject</th>
      <th style="${S.th}">To</th>
      <th style="${S.th}">Days Ago</th>
    </tr></thead>
    <tbody>${bodyRows}</tbody>
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

// ── HTML email body (table-based, fully inline — survives all email clients) ──

function buildEmailBody(stats, calendar, followups) {
  const dateStr   = formatDateLong();
  const allEmails = [...stats.p1, ...stats.p2, ...stats.p3];
  const actionItems = stats.p1.flatMap(e => e.action_items ?? []);
  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });

  // Section: Inbox
  const inboxBadges = [
    `<span style="${S.badge}">${stats.total}</span>`,
    stats.p1.length ? `<span style="${S.badgeRed}">${stats.p1.length} need reply today</span>` : '',
  ].join('');
  const inboxSection = `<td style="${S.section}">
    <p style="${S.sTitle}display:inline;">📧 Inbox — Last 24 Hours</p>${inboxBadges}
    ${emailTriageTable(allEmails)}
  </td>`;

  // Section: Calendar
  const calBadge = `<span style="${S.badge}">${calendar.length} event${calendar.length !== 1 ? 's' : ''}</span>`;
  const calSection = `<td style="${S.section}">
    <p style="${S.sTitle}display:inline;">📅 Today's Calendar</p>${calBadge}
    ${calendarTable(calendar)}
  </td>`;

  // Section: Follow-ups
  const fuBadge = followups.length
    ? `<span style="${S.badgeOrange}">${followups.length}</span>`
    : `<span style="${S.badgeGreen}">0</span>`;
  const fuStyle = actionItems.length ? S.section : S.sectionLast;
  const fuSection = `<td style="${fuStyle}">
    <p style="${S.sTitle}display:inline;">🔄 Follow-ups Overdue</p>${fuBadge}
    ${followupTable(followups)}
  </td>`;

  // Section: Action Items (conditional)
  const actionSection = actionItems.length ? `<tr><td style="${S.sectionLast}">
    <p style="${S.sTitle}margin-bottom:10px;">⚡ Action Items Detected</p>
    <ul style="margin:0;padding:0 0 0 20px;">
      ${actionItems.map(item => `<li style="font-size:13px;color:#444444;line-height:1.7;margin-bottom:6px;">${item}</li>`).join('')}
    </ul>
  </td></tr>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>JRB Morning Brief</title></head>
<body style="${S.body}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;">
    <tr>
      <td align="center" style="${S.outerTd}">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${S.wrap}">

          <!-- Header -->
          <tr>
            <td style="${S.header}">
              <p style="${S.headerTitle}">JRB Morning Brief</p>
              <p style="${S.headerDate}">${dateStr}</p>
            </td>
          </tr>

          <!-- Inbox -->
          <tr>${inboxSection}</tr>

          <!-- Calendar -->
          <tr>${calSection}</tr>

          <!-- Follow-ups -->
          <tr>${fuSection}</tr>

          <!-- Action Items -->
          ${actionSection}

          <!-- Footer -->
          <tr>
            <td style="${S.footer}">
              <p style="${S.footerText}">JRB Executive Assistant &mdash; ${timestamp} CT &mdash; Reply drafts saved to your Drafts folder in Outlook</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
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
