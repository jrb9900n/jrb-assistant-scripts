-- Adds the instrumentation voice-call quality review (tools/impl/voice-call-review.js)
-- needs, on top of the existing transcript-only voice_call_log (see
-- 20260827090000_voice_call_log.sql).
--
-- tool_calls: per-call record of which tools were invoked, whether each
-- succeeded, and how long it took -- the transcript alone only shows what
-- was SAID, not what the agent actually tried to do behind the scenes.
-- Without this, "the assistant couldn't find that client" and "the SA tool
-- call errored" are indistinguishable from a transcript read alone.
--
-- reviewed_at / review_findings: tracks which calls voice-call-review.js has
-- already processed (so a scheduled run only analyzes new calls, not the
-- whole table every time) and keeps the structured per-call findings as an
-- audit trail -- separate from the cross-call synthesized rules that
-- actually change future behavior (those land in the existing `rules`
-- table, not here).
alter table public.voice_call_log
  add column if not exists tool_calls jsonb not null default '[]'::jsonb,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_findings jsonb;

create index if not exists voice_call_log_unreviewed_idx
  on public.voice_call_log (started_at)
  where reviewed_at is null;
