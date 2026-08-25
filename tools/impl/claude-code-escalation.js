// tools/impl/claude-code-escalation.js — escalates a Teams task the normal
// runAgent()/TOOL_MAP loop can't complete out to a full headless Claude Code
// invocation, gated on Michael's explicit yes/no. Built 2026-08-25 after a
// live incident: Michael asked to void a misprinted QBO check, runAgent had
// no tool for it, and resolving it actually took broader tool orchestration
// (searching Supabase, writing a standing rule directly) than any single
// taskType's fixed TOOL_MAP grants.
//
// Same pending-request/yes-reply shape as privacy-gate.js's employee
// approval flow, just triggered by the model itself (via the
// escalate_to_claude_code tool, see tools/registry.js) instead of by
// requester identity.
//
// Deliberately scoped, not a general-purpose shell-out: the escalated
// process gets --tools "" (no Bash/Read/Edit/Write at all) and MCP access
// to exactly three tools on JRBAgent's own already-running MCP server
// (run_task, get_status, save_standing_rule — see mcp/server.js). That
// reproduces the two things that actually resolved the check-1732 incident
// (a broader run_task call, and writing a standing rule directly) without
// handing an unattended process shell/filesystem access to a production
// machine off a single Teams "yes". Read/Grep/Glob repo access is a
// plausible future addition, deliberately left out of this first version —
// see PR description.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync, mkdtempSync, rmdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { logger } from '../../core/logger.js';
import { sendProactiveMessage } from '../../teams/notify.js';

const execFileAsync = promisify(execFile);

function supabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

const CLAUDE_BIN = process.env.CLAUDE_CLI_PATH || 'claude';
const MCP_PORT = process.env.TEAMS_PORT ?? '3978';
const MCP_TOKEN = process.env.CLAUDE_MCP_TOKEN || process.env.CLAUDE_EXECUTE_SECRET;
const ALLOWED_TOOLS = 'mcp__jrb-agent__run_task,mcp__jrb-agent__get_status,mcp__jrb-agent__save_standing_rule';
// Hard wall-clock cap so a stuck/looping escalation can't run forever on an
// unattended machine — generous (most run_task calls are well under a
// minute) but bounded.
const ESCALATION_TIMEOUT_MS = 8 * 60 * 1000;
const ESCALATION_MAX_BUDGET_USD = process.env.ESCALATION_MAX_BUDGET_USD ?? '3';
// A pending escalation Michael never explicitly answered (moved on to
// something else, or replied in a way isApprovalReply doesn't parse as
// yes/no) shouldn't linger forever -- found live 2026-08-24/25: three
// separate unrelated pending rows piled up in one evening's conversation,
// all silently waiting to turn his next actual "yes" into a confusing "you
// have 3 pending escalations, which one?" prompt. Auto-deny anything this
// stale before creating a new one for the same conversation.
const STALE_PENDING_MS = 30 * 60 * 1000;

// ── Called from the escalate_to_claude_code tool handler (dispatcher.js) ───
// context (sender, activity, sessionId) comes from the TRUSTED context
// object threaded through core/agent.js -> tools/dispatcher.js — same
// pattern as privacy-gate.js's requestEmployeeApproval.
export async function requestEscalation({ activity, sessionId, task, taskType, reason }) {
  const db = supabase();

  const staleCutoff = new Date(Date.now() - STALE_PENDING_MS).toISOString();
  const { error: expireError } = await db
    .from('claude_code_escalations')
    .update({ status: 'denied', resolved_at: new Date().toISOString() })
    .eq('session_id', sessionId)
    .eq('status', 'pending')
    .lt('created_at', staleCutoff);
  if (expireError) {
    logger.warn('claude-code-escalation: stale-pending cleanup failed (non-fatal)', { err: expireError.message });
  }

  const { data: row, error } = await db
    .from('claude_code_escalations')
    .insert({
      session_id: sessionId,
      conversation_id: activity.conversation.id,
      service_url: activity.serviceUrl,
      task,
      task_type: taskType,
      reason,
    })
    .select('*')
    .single();

  if (error) {
    logger.error('claude-code-escalation: could not create pending request', { err: error.message });
    return "I can't do this with my current tools, and couldn't even queue an escalation request — something's wrong on my end.";
  }

  logger.info('claude-code-escalation: pending escalation created', { id: row.id, taskType, reason: reason.slice(0, 120) });

  return `I can't do this with my current tools: ${reason}\n\nWant me to escalate this to Claude Code for a deeper attempt? Reply yes/no.`;
}

