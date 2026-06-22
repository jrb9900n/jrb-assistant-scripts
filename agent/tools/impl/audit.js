// tools/impl/audit.js — Weekly QBO ↔ SA audit matching engine
// Runs at 1:30 AM Sunday. Email fires at 6 AM Sunday.
// Persists issues in audit_issues (fleetops) with fingerprint dedup.
// Issues auto-resolve when the underlying condition clears.

import { createClient } from '@supabase/supabase-js';
import { query } from './quickbooks.js';
import { logger } from '../../core/logger.js';

const fleetops = createClient(
  process.env.FLEETOPS_SUPABASE_URL,
  process.env.FLEETOPS_SUPABASE_SERVICE_KEY
);

const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';
const LOOKBACK_DAYS = 90;
const OVERDUE_THRESHOLD_DAYS = 30;
const AMOUNT_MISMATCH_THRESHOLD = 50;   // flag customer-level delta > $50
const UNBILLED_GRACE_DAYS = 30;         // ignore completed jobs < 30 days old (snow ~30d, landscape monthly billing)
const BALANCE_MIN_THRESHOLD = 10;       // ignore SA balances < $10

function normalizeName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

// ── Check 1: SA completed jobs with no QBO invoice reference ──────────────────
// Completed SA jobs older than UNBILLED_GRACE_DAYS with no invoice_id.
// Fingerprint per job — auto-resolves when invoice_id gets populated.
// Contract clients excluded — their billing is aggregate/fixed-price, not per-job.

async function checkUnbilledComplete(runId) {
  const cutoff = dateStr(UNBILLED_GRACE_DAYS);
  const lookbackDate = dateStr(LOOKBACK_DAYS);

  // Fetch contract client names to exclude (is_contract = true in sa_invoices)
  const { data: contractRows } = await fleetops
    .from('sa_invoices')
    .select('client')
    .eq('is_contract', true)
    .gte('date', lookbackDate);
  const contractClients = new Set((contractRows ?? []).map(r => normalizeName(r.client)));

  const { data: jobs, error } = await fleetops
    .from('sa_jobs')
    .select('id, client, amount, invoice_id, date_completed, service, address')
    .eq('status', 3)
    .lt('date_completed', cutoff)
    .gte('date_completed', lookbackDate)
    .gt('amount', 0)
    .not('date_completed', 'is', null)
    .or(`invoice_id.is.null,invoice_id.eq.${EMPTY_GUID}`);

  if (error) throw new Error(`unbilled_complete query failed: ${error.message}`);

  return (jobs ?? [])
    .filter(job => !contractClients.has(normalizeName(job.client)))
    .map(job => ({
    fingerprint: `unbilled_complete|${job.id}`,
    issue_type: 'unbilled_complete',
    severity: 'high',
    sa_job_id: job.id,
    sa_client: job.client,
    sa_amount: job.amount,
    sa_date_completed: job.date_completed,
    description: `Completed SA job with no QBO invoice — ${job.client}, $${parseFloat(job.amount).toFixed(2)}, ${job.service ?? 'unknown service'} on ${job.date_completed}${job.address ? ' @ ' + job.address : ''}`,
    last_audit_run_id: runId,
  }));
}

// ── Check 2: QBO overdue invoices (> OVERDUE_THRESHOLD_DAYS past due) ────────
// Fingerprint per QBO invoice ID — auto-resolves when invoice balance hits 0.

async function checkOverdueInvoices(runId) {
  const cutoff = dateStr(OVERDUE_THRESHOLD_DAYS);

  const qboResult = await query({
    query: `SELECT * FROM Invoice WHERE Balance > '0' AND DueDate <= '${cutoff}' STARTPOSITION 1 MAXRESULTS 200`,
  });

  const invoices = qboResult?.Invoice ?? [];

  return invoices.map(inv => {
    const daysOverdue = Math.floor((Date.now() - new Date(inv.DueDate).getTime()) / 86400000);
    return {
      fingerprint: `overdue_invoice|${inv.Id}`,
      issue_type: 'overdue_invoice',
      severity: 'medium',
      qbo_invoice_id: inv.Id,
      qbo_customer_name: inv.CustomerRef?.name,
      qbo_amount: parseFloat(inv.TotalAmt),
      qbo_balance: parseFloat(inv.Balance),
      qbo_due_date: inv.DueDate,
      description: `QBO Invoice #${inv.Id} for ${inv.CustomerRef?.name} — $${parseFloat(inv.Balance).toFixed(2)} outstanding, ${daysOverdue} days overdue (due ${inv.DueDate})`,
      last_audit_run_id: runId,
    };
  });
}

// ── Check 3: Customer-level SA vs QBO amount reconciliation ──────────────────
// Sums SA completed job amounts vs QBO invoice amounts per customer over LOOKBACK_DAYS.
// Flags customers where the delta exceeds AMOUNT_MISMATCH_THRESHOLD.
// Fingerprint per customer name — auto-resolves when delta drops below threshold.
// Contract clients excluded — fixed-price contracts always show a gap at the job level.

