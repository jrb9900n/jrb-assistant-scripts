-- claude_code_escalations was a pending-approval state machine (yes/no from
-- Michael before anything ran) -- session_id/conversation_id/service_url/
-- task_type existed to route that Teams approval reply back to the right
-- conversation. Rebuilt 2026-09-03 to start immediately (no approval gate,
-- no Teams conversation required at all -- see tools/impl/claude-code-
-- escalation.js's own header), so this table is now just an audit log:
-- those four columns have no value to write on insert anymore. Relaxed
-- additively (nullable, not dropped) rather than removed, so any existing
-- historical rows and the columns themselves stay intact.
alter table public.claude_code_escalations alter column session_id drop not null;
alter table public.claude_code_escalations alter column conversation_id drop not null;
alter table public.claude_code_escalations alter column service_url drop not null;
alter table public.claude_code_escalations alter column task_type drop not null;

alter table public.claude_code_escalations drop constraint if exists claude_code_escalations_status_check;
alter table public.claude_code_escalations add constraint claude_code_escalations_status_check
  check (status in ('pending','approved','denied','running','completed','error'));

-- Issue #2 fix: prevent concurrent duplicate escalations for the same branch.
-- Two simultaneous triggers (e.g. voice + Teams, or a retry before the first
-- finishes) could previously both INSERT with the same branch_name and both
-- attempt `git worktree add` for the same branch, causing the second to fail
-- non-fatally or both to race toward opening duplicate PRs.
--
-- A partial unique index on branch_name covering only the active/in-progress
-- statuses (pending, approved, running) enforces at the DB level that only one
-- live escalation per branch can exist at a time. Completed/error/denied rows
-- are excluded so a branch that was previously used and finished can be reused
-- in a future escalation without hitting the constraint.
--
-- branch_name column: added here if it does not already exist on the table.
-- If it was added by a prior migration, the ALTER TABLE is a no-op on
-- re-run (idempotent via IF NOT EXISTS).
alter table public.claude_code_escalations
  add column if not exists branch_name text;

drop index if exists public.claude_code_escalations_branch_active_uniq;
create unique index claude_code_escalations_branch_active_uniq
  on public.claude_code_escalations (branch_name)
  where status in ('pending', 'approved', 'running');
