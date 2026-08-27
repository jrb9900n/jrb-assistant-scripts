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
//
// TOCTOU note: The allowlist fetch and the message fetch are still two
// separate HTTP calls (Graph has no transaction primitive). To minimise the
// window we: (a) perform the allowlist fetch immediately before the guarded
// fetch in the same async call with no await in between other than the
// message fetch itself, (b) use the canonical IDs taken directly from the
// allowlist entry (not the raw caller-supplied values) in the fetch URL so
// that even a crafted ID that passes an equality check cannot redirect the
// URL, and (c) re-verify the resolved entry is non-null immediately before
// building the URL.

import { graph } from './m365.js';
import { logger } from '../../core/logger.js';

const MICHAEL = 'michael@jrboehlke.com';

// ── Internal fetchers (no caching — always live data) ────────────────────────

async function fetchMichaelChats() {
  const data = await graph('GET', `/users/${MICHAEL}/chats?$top=50`);
  return (data.value ?? []).map(c => ({
    id: c.id,
    topic: c.topic ?? null,
    chatType: c.chatType,
    lastUpdated: c.lastUpdatedDateTime,
  }));
}

async function fetchMichaelChannels() {
  const teams = await graph('GET', `/users/${MICHAEL}/joinedTeams`);
  const out = [];
  for (const team of teams.value ?? []) {
    const channels = await graph('GET', `/teams/${team.id}/channels`);
    for (const ch of channels.value ?? []) {
      out.push({
        teamId:      team.id,
        teamName:    team.displayName,
        channelId:   ch.id,
        channelName: ch.displayName,
      });
    }
  }
  return out;
}

// ── Public list helpers (called from dispatcher for display purposes) ─────────
//
// These are thin wrappers so callers get a stable API, and so that the
// dispatcher's list_michael_teams_chats / list_michael_teams_channels tools
// don't need to know about the internal split.

export async function listMichaelChats() {
  return fetchMichaelChats();
}

export async function listMichaelChannels() {
  return fetchMichaelChannels();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clampLimit(limit) {
  return Math.min(Math.max(Number(limit) || 20, 1), 50);
}

// ── Message readers ───────────────────────────────────────────────────────────

export async function getChatMessages({ chatId, limit = 20 } = {}) {
  if (!chatId) throw new Error('chatId is required');

  // Fetch the live allowlist immediately before using it — minimise TOCTOU
  // window. No other awaits between this and the guarded fetch below.
  const allowed = await fetchMichaelChats();

  // Find the canonical allowlist entry. We compare against the caller-supplied
  // chatId but then use the entry's own .id for the fetch URL so that a crafted
  // chatId that somehow passes the equality check cannot alter the URL path.
  const entry = allowed.find(c => c.id === chatId);
  if (!entry) {
    logger.warn('teams-read: rejected chatId not in Michael\'s chat list', { chatId });
    throw new Error('That chat is not accessible — not one of Michael\'s conversations.');
  }

  // Use the allowlist-derived canonical ID (entry.id), not the raw caller
  // input, so URL structure cannot be influenced by a crafted chatId value.
  const data = await graph(
    'GET',
    `/chats/${encodeURIComponent(entry.id)}/messages?$top=${clampLimit(limit)}`,
  );
  return (data.value ?? []).map(m => ({
    id:   m.id,
    from: m.from?.user?.displayName ?? null,
    sent: m.createdDateTime,
    text: m.body?.content ?? null,
  }));
}

export async function getChannelMessages({ teamId, channelId, limit = 20 } = {}) {
  if (!teamId || !channelId) throw new Error('teamId and channelId are required');

  // Fetch the live allowlist immediately before using it — minimise TOCTOU
  // window. The full teams+channels enumeration is done once here and reused
  // for both the allowlist check and (via canonical IDs) the fetch URL,
  // eliminating the N+1 pattern: one enumeration per getChannelMessages call
  // rather than one enumeration inside listMichaelChannels plus another inside
  // this function.
  const allowed = await fetchMichaelChannels();

  // Find the canonical allowlist entry. Use entry's own IDs for the URL (see
  // getChatMessages comment above). Also fixes missing encodeURIComponent that
  // was present for chatId but absent for teamId/channelId.
  const entry = allowed.find(
    c => c.teamId === teamId && c.channelId === channelId,
  );
  if (!entry) {
    logger.warn(
      'teams-read: rejected team/channel not in Michael\'s joined channels',
      { teamId, channelId },
    );
    throw new Error('That channel is not accessible — not one Michael has joined.');
  }

  // Both teamId and channelId are now encoded (fixes the missing
  // encodeURIComponent finding) and sourced from the verified allowlist entry.
  const data = await graph(
    'GET',
    `/teams/${encodeURIComponent(entry.teamId)}/channels/${encodeURIComponent(entry.channelId)}/messages?$top=${clampLimit(limit)}`,
  );
  return (data.value ?? []).map(m => ({
    id:   m.id,
    from: m.from?.user?.displayName ?? null,
    sent: m.createdDateTime,
    text: m.body?.content ?? null,
  }));
}
