// tools/impl/m365.js — Microsoft Graph API wrapper
// Covers email, calendar, OneDrive, and SharePoint.

import axios from 'axios';
import XLSX from 'xlsx';
import { logger } from '../../core/logger.js';
import { createClient } from '@supabase/supabase-js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

// ── Auth ─────────────────────────────────────────────────────
let _tokenCache = { token: null, expiresAt: 0 };

function supabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

async function getToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.token;
  }
  const res = await axios.post(
    `https://login.microsoftonline.com/${process.env.M365_TENANT_ID}/oauth2/v2.0/token`,
    new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     process.env.M365_CLIENT_ID,
      client_secret: process.env.M365_CLIENT_SECRET,
      scope:         'https://graph.microsoft.com/.default',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  _tokenCache = {
    token:     res.data.access_token,
    expiresAt: Date.now() + res.data.expires_in * 1000,
  };
  return _tokenCache.token;
}


export async function graph(method, path, data, extraHeaders) {
  const token = await getToken();
  const url = path.startsWith('http') ? path : `${GRAPH}${path}`;
  try {
    const res = await axios({ method, url, data, headers: { Authorization: `Bearer ${token}`, ...extraHeaders } });
    return res.data;
  } catch (err) {
    const body = err.response?.data;
    const msg = body?.error?.message ?? body?.error?.code ?? JSON.stringify(body) ?? err.message;
    throw new Error(`Graph ${method} ${path.slice(0, 80)} → ${err.response?.status ?? err.code ?? 'network'}: ${msg}`);
  }
}

const USER = () => process.env.M365_USER_EMAIL;

// Calendar tools default to Michael's own calendar, not the assistant's --
// unlike email/SharePoint (genuinely the assistant's own mailbox/files),
// every real business use of these calendar functions in this codebase is
// about Michael's calendar (every hardcoded call site already passes
// userEmail explicitly; nothing relies on the assistant@ default). The
// default only matters when an LLM tool call omits userEmail, and confirmed
// live 2026-08-24 that this is a real failure mode: asked to check for
// calendar conflicts, the model called list_calendar_events without
// userEmail, silently read the (empty) assistant calendar, and confidently
// reported "your calendar is completely clear" -- while create_calendar_event
// calls in the same run DID pass Michael's address, so the new events landed
// correctly even though the conflict check that should have caught overlaps
// never actually looked at his calendar at all.
const MICHAEL_CALENDAR = 'michael@jrboehlke.com';

// ── Email ─────────────────────────────────────────────────────

export async function listEmails({ folder = 'Inbox', limit = 20, unread_only = false, userEmail } = {}) {
  const user = userEmail ?? USER();
  const filter = unread_only ? '&$filter=isRead eq false' : '';
  const data = await graph(
    'GET',
    `/users/${user}/mailFolders/${folder}/messages?$top=${limit}&$select=id,subject,from,receivedDateTime,bodyPreview${filter}`
  );
  return data.value.map(m => ({
    id:       m.id,
    from:     m.from?.emailAddress?.address,
    subject:  m.subject,
    date:     m.receivedDateTime,
    snippet:  m.bodyPreview?.slice(0, 200),
  }));
}

// Lists drafts (well-known "drafts" folder) last modified before the given
// cutoff — i.e. genuinely stale/abandoned, not just old-but-recently-edited.
// Paginates via @odata.nextLink (same pattern as getCalendarViewWithCategories
// above) -- confirmed live 2026-08-24 this mailbox has 400+ qualifying drafts
// going back to 2023, well past a single $top page; an earlier unpaginated
// version silently truncated at 200 and looked "done" after only clearing
// the first page.
export async function getOldDrafts({ userEmail, olderThanDays = 30, maxPages = 50 } = {}) {
  const user = userEmail ?? USER();
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  let url = `/users/${user}/mailFolders/drafts/messages?$filter=lastModifiedDateTime le ${cutoff}` +
    `&$select=id,subject,lastModifiedDateTime,toRecipients&$top=200`;
  const raw = [];
  let pages = 0;
  while (url && pages < maxPages) {
    const data = await graph('GET', url);
    raw.push(...(data.value ?? []));
    url = data['@odata.nextLink'] || null;
    pages++;
  }
  if (url) {
    logger.warn('getOldDrafts: hit maxPages cap with more pages remaining', { user, olderThanDays, maxPages });
  }
  return raw.map(m => ({
    id:                   m.id,
    subject:              m.subject,
    lastModifiedDateTime: m.lastModifiedDateTime,
    to:                   (m.toRecipients ?? []).map(r => r.emailAddress?.address),
  }));
}

// Permanently deletes a message (any folder, including drafts). No recovery —
// Graph's message DELETE bypasses Deleted Items for drafts.
export async function deleteEmail({ email_id, userEmail } = {}) {
  const user = userEmail ?? USER();
  await graph('DELETE', `/users/${user}/messages/${encodeURIComponent(email_id)}`);
  logger.info('Email deleted', { user, email_id });
  return { deleted: true, email_id };
}

export async function getEmail({ email_id, userEmail } = {}) {
  const user = userEmail ?? USER();
  const data = await graph('GET', `/users/${user}/messages/${encodeURIComponent(email_id)}?$select=id,subject,from,toRecipients,body,receivedDateTime,conversationId,hasAttachments`);
  return {
    id:              data.id,
    from:            data.from?.emailAddress?.address,
    from_name:       data.from?.emailAddress?.name,
    to:              (data.toRecipients ?? []).map(r => r.emailAddress?.address),
    subject:         data.subject,
    date:            data.receivedDateTime,
    thread_id:       data.conversationId,
    has_attachments: data.hasAttachments,
    body:            data.body?.content,
  };
}

export async function draftEmail({ to, subject, body, cc = [], userEmail } = {}) {
  const user = userEmail ?? USER();
  const message = {
    subject,
    body: { contentType: 'HTML', content: wrapForExchangeFont(withSignOff(body)) },
    toRecipients: to.map(a => ({ emailAddress: { address: a } })),
    ccRecipients: cc.map(a => ({ emailAddress: { address: a } })),
  };
  const data = await graph('POST', `/users/${user}/messages`, message);
  logger.info('Email drafted', { id: data.id, subject, user });
  return { draft_id: data.id, subject, message: 'Draft created — not sent.' };
}

