// voice/realtime-bridge.js — entry point for the live voice-call bridge.
// Run via: node voice/realtime-bridge.js (env vars set by hand for local
// testing, or via launcher/start-agent.ps1's "voice" mode once that change
// is reviewed and merged separately -- see docs in the PR description).
//
// Owns two things: the Event Grid webhook (ACS call events, including the
// required SubscriptionValidationEvent echo-back handshake) and the
// WebSocket upgrade endpoint ACS's media-streaming connects to. All
// business logic lives in acs-call-handler.js / openai-realtime-client.js /
// tool-bridge.js -- this file is wiring only.
//
// createVoiceBridgeServer() is exported (not just auto-started) so
// test/voice/fake-acs-media-server.mjs can run the real server in-process
// against a synthetic ACS connection, with zero Azure dependency.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { logger } from '../core/logger.js';
import { handleIncomingCallEvent, handleCallbackEvent, attachAcsMediaSocket } from './acs-call-handler.js';

const DEFAULT_PORT = process.env.VOICE_BRIDGE_PORT || 3979;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : []);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function createVoiceBridgeServer() {
  const server = http.createServer(async (req, res) => {
    const url = req.url?.split('?')[0];

    if (req.method === 'GET' && url === '/voice/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }

    if (req.method === 'POST' && url === '/voice/events') {
      let events;
      try {
        events = await readJsonBody(req);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }

      for (const evt of Array.isArray(events) ? events : [events]) {
        // Event Grid's one-time subscription-validation handshake: must be
        // answered synchronously with the echoed validation code, HTTP 200,
        // before any real events will ever be delivered to this endpoint.
        if (evt.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ validationResponse: evt.data?.validationCode }));
          return;
        }

        try {
          if (evt.eventType === 'Microsoft.Communication.IncomingCall') {
            await handleIncomingCallEvent(evt);
          } else {
            await handleCallbackEvent(evt);
          }
        } catch (err) {
          logger.error('Voice bridge: error handling event', { eventType: evt.eventType, err: err.message });
        }
      }

      res.writeHead(200);
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = req.url?.split('?')[0];
    if (url !== '/voice-media') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachAcsMediaSocket(ws, req.headers);
    });
  });

  return server;
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  const server = createVoiceBridgeServer();
  server.listen(DEFAULT_PORT, () => logger.info(`Voice bridge listening on :${DEFAULT_PORT}`));

  process.on('unhandledRejection', (err) => {
    logger.error('Voice bridge: unhandled rejection', { err: err?.message ?? err });
  });
}
