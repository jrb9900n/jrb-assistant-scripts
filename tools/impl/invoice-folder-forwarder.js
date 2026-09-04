// tools/impl/invoice-folder-forwarder.js
//
// Polls michael@jrboehlke.com's "_Invoices" mail folder every 5 minutes and
// automatically forwards any new items to joanne@jrboehlke.com.
//
// WHY A POLLER, NOT AN OUTLOOK RULE
// ──────────────────────────────────
// Outlook inbox rules can only fire on "new mail arrival" (i.e. directly
// received messages). They cannot trigger on "item moved into a folder by
// another process" — which is the actual event here, because
// inbox-processor.js's processInbox() (running every 15 minutes, see
// scheduler/cron.js's michael_inbox_processor task) classifies arriving
// emails and physically moves invoice-categorised messages into _Invoices.
// A native rule would have no trigger to hook. A scheduled Graph API poller
// is the only reliable mechanism for this requirement.
//
// DEDUP STRATEGY
// ──────────────
// State is persisted to Supabase table `forwarded_invoice_ids` (jrb-assistant
// project, znpahinyplccdyoekfeo — see supabase/migrations). Each forwarded
// message ID is recorded there immediately before the forward is sent. On
// each poll:
//   1. List all messages currently in _Invoices (up to PAGE_SIZE).
//   2. Batch-check their IDs against `forwarded_invoice_ids`.
//   3. Skip any already in the table (already forwarded).
//   4. For each new message: upsert the record BEFORE sending, so a crash
//      mid-send doesn't cause a resend — an occasional missed forward on a
//      crash is far safer than a duplicate send (joanne receiving the same
//      invoice twice is confusing; a one-time miss is easy to catch manually).
//
// NOTE: Graph message IDs for michael@jrboehlke.com are tenant-stable — a
// message ID does not change when a message is moved between folders in the
// same mailbox (confirmed against Exchange Online in this tenant via live
// inbox-processor testing). The dedup table is therefore keyed on message_id
// and never needs cleanup — an ID in the table means "this specific email
// has been forwarded" regardless of where the message moves later.
//
// RUN-LOCK AND FAILURE ALERTING
// ──────────────────────────────
// This module intentionally has NO lock/alert logic of its own. Every other
// scheduled task in this codebase (michael_inbox_processor, sa_connectivity_check,
// email_poller, etc.) wires acquireRunLock/releaseRunLock and the
// alert-once-on-failure/once-on-recovery Teams pattern at the cron
// *registration* site in scheduler/cron.js, not inside the tools/impl module
// itself — see the invoice_folder_forwarder task registration there. Keeping
// that wiring out of this file matches the rest of the codebase and avoids
// duplicating cron.js's lock-file implementation.
//
// Per-message forward failures are different from a catastrophic run failure:
// they're caught individually inside the loop below (never abort the whole
// run over one bad message) and surfaced via the `errors` count in this
// function's return value — the cron registration alerts on that count.

import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';
import { graph } from './m365.js';

// ── Constants ──────────────────────────────────────────────────────────────

const SOURCE_MAILBOX     = 'michael@jrboehlke.com';
const FORWARD_TO         = 'joanne@jrboehlke.com';
const INVOICES_FOLDER    = '_Invoices';          // display name of the target folder
const PAGE_SIZE          = 50;                   // messages fetched per Graph page
const MAX_MESSAGES_SCAN  = 2000;                 // safety ceiling across all pages in one run
const DEDUP_TABLE        = 'forwarded_invoice_ids';

// ── Supabase client ────────────────────────────────────────────────────────

function supabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// ── Folder ID resolution (cached for the process lifetime) ────────────────
//
// Graph folder IDs are stable for the life of a folder; caching for the
// process lifetime is safe. A null cache means "not yet resolved" — it will
// retry on the next tick if the first resolution call fails.

let _invoicesFolderId = null;

