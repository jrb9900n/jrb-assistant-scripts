// tools/impl/teams-read.js — read-only access to Michael's Teams chats and
// channel messages, via the same app-only Graph credential already used in
// m365.js (Chat.Read.All, ChannelMessage.Read.All, Team.ReadBasic.All,
// Channel.ReadBasic.All — admin-consented by Michael 2026-08-27).
//
// That credential is tenant-wide by nature of how Graph application
// permissions work — it COULD read any employee's Teams messages, not just
// Michael's. The allowlist functions below are what actually narrows this to
// "only Michael's conversations" in practice: computed fresh on every call
// (never cached/hardcoded), so a chat/channel Michael leaves is
// automatically excluded, and every message-read function validates its
// target against one of these before ever calling Graph. Same fail-closed
// intent as teams/identity.js's resolveSender() — reject anything not on
// the allowlist rather than trust the caller's ID.

import { graph } from './m365.js';
import { logger } from '../../core/logger.js';

const MICHAEL = 'michael@jrboehlke.com';

export async function listMichaelChats() {
  const data = await graph('GET', `/users/${MICHAEL}/chats?$top=50`);
  return (data.value ?? []).map(c => ({
    id: c.id, topic: c.topic ?? null, chatType: c.chatType, lastUpdated: c.lastUpdatedDateTime,
  }));
}

export async function listMichaelChannels() {
  const teams = await graph('GET', `/users/${MICHAEL}/joinedTeams`);
  const out = [];
  for (const team of teams.value ?? []) {
    const channels = await graph('GET', `/teams/${team.id}/channels`);
    for (const ch of channels.value ?? []) {
      out.push({ teamId: team.id, teamName: team.displayName, channelId: ch.id, channelName: ch.displayName });
    }
  }
  return out;
}

function clampLimit(limit) {
  return Math.min(Math.max(Number(limit) || 20, 1), 50);
}

export async function getChatMessages({ chatId, limit = 20 } = {}) {
  if (!chatId) throw new Error('chatId is required');
  const allowed = await listMichaelChats();
  if (!allowed.some(c => c.id === chatId)) {
    logger.warn('teams-read: rejected chatId not in Michael\'s chat list', { chatId });
    throw new Error('That chat is not accessible — not one of Michael\'s conversations.');
  }
  const data = await graph('GET', `/chats/${encodeURIComponent(chatId)}/messages?$top=${clampLimit(limit)}`);
  return (data.value ?? []).map(m => ({
    id: m.id, from: m.from?.user?.displayName ?? null, sent: m.createdDateTime,
    text: m.body?.content ?? null,
  }));
}

export async function getChannelMessages({ teamId, channelId, limit = 20 } = {}) {
  if (!teamId || !channelId) throw new Error('teamId and channelId are required');
  const allowed = await listMichaelChannels();
  if (!allowed.some(c => c.teamId === teamId && c.channelId === channelId)) {
    logger.warn('teams-read: rejected team/channel not in Michael\'s joined channels', { teamId, channelId });
    throw new Error('That channel is not accessible — not one Michael has joined.');
  }
  const data = await graph('GET', `/teams/${teamId}/channels/${channelId}/messages?$top=${clampLimit(limit)}`);
  return (data.value ?? []).map(m => ({
    id: m.id, from: m.from?.user?.displayName ?? null, sent: m.createdDateTime,
    text: m.body?.content ?? null,
  }));
}
