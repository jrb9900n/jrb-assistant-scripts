// core/agent.js â€” Main agent runner
// NOTE: No dotenv import. Secrets come from the OS environment,
// injected by launcher/start-agent.ps1 at startup.

import Anthropic from '@anthropic-ai/sdk';
import { logger, trackTokens } from './logger.js';
import { loadContext, saveMemory } from '../memory/memory.js';
import { getTools } from '../tools/registry.js';
import { dispatchTool } from '../tools/dispatcher.js';
import { randomUUID } from 'crypto';
import { buildContextBlock, logObservation, runWeeklySynthesis } from '../tools/impl/feedback.js';

const REQUIRED_ENV = [
    'ANTHROPIC_API_KEY',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_KEY',
    'M365_TENANT_ID',
    'M365_CLIENT_ID',
    'M365_CLIENT_SECRET',
];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
    console.error(`\n[FATAL] Missing environment variables: ${missing.join(', ')}\nStart the agent via launcher/start-agent.ps1, not directly.\n`);
    process.exit(1);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const SONNET = 'claude-sonnet-4-6';
const HAIKU  = 'claude-haiku-4-5-20251001';
const HAIKU_THRESHOLD = parseInt(process.env.HAIKU_THRESHOLD ?? '500');

// These task types always use Sonnet — they involve writing, analysis, or multi-step work
const SONNET_TASK_TYPES = new Set(['scheduling', 'code', 'report', 'email', 'file', 'crm']);

function routeModel(taskPrompt, forceModel, taskType) {
    if (forceModel) return forceModel;
    if (SONNET_TASK_TYPES.has(taskType)) return SONNET;
    const words = taskPrompt.split(/\s+/).length;
    const isComplex =
        words > HAIKU_THRESHOLD ||
        // Writing / saving anything
        /\b(write|draft|save|upload|create|generate|compose|summarize|reply|send)\b/i.test(taskPrompt) ||
        // Code or file operations
        /\b(commit|push|deploy|build|implement|refactor|debug|patch|script|function)\b/i.test(taskPrompt) ||
        // Analysis or multi-step reasoning
        /\b(analys|strateg|compar|synthesiz|report|forecast|explain why|plan|review)\b/i.test(taskPrompt) ||
        // Anything touching external systems with side effects
        /\b(invoice|payment|schedule|estimate|quickbooks|hubspot)\b/i.test(taskPrompt);
    return isComplex ? SONNET : HAIKU;
}

async function buildSystemPrompt(memoryContext, rulesAndPatterns, taskType) {
  return `You are an AI executive assistant for J.R. Boehlke, LLC (JRB Boehlke LLC), an asphalt, concrete, landscape, and snow contractor in southeast Wisconsin and metro Milwaukee. Michael Boehlke is the owner and your primary user.

## Your role
You help Michael manage every hat he wears: bookkeeping, finance, operations, scheduling, invoicing, project management, estimating, marketing, and systems. Be his most capable employee.

## How you work
- When asked to DO something, do it immediately using your tools. Never ask clarifying questions for executable tasks.
- When asked to BUILD something (code, scripts, reports), confirm scope in 1-2 sentences then execute.
- When asked for information or analysis, answer directly with data. No filler, no preamble.
- You have judgment. Make reasonable assumptions and state them briefly rather than asking for clarification.

## Tools you have
- **Microsoft 365**: read/send email (assistant@jrboehlke.com), calendar, OneDrive files
- **QuickBooks**: invoices, payments, AR aging, cash flow (realm: 9130357265584656)
- **Service Autopilot**: jobs, estimates, scheduling, crew, customers
- **CardDAV contacts**: provision/revoke employee access to JRB contacts on their phone (carddav_provision, carddav_revoke, carddav_list)
- **GitHub**: read/write code in jrb-assistant-scripts, FleetOps, FieldOps repos
- **Vercel**: deploy FleetOps (prj_83cd6Wmn2WWW79uO7N6mFKd1BcFF) and FieldOps (prj_0YjCwD9qpI0uRLMqFz9OGL9aVX6b)
- **Supabase**: jrb-assistant DB (znpahinyplccdyoekfeo) for agent memory, feedback loop, config; fleetops DB (mzywmgesulyalevtzudw) for SA/QB sync data
- **Web search**: current information, research
- **Local filesystem**: read/write files at C:\\Users\\Assistant\\JRBAgent\\
- **Scripts**: run Node.js and Python scripts locally

## API tokens (retrieve from Supabase config table)
- GITHUB_READONLY_TOKEN: read access to jrb-assistant-scripts
- VERCEL_TOKEN: full Vercel account access (team: team_oquyk1BQkSEyHjqJlHK0aF9E)

## Email rules
- Outbound: only send to michael@jrboehlke.com unless explicitly told otherwise
- Inbound non-promotional: flag for Michael, never auto-reply

## Current context
Date/time: ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })}
Task type: ${taskType}

${memoryContext}${rulesAndPatterns ?? ''}`.trim();
}