async function getInvoicesFolderId() {
  if (_invoicesFolderId) return _invoicesFolderId;

  // Check top-level folders first (listMailFolders returns top-level only)
  const topLevel = await graph('GET',
    `/users/${SOURCE_MAILBOX}/mailFolders?$top=100&$select=id,displayName`);
  const topMatch = (topLevel.value ?? []).find(f => f.displayName === INVOICES_FOLDER);
  if (topMatch) {
    _invoicesFolderId = topMatch.id;
    logger.info('invoice-folder-forwarder: resolved _Invoices folder (top-level)',
      { id: _invoicesFolderId });
    return _invoicesFolderId;
  }

  // inbox-processor moved the category folders INTO Inbox as children
  // (see inbox-processor.js migrateFolderLocations). Check there too.
  const inboxChildren = await graph('GET',
    `/users/${SOURCE_MAILBOX}/mailFolders/inbox/childFolders?$top=100&$select=id,displayName`);
  const childMatch = (inboxChildren.value ?? []).find(f => f.displayName === INVOICES_FOLDER);
  if (childMatch) {
    _invoicesFolderId = childMatch.id;
    logger.info('invoice-folder-forwarder: resolved _Invoices folder (inbox child)',
      { id: _invoicesFolderId });
    return _invoicesFolderId;
  }

  throw new Error(`invoice-folder-forwarder: _Invoices folder not found in ${SOURCE_MAILBOX} — inbox-processor may not have created it yet`);
}

// ── Dedup helpers ──────────────────────────────────────────────────────────

// A single transient Supabase blip fails OPEN (see below) so a genuinely
// short outage doesn't block real invoices from reaching Joanne. But
// forwardMessage() talks to Graph, not Supabase, so forwards keep succeeding
// even while Supabase is down — meaning a fail-open run never throws, and
// scheduler/cron.js's catch (the only trigger for its down/recovery Teams
// alert) never fires. Left alone, a SUSTAINED Supabase outage would silently
// re-forward the whole _Invoices page to Joanne every 5 minutes forever, with
// nobody ever told. This counter converts "still failing after repeated
// consecutive ticks" into an actual thrown error so cron.js's alert fires
// once the outage stops looking like a one-off blip — reset to 0 on any
// successful lookup, module-level so it persists across ticks within one
// scheduler process lifetime (a restart resets it, same accepted tradeoff as
// every other alert-once counter in this codebase, e.g. sa_connectivity_check).
let _consecutiveDedupFailures = 0;
const MAX_CONSECUTIVE_DEDUP_FAILURES = 2; // tolerate one blip, not an outage

// Returns a Set of message IDs already recorded in the dedup table.
// Only checks the specific IDs in the current page — never does a full-table
// scan, so this stays O(page) not O(all-time).
async function getAlreadyForwardedIds(messageIds) {
  if (!messageIds.length) return new Set();
  const sb = supabase();
  const { data, error } = await sb
    .from(DEDUP_TABLE)
    .select('message_id')
    .in('message_id', messageIds);
  if (error) {
    // '42P01' = undefined_table (Postgres). This is a structural setup gap
    // (the forwarded_invoice_ids migration hasn't been applied yet), not a
    // transient Supabase outage — it will NOT self-heal on the next tick.
    // Fail-open here (like the generic branch below) would treat every
    // message in the folder as "new" on every single 5-minute run forever,
    // re-forwarding the whole folder to Joanne repeatedly instead of a
    // one-time blip. Fail closed instead: skip this run's forwards entirely
    // and say so loudly, so it gets fixed rather than silently spamming.
    if (error.code === '42P01') {
      throw new Error(
        `invoice-folder-forwarder: dedup table "${DEDUP_TABLE}" does not exist — apply supabase/migrations/20260901210000_forwarded_invoice_ids.sql before this task can run safely`
      );
    }
    _consecutiveDedupFailures++;
    if (_consecutiveDedupFailures > MAX_CONSECUTIVE_DEDUP_FAILURES) {
      throw new Error(
        `invoice-folder-forwarder: dedup lookup has failed ${_consecutiveDedupFailures} consecutive runs (Supabase outage?) — refusing to keep fail-open forwarding to avoid silently re-sending the same invoices to Joanne every tick. Last error: ${error.message}`
      );
    }
    logger.warn('invoice-folder-forwarder: dedup lookup error, failing open (blip tolerance)', {
      err: error.message,
      consecutiveFailures: _consecutiveDedupFailures,
    });
    // Fail safe for an isolated, short blip: assume all are new. This risks a
    // duplicate send in a genuine Supabase-down scenario, but the alternative
    // (blocking all forwards on every hiccup) is worse — invoices pile up
    // unforwarded over something that self-heals in seconds. Double-sends are
    // rare and auditable; blocked forwards can stay unnoticed. This tradeoff
    // only holds for a short blip — the counter above converts a SUSTAINED
    // failure into a thrown (fail-closed + alerted) error instead.
    return new Set();
  }
  _consecutiveDedupFailures = 0;
  return new Set((data ?? []).map(r => r.message_id));
}