export async function sendEmail({ draft_id, to, subject, body, contentType = 'HTML', attachments = [], userEmail } = {}) {
  // Must match whichever mailbox the draft_id actually lives in -- draftEmail()
  // now also takes userEmail (e.g. voice forces michael@jrboehlke.com), and a
  // mismatch here 404s ("draft not found") rather than sending the wrong
  // mailbox's copy, since Graph's /messages/{id}/send is mailbox-scoped.
  const user = userEmail ?? USER();
  if (draft_id) {
    await graph('POST', `/users/${user}/messages/${encodeURIComponent(draft_id)}/send`);
    return { sent: true, draft_id };
  }

  if (attachments.length === 0) {
    await graph('POST', `/users/${user}/sendMail`, {
      message: {
        subject: subject ?? '',
        body: { contentType, content: /^html$/i.test(contentType) ? wrapForExchangeFont(body) : body },
        toRecipients: to.map(a => ({ emailAddress: { address: a } })),
      },
      saveToSentItems: false,
    });
    return { sent: true };
  }

  // With attachments: create draft, upload each via upload session (raw bytes, no
  // base64 JSON encoding), then send. This avoids Exchange corruption of large binaries.
  const draft = await graph('POST', `/users/${user}/messages`, {
    subject: subject ?? '',
    body: { contentType, content: /^html$/i.test(contentType) ? wrapForExchangeFont(body) : body },
    toRecipients: to.map(a => ({ emailAddress: { address: a } })),
  });
  const draftId = draft.id;

  try {
    for (const a of attachments) {
      const buf = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content, 'base64');
      const session = await graph(
        'POST',
        `/users/${user}/messages/${draftId}/attachments/createUploadSession`,
        { AttachmentItem: { attachmentType: 'file', name: a.name, size: buf.length, contentType: a.contentType } }
      );
      // uploadUrl is pre-authenticated — do NOT add Authorization header
      await axios.put(session.uploadUrl, buf, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes 0-${buf.length - 1}/${buf.length}`,
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
      logger.info('Attachment uploaded via session', { name: a.name, bytes: buf.length });
    }
    await graph('POST', `/users/${user}/messages/${draftId}/send`);
    return { sent: true };
  } catch (err) {
    try { await graph('DELETE', `/users/${user}/messages/${draftId}`); } catch {}
    throw err;
  }
}

export async function createReminder({ title, due_date, notes = '' }) {
  const task = {
    title,
    dueDateTime: { dateTime: due_date, timeZone: 'UTC' },
    body: { content: notes, contentType: 'text' },
  };
  const data = await graph('POST', `/users/${USER()}/todo/lists/tasks/tasks`, task);
  return { created: true, task_id: data.id, title };
}

// ── OneDrive ──────────────────────────────────────────────────

export async function saveToOneDrive({ path, content, encoding = 'utf8', overwrite = false }) {
  const token = await getToken();
  const url = `${GRAPH}/users/${USER()}/drive/root:${path}:/content`;

  // Check existence first if overwrite=false
  if (!overwrite) {
    try {
      await axios.get(`${GRAPH}/users/${USER()}/drive/root:${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return { saved: false, error: `File already exists at ${path}. Set overwrite=true to replace.` };
    } catch {
      // 404 = doesn't exist, proceed
    }
  }

  const buf = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
  await axios.put(url, buf, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
  });
  logger.info('File saved to OneDrive', { path });
  return { saved: true, path };
}

export async function readFromOneDrive({ path }) {
  const meta = await graph('GET', `/users/${USER()}/drive/root:${path}`);
  const token = await getToken();
  const res = await axios.get(meta['@microsoft.graph.downloadUrl'], {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'text',
  });
  return { path, content: res.data };
}

export async function listOneDrive({ folder }) {
  const data = await graph('GET', `/users/${USER()}/drive/root:${folder}:/children?$select=name,size,lastModifiedDateTime,file,folder`);
  return data.value.map(i => ({
    name:     i.name,
    type:     i.folder ? 'folder' : 'file',
    size:     i.size,
    modified: i.lastModifiedDateTime,
  }));
}

export async function markEmailRead({ email_id, userEmail } = {}) {
  const user = userEmail ?? USER();
  await graph('PATCH', `/users/${user}/messages/${encodeURIComponent(email_id)}`, { isRead: true });
  return { marked_read: true, email_id };
}

/**
 * List attachments on an email. Returns metadata only (no content bytes).
 */
export async function listEmailAttachments({ email_id, userEmail } = {}) {
  const user = userEmail ?? USER();
  const data = await graph('GET', `/users/${user}/messages/${encodeURIComponent(email_id)}/attachments?$select=id,name,contentType,size`);
  return (data.value ?? []).map(a => ({
    id:          a.id,
    name:        a.name,
    contentType: a.contentType,
    size:        a.size,
  }));
}

/**
 * Download a single attachment as a Buffer.
 * Graph returns contentBytes as base64 for small files (< 3 MB).
 */
export async function getEmailAttachmentBytes({ email_id, attachment_id, userEmail } = {}) {
  const user = userEmail ?? USER();
  const data = await graph('GET', `/users/${user}/messages/${encodeURIComponent(email_id)}/attachments/${encodeURIComponent(attachment_id)}`);
  if (!data.contentBytes) throw new Error('Attachment has no content bytes (may be a reference attachment)');
  return Buffer.from(data.contentBytes, 'base64');
}

const TEXT_ATTACHMENT_TYPES = new Set(['text/plain', 'text/csv', 'application/json']);

/**
 * Fetch an email attachment's content as text the LLM can read directly -- extracts
 * PDF text via pdf-parse, decodes plain-text/CSV/JSON as utf8. Graph's attachment
 * content-bytes limitation only applies to the raw HTTP response (base64, no parsing);
 * this function does the parsing on top of getEmailAttachmentBytes's same download.
 * Returns `supported: false` with a note (not a thrown error) for file types with no
 * text extraction path (images, Office docs, etc.) so a caller can report the gap
 * instead of getting an unexplained crash.
 */
