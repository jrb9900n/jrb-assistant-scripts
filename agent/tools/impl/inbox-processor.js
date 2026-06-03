// tools/impl/inbox-processor.js
// Autonomous triage engine for michael@jrboehlke.com.
// Runs every 15 minutes via scheduler/cron.js.
//
// What it does per run:
//   1. Fetch unread emails from Michael's inbox (last 48h, unprocessed only)
//   2. Batch-classify all of them with one Haiku call (category, priority, intent)
//   3. Move each to the matching folder in Michael's mailbox
//   4. For P1 / hot-trigger emails: send immediate Teams alert
//   5. For draft-needed P1s: generate a Sonnet reply draft, save to his Drafts
//   6. Upsert all results to email_triage in Supabase

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';
import {
  searchEmails,
  getEmail,
  moveEmail,
  listMailFolders,
  createMailFolder,
  renameMailFolder,
  createReplyDraft,
} from './m365.js';
import { sendProactiveMessage } from '../../teams/notify.js';

const MICHAEL = 'michael@jrboehlke.com';
const HAIKU   = 'claude-haiku-4-5-20251001';
const SONNET  = 'claude-sonnet-4-6';

// ── Supabase ─────────────────────────────────────────────────────────────────

function supabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// ── Folder routing ───────────────────────────────────────────────────────────

const FOLDER_MAP = {
  quote_request:    'aaa Quotes & Estimates',
  customer:         'aaa Customers',
  vendor:           'aaa Vendors',
  invoice:          'aaa Invoices',
  crew:             'aaa Crew',
  admin:            'aaa Admin',
  legal:            'aaa Admin',    // legal goes into Admin; flag in triage
  spam:             'Junk Email',
  other:            null,           // leave in inbox
};

// Old folder names (pre-aaa prefix) that need renaming on first run
const LEGACY_FOLDER_NAMES = {
  'Quotes & Estimates': 'aaa Quotes & Estimates',
  'Customers':          'aaa Customers',
  'Vendors':            'aaa Vendors',
  'Invoices':           'aaa Invoices',
  'Crew':               'aaa Crew',
  'Admin':              'aaa Admin',
};

// Cache folder name → id for Michael's mailbox (reset on each run)
let _folderCache = null;

async function getFolderCache() {
  if (_folderCache) return _folderCache;
  const folders = await listMailFolders({ userEmail: MICHAEL });
  _folderCache = {};
  for (const f of folders) _folderCache[f.name] = f.id;
  return _folderCache;
}

// Rename any legacy (non-prefixed) folders to their aaa versions.
// Called once per processInbox run before any moves.
async function migrateLegacyFolders() {
  const cache = await getFolderCache();
  const renamed = [];
  for (const [oldName, newName] of Object.entries(LEGACY_FOLDER_NAMES)) {
    if (cache[oldName] && !cache[newName]) {
      try {
        await renameMailFolder({ userEmail: MICHAEL, folder_id: cache[oldName], name: newName });
        cache[newName] = cache[oldName];
        delete cache[oldName];
        renamed.push(`${oldName} → ${newName}`);
        logger.info(`inbox-processor: renamed folder "${oldName}" → "${newName}"`);
      } catch (err) {
        logger.warn(`inbox-processor: could not rename folder "${oldName}"`, { err: err.message });
      }
    }
  }
  return renamed;
}

// Ensure all target folders exist, creating any that are missing.
async function ensureFolder(name) {
  const cache = await getFolderCache();
  if (cache[name]) return cache[name];
  const { folder_id } = await createMailFolder({ userEmail: MICHAEL, name });
  cache[name] = folder_id;
  logger.info(`inbox-processor: created folder "${name}"`, { folder_id });
  return folder_id;
}

// ── Already-processed check ──────────────────────────────────────────────────

async function getProcessedIds(messageIds) {
  if (!messageIds.length) return new Set();
  const { data, error } = await supabase()
    .from('email_triage')
    .select('message_id')
    .in('message_id', messageIds);
  if (error) {
    logger.warn('inbox-processor: could not query email_triage', { error: error.message });
    return new Set();
  }
  return new Set((data ?? []).map(r => r.message_id));
}

// ── Batch LLM classification ─────────────────────────────────────────────────

