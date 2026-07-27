// tools/impl/commission-report.js — Quarterly PM commission email report
//
// Runs the commission engine, then emails Michael (and the accountant, once
// ACCOUNTANT_EMAIL is configured — see CLAUDE.md) a report with three sections:
//   - Payable this quarter (cash-basis — ready for payroll, EXCEPT rows marked
//     with a subcontractor asterisk — see note below)
//   - Accrued this quarter (GAAP basis — for the accountant's books)
//   - Needs review (renewal candidates, unconfirmed subcontractor bill matches,
//     jobs with no PM assignment or no active commission plan, processing errors)
// See commission-engine.js for the accrual/payable/renewal/subcontractor-hold
// semantics this report assumes. HTML template matches weekly-finance-report.js
// (Michael's confirmed preferred format — navy #1a1a2e header, Arial, dark total rows).

import { createClient } from '@supabase/supabase-js';
import { sendEmail } from './m365.js';
import { runCommissionEngine, currentQuarter } from './commission-engine.js';
import { logger } from '../../core/logger.js';

const fleetops = createClient(
  process.env.FLEETOPS_SUPABASE_URL,
  process.env.FLEETOPS_SUPABASE_SERVICE_KEY
);

const f$ = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function sectionHeader(title, count) {
  const badge = count != null
    ? ` <span style="background-color:#1a1a2e;color:#ffffff;border-radius:10px;padding:1px 8px;font-size:11px;">${count}</span>`
    : '';
  return `<p style="margin:28px 0 10px 0;font-size:13px;font-weight:bold;text-transform:uppercase;letter-spacing:0.8px;color:#888888;border-bottom:1px solid #e8e8e8;padding-bottom:6px;">${title}${badge}</p>`;
}

function alertBox(color, borderColor, title, rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${color};border-left:4px solid ${borderColor};border-radius:4px;margin-bottom:16px;"><tr><td style="padding:12px 16px;"><p style="margin:0 0 8px 0;font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:0.8px;color:${borderColor};">${title}</p>${rows}</td></tr></table>`;
}

