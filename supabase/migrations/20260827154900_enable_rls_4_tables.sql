-- Closes a repeat of the exact gap the 2026-08-21 RLS fix already flagged --
-- claude_code_escalations's own migration comment warned "employee_requests
-- was left without RLS by oversight; don't repeat that here," but it (and
-- employees, privacy_exceptions, block_displacement_log) were still
-- RLS-disabled and exposed to the anon key as of 2026-08-27. Found via
-- Supabase's own advisor while adding code_action_approvals (see
-- 20260827135000_code_action_approvals.sql) in the prior PR.
--
-- No policies added -- same as every other table in this project (rules,
-- conversation_turns, claude_code_escalations, code_action_approvals, etc.):
-- this app's backend uses the service_role key exclusively, which bypasses
-- RLS entirely, so enabling it with zero policies is a pure deny-all for
-- anon/authenticated with no functional impact on the app itself.
alter table public.employees enable row level security;
alter table public.employee_requests enable row level security;
alter table public.privacy_exceptions enable row level security;
alter table public.block_displacement_log enable row level security;
