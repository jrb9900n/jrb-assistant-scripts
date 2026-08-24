-- Logs every auto-resolved displacement of an [OCCASIONAL]-tier block-schedule
-- occurrence, so checkAndResolveDisplacement can enforce "occasional, not
-- routine" as a real rolling-window cap (confirmed with Michael: 2 per 30
-- days per series) instead of just a label. Keyed by series_master_id (the
-- recurring series' stable identity) rather than the per-occurrence event id,
-- since each week's occurrence has its own id but "how often has THIS block
-- been displaced" is a series-level question.
create table if not exists public.block_displacement_log (
  id uuid primary key default gen_random_uuid(),
  mailbox text not null,
  series_master_id text,
  occurrence_id text not null,
  subject text not null,
  occurrence_date date not null,
  action text not null,
  requested_by text,
  requester_identity text,
  created_at timestamptz not null default now()
);
create index if not exists block_displacement_log_series_created_idx
  on public.block_displacement_log (series_master_id, created_at);
