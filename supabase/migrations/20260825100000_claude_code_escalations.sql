-- Pending-approval state machine for escalating a Teams task the normal
-- runAgent() tool set can't complete out to a full headless Claude Code
-- invocation. Same shape as employee_requests/privacy-gate.js's approval
-- flow, just triggered by the model itself (via the escalate_to_claude_code
-- tool) instead of by requester identity. See tools/impl/claude-code-escalation.js.
create table if not exists public.claude_code_escalations (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  conversation_id text not null,
  service_url text not null,
  task text not null,
  task_type text not null,
  reason text not null,
  status text not null default 'pending'
    check (status in ('pending','approved','denied')),
  result text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists claude_code_escalations_status_idx on public.claude_code_escalations (status, created_at desc);
create index if not exists claude_code_escalations_session_idx on public.claude_code_escalations (session_id, created_at desc);

-- Locked down like rules/conversation_turns: RLS on, zero policies, so only
-- the service-role key (which this Node backend uses exclusively) can touch
-- it. See project-supabase-rls-exposure-fix-2026-08-21 -- employee_requests
-- was left without RLS by oversight; don't repeat that here.
alter table public.claude_code_escalations enable row level security;
