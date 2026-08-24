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

-- Prevent the same occurrence from being logged as displaced more than once.
-- This is the primary guard against the read-check-then-write race: even if
-- two concurrent requests both read a count under the cap and both attempt to
-- log a displacement of the same occurrence, only one insert can succeed.
-- The second will receive a unique-violation error, which logBlockDisplacement
-- surfaces as a warning and callers should treat as a signal to abort.
create unique index if not exists block_displacement_log_occurrence_unique_idx
  on public.block_displacement_log (occurrence_id);

-- Per-series displacement counter for atomic cap enforcement. Rows are
-- upserted (INSERT ... ON CONFLICT DO UPDATE) by a stored procedure so that
-- the count increment and the cap check happen in a single serialized
-- database operation, removing the application-level read-then-write race
-- for the rolling-window cap. The rolling window check (created_at filter)
-- remains in the application layer via countRecentDisplacements; this table
-- provides the serialization point that prevents two concurrent bookings for
-- the same series from both passing the cap check simultaneously.
create table if not exists public.block_displacement_series_lock (
  series_master_id text primary key,
  last_displacement_at timestamptz not null default now()
);

-- Stored procedure: atomically claim a displacement slot for a series.
-- Returns TRUE if the slot was granted (count under cap after increment),
-- FALSE if the series is at or over cap for the window.
-- Callers must check the return value and refuse to proceed if FALSE.
--
-- Parameters:
--   p_series_master_id  — the recurring series' stable Graph event ID
--   p_window_start      — start of the rolling window (now() - 30 days)
--   p_cap               — maximum allowed displacements in the window (2)
create or replace function public.try_claim_displacement(
  p_series_master_id text,
  p_window_start      timestamptz,
  p_cap               int
) returns boolean
language plpgsql
as $$
declare
  v_count int;
begin
  -- Serialize all cap checks for this series by locking its row.
  -- FOR UPDATE causes concurrent calls to queue behind each other rather
  -- than running the count check simultaneously on the same snapshot.
  insert into public.block_displacement_series_lock (series_master_id, last_displacement_at)
    values (p_series_master_id, now())
    on conflict (series_master_id) do update
      set last_displacement_at = now();

  -- Now count existing displacements within the window under the lock.
  select count(*)
    into v_count
    from public.block_displacement_log
   where series_master_id = p_series_master_id
     and created_at >= p_window_start;

  return v_count < p_cap;
end;
$$;
