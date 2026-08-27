// tools/impl/teams-read.js — Read-only access to Michael's Teams chats and channels.
//
// Uses the same app-only Graph credential (M365_CLIENT_ID/SECRET/TENANT_ID) already
// used in m365.js. Admin consent for Chat.Read.All, ChannelMessage.Read.All,
// Team.ReadBasic.All, and Channel.ReadBasic.All has been granted in Entra ID.
//
// Privacy boundary: every message-read function validates its target against a
// freshly-fetched allowlist of conversations/channels Michael himself is part of
// before calling Graph. This scopes the broad app-only credential in practice to
// only Michael's conversations — matching the fail-closed intent of
// teams/identity.js's resolveSender(). The allowlists are computed fresh on every
// call (never cached or hardcoded) so a chat/channel Michael leaves is automatically
// excluded.

import { graph } from './m365.js';
import { logger } from '../../core/logger.js';

const MICHAEL = 'michael@jrboehlke.com';

// Source-of-truth allowlist — computed fresh on every call, never cached or
// hardcoded, so a chat/channel Michael leaves is automatically excluded.
// Every message-read function below MUST validate its target against one of
// these before calling Graph — this is what keeps a Chat.Read.All/
// ChannelMessage.Read.All app-only credential (which COULD read any
// employee's messages) scoped in practice to only Michael's, matching the
// same fail-closed intent as teams/identity.js's resolveSender().

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

export async function getChatMessages({ chatId, limit = 20 } = {}) {
  if (!chatId) throw new Error('chatId is required');
  const allowed = await listMichaelChats();
  if (!allowed.some(c => c.id === chatId)) {
    logger.warn('teams-read: rejected chatId not in Michael\'s chat list', { chatId });
    throw new Error('That chat is not accessible — not one of Michael\'s conversations.');
  }
  const data = await graph('GET', `/chats/${encodeURIComponent(chatId)}/messages?$top=${Math.min(Math.max(Number(limit) || 20, 1), 50)}`);
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
  const data = await graph('GET', `/teams/${teamId}/channels/${channelId}/messages?$top=${Math.min(Math.max(Number(limit) || 20, 1), 50)}`);
  return (data.value ?? []).map(m => ({
    id: m.id, from: m.from?.user?.displayName ?? null, sent: m.createdDateTime,
    text: m.body?.content ?? null,
  }));
}
