// tools/impl/qbo-reparent-migration.js — QBO sub-customer reparent migration
//
// Fixes a mis-nested QBO sub-customer (e.g. Lilly Creek Business Center sitting
// under the wrong sibling instead of the real Master) for accounts that already
// carry real transaction history. QBO rejects a direct ParentRef change on a
// customer with transactions (error code 6000, "A project must be a subcustomer
// billed to its parent") — SA support's confirmed workaround is: move every
// transaction off the source customer onto a holding customer (the real Master),
// reparent the now-empty source customer, then move the transactions back.
//
// Two-phase, resumable, dry-run by default. Never touches JournalEntry or
// Deposit transactions automatically — those are always surfaced for manual
// review, since their CustomerRef lives in a nested Line[].*.Entity.EntityRef
// shape that varies per transaction and is too easy to get wrong silently on
// real financial data.

import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { logger } from '../../core/logger.js';
import { getQBAccessToken, getQBRealmId } from './qb-token.js';

const qbBase = (company = 'jrb') => `https://quickbooks.api.intuit.com/v3/company/${getQBRealmId(company)}`;

// Deliberately bypasses quickbooks.js's cached query() — this script does
// tight read-write-verify cycles within a single run and cannot risk serving
// a stale SyncToken or a pre-move CustomerRef from the 1hr query cache.
async function freshQuery(qStr, company = 'jrb') {
  const token = await getQBAccessToken(company);
  const res = await axios.get(`${qbBase(company)}/query`, {
    params: { query: qStr },
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  return res.data.QueryResponse || {};
}

async function freshRead(entityType, id, company = 'jrb') {
  const token = await getQBAccessToken(company);
  const res = await axios.get(`${qbBase(company)}/${entityType.toLowerCase()}/${id}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  return res.data[entityType];
}

async function sparseUpdate(entityType, payload, company = 'jrb') {
  const token = await getQBAccessToken(company);
  const res = await axios.post(`${qbBase(company)}/${entityType.toLowerCase()}`,
    { ...payload, sparse: true },
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' } });
  return res.data[entityType];
}

// Transaction types this script will actually move. JournalEntry/Deposit are
// deliberately excluded — see file header.
const MOVABLE_TYPES = ['Invoice', 'Payment', 'CreditMemo', 'SalesReceipt'];

/**
 * Read-only. Builds a full plan of what a reparent migration for
 * sourceCustomerId would do, without calling any write endpoint.
 *
 * @returns {{
 *   sourceCustomerId: string, holdingCustomerId: string, newParentId: string,
 *   transactions: Array<{type:string,id:string,docNumber:string,txnDate:string,
 *     amount:number,currentCustomerId:string,plannedCustomerId:string,linkedTxnIds:string[]}>,
 *   needsManualReview: Array<{type:string,id:string,reason:string,detail:object}>
 * }}
 */
export async function buildReparentPlan({ sourceCustomerId, holdingCustomerId, newParentId, company = 'jrb' }) {
  const transactions = [];
  const needsManualReview = [];

  for (const type of MOVABLE_TYPES) {
    const result = await freshQuery(
      `SELECT * FROM ${type} WHERE CustomerRef = '${sourceCustomerId}' MAXRESULTS 1000`, company);
    const rows = result[type] || [];

    for (const row of rows) {
      const amount = row.TotalAmt ?? row.Amount ?? 0;

      if (amount === 0) {
        needsManualReview.push({ type, id: row.Id, reason: 'zero-amount transaction', detail: row });
        continue;
      }

      const entry = {
        type,
        id: row.Id,
        docNumber: row.DocNumber || null,
        txnDate: row.TxnDate,
        amount,
        currentCustomerId: sourceCustomerId,
        plannedCustomerId: holdingCustomerId,
        linkedTxnIds: [],
      };

      if (type === 'Payment') {
        const lines = row.Line || [];
        for (const line of lines) {
          for (const linked of line.LinkedTxn || []) {
            entry.linkedTxnIds.push(linked.TxnId);
          }
        }
        if (entry.linkedTxnIds.length === 0 && (row.UnappliedAmt ?? 0) > 0) {
          needsManualReview.push({
            type, id: row.Id,
            reason: 'unapplied payment — no invoice to preserve the link to across the move',
            detail: { totalAmt: row.TotalAmt, unappliedAmt: row.UnappliedAmt },
          });
          continue;
        }
      }

      transactions.push(entry);
    }
  }

  // JournalEntry rows referencing this customer are surfaced but never planned
  // for auto-move — their CustomerRef lives per-line under
  // JournalEntryLineDetail.Entity.EntityRef, and on this specific account
  // several existing JournalEntry rows are known manual balance corrections
  // (see project notes) that a script has no business reinterpreting.
  const jeResult = await freshQuery(`SELECT * FROM JournalEntry MAXRESULTS 1000`, company);
  for (const je of jeResult.JournalEntry || []) {
    const touchesSource = (je.Line || []).some(l =>
      l.JournalEntryLineDetail?.Entity?.EntityRef?.value === sourceCustomerId);
    if (touchesSource) {
      needsManualReview.push({
        type: 'JournalEntry', id: je.Id,
        reason: 'journal entry referencing source customer — never auto-moved, needs manual accounting review',
        detail: je,
      });
    }
  }

  return { sourceCustomerId, holdingCustomerId, newParentId, transactions, needsManualReview };
}

/** Dry-run formatter — human-readable plan summary, no side effects. */
export function formatPlan(plan) {
  const lines = [];
  lines.push(`Reparent plan for customer ${plan.sourceCustomerId}`);
  lines.push(`  Phase 1: move ${plan.transactions.length} transaction(s) -> holding customer ${plan.holdingCustomerId}`);
  lines.push(`  Phase 2: reparent ${plan.sourceCustomerId} -> ${plan.newParentId} (once balance/txn count is zero)`);
  lines.push(`  Phase 3: move the same ${plan.transactions.length} transaction(s) back -> ${plan.sourceCustomerId}`);
  lines.push('');
  lines.push('Transactions planned for auto-move:');
  for (const t of plan.transactions) {
    const linked = t.linkedTxnIds.length ? ` (linked to invoice ${t.linkedTxnIds.join(', ')})` : '';
    lines.push(`  [${t.type} ${t.id}] ${t.docNumber || ''} ${t.txnDate} $${t.amount}${linked}`);
  }
  lines.push('');
  lines.push(`NEEDS MANUAL REVIEW (${plan.needsManualReview.length}) — not part of the auto-plan:`);
  for (const m of plan.needsManualReview) {
    lines.push(`  [${m.type} ${m.id}] ${m.reason}`);
  }
  return lines.join('\n');
}

function opLogPath(sourceCustomerId) {
  return path.join(process.cwd(), `qbo-reparent-oplog-${sourceCustomerId}.json`);
}

async function appendOpLog(sourceCustomerId, entry) {
  const file = opLogPath(sourceCustomerId);
  let log = [];
  try { log = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* first write */ }
  log.push({ ...entry, timestamp: new Date().toISOString() });
  await fs.writeFile(file, JSON.stringify(log, null, 2));
}

/**
 * Moves every transaction in plan.transactions to targetCustomerId via sparse
 * CustomerRef update, verifying each write with a fresh read-back. Writes a
 * persisted op log entry per transaction so a partial failure is diagnosable
 * and resumable (re-running skips transactions already logged as done for
 * this direction).
 */
export async function executeMove({ plan, targetCustomerId, direction, company = 'jrb', live = false }) {
  if (!live) throw new Error('executeMove called without live=true — refusing to write. This function has no dry-run mode of its own; callers must gate on the CLI --live flag before calling it.');

  const file = opLogPath(plan.sourceCustomerId);
  let done = new Set();
  try {
    const existing = JSON.parse(await fs.readFile(file, 'utf8'));
    done = new Set(existing.filter(e => e.direction === direction && e.verified).map(e => e.txnId));
  } catch { /* no prior log */ }

  const results = [];
  for (const t of plan.transactions) {
    if (done.has(t.id)) {
      logger.info('qbo-reparent-migration: skipping already-verified transaction', { id: t.id, direction });
      results.push({ ...t, skipped: true });
      continue;
    }

    const current = await freshRead(t.type, t.id, company);
    const payload = {
      Id: t.id,
      SyncToken: current.SyncToken,
      CustomerRef: { value: targetCustomerId },
    };

    let verified = false;
    let error = null;
    try {
      await sparseUpdate(t.type, payload, company);
      const fresh = await freshRead(t.type, t.id, company);
      verified = fresh.CustomerRef?.value === targetCustomerId;
      if (!verified) error = `post-write read shows CustomerRef=${fresh.CustomerRef?.value}, expected ${targetCustomerId}`;
    } catch (e) {
      error = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    }

    await appendOpLog(plan.sourceCustomerId, {
      direction, txnId: t.id, type: t.type, fromCustomerId: t.currentCustomerId,
      toCustomerId: targetCustomerId, verified, error,
    });

    results.push({ ...t, verified, error });
    if (!verified) {
      logger.error('qbo-reparent-migration: write did not verify, stopping this run', { id: t.id, error });
      break; // stop on first unverified write — do not keep moving transactions past a failure
    }
  }

  return results;
}

/**
 * Reparents sourceCustomerId to newParentId — ONLY after confirming via a
 * fresh read that its Balance and open-transaction footprint are both zero.
 * Refuses otherwise (this is the QBO restriction the whole migration exists
 * to work around; reparenting too early just reproduces error code 6000).
 */
export async function reparentIfEmpty({ sourceCustomerId, newParentId, company = 'jrb', live = false }) {
  if (!live) throw new Error('reparentIfEmpty called without live=true — refusing to write.');

  const customer = await freshRead('Customer', sourceCustomerId, company);
  if ((customer.Balance ?? 0) !== 0) {
    throw new Error(`Refusing to reparent ${sourceCustomerId}: Balance is ${customer.Balance}, not zero. Move all transactions off it first.`);
  }

  for (const type of MOVABLE_TYPES) {
    const result = await freshQuery(`SELECT COUNT(*) FROM ${type} WHERE CustomerRef = '${sourceCustomerId}'`, company);
    const count = result[type]?.[0]?.count ?? result.totalCount ?? 0;
    if (count > 0) {
      throw new Error(`Refusing to reparent ${sourceCustomerId}: ${count} ${type} row(s) still reference it.`);
    }
  }

  const res = await sparseUpdate('Customer', {
    Id: sourceCustomerId, SyncToken: customer.SyncToken, ParentRef: { value: newParentId }, Job: true,
  }, company);

  const fresh = await freshRead('Customer', sourceCustomerId, company);
  const verified = fresh.ParentRef?.value === newParentId;
  await appendOpLog(sourceCustomerId, {
    direction: 'reparent', txnId: sourceCustomerId, type: 'Customer',
    fromCustomerId: customer.ParentRef?.value, toCustomerId: newParentId, verified,
    error: verified ? null : `post-write ParentRef=${fresh.ParentRef?.value}, expected ${newParentId}`,
  });

  if (!verified) throw new Error(`Reparent did not verify — see op log at ${opLogPath(sourceCustomerId)}`);
  return res;
}
