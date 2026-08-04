// tools/impl/commission-report.js — PM commission email report
//
// Runs the commission engine, then emails Michael (and the accountant, once
// ACCOUNTANT_EMAIL is configured — see CLAUDE.md) a report with three sections:
//   - Payable this quarter (cash-basis — ready for payroll, EXCEPT rows marked
//     with a subcontractor asterisk — see note below)
//   - Accrued this quarter (GAAP basis — for the accountant's books)
//   - Needs review (renewal candidates, unconfirmed subcontractor bill/line
//     matches, processing errors)
// See commission-engine.js for the accrual/payable/renewal/subcontractor-hold
// semantics this report assumes. HTML template matches weekly-finance-report.js
// (Michael's confirmed preferred format — navy #1a1a2e header, Arial, dark total rows).
//
// Runs monthly (see cron.js) even though payment stays quarterly per the
// Accountability Agreement — the `isFinal` flag distinguishes the quarter-end
// close (Jan/Apr/Jul/Oct, the actual payout figure) from the other 8 months'
// quarter-to-date tracking snapshots, so nobody mistakes a mid-quarter number
// for the final one.

import { createClient } from '@supabase/supabase-js';
import { sendEmail, draftEmail, getEmail, createReplyDraft, sendDraft } from './m365.js';
import { runCommissionEngine, currentQuarter, findUnmatchedWonEstimates } from './commission-engine.js';
import { sendProactiveMessage } from '../../teams/notify.js';
import { logger } from '../../core/logger.js';

const fleetops = createClient(
  process.env.FLEETOPS_SUPABASE_URL,
  process.env.FLEETOPS_SUPABASE_SERVICE_KEY
);

const f$ = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fD(d) {
  if (!d) return '—';
  // Some SA-sourced date fields are synced as free-form text and can carry a time
  // suffix (e.g. "7/15/2026 12:00:00 AM") rather than a clean YYYY-MM-DD — guard
  // against rendering the literal string "Invalid Date" in the email.
  const parsed = new Date(d + 'T12:00:00Z');
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
}

// Shortened per Michael's spec, 2026-08-04 (was the full Accountability
// Agreement phrasing — accurate but too long for a table column).
const CATEGORY_LABEL = {
  maintenance_snow: 'Contract',
  self_performed: 'Project',
};

function subcontractorLabel(r) {
  if (!r.involves_subcontractor) return 'No';
  return Number(r.unconfirmed_subcontracted_fraction) > 0 ? 'Yes — pending review' : 'Yes — confirmed';
}

function sectionHeader(title, count) {
  const badge = count != null
    ? ` <span style="background-color:#1a1a2e;color:#ffffff;border-radius:10px;padding:1px 8px;font-size:11px;">${count}</span>`
    : '';
  return `<p style="margin:28px 0 10px 0;font-size:13px;font-weight:bold;text-transform:uppercase;letter-spacing:0.8px;color:#888888;border-bottom:1px solid #e8e8e8;padding-bottom:6px;">${title}${badge}</p>`;
}

function alertBox(color, borderColor, title, rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${color};border-left:4px solid ${borderColor};border-radius:4px;margin-bottom:16px;"><tr><td style="padding:12px 16px;"><p style="margin:0 0 8px 0;font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:0.8px;color:${borderColor};">${title}</p>${rows}</td></tr></table>`;
}

const f_pct = n => `${(Number(n || 0) * 100).toFixed(1)}%`;