export async function readEmailAttachment({ email_id, attachment_id, userEmail } = {}) {
  const user = userEmail ?? USER();
  const data = await graph('GET', `/users/${user}/messages/${encodeURIComponent(email_id)}/attachments/${encodeURIComponent(attachment_id)}`);
  const { name, contentType, size } = data;

  let buf;
  if (data.contentBytes) {
    buf = Buffer.from(data.contentBytes, 'base64');
  } else if (data['@odata.type'] === '#microsoft.graph.referenceAttachment') {
    return { name, contentType, size, supported: false, text: null, note: 'Reference attachment (e.g. a cloud file link) has no downloadable content bytes.' };
  } else {
    // Graph omits contentBytes above ~3MB on the inline JSON response (see
    // getEmailAttachmentBytes's comment above) even for a real file attachment --
    // fall back to the $value endpoint, which streams raw bytes regardless of size.
    const token = await getToken();
    const res = await axios.get(
      `${GRAPH}/users/${user}/messages/${encodeURIComponent(email_id)}/attachments/${encodeURIComponent(attachment_id)}/$value`,
      { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer' }
    );
    buf = Buffer.from(res.data);
  }

  if (contentType === 'application/pdf' || /\.pdf$/i.test(name ?? '')) {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buf });
    try {
      const result = await parser.getText();
      return { name, contentType, size, supported: true, text: result.text };
    } finally {
      await parser.destroy();
    }
  }

  if (TEXT_ATTACHMENT_TYPES.has(contentType) || /\.(txt|csv|json)$/i.test(name ?? '')) {
    return { name, contentType, size, supported: true, text: buf.toString('utf8') };
  }

  return {
    name, contentType, size, supported: false, text: null,
    note: `No text extraction available for ${contentType || 'this file type'}. Supported: PDF, plain text, CSV, JSON.`,
  };
}

export async function createCalendarEvent({ subject, start, end, body = '', timezone = 'America/Chicago', userEmail, recurrenceDaysOfWeek, recurrenceStartDate, categories, location, attendees } = {}) {
  const user = userEmail ?? MICHAEL_CALENDAR;
  const event = {
    subject,
    body: { contentType: 'text', content: body },
    start: { dateTime: start, timeZone: timezone },
    end:   { dateTime: end,   timeZone: timezone },
    isReminderOn: true,
    reminderMinutesBeforeStart: 1440,
  };
  // `!== undefined`, not `?.length` -- matches updateCalendarEvent's guard
  // for the same field, so the two functions apply consistent semantics to
  // an identical parameter rather than silently diverging on `categories: []`.
  if (categories !== undefined) event.categories = categories;
  // Deliberately a truthy check, not `!== undefined` like categories above --
  // unlike `categories: []` (a meaningful "explicitly no categories" value),
  // an empty-string location has no distinct meaning from "not provided," so
  // there's no equivalent case to preserve.
  if (location) event.location = { displayName: location };
  // Added for employee-booking invites (scheduling-booking.js) -- every
  // existing call site omits this entirely, so it's a pure opt-in with zero
  // behavior change for estimate-visit blocks or the block-schedule scaffold.
  if (attendees?.length) {
    event.attendees = attendees.map(a => ({
      emailAddress: { address: a.email, name: a.name || a.email },
      type: 'required',
    }));
  }
  if (recurrenceDaysOfWeek?.length) {
    // tools/dispatcher.js does no schema validation before dispatch --
    // registry.js's `required: ['subject','start','end']` is advisory to the
    // LLM only. Without recurrenceStartDate, a call that also omits/mistypes
    // `start` would otherwise crash here on `.slice` of a non-string.
    if (!recurrenceStartDate && typeof start !== 'string') {
      throw new Error('createCalendarEvent: recurrenceDaysOfWeek requires either recurrenceStartDate or a valid string `start`');
    }
    event.recurrence = {
      pattern: { type: 'weekly', interval: 1, daysOfWeek: recurrenceDaysOfWeek },
      range: { type: 'noEnd', startDate: recurrenceStartDate ?? start.slice(0, 10) },
    };
  }
  const data = await graph('POST', `/users/${user}/events`, event);
  return { created: true, event_id: data.id, subject, start, calendar: user, recurring: !!event.recurrence };
}

// ── Inbox folder management ───────────────────────────────────

export async function listMailFolders({ userEmail } = {}) {
  const user = userEmail ?? USER();
  const data = await graph('GET', `/users/${user}/mailFolders?$top=100&$select=id,displayName,totalItemCount,unreadItemCount`);
  return (data.value ?? []).map(f => ({
    id:          f.id,
    name:        f.displayName,
    total:       f.totalItemCount,
    unread:      f.unreadItemCount,
  }));
}

export async function createMailFolder({ userEmail, name, parentFolderId } = {}) {
  const user = userEmail ?? USER();
  const path = parentFolderId
    ? `/users/${user}/mailFolders/${parentFolderId}/childFolders`
    : `/users/${user}/mailFolders`;
  const data = await graph('POST', path, { displayName: name });
  logger.info('Mail folder created', { user, name, id: data.id });
  return { created: true, folder_id: data.id, name: data.displayName };
}

// Lists the direct child folders of a parent (e.g. Inbox) — listMailFolders
// above only returns TOP-LEVEL folders, so a folder nested under Inbox (like
// the inbox-processor's category folders, moved there 2026-08-24) never shows
// up in that list at all.
export async function listChildFolders({ userEmail, parentFolderId } = {}) {
  const user = userEmail ?? USER();
  const data = await graph('GET', `/users/${user}/mailFolders/${parentFolderId}/childFolders?$top=100&$select=id,displayName,totalItemCount,unreadItemCount`);
  return (data.value ?? []).map(f => ({
    id:     f.id,
    name:   f.displayName,
    total:  f.totalItemCount,
    unread: f.unreadItemCount,
  }));
}

// Moves an existing mail folder to become a child of destinationParentId
// (e.g. Inbox) — Graph's mailFolders/{id}/move, the folder-level analog of
// moveEmail. The folder keeps its id, so anything already referencing it
// (a cached folder id, an open Outlook window) stays valid.
export async function moveMailFolder({ userEmail, folder_id, destinationParentId } = {}) {
  const user = userEmail ?? USER();
  const data = await graph('POST', `/users/${user}/mailFolders/${folder_id}/move`, { destinationId: destinationParentId });
  logger.info('Mail folder moved', { user, folder_id, destinationParentId });
  return { moved: true, folder_id: data.id, name: data.displayName };
}

