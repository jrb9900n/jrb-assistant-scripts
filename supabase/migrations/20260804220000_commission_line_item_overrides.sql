-- QBO's own line-item name isn't always resolvable (real case: Heather
-- Kehr's $1,470 planting job, invoice #33551 -- no qb_invoices row synced
-- for its qbo_id at all). Same escape-hatch pattern as
-- commission_payment_overrides for exactly this kind of sync gap.
create table if not exists commission_line_item_overrides (
  sa_invoice_sa_id text primary key,
  line_item_name text not null,
  note text,
  confirmed_by text,
  confirmed_at timestamptz not null default now()
);
alter table commission_line_item_overrides enable row level security;
