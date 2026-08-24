-- Renames email_triage.priority -> email_triage.bucket, and its Fyxer.ai-style
-- values (needs_reply/fyi/marketing) replace the old numeric p1/p2/p3 tiers.
-- Michael explicitly preferred Fyxer's simpler 3-bucket model over a priority
-- scale (2026-08-24). A rename, not a drop, so historical rows are preserved --
-- their old p1/p2/p3 values are left as-is under the new column name (this is
-- a going-forward relabeling of the taxonomy, not a backfill of old rows).
alter table public.email_triage rename column priority to bucket;

-- Replace the old p1/p2/p3-only check constraint with one that accepts both
-- the legacy values (still present in historical rows that were not backfilled)
-- and the new needs_reply/fyi/marketing values emitted going forward.
-- Dropping the old constraint and adding a new one rather than using ALTER
-- CONSTRAINT because Postgres requires a full DROP+ADD to change the expression.
-- The new constraint keeps DB-level rejection of truly unexpected values (e.g.
-- a typo, a buggy direct INSERT, or a future code regression) while remaining
-- compatible with existing data.
alter table public.email_triage drop constraint email_triage_priority_check;
alter table public.email_triage
  add constraint email_triage_bucket_check
  check (bucket in ('p1', 'p2', 'p3', 'needs_reply', 'fyi', 'marketing'));
