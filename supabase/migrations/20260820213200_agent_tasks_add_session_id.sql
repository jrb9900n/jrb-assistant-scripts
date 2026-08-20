-- Lets scheduler/task-poller.js attribute a queued SA-retry task's real
-- outcome back to the Teams conversation that requested it, via
-- memory/conversation.js's saveTurn(). Without this, the conversation
-- history only ever records the generic "I've queued this task..."
-- placeholder -- never what actually happened once the retry completed.
alter table public.agent_tasks add column if not exists session_id text;

-- Carries the recent-turns context (memory/conversation.js's extraMessages)
-- that was loaded for the original attempt through to the retried run in
-- task-poller.js. Without this, a retried task loses the short-term
-- conversation context the live attempt would have had -- e.g. it can no
-- longer resolve "that" if the referent was in a message from a couple
-- turns before the one that got SA-blocked.
alter table public.agent_tasks add column if not exists extra_messages jsonb;
