-- QBO invoice line-item names (e.g. "Grading", "Topsoil", "Hardscape
-- Installation") per Michael's report spec, 2026-08-04.
alter table commission_ledger
  add column if not exists line_item_names text;