// ── Called from teams/bot.js for every message from Michael, before normal
// intent routing — same slot/shape as privacy-gate.js's
// resolvePendingApprovalReply, a fast no-op (one Supabase query) for the
// overwhelming majority of messages that aren't a reply to a pending
// escalation. ──────────────────────────────────────────────────────────────
export async function resolvePendingEscalationReply(michaelText) {
  const db = supabase();
  const { data: pending, error } = await db
    .from('claude_code_escalations')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error) {
    logger.warn('claude-code-escalation: pending-requests query failed', { err: error.message });
    return null;
  }
  if (!pending.length) return null;

  const { isApprovalReply } = await import('../../teams/router.js');

  if (pending.length > 1) {
    const { decision } = isApprovalReply(michaelText);
    if (!decision) return null; // not decision-shaped -- let it flow through normally
    const list = pending.map((r, i) => `${i + 1}. [${r.task_type}] "${r.task}" -- ${r.reason}`).join('\n');
    return { replyToMichael: `You have ${pending.length} pending escalations — which one?\n\n${list}\n\nReply with the number.` };
  }

  const row = pending[0];
  const { decision } = isApprovalReply(michaelText);
  if (!decision) return null;

  if (decision === 'denied') {
    await db.from('claude_code_escalations').update({ status: 'denied', resolved_at: new Date().toISOString() }).eq('id', row.id);
    return { replyToMichael: "Got it — won't escalate that." };
  }

  await db.from('claude_code_escalations').update({ status: 'approved', resolved_at: new Date().toISOString() }).eq('id', row.id);

  // Fire-and-forget: runEscalatedClaudeCode reports its own result back via
  // sendProactiveMessage once it finishes, same pattern as
  // privacy-gate.js's fulfillApprovedRequest. Not awaited here -- Michael
  // shouldn't wait on the Teams request/response cycle for a multi-minute
  // Claude Code run.
  runEscalatedClaudeCode(row).catch(err =>
    logger.error('claude-code-escalation: runEscalatedClaudeCode failed', { id: row.id, err: err.message })
  );

  return { replyToMichael: "Approved — escalating to Claude Code now. I'll follow up here when it's done." };
}

async function runEscalatedClaudeCode(row) {
  if (!MCP_TOKEN) {
    await sendProactiveMessage(`⚠️ Escalation for "${row.task}" couldn't run — no CLAUDE_MCP_TOKEN/CLAUDE_EXECUTE_SECRET configured, so the escalated session has no way to reach JRBAgent's own tools.`);
    return;
  }

  const workDir = mkdtempSync(path.join(tmpdir(), 'jrb-escalation-'));
  const mcpConfigPath = path.join(workDir, 'mcp-config.json');
  writeFileSync(mcpConfigPath, JSON.stringify({
    mcpServers: {
      'jrb-agent': {
        type: 'http',
        url: `http://localhost:${MCP_PORT}/mcp`,
        headers: { Authorization: `Bearer ${MCP_TOKEN}` },
      },
    },
  }));

  const prompt = `Michael's JRB Teams assistant couldn't complete this task with its normal tools and escalated it to you for a deeper attempt.\n\nTask: ${row.task}\n\nReason it couldn't be completed normally: ${row.reason}\n\nYou have exactly three tools: run_task (the same agent, but you can pick any taskType and phrase the task however gets the best result — try a different taskType or framing than what presumably already failed), get_status, and save_standing_rule (use this if you land on a durable fix/procedure Michael shouldn't have to re-explain next time). You have no filesystem or shell access. If you genuinely cannot complete this with these tools either, say so plainly and explain what would be needed instead of guessing. End with a concise summary of what you did and the outcome — this is sent to Michael verbatim.`;

  logger.info('claude-code-escalation: launching escalated Claude Code run', { id: row.id, taskType: row.task_type });

  let outcome;
  try {
    const { stdout } = await execFileAsync(CLAUDE_BIN, [
      '-p', prompt,
      '--mcp-config', mcpConfigPath,
      '--strict-mcp-config',
      '--tools', '',
      '--allowedTools', ALLOWED_TOOLS,
      '--output-format', 'json',
      '--max-budget-usd', String(ESCALATION_MAX_BUDGET_USD),
      '--no-session-persistence',
    ], {
      cwd: workDir,
      timeout: ESCALATION_TIMEOUT_MS,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        APPDATA: process.env.APPDATA,
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        USERPROFILE: process.env.USERPROFILE,
        HOMEDRIVE: process.env.HOMEDRIVE,
        HOMEPATH: process.env.HOMEPATH,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      },
      maxBuffer: 10 * 1024 * 1024,
    });

    const parsed = JSON.parse(stdout);
    outcome = parsed.is_error
      ? `Escalation ran but reported an error: ${parsed.result || 'unknown error'}`
      : (parsed.result || '(no result text returned)');
    logger.info('claude-code-escalation: run complete', { id: row.id, costUsd: parsed.total_cost_usd, isError: parsed.is_error });
  } catch (err) {
    // execFile throws on non-zero exit, on timeout (err.killed), and on a
    // stdout parse failure -- all three are real outcomes worth reporting to
    // Michael rather than swallowing, since this whole flow exists so he's
    // never left wondering whether something quietly failed.
    outcome = err.killed
      ? `Escalation timed out after ${Math.round(ESCALATION_TIMEOUT_MS / 60000)} minutes without finishing.`
      : `Escalation failed to run: ${err.message}`;
    logger.error('claude-code-escalation: run errored', { id: row.id, err: err.message });
  } finally {
    try { unlinkSync(mcpConfigPath); } catch {}
    try { rmdirSync(workDir); } catch {}
  }

  await supabase().from('claude_code_escalations').update({ result: outcome }).eq('id', row.id);
  await sendProactiveMessage(`Claude Code escalation result for "${row.task}":\n\n${outcome}`);
}