export async function moveEmail({ userEmail, email_id, destination_folder_id } = {}) {
  const user = userEmail ?? USER();
  const data = await graph('POST', `/users/${user}/messages/${encodeURIComponent(email_id)}/move`, {
    destinationId: destination_folder_id,
  });
  return { moved: true, new_id: data.id, folder_id: destination_folder_id };
}

export async function searchEmails({ userEmail, query, from, subject, limit = 20, afterDate, beforeDate, folder } = {}) {
  const user = userEmail ?? USER();
  const filters = [];
  if (from)    filters.push(`from/emailAddress/address eq '${from}'`);
  if (afterDate)  filters.push(`receivedDateTime ge ${new Date(afterDate).toISOString()}`);
  if (beforeDate) filters.push(`receivedDateTime le ${new Date(beforeDate).toISOString()}`);

  let path;
  if (query) {
    const base = `/users/${user}/messages?$search="${encodeURIComponent(query)}"&$top=${limit}&$select=id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments,conversationId,parentFolderId`;
    path = base;
  } else {
    const filterStr = filters.length ? `&$filter=${filters.join(' and ')}` : '';
    const folderSeg = folder ? `/mailFolders/${folder}` : '';
    path = `/users/${user}${folderSeg}/messages?$top=${limit}&$select=id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments,conversationId,parentFolderId${filterStr}&$orderby=receivedDateTime desc`;
  }

  if (subject) path += `${path.includes('?') ? '&' : '?'}$search="subject:${encodeURIComponent(subject)}"`;

  const data = await graph('GET', path);
  return (data.value ?? []).map(m => ({
    id:            m.id,
    from:          m.from?.emailAddress?.address,
    from_name:     m.from?.emailAddress?.name,
    subject:       m.subject,
    date:          m.receivedDateTime,
    snippet:       m.bodyPreview?.slice(0, 250),
    is_read:       m.isRead,
    has_attachments: m.hasAttachments,
    thread_id:     m.conversationId,
    folder_id:     m.parentFolderId,
  }));
}

// ── Email catalog (Supabase) ──────────────────────────────────

export async function catalogEmail({ email_id, userEmail, category, action_taken = 'none', action_notes = '', folder_name } = {}) {
  const user = userEmail ?? USER();
  const msg = await graph('GET', `/users/${user}/messages/${encodeURIComponent(email_id)}?$select=id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments,conversationId,parentFolderId`);

  const row = {
    message_id:      msg.id,
    mailbox:         user,
    subject:         msg.subject,
    from_address:    msg.from?.emailAddress?.address,
    from_name:       msg.from?.emailAddress?.name,
    received_at:     msg.receivedDateTime,
    folder:          folder_name ?? msg.parentFolderId,
    category:        category ?? 'uncategorized',
    is_read:         msg.isRead,
    has_attachments: msg.hasAttachments,
    snippet:         msg.bodyPreview?.slice(0, 500),
    action_taken,
    action_notes,
    thread_id:       msg.conversationId,
    processed_at:    new Date().toISOString(),
  };

  const { error } = await supabase()
    .from('email_catalog')
    .upsert(row, { onConflict: 'message_id' });

  if (error) throw new Error(`catalog_email upsert failed: ${error.message}`);
  logger.info('Email cataloged', { message_id: msg.id, category, action_taken });
  return { cataloged: true, message_id: msg.id, category };
}

export async function getEmailCatalog({ mailbox, category, limit = 50, offset = 0 } = {}) {
  let q = supabase().from('email_catalog').select('*').order('received_at', { ascending: false }).range(offset, offset + limit - 1);
  if (mailbox)  q = q.eq('mailbox', mailbox);
  if (category) q = q.eq('category', category);
  const { data, error } = await q;
  if (error) throw new Error(`get_email_catalog failed: ${error.message}`);
  return data;
}

// ── Calendar read/update ──────────────────────────────────────

export async function listCalendarEvents({ userEmail, startDateTime, endDateTime, limit = 20, query } = {}) {
  const user = userEmail ?? MICHAEL_CALENDAR;
  const start = startDateTime ?? new Date().toISOString();
  const end   = endDateTime   ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const search = query ? `&$search="${encodeURIComponent(query)}"` : '';
  // Prefer: outlook.timezone, same as getCalendarViewWithCategories/getCalendarEvent below --
  // without it Graph returns start/end in UTC while every other calendar function in this
  // codebase works in America/Chicago wall-clock terms. Confirmed live 2026-08-24: this was the
  // one calendar-read function still missing the header, and it's the one exposed as the
  // list_calendar_events agent tool -- the model was doing its own UTC-to-Central arithmetic
  // in-context on a Teams rescheduling request and repeatedly got it wrong/self-contradictory
  // across turns before landing on the right answer.
  const data = await graph(
    'GET',
    `/users/${user}/calendarView?startDateTime=${start}&endDateTime=${end}&$top=${limit}&$select=id,subject,start,end,location,organizer,attendees,bodyPreview,isAllDay${search}&$orderby=start/dateTime`,
    undefined,
    { Prefer: 'outlook.timezone="America/Chicago"' }
  );
  return (data.value ?? []).map(e => ({
    id:         e.id,
    subject:    e.subject,
    start:      e.start?.dateTime,
    end:        e.end?.dateTime,
    timezone:   e.start?.timeZone,
    location:   e.location?.displayName,
    organizer:  e.organizer?.emailAddress?.address,
    attendees:  (e.attendees ?? []).map(a => a.emailAddress?.address),
    notes:      e.bodyPreview?.slice(0, 300),
    all_day:    e.isAllDay,
  }));
}

/**
 * Finds real (non-block-schedule) calendar events whose subject contains a
 * given substring, on a specific LOCAL calendar date. Built for the calendar
 * conflict-resolution tool (see block-schedule-reconciler.js's
 * resolveCalendarConflictBySubject) so a Teams request like "prioritize my
 * BTA meeting over the block schedule" can locate the real event without the
 * model reading/paging through a whole day's events itself.
 *
 * Deliberately does NOT send the Prefer: outlook.timezone header (unlike
 * listCalendarEvents above) -- the returned start/end need to stay bare UTC
 * strings so they're directly compatible with reconcileRealEventAgainstBlocks'
 * expected input contract (the same shape calendar-watch.js's
 * getCalendarChanges() already supplies it). Passing already-local times
 * into that function would double-convert them via its own
 * toLocalNaiveFromUtc() call and silently reintroduce the exact class of
 * timezone bug this file just fixed above.
 *
 * The query window is padded a day on each side and results are filtered
 * back down to the requested local date via toLocalNaiveFromUtc -- same
 * convention documented on getCalendarViewWithCategories below (an
 * unpadded same-UTC-day window can silently miss an evening/early-morning
 * local event whose UTC instant rolls onto the adjacent UTC day).
 */