function ledgerTable(rows, amountKey) {
  if (!rows.length) return `<p style="margin:0 0 10px;font-size:13px;color:#888888;font-style:italic;">None this run.</p>`;
  const body = rows.map((r, i) => `
    <tr style="background-color:${i % 2 ? '#f8f8f8' : '#ffffff'};">
      <td style="padding:5px 8px;font-size:13px;color:#333333;">${r.employee_name}</td>
      <td style="padding:5px 8px;font-size:13px;color:#333333;">${r.client_name ?? '—'}${r.involves_subcontractor ? ' <span style="color:#b35900;">*</span>' : ''}</td>
      <td style="padding:5px 8px;font-size:12px;color:#888888;">${r.category === 'maintenance_snow' ? 'Maintenance/Snow' : 'Self-Performed'}</td>
      <td style="padding:5px 8px;font-size:13px;color:#1a1a2e;font-weight:bold;text-align:right;white-space:nowrap;">${f$(r[amountKey])}</td>
    </tr>`).join('');
  const total = rows.reduce((s, r) => s + Number(r[amountKey] || 0), 0);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:6px;">
    <tr>
      <td style="padding:0 8px 4px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;">PM</td>
      <td style="padding:0 8px 4px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;">Client</td>
      <td style="padding:0 8px 4px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;">Category</td>
      <td style="padding:0 8px 4px;font-size:11px;font-weight:bold;color:#888888;text-transform:uppercase;text-align:right;">Amount</td>
    </tr>
    ${body}
    <tr style="background-color:#1a1a2e;">
      <td colspan="3" style="padding:8px;font-size:13px;color:#aaaacc;">Total</td>
      <td style="padding:8px;font-size:15px;color:#ffffff;font-weight:bold;text-align:right;">${f$(total)}</td>
    </tr>
  </table>
  <p style="margin:2px 0 14px;font-size:11px;color:#888888;">* involves a subcontractor — see flagged bill matches below before treating as final</p>`;
}

function reviewList(items) {
  if (!items.length) return '';
  return `<ul style="margin:0 0 14px;padding-left:18px;">${items.map(i => `<li style="font-size:13px;color:#533f03;margin-bottom:4px;">${i}</li>`).join('')}</ul>`;
}

export async function generateCommissionReport({ quarter, engineResult } = {}) {
  const targetQuarter = quarter || currentQuarter();
  const result = engineResult || await runCommissionEngine({ quarter: targetQuarter });

  const [payableResult, accruedResult, renewalPendingResult, quarterLedgerIdsResult] = await Promise.all([
    fleetops.from('commission_ledger').select('*').eq('quarter', targetQuarter).gt('payable_commission', 0).order('employee_name'),
    fleetops.from('commission_ledger').select('*').eq('quarter', targetQuarter).gt('accrued_commission', 0).order('employee_name'),
    fleetops.from('commission_ledger').select('*').eq('quarter', targetQuarter).eq('renewal_flag', true).is('renewal_confirmed', null),
    // Every ledger row for this quarter, regardless of dollar amount — a row can
    // legitimately be $0/$0 (already accrued earlier, no new cash this run) and
    // still have a real unconfirmed subcontractor flag that needs surfacing.
    fleetops.from('commission_ledger').select('id, client_name, employee_name').eq('quarter', targetQuarter),
  ]);

  for (const [label, r] of [
    ['payable', payableResult], ['accrued', accruedResult],
    ['renewalPending', renewalPendingResult], ['quarterLedgerIds', quarterLedgerIdsResult],
  ]) {
    if (r.error) throw new Error(`generateCommissionReport ${label} query failed: ${r.error.message}`);
  }

  const payableRows = payableResult.data ?? [];
  const accruedRows = accruedResult.data ?? [];
  const renewalPending = renewalPendingResult.data ?? [];
  const quarterLedger = quarterLedgerIdsResult.data ?? [];

  const unconfirmedFlagsResult = quarterLedger.length
    ? await fleetops.from('commission_sub_bill_flags').select('*').in('ledger_id', quarterLedger.map(r => r.id)).eq('confirmed', false)
    : { data: [] };
  if (unconfirmedFlagsResult.error) throw new Error(`generateCommissionReport unconfirmedFlags query failed: ${unconfirmedFlagsResult.error.message}`);

  const ledgerById = new Map(quarterLedger.map(r => [r.id, r]));
  const relevantFlags = unconfirmedFlagsResult.data ?? [];

  const payableTotal = payableRows.reduce((s, r) => s + Number(r.payable_commission || 0), 0);
  const accruedTotal = accruedRows.reduce((s, r) => s + Number(r.accrued_commission || 0), 0);

  const reviewItems = [
    ...renewalPending.map(r => `${r.client_name ?? r.sa_reference} (${r.employee_name}) — looks like a contract renewal, confirm new/expanded vs. renewal before it's paid`),
    ...relevantFlags.map(f => {
      const ledger = ledgerById.get(f.ledger_id);
      return `${ledger?.client_name ?? '—'} (${ledger?.employee_name ?? '—'}) — candidate subcontractor bill: ${f.vendor_name ?? 'unknown vendor'}, ${f$(f.bill_amount)} on ${f.bill_date} (${f.match_confidence} confidence) — confirm before applying the 20% GP cap`;
    }),
    ...result.unassignedJobs.map(j => `${j.clientName ?? j.saReference} (${j.category === 'maintenance_snow' ? 'Maintenance/Snow' : 'Self-Performed'}, ${f$(j.value)}) — no PM assigned in pm_job_assignments`),
    ...result.unplannedJobs.map(j => `${j.clientName ?? j.saReference} — assigned to ${j.employeeName}, but no active commission plan covers this job's date`),
    ...(result.processingErrors ?? []).map(e => `${e.clientName ?? e.saReference} — SKIPPED this run due to a query error (${e.error}); needs a re-run`),
  ];

  const today = new Date().toISOString().split('T')[0];

  let html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>PM Commission Report ${targetQuarter}</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" style="max-width:620px;background-color:#ffffff;border-radius:6px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

<!-- HEADER -->
<tr><td style="background-color:#1a1a2e;padding:24px 32px;">
  <p style="margin:0;color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:0.5px;">J.R. Boehlke, LLC</p>
  <p style="margin:4px 0 0;color:#aaaacc;font-size:13px;">PM Commission Report &nbsp;|&nbsp; ${targetQuarter}</p>
