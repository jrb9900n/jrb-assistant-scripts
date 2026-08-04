-- sa_accepted_estimates has no reliable won/lost/sent-only signal (resolved_at
-- and resolved_reason are null for every row checked so far) -- Michael has to
-- tell us this from context. This table lets that be recorded once instead of
-- re-explained every report cycle, mirroring the sticky-confirmation pattern
-- already used for renewal_confirmed on commission_ledger.
create table if not exists estimate_resolutions (
  estimate_number text primary key,
  resolution text not null check (resolution in ('lost', 'sent_only', 'in_progress', 'invoiced')),
  note text,
  matched_invoice_number text,
  resolved_by text,
  resolved_at timestamptz not null default now()
);
alter table estimate_resolutions enable row level security;
