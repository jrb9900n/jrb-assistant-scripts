// tools/impl/monthly-transport-package.js — one combined monthly email for the transport
// accounting reports
//
// Michael asked (2026-08-19) for a single email per month, sent the 1st (once GPS data for
// the prior month is finalized), with the Transport and Management reports as two .xlsx
// attachments plus a summary body — replacing the two separate emails this project started
// with. Both attachments are priced from one shared FleetSharp pull/classification so the
// two reports can never drift against each other from being fetched at slightly different
// times.

import { pullAndClassify, computeTransportInvoiceTotals, RATE_CONFIG } from './transport-accounting-report.js';
import { computeManagementEmploymentTotals, ROUNDTRIP_HOURS, MARKUP_RATE } from './management-employment-report.js';
import { sendEmail } from './m365.js';
import { logger } from '../../core/logger.js';
import XLSX from 'xlsx';

function monthLabel(startDate) {
  const d = new Date(`${startDate}T00:00:00`);
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

function formatCurrency(n) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function buildReportWorkbookBuffer(sheetName, aoa) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function buildTransportWorkbookBuffer(report, label) {
  const aoa = [
    [`Transport Accounting Report — ${label}`],
    [`Rates: $${RATE_CONFIG.shortDayRate}/short day, $${RATE_CONFIG.longDayRate}/long day (50-mile radius cutoff)`],
    [],
    ['Truck', 'Short Days', 'Long Days', 'Amount', 'Long Trip Date(s)'],
    ...report.lines.map(l => [l.truck, l.shortDayCount, l.longDayCount, l.amount, l.longDates.join(', ')]),
    [],
    ['Total', report.totalShort, report.totalLong, report.totalAmount],
  ];
  return buildReportWorkbookBuffer('Transport', aoa);
}

function buildManagementWorkbookBuffer(report, label) {
  const aoa = [
    [`Management & Employment Report — ${label}`],
    [`Roundtrip hours: ${ROUNDTRIP_HOURS.short}hr short / ${ROUNDTRIP_HOURS.long}hr long`],
    [],
    ['Truck', 'Rate', 'Short Days', 'Long Days', 'Amount'],
    ...report.lines.map(l => [l.truck, l.rate, l.shortDayCount, l.longDayCount, l.total]),
    [],
    ['', '', '', 'Subtotal', report.subtotal],
    ['', '', '', `Markup (${(MARKUP_RATE * 100).toFixed(0)}%)`, report.markup],
    ['', '', '', 'Period Invoice Total', report.grandTotal],
  ];
  return buildReportWorkbookBuffer('Management', aoa);
}

function buildSummaryEmailHtml({ label, transport, management }) {
  const unmapped = management.lines.filter(l => l.unmapped);
  const unmappedNote = unmapped.length > 0 ? `
    <p style="font-size:12px;color:#b45309;margin-top:14px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:10px 14px;">
      <strong>Needs a rate assignment:</strong> ${unmapped.map(l => l.truck).join(', ')} — add to TRUCK_RATE_ASSIGNMENT
      in management-employment-report.js. Excluded from the Management total below.
    </p>` : '';

  return `
    <div style="font-family:Arial,sans-serif;color:#1f2937;max-width:640px;">
      <div style="background:#1a1a2e;color:#fff;padding:20px 24px;">
        <h2 style="margin:0;font-size:20px;">Transport &amp; Management Report</h2>
        <p style="margin:4px 0 0 0;color:#cbd5e1;font-size:13px;">${label}</p>
      </div>
      <div style="padding:20px 24px;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:6px 0;">Short trip-days</td><td style="padding:6px 0;text-align:right;">${transport.totalShort}</td></tr>
          <tr><td style="padding:6px 0;${transport.totalLong > 0 ? 'color:#b45309;font-weight:600;' : ''}">Long trip-days</td><td style="padding:6px 0;text-align:right;${transport.totalLong > 0 ? 'color:#b45309;font-weight:600;' : ''}">${transport.totalLong}</td></tr>
          <tr style="background:#1a1a2e;color:#fff;font-weight:600;"><td style="padding:10px 12px;">Transport Total</td><td style="padding:10px 12px;text-align:right;">${formatCurrency(transport.totalAmount)}</td></tr>
          <tr><td style="padding:14px 0 2px;">Management Subtotal</td><td style="padding:14px 0 2px;text-align:right;">${formatCurrency(management.subtotal)}</td></tr>
          <tr><td style="padding:2px 0;">Markup (${(MARKUP_RATE * 100).toFixed(0)}%)</td><td style="padding:2px 0;text-align:right;">${formatCurrency(management.markup)}</td></tr>
          <tr style="background:#1a1a2e;color:#fff;font-weight:600;"><td style="padding:10px 12px;">Management Total</td><td style="padding:10px 12px;text-align:right;">${formatCurrency(management.grandTotal)}</td></tr>
        </table>
        ${unmappedNote}
        <p style="font-size:12px;color:#6b7280;margin-top:16px;">
          Two attachments: <strong>Transport</strong> (flat $${RATE_CONFIG.shortDayRate}/short, $${RATE_CONFIG.longDayRate}/long day
          rate) and <strong>Management</strong> (per-person hourly rate × roundtrip hours, plus ${(MARKUP_RATE * 100).toFixed(0)}% markup) —
          same underlying FleetSharp Short/Long day counts, priced two ways, matching your existing spreadsheets.
        </p>
      </div>
    </div>
  `;
}

/**
 * Generates and emails the combined monthly transport package: one FleetSharp pull, both
 * reports computed from the same classified data, sent as two .xlsx attachments on one
 * email with a summary body. Called by the monthly cron job with the prior full calendar
 * month.
 */
export async function runMonthlyTransportPackage({ startDate, endDate }) {
  // Does NOT close the FleetSharp session when done — tools/impl/fleetsharp.js keeps a
  // single shared browser/page open for its full 4-hour SESSION_TTL_MS, reused by every
  // caller (fleetops_odometer_sync, interactive fleetsharp_get_* agent tools, etc.).
  // Closing it here would yank that session out from under any concurrent caller. Only
  // the process-level shutdown handler in scheduler/cron.js should ever close it.
  const perTruck = await pullAndClassify({ startDate, endDate });
  const transport = computeTransportInvoiceTotals(perTruck);
  const management = computeManagementEmploymentTotals(perTruck);
  const label = monthLabel(startDate);

  await sendEmail({
    to: ['michael@jrboehlke.com'],
    subject: `Transport & Management Report — ${label}`,
    body: buildSummaryEmailHtml({ label, transport, management }),
    attachments: [
      {
        name: `${label} Transport.xlsx`,
        content: buildTransportWorkbookBuffer(transport, label),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      {
        name: `${label} Management.xlsx`,
        content: buildManagementWorkbookBuffer(management, label),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    ],
  });

  logger.info('monthly_transport_package complete', {
    startDate, endDate,
    totalShort: transport.totalShort, totalLong: transport.totalLong, transportTotal: transport.totalAmount,
    managementSubtotal: management.subtotal, managementMarkup: management.markup, managementGrandTotal: management.grandTotal,
  });

  return { startDate, endDate, transport, management };
}
