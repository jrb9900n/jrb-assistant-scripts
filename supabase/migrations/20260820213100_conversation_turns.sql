-- Short-term raw conversation history for memory/conversation.js. Distinct
-- from agent_memory (Haiku-summarized, long-term): this stores the last few
-- raw turns per Teams conversation so the agent doesn't lose the thread
-- mid-conversation. Bounded per session via application-level pruning in
-- saveTurn(), not a DB-level retention policy.
create table if not exists public.conversation_turns (
  id bigint generated always as identity primary key,
  session_id text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
-- Indexed on id, not created_at: loadRecentTurns() orders by id (not
-- created_at) specifically because id is monotonic per insert commit even
-- when two Teams messages are handled concurrently and their timestamps
-- land close enough to tie or invert.
create index if not exists conversation_turns_session_idx
  on public.conversation_turns (session_id, id desc);
alter table public.conversation_turns enable row level security;