async function checkAmountMismatches(runId) {
  const lookbackDate = dateStr(LOOKBACK_DAYS);

  const [saResult, qboResult, contractResult] = await Promise.all([
    fleetops
      .from('sa_jobs')
      .select('client, amount')
      .eq('status', 3)
      .gte('date_completed', lookbackDate)
      .not('amount', 'is', null),
    query({
      query: `SELECT * FROM Invoice WHERE TxnDate >= '${lookbackDate}' STARTPOSITION 1 MAXRESULTS 500`,
    }),
    fleetops
      .from('sa_invoices')
      .select('client')
      .eq('is_contract', true)
      .gte('date', lookbackDate),
  ]);

  if (saResult.error) throw new Error(`amount_mismatch SA query failed: ${saResult.error.message}`);

  const contractClients = new Set((contractResult.data ?? []).map(r => normalizeName(r.client)));

  // Aggregate SA totals by normalized client name, skipping contract clients
  const saMap = new Map();
  for (const row of saResult.data) {
    const norm = normalizeName(row.client);
    if (contractClients.has(norm)) continue;
    if (!saMap.has(norm)) saMap.set(norm, { original: row.client, total: 0 });
    saMap.get(norm).total += parseFloat(row.amount || 0);
  }

  // Aggregate QBO totals by normalized customer name
  const qboInvoices = qboResult?.Invoice ?? [];
  const qboMap = new Map();
  for (const inv of qboInvoices) {
    const norm = normalizeName(inv.CustomerRef?.name);
    qboMap.set(norm, (qboMap.get(norm) || 0) + parseFloat(inv.TotalAmt || 0));
  }

  const issues = [];
  for (const [norm, saData] of saMap) {
    const qboTotal = qboMap.get(norm) || 0;
    const delta = Math.abs(saData.total - qboTotal);
    if (delta > AMOUNT_MISMATCH_THRESHOLD) {
      issues.push({
        fingerprint: `amount_mismatch|${norm}`,
        issue_type: 'amount_mismatch',
        severity: 'high',
        sa_client: saData.original,
        sa_amount: parseFloat(saData.total.toFixed(2)),
        qbo_customer_name: saData.original,
        qbo_amount: parseFloat(qboTotal.toFixed(2)),
        description: `SA completed $${saData.total.toFixed(2)} vs QBO invoiced $${qboTotal.toFixed(2)} for ${saData.original} — $${delta.toFixed(2)} gap over past ${LOOKBACK_DAYS} days`,
        last_audit_run_id: runId,
      });
    }
  }
  return issues;
}

// ── Check 4: SA clients with non-zero account balance ────────────────────────
// Groups by client — one issue per client with a meaningful balance.
// Reads sa_invoices.account_balance (account-level field populated by AME sync).
// Fingerprint per normalized client name — auto-resolves when balance clears.

async function checkNonzeroBalances(runId) {
  const { data: invoices, error } = await fleetops
    .from('sa_invoices')
    .select('client, account_balance')
    .not('account_balance', 'is', null)
    .eq('deleted', false);

  if (error) throw new Error(`nonzero_balance query failed: ${error.message}`);

  // One record per client — account_balance is account-level so same value on all invoices for a client
  const clientMap = new Map();
  for (const inv of invoices ?? []) {
    const balance = parseFloat(inv.account_balance || 0);
    if (Math.abs(balance) > BALANCE_MIN_THRESHOLD && !clientMap.has(normalizeName(inv.client))) {
      clientMap.set(normalizeName(inv.client), { client: inv.client, balance });
    }
  }

  return Array.from(clientMap.values()).map(({ client, balance }) => {
    const direction = balance > 0 ? 'owes' : 'has credit of';
    return {
      fingerprint: `nonzero_balance|${normalizeName(client)}`,
      issue_type: 'nonzero_balance',
      severity: 'low',
      sa_client: client,
      description: `${client} ${direction} $${Math.abs(balance).toFixed(2)} in SA — account balance`,
      last_audit_run_id: runId,
    };
  });
}

// ── Main audit runner ─────────────────────────────────────────────────────────

