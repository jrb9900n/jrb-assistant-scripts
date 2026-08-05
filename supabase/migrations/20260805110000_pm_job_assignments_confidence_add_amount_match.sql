-- Adds 'estimate_amount_match' to the allowed confidence values -- a new,
-- more reliable attribution tier (2026-08-05) that matches an invoice to
-- its originating estimate by exact pretax dollar amount via
-- sa_estimates_2026, instead of guessing by date proximity.
alter table pm_job_assignments drop constraint if exists pm_job_assignments_confidence_check;
alter table pm_job_assignments add constraint pm_job_assignments_confidence_check
  check (confidence is null or confidence = any (array['manual', 'job_confirmed', 'job_fuzzy_matched', 'estimate_scrape', 'estimate_amount_match']));
