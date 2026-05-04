// mcp/oauth.js
// Minimal OAuth 2.0 server for Claude.ai custom connector authentication.
// Single-user, static token — no real user login needed.
// Adds these routes to bot.js:
//   GET  /oauth/authorize  — redirect with code
//   POST /oauth/token      — exchange code for access token
//
// Add to bot.js imports:
//   import { handleOAuthAuthorize, handleOAuthToken } from '../mcp/oauth.js';
//
// Add to bot.js routes (before 404):
//   if (req.method === 'GET' && req.url?.startsWith('/oauth/authorize')) { await handleOAuthAuthorize(req, res); return; }
//   if (req.method === 'POST' && req.url === '/oauth/token') { await handleOAuthToken(req, res); return; }

import crypto from 'crypto';
import { logger } from '../core/logger.js';

// These are set by Michael in Claude.ai connector settings
// and must match what we configure here
const OAUTH_CLIENT_ID     = process.env.OAUTH_CLIENT_ID     || 'jrb-agent-claude';
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || process.env.CLAUDE_EXECUTE_SECRET;
const EXECUTE_SECRET      = process.env.CLAUDE_EXECUTE_SECRET;
const PUBLIC_URL          = process.env.TEAMS_PUBLIC_URL     || 'https://agent.jrboehlke.com';

// Short-lived auth codes (code → expiry)
const authCodes = new Map();
export const dynamicClients = new Map(); // populated by /register

// ── GET /oauth/authorize ──────────────────────────────────────────────────────
// Claude.ai redirects the user here to start OAuth.
// Since this is single-user, we immediately issue a code and redirect back.
export async function handleOAuthAuthorize(req, res) {
  const url = new URL(req.url, PUBLIC_URL);
  const redirectUri = url.searchParams.get('redirect_uri');
  const state       = url.searchParams.get('state');
  const clientId    = url.searchParams.get('client_id');

  if (clientId !== OAUTH_CLIENT_ID && !dynamicClients.has(clientId)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Unknown client_id');
    return;
  }

  if (!redirectUri) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing redirect_uri');
    return;
  }

  // Issue a one-time auth code valid for 60 seconds
  const code = crypto.randomBytes(16).toString('hex');
  authCodes.set(code, { expiry: Date.now() + 60_000, redirectUri });
  logger.info('[oauth] Auth code issued', { code: code.slice(0, 8) });

  // Show a simple approval page — single click to authorize
  const approveUrl = `${PUBLIC_URL}/oauth/approve?code=${code}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state || '')}`;

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!DOCTYPE html>
<html>
<head><title>JRB Agent — Authorize Claude.ai</title>
<style>
  body { font-family: monospace; background: #0a0a0a; color: #e0e0e0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .box { background: #111; border: 1px solid #333; border-radius: 8px; padding: 32px 40px; max-width: 400px; text-align: center; }
  h2 { color: #00cc66; margin-bottom: 8px; }
  p { color: #888; font-size: 13px; margin-bottom: 24px; }
  a.btn { display: inline-block; background: #00cc66; color: #000; font-weight: bold; padding: 12px 28px; border-radius: 4px; text-decoration: none; font-size: 14px; }
  a.btn:hover { background: #00aa55; }
</style>
</head>
<body>
<div class="box">
  <h2>JRB Agent</h2>
  <p>Claude.ai is requesting access to your agent.<br>Click below to authorize.</p>
  <a class="btn" href="${approveUrl}">Authorize Claude.ai</a>
</div>
</body>
</html>`);
}

// ── GET /oauth/approve ────────────────────────────────────────────────────────
// Michael clicks "Authorize" — we redirect back to Claude.ai with the code.
export async function handleOAuthApprove(req, res) {
  const url         = new URL(req.url, PUBLIC_URL);
  const code        = url.searchParams.get('code');
  const redirectUri = url.searchParams.get('redirect_uri');
  const state       = url.searchParams.get('state');

  if (!code || !authCodes.has(code)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid or expired code');
    return;
  }

  const entry = authCodes.get(code);
  if (Date.now() > entry.expiry) {
    authCodes.delete(code);
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Code expired — please try connecting again');
    return;
  }

  logger.info('[oauth] Approved — redirecting to Claude.ai', { code: code.slice(0, 8) });

  const dest = `${redirectUri}?code=${code}${state ? `&state=${encodeURIComponent(state)}` : ''}`;
  res.writeHead(302, { Location: dest });
  res.end();
}

// ── POST /oauth/token ─────────────────────────────────────────────────────────
// Claude.ai exchanges the auth code for an access token.
export async function handleOAuthToken(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = new URLSearchParams(Buffer.concat(chunks).toString());

  const grantType    = body.get('grant_type');
  const code         = body.get('code');
  const clientId     = body.get('client_id');
  const clientSecret = body.get('client_secret');
  const codeVerifier = body.get('code_verifier');
  logger.info('[oauth] Token body', { clientId, grantType, hasSecret: !!clientSecret, hasVerifier: !!codeVerifier, isDynamic: dynamicClients.has(clientId), clientCount: dynamicClients.size });

  // Validate client — accept static or dynamically registered clients
  const isDynamic = dynamicClients.has(clientId);

  if (!isDynamic && clientId !== OAUTH_CLIENT_ID) {
    logger.warn('[oauth] Token request with invalid client credentials');
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_client' }));
    return;
  }
  // For static client without PKCE, also check secret
  if (!isDynamic && !codeVerifier && clientSecret !== OAUTH_CLIENT_SECRET) {
    logger.warn('[oauth] Token request with invalid client secret');
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_client' }));
    return;
  }

  if (grantType === 'authorization_code') {
    if (!authCodes.has(code)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant' }));
      return;
    }
    authCodes.delete(code);
  } else if (grantType !== 'client_credentials') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
    return;
  }

  // Issue the access token — we use the EXECUTE_SECRET as the token itself
  // so the MCP server can validate it directly
  logger.info('[oauth] Access token issued');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    access_token: process.env.CLAUDE_EXECUTE_SECRET || 'jrb-mcp-token-2026',
    token_type: 'Bearer',
    expires_in: 7776000,
    scope: 'mcp',
    resource: 'https://agent.jrboehlke.com/mcp4',
  }));
}


// ── GET /.well-known/oauth-authorization-server ──────────────────────────────
export async function handleOAuthWellKnown(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    issuer: PUBLIC_URL,
    authorization_endpoint: `${PUBLIC_URL}/authorize`,
    token_endpoint: `${PUBLIC_URL}/token`,
    registration_endpoint: `${PUBLIC_URL}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    scopes_supported: ['mcp'],
  }));
}

// ── POST /register — dynamic client registration (RFC 7591) ──────────────────
export async function handleOAuthRegister(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  let body = '';
  req.on('data', d => body += d);
  await new Promise(r => req.on('end', r));

  let parsed = {};
  try { parsed = JSON.parse(body); } catch { /* ignore */ }

  const clientId = `claude-${Math.random().toString(36).slice(2, 12)}`;
  const clientSecret = crypto.randomBytes(16).toString('hex');

  // Store in dynamic clients map for token validation
  dynamicClients.set(clientId, {
    clientSecret,
    redirectUris: parsed.redirect_uris || ['https://claude.ai/api/mcp/auth_callback'],
    createdAt: Date.now(),
  });

  logger.info('[oauth] Dynamic client registered', { clientId, clientName: parsed.client_name });

  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    client_name: parsed.client_name || 'Claude',
    redirect_uris: parsed.redirect_uris || ['https://claude.ai/api/mcp/auth_callback'],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
  }));
}
