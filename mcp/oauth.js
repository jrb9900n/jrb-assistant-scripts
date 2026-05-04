// mcp/oauth.js - Persistent token storage via Supabase
// Tokens survive pm2 restarts — no manual reconnect needed after this.

import crypto from 'crypto';
import { logger } from '../core/logger.js';

const OAUTH_CLIENT_ID     = process.env.OAUTH_CLIENT_ID     || 'jrb-agent-claude';
const EXECUTE_SECRET      = process.env.CLAUDE_EXECUTE_SECRET;
const PUBLIC_URL          = process.env.TEAMS_PUBLIC_URL     || 'https://agent.jrboehlke.com';
const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_KEY        = process.env.SUPABASE_SERVICE_KEY;

const authCodes = new Map();
export const dynamicClients = new Map();

async function sbFetch(path, opts = {}) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    ...opts,
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation', ...(opts.headers || {}) },
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function saveToken(token, clientId) {
  try {
    await sbFetch('mcp_tokens?on_conflict=token', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ token, client_id: clientId, expires_at: new Date(Date.now() + 365*24*60*60*1000).toISOString(), active: true }),
    });
    logger.info('[oauth] Token persisted to Supabase', { clientId });
  } catch (err) {
    logger.warn('[oauth] Could not persist token', { err: err.message });
  }
}

export async function isValidToken(token) {
  if (EXECUTE_SECRET && token === EXECUTE_SECRET) return true;
  try {
    const rows = await sbFetch('mcp_tokens?token=eq.' + encodeURIComponent(token) + '&active=eq.true&select=token,expires_at');
    if (!Array.isArray(rows) || rows.length === 0) return false;
    const row = rows[0];
    if (row.expires_at && new Date(row.expires_at) < new Date()) return false;
    return true;
  } catch (err) {
    logger.warn('[oauth] Token DB check failed', { err: err.message });
    return false;
  }
}

export async function handleOAuthWellKnown(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ issuer: PUBLIC_URL, authorization_endpoint: PUBLIC_URL+'/authorize', token_endpoint: PUBLIC_URL+'/token', registration_endpoint: PUBLIC_URL+'/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none','client_secret_basic','client_secret_post'], scopes_supported: ['mcp'] }));
}

export async function handleOAuthRegister(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  let body = ''; req.on('data', d => body += d); await new Promise(r => req.on('end', r));
  let parsed = {}; try { parsed = JSON.parse(body); } catch {}
  const clientId = 'claude-' + Math.random().toString(36).slice(2, 12);
  const clientSecret = crypto.randomBytes(16).toString('hex');
  dynamicClients.set(clientId, { clientSecret, redirectUris: parsed.redirect_uris || ['https://claude.ai/api/mcp/auth_callback'], createdAt: Date.now() });
  logger.info('[oauth] Dynamic client registered', { clientId, clientName: parsed.client_name });
  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ client_id: clientId, client_secret: clientSecret, client_name: parsed.client_name||'Claude', redirect_uris: parsed.redirect_uris||['https://claude.ai/api/mcp/auth_callback'], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none', client_id_issued_at: Math.floor(Date.now()/1000), client_secret_expires_at: 0 }));
}

export async function handleOAuthAuthorize(req, res) {
  const url = new URL(req.url, PUBLIC_URL);
  const redirectUri = url.searchParams.get('redirect_uri') || 'https://claude.ai/api/mcp/auth_callback';
  const state = url.searchParams.get('state') || '';
  const code = crypto.randomBytes(4).toString('hex');
  authCodes.set(code, { expiry: Date.now() + 60_000, redirectUri });
  logger.info('[oauth] Auth code issued', { code: code.slice(0, 8) });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!DOCTYPE html><html><head><title>JRB Agent</title><style>body{font-family:sans-serif;max-width:400px;margin:80px auto;text-align:center}button{background:#2563eb;color:white;border:none;padding:12px 32px;border-radius:8px;font-size:16px;cursor:pointer}</style></head><body><h2>JRB Executive Agent</h2><p>Claude.ai is requesting access.</p><a href="/oauth/approve?code=' + code + '&redirect_uri=' + encodeURIComponent(redirectUri) + '&state=' + encodeURIComponent(state) + '"><button>Approve Access</button></a></body></html>');
}

export async function handleOAuthApprove(req, res) {
  const url = new URL(req.url, PUBLIC_URL);
  const code = url.searchParams.get('code');
  const redirectUri = url.searchParams.get('redirect_uri') || 'https://claude.ai/api/mcp/auth_callback';
  const state = url.searchParams.get('state') || '';
  if (!code || !authCodes.has(code)) { res.writeHead(400); res.end('Invalid code'); return; }
  authCodes.delete(code);
  authCodes.set(code, { expiry: Date.now() + 60_000, redirectUri });
  logger.info('[oauth] Approved', { code: code.slice(0, 8) });
  res.writeHead(302, { Location: redirectUri + '?code=' + code + '&state=' + state });
  res.end();
}

export async function handleOAuthToken(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  let raw = ''; req.on('data', d => raw += d); await new Promise(r => req.on('end', r));
  let body = {}; try { body = raw.includes('=') ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw); } catch {}
  const clientId = body.client_id || OAUTH_CLIENT_ID;
  const code = body.code;
  if (body.grant_type === 'authorization_code') {
    if (!code || !authCodes.has(code)) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'invalid_grant'})); return; }
    authCodes.delete(code);
  }
  const accessToken = EXECUTE_SECRET;
  await saveToken(accessToken, clientId);
  logger.info('[oauth] Access token issued and persisted');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ access_token: accessToken, token_type: 'Bearer', expires_in: 31536000, scope: 'mcp' }));
}

export const issuedTokens = new Map();
