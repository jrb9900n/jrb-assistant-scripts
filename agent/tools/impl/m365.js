// tools/impl/m365.js — Microsoft Graph API wrapper
// Covers email, calendar, OneDrive, and SharePoint.

import axios from 'axios';
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


async function graph(method, path, data) {
  const token = await getToken();
  const url = path.startsWith('http') ? path : `${GRAPH}${path}`;
  const res = await axios({ method, url, data, headers: { Authorization: `Bearer ${token}` } });
  return res.data;
}

const USER = () => process.env.M365_USER_EMAIL;

// ── Email ─────────────────────────────────────────────────────

export async function listEmails({ folder = 'Inbox', limit = 20, unread_only = false }) {
  const filter = unread_only ? '&$filter=isRead eq false' : '';
  const data = await graph(
    'GET',
    `/users/${USER()}/mailFolders/${folder}/messages?$top=${limit}&$select=id,subject,from,receivedDateTime,bodyPreview${filter}`
  );
  return data.value.map(m => ({
    id:       m.id,
    from:     m.from?.emailAddress?.address,
    subject:  m.subject,
    date:     m.receivedDateTime,
    snippet:  m.bodyPreview?.slice(0, 200),
  }));
}

export async function getEmail({ email_id, userEmail } = {}) {
  const user = userEmail ?? USER();
  const data = await graph('GET', `/users/${user}/messages/${email_id}?$select=id,subject,from,to,body,receivedDateTime,conversationId,hasAttachments`);
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

export async function draftEmail({ to, subject, body, cc = [] }) {
  const message = {
    subject,
    body: { contentType: 'HTML', content: body },
    toRecipients: to.map(a => ({ emailAddress: { address: a } })),
    ccRecipients: cc.map(a => ({ emailAddress: { address: a } })),
  };
  const data = await graph('POST', `/users/${USER()}/messages`, message);
  logger.info('Email drafted', { id: data.id, subject });
  return { draft_id: data.id, subject, message: 'Draft created — not sent.' };
}

export async function sendEmail({ draft_id, to, subject, body, contentType = 'HTML', attachments = [] }) {
  if (draft_id) {
    await graph('POST', `/users/${USER()}/messages/${draft_id}/send`);
    return { sent: true, draft_id };
  }
  const message = {
    message: {
      subject: subject ?? '',
      body: { contentType, content: body },
      toRecipients: to.map(a => ({ emailAddress: { address: a } })),
      ...(attachments.length ? {
        attachments: attachments.map(a => ({
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: a.name,
          contentType: a.contentType,
          contentBytes: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content,
        })),
      } : {}),
    },
    saveToSentItems: false,
  };
  await graph('POST', `/users/${USER()}/sendMail`, message);
  return { sent: true };
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
  await graph('PATCH', `/users/${user}/messages/${email_id}`, { isRead: true });
  return { marked_read: true, email_id };
}

/**
 * List attachments on an email. Returns metadata only (no content bytes).
 */
export async function listEmailAttachments({ email_id }) {
  const data = await graph('GET', `/users/${USER()}/messages/${email_id}/attachments?$select=id,name,contentType,size`);
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
export async function getEmailAttachmentBytes({ email_id, attachment_id }) {
  const data = await graph('GET', `/users/${USER()}/messages/${email_id}/attachments/${attachment_id}`);
  if (!data.contentBytes) throw new Error('Attachment has no content bytes (may be a reference attachment)');
  return Buffer.from(data.contentBytes, 'base64');
}

export async function createCalendarEvent({ subject, start, end, body = '', timezone = 'America/Chicago' }) {
  const event = {
    subject,
    body: { contentType: 'text', content: body },
    start: { dateTime: start, timeZone: timezone },
    end:   { dateTime: end,   timeZone: timezone },
    isReminderOn: true,
    reminderMinutesBeforeStart: 1440,
  };
  const data = await graph('POST', `/users/${USER()}/events`, event);
  return { created: true, event_id: data.id, subject, start };
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

export async function moveEmail({ userEmail, email_id, destination_folder_id } = {}) {
  const user = userEmail ?? USER();
  const data = await graph('POST', `/users/${user}/messages/${email_id}/move`, {
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
  const msg = await graph('GET', `/users/${user}/messages/${email_id}?$select=id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments,conversationId,parentFolderId`);

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
  const user = userEmail ?? USER();
  const start = startDateTime ?? new Date().toISOString();
  const end   = endDateTime   ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const search = query ? `&$search="${encodeURIComponent(query)}"` : '';
  const data = await graph(
    'GET',
    `/users/${user}/calendarView?startDateTime=${start}&endDateTime=${end}&$top=${limit}&$select=id,subject,start,end,location,organizer,attendees,bodyPreview,isAllDay${search}&$orderby=start/dateTime`
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

export async function updateCalendarEvent({ userEmail, event_id, subject, start, end, body, timezone = 'America/Chicago' } = {}) {
  const user = userEmail ?? USER();
  const patch = {};
  if (subject) patch.subject = subject;
  if (body)    patch.body = { contentType: 'text', content: body };
  if (start)   patch.start = { dateTime: start, timeZone: timezone };
  if (end)     patch.end   = { dateTime: end,   timeZone: timezone };
  await graph('PATCH', `/users/${user}/events/${event_id}`, patch);
  return { updated: true, event_id };
}

export async function deleteCalendarEvent({ userEmail, event_id } = {}) {
  const user = userEmail ?? USER();
  await graph('DELETE', `/users/${user}/events/${event_id}`);
  return { deleted: true, event_id };
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

// Creates a draft reply in Michael's mailbox, preserving the email thread.
// Returns the draft message ID so it can be sent later or reviewed in Outlook.
export async function createReplyDraft({ userEmail, email_id, body } = {}) {
  const user = userEmail ?? USER();
  // Step 1: create the reply stub (preserves thread headers, To, Subject)
  const stub = await graph('POST', `/users/${user}/messages/${email_id}/createReply`, {});
  const draftId = stub.id;
  // Step 2: patch the body onto the draft
  await graph('PATCH', `/users/${user}/messages/${draftId}`, {
    body: { contentType: 'HTML', content: body },
  });
  logger.info('Reply draft created', { user, draftId, sourceMessageId: email_id });
  return { draft_id: draftId };
}

// Send a saved draft by ID.
export async function sendDraft({ userEmail, draft_id } = {}) {
  const user = userEmail ?? USER();
  await graph('POST', `/users/${user}/messages/${draft_id}/send`);
  logger.info('Draft sent', { user, draft_id });
  return { sent: true, draft_id };
}