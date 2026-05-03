// agents/library.js — Persistent named sub-agent store
//
// A "saved agent" is a reusable configuration: a system prompt,
// a preferred model, a task type, and optional tool overrides.
// Agents are stored in Supabase and loaded by name at runtime.
//
// Usage:
//   await saveAgent({ name: 'invoice-chaser', ... })
//   const agent = await loadAgent('invoice-chaser')
//   await runAgent({ ...agent, task: 'Chase all invoices > 30 days' })

import { createClient } from '@supabase/supabase-js';
import { logger } from '../core/logger.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Types (JSDoc) ─────────────────────────────────────────────
/**
 * @typedef {object} AgentDefinition
 * @property {string}   name          - Unique identifier (slug format, e.g. 'invoice-chaser')
 * @property {string}   description   - What this agent does (shown in listings)
 * @property {string}   systemPrompt  - The agent's personality/instructions
 * @property {string}   [model]       - 'haiku' | 'sonnet' (default: auto-routed)
 * @property {string}   taskType      - 'email'|'crm'|'report'|'code'|'file'|'general'
 * @property {string[]} [tags]        - e.g. ['finance', 'automated']
 * @property {object}   [defaultVars] - Default variable values for template tasks
 */

// ── CRUD ──────────────────────────────────────────────────────

/**
 * Save or update a named agent in the library.
 * @param {AgentDefinition} agentDef
 */
export async function saveAgent(agentDef) {
  const { name, description, systemPrompt, model, taskType, tags = [], defaultVars = {} } = agentDef;

  const { error } = await supabase.from('agent_library').upsert({
    name,
    description,
    system_prompt: systemPrompt,
    model: model ?? null,
    task_type: taskType,
    tags,
    default_vars: defaultVars,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'name' });

  if (error) throw new Error(`Failed to save agent "${name}": ${error.message}`);
  logger.info('Agent saved', { name, taskType });
  return { saved: true, name };
}

/**
 * Load a named agent from the library.
 * @param {string} name
 * @returns {Promise<AgentDefinition>}
 */
export async function loadAgent(name) {
  const { data, error } = await supabase
    .from('agent_library')
    .select('*')
    .eq('name', name)
    .single();

  if (error || !data) throw new Error(`Agent "${name}" not found in library.`);

  return {
    name:         data.name,
    description:  data.description,
    systemPrompt: data.system_prompt,
    model:        data.model,
    taskType:     data.task_type,
    tags:         data.tags,
    defaultVars:  data.default_vars,
  };
}

/**
 * List all agents in the library.
 * @param {object} [opts]
 * @param {string} [opts.tag] - Filter by tag
 */
export async function listAgents({ tag } = {}) {
  let query = supabase
    .from('agent_library')
    .select('name, description, task_type, tags, updated_at')
    .order('name');

  if (tag) {
    query = query.contains('tags', [tag]);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to list agents: ${error.message}`);
  return data;
}

/**
 * Delete a named agent.
 * @param {string} name
 */
export async function deleteAgent(name) {
  const { error } = await supabase.from('agent_library').delete().eq('name', name);
  if (error) throw new Error(`Failed to delete agent "${name}": ${error.message}`);
  logger.info('Agent deleted', { name });
  return { deleted: true, name };
}

// ── Run a saved agent ─────────────────────────────────────────

/**
 * Load a named agent and run it with a task.
 * Variables in the task string ({{VAR}}) are interpolated from vars + defaultVars.
 *
 * @param {object} opts
 * @param {string} opts.agentName   - Name of the saved agent
 * @param {string} opts.task        - Task prompt (may contain {{VARIABLE}} tokens)
 * @param {object} [opts.vars]      - Variable values to interpolate into the task
 * @param {boolean} [opts.saveContext]
 */
export async function runSavedAgent({ agentName, task, vars = {}, saveContext = true }) {
  const { runAgent } = await import('../core/agent.js');
  const agentDef = await loadAgent(agentName);

  // Interpolate variables
  const allVars = { ...agentDef.defaultVars, ...vars };
  let resolvedTask = task;
  for (const [k, v] of Object.entries(allVars)) {
    resolvedTask = resolvedTask.replaceAll(`{{${k}}}`, v);
  }

  return runAgent({
    task: resolvedTask,
    taskType: agentDef.taskType,
    model: agentDef.model,
    systemPromptOverride: agentDef.systemPrompt,
    saveContext,
  });
}
