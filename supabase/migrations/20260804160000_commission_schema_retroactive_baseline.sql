-- Retroactive baseline for the PM commission engine schema.
--
-- These tables (commission_plans, pm_job_assignments, commission_ledger,
-- commission_ledger_lines, commission_report_drafts, commission_sub_bill_flags)
-- were created live via Supabase's migration system between 2026-07-27 and
-- 2026-07-28 (versions 20260727192001 through 20260728173033 in this
-- project's migration history), but the .sql files themselves were never
-- saved to this repo -- this file did not exist until 2026-08-04. All
-- statements are IF NOT EXISTS so applying this against the live database
-- is a safe no-op; its purpose is to give a fresh clone of this repo a way
-- to reconstruct the schema, not to change anything that already exists.

-- Finding #2: Ensure uuid-ossp extension exists before any table that uses
-- uuid_generate_v4() as a default; a fresh database clone will not have it.
create extension if not exists "uuid-ossp";

create table if not exists commission_plans (
  id uuid primary key default uuid_generate_v4(),
  employee_name text not null,
  role text not null default 'project_manager',
  self_performed_rate numeric not null default 0.045,
  maintenance_rate numeric not null default 0.025,
  sub_cap_pct numeric not null default 0.20,
  effective_date date not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Finding #1: Enable RLS on all new tables so that if a client-side or anon
-- key ever reaches these tables, commission data is not fully exposed.
-- Server-side code using the service role key bypasses RLS as before.
alter table commission_plans enable row level security;

create table if not exists pm_job_assignments (
  id uuid primary key default uuid_generate_v4(),
  sa_client_id text,
  sa_contract_id text,
  sa_invoice_sa_id text,
  employee_name text not null,
  source text not null default 'manual',
  assigned_by text,
  assigned_at timestamptz not null default now(),
  notes text,
  confidence text
);
alter table pm_job_assignments enable row level security;

create table if not exists commission_ledger (
  id uuid primary key default uuid_generate_v4(),
  employee_name text not null,
  category text not null,
  sa_reference text not null,
  sa_client_id text,
  client_name text,
  contract_or_first_year_value numeric not null,
  invoiced_amount numeric not null,
  paid_amount numeric not null default 0,
  paid_pct numeric not null default 0,
  commission_rate numeric not null,
  accrued_commission numeric not null,
  payable_commission numeric not null,
  renewal_flag boolean not null default false,
  renewal_confirmed boolean,
  status text not null default 'flagged',
  quarter text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  involves_subcontractor boolean not null default false,
  commissioned_through_amount numeric not null default 0,
  unconfirmed_subcontracted_fraction numeric not null default 0,
  service_names text,
  estimate_number text,
  estimate_date date,
  date_completed date,
  date_paid date,
  pm_attribution_confirmed boolean not null default true,
  constraint commission_ledger_sa_reference_quarter_key unique (sa_reference, quarter)
);
alter table commission_ledger enable row level security;

create table if not exists commission_ledger_lines (
  id uuid primary key default uuid_generate_v4(),
  ledger_id uuid not null references commission_ledger(id) on delete cascade,
  sa_invoice_sa_id text not null,
  qbo_line_description text,
  qbo_item_name text,
  line_amount numeric not null,
  category text not null,
  match_confidence text,
  confirmed boolean not null default false,
  vendor_name text,
  bill_qbo_id text,
  bill_amount numeric,
  bill_date date,
  created_at timestamptz not null default now()
);
alter table commission_ledger_lines enable row level security;

create table if not exists commission_report_drafts (
  id uuid primary key default uuid_generate_v4(),
  quarter text not null,
  is_final boolean not null,
  revision_number integer not null default 1,
  status text not null default 'draft',
  thread_id text not null,
  last_email_id text not null,
  engine_snapshot jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table commission_report_drafts enable row level security;

create table if not exists commission_sub_bill_flags (
  id uuid primary key default uuid_generate_v4(),
  ledger_id uuid not null references commission_ledger(id) on delete cascade,
  qbo_bill_id text not null,
  vendor_name text,
  bill_amount numeric not null,
  bill_date date,
  match_confidence text not null,
  confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  constraint commission_sub_bill_flags_ledger_bill_unique unique (ledger_id, qbo_bill_id)
);
alter table commission_sub_bill_flags enable row level security;