// No PM/employee column — Jarrett is currently the only employee with an active
// commission plan, so every row is his and a repeated name is just noise (per
// Michael, 2026-07-28: "No other employees earn commissions"). Revisit this if
// a second commissioned PM is ever added — rows for different employees would
// otherwise interleave in the same table with no way to tell them apart.
// Column order/set per Michael's spec, 2026-08-04.
const LEDGER_COLUMNS = [
  { label: 'Client', render: r => r.client_name ?? '—' },
  { label: 'Category', render: r => CATEGORY_LABEL[r.category] ?? r.category },
  { label: 'Line Item', render: r => r.line_item_names ?? '—' },
  { label: 'Estimate #', render: r => r.estimate_number ?? '—' },
  { label: 'Estimate Date', render: r => fD(r.estimate_date) },
  { label: 'Invoice #', render: r => r.invoice_number ?? '—' },
  { label: 'Invoice Date', render: r => fD(r.invoice_date) },
  { label: 'Invoice Amount', render: r => f$(r.invoiced_amount) },
  { label: 'Paid Date', render: r => fD(r.date_paid) },
  // The commission engine's payable/paid trigger comes from invoiced_amount
  // minus sa_invoices.invoice_balance (reliable, QBO-synced) -- NOT from
  // Paid Date (which comes from a separate, sparser sa_payment_applications/
  // sa_payments join, see fetchJobDetails in commission-engine.js). A row can
  // legitimately show real dollars here with "—" for Paid Date: that's a data-
  // linkage gap in what populates the date, not a sign commission is being
  // paid on unpaid work. This column is the actual proof cash was collected.
  { label: 'Paid Amount', render: r => f$(r.paid_amount) },
  { label: 'Subcontracted?', render: r => subcontractorLabel(r) },
  { label: 'Commission Rate', render: r => f_pct(r.commission_rate) },
];

// Excel-style banding: same client keeps the same shade across however many
// rows it has (Heather Kehr's 3 rows, Jason Carver's 4, etc.) instead of a
// plain alternating-by-row-index stripe, which visually chopped a single
// client's block up for no reason. Rows are already sorted by client first,
// so the band only needs to flip when client_name actually changes.
const BAND_COLORS = ['#ffffff', '#eef2f9'];
function bandColorsByRow(sortedRows) {
  let band = 0;
  return sortedRows.map((r, i) => {
    if (i > 0 && r.client_name !== sortedRows[i - 1].client_name) band = 1 - band;
    return BAND_COLORS[band];
  });
}

function sortByClientThenInvoiceDate(rows) {
  return [...rows].sort((a, b) => {
    const clientCmp = (a.client_name ?? '').localeCompare(b.client_name ?? '');
    if (clientCmp !== 0) return clientCmp;
    return (a.invoice_date ?? '').localeCompare(b.invoice_date ?? '');
  });
}

const GRID_BORDER = '1px solid #d5dae3';

function ledgerTable(rows, amountKey) {
  if (!rows.length) return `<p style="margin:0 0 10px;font-size:13px;color:#888888;font-style:italic;">None this run.</p>`;
  const sorted = sortByClientThenInvoiceDate(rows);
  const bandColors = bandColorsByRow(sorted);
  const headerCells = LEDGER_COLUMNS.map(c => `<td style="padding:5px 8px;font-size:11px;font-weight:bold;color:#ffffff;background-color:#3a3f5c;text-transform:uppercase;border:${GRID_BORDER};">${c.label}</td>`).join('')
    + `<td style="padding:5px 8px;font-size:11px;font-weight:bold;color:#ffffff;background-color:#3a3f5c;text-transform:uppercase;text-align:right;border:${GRID_BORDER};">Commission Amount</td>`;
  const body = sorted.map((r, i) => {
    const rowColor = bandColors[i];
    const cells = LEDGER_COLUMNS.map(c => `<td style="padding:5px 8px;font-size:13px;color:#333333;background-color:${rowColor};border:${GRID_BORDER};">${c.render(r)}</td>`).join('');
    // Commission Amount gets its own tint (like a calculated column in Excel)
    // instead of following the client band, so it stands out as the number
    // that matters on every row regardless of which client it's on.
    return `<tr>${cells}<td style="padding:5px 8px;font-size:13px;color:#1a1a2e;font-weight:bold;text-align:right;white-space:nowrap;background-color:#dcecdc;border:${GRID_BORDER};">${f$(r[amountKey])}</td></tr>`;
  }).join('');
  const total = sorted.reduce((s, r) => s + Number(r[amountKey] || 0), 0);
  return `<div style="overflow-x:auto;"><table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:6px;border-collapse:collapse;white-space:nowrap;border:${GRID_BORDER};">
    <tr>${headerCells}</tr>
    ${body}
    <tr style="background-color:#1a1a2e;">
      <td colspan="${LEDGER_COLUMNS.length}" style="padding:8px;font-size:13px;color:#aaaacc;border:${GRID_BORDER};">Total</td>
      <td style="padding:8px;font-size:15px;color:#ffffff;font-weight:bold;text-align:right;border:${GRID_BORDER};">${f$(total)}</td>
    </tr>
  </table></div>
  <p style="margin:2px 0 14px;font-size:11px;color:#888888;">Estimate #/Date are a best-effort match (no direct link exists from invoice to estimate) — flag if one looks wrong. Invoice Date/Paid Date can show "—" when the underlying record hasn't synced from Service Autopilot yet — that's a display gap only; "Paid Amount" is the actual amount collected against the invoice and is what determines whether a row is payable. "Subcontracted?" reflects what's been auto-flagged from QBO vendor bills so far; reply to confirm, reject, or add one I missed. Invoice Amount/Paid Amount exclude sales tax.</p>`;
}