// Record a message ID as forwarded. Called BEFORE the actual send so a crash
// mid-send doesn't cause a resend loop. An upsert (onConflict: message_id)
// makes this idempotent — a retry of this function itself is safe.
async function markForwarded(messageId, subject, receivedAt) {
  const sb = supabase();
  const { error } = await sb
    .from(DEDUP_TABLE)
    .upsert(
      {
        message_id:   messageId,
        subject:      subject ?? '(no subject)',
        received_at:  receivedAt ?? new Date().toISOString(),
        forwarded_at: new Date().toISOString(),
      },
      { onConflict: 'message_id' }
    );
  if (error) {
    // Non-fatal: log and continue. The forward will still be attempted.
    // Worst case: if this fails AND the process crashes before the forward
    // completes, the message won't be in the table, so it will be retried
    // next tick — resulting in a single duplicate forward. Acceptable.
    logger.warn('invoice-folder-forwarder: markForwarded upsert error', {
      messageId,
      err: error.message,
    });
  }
}

// ── Forward a single message ───────────────────────────────────────────────
//
// Graph's /messages/{id}/forward endpoint is the right primitive here — it
// preserves the original email headers (From, Date, Subject) in the forwarded
// message body exactly the way Outlook's own Forward button does, and
// automatically prepends "FW: " to the subject if it isn't already there.
//
// We use Graph's forward action directly rather than re-composing a new email
// with sendEmail(), because:
//   1. It preserves the original thread headers (In-Reply-To, References)
//      so Joanne's email client correctly threads the forwarded message.
//   2. It handles attachments automatically — no need to download and
//      re-attach each file; Graph streams them directly.
//   3. It correctly attributes the forward to michael@jrboehlke.com (the
//      mailbox we're acting on behalf of) rather than assistant@jrboehlke.com.

async function forwardMessage(messageId, subject) {
  // Graph's forward action sends immediately (no draft step needed) and
  // returns 202 Accepted with no body on success.
  await graph(
    'POST',
    `/users/${SOURCE_MAILBOX}/messages/${encodeURIComponent(messageId)}/forward`,
    {
      toRecipients: [
        { emailAddress: { address: FORWARD_TO } },
      ],
      comment: '',   // no cover note — a blank comment produces a clean forward
    }
  );
  logger.info('invoice-folder-forwarder: forwarded', { messageId, subject, to: FORWARD_TO });
}

// ── Main exported function ─────────────────────────────────────────────────
//
// Returns a plain result object rather than throwing for expected/recoverable
// conditions (empty folder, folder not yet created, per-message send
// failures) — only a genuine failure to even list the folder throws, which
// the cron registration in scheduler/cron.js treats as a catastrophic
// run failure (lock + alert-once-on-failure/recovery, same as
// michael_inbox_processor).

