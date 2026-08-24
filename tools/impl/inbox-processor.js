// tools/impl/inbox-processor.js
// Autonomous triage engine for michael@jrboehlke.com.
// Runs every 15 minutes via scheduler/cron.js.
//
// What it does per run:
//   1. Fetch unread emails from Michael's inbox (last 48h, unprocessed only)
//   2. Batch-classify all of them with one Haiku call (category, bucket, intent)
//      — bucket is Fyxer.ai-style: "needs_reply" | "fyi" | "marketing"
//   3. Move each to the matching folder in Michael's mailbox
//   4. For needs_reply / hot-trigger emails: send immediate Teams alert
//   5. For draft-needed needs_reply emails: generate a Sonnet reply draft
//      (tone-matched to Michael's own past emails to that recipient, when
//      history exists), save to his Drafts
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
  getSentEmailsTo,
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
  legal:            'aaa Admin',        // legal goes into Admin; flag in triage
  promotional:      'aaa Low Priority', // ads, newsletters, marketing, solicitations
  marketing:        'aaa Low Priority', // alias — classifier sometimes uses this instead of promotional
  other:            'aaa Low Priority', // unclassified → low priority, not inbox clutter
  spam:             'Junk Email',       // true spam → Outlook's built-in junk
};

// Old folder names (pre-aaa prefix) that need renaming on first run
const LEGACY_FOLDER_NAMES = {
  'Quotes & Estimates': 'aaa Quotes & Estimates',
  'Customers':          'aaa Customers',
  'Vendors':            'aaa Vendors',
  'Invoices':           'aaa Invoices',
  'Crew':               'aaa Crew',
  'Admin':              'aaa Admin',
  'Low Priority':       'aaa Low Priority',
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

// ── Known notification senders — always P3, never hot trigger ────────────────
// These are automated services whose emails are informational only.
// They are pre-classified before hitting the LLM to avoid false P1 alerts.

const NOTIFICATION_SENDER_DOMAINS = [
  'callrail.com',       // call tracking notifications
  'mail.callrail.com',
  'notifications.google.com',
  'googlealerts-noreply.google.com',
  'docusign.net',       // signature completed notifications
  'hellosign.com',
  'noreply.github.com',
  'notifications.github.com',
  'mail.notion.so',
  'zapier.com',
];

const NOTIFICATION_SENDER_PREFIXES = [
  'no-reply@',
  'noreply@',
  'donotreply@',
  'notifications@',
  'notify@',
  'alert@',
  'alerts@',
  'mailer@',
  'bounce@',
  'auto@',
  'automated@',
];

function isKnownNotificationSender(fromAddress) {
  if (!fromAddress) return false;
  const addr = fromAddress.toLowerCase();
  if (NOTIFICATION_SENDER_DOMAINS.some(d => addr.endsWith(`@${d}`) || addr.includes(`.${d}`))) return true;
  if (NOTIFICATION_SENDER_PREFIXES.some(p => addr.startsWith(p))) return true;
  return false;
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

// Fyxer-style 3-bucket model (replaces the old p1/p2/p3 priority scheme,
// 2026-08-24 — Michael explicitly preferred Fyxer.ai's simpler "Needs a
// Reply / FYI / Marketing" taxonomy over a numeric priority tier). `category`
// is a separate, orthogonal axis kept unchanged — it drives folder filing
// (FOLDER_MAP below), while `bucket` drives attention/alerting/drafting.
const CLASSIFY_SYSTEM = `You classify emails arriving in the inbox of Michael Reardon, owner of J.R. Boehlke LLC — an asphalt, concrete, landscape, and snow contractor in SE Wisconsin / metro Milwaukee.

Return a JSON object: { "classifications": [...] }

For each email include:
  message_id    — echo back unchanged
  bucket        — "needs_reply" | "fyi" | "marketing"
  category      — "quote_request" | "customer" | "vendor" | "invoice" | "crew" | "admin" | "legal" | "promotional" | "spam" | "other"
  intent        — one sentence: what the sender wants or is communicating
  meeting_request — boolean
  draft_needed  — boolean (true when a prompt reply would be useful)
  action_items  — string[] (commitments, deadlines, or tasks detected)
  hot_trigger   — boolean (needs immediate alert, can't wait until morning)
  hot_reason    — string (why — empty if not hot)

Category definitions:
  quote_request  — prospective customer asking for a price, estimate, or service
  customer       — existing or active customer: job question, follow-up, complaint
  vendor         — supplier, subcontractor, material order, delivery notice
  invoice        — billing statement, payment confirmation, receipt from a vendor
  crew           — message from field staff (Dave, Noah, Eric, Don)
  admin          — bank alerts, insurance, M365 system emails, government, permits
  legal          — contracts, legal notices, liens, attorney correspondence
  promotional    — newsletters, advertisements, marketing emails, sales pitches, solicitations, subscription digests, coupon/promo emails, event invites from companies you don't have a direct relationship with
  spam           — unsolicited junk with no relevance, phishing attempts, obvious bulk spam
  other          — doesn't fit any above category

Bucket rules:
  needs_reply: new quote/lead requests; active customer with a job question; legal/insurance notices with
      deadlines; bank issues (fraud, large overdraft); meeting requests; vendor questions that need an
      answer; anything a reasonable person would feel obligated to respond to
  fyi          : automated notifications, payment receipts/confirmations, routine billing statements with
      nothing to decide, informational updates, system emails — worth knowing about, nothing to act on
  marketing    : newsletters, advertisements, sales pitches, promotional/marketing emails, solicitations,
      subscription digests — noise, not signal

Hot trigger rules (immediate Teams alert regardless of time — always implies bucket "needs_reply"):
  • A DIRECT email from a prospective customer asking for a quote or service
  • Legal notice, lien, lawsuit, or permit issue
  • Bank fraud alert or account issue
  • Any email referencing a deadline TODAY or TOMORROW
  • Email from an attorney or with subject containing "legal action", "lien", "complaint"
  • Anything referencing a large dollar amount (> $5000) that needs a decision

NEVER hot trigger (even if content mentions a lead or customer):
  • Automated notification emails (CallRail call alerts, Google alerts, form submission notifications)
  • Any email from a no-reply address — these are system-generated, not from a human
  • CRM or call tracking software notifications about activity
  • These should always be bucket "fyi", category "admin"

Draft-needed: true when the email is "needs_reply" and clearly warrants a reply — must be from a real human, not an automated system.`;

// Max emails per Haiku call. Confirmed live 2026-08-24: a 39-email batch at
// max_tokens 4096 got cut off mid-array ("Expected ',' or ']' ... at position
// 8602"), silently dropping classification for the ENTIRE batch — not just
// the emails past the cutoff, since the whole response failed to parse as
// JSON. Chunking keeps each call comfortably under the token budget instead
// of just raising max_tokens once, since an inbox that's been quiet for a
// while (larger unprocessed batch) could exceed any fixed ceiling.
const CLASSIFY_CHUNK_SIZE = 15;

async function classifyChunk(anthropic, emails) {
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
    logger.warn('inbox-processor: JSON parse error', { err: err.message, chunkSize: emails.length });
    return [];
  }
}

async function batchClassify(emails) {
  if (!emails.length) return [];
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const results = [];
  for (let i = 0; i < emails.length; i += CLASSIFY_CHUNK_SIZE) {
    const chunk = emails.slice(i, i + CLASSIFY_CHUNK_SIZE);
    // Sequential, not parallel — this runs every 15 min, not latency-sensitive,
    // and avoids bursting concurrent Haiku calls against rate limits.
    const chunkResults = await classifyChunk(anthropic, chunk);
    results.push(...chunkResults);
  }
  return results;
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
- Output ONLY the HTML email body (no subject line, no "From:", no markdown). Use <p> tags.`;

// Fyxer-style tone-matching (2026-08-24): before drafting, look at how Michael
// has actually written to THIS person before, and have Sonnet match that style
// instead of always falling back to the same generic instruction. Best-effort —
// a lookup failure or a first-time sender just falls through to the generic tone.
async function getToneExamples(recipientAddress) {
  if (!recipientAddress) return [];
  try {
    const past = await getSentEmailsTo({ userEmail: MICHAEL, recipientAddress, limit: 3 });
    return past.filter(p => p.body?.trim()).map(p => ({ subject: p.subject, body: p.body }));
  } catch (err) {
    logger.warn('inbox-processor: tone-example lookup failed (non-fatal)', { recipientAddress, err: err.message });
    return [];
  }
}

async function generateDraftBody(email, classification) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const toneExamples = await getToneExamples(email.from);

  let toneBlock = '- Plain, friendly, professional tone — not formal/stiff';
  if (toneExamples.length) {
    const examples = toneExamples
      .map((ex, i) => `Example ${i + 1} (subject: "${ex.subject}"):\n${ex.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500)}`)
      .join('\n\n');
    toneBlock = `- Match the tone/style Michael has actually used with this specific person before — formality level, sign-off, sentence length. Real past examples of Michael writing to this person:\n\n${examples}`;
  }

  const resp = await anthropic.messages.create({
    model:      SONNET,
    max_tokens: 512,
    system:     `${DRAFT_SYSTEM}\n\n${toneBlock}`,
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
  const bucketLabel = { needs_reply: '🔴 Needs a Reply', fyi: '🟢 FYI', marketing: '⚪ Marketing' }[classification.bucket] ?? classification.bucket;
  const lines = [
    `${bucketLabel} — ${classification.hot_trigger ? '⚡ HOT TRIGGER' : 'New Email'}`,
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

  // 2b. Pre-classify known notification senders as fyi/admin — skip LLM for these
  const preClassified = [];
  const needsClassification = [];
  for (const email of toProcess) {
    if (isKnownNotificationSender(email.from)) {
      preClassified.push({
        message_id:      email.id,
        bucket:          'fyi',
        category:        'admin',
        intent:          'Automated notification — no action required.',
        meeting_request: false,
        draft_needed:    false,
        action_items:    [],
        hot_trigger:     false,
        hot_reason:      '',
      });
    } else {
      needsClassification.push(email);
    }
  }
  if (preClassified.length) {
    logger.info(`inbox-processor: pre-classified ${preClassified.length} notification sender(s) as P3`);
  }

  logger.info(`inbox-processor: classifying ${needsClassification.length} new emails`);

  // 3. Batch classify
  let classifications;
  try {
    classifications = needsClassification.length ? await batchClassify(needsClassification) : [];
  } catch (err) {
    logger.error('inbox-processor: classify failed', { err: err.message });
    return { error: err.message };
  }

  // Build a map for quick lookup — merge LLM results with pre-classified
  const classMap = Object.fromEntries(
    [...preClassified, ...classifications].map(c => [c.message_id, c])
  );

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
        bucket:       'fyi',
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

    // 4a. Draft reply for needs_reply draft-needed emails — MUST run before the
    // folder move below. Confirmed live 2026-08-24: moving a message changes
    // its Graph id in this tenant (non-immutable IDs), so createReply against
    // the post-move id 404s ("specified object was not found in the store")
    // every single time. Drafting against the still-valid pre-move id first
    // fixes this — this was a real, pre-existing 100%-failure-rate bug, not
    // just a theoretical ordering concern.
    if ((cls.bucket === 'needs_reply' || cls.hot_trigger) && cls.draft_needed) {
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

    // 4b. Move to folder
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

    // 4c. Immediate Teams alert for needs_reply and hot triggers
    if (cls.bucket === 'needs_reply' || cls.hot_trigger) {
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
      bucket:          cls.bucket,
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
        : `📬 ${teamsAlerts.length} emails need a reply\n${'─'.repeat(40)}\n\n`;
      await sendProactiveMessage(header + teamsAlerts.join('\n\n' + '─'.repeat(40) + '\n\n'));
    } catch (err) {
      logger.warn('inbox-processor: Teams send failed', { err: err.message });
    }
  }

  const summary = {
    processed:          toProcess.length,
    moved,
    drafted,
    alerted,
    folders_renamed:    renamedFolders.length,
    needs_reply_count:  triageRows.filter(r => r.bucket === 'needs_reply').length,
    fyi_count:          triageRows.filter(r => r.bucket === 'fyi').length,
    marketing_count:    triageRows.filter(r => r.bucket === 'marketing').length,
    move_errors:        moveErrors.length ? moveErrors : undefined,
    duration_ms:        Date.now() - start,
  };

  logger.info('inbox-processor: run complete', summary);
  return summary;
}
