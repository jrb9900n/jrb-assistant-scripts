-- Pending-approval state machine for code/repo/infra-write tool calls
-- (write_file, run_script, github_push, github_merge_pr, vercel_api's write
-- actions) from the Teams bot or voice app. Same shape as
-- claude_code_escalations/employee_requests's approval flow, just gated
-- centrally in tools/dispatcher.js's dispatchTool() instead of triggered by
-- a specific tool or requester identity. See tools/impl/code-approval.js.
create table if not exists public.code_action_approvals (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('teams', 'voice')),
  session_id text,
  conversation_id text,
  service_url text,
  call_id text,
  tool_name text not null,
  tool_input jsonb not null,
  context jsonb not null,
  description text not null,
  requested_by text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'executed', 'error')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  result jsonb
);
create index if not exists code_action_approvals_status_idx on public.code_action_approvals (status, created_at);

-- Same pattern as claude_code_escalations: RLS enabled, zero policies --
-- service_role (used by this app's backend) bypasses RLS entirely, so this
-- is a deny-all for anon/authenticated with no functional impact on the app.
alter table public.code_action_approvals enable row level security;
