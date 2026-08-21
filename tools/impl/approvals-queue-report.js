// tools/impl/approvals-queue-report.js
// Approvals Queue Report — weekdays 11:15 AM, ahead of the 11:30 AM-12:00 PM
// Direct Report / Approval Window calendar block. Same code-style/template
// conventions as ar-collections-report.js (see ar-report-helpers.js).
//
// v1 scope: expense-report approvals only. QBO payroll time-off requests were
// investigated (`qbo_payroll_get_company_timeoff_details` /
// `qbo_payroll_get_employee_timeoff_assignments`) and are NOT wired up here:
//   1. This session's QuickBooks MCP connector grant returned insufficient_scope
//      for both payroll timeoff tools ("allowed tools: ['qbo_contact_search_customer']")
//      -- they exist in the tool schema but aren't reachable through the
//      connector as currently authorized.
//   2. tools/impl/quickbooks.js (JRBAgent's own direct QBO API integration,
//      QB_CLIENT_ID/QB_CLIENT_SECRET/QB_REFRESH_TOKEN) has no payroll code or
//      scope at all -- it only ever talks to the Accounting API.
//   3. No other timeoff/payroll-approval data source exists anywhere in this
//      repo (confirmed via a full-repo search).
// Nothing here fabricates a time-off queue -- if that scope gap ever closes,
// add a second gatherer + section rather than guessing at content.
//
// Empty-queue design decision: SKIP sending when the queue is completely
// empty (no rows at all across every bucket below), logging what would have
// been sent instead. Unlike the weekly finance/AR reports, this one runs
// every weekday -- an "all clear" email five days a week ahead of every
// approval-window block would train Michael to stop opening it. A non-empty
// queue always sends, even if every row is low-urgency.

import { logger } from '../../core/logger.js';
import { sendEmail } from './m365.js';
import { getPendingApprovalsQueue, MAX_REMINDERS } from './expense.js';
import { f$, fD, sectionHeader, alertBox } from './ar-report-helpers.js';

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Vendor/card/employee-name text ultimately originates from Chase's bank-alert
// merchant string (loosely controlled, external) and gets interpolated
// directly into this email's HTML -- escape before rendering.
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
}

function ageDays(createdAt) {
  if (!createdAt) return null;
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400000);
}

function rowLabel(r) {
  return esc(r.employee_name || (r.card_last_four ? `Card ...${r.card_last_four}` : 'Unknown employee'));
}

