-- Weekly pipeline-health history for the Sales Pipeline / BD report
-- (tools/impl/sales-pipeline-report.js). One row per BD-mode run so the report
-- can show a week-over-week trend for open pipeline value and win rate instead
-- of just a point-in-time figure. Same pattern as ar_dso_snapshots
-- (tools/impl/ar-collections-report.js) — the report's first run has no prior
-- row to compare against and says so explicitly rather than faking a trend.
create table if not exists public.sales_pipeline_snapshots (
  id bigint generated always as identity primary key,
  week_start date not null unique,
  open_pipeline_value numeric not null,
  open_pipeline_count integer not null,
  win_rate numeric,
  avg_deal_size numeric,
  created_at timestamptz not null default now()
);
alter table public.sales_pipeline_snapshots enable row level security;