export async function findCalendarEventsBySubject({ userEmail, subjectContains, date } = {}) {
  const user = userEmail ?? MICHAEL_CALENDAR;
  const padStart = new Date(`${date}T00:00:00Z`); padStart.setUTCDate(padStart.getUTCDate() - 1);
  const padEnd = new Date(`${date}T23:59:59Z`); padEnd.setUTCDate(padEnd.getUTCDate() + 1);
  const data = await graph(
    'GET',
    `/users/${user}/calendarView?startDateTime=${padStart.toISOString()}&endDateTime=${padEnd.toISOString()}&$top=50&$select=id,subject,start,end,organizer,isOrganizer,responseStatus,isAllDay&$orderby=start/dateTime`
  );
  const needle = subjectContains.toLowerCase();
  return (data.value ?? [])
    .filter(e => (e.subject ?? '').toLowerCase().includes(needle))
    .map(e => ({
      id:             e.id,
      subject:        e.subject,
      start:          e.start?.dateTime,
      end:            e.end?.dateTime,
      organizer:      e.organizer?.emailAddress?.address,
      isOrganizer:    !!e.isOrganizer,
      responseStatus: e.responseStatus?.response,
      isAllDay:       !!e.isAllDay,
    }))
    .filter(e => toLocalNaiveFromUtc(e.start).slice(0, 10) === date);
}

export async function updateCalendarEvent({ userEmail, event_id, subject, start, end, body, bodyContentType = 'text', timezone = 'America/Chicago', categories } = {}) {
  const user = userEmail ?? MICHAEL_CALENDAR;
  const patch = {};
  // `!== undefined` for subject/body, matching the categories fix below --
  // an explicit '' must clear the field, not silently no-op. start/end stay
  // on a truthy check: a calendar event always needs a valid dateTime, so
  // "clear the start time" isn't a meaningful operation the way "clear the
  // notes" is -- that case means delete the event, not blank a required field.
  if (subject !== undefined) patch.subject = subject;
  // bodyContentType defaults to 'text' (unchanged default behavior) but callers
  // appending to an existing body must pass whatever contentType that body
  // already has (from getCalendarEvent) -- hardcoding 'text' here would silently
  // downgrade an 'html' body, causing Outlook to render its markup as literal
  // escaped text on the next PATCH.
  if (body !== undefined)    patch.body = { contentType: bodyContentType, content: body };
  if (start)                  patch.start = { dateTime: start, timeZone: timezone };
  if (end)                    patch.end   = { dateTime: end,   timeZone: timezone };
  // `!== undefined`, not `?.length` -- an explicit [] must still patch through
  // to actually clear existing categories (e.g. un-tagging a former block-
  // schedule event), matching the tool's documented "replaces" semantics.
  if (categories !== undefined) patch.categories = categories;
  await graph('PATCH', `/users/${user}/events/${event_id}`, patch);
  return { updated: true, event_id };
}

export async function deleteCalendarEvent({ userEmail, event_id } = {}) {
  const user = userEmail ?? MICHAEL_CALENDAR;
  await graph('DELETE', `/users/${user}/events/${event_id}`);
  return { deleted: true, event_id };
}

// Used by the block-schedule reconciler to auto-accept trusted recurring
// invites (e.g. Breakthrough Academy) that would otherwise sit unresponded
// while still displacing block time. Graph's accept endpoint sends the
// organizer a real acceptance response by default (sendResponse defaults
// true) -- matches what clicking "Accept" in Outlook would actually do.
export async function acceptCalendarEvent({ userEmail, event_id, comment = '' } = {}) {
  const user = userEmail ?? MICHAEL_CALENDAR;
  await graph('POST', `/users/${user}/events/${event_id}/accept`, { comment, sendResponse: true });
  return { accepted: true, event_id };
}

/**
 * Fetch a single event's full body content (listCalendarEvents/calendarView only
 * return a 300-char-truncated bodyPreview, never the real body). Used by the
 * estimate-visit to-do injection to read + append to a protected block's notes
 * without clobbering whatever's already there.
 */
export async function getCalendarEvent({ event_id, userEmail, timezone = 'America/Chicago' } = {}) {
  const user = userEmail ?? USER();
  // Same Prefer header as getCalendarViewWithCategories, for the same reason:
  // without it, start/end come back in UTC while every other calendar
  // function in this codebase works in America/Chicago wall-clock terms --
  // a caller comparing this event's start/end against one of those would
  // silently be comparing across a several-hour offset.
  const data = await graph(
    'GET',
    `/users/${user}/events/${event_id}?$select=id,subject,body,start,end,categories`,
    undefined,
    { Prefer: `outlook.timezone="${timezone}"` }
  );
  return {
    id:          data.id,
    subject:     data.subject,
    start:       data.start?.dateTime,
    end:         data.end?.dateTime,
    categories:  data.categories ?? [],
    content:     data.body?.content ?? '',
    contentType: data.body?.contentType ?? 'text',
  };
}

/**
 * calendarView read with categories + occurrence identity included (the plain
 * listCalendarEvents $select omits both). Used by the estimate-visit
 * displacement check to classify JRB Block Schedule overlaps, and to locate
 * the next "Estimating / Proposal Production" occurrence for the to-do
 * injection step.
 *
 * Passes Prefer: outlook.timezone so the *returned* start/end values come
 * back in the same local time zone as createCalendarEvent's default, instead
 * of UTC. CONFIRMED LIVE 2026-08-20: this header reliably fixes the returned
 * values, but does NOT reliably extend to how Graph interprets the
 * startDateTime/endDateTime query params themselves -- an evening
 * America/Chicago event whose UTC instant rolls into the next UTC calendar
 * day was silently excluded by a same-local-day query window. Callers that
 * need a specific local day/window fully covered should pad the requested
 * startDateTime/endDateTime by a day on each side and rely on this
 * function's correctly-zoned returned values for the real filtering, the
 * way tools/impl/scheduling-visits.js does -- don't trust the raw query
 * boundary to mean what it says in local-zone terms.
 *
 * Graph's calendarView already expands recurring series into individual
 * occurrences, each with its own event id distinct from the series master's
 * -- exactly the id a caller needs to PATCH/DELETE just one occurrence.
 *
 * Follows @odata.nextLink to completion (same pattern as calendar-watch.js's
 * delta pagination) -- `limit` is a per-page $top, not a result cap. Without
 * this, a busy multi-day window (the displacement check pads to 3 days; the
 * to-do search pads to ~16) could silently truncate before the categories
 * filter even runs, since $top caps the *raw* calendarView page (every event
 * of any kind in the window), not just JRB Block Schedule-tagged ones --
 * exactly the kind of silent, no-error data loss this project has been
 * bitten by before. maxPages is a sanity ceiling against a pathological
 * Graph response looping forever, not an expected real limit.
 */