function reviewList(items) {
  if (!items.length) return '';
  return `<ul style="margin:0 0 14px;padding-left:18px;">${items.map(i => `<li style="font-size:13px;color:#533f03;margin-bottom:4px;">${i}</li>`).join('')}</ul>`;
}

export async function generateCommissionReport({ quarter, engineResult, isFinal = true, isDraft = false } = {}) {
  const targetQuarter = quarter || currentQuarter();
  const result = engineResult || await runCommissionEngine({ quarter: targetQuarter, isFinal });

  const [payableResult, accruedResult, renewalPendingResult, quarterLedgerIdsResult, unconfirmedPmResult] = await Promise.all([
    fleetops.from('commission_ledger').select('*').eq('quarter', targetQuarter).gt('payable_commission', 0).order('employee_name'),
    fleetops.from('commission_ledger').select('*').eq('quarter', targetQuarter).gt('accrued_commission', 0).order('employee_name'),
    fleetops.from('commission_ledger').select('*').eq('quarter', targetQuarter).eq('renewal_flag', true).is('renewal_confirmed', null),
    // Every ledger row for this quarter, regardless of dollar amount — a row can
    // legitimately be $0/$0 (already accrued earlier, no new cash this run) and
    // still have a real unconfirmed subcontractor flag that needs surfacing.
    fleetops.from('commission_ledger').select('id, client_name, employee_name, service_names').eq('quarter', targetQuarter),
    // pm_attribution_confirmed=false rows have cash withheld regardless of
    // dollar amount (same reasoning as the subcontractor flags above) — surface
    // every one, not just rows with a nonzero payable this run.
    fleetops.from('commission_ledger').select('*').eq('quarter', targetQuarter).eq('pm_attribution_confirmed', false),
  ]);

  for (const [label, r] of [
    ['payable', payableResult], ['accrued', accruedResult],
    ['renewalPending', renewalPendingResult], ['quarterLedgerIds', quarterLedgerIdsResult],
    ['unconfirmedPm', unconfirmedPmResult],
  ]) {
    if (r.error) throw new Error(`generateCommissionReport ${label} query failed: ${r.error.message}`);
  }

  const payableRows = payableResult.data ?? [];
  const accruedRows = accruedResult.data ?? [];
  // Section 2 is "accrued but not payable" — a row already shown (with dollars)
  // in Section 1 this quarter doesn't need to repeat there too. accruedTotal
  // (the summary box, below) stays the TRUE full accrual for the accountant's
  // books and is intentionally NOT limited to this subset.
  const accruedNotPayableRows = accruedRows.filter(r => Number(r.payable_commission || 0) === 0);
  const renewalPending = renewalPendingResult.data ?? [];
  const quarterLedger = quarterLedgerIdsResult.data ?? [];
  const unconfirmedPmRows = unconfirmedPmResult.data ?? [];

  const [unconfirmedFlagsResult, unconfirmedLinesResult] = quarterLedger.length
    ? await Promise.all([
        fleetops.from('commission_sub_bill_flags').select('*').in('ledger_id', quarterLedger.map(r => r.id)).eq('confirmed', false),
        fleetops.from('commission_ledger_lines').select('*').in('ledger_id', quarterLedger.map(r => r.id)).eq('category', 'subcontracted_candidate').eq('confirmed', false),
      ])
    : [{ data: [] }, { data: [] }];
  if (unconfirmedFlagsResult.error) throw new Error(`generateCommissionReport unconfirmedFlags query failed: ${unconfirmedFlagsResult.error.message}`);
  if (unconfirmedLinesResult.error) throw new Error(`generateCommissionReport unconfirmedLines query failed: ${unconfirmedLinesResult.error.message}`);

  const ledgerById = new Map(quarterLedger.map(r => [r.id, r]));
  const relevantFlags = unconfirmedFlagsResult.data ?? [];
  const unconfirmedLines = unconfirmedLinesResult.data ?? [];

  const payableTotal = payableRows.reduce((s, r) => s + Number(r.payable_commission || 0), 0);
  const accruedTotal = accruedRows.reduce((s, r) => s + Number(r.accrued_commission || 0), 0);

  // unplannedJobs/unassignedJobs come from a company-wide engine run across
  // every employee, not just commission-eligible PMs — since only Jarrett has
  // a commission plan right now, that's every other job in the company (Michael
  // confirmed 2026-07-28: "no other employees earn commissions", he doesn't
  // want this listed or summarized). Deliberately not surfaced here at all —
  // if a second PM is ever added, revisit whether this needs to come back.
  // Includes the service name when known — a client with two concurrent jobs
  // this quarter (e.g. two maintenance contracts) would otherwise be ambiguous
  // about which ledger row a review item refers to.
  const clientLabel = row => row?.service_names ? `${row.client_name ?? '—'} (${row.service_names})` : (row?.client_name ?? '—');

  // Estimate-first coverage check (2026-08-04, per Michael): for every
  // employee with an active plan, look forward from their WON estimates
  // instead of only backward from invoices — catches a job that's real and
  // won but hasn't yet produced a traced commission_ledger row (this is how
  // the Sterling Pharma enhancement job went unreported for a full cycle).
  const { data: activePlans, error: activePlansError } = await fleetops
    .from('commission_plans').select('employee_name').eq('active', true);
  if (activePlansError) throw new Error(`generateCommissionReport activePlans query failed: ${activePlansError.message}`);
  const unmatchedEstimatesByEmployee = await Promise.all(
    (activePlans ?? []).map(p => findUnmatchedWonEstimates({ employeeName: p.employee_name }))
  );
  const unmatchedEstimates = unmatchedEstimatesByEmployee.flat();

  const reviewItems = [
    ...unmatchedEstimates.map(e => e.inProgressNote
      ? `${e.clientName ?? '—'} — won estimate #${e.estimateNumber} (${f$(e.amount)}, quoted ${fD(e.quoteDate)}): ${e.inProgressNote}`
      : `${e.clientName ?? '—'} — won estimate #${e.estimateNumber} (${f$(e.amount)}, quoted ${fD(e.quoteDate)}) has no traced invoice/commission entry yet — confirm the job hasn't been invoiced, or that the match against it is failing`),
    ...renewalPending.map(r => `${clientLabel(r) ?? r.sa_reference} — looks like a contract renewal, confirm new/expanded vs. renewal before it's paid`),
    ...unconfirmedPmRows.map(r => `${clientLabel(r) ?? r.sa_reference} — PM attribution is a best-effort guess (no direct job or manual record confirms ${r.employee_name} sold this) — commission is accruing but payable is withheld until confirmed`),
    ...relevantFlags.map(f => {
      const ledger = ledgerById.get(f.ledger_id);
      return `${clientLabel(ledger)} — candidate subcontractor bill: ${f.vendor_name ?? 'unknown vendor'}, ${f$(f.bill_amount)} on ${f.bill_date} (${f.match_confidence} confidence) — confirm before applying the 20% GP cap`;
    }),
    ...unconfirmedLines.map(l => {
      const ledger = ledgerById.get(l.ledger_id);
      return `${clientLabel(ledger)} — line item "${l.qbo_line_description || l.qbo_item_name}" (${f$(l.line_amount)}) matched vendor ${l.vendor_name ?? 'unknown'} — confirm this specific line as subcontracted before the cap applies to it`;
    }),
    ...(result.processingErrors ?? []).map(e => `${e.clientName ?? e.saReference} — SKIPPED this run due to a query error (${e.error}); needs a re-run`),
  ];

  const today = new Date().toISOString().split('T')[0];
  const reportLabel = isFinal ? 'Quarter-End Report' : 'Quarter-to-Date Tracking';
  const titlePrefix = isDraft ? 'DRAFT — ' : '';

  let html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${titlePrefix}PM Commission ${reportLabel} ${targetQuarter}</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" style="max-width:620px;background-color:#ffffff;border-radius:6px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

<!-- HEADER -->
<tr><td style="background-color:#1a1a2e;padding:24px 32px;">
  <p style="margin:0;color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:0.5px;">J.R. Boehlke, LLC</p>
  <p style="margin:4px 0 0;color:#aaaacc;font-size:13px;">${titlePrefix}PM Commission ${reportLabel} &nbsp;|&nbsp; ${targetQuarter}</p>
</td></tr>

<!-- BODY -->
<tr><td style="padding:28px 32px;">

${isDraft ? alertBox('#fff3cd', '#e6a817', 'This Is A Draft', `<p style="margin:0;font-size:13px;color:#533f03;">Reply to this email with any corrections (e.g. "move Sterling Pharma to Nicole" or "confirm the Celia Shaughnessy line as subcontracted") and a revised draft will come back in this same thread. Reply "approved" (or similar) once it looks right, and the final version goes out to you${process.env.ACCOUNTANT_EMAIL ? ' and the accountant' : ''}.</p>`) : ''}
${!isFinal ? alertBox('#f0f4ff', '#1a1a2e', 'Quarter Still In Progress', `<p style="margin:0;font-size:13px;color:#1a1a2e;">This is a mid-quarter snapshot for tracking and accrual purposes — not the final payout. Payable reflects cash collected on ${targetQuarter} so far; the actual quarterly payment runs the first payroll after ${targetQuarter} closes.</p>`) : ''}

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f4ff;border-radius:4px;margin-bottom:20px;">
<tr>
  <td style="padding:14px 16px;text-align:center;border-right:1px solid #d8e0f0;">
    <p style="margin:0;font-size:20px;font-weight:bold;color:#1a6e1a;">${f$(payableTotal)}</p>
    <p style="margin:2px 0 0;font-size:11px;color:#555577;text-transform:uppercase;letter-spacing:0.6px;">${isFinal ? 'Payable' : 'Payable Quarter-to-Date'}</p>
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

  html += sectionHeader('Commissions Payable', payableRows.length);
  html += ledgerTable(payableRows, 'payable_commission');

  html += sectionHeader('Commissions Accrued But Not Payable', accruedNotPayableRows.length);
  html += ledgerTable(accruedNotPayableRows, 'accrued_commission');
  if (accruedRows.length > accruedNotPayableRows.length) {
    html += `<p style="margin:-4px 0 14px;font-size:11px;color:#888888;">${accruedRows.length - accruedNotPayableRows.length} additional row${accruedRows.length - accruedNotPayableRows.length !== 1 ? 's' : ''} accrued this quarter but ${accruedRows.length - accruedNotPayableRows.length !== 1 ? 'are' : 'is'} already shown above in Commissions Payable — not repeated here.</p>`;
  }

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

  const subject = `${titlePrefix}PM Commission ${reportLabel} — ${targetQuarter} — ${f$(payableTotal)} payable`;

  // Drafts and revisions never go to the accountant, regardless of ACCOUNTANT_EMAIL —
  // only the version Michael has explicitly approved does (per his answer, 2026-07-28).
  const recipients = ['michael@jrboehlke.com'];
  if (isDraft) {
    // no-op — Michael only
  } else if (process.env.ACCOUNTANT_EMAIL) {
    recipients.push(process.env.ACCOUNTANT_EMAIL);
  } else {
    logger.warn('ACCOUNTANT_EMAIL not configured — commission report sent to Michael only');
  }

  return { quarter: targetQuarter, isFinal, isDraft, subject, body: html, recipients, payableTotal, accruedTotal, reviewCount: reviewItems.length };
}

