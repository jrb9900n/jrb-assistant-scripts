import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export async function logObservation({ agentName, actionTaken, sender, subject, patternMatched, rawContext }) {
  const { error } = await supabase.from('knowledge_log').insert({
    agent_name: agentName, action_taken: actionTaken,
    sender: sender || null, subject: subject || null,
    pattern_matched: patternMatched || null, raw_context: rawContext || null,
  });
  if (error) console.error('[feedback] logObservation error:', error.message);
}

export async function logFeedback({ logId, feedbackText, agentName }) {
  await supabase.from('knowledge_log')
    .update({ feedback: feedbackText, feedback_at: new Date().toISOString() })
    .eq('id', logId);
  const { error } = await supabase.from('rules').insert({
    agent: agentName || 'general', rule: feedbackText,
  });
  if (error) console.error('[feedback] logFeedback error:', error.message);
  else console.log('[feedback] Rule written from correction.');
}

export async function getRulesForAgent(agentName) {
  const { data, error } = await supabase.from('rules')
    .select('rule, agent')
    .in('agent', [agentName, 'general', 'all'])
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) { console.error('[feedback] getRulesForAgent error:', error.message); return []; }
  return data || [];
}

export async function getPatternsForAgent(agentName) {
  const { data, error } = await supabase.from('patterns')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) { console.error('[feedback] getPatternsForAgent error:', error.message); return []; }
  return data || [];
}

export async function buildContextBlock(agentName) {
  const [rules, patterns] = await Promise.all([getRulesForAgent(agentName), getPatternsForAgent(agentName)]);
  const lines = [];
  if (rules.length > 0) {
    lines.push("## Active Rules (from Michael's corrections)");
    rules.forEach(r => lines.push(`- ${r.rule}`));
  }
  if (patterns.length > 0) {
    lines.push('\n## Learned Patterns');
    patterns.forEach(p => lines.push(`- ${JSON.stringify(p)}`));
  }
  if (lines.length === 0) return '';
  return '\n\n' + lines.join('\n') + '\n\n';
}

export async function runWeeklySynthesis() {
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: observations, error } = await supabase.from('knowledge_log')
    .select('*').gte('created_at', oneWeekAgo).order('created_at', { ascending: true });
  if (error || !observations?.length) { console.log('[synthesis] No observations to synthesize.'); return; }
  console.log(`[synthesis] Synthesizing ${observations.length} observations...`);
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 2000,
      system: 'You are a pattern synthesis engine. Return ONLY a JSON array, no preamble, no markdown. Each object: { agent_name, pattern_type ("skip"|"escalate"|"flag"|"routine"|"auto_reply"), description, match_criteria: { sender_contains?, subject_contains? }, confidence (0-1) }. Only include patterns seen 3+ times, confidence >= 0.7.',
      messages: [{ role: 'user', content: JSON.stringify(observations) }]
    })
  });
  const result = await response.json();
  const rawText = result.content?.find(b => b.type === 'text')?.text || '[]';
  let newPatterns;
  try { newPatterns = JSON.parse(rawText.replace(/```json|```/g, '').trim()); }
  catch (e) { console.error('[synthesis] Parse error:', e.message); return; }
  let written = 0;
  for (const p of (newPatterns || [])) {
    await supabase.from('patterns').insert({
      agent_name: p.agent_name, pattern_type: p.pattern_type, description: p.description,
      match_criteria: p.match_criteria || {}, confidence: p.confidence || 0.7,
      source: 'weekly_synthesis', active: true,
    });
    written++;
  }
  await supabase.from('synthesis_log').insert({
    observations_read: observations.length, patterns_written: written,
    patterns_updated: 0, patterns_retired: 0,
    summary: `Synthesized ${written} patterns from ${observations.length} observations.`
  });
  console.log(`[synthesis] Done. ${written} patterns written.`);
}
