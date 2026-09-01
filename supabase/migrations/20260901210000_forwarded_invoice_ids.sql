-- Dedup table for tools/impl/invoice-folder-forwarder.js: records every
-- Graph message ID from michael@jrboehlke.com's "_Invoices" folder that has
-- already been forwarded to joanne@jrboehlke.com, so the every-5-minute
-- poller (invoice_folder_forwarder task, scheduler/cron.js) never double-sends.
-- Rows are written BEFORE the forward is sent (see that file's dedup
-- philosophy comment) -- a row existing means "forwarded, or forward was
-- attempted and is not being retried," not merely "queued."
create table if not exists public.forwarded_invoice_ids (
  message_id   text primary key,
  subject      text,
  received_at  timestamptz,
  forwarded_at timestamptz not null default now()
);
create index if not exists forwarded_invoice_ids_forwarded_at_idx
  on public.forwarded_invoice_ids (forwarded_at);

-- Same pattern as every other table in this project (rules, conversation_turns,
-- website_change_proposals, etc.): this app's backend uses the service_role
-- key exclusively, which bypasses RLS entirely, so enabling it with zero
-- policies is a pure deny-all for anon/authenticated with no functional
-- impact on the app itself.
alter table public.forwarded_invoice_ids enable row level security;
