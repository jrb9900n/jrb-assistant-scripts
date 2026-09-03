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

// These task types always use Sonnet — they involve writing, analysis, or multi-step work.
// 'general' and 'calendar' added 2026-08-26: 'general' is both the largest
// catch-all bucket (anything that doesn't trip a routing keyword) AND the
// widest tool bucket in tools/registry.js's TOOL_MAP -- the exact kind of
// broad, judgment-heavy request ("remember what we talked about", "check
// three systems and cross-reference") that most needs Sonnet's reasoning and
// 16k output budget was instead falling to Haiku's keyword-regex heuristic
// and 1k output cap by default. 'calendar' had the same gap -- confirmed live
// 2026-08-24 (see CLAUDE.md's "Bug #4") that a calendar-modifying request
// reached Haiku and gave false information because it never actually used
// its tools carefully. 'dev_ambiguous' added alongside the fix that made it
// call runAgent() at all (see tools/registry.js's TOOL_MAP.dev_ambiguous) --
// its whole job is asking one well-judged clarifying question, not a task
// where the cheap model's shallower reasoning is an acceptable tradeoff.
// 'marketing' (built 2026-08-25) drafts campaign/re-engagement content --
// writing quality matters the same way it does for 'email'/'report'.
// 'employee' (built 2026-08-24) is the non-Michael Teams requester path --
// its system prompt gives a strict, narrow instruction ("never explain, just
// call request_employee_approval") specifically so an unverified sender can
// never talk the model into revealing private data or claiming a gated
// action succeeded. Confirmed live 2026-08-27: omitted from this set, a
// follow-up message in that same conversation fell to Haiku's keyword
// heuristic (no complexity keyword tripped) and didn't follow that
// instruction -- it fabricated its own ad hoc "prove your identity" demand
// instead of calling the tool again, a challenge nothing in the codebase can
// actually satisfy. This is exactly the failure mode 'general'/'calendar'/
// 'dev_ambiguous' were added to prevent above, just missed for this
// taskType since it shipped the same day as that investigation.
const SONNET_TASK_TYPES = new Set(['scheduling', 'code', 'report', 'email', 'file', 'crm', 'auto_fix', 'general', 'calendar', 'dev_ambiguous', 'marketing', 'employee']);

// Maps the shorthand model aliases stored in agent_library.model ('sonnet' |
// 'haiku' | null, see agents/library.js's AgentDefinition typedef) to the
// real Anthropic model ID strings routeModel/anthropic.messages.create()
// actually need. Exported specifically for agents/library.js's
// runSavedAgent(), which used to pass the alias straight through as
// runAgent()'s `model` (forceModel) param -- routeModel returns forceModel
// verbatim when it's truthy (see below), so a saved agent with model:
// 'sonnet' sent the literal string "sonnet" to the Anthropic API as the
// `model` field and 404'd on every call. Any value already spelled as a real
// model ID (or anything else routeModel/the caller wants to force verbatim)
// passes through unchanged; null/undefined passes through as undefined so
// routeModel falls back to its normal taskType/keyword-based routing instead
// of forcing anything.
export function resolveModelAlias(alias) {
  if (!alias) return undefined;
  if (alias === 'sonnet') return SONNET;
  if (alias === 'haiku') return HAIKU;
  return alias;
}

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
        /\b(invoice|payment|schedule|invoice|quickbooks|hubspot|calendar|block|conflict)\b/i.test(taskPrompt) ||
        // Prefix match (no trailing \b) -- "Estimating" (this system's actual
        // block-schedule name) doesn't contain the complete word "estimate",
        // so a \b-wrapped "estimate" alternative never matched it. Confirmed
        // live 2026-08-24: "Estimating 9am; then HR" routed to Haiku instead
        // of Sonnet for a real calendar-modifying request (creating two
        // events plus checking for conflicts), which the cheap model got
        // wrong -- it never actually read Michael's calendar before claiming
        // "completely clear."
        /\bestimat/i.test(taskPrompt);
    return isComplex ? SONNET : HAIKU;
}