function buildRowsTable(rows, { showReminders = false, showAsset = false } = {}) {
  let html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
  <tr style="background-color:#f8f8f8;">
    <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;">Employee</td>
    <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;">Vendor</td>
    <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Amount</td>
    <td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Age</td>
    ${showReminders ? `<td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Reminders</td>` : ''}
    ${showAsset ? `<td style="padding:5px 6px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;">Asset / Job</td>` : ''}
  </tr>`;
  rows.forEach((r, i) => {
    const days = ageDays(r.created_at);
    html += `<tr style="background-color:${i % 2 ? '#f8f8f8' : '#ffffff'};">
      <td style="padding:6px 6px;font-size:13px;color:#333333;">${rowLabel(r)}</td>
      <td style="padding:6px 6px;font-size:13px;color:#333333;">${esc(r.vendor) || '—'}</td>
      <td style="padding:6px 6px;font-size:13px;font-weight:bold;color:#333333;text-align:right;white-space:nowrap;">${f$(r.amount)}</td>
      <td style="padding:6px 6px;font-size:12px;color:#888888;text-align:right;white-space:nowrap;">${days === null ? '—' : days + 'd'}</td>
      ${showReminders ? `<td style="padding:6px 6px;font-size:12px;color:#888888;text-align:right;">${r.reminder_count ?? 0}/${MAX_REMINDERS} sent</td>` : ''}
      ${showAsset ? `<td style="padding:6px 6px;font-size:12px;color:#888888;">${esc(r.asset_id || r.job_number) || '—'}</td>` : ''}
    </tr>`;
  });
  html += `</table>`;
  return html;
}

function buildEmail({ queue, today }) {
  const { awaitingIdentification, noAutomation, stalled, awaitingEmployee, awaitingMaintenanceLog, flagged, total } = queue;

  let html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Approvals Queue ${today}</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" style="max-width:620px;background-color:#ffffff;border-radius:6px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

<!-- HEADER -->
<tr><td style="background-color:#1a1a2e;padding:24px 32px;">
  <p style="margin:0;color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:0.5px;">J.R. Boehlke, LLC</p>
  <p style="margin:4px 0 0;color:#aaaacc;font-size:13px;">Approvals Queue &nbsp;|&nbsp; ${fD(today)}</p>
</td></tr>

<!-- BODY -->
<tr><td style="padding:28px 32px;">`;

  html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eef1fa;border-radius:4px;margin-bottom:6px;"><tr>
  <td style="padding:14px 16px;text-align:center;">
    <p style="margin:0;font-size:20px;font-weight:bold;color:#1a1a2e;">${total}</p>
    <p style="margin:2px 0 0;font-size:11px;color:#555577;text-transform:uppercase;letter-spacing:0.6px;">Open Item${total === 1 ? '' : 's'}</p>
  </td>
</tr></table>`;

  // Ordered most- to least-urgent.
  if (awaitingIdentification.length) {
    html += alertBox('#fff0f0', '#c0392b', `${awaitingIdentification.length} Charge${awaitingIdentification.length > 1 ? 's' : ''} — Can't Even Identify the Card`,
      `<p style="margin:0 0 8px 0;font-size:12px;color:#7a2020;">No matching card on file for these charges -- nobody's been notified yet. Needs manual identification before anything else can happen.</p>${buildRowsTable(awaitingIdentification)}`);
  }

  if (noAutomation.length) {
    html += alertBox('#fff0f0', '#c0392b', `${noAutomation.length} Report${noAutomation.length > 1 ? 's' : ''} — No Phone on File, Needs Manual Follow-Up`,
      `<p style="margin:0 0 8px 0;font-size:12px;color:#7a2020;">No SMS was ever sent for these (missing phone number or a failed send) -- the automated reminder cycle will never run on them. Follow up with the employee directly.</p>${buildRowsTable(noAutomation)}`);
  }

  if (stalled.length) {
    html += alertBox('#fff0f0', '#c0392b', `${stalled.length} Stalled — Needs Your Decision`,
      `<p style="margin:0 0 8px 0;font-size:12px;color:#7a2020;">Auto-reminders to the employee are exhausted (${MAX_REMINDERS} sent, no response). Write off, follow up personally, or escalate.</p>${buildRowsTable(stalled, { showReminders: true })}`);
  }

  html += sectionHeader('Awaiting Employee Submission');
  if (!awaitingEmployee.length) {
    html += `<p style="margin:0 0 16px;font-size:13px;color:#888888;font-style:italic;">None — nothing currently mid-reminder-cycle.</p>`;
  } else {
    html += `<p style="margin:0 0 8px;font-size:12px;color:#888888;">Automated SMS reminders are still active on these — informational only, no action needed yet.</p>`;
    html += buildRowsTable(awaitingEmployee, { showReminders: true });
  }

  html += sectionHeader('Awaiting Maintenance Log Entry');
  if (!awaitingMaintenanceLog.length) {
    html += `<p style="margin:0 0 16px;font-size:13px;color:#888888;font-style:italic;">None.</p>`;
  } else {
    html += `<p style="margin:0 0 8px;font-size:12px;color:#888888;">Receipt submitted; employee still owes an asset maintenance log entry before this closes out.</p>`;
    html += buildRowsTable(awaitingMaintenanceLog, { showAsset: true });
  }

  if (flagged.length) {
    html += sectionHeader('Flagged for Review');
    html += buildRowsTable(flagged);
  }

  html += `<p style="margin:24px 0 0;font-size:11px;color:#aaaaaa;font-style:italic;">Not yet included: QBO payroll time-off requests — checked the QBO payroll MCP tools and JRBAgent's own QuickBooks integration; neither currently exposes a reachable time-off-approval data source (see approvals-queue-report.js header comment). Will be added if that changes.</p>`;

  html += `
</td></tr>
</table></td></tr></table>
</body></html>`;

  return html;
}

export async function generateAndSendApprovalsQueueReport() {
  const today = new Date().toISOString().slice(0, 10);
  const queue = await getPendingApprovalsQueue();

  if (queue.total === 0) {
    logger.info('approvals_queue_report: queue empty, skipping send', { today });
    return { today, sent: false, reason: 'empty_queue', total: 0 };
  }

  const body = buildEmail({ queue, today });
  const urgentCount = queue.awaitingIdentification.length + queue.noAutomation.length + queue.stalled.length;
  const subject = urgentCount
    ? `Approvals Queue — ${fD(today)} | ${urgentCount} need your attention`
    : `Approvals Queue — ${fD(today)} | ${queue.total} open item${queue.total === 1 ? '' : 's'}`;

  await sendEmail({
    to: ['michael@jrboehlke.com'],
    subject,
    body,
  });

  logger.info('approvals_queue_report: sent', {
    today,
    total: queue.total,
    awaitingIdentification: queue.awaitingIdentification.length,
    noAutomation: queue.noAutomation.length,
    stalled: queue.stalled.length,
    awaitingEmployee: queue.awaitingEmployee.length,
    awaitingMaintenanceLog: queue.awaitingMaintenanceLog.length,
    flagged: queue.flagged.length,
  });
  return { today, sent: true, total: queue.total, urgentCount };
}
