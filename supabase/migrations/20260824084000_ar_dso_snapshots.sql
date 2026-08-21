-- Weekly DSO (Days Sales Outstanding) history for the AR/Collections report
-- (tools/impl/ar-collections-report.js). One row per report run so the report
-- can show a trend instead of just a point-in-time figure. The report's first
-- run has no prior row to compare against — it says so explicitly rather than
-- faking a trend.
create table if not exists public.ar_dso_snapshots (
  id bigint generated always as identity primary key,
  week_start date not null unique,
  total_ar numeric not null,
  dso numeric not null,
  created_at timestamptz not null default now()
);
alter table public.ar_dso_snapshots enable row level security;
