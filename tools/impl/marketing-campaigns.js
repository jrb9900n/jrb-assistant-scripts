// tools/impl/marketing-campaigns.js
// CRUD against the `marketing_campaigns` table (fleetops Supabase) - the
// audit trail of every re-engagement campaign run through the tag system:
// which SA tags were used, how many clients, when applied/removed. Table
// created 2026-08-25 alongside the first real campaign ("Due for a Recoat
// (2026)", 468 clients, logged retroactively after the fact).
//
// Status vocabulary: proposed -> approved -> applied -> completed, plus
// removed (tags cleared, e.g. after the campaign's emails were sent and the
// temporary tags served their purpose).

import { supabase } from './ar-report-helpers.js';
import { logger } from '../../core/logger.js';

export async function createMarketingCampaign({ campaignName, description, saTagNames, saTagCategory, clientCount, notes }) {
  const { data, error } = await supabase
    .from('marketing_campaigns')
    .insert({
      campaign_name: campaignName,
      description,
      sa_tag_names: saTagNames,
      sa_tag_category: saTagCategory,
      client_count: clientCount,
      status: 'proposed',
      notes,
    })
    .select()
    .single();
  if (error) throw new Error(`createMarketingCampaign: ${error.message}`);
  logger.info('marketing_campaigns: created', { id: data.id, campaignName });
  return data;
}

export async function updateMarketingCampaignStatus({ id, status, notes, appliedAt, removedAt }) {
  const validStatuses = ['proposed', 'approved', 'applied', 'completed', 'removed'];
  if (!validStatuses.includes(status)) {
    throw new Error(`updateMarketingCampaignStatus: invalid status "${status}" - must be one of ${validStatuses.join(', ')}`);
  }
  const update = { status };
  if (notes !== undefined) update.notes = notes;
  if (appliedAt !== undefined) update.applied_at = appliedAt;
  if (removedAt !== undefined) update.removed_at = removedAt;

  const { data, error } = await supabase
    .from('marketing_campaigns')
    .update(update)
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(`updateMarketingCampaignStatus: ${error.message}`);
  logger.info('marketing_campaigns: status updated', { id, status });
  return data;
}

export async function listMarketingCampaigns({ status, serviceCategory } = {}) {
  let query = supabase.from('marketing_campaigns').select('*').order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  if (serviceCategory) query = query.or(`campaign_name.ilike.%${serviceCategory}%,description.ilike.%${serviceCategory}%`);
  const { data, error } = await query;
  if (error) throw new Error(`listMarketingCampaigns: ${error.message}`);
  return data;
}

export async function getMarketingCampaign({ id }) {
  const { data, error } = await supabase.from('marketing_campaigns').select('*').eq('id', id).single();
  if (error) throw new Error(`getMarketingCampaign: ${error.message}`);
  return data;
}
