// mcp/server.js — JRB Agent MCP server
// Uses @modelcontextprotocol/sdk StreamableHTTPServerTransport
// Single endpoint: POST/GET /mcp  (mounted by bot.js)
// Auth: static Bearer token from env CLAUDE_MCP_TOKEN
//
// REBUILT 2026-05-04 — clean SDK-based implementation

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
import { runAgent } from '../core/agent.js';
import { logger } from '../core/logger.js';
import { z } from 'zod';

const MCP_TOKEN = process.env.CLAUDE_MCP_TOKEN || process.env.CLAUDE_EXECUTE_SECRET;

// Session store: sessionId → transport
const transports = new Map();

// ── Build the MCP server with tools ──────────────────────────────────────────
function buildMcpServer() {
  const server = new McpServer({
    name: 'jrb-agent',
    version: '1.0.0',
  });

  // Tool: run_task
  server.tool(
    'run_task',
    'Run any task on the JRB Executive Agent — email triage, QuickBooks reports, Service Autopilot data, GitHub operations, Vercel deployments, calendar events, or any business question. Returns the agent response as a string.',
    {
      task: z.string().describe('The task or question to run. Be specific.'),
      task_type: z.enum(['general', 'finance', 'ops', 'dev']).optional().describe('Task category for model routing. Defaults to general.'),
    },
    async ({ task, task_type }) => {
      logger.info('MCP run_task', { task: task.slice(0, 80), task_type });
      try {
        const result = await runAgent({ task, taskType: task_type || 'general' });
        return {
          content: [{ type: 'text', text: result }],
        };
      } catch (err) {
        logger.error('MCP run_task error', { err: err.message });
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: get_status
  server.tool(
    'get_status',
    'Get the current status of the JRB Agent — uptime, loaded tools, and basic health info.',
    {},
    async () => {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'ok',
            agent: 'JRB Executive Agent',
            uptime_seconds: Math.floor(process.uptime()),
            timestamp: new Date().toISOString(),
            node_version: process.version,
          }, null, 2),
        }],
      };
    }
  );

  return server;
}

// ── Auth check ────────────────────────────────────────────────────────────────
function isAuthorized(req) {
  if (!MCP_TOKEN) return true; // no token configured = open (dev mode)
  const auth = req.headers['authorization'];
  if (!auth) return false;
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  return token === MCP_TOKEN;
}

// ── Main request handler (called by bot.js for /mcp) ─────────────────────────
export async function handleMcpRequest(req, res) {
  // Auth
  if (!isAuthorized(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized', hint: 'Provide Authorization: Bearer <CLAUDE_MCP_TOKEN>' }));
    return;
  }

  try {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      await new Promise(r => req.on('end', r));

      let message;
      try { message = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      // New session or existing session
      const sessionId = req.headers['mcp-session-id'];

      if (!sessionId || !transports.has(sessionId)) {
        // Must be an initialize request to start a new session
        if (!isInitializeRequest(message)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No session — send initialize first' }));
          return;
        }

        const newSessionId = randomUUID();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          onsessioninitialized: (id) => {
            transports.set(id, transport);
            logger.info('MCP session initialized', { sessionId: id });
          },
        });

        // Clean up on close
        transport.onclose = () => {
          transports.delete(newSessionId);
          logger.info('MCP session closed', { sessionId: newSessionId });
        };

        const server = buildMcpServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, message);
        return;
      }

      // Existing session
      const transport = transports.get(sessionId);
      await transport.handleRequest(req, res, message);

    } else if (req.method === 'GET') {
      // SSE stream for existing session
      const sessionId = req.headers['mcp-session-id'];
      if (!sessionId || !transports.has(sessionId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No session — POST initialize first' }));
        return;
      }
      const transport = transports.get(sessionId);
      await transport.handleRequest(req, res);

    } else if (req.method === 'DELETE') {
      // Session teardown
      const sessionId = req.headers['mcp-session-id'];
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId);
        await transport.close();
        transports.delete(sessionId);
        logger.info('MCP session deleted', { sessionId });
      }
      res.writeHead(200); res.end('OK');

    } else {
      res.writeHead(405); res.end('Method not allowed');
    }
  } catch (err) {
    logger.error('MCP handler error', { err: err.message, stack: err.stack });
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }
}
