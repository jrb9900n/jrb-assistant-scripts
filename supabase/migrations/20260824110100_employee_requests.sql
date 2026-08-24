-- Pending-approval state machine for non-Michael Teams requesters. A row is
-- created whenever an employee asks the assistant for anything beyond
-- genuinely generic info; Michael is notified and replies yes/no/"remember
-- this" to resolve it. See tools/impl/privacy-gate.js.
create table if not exists public.employee_requests (
  id uuid primary key default gen_random_uuid(),
  requester_aad_id text not null,
  requester_name text,
  requester_email text,
  requester_conversation_id text not null,
  requester_service_url text not null,
  request_text text not null,
  status text not null default 'pending'
    check (status in ('pending','approved_once','approved_standing','denied','expired')),
  michael_notified_at timestamptz,
  resolved_at timestamptz,
  resolution_note text,
  probing_alert_sent boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists employee_requests_status_idx on public.employee_requests (status, created_at desc);
create index if not exists employee_requests_requester_idx on public.employee_requests (requester_aad_id, created_at desc);
