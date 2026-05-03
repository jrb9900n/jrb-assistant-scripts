// core/agent.js — Main agent runner
// NOTE: No dotenv import. Secrets come from the OS environment,
// injected by launcher/start-agent.ps1 at startup.

import Anthropic from '@anthropic-ai/sdk';
import { logger, trackTokens } from './logger.js';
import { loadContext, saveMemory } from '../memory/memory.js';
import { getTools } from '../tools/registry.js';
import { dispatchTool } from '../tools/dispatcher.js';
import { randomUUID } from 'crypto';

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

function routeModel(taskPrompt, forceModel) {
    if (forceModel) return forceModel;
    const words = taskPrompt.split(/\s+/).length;
    const isComplex =
        words > HAIKU_THRESHOLD ||
        /analys|strateg|compar|synthesiz|report|draft email|write script|explain why/i.test(taskPrompt);
    return isComplex ? SONNET : HAIKU;
}

function buildSystemPrompt(memoryContext, taskType) {
    const now = new Date();
    return `You are an AI executive assistant for J.R. Boehlke, LLC. You are precise, concise, and action-oriented.
When asked to take action (send email, save file, run script), you call the appropriate tool immediately.
When asked for analysis, you provide a direct answer with supporting data — no filler.
When writing code or scripts, you write clean, well-commented, production-ready code.
You have access to: Microsoft 365 (email, calendar, OneDrive), QuickBooks, GitHub, and the local filesystem.

About J.R. Boehlke, LLC: Michael Boehlke is the owner and operator of J.R. Boehlke, LLC, an asphalt, concrete, and landscaping company. The business uses Service Autopilot for field operations, QuickBooks for accounting, and Microsoft 365 for communications.

Current date: ${now.toDateString()}
Current time: ${now.toLocaleTimeString()}
Current task type: ${taskType}
${memoryContext}`.trim();
}

export async function runAgent({
    task, taskType = 'general', model: forceModel,
    systemPromptOverride, extraMessages = [], saveContext = true,
}) {
    const runId = randomUUID();
    const model = routeModel(task, forceModel);
    logger.info('Agent run started', { runId, taskType, model, task: task.slice(0, 80) });

    const memoryContext = await loadContext({ topic: taskType });
    const tools = getTools(taskType);
    const messages = [...extraMessages, { role: 'user', content: task }];
    const systemPrompt = systemPromptOverride ?? buildSystemPrompt(memoryContext, taskType);

    let totalInput = 0, totalOutput = 0, finalText = '';

    while (true) {
        const response = await anthropic.messages.create({
            model,
            max_tokens: model === SONNET
                ? parseInt(process.env.MAX_TOKENS_SONNET ?? '4096')
                : parseInt(process.env.MAX_TOKENS_HAIKU ?? '1024'),
            system: systemPrompt, tools, messages,
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
    if (saveContext) saveMemory({ messages, topic: taskType, runId }).catch(err => logger.warn('Memory save failed', { err: err.message }));
    return { result: finalText, messages, usage: { input: totalInput, output: totalOutput, model } };
}
