-- sa_payment_applications has zero synced rows for several real, fully-paid
-- invoices checked 2026-08-04 (Jason Carver x2, Kelley Sovol, Laura Ramos,
-- Joyce Aldon) -- there is no system signal at all for WHEN they were paid.
-- fetchPaidAmountAsOf (commission-engine.js) defaults to $0 for an invoice
-- with no synced payment-application data, on purpose: for a quarter-end
-- payout, "unknown timing" must not silently resolve to "definitely paid by
-- quarter-end." This table is the escape hatch for the specific jobs where a
-- human (Michael) directly knows the real paid-by date despite the sync gap.
create table if not exists commission_payment_overrides (
  sa_invoice_sa_id text primary key,
  paid_amount_confirmed numeric not null,
  as_of_date date not null,
  note text,
  confirmed_by text,
  confirmed_at timestamptz not null default now()
);
alter table commission_payment_overrides enable row level security;