async function buildSystemPrompt(memoryContext, taskType) {
  const rulesAndPatterns = await buildContextBlock(taskType);
  return `You are an AI executive assistant for J.R. Boehlke, LLC (JRB Boehlke LLC), an asphalt, concrete, landscape, and snow contractor in southeast Wisconsin and metro Milwaukee. Michael Reardon is the owner and your primary user.

## Your role
You help Michael manage every hat he wears: bookkeeping, finance, operations, scheduling, invoicing, project management, estimating, marketing, and systems. Be his most capable employee.

## Who you're talking to
In Teams, the person messaging you is almost always Michael himself (see the sender-identity check for the one exception). When he says "I"/"me"/"my" — including "my inbox," "my email," "emails I received" — he means himself, not you. His mailbox is michael@jrboehlke.com; assistant@jrboehlke.com is your own separate operational mailbox (used for automated processing, Chase alerts, etc.), not his. Never tell Michael you can't access "his" inbox/calendar/OneDrive — you can, via the same tools, by targeting his address instead of the default.

## How you work
- When asked to DO something, do it immediately using your tools. Never ask clarifying questions for executable tasks.
- When asked to BUILD something (code, scripts, reports), confirm scope in 1-2 sentences then execute.
- When asked for information or analysis, answer directly with data. No filler, no preamble.
- You have judgment. Make reasonable assumptions and state them briefly rather than asking for clarification.

## Tools you have
- **Microsoft 365**: read/send email, calendar, OneDrive files, for ANY mailbox in the tenant — pass userEmail (e.g. michael@jrboehlke.com for Michael's own inbox/calendar; defaults to your own assistant@jrboehlke.com mailbox when omitted). For "what did I get today"/"anything I need to reply to" about Michael's own inbox specifically, prefer get_email_triage (already-processed/categorized) over a raw list_emails call.
- **QuickBooks**: invoices, payments, AR aging, cash flow (realm: 9130357265584656)
- **Service Autopilot**: jobs, estimates, scheduling, crew, customers
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

## Code/repo/infra writes and real-money ad-spend changes require Michael's confirmation
Some tools (write_file, run_script, github_push, github_merge_pr, vercel_api's write actions, and google_ads_pause_keyword/google_ads_enable_keyword/google_ads_adjust_campaign_budget) require Michael's explicit confirmation before they run — calling one of these returns \`{pendingApproval: true, message}\` instead of actually executing. That means the action did NOT happen. Never tell Michael it succeeded, or move on as if it's done — relay the tool result's message to him verbatim (it tells him exactly how to confirm) and stop there. This applies on every channel, including voice — on a call, be plain that a code/infra change or ad-spend change can't happen live and will need his confirmation over Teams afterward.

## Current context
Date/time: ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })}
Task type: ${taskType}

${memoryContext}${rulesAndPatterns}`.trim();
}

export async function runAgent({
    task, taskType = 'general', model: forceModel,
    systemPromptOverride, extraMessages = [], saveContext = true, images = [],
    context = null,
}) {
    // `context` (added 2026-08-24) is a TRUSTED side-channel passed straight
    // through to every dispatchTool() call this run makes — never exposed to
    // the LLM as a tool parameter, never derived from tool_use input. Exists
    // specifically so a tool handler can know things like "who is actually
    // asking" (see teams/identity.js's resolveSender + tools/impl/
    // privacy-gate.js's requestEmployeeApproval) without that identity ever
    // being something the model could spoof by producing convenient JSON.
    const runId = randomUUID();
    // Model routing/logging/observation all key off the text prompt alone --
    // routeModel does word-count + keyword regexes, neither of which knows
    // what to do with an image block, so `task` stays a plain string
    // throughout; only the actual message content sent to the API changes
    // shape when images are attached.
    const model = routeModel(task, forceModel, taskType);
    logger.info('Agent run started', { runId, taskType, model, task: task.slice(0, 80), images: images.length });

    const memoryContext = await loadContext({ topic: taskType });
    const tools = getTools(taskType);
    const userContent = images.length
        ? [{ type: 'text', text: task }, ...images.map(img => ({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
          }))]
        : task;
    const messages = [...extraMessages, { role: 'user', content: userContent }];
    const systemPrompt = systemPromptOverride ?? await buildSystemPrompt(memoryContext, taskType);

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
                try { result = await dispatchTool(toolUse.name, toolUse.input, context); }
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

    // Slice off extraMessages (prior turns loaded for short-term conversation
    // context) so saveMemory only summarizes what happened in *this* run --
    // otherwise every call re-ingests and re-summarizes turns already
    // captured in earlier agent_memory rows, wasting tokens and compounding
    // redundant summaries that loadContext later re-injects.
    if (saveContext) saveMemory({ messages: messages.slice(extraMessages.length), topic: taskType, runId }).catch(err => logger.warn('Memory save failed', { err: err.message }));
    return { result: finalText, messages, usage: { input: totalInput, output: totalOutput, model } };
}
