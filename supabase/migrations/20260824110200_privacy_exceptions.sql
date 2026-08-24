-- Standing exceptions Michael grants when approving an employee_requests row
-- with "yes, and remember this going forward" -- checked on FUTURE requests
-- from the same requester before re-asking Michael. Kept separate from the
-- `rules` table (which broadcasts into every system prompt with no
-- per-requester scoping -- see tools/impl/privacy-gate.js for the full
-- reasoning) so one employee's approved topic can never leak into an
-- unrelated context.
create table if not exists public.privacy_exceptions (
  id uuid primary key default gen_random_uuid(),
  requester_aad_id text not null,
  topic_summary text not null,
  rule_text text not null,
  granted_by text not null default 'michael',
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists privacy_exceptions_requester_idx on public.privacy_exceptions (requester_aad_id, active);