</td></tr>

<!-- BODY -->
<tr><td style="padding:28px 32px;">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f4ff;border-radius:4px;margin-bottom:20px;">
<tr>
  <td style="padding:14px 16px;text-align:center;border-right:1px solid #d8e0f0;">
    <p style="margin:0;font-size:20px;font-weight:bold;color:#1a6e1a;">${f$(payableTotal)}</p>
    <p style="margin:2px 0 0;font-size:11px;color:#555577;text-transform:uppercase;letter-spacing:0.6px;">Payable</p>
  </td>
  <td style="padding:14px 16px;text-align:center;border-right:1px solid #d8e0f0;">
    <p style="margin:0;font-size:20px;font-weight:bold;color:#1a1a2e;">${f$(accruedTotal)}</p>
    <p style="margin:2px 0 0;font-size:11px;color:#555577;text-transform:uppercase;letter-spacing:0.6px;">Newly Accrued</p>
  </td>
  <td style="padding:14px 16px;text-align:center;">
    <p style="margin:0;font-size:20px;font-weight:bold;color:${reviewItems.length ? '#b35900' : '#333'};">${reviewItems.length}</p>
    <p style="margin:2px 0 0;font-size:11px;color:#555577;text-transform:uppercase;letter-spacing:0.6px;">Need Review</p>
  </td>
</tr></table>

<p style="margin:0 0 20px;font-size:12px;color:#888888;">Payable is cash-basis — prorated by newly-collected cash since the last run, withheld entirely for pending renewals or unconfirmed subcontractor involvement. Accrued is GAAP-basis — the full commission recognized once, in the earliest quarter a job/contract is seen, for the accountant's books.</p>`;

  html += sectionHeader('Payable This Quarter', payableRows.length);
  html += ledgerTable(payableRows, 'payable_commission');

  html += sectionHeader('Newly Accrued (GAAP)', accruedRows.length);
  html += ledgerTable(accruedRows, 'accrued_commission');

  if (reviewItems.length) {
    html += sectionHeader('Needs Review', reviewItems.length);
    html += alertBox('#fff3cd', '#e6a817', `${reviewItems.length} item${reviewItems.length !== 1 ? 's' : ''} pending confirmation`, reviewList(reviewItems));
  }

  if (!payableRows.length && !accruedRows.length && !reviewItems.length) {
    html += `<p style="margin:16px 0;font-size:14px;color:#888888;">No commission activity this run.</p>`;
  }

  html += `
</td></tr>

<!-- FOOTER -->
<tr><td style="background-color:#f8f8f8;padding:14px 32px;border-top:1px solid #e8e8e8;">
  <p style="margin:0;font-size:12px;color:#888888;line-height:1.6;">J.R. Boehlke, LLC &nbsp;|&nbsp; Milwaukee, WI &nbsp;|&nbsp; ${today}</p>
</td></tr>

</table></td></tr></table>
</body></html>`;

  const subject = `PM Commission Report — ${targetQuarter} — ${f$(payableTotal)} payable`;

  const recipients = ['michael@jrboehlke.com'];
  if (process.env.ACCOUNTANT_EMAIL) {
    recipients.push(process.env.ACCOUNTANT_EMAIL);
  } else {
    logger.warn('ACCOUNTANT_EMAIL not configured — commission report sent to Michael only');
  }

  return { quarter: targetQuarter, subject, body: html, recipients, payableTotal, accruedTotal, reviewCount: reviewItems.length };
}

// Builds the report (see generateCommissionReport) and sends it. Split out so the
// report body can be generated and inspected independently of actually emailing it.
export async function generateAndSendCommissionReport(opts) {
  const report = await generateCommissionReport(opts);
  await sendEmail({ to: report.recipients, subject: report.subject, body: report.body });
  logger.info('Commission report sent', {
    quarter: report.quarter, recipients: report.recipients,
    payableTotal: report.payableTotal, accruedTotal: report.accruedTotal, reviewCount: report.reviewCount,
  });
  return report;
}
