-- Add Invoice #/Invoice Date to commission_ledger so the report can show
-- them directly instead of only Estimate #/Date -- Michael's report spec
-- (2026-08-04) calls for both.
alter table commission_ledger
  add column if not exists invoice_number text,
  add column if not exists invoice_date date;
