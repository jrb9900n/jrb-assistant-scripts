// tools/impl/marketing-ideas.js
// Gather step for the Monday marketing digest's "Marketing Ideas" section
// (see marketing-performance-report.js). Deliberately reads back already-
// computed data (this week's marketing_segment_candidates scan, pending
// marketing_campaigns rows) rather than running identifySegment() live
// inside the time-sensitive 12:45pm report send — segment identification is
// SA/Supabase-heavy and runs separately via the marketing_segment_scan cron
// job (6:00 AM Monday, well ahead of this report).

import { supabase, mondayOf } from './ar-report-helpers.js';
import { logger } from '../../core/logger.js';

export async function gatherWeeklyMarketingIdeas() {
  try {
    const weekStart = mondayOf();

    const [candidatesResult, campaignsResult] = await Promise.all([
      supabase
        .from('marketing_segment_candidates')
        .select('service_category, client_name, ambiguity_flag')
        .gte('scan_run_at', `${weekStart}T00:00:00Z`),
      supabase
        .from('marketing_campaigns')
        .select('id, campaign_name, description, client_count, created_at')
        .eq('status', 'proposed')
        .order('created_at', { ascending: false }),
    ]);

    if (candidatesResult.error) throw candidatesResult.error;
    if (campaignsResult.error) throw campaignsResult.error;

    const candidates = candidatesResult.data ?? [];
    const byCategory = new Map();
    for (const c of candidates) {
      if (!byCategory.has(c.service_category)) byCategory.set(c.service_category, { clean: 0, flagged: 0 });
      const bucket = byCategory.get(c.service_category);
      if (c.ambiguity_flag) bucket.flagged++; else bucket.clean++;
    }

    return {
      available: true,
      weekStart,
      segmentsByCategory: [...byCategory.entries()].map(([serviceCategory, counts]) => ({ serviceCategory, ...counts })),
      pendingCampaigns: campaignsResult.data ?? [],
    };
  } catch (err) {
    logger.warn('gatherWeeklyMarketingIdeas: failed — section will show unavailable', { err: err.message });
    return { available: false, weekStart: mondayOf(), segmentsByCategory: [], pendingCampaigns: [], error: err.message };
  }
}