export async function getCalendarViewWithCategories({ userEmail, startDateTime, endDateTime, timezone = 'America/Chicago', limit = 100, maxPages = 20 } = {}) {
  const user = userEmail ?? USER();
  const headers = { Prefer: `outlook.timezone="${timezone}"` };
  let url = `/users/${user}/calendarView?startDateTime=${startDateTime}&endDateTime=${endDateTime}&$top=${limit}&$select=id,subject,start,end,categories,seriesMasterId,type&$orderby=start/dateTime`;
  const raw = [];
  let pages = 0;
  while (url && pages < maxPages) {
    const data = await graph('GET', url, undefined, headers);
    raw.push(...(data.value ?? []));
    url = data['@odata.nextLink'] || null;
    pages++;
  }
  if (url) {
    logger.warn('getCalendarViewWithCategories: hit maxPages cap with more pages remaining', { user, startDateTime, endDateTime, maxPages });
  }
  return raw.map(e => ({
    id:             e.id,
    subject:        e.subject,
    start:          e.start?.dateTime,
    end:            e.end?.dateTime,
    timezone:       e.start?.timeZone,
    categories:     e.categories ?? [],
    seriesMasterId: e.seriesMasterId ?? null,
    type:           e.type ?? null, // 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster'
  }));
}

