-- Renames email_triage.priority -> email_triage.bucket, and its Fyxer.ai-style
-- values (needs_reply/fyi/marketing) replace the old numeric p1/p2/p3 tiers.
-- Michael explicitly preferred Fyxer's simpler 3-bucket model over a priority
-- scale (2026-08-24). A rename, not a drop, so historical rows are preserved --
-- their old p1/p2/p3 values are left as-is under the new column name (this is
-- a going-forward relabeling of the taxonomy, not a backfill of old rows).
alter table public.email_triage rename column priority to bucket;

-- The rename alone isn't sufficient -- the existing check constraint still
-- enforces the OLD p1/p2/p3 values under its old name, so every write would
-- otherwise start failing immediately. Just drop it rather than replacing
-- with a new needs_reply/fyi/marketing-only constraint: real historical rows
-- still hold the old p1/p2/p3 values (left as-is, not backfilled -- see
-- above), so a strict new-values-only constraint would itself be violated by
-- existing data. Going-forward values are already constrained at the
-- application layer (inbox-processor.js's classifier prompt/fallbacks only
-- ever emit the 3 new values; dispatcher.js's VALID_BUCKETS validates the
-- get_email_triage query param) -- no DB-level enum needed.
alter table public.email_triage drop constraint email_triage_priority_check;