const CLASSIFY_SYSTEM = `You classify emails arriving in the inbox of Michael Reardon, owner of J.R. Boehlke LLC — an asphalt, concrete, landscape, and snow contractor in SE Wisconsin / metro Milwaukee.

Return a JSON object: { "classifications": [...] }

For each email include:
  message_id    — echo back unchanged
  priority      — "p1" | "p2" | "p3"
  category      — "quote_request" | "customer" | "vendor" | "invoice" | "crew" | "admin" | "legal" | "spam" | "other"
  intent        — one sentence: what the sender wants or is communicating
  meeting_request — boolean
  draft_needed  — boolean (true when a prompt reply would be useful)
  action_items  — string[] (commitments, deadlines, or tasks detected)
  hot_trigger   — boolean (needs immediate alert, can't wait until morning)
  hot_reason    — string (why — empty if not hot)

Priority rules:
  p1: new quote/lead requests; active customer with job question; legal/insurance notices with deadlines;
      bank issues (fraud, large overdraft); meeting requests; emails mentioning a date/deadline ≤ 7 days out
  p2: vendor follow-ups; general customer inquiries; routine billing/invoices; estimate follow-ups
  p3: newsletters; automated notifications; payment receipts; marketing; general FYI

Hot trigger rules (immediate Teams alert regardless of time):
  • New quote or lead request from a prospective customer
  • Legal notice, lien, lawsuit, or permit issue
  • Bank fraud alert or account issue
  • Any email referencing a deadline TODAY or TOMORROW
  • Email from an attorney or with subject containing "legal action", "lien", "complaint"
  • Anything referencing a large dollar amount (> $5000) that needs a decision

Draft-needed: true when the email is a p1 that clearly warrants a reply (not spam, not FYI).`;

async function batchClassify(emails) {
  if (!emails.length) return [];
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const emailsPayload = emails.map(e => ({
    message_id: e.id,
    from:       e.from,
    from_name:  e.from_name,
    subject:    e.subject,
    snippet:    e.snippet?.slice(0, 300),
    received:   e.date,
  }));

  const resp = await anthropic.messages.create({
    model:      HAIKU,
    max_tokens: 4096,
    system:     CLASSIFY_SYSTEM,
    messages: [{
      role:    'user',
      content: `Classify these ${emails.length} emails:\n\n${JSON.stringify(emailsPayload, null, 2)}`,
    }],
  });

  const raw = resp.content[0]?.text ?? '{}';
  // Extract JSON even if the model wraps it in markdown
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    logger.warn('inbox-processor: classifier returned no JSON', { raw: raw.slice(0, 200) });
    return [];
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return parsed.classifications ?? [];
  } catch (err) {
    logger.warn('inbox-processor: JSON parse error', { err: err.message });
    return [];
  }
}

// ── Draft reply generation ───────────────────────────────────────────────────

const DRAFT_SYSTEM = `You write concise, professional email replies on behalf of Michael Reardon at J.R. Boehlke LLC.

Company: J.R. Boehlke
Phone: 262-242-9924
Sign all emails as: Michael

Rules:
- Never make commitments about pricing or timing you don't know
- For quote requests: acknowledge receipt, promise a reply within 2 business days, offer phone number
- For meeting requests: express willingness, say you'll follow up to confirm a time
- For customer job inquiries: acknowledge and say you'll look into it
- Keep replies to 3-5 sentences maximum
- Plain, friendly, professional tone — not formal/stiff
- Output ONLY the HTML email body (no subject line, no "From:", no markdown). Use <p> tags.`;

async function generateDraftBody(email, classification) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const resp = await anthropic.messages.create({
    model:      SONNET,
    max_tokens: 512,
    system:     DRAFT_SYSTEM,
    messages: [{
      role:    'user',
      content: `Write a reply to this email.\n\nFrom: ${email.from_name ?? email.from}\nSubject: ${email.subject}\nMessage: ${email.snippet?.slice(0, 600)}\n\nIntent: ${classification.intent}`,
    }],
  });
  return resp.content[0]?.text ?? '';
}

// ── Upsert to email_triage ───────────────────────────────────────────────────

async function upsertTriage(rows) {
  if (!rows.length) return;
  const { error } = await supabase()
    .from('email_triage')
    .upsert(rows, { onConflict: 'message_id' });
  if (error) logger.warn('inbox-processor: email_triage upsert error', { error: error.message });
}

// ── Teams alert formatter ────────────────────────────────────────────────────

function buildTeamsAlert(email, classification, draftSaved) {
  const priorityLabel = { p1: '🔴 P1', p2: '🟡 P2', p3: '🟢 P3' }[classification.priority] ?? classification.priority;
  const lines = [
    `${priorityLabel} — ${classification.hot_trigger ? '⚡ HOT TRIGGER' : 'New Email'}`,
    `From: ${email.from_name ? `${email.from_name} <${email.from}>` : email.from}`,
    `Subject: ${email.subject}`,
    `Category: ${classification.category.replace('_', ' ')}`,
    `Intent: ${classification.intent}`,
  ];
  if (classification.action_items?.length) {
    lines.push(`Action items: ${classification.action_items.join(' | ')}`);
  }
  if (draftSaved) lines.push(`✍️ Draft reply saved to your Drafts folder`);
  if (classification.meeting_request) lines.push(`📅 Meeting request detected`);
  return lines.join('\n');
}