export function toLocalNaiveFromUtc(dateTimeStr) {
  if (!dateTimeStr) return dateTimeStr;
  const d = new Date(dateTimeStr.endsWith('Z') ? dateTimeStr : `${dateTimeStr}Z`);
  const pad2 = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// getSchedule's response can include real subjects/locations -- this app
// holds full Calendars.ReadWrite on this mailbox, not a normal cross-user
// free/busy grant, so nothing stops Graph from returning event detail here.
// Stripping down to status/start/end below is the actual security boundary
// an employee-facing availability check relies on, not whatever detail
// level Graph happens to default to.
export async function getFreeBusy({ userEmail, startDateTime, endDateTime, intervalMinutes = 30, timezone = 'America/Chicago' } = {}) {
  const user = userEmail ?? USER();
  const body = {
    schedules: [user],
    startTime: { dateTime: startDateTime, timeZone: timezone },
    endTime: { dateTime: endDateTime, timeZone: timezone },
    availabilityViewInterval: intervalMinutes,
  };
  const data = await graph('POST', `/users/${user}/calendar/getSchedule`, body);
  const items = data?.value?.[0]?.scheduleItems ?? [];
  // Confirmed live 2026-08-24: unlike calendarView (which honors the
  // Prefer: outlook.timezone header), getSchedule's scheduleItems come back
  // in UTC regardless of the `timeZone` given above -- a requested
  // 08:00-17:00 America/Chicago window came back with busy items spanning
  // 13:00-22:00 (a straight 5-hour UTC offset during CDT). Every naive
  // "YYYY-MM-DDTHH:MM:SS" timestamp elsewhere in this codebase (see
  // scheduling-visits.js's own comment on this) is local-wall-clock on the
  // assumption the Node process itself runs in America/Chicago -- so treat
  // Graph's string as UTC explicitly, then re-emit through the same
  // local-getter convention rather than leaving it mislabeled as local.
  return items.map(i => ({
    status: i.status, // 'free' | 'tentative' | 'busy' | 'oof' | 'workingElsewhere'
    start:  toLocalNaiveFromUtc(i.start?.dateTime),
    end:    toLocalNaiveFromUtc(i.end?.dateTime),
  }));
}

// ── SharePoint (via Microsoft Graph API — Sites.Read.All) ─────

export async function searchSharePoint({ query, fileType, siteId, limit = 20 } = {}) {
  const entityTypes = ['driveItem', 'listItem'];
  const body = {
    requests: [{
      entityTypes,
      query: { queryString: fileType ? `${query} filetype:${fileType}` : query },
      from: 0,
      size: limit,
      region: 'NAM',
      fields: ['id', 'name', 'webUrl', 'lastModifiedDateTime', 'createdBy', 'fileSystemInfo', 'parentReference'],
    }],
  };
  if (siteId) body.requests[0].contentSources = [`/sites/${siteId}`];

  const res = await graph('POST', '/search/query', body);
  const hits = res?.value?.[0]?.hitsContainers?.[0]?.hits ?? [];
  return hits.map(h => ({
    id:       h.hitId,
    name:     h.resource?.name,
    url:      h.resource?.webUrl,
    modified: h.resource?.lastModifiedDateTime,
    author:   h.resource?.createdBy?.user?.displayName,
    drive_id: h.resource?.parentReference?.driveId,
    site_id:  h.resource?.parentReference?.siteId,
    item_id:  h.resource?.id,
  }));
}

export async function readSharePointFile({ site_id, drive_id, item_id } = {}) {
  const meta = await graph('GET', `/sites/${site_id}/drives/${drive_id}/items/${item_id}`);
  const token = await getToken();
  const res = await axios.get(meta['@microsoft.graph.downloadUrl'], {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'text',
  });
  return { name: meta.name, url: meta.webUrl, content: res.data };
}

export async function fetchEmployeeDirectory() {
  const hits = await searchSharePoint({ query: 'EMPLOYEE DIRECTORY', fileType: 'xlsx', limit: 10 });
  const file = hits.find(h => h.name?.toUpperCase().includes('EMPLOYEE DIRECTORY'));
  if (!file) throw new Error('Employee Directory XLSX not found in SharePoint search results');

  const meta = await graph('GET', `/sites/${file.site_id}/drives/${file.drive_id}/items/${file.item_id}`);
  const token = await getToken();
  const res = await axios.get(meta['@microsoft.graph.downloadUrl'], {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'arraybuffer',
  });

  const wb = XLSX.read(Buffer.from(res.data), { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  return rows
    .map(row => {
      const keys = Object.keys(row);
      const firstKey = keys.find(k => /first/i.test(k) && /name/i.test(k));
      const lastKey  = keys.find(k => /last/i.test(k)  && /name/i.test(k));
      const nameKey  = keys.find(k => /^(name|full.?name|employee.?name|display.?name)$/i.test(k));
      let name;
      if (firstKey && lastKey) {
        name = `${row[firstKey]} ${row[lastKey]}`.trim();
      } else if (nameKey) {
        name = String(row[nameKey]).trim();
        // Normalize "Last, First" → "First Last" (SA and some directories use this format)
        if (/^[^,]+,[^,]+$/.test(name)) {
          const [last, first] = name.split(',');
          name = `${first.trim()} ${last.trim()}`;
        }
      } else {
        name = String(row[keys[0]] ?? '').trim();
      }
      const cellKey  = keys.find(k => /cell|mobile/i.test(k));
      const phoneKey = keys.find(k => /phone|tel/i.test(k));
      const phone = String(row[cellKey] ?? row[phoneKey] ?? '').trim() || null;
      const emailKey = keys.find(k => /email/i.test(k));
      const email = emailKey ? String(row[emailKey]).trim() || null : null;
      return { name, phone, email };
    })
    .filter(r => r.name);
}

export async function listSharePointFolder({ site_id, folder_path = '/' } = {}) {
  const path = folder_path === '/'
    ? `/sites/${site_id}/drive/root/children`
    : `/sites/${site_id}/drive/root:${folder_path}:/children`;
  const data = await graph('GET', `${path}?$select=id,name,webUrl,lastModifiedDateTime,size,file,folder,parentReference`);
  return (data.value ?? []).map(i => ({
    id:       i.id,
    name:     i.name,
    type:     i.folder ? 'folder' : 'file',
    url:      i.webUrl,
    size:     i.size,
    modified: i.lastModifiedDateTime,
    drive_id: i.parentReference?.driveId,
    site_id:  i.parentReference?.siteId,
  }));
}

export async function listSharePointSites({ query } = {}) {
  const path = query
    ? `/sites?search=${encodeURIComponent(query)}&$select=id,displayName,webUrl,description`
    : `/sites?search=*&$select=id,displayName,webUrl,description`;
  const data = await graph('GET', path);
  return (data.value ?? []).map(s => ({
    id:          s.id,
    name:        s.displayName,
    url:         s.webUrl,
    description: s.description,
  }));
}

export async function renameMailFolder({ userEmail, folder_id, name } = {}) {
  const user = userEmail ?? USER();
  const data = await graph('PATCH', `/users/${user}/mailFolders/${folder_id}`, { displayName: name });
  logger.info('Mail folder renamed', { user, folder_id, name });
  return { renamed: true, folder_id: data.id, name: data.displayName };
}

// ── Inbox assistant helpers ───────────────────────────────────────────────────

export async function listSentEmails({ userEmail, limit = 30, afterDate } = {}) {
  const user = userEmail ?? USER();
  const after = afterDate ? `&$filter=sentDateTime ge ${new Date(afterDate).toISOString()}` : '';
  const data = await graph(
    'GET',
    `/users/${user}/mailFolders/SentItems/messages?$top=${limit}&$select=id,subject,toRecipients,sentDateTime,conversationId,bodyPreview${after}&$orderby=sentDateTime desc`
  );
  return (data.value ?? []).map(m => ({
    id:        m.id,
    subject:   m.subject,
    to:        (m.toRecipients ?? []).map(r => r.emailAddress?.address),
    date:      m.sentDateTime,
    thread_id: m.conversationId,
    snippet:   m.bodyPreview?.slice(0, 200),
  }));
}

// Full past sent emails to ONE specific recipient, body included — used to learn
// Michael's actual writing style/tone toward that person before drafting a new
// reply. Distinct from listSentEmails (no recipient filter, snippet only).
export async function getSentEmailsTo({ userEmail, recipientAddress, limit = 5 } = {}) {
  const user = userEmail ?? USER();
  // Confirmed live 2026-08-24: Graph's $filter does NOT support toRecipients/any()
  // for mail messages at all ("ErrorInvalidUrlQueryFilter" — ordinary syntax, just
  // an unsupported property for $filter, unlike from/receivedDateTime/etc). Use
  // $search with the "to:" scoped operator instead, same convention searchEmails
  // already uses above. $search can't be combined with $orderby (a real Graph
  // limitation, matching why the $search branch above never appends one either) —
  // results come back in relevance order, which is fine here since this is just
  // sampling a few real past examples, not a precise recency requirement.
  const data = await graph(
    'GET',
    `/users/${user}/mailFolders/SentItems/messages?$search="to:${encodeURIComponent(recipientAddress)}"` +
    `&$top=${limit}&$select=id,subject,sentDateTime,body`
  );
  return (data.value ?? []).map(m => ({
    id:      m.id,
    subject: m.subject,
    date:    m.sentDateTime,
    body:    m.body?.content ?? '',
  }));
}

export async function getThreadEmails({ userEmail, thread_id, limit = 10 } = {}) {
  const user = userEmail ?? USER();
  const data = await graph(
    'GET',
    `/users/${user}/messages?$filter=conversationId eq '${thread_id}'&$top=${limit}&$select=id,subject,from,sentDateTime,receivedDateTime,conversationId&$orderby=receivedDateTime desc`
  );
  return (data.value ?? []).map(m => ({
    id:        m.id,
    from:      m.from?.emailAddress?.address,
    subject:   m.subject,
    date:      m.receivedDateTime ?? m.sentDateTime,
    thread_id: m.conversationId,
  }));
}

// Returns text unchanged if it already ends with "Michael" (case-insensitive, trailing
// punctuation allowed); otherwise appends it as a default sign-off. Applied to all
// drafted message bodies (new drafts and replies) per Michael's standing preference.
//
// Body text here is HTML, not plain text — a sign-off is usually wrapped in a tag
// (e.g. "...<p>Michael</p>"), so trailing whitespace alone isn't enough to see past
// to the actual text. Strip trailing whitespace/&nbsp;/closing HTML tags one layer
// at a time before testing, so "<p>Michael</p>" is recognized the same as "Michael".
// Confirmed live 2026-08-27: without this, callers whose body already ended in
// "...Michael</p>" (the common case) still got a second "<br><br>Michael<br>"
// appended, since the old check only matched bare text ending in "Michael".
function withSignOff(text) {
  let trimmed = text || '';
  let prev;
  do {
    prev = trimmed;
    trimmed = trimmed.replace(/(&nbsp;|\s)+$/i, '').replace(/<\/[a-zA-Z][^>]*>\s*$/, '');
  } while (trimmed !== prev);
  if (/michael[.,!]?$/i.test(trimmed)) return text;
  return `${text}<br><br>Michael<br>`;
}

// Same font stack/size already proven live for reply drafts (see createReplyDraft below).
const EXCHANGE_COMPOSE_STYLE = 'font-family: Calibri, Arial, Helvetica, sans-serif; font-size: 11pt; color: rgb(0, 0, 0);';

// Outlook only reliably honors an inline font style when it's applied at the <body>
// level of a real HTML document — a bare fragment (e.g. `<div style="...">...</div>`
// with no surrounding <html><body>) renders in the mailbox's default compose font
// instead (confirmed live 2026-08-28: a plain draftEmail() call rendered in Aptos 12,
// the M365 tenant default, despite an explicit Calibri/11pt inline style on the outer
// div). Wrapping in a real <html><body style="..."> document fixes this — the same
// fix already proven live for reply drafts below, just never applied to plain new
// drafts/sends. A no-op for callers that already supply a full document (e.g.
// commission-report.js's own <html>-templated body) — detected via the presence of
// a <body> tag, so their existing styling is never double-wrapped or overridden.
function wrapForExchangeFont(html) {
  if (/<body[^>]*>/i.test(html || '')) return html;
  return `<html><body style="${EXCHANGE_COMPOSE_STYLE}">${html}</body></html>`;
}

// Creates a draft reply in Michael's mailbox, preserving the email thread.
// Returns the draft message ID so it can be sent later or reviewed in Outlook.
//
// FIX (2026-08-26): the original Step 2 PATCH overwrote the ENTIRE draft body with only
// the new reply text, discarding Exchange's auto-generated quoted-original HTML from Step 1.
// This caused two symptoms: (a) the quoted thread was completely absent from the draft, and
// (b) the reply text rendered in Outlook's default display font (often Times New Roman)
// instead of Calibri — because Exchange's inline-styled .elementToProof compose div was
// part of the same content that got overwritten. Both symptoms were confirmed live on the
// PlanHub test draft and the Hefner's Custard thread created by michael_inbox_processor.
//
// The fix preserves Exchange's stub body by prepending the new reply text (wrapped in an
// Exchange-matching Calibri-12pt styled div) into the stub's <body> element rather than
// replacing the entire body.content field. A GET fallback handles the subset of Graph
// tenants where body.content is absent/empty on the createReply POST response.
export async function createReplyDraft({ userEmail, email_id, body } = {}) {
  const user = userEmail ?? USER();

  // Step 1: create the reply stub.
  // Exchange auto-populates the draft with correct threading headers and a quoted block
  // (an <hr>, From/Sent/To/Subject attribution, and the original message body).
  const stub = await graph('POST', `/users/${user}/messages/${encodeURIComponent(email_id)}/createReply`, {});
  const draftId = stub.id;

  // Step 2: get the existing body content Exchange wrote into the draft.
  // Most Graph tenants return body.content on the createReply POST response directly,
  // but some only populate it on a subsequent GET (a tenant-config / Exchange-version
  // difference in how the quoted block is materialized). An empty stub.body.content is
  // the signal to do the GET rather than silently losing the quoted thread.
  let existingContent = stub.body?.content ?? '';
  if (!existingContent.trim()) {
    logger.info('createReplyDraft: stub.body.content empty on POST response — fetching via GET', { user, draftId });
    const fetched = await graph('GET', `/users/${user}/messages/${encodeURIComponent(draftId)}?$select=id,body`);
    existingContent = fetched.body?.content ?? '';
  }

  // Step 3: build the combined body.
  // Wrap the new reply text in a styled div that matches Exchange's own .elementToProof
  // compose-area inline style (Calibri 12pt, black). Without this wrapper, new text
  // renders in Outlook's default display font, visually mismatched against the Calibri
  // attribution block Exchange generates below the separator.
  const styledReplyText = `<div style="${EXCHANGE_COMPOSE_STYLE}">${withSignOff(body)}</div>`;

  let combinedContent;
  if (existingContent.trim()) {
    // Inject new reply text right after the opening <body> tag of Exchange's stub HTML.
    // This places it at the top of the compose area, above the <hr> and quoted block.
    const bodyTagMatch = existingContent.match(/<body[^>]*>/i);
    if (bodyTagMatch) {
      const insertPos = bodyTagMatch.index + bodyTagMatch[0].length;
      combinedContent =
        existingContent.slice(0, insertPos) +
        styledReplyText +
        existingContent.slice(insertPos);
    } else {
      // Exchange returned a fragment (no <body> tag) — prepend directly.
      combinedContent = styledReplyText + existingContent;
    }
  } else {
    // Fallback: Exchange stub body was empty even after the GET.
    // Produce a minimal valid reply rather than sending a bare fragment.
    combinedContent = `<html><body>${styledReplyText}</body></html>`;
    logger.warn('createReplyDraft: Exchange stub body was empty after GET — draft will have no quoted thread', { user, draftId, sourceMessageId: email_id });
  }

  // Step 4: patch the draft with the combined body (new text + Exchange's quoted thread).
  await graph('PATCH', `/users/${user}/messages/${encodeURIComponent(draftId)}`, {
    body: { contentType: 'HTML', content: combinedContent },
  });

  logger.info('Reply draft created', { user, draftId, sourceMessageId: email_id, hadExistingContent: !!existingContent.trim() });
  return { draft_id: draftId };
}

// Send a saved draft by ID.
export async function sendDraft({ userEmail, draft_id } = {}) {
  const user = userEmail ?? USER();
  await graph('POST', `/users/${user}/messages/${encodeURIComponent(draft_id)}/send`);
  logger.info('Draft sent', { user, draft_id });
  return { sent: true, draft_id };
}