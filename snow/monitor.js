// snow/monitor.js
// Monitors the _Snow folder in michael@jrboehlke.com for incoming replies
// to "Snow removal for this winter" emails. Positive-intent replies are
// forwarded to support@jrboehlke.com as a properly-formatted forwarded email.
//
// Run on-demand or via the existing scheduler (every 15 min).

import { graph } from '../tools/impl/m365.js';
import { logger } from '../core/logger.js';

const MICHAEL = 'michael@jrboehlke.com';
const SUPPORT  = 'support@jrboehlke.com';
const SNOW_FOLDER_NAME = '_Snow';

// ── Positive-intent keyword detection ────────────────────────────────────────

const POSITIVE_KEYWORDS = [
  'yes', 'interested', 'please send', 'send a proposal', 'send a quote',
  'would like', "we'd like", 'we would like', 'sign us up', 'sign me up',
  'reach out', 'call me', 'give me a call', 'get a bid', 'get a quote',
  'get a proposal', 'looking for', 'need a quote', 'need a bid',
  'definitely', 'absolutely', 'for sure', 'sounds good', 'let\'s do it',
  "let's talk", 'please contact', 'contact me', 'follow up', 'available',
];

const NEGATIVE_KEYWORDS = [
  'already have', 'have a contract', 'not interested', 'no thank you',
  'no thanks', 'do not contact', 'remove me', 'unsubscribe', 'stop emailing',
  'go with someone else', 'going with someone else',
];

function isPositiveIntent(bodyText) {
  const lower = (bodyText || '').toLowerCase();
  const hasNegative = NEGATIVE_KEYWORDS.some(k => lower.includes(k));
  if (hasNegative) return false;
  return POSITIVE_KEYWORDS.some(k => lower.includes(k));
}

// ── Forwarded-email formatter ─────────────────────────────────────────────────

/**
 * Build an HTML email body that looks like a genuine forwarded message in Outlook.
 *
 * Structure:
 *   Please set up a ticket for this snow removal lead.
 *
 *   -------- Forwarded Message --------
 *   From:    Jane Smith <jane@example.com>
 *   Date:    Tuesday, September 2, 2026 at 3:14 PM
 *   Subject: RE: Snow removal for this winter
 *   To:      michael@jrboehlke.com
 *
 *   <original message body>
 */
function buildForwardedBody({ fromName, fromEmail, date, subject, to, originalBody }) {
  const formattedDate = new Date(date).toLocaleString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
    hour:    'numeric',
    minute:  '2-digit',
    timeZone: 'America/Chicago',
  });

  const fromDisplay = fromName ? `${fromName} &lt;${fromEmail}&gt;` : fromEmail;

  // Strip outer <html>/<body> tags from original so it embeds cleanly
  let innerBody = originalBody || '';
  innerBody = innerBody.replace(/<html[^>]*>/gi, '').replace(/<\/html>/gi, '');
  innerBody = innerBody.replace(/<body[^>]*>/gi, '').replace(/<\/body>/gi, '');
  innerBody = innerBody.trim();

  return `
<html>
<body style="font-family: Calibri, Arial, Helvetica, sans-serif; font-size: 11pt; color: #000;">

<p>Please set up a ticket for this snow removal lead.</p>

<hr style="border: none; border-top: 1px solid #ccc; margin: 16px 0;" />

<p style="margin: 0; font-size: 10pt; color: #444;">
  <b>-------- Forwarded Message --------</b><br>
  <b>From:</b>&nbsp;&nbsp;&nbsp;&nbsp;${fromDisplay}<br>
  <b>Date:</b>&nbsp;&nbsp;&nbsp;&nbsp;${formattedDate}<br>
  <b>Subject:</b>&nbsp;${subject}<br>
  <b>To:</b>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;${to}
</p>

<br>

<div style="border-left: 3px solid #ccc; padding-left: 12px; color: #222; font-size: 11pt;">
  ${innerBody}
</div>

</body>
</html>
`.trim();
}

// ── Core monitor logic ────────────────────────────────────────────────────────

async function getSnowFolderId() {
  const folders = await graph('GET', `/users/${MICHAEL}/mailFolders?$top=100&$select=id,displayName`);
  const folder = (folders.value ?? []).find(f => f.displayName === SNOW_FOLDER_NAME);
  if (!folder) throw new Error(`_Snow folder not found in ${MICHAEL}'s mailbox — run setup-folder.js first`);
  return folder.id;
}

async function getUnprocessedMessages(folderId) {
  // Fetch unread messages only — already-processed messages are marked read
  const data = await graph(
    'GET',
    `/users/${MICHAEL}/mailFolders/${folderId}/messages` +
    `?$filter=isRead eq false` +
    `&$top=50` +
    `&$select=id,subject,from,toRecipients,receivedDateTime,body,isRead`
  );
  return data.value ?? [];
}

async function markRead(messageId) {
  await graph('PATCH', `/users/${MICHAEL}/messages/${encodeURIComponent(messageId)}`, { isRead: true });
}

async function forwardToSupport(message) {
  const fromEmail = message.from?.emailAddress?.address ?? '';
  const fromName  = message.from?.emailAddress?.name ?? '';
  const date      = message.receivedDateTime;
  const subject   = message.subject ?? 'RE: Snow removal for this winter';
  const to        = (message.toRecipients ?? []).map(r => r.emailAddress?.address).join(', ') || MICHAEL;
  const bodyHtml  = message.body?.content ?? '';

  const forwardedBody = buildForwardedBody({ fromName, fromEmail, date, subject, to, originalBody: bodyHtml });

  await graph('POST', `/users/${MICHAEL}/sendMail`, {
    message: {
      subject: `Fwd: ${subject}`,
      body: { contentType: 'HTML', content: forwardedBody },
      toRecipients: [{ emailAddress: { address: SUPPORT } }],
    },
    saveToSentItems: true,
  });

  logger.info('Snow reply forwarded to support', { from: fromEmail, subject });
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runSnowMonitor() {
  logger.info('Snow monitor: starting run');

  const folderId = await getSnowFolderId();
  const messages = await getUnprocessedMessages(folderId);

  logger.info(`Snow monitor: found ${messages.length} unread message(s) in _Snow`);

  const results = { total: messages.length, forwarded: 0, skipped: 0, errors: 0 };

  for (const msg of messages) {
    try {
      const bodyText = msg.body?.content ?? '';
      const positive = isPositiveIntent(bodyText);

      if (positive) {
        await forwardToSupport(msg);
        results.forwarded++;
        logger.info('Snow monitor: positive reply → forwarded', {
          id:      msg.id,
          from:    msg.from?.emailAddress?.address,
          subject: msg.subject,
        });
      } else {
        results.skipped++;
        logger.info('Snow monitor: neutral/negative reply → skipped forward', {
          id:      msg.id,
          from:    msg.from?.emailAddress?.address,
          subject: msg.subject,
        });
      }

      // Mark read regardless so we don't process it again on the next run
      await markRead(msg.id);
    } catch (err) {
      results.errors++;
      logger.error('Snow monitor: error processing message', { id: msg.id, error: err.message });
    }
  }

  logger.info('Snow monitor: run complete', results);
  return results;
}

// Allow direct execution: node snow/monitor.js
if (process.argv[1] === new URL(import.meta.url).pathname) {
  runSnowMonitor()
    .then(r => console.log('Done:', r))
    .catch(err => { console.error(err); process.exit(1); });
}
