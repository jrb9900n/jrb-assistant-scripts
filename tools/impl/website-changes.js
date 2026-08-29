// tools/impl/website-changes.js
// CRUD against `website_change_proposals` (jrb-assistant Supabase) -- the
// approval queue for jrboehlke.com SEO/content changes drafted by the new
// seo-advisor persona (agents/seed.js, taskType 'marketing'). Mirrors
// tools/impl/marketing-campaigns.js's proposal-lifecycle shape (status:
// proposed -> approved/rejected -> applied) rather than reusing
// tools/impl/code-approval.js's code_action_approvals table -- that table's
// shape (generic tool_name/tool_input replay + a Teams "confirm <code>"
// reply) is built for a one-off per-action confirmation, not a weekly BATCH
// review with a screenshot/rationale/expected-impact payload attached to
// each row. See supabase/migrations/20260829120000_website_change_proposals.sql
// for the full design note, including the project-placement discrepancy
// found while building this (marketing_campaigns actually lives in the
// FleetOps project, not this one).
//
// IMPORTANT: nothing in this file ever touches the live site. Writing an
// approved change to jrboehlke.com itself is a separate, not-yet-built step
// -- see tools/impl/website-content.js's header for why a live-editing tool
// isn't included in this pass.

import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';

function supabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

const VALID_STATUSES = ['proposed', 'approved', 'rejected', 'applied'];

export async function proposeWebsiteChange({
  pageUrl, fieldName, oldValue, newValue, rationale, expectedImpact,
  screenshotBefore, screenshotAfter, requestedBy, notes,
}) {
  if (!pageUrl || !fieldName || !newValue || !rationale) {
    throw new Error('proposeWebsiteChange: pageUrl, fieldName, newValue, and rationale are all required');
  }
  const { data, error } = await supabase()
    .from('website_change_proposals')
    .insert({
      page_url: pageUrl,
      field_name: fieldName,
      old_value: oldValue ?? null,
      new_value: newValue,
      rationale,
      expected_impact: expectedImpact ?? null,
      screenshot_before: screenshotBefore ?? null,
      screenshot_after: screenshotAfter ?? null,
      status: 'proposed',
      requested_by: requestedBy ?? 'seo-advisor',
      notes: notes ?? null,
    })
    .select()
    .single();
  if (error) throw new Error(`proposeWebsiteChange: ${error.message}`);
  logger.info('website_change_proposals: created', { id: data.id, pageUrl, fieldName });
  return data;
}

export async function listWebsiteChangeProposals({ status, pageUrl } = {}) {
  let query = supabase().from('website_change_proposals').select('*').order('created_at', { ascending: false });
  if (status) {
    if (!VALID_STATUSES.includes(status)) {
      throw new Error(`listWebsiteChangeProposals: invalid status "${status}" - must be one of ${VALID_STATUSES.join(', ')}`);
    }
    query = query.eq('status', status);
  }
  if (pageUrl) query = query.ilike('page_url', `%${pageUrl}%`);
  const { data, error } = await query;
  if (error) throw new Error(`listWebsiteChangeProposals: ${error.message}`);
  return data;
}

export async function getWebsiteChangeProposal({ id }) {
  if (!id) throw new Error('getWebsiteChangeProposal: id is required');
  const { data, error } = await supabase().from('website_change_proposals').select('*').eq('id', id).single();
  if (error) throw new Error(`getWebsiteChangeProposal: ${error.message}`);
  return data;
}

// Deliberately NOT registered as an agent tool (see tools/registry.js /
// tools/dispatcher.js) -- this is the one function in this file the
// seo-advisor persona itself must never be able to call. Moving a proposal
// to 'approved'/'applied' is Michael's decision during his Monday review,
// not something the propose-only persona should ever be able to trigger on
// its own conversational say-so. Kept here as a plain exported function for
// whatever surface eventually handles the human-approval step (the
// not-yet-built report-integration piece, or a direct Supabase/script call)
// -- same reasoning as this codebase's "hard structural guarantee, not just
// prompt discipline" pattern (see tools/registry.js's TOOL_MAP.marketing
// comment on why send_email/send_draft_reply are excluded there).
export async function updateWebsiteChangeProposalStatus({ id, status, notes, reviewedBy, appliedAt }) {
  if (!id) throw new Error('updateWebsiteChangeProposalStatus: id is required');
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`updateWebsiteChangeProposalStatus: invalid status "${status}" - must be one of ${VALID_STATUSES.join(', ')}`);
  }
  const update = { status };
  if (notes !== undefined) update.notes = notes;
  if (reviewedBy !== undefined) update.reviewed_by = reviewedBy;
  if (status === 'approved' || status === 'rejected') update.reviewed_at = new Date().toISOString();
  if (appliedAt !== undefined) update.applied_at = appliedAt;
  else if (status === 'applied') update.applied_at = new Date().toISOString();

  const { data, error } = await supabase()
    .from('website_change_proposals')
    .update(update)
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(`updateWebsiteChangeProposalStatus: ${error.message}`);
  logger.info('website_change_proposals: status updated', { id, status });
  return data;
}