// Builds the report (see generateCommissionReport) and sends it. Split out so the
// report body can be generated and inspected independently of actually emailing it.
// Kept for direct/manual use (e.g. backtesting) — the live cron path goes through
// sendDraftForApproval below instead.
export async function generateAndSendCommissionReport(opts) {
  const report = await generateCommissionReport(opts);
  await sendEmail({ to: report.recipients, subject: report.subject, body: report.body });
  logger.info('Commission report sent', {
    quarter: report.quarter, recipients: report.recipients,
    payableTotal: report.payableTotal, accruedTotal: report.accruedTotal, reviewCount: report.reviewCount,
  });
  return report;
}

// ── Draft → feedback → approval workflow ──────────────────────
// Every run (monthly and quarterly per Michael's answer, 2026-07-28) goes out
// as a draft first. commission-report-reply.js handles the incoming replies;
// these two functions handle the outgoing side of the same conversation.

async function findOpenDraft(quarter, isFinal) {
  const { data, error } = await fleetops
    .from('commission_report_drafts')
    .select('*')
    .eq('quarter', quarter)
    .eq('is_final', isFinal)
    .eq('status', 'draft')
    .maybeSingle();
  if (error) throw new Error(`findOpenDraft query failed: ${error.message}`);
  return data;
}

// Sends a draft (or, if one is already open for this quarter/is_final, a
// revision reply in the same thread) and upserts the tracking row.
//
// replyToEmailId: Graph's createReply only works on a RECEIVED message, never
// on one you sent yourself — so a revision must be based on Michael's actual
// incoming reply (commission-report-reply.js passes email.id here), not on
// our own previously-sent draft. Without it (e.g. the monthly cron re-firing
// while a draft is still open and Michael hasn't replied yet), there's
// nothing valid to reply to — skip re-sending rather than erroring, and say why.
export async function sendDraftForApproval({ quarter, isFinal = true, engineResult, replyToEmailId } = {}) {
  const targetQuarter = quarter || currentQuarter();
  const existing = await findOpenDraft(targetQuarter, isFinal);

  if (existing && !replyToEmailId) {
    logger.info('sendDraftForApproval: a draft is already open with no new reply to respond to — skipping re-send', { quarter: targetQuarter, isFinal, revisionNumber: existing.revision_number });
    return { quarter: targetQuarter, isFinal, skipped: true, reason: 'draft already open, awaiting reply' };
  }

  const report = await generateCommissionReport({ quarter: targetQuarter, isFinal, isDraft: true, engineResult });

  let threadId, emailId, revisionNumber;
  if (existing) {
    const { draft_id } = await createReplyDraft({ email_id: replyToEmailId, body: report.body });
    await sendDraft({ draft_id });
    threadId = existing.thread_id;
    emailId = draft_id;
    revisionNumber = existing.revision_number + 1;
  } else {
    const { draft_id } = await draftEmail({ to: report.recipients, subject: report.subject, body: report.body });
    const sentMeta = await getEmail({ email_id: draft_id }); // conversationId is assigned at draft-creation time
    threadId = sentMeta.thread_id;
    emailId = draft_id;
    revisionNumber = 1;
    await sendDraft({ draft_id });
  }

  const snapshot = { payableTotal: report.payableTotal, accruedTotal: report.accruedTotal, reviewCount: report.reviewCount };
  // Explicit update-or-insert rather than .upsert(onConflict:...) — the
  // uniqueness guarantee here is a PARTIAL index (only while status='draft'),
  // which the Supabase JS client's onConflict option can't target; `existing`
  // (already looked up above) tells us which path applies.
  const { error: writeError } = existing
    ? await fleetops.from('commission_report_drafts').update({
        status: 'draft', revision_number: revisionNumber, thread_id: threadId, last_email_id: emailId,
        engine_snapshot: snapshot, updated_at: new Date().toISOString(),
      }).eq('id', existing.id)
    : await fleetops.from('commission_report_drafts').insert({
        quarter: targetQuarter, is_final: isFinal, status: 'draft',
        revision_number: revisionNumber, thread_id: threadId, last_email_id: emailId,
        engine_snapshot: snapshot,
      });
  if (writeError) {
    // The email already went out — a failure here only desyncs tracking, but
    // that desync means future replies/cron runs get permanently confused, so
    // this needs a human's attention, not just a log line.
    logger.warn('commission_report_drafts write failed', { err: writeError.message, quarter: targetQuarter, isFinal });
    sendProactiveMessage(`⚠️ A commission report draft for ${targetQuarter} was sent, but its tracking row failed to save (${writeError.message}). Replies to it may not route correctly — check commission_report_drafts manually.`).catch(() => {});
  }

  logger.info('Commission draft sent', { quarter: targetQuarter, isFinal, revisionNumber, threadId });
  return { ...report, threadId, revisionNumber };
}

