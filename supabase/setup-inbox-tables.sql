-- Inbox triage tables for autonomous email assistant
-- Run in Supabase dashboard → SQL Editor (project: jrb-assistant / znpahinyplccdyoekfeo)

-- ── email_triage ────────────────────────────────────────────────────────────────
-- One row per processed email from michael@jrboehlke.com.
-- Separate from email_catalog (which covers assistant@ receipts/alerts).

create table if not exists email_triage (
  id               uuid primary key default gen_random_uuid(),
  message_id       text unique not null,
  thread_id        text,
  mailbox          text not null default 'michael@jrboehlke.com',
  from_address     text,
  from_name        text,
  subject          text,
  received_at      timestamptz,
  priority         text check (priority in ('p1','p2','p3')),
  category         text,
  intent           text,
  folder_moved_to  text,
  meeting_detected boolean default false,
  draft_id         text,
  action_items     jsonb default '[]',
  hot_trigger      boolean default false,
  hot_reason       text,
  teams_alerted    boolean default false,
  processed_at     timestamptz default now()
);

create index if not exists idx_email_triage_received   on email_triage (received_at desc);
create index if not exists idx_email_triage_priority   on email_triage (priority);
create index if not exists idx_email_triage_thread     on email_triage (thread_id);
create index if not exists idx_email_triage_processed  on email_triage (processed_at desc);

-- ── email_followup_tracker ──────────────────────────────────────────────────────
-- Tracks emails Michael sent that haven't received a reply after a threshold.

create table if not exists email_followup_tracker (
  id              uuid primary key default gen_random_uuid(),
  thread_id       text unique not null,
  message_id      text not null,
  to_address      text,
  subject         text,
  sent_at         timestamptz,
  followup_after  timestamptz,
  resolved_at     timestamptz,
  resolution_type text,        -- 'replied', 'manual', 'expired'
  created_at      timestamptz default now()
);

create index if not exists idx_followup_sent       on email_followup_tracker (sent_at desc);
create index if not exists idx_followup_unresolved on email_followup_tracker (resolved_at) where resolved_at is null;
