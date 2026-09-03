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
