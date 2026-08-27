-- Full raw transcript + summary per voice call. Distinct from
-- conversation_turns (Teams' bounded, pruned rolling window used only to
-- keep an LLM from losing the thread mid-conversation) -- this is a
-- permanent call log, closer to a voicemail transcript archive: nothing here
-- is pruned. The summary is ALSO written into agent_memory (topic
-- 'voice_call') via memory.js's existing saveMemory(), so a voice call's
-- outcome flows into the same shared, cross-channel context Teams already
-- reads via loadContext() -- this table exists for the full-text record,
-- not as the mechanism that gives calls memory of each other or of Teams.
--
-- Never contains PIN-gate turns: voice/openai-realtime-client.js only starts
-- appending to session.transcript after authState flips to 'verified', so a
-- spoken PIN attempt (right or wrong) is never persisted here.
create table if not exists public.voice_call_log (
  id bigint generated always as identity primary key,
  call_connection_id text not null,
  from_number text,
  started_at timestamptz not null,
  ended_at timestamptz not null default now(),
  transcript jsonb not null default '[]'::jsonb,
  summary text,
  created_at timestamptz not null default now()
);
create index if not exists voice_call_log_started_idx
  on public.voice_call_log (started_at desc);
alter table public.voice_call_log enable row level security;