export async function runAgent({
    task, taskType = 'general', model: forceModel,
    systemPromptOverride, extraMessages = [], saveContext = true,
}) {
    const runId = randomUUID();
    const model = routeModel(task, forceModel, taskType);
    logger.info('Agent run started', { runId, taskType, model, task: task.slice(0, 80) });

    const tools = getTools(taskType);
    const messages = [...extraMessages, { role: 'user', content: task }];
    let systemPrompt;
    if (systemPromptOverride) {
        systemPrompt = systemPromptOverride;
    } else {
        const [memoryContext, rulesAndPatterns] = await Promise.all([
            loadContext({ topic: taskType }),
            buildContextBlock(taskType),
        ]);
        systemPrompt = await buildSystemPrompt(memoryContext, rulesAndPatterns, taskType);
    }

    let totalInput = 0, totalOutput = 0, finalText = '';

    // Cache system prompt + tools to reduce input tokens (cached reads count ~1/10th toward rate limits)
    const cachedSystem = [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
    const cachedTools = tools.length > 0
        ? [...tools.slice(0, -1), { ...tools[tools.length - 1], cache_control: { type: 'ephemeral' } }]
        : tools;

    while (true) {
        const response = await anthropic.messages.create({
            model,
            max_tokens: model === SONNET
                ? parseInt(process.env.MAX_TOKENS_SONNET ?? '16000')
                : parseInt(process.env.MAX_TOKENS_HAIKU ?? '1024'),
            system: cachedSystem, tools: cachedTools, messages,
        });

        totalInput  += response.usage.input_tokens;
        totalOutput += response.usage.output_tokens;
        messages.push({ role: 'assistant', content: response.content });

        if (response.stop_reason === 'end_turn') {
            finalText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
            break;
        }

        if (response.stop_reason === 'tool_use') {
            const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
            const toolResults = await Promise.all(toolUseBlocks.map(async (toolUse) => {
                logger.info('Tool call', { tool: toolUse.name, runId });
                let result;
                try { result = await dispatchTool(toolUse.name, toolUse.input); }
                catch (err) { logger.error('Tool error', { tool: toolUse.name, err: err.message }); result = { error: err.message }; }
                return { type: 'tool_result', tool_use_id: toolUse.id, content: typeof result === 'string' ? result : JSON.stringify(result) };
            }));
            messages.push({ role: 'user', content: toolResults });
            continue;
        }
        logger.warn('Unexpected stop_reason', { stop_reason: response.stop_reason });
        break;
    }

    await trackTokens({ task: taskType, model, input: totalInput, output: totalOutput, runId });
    logger.info('Agent run complete', { runId, totalTokens: totalInput + totalOutput, model });
    // Feedback loop: log this agent action to knowledge_log
    logObservation({
      agentName: taskType,
      actionTaken: finalText.slice(0, 500),
      rawContext: task.slice(0, 300),
    }).catch(err => logger.warn('logObservation failed', { err: err.message }));

    if (saveContext) saveMemory({ messages, topic: taskType, runId }).catch(err => logger.warn('Memory save failed', { err: err.message }));
    return { result: finalText, messages, usage: { input: totalInput, output: totalOutput, model } };
}
