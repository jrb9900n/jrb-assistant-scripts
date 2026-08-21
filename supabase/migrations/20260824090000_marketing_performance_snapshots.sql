-- Weekly Google Ads performance history for the Marketing Performance report
-- (tools/impl/marketing-performance-report.js). One row per report run so the
-- Monday email can show a week-over-week trend instead of just a point-in-time
-- figure, same pattern as ar_dso_snapshots for the AR/Collections report. The
-- report's first run has no prior row to compare against -- it says so
-- explicitly rather than faking a trend.
create table if not exists public.marketing_performance_snapshots (
  id bigint generated always as identity primary key,
  week_start date not null unique,
  total_spend numeric not null,
  impressions bigint not null,
  clicks bigint not null,
  ctr numeric,
  avg_cpc numeric,
  conversions numeric not null,
  cost_per_lead numeric,
  budget_total numeric,
  pacing_pct numeric,
  won_job_count integer not null,
  won_revenue numeric not null,
  cost_per_won_job numeric,
  created_at timestamptz not null default now()
);
alter table public.marketing_performance_snapshots enable row level security;