export async function runInvoiceFolderForwarder() {
  const start = Date.now();

  // ── Folder ID ────────────────────────────────────────────────────────────
  let folderId;
  try {
    folderId = await getInvoicesFolderId();
  } catch (err) {
    // Folder not found is expected on first deploy before inbox-processor
    // has ever run. Log at debug, not warn — not an actionable error yet.
    logger.debug('invoice-folder-forwarder: _Invoices folder not found (will retry next tick)', {
      err: err.message,
    });
    return { skipped: true, reason: 'folder_not_found' };
  }

  // ── Fetch messages from _Invoices ────────────────────────────────────────
  // $select keeps each page small — we only need id/subject/receivedDateTime
  // for the dedup check and the forward. The folder scan is unfiltered (no
  // $filter=isRead eq false) by design: Michael or a previous forward attempt
  // may have marked a message read, and we still want to catch any unforwarded
  // messages regardless of read state.
  //
  // Paginates through the WHOLE folder (via @odata.nextLink), not just the
  // first page. forwardMessage() only calls Graph's /forward action — it never
  // moves or deletes the source message, so already-forwarded messages stay in
  // _Invoices forever. A single $top=50 fetch with no pagination would silently
  // stop seeing older unforwarded stragglers the moment the folder accumulates
  // more than 50 messages total (forwarded + not), since $orderby=desc always
  // fills the page with the newest ones first — a real gap found in review,
  // not a hypothetical. MAX_MESSAGES_SCAN is a safety ceiling, not a normal
  // limit: `truncated` on the return value tells the caller to alert if it's
  // ever actually hit, since that would mean genuinely unbounded folder growth.
  let messages = [];
  let truncated = false;
  try {
    let path = `/users/${SOURCE_MAILBOX}/mailFolders/${folderId}/messages` +
      `?$top=${PAGE_SIZE}&$select=id,subject,receivedDateTime` +
      `&$orderby=receivedDateTime desc`;
    while (path) {
      const data = await graph('GET', path);
      messages.push(...(data.value ?? []));
      if (messages.length >= MAX_MESSAGES_SCAN) {
        truncated = true;
        logger.warn('invoice-folder-forwarder: hit MAX_MESSAGES_SCAN, stopping pagination early', {
          scanned: messages.length,
        });
        break;
      }
      path = data['@odata.nextLink'] ?? null;
    }
  } catch (err) {
    throw new Error(`invoice-folder-forwarder: failed to list _Invoices messages: ${err.message}`);
  }

  if (!messages.length) {
    logger.debug('invoice-folder-forwarder: _Invoices folder is empty');
    return { forwarded: 0, skipped: 0, errors: 0, truncated: false, duration_ms: Date.now() - start };
  }

  // ── Dedup check ───────────────────────────────────────────────────────────
  const messageIds = messages.map(m => m.id);
  const alreadyForwarded = await getAlreadyForwardedIds(messageIds);

  const toForward = messages.filter(m => !alreadyForwarded.has(m.id));

  if (!toForward.length) {
    logger.debug('invoice-folder-forwarder: all messages already forwarded', {
      total: messages.length,
    });
    return { forwarded: 0, skipped: messages.length, errors: 0, duration_ms: Date.now() - start };
  }

  logger.info('invoice-folder-forwarder: forwarding new messages', {
    total:   messages.length,
    new:     toForward.length,
    already: alreadyForwarded.size,
  });

  // ── Forward each new message ──────────────────────────────────────────────
  let forwarded = 0;
  let errors    = 0;

  for (const msg of toForward) {
    try {
      // Mark BEFORE send — a crash mid-send is safer than a double-send.
      // See module-level comment for the dedup philosophy.
      await markForwarded(msg.id, msg.subject, msg.receivedDateTime);
      await forwardMessage(msg.id, msg.subject);
      forwarded++;
    } catch (err) {
      errors++;
      logger.error('invoice-folder-forwarder: failed to forward message', {
        messageId: msg.id,
        subject:   msg.subject,
        err:       err.message,
      });
      // Continue processing remaining messages — one failure doesn't block
      // the rest. The failed message stays in the dedup table (markForwarded
      // ran first), so it won't be retried automatically. That's intentional
      // (see dedup philosophy above), which is also why the cron registration
      // alerts on `errors > 0` for THIS run specifically — a stuck message
      // will not surface again on a later tick, so this is the only chance
      // to catch it and forward it manually.
    }
  }

  const result = {
    forwarded,
    skipped:     alreadyForwarded.size,
    errors,
    duration_ms: Date.now() - start,
  };
  logger.info('invoice-folder-forwarder: run complete', result);
  return result;
}