// ── Follow-up scanner ────────────────────────────────────────────────────────
// Scans Michael's Sent folder for emails with no reply after FOLLOWUP_DAYS.
// Upserts unresolved items to email_followup_tracker.

const FOLLOWUP_DAYS = 3;
const FOLLOWUP_SCAN_DAYS = 14;

export async function scanFollowups() {
  const { listSentEmails, getThreadEmails } = await import('./m365.js');
  const db = supabase();

  const cutoff = new Date(Date.now() - FOLLOWUP_SCAN_DAYS * 86400000).toISOString();
  const sent = await listSentEmails({ userEmail: MICHAEL, limit: 60, afterDate: cutoff });

  // Only care about emails to external recipients (not to himself or assistant@)
  const external = sent.filter(m =>
    m.to.some(addr => addr && !addr.includes('jrboehlke.com'))
  );

  const newRows = [];
  for (const msg of external) {
    const sentAge = (Date.now() - new Date(msg.date).getTime()) / 86400000;
    if (sentAge < FOLLOWUP_DAYS) continue; // too fresh

    // Check if there's any message in this thread after Michael's sent email
    const thread = await getThreadEmails({ userEmail: MICHAEL, thread_id: msg.thread_id, limit: 5 });
    const hasReply = thread.some(m =>
      m.from && !m.from.includes('jrboehlke.com') &&
      new Date(m.date) > new Date(msg.date)
    );
    if (hasReply) continue;

    newRows.push({
      thread_id:      msg.thread_id,
      message_id:     msg.id,
      to_address:     msg.to[0] ?? '',
      subject:        msg.subject,
      sent_at:        msg.date,
      followup_after: new Date(new Date(msg.date).getTime() + FOLLOWUP_DAYS * 86400000).toISOString(),
    });
  }

  if (!newRows.length) return { scanned: external.length, new_followups: 0 };

  // Upsert — on conflict (thread_id) do nothing (preserves resolved_at if already resolved)
  const { error } = await db
    .from('email_followup_tracker')
    .upsert(newRows, { onConflict: 'thread_id', ignoreDuplicates: true });

  if (error) logger.warn('inbox-processor: followup_tracker upsert error', { error: error.message });

  // Auto-resolve any threads that now have a reply (clear old unresolved rows)
  const { data: unresolved } = await db
    .from('email_followup_tracker')
    .select('id, thread_id, message_id')
    .is('resolved_at', null);

  for (const row of (unresolved ?? [])) {
    const thread = await getThreadEmails({ userEmail: MICHAEL, thread_id: row.thread_id, limit: 5 });
    const hasReply = thread.some(m =>
      m.from && !m.from.includes('jrboehlke.com') &&
      new Date(m.date) > new Date(row.sent_at ?? 0)
    );
    if (hasReply) {
      await db.from('email_followup_tracker').update({
        resolved_at: new Date().toISOString(),
        resolution_type: 'replied',
      }).eq('id', row.id);
    }
  }

  logger.info('inbox-processor: followup scan complete', { scanned: external.length, new_followups: newRows.length });
  return { scanned: external.length, new_followups: newRows.length };
}

// ── Main: processInbox ───────────────────────────────────────────────────────

