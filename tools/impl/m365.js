// tools/impl/m365.js — Microsoft Graph API wrapper
// Covers email, calendar, and OneDrive.

import axios from 'axios';
import { logger } from '../../core/logger.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

// ── Auth ─────────────────────────────────────────────────────
let _tokenCache = { token: null, expiresAt: 0 };

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

export async function getEmail({ email_id }) {
  const data = await graph('GET', `/users/${USER()}/messages/${email_id}?$select=id,subject,from,body,receivedDateTime`);
  return {
    id:      data.id,
    from:    data.from?.emailAddress?.address,
    subject: data.subject,
    date:    data.receivedDateTime,
    body:    data.body?.content,
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

export async function sendEmail({ draft_id, to, subject, body }) {
  if (draft_id) {
    await graph('POST', `/users/${USER()}/messages/${draft_id}/send`);
    return { sent: true, draft_id };
  }
  // Send directly without drafting
  const message = {
    message: {
      subject,
      body: { contentType: 'HTML', content: body },
      toRecipients: to.map(a => ({ emailAddress: { address: a } })),
    },
    saveToSentItems: true,
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

export async function markEmailRead({ email_id }) {
  await graph('PATCH', `/users/${USER()}/messages/${email_id}`, { isRead: true });
  return { marked_read: true, email_id };
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