export async function runAudit() {
  const { data: runRow, error: runErr } = await fleetops
    .from('audit_runs')
    .insert({ status: 'running' })
    .select('id')
    .single();

  if (runErr) throw new Error(`Failed to create audit run: ${runErr.message}`);
  const runId = runRow.id;

  let allIssues = [];
  try {
    const [unbilled, overdue, mismatches, balances] = await Promise.all([
      checkUnbilledComplete(runId),
      checkOverdueInvoices(runId),
      checkAmountMismatches(runId),
      checkNonzeroBalances(runId),
    ]);
    allIssues = [...unbilled, ...overdue, ...mismatches, ...balances];
  } catch (err) {
    await fleetops.from('audit_runs')
      .update({ status: 'error', error_message: err.message })
      .eq('id', runId);
    throw err;
  }

  const now = new Date().toISOString();

  // Upsert all found issues.
  // On conflict (same fingerprint): update description, amounts, last_seen_at, re-open.
  // first_seen_at is intentionally omitted — it's only set on INSERT via DB default.
  for (const issue of allIssues) {
    const { error } = await fleetops
      .from('audit_issues')
      .upsert(
        { ...issue, status: 'open', last_seen_at: now },
        { onConflict: 'fingerprint', ignoreDuplicates: false }
      );
    if (error) {
      logger.warn('audit issue upsert failed', { fingerprint: issue.fingerprint, err: error.message });
    }
  }

  // Auto-resolve any open issue that didn't appear in this run.
  // last_audit_run_id gets set to runId on every upsert — anything still pointing
  // at an older run was not found and is now fixed.
  const { count: resolvedCount } = await fleetops
    .from('audit_issues')
    .update({ status: 'resolved', resolved_at: now })
    .eq('status', 'open')
    .neq('last_audit_run_id', runId)
    .select('id', { count: 'exact', head: true });

  // Count new issues (first seen within the last 5 minutes)
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  const { count: newCount } = await fleetops
    .from('audit_issues')
    .select('id', { count: 'exact', head: true })
    .eq('last_audit_run_id', runId)
    .gte('first_seen_at', fiveMinAgo);

  await fleetops.from('audit_runs').update({
    status: 'complete',
    issues_found: allIssues.length,
    issues_new: newCount || 0,
    issues_resolved: resolvedCount || 0,
  }).eq('id', runId);

  logger.info('Audit run complete', {
    runId,
    found: allIssues.length,
    new: newCount,
    resolved: resolvedCount,
  });

  return { runId, found: allIssues.length, new: newCount || 0, resolved: resolvedCount || 0 };
}

// ── Weekly email report ───────────────────────────────────────────────────────

export async function generateAuditEmail() {
  const [issuesResult, lastRunResult] = await Promise.all([
    fleetops
      .from('audit_issues')
      .select('*')
      .eq('status', 'open')
      .order('first_seen_at', { ascending: true }),
    fleetops
      .from('audit_runs')
      .select('*')
      .eq('status', 'complete')
      .order('run_at', { ascending: false })
      .limit(1)
      .single(),
  ]);

  if (issuesResult.error) throw new Error(`generateAuditEmail query failed: ${issuesResult.error.message}`);

  const issues = issuesResult.data;
  const lastRun = lastRunResult.data;

  const severityOrder = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9));

  const today = new Date().toISOString().split('T')[0];
  const lastSunday = new Date(Date.now() - 7 * 86400000).toISOString();
  const newThisWeek = issues.filter(i => i.first_seen_at >= lastSunday).length;

  const byType = {
    high: issues.filter(i => i.severity === 'high'),
    medium: issues.filter(i => i.severity === 'medium'),
    low: issues.filter(i => i.severity === 'low'),
  };

  const renderSection = (label, color, items) => {
    if (!items.length) return '';
    const rows = items.map(i => {
      const age = Math.floor((Date.now() - new Date(i.first_seen_at).getTime()) / 86400000);
      const ageStr = age === 0 ? 'new today' : age === 1 ? '1 day ago' : `${age} days ago`;
      return `<li style="margin-bottom:4px">${i.description} <span style="color:#888;font-size:11px">(${ageStr})</span></li>`;
    }).join('');
    return `
      <h3 style="font-family:sans-serif;color:${color};margin:20px 0 6px">${label} (${items.length})</h3>
      <ul style="font-family:monospace;font-size:13px;line-height:1.6;margin:0;padding-left:20px">${rows}</ul>`;
  };

  let body = `
<div style="max-width:700px">
  <h2 style="font-family:sans-serif;color:#1a1a1a;margin-bottom:4px">JRB Accounting Audit — ${today}</h2>
  <p style="font-family:sans-serif;font-size:13px;color:#555;margin-top:0">
    <strong>${issues.length}</strong> open issues &nbsp;|&nbsp;
    <strong>${newThisWeek}</strong> new this week &nbsp;|&nbsp;
    <strong>${lastRun?.issues_resolved ?? 0}</strong> resolved last run
  </p>`;

  if (issues.length === 0) {
    body += `<p style="font-family:sans-serif;color:#27ae60;font-size:15px;margin-top:20px">✅ No open issues — all clear!</p>`;
  } else {
    body += renderSection('🔴 High Priority', '#c0392b', byType.high);
    body += renderSection('🟡 Medium', '#d68910', byType.medium);
    body += renderSection('⚫ Low', '#7f8c8d', byType.low);
  }

  body += `
  <hr style="margin-top:24px;border:none;border-top:1px solid #eee">
  <p style="font-family:sans-serif;font-size:11px;color:#aaa">
    Sent by JRB Executive Assistant &nbsp;·&nbsp; Audit run: ${lastRun?.run_at?.split('T')[0] ?? today}
  </p>
</div>`;

  return {
    subject: `JRB Accounting Audit — ${issues.length} open issue${issues.length !== 1 ? 's' : ''} (${today})`,
    body,
  };
}