// Sends the final (non-draft, full-recipient) version in reply to the same
// thread and closes out the tracking row. Called once a reply is classified
// as an approval — see commission-report-reply.js. replyToEmailId must be
// Michael's approval reply's own id (see sendDraftForApproval's comment on why).
export async function sendFinalReport({ quarter, isFinal, engineResult, replyToEmailId }) {
  const existing = await findOpenDraft(quarter, isFinal);
  if (!existing) throw new Error(`sendFinalReport: no open draft found for ${quarter} (isFinal=${isFinal}) — nothing to finalize`);
  if (!replyToEmailId) throw new Error('sendFinalReport: replyToEmailId is required — Graph can only reply to a received message');

  // Atomically claim the draft before doing any work — guards against two
  // near-simultaneous approval replies both sending the final report (which
  // would double-email the accountant). Only one caller's conditional update
  // (status must still be 'draft') can succeed.
  const { data: claimed, error: claimError } = await fleetops.from('commission_report_drafts')
    .update({ status: 'sent', updated_at: new Date().toISOString() })
    .eq('id', existing.id)
    .eq('status', 'draft')
    .select('id');
  if (claimError) throw new Error(`sendFinalReport: failed to claim draft: ${claimError.message}`);
  if (!claimed?.length) {
    logger.info('sendFinalReport: another process already claimed/sent this draft — skipping', { quarter, isFinal });
    return { quarter, isFinal, skipped: true, reason: 'already sent by a concurrent approval' };
  }

  let report, draft_id;
  try {
    report = await generateCommissionReport({ quarter, isFinal, isDraft: false, engineResult });
    ({ draft_id } = await createReplyDraft({ email_id: replyToEmailId, body: report.body }));
    await sendDraft({ draft_id });
  } catch (err) {
    // Revert the claim so a retry (e.g. Michael replying "approved" again)
    // isn't permanently blocked by a status='sent' row for a report that
    // never actually went out.
    await fleetops.from('commission_report_drafts').update({ status: 'draft' }).eq('id', existing.id).then(() => {}, () => {});
    sendProactiveMessage(`⚠️ Final commission report for ${quarter} FAILED to send: ${err.message}. Reverted to draft status — reply "approved" again to retry.`).catch(() => {});
    throw err;
  }

  const { error: updateError } = await fleetops.from('commission_report_drafts')
    .update({ last_email_id: draft_id, updated_at: new Date().toISOString() })
    .eq('id', existing.id);
  if (updateError) {
    logger.warn('commission_report_drafts final last_email_id update failed', { err: updateError.message, id: existing.id });
    sendProactiveMessage(`⚠️ Final commission report for ${quarter} sent successfully, but its tracking row failed a minor update (${updateError.message}). No action needed unless you notice something odd.`).catch(() => {});
  }

  logger.info('Commission final report sent', {
    quarter, isFinal, recipients: report.recipients, payableTotal: report.payableTotal,
  });
  return report;
}
