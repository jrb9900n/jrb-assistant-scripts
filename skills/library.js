// skills/library.js — Reusable task template store
//
// A "skill" is a parameterised task template — like a macro.
// Unlike agents (which carry personality/system prompts), skills
// are just task strings with {{VARIABLE}} placeholders.
//
// Example:
//   Skill "weekly-report" has task: "Pull CRM data for {{PERIOD}} and..."
//   You call it with vars: { PERIOD: 'this week' }
//
// Skills and agents compose:
//   runSkillWithAgent({ skill: 'weekly-report', agent: 'crm-analyst', vars: {...} })

import { createClient } from '@supabase/supabase-js';
import { logger } from '../core/logger.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── CRUD ──────────────────────────────────────────────────────

/**
 * Save or update a skill.
 * @param {object} skill
 * @param {string}   skill.name        - Unique slug
 * @param {string}   skill.description - What it does
 * @param {string}   skill.task        - Task template with {{VARIABLE}} tokens
 * @param {string}   skill.taskType    - Routing hint
 * @param {string[]} [skill.tags]
 * @param {object}   [skill.defaultVars]
 */
export async function saveSkill(skill) {
  const { name, description, task, taskType, tags = [], defaultVars = {} } = skill;

  const { error } = await supabase.from('skill_library').upsert({
    name,
    description,
    task,
    task_type: taskType,
    tags,
    default_vars: defaultVars,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'name' });

  if (error) throw new Error(`Failed to save skill "${name}": ${error.message}`);
  logger.info('Skill saved', { name });
  return { saved: true, name };
}

/**
 * Load a skill by name.
 */
export async function loadSkill(name) {
  const { data, error } = await supabase
    .from('skill_library')
    .select('*')
    .eq('name', name)
    .single();

  if (error || !data) throw new Error(`Skill "${name}" not found.`);

  return {
    name:        data.name,
    description: data.description,
    task:        data.task,
    taskType:    data.task_type,
    tags:        data.tags,
    defaultVars: data.default_vars,
  };
}

/**
 * List all skills, optionally filtered by tag.
 */
export async function listSkills({ tag } = {}) {
  let query = supabase
    .from('skill_library')
    .select('name, description, task_type, tags, updated_at')
    .order('name');

  if (tag) query = query.contains('tags', [tag]);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to list skills: ${error.message}`);
  return data;
}

// ── Compose: skill + agent ────────────────────────────────────

/**
 * Run a skill using a named agent.
 * Interpolates variables, loads the agent's system prompt, and runs.
 *
 * @param {object} opts
 * @param {string} opts.skill   - Skill name
 * @param {string} opts.agent   - Agent name (from agent library)
 * @param {object} [opts.vars]  - Variable overrides
 */
export async function runSkillWithAgent({ skill: skillName, agent: agentName, vars = {} }) {
  const { runSavedAgent } = await import('../agents/library.js');
  const skill = await loadSkill(skillName);

  const allVars = { ...skill.defaultVars, ...vars };
  let task = skill.task;
  for (const [k, v] of Object.entries(allVars)) {
    task = task.replaceAll(`{{${k}}}`, v);
  }

  return runSavedAgent({ agentName, task, vars: {} });
}

/**
 * Run a skill directly (without a named agent — uses auto-routing).
 * @param {object} opts
 * @param {string} opts.skill  - Skill name
 * @param {object} [opts.vars] - Variable overrides
 */
export async function runSkill({ skill: skillName, vars = {} }) {
  const { runAgent } = await import('../core/agent.js');
  const skill = await loadSkill(skillName);

  const allVars = { ...skill.defaultVars, ...vars };
  let task = skill.task;
  for (const [k, v] of Object.entries(allVars)) {
    task = task.replaceAll(`{{${k}}}`, v);
  }

  return runAgent({ task, taskType: skill.taskType });
}
