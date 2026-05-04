// mcp/server.js — JRB Agent MCP server
// Uses @modelcontextprotocol/sdk StreamableHTTPServerTransport
// REBUILT 2026-05-04 — restart-resilient: auto-recovers sessions after pm2 restart

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

function buildMcpServer() {
  const server = new McpServer({ name: 'jrb-agent', version: '1.0.0' });

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
        const text = typeof result === 'string' ? result : (result?.result || result?.response || result?.text || JSON.stringify(result));
        return { content: [{ type: 'text', text: text }] };
      } catch (err) {
        logger.error('MCP run_task error', { err: err.message });
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool('get_status', 'Get the current status of the JRB Agent — uptime, loaded tools, and basic health info.', {}, async () => {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ status: 'ok', agent: 'JRB Executive Agent', uptime_seconds: Math.floor(process.uptime()), timestamp: new Date().toISOString(), node_version: process.version }, null, 2),
      }],
    };
  });

  return server;
}

function isAuthorized(req) {
  if (!MCP_TOKEN) return true;
  const auth = req.headers['authorization'];
  if (!auth) return false;
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  return token === MCP_TOKEN;
}

// Create a new transport+server session and store it
async function createSession(sessionId) {
  const id = sessionId || randomUUID();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => id,
    onsessioninitialized: (sid) => {
      transports.set(sid, transport);
      logger.info('MCP session initialized', { sessionId: sid });
    },
  });
  transport.onclose = () => {
    transports.delete(id);
    logger.info('MCP session closed', { sessionId: id });
  };
  const server = buildMcpServer();
  await server.connect(transport);
  return transport;
}

export async function handleMcpRequest(req, res) {
  if (!isAuthorized(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
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

      const sessionId = req.headers['mcp-session-id'];

      if (sessionId && transports.has(sessionId)) {
        // Known session — use existing transport
        await transports.get(sessionId).handleRequest(req, res, message);
      } else if (isInitializeRequest(message)) {
        // New session — initialize
        const transport = await createSession(null);
        await transport.handleRequest(req, res, message);
      } else if (sessionId) {
        // RESTART RECOVERY: Claude.ai has an old session ID but server restarted.
        // Re-create the session with the same ID so Claude.ai doesn't need to reconnect.
        logger.info('MCP session recovery after restart', { sessionId });
        const transport = await createSession(sessionId);
        transports.set(sessionId, transport);
        await transport.handleRequest(req, res, message);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No session — send initialize first' }));
      }

    } else if (req.method === 'GET') {
      const sessionId = req.headers['mcp-session-id'];
      if (!sessionId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No mcp-session-id header' }));
        return;
      }
      if (!transports.has(sessionId)) {
        // Recovery: create session for GET too
        logger.info('MCP GET session recovery', { sessionId });
        const transport = await createSession(sessionId);
        transports.set(sessionId, transport);
        await transport.handleRequest(req, res);
      } else {
        await transports.get(sessionId).handleRequest(req, res);
      }

    } else if (req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id'];
      if (sessionId && transports.has(sessionId)) {
        await transports.get(sessionId).close();
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
