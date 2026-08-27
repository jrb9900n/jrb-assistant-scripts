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

-- The application exclusively accesses this table via the service role key,
-- which bypasses RLS. No client-side (anon/authenticated) access is
-- intended -- voice call transcripts are internal operational records, not
-- user-facing data. The policies below make this intent explicit and ensure
-- that if the wrong key is ever used by accident, all access is denied
-- rather than silently succeeding or silently returning empty.
--
-- If a future feature needs authenticated reads (e.g. a dashboard), add a
-- scoped SELECT policy here at that time.
create policy "voice_call_log: deny anon reads"
  on public.voice_call_log
  for select
  to anon
  using (false);

-- with check (false) is required alongside using (false) for INSERT/UPDATE
-- coverage: Postgres ignores USING for INSERT operations and only evaluates
-- WITH CHECK, so omitting it means this "for all" policy does not actually
-- block anon INSERT statements.
create policy "voice_call_log: deny anon writes"
  on public.voice_call_log
  for all
  to anon
  using (false)
  with check (false);

create policy "voice_call_log: deny authenticated reads"
  on public.voice_call_log
  for select
  to authenticated
  using (false);

-- with check (false) is required alongside using (false) for INSERT/UPDATE
-- coverage: Postgres ignores USING for INSERT operations and only evaluates
-- WITH CHECK, so omitting it means this "for all" policy does not actually
-- block authenticated INSERT statements.
create policy "voice_call_log: deny authenticated writes"
  on public.voice_call_log
  for all
  to authenticated
  using (false)
  with check (false);
