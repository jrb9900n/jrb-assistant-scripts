-- Approval queue for jrboehlke.com SEO/content changes drafted by the new
-- seo-advisor persona (agents/seed.js, taskType 'marketing'). Michael's
-- requirement: every website change is reviewed with a before/after view,
-- rationale, and expected-impact note as part of his Monday marketing
-- review -- no autonomous website edits, ever.
--
-- Deliberately its own table rather than reusing code_action_approvals: that
-- table's shape (generic tool_name/tool_input replay + a Teams "confirm
-- <code>"/"deny <code>" reply, 30-min expiry) is built around a one-off
-- per-action confirmation, not a weekly BATCH review with a
-- screenshot/rationale/expected-impact payload attached to each row. This
-- table borrows the same *state-machine shape* (pending row -> a human
-- decision -> only then does anything execute) but is triggered by the
-- Monday report, not an individual Teams message per change. A future,
-- separate piece of work wires "pending proposals" into
-- marketing-performance-report.js's existing "Marketing Ideas" section
-- (see tools/impl/marketing-ideas.js's pattern) -- not built here, but this
-- table's shape (status filter + created_at ordering) is chosen to support
-- that cleanly when it lands.
--
-- Note on project placement: marketing_campaigns/marketing_segment_candidates
-- actually live in the FleetOps Supabase project (mzywmgesulyalevtzudw), not
-- this one -- confirmed live 2026-08-29 while building this migration. This
-- table is placed in jrb-assistant (znpahinyplccdyoekfeo) per explicit
-- instruction instead, matching where the other approval-queue tables
-- (code_action_approvals, claude_code_escalations, employee_requests) live.
create table if not exists public.website_change_proposals (
  id uuid primary key default gen_random_uuid(),
  page_url text not null,
  field_name text not null,
  old_value text,
  new_value text not null,
  rationale text not null,
  expected_impact text,
  -- Supabase Storage path/URL, or a plain descriptive text note when actual
  -- screenshot capture isn't wired up yet -- see tools/impl/website-content.js.
  screenshot_before text,
  screenshot_after text,
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'rejected', 'applied')),
  requested_by text,
  notes text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text,
  applied_at timestamptz
);
create index if not exists website_change_proposals_status_idx on public.website_change_proposals (status, created_at);
create index if not exists website_change_proposals_page_url_idx on public.website_change_proposals (page_url);

-- Same pattern as every other table in this project (rules, conversation_turns,
-- claude_code_escalations, code_action_approvals, etc.): this app's backend
-- uses the service_role key exclusively, which bypasses RLS entirely, so
-- enabling it with zero policies is a pure deny-all for anon/authenticated
-- with no functional impact on the app itself.
alter table public.website_change_proposals enable row level security;