export async function processInbox() {
  const start = Date.now();
  logger.info('inbox-processor: starting run');
  _folderCache = null; // reset folder cache each run

  // 0. Rename any legacy folders (Admin → aaa Admin, etc.) so they sort to top
  let renamedFolders = [];
  try {
    renamedFolders = await migrateLegacyFolders();
    if (renamedFolders.length) logger.info('inbox-processor: migrated folders', { renamedFolders });
  } catch (err) {
    logger.warn('inbox-processor: folder migration error (non-fatal)', { err: err.message });
  }

  // 1. Fetch unread emails from Michael's inbox (last 48h)
  const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  let unread;
  try {
    unread = await searchEmails({
      userEmail:   MICHAEL,
      folder:      'Inbox',
      limit:       50,
      afterDate:   cutoff48h,
    });
    // searchEmails with folder + afterDate uses $filter, not $search, so is_read filtering
    // happens here. We only want unread ones.
    unread = unread.filter(m => m.is_read === false);
  } catch (err) {
    logger.error('inbox-processor: failed to fetch unread emails', { err: err.message });
    return { error: err.message };
  }

  if (!unread.length) {
    logger.info('inbox-processor: no unread emails — done');
    return { processed: 0, duration_ms: Date.now() - start };
  }

  // 2. Filter to emails not yet triaged
  const ids = unread.map(m => m.id);
  const alreadyProcessed = await getProcessedIds(ids);
  const toProcess = unread.filter(m => !alreadyProcessed.has(m.id));

  if (!toProcess.length) {
    logger.info('inbox-processor: all unread emails already triaged');
    return { processed: 0, duration_ms: Date.now() - start };
  }

  logger.info(`inbox-processor: classifying ${toProcess.length} new emails`);

  // 3. Batch classify
  let classifications;
  try {
    classifications = await batchClassify(toProcess);
  } catch (err) {
    logger.error('inbox-processor: classify failed', { err: err.message });
    return { error: err.message };
  }

  // Build a map for quick lookup
  const classMap = Object.fromEntries(classifications.map(c => [c.message_id, c]));

  // 4. Process each email
  const triageRows  = [];
  const teamsAlerts = [];
  const moveErrors  = [];
  let drafted = 0;
  let moved   = 0;
  let alerted = 0;

  for (const email of toProcess) {
    const cls = classMap[email.id];
    if (!cls) {
      // Classifier didn't return a result for this email — log and skip
      logger.warn('inbox-processor: no classification for message', { id: email.id, subject: email.subject });
      triageRows.push({
        message_id:   email.id,
        thread_id:    email.thread_id,
        from_address: email.from,
        from_name:    email.from_name,
        subject:      email.subject,
        received_at:  email.date,
        priority:     'p3',
        category:     'other',
        intent:       'unclassified',
        action_items: [],
        hot_trigger:  false,
        teams_alerted: false,
      });
      continue;
    }

    let folder_moved_to = null;
    let draft_id        = null;
    let teams_alerted   = false;

    // 4a. Move to folder
    const targetFolder = FOLDER_MAP[cls.category];
    if (targetFolder) {
      try {
        const folderId = await ensureFolder(targetFolder);
        await moveEmail({ userEmail: MICHAEL, email_id: email.id, destination_folder_id: folderId });
        folder_moved_to = targetFolder;
        moved++;
        logger.info(`inbox-processor: moved "${email.subject}" → ${targetFolder}`);
      } catch (err) {
        logger.warn('inbox-processor: move failed', {
          subject: email.subject,
          from: email.from,
          target: targetFolder,
          err: err.message,
        });
        moveErrors.push(`${email.subject}: ${err.message}`);
      }
    }

    // 4b. Draft reply for P1 draft-needed emails
    if ((cls.priority === 'p1' || cls.hot_trigger) && cls.draft_needed) {
      try {
        const body = await generateDraftBody(email, cls);
        if (body) {
          const { draft_id: did } = await createReplyDraft({ userEmail: MICHAEL, email_id: email.id, body });
          draft_id = did;
          drafted++;
        }
      } catch (err) {
        logger.warn('inbox-processor: draft generation failed', { id: email.id, err: err.message });
      }
    }

    // 4c. Immediate Teams alert for P1 and hot triggers
    if (cls.priority === 'p1' || cls.hot_trigger) {
      try {
        const msg = buildTeamsAlert(email, cls, !!draft_id);
        teamsAlerts.push(msg);
        alerted++;
        teams_alerted = true;
      } catch (err) {
        logger.warn('inbox-processor: Teams alert build failed', { err: err.message });
      }
    }

    triageRows.push({
      message_id:      email.id,
      thread_id:       email.thread_id,
      from_address:    email.from,
      from_name:       email.from_name,
      subject:         email.subject,
      received_at:     email.date,
      priority:        cls.priority,
      category:        cls.category,
      intent:          cls.intent,
      folder_moved_to,
      meeting_detected: cls.meeting_request ?? false,
      draft_id,
      action_items:    cls.action_items ?? [],
      hot_trigger:     cls.hot_trigger ?? false,
      hot_reason:      cls.hot_reason ?? '',
      teams_alerted,
    });
  }

  // 5. Upsert triage rows to Supabase
  await upsertTriage(triageRows);

  // 6. Send Teams alerts (batch them into one message if multiple, to avoid spam)
  if (teamsAlerts.length) {
    try {
      const header = teamsAlerts.length === 1
        ? ''
        : `📬 ${teamsAlerts.length} priority emails — action needed\n${'─'.repeat(40)}\n\n`;
      await sendProactiveMessage(header + teamsAlerts.join('\n\n' + '─'.repeat(40) + '\n\n'));
    } catch (err) {
      logger.warn('inbox-processor: Teams send failed', { err: err.message });
    }
  }

  const summary = {
    processed:       toProcess.length,
    moved,
    drafted,
    alerted,
    folders_renamed: renamedFolders.length,
    p1_count:        triageRows.filter(r => r.priority === 'p1').length,
    p2_count:        triageRows.filter(r => r.priority === 'p2').length,
    p3_count:        triageRows.filter(r => r.priority === 'p3').length,
    move_errors:     moveErrors.length ? moveErrors : undefined,
    duration_ms:     Date.now() - start,
  };

  logger.info('inbox-processor: run complete', summary);
  return summary;
}
