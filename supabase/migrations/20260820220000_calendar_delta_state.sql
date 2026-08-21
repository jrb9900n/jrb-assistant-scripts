-- Stores the Microsoft Graph delta-query cursor per mailbox for
-- tools/impl/calendar-watch.js. Phase 1 of the autonomous-schedule-manager
-- roadmap agreed with Michael 2026-08-20: lets scheduler/cron.js's
-- calendar_change_watch task detect new/changed events since the last
-- poll without re-diffing a full calendar snapshot every run.
-- window_end tracks the endDateTime baked into the delta cursor at
-- bootstrap time. calendarView/delta's window doesn't slide forward as
-- real time advances, so calendar-watch.js checks this to proactively
-- re-bootstrap with a fresh window before Graph would reject the stale one.
create table if not exists public.calendar_delta_state (
  mailbox text primary key,
  delta_link text not null,
  window_end timestamptz,
  updated_at timestamptz not null default now()
);
-- RLS enabled with no explicit policies, matching every other table added
-- this session (rules.source, conversation_turns, agent_tasks columns) --
-- all access goes through SUPABASE_SERVICE_KEY, which bypasses RLS.
alter table public.calendar_delta_state enable row level security;
