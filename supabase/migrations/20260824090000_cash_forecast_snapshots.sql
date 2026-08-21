-- Weekly snapshot history for the 12-Week Cash Forecast report
-- (tools/impl/cash-forecast-report.js). One row per report run so the report
-- can show a simple forecast-accuracy check ("what did last week's forecast
-- say this week's starting cash would be, vs. what it actually was") instead
-- of just a point-in-time projection. The report's first run has no prior
-- row to compare against — it says so explicitly rather than faking a trend,
-- same convention as ar_dso_snapshots.
create table if not exists public.cash_forecast_snapshots (
  id bigint generated always as identity primary key,
  week_start date not null unique,
  starting_cash numeric not null,
  weekly_forecast jsonb not null, -- array of 12 {weekStart, starting, arIn, apOut, payrollOut, ending}
  lowest_week date,
  lowest_amount numeric,
  created_at timestamptz not null default now()
);
alter table public.cash_forecast_snapshots enable row level security;
