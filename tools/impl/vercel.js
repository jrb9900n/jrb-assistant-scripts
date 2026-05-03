// tools/impl/vercel.js
// Vercel API tool — deploy, manage env vars, check deployments, add domains
// Token retrieved from Supabase config table at runtime.

import { createClient } from '@supabase/supabase-js';

const TEAM_ID = 'team_oquyk1BQkSEyHjqJlHK0aF9E';

const PROJECTS = {
  'fleet-ops':  'prj_83cd6Wmn2WWW79uO7N6mFKd1BcFF',
  'fleetops':   'prj_83cd6Wmn2WWW79uO7N6mFKd1BcFF',
  'fieldops':   'prj_0YjCwD9qpI0uRLMqFz9OGL9aVX6b',
  'field-ops':  'prj_0YjCwD9qpI0uRLMqFz9OGL9aVX6b',
};

async function getToken() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data, error } = await supabase.from('config').select('value').eq('key', 'VERCEL_TOKEN').single();
  if (error) throw new Error('Failed to get VERCEL_TOKEN: ' + error.message);
  return data.value;
}

function resolveProject(nameOrId) {
  if (nameOrId.startsWith('prj_')) return nameOrId;
  const id = PROJECTS[nameOrId.toLowerCase()];
  if (!id) throw new Error(`Unknown project "${nameOrId}". Known: ${Object.keys(PROJECTS).join(', ')}`);
  return id;
}

async function vercelFetch(path, token, method = 'GET', body = null) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://api.vercel.com${path}${sep}teamId=${TEAM_ID}`;
  const opts = { method, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: resp.ok, status: resp.status, data };
}

// ── Exported actions ──────────────────────────────────────────────────────────

export async function vercelApi({ action, project, domain, envKey, envValue, envTarget, deploymentId }) {
  const token = await getToken();

  switch (action) {

    case 'list_projects': {
      const r = await vercelFetch('/v9/projects', token);
      if (!r.ok) return { error: r.data };
      return r.data.projects.map(p => ({ name: p.name, id: p.id, url: p.alias?.[0]?.domain }));
    }

    case 'list_deployments': {
      const projectId = resolveProject(project);
      const r = await vercelFetch(`/v6/deployments?projectId=${projectId}&limit=5`, token);
      if (!r.ok) return { error: r.data };
      return r.data.deployments.map(d => ({ uid: d.uid, url: d.url, state: d.state, created: new Date(d.created).toLocaleString() }));
    }

    case 'get_deployment': {
      const r = await vercelFetch(`/v13/deployments/${deploymentId}`, token);
      if (!r.ok) return { error: r.data };
      return { uid: r.data.uid, url: r.data.url, state: r.data.readyState, created: new Date(r.data.createdAt).toLocaleString() };
    }

    case 'redeploy': {
      const projectId = resolveProject(project);
      // Get latest deployment to redeploy
      const latest = await vercelFetch(`/v6/deployments?projectId=${projectId}&limit=1`, token);
      if (!latest.ok || !latest.data.deployments?.length) return { error: 'No existing deployments found' };
      const lastDeploy = latest.data.deployments[0];
      const r = await vercelFetch(`/v13/deployments/${lastDeploy.uid}/redeploy`, token, 'POST', {});
      if (!r.ok) return { error: r.data };
      return { message: `Redeployment triggered for ${project}`, deploymentId: r.data.id, url: r.data.url };
    }

    case 'add_domain': {
      const projectId = resolveProject(project);
      const r = await vercelFetch(`/v10/projects/${projectId}/domains`, token, 'POST', { name: domain });
      if (!r.ok && r.status !== 409) return { error: r.data };
      if (r.status === 409) return { message: `Domain ${domain} already exists on ${project}` };
      const dns = r.data.verification?.length
        ? r.data.verification.map(v => `${v.type} ${v.domain} → ${v.value}`).join('; ')
        : `CNAME ${domain} → cname.vercel-dns.com`;
      return { message: `Domain ${domain} added to ${project}`, dns_records_needed: dns };
    }

    case 'list_domains': {
      const projectId = resolveProject(project);
      const r = await vercelFetch(`/v9/projects/${projectId}/domains`, token);
      if (!r.ok) return { error: r.data };
      return r.data.domains.map(d => ({ name: d.name, verified: d.verified, redirect: d.redirect }));
    }

    case 'set_env': {
      const projectId = resolveProject(project);
      const target = envTarget ? [envTarget] : ['production', 'preview'];
      const r = await vercelFetch(`/v9/projects/${projectId}/env`, token, 'POST', {
        key: envKey, value: envValue, type: 'encrypted', target
      });
      if (!r.ok) return { error: r.data };
      return { message: `Env var ${envKey} set on ${project} for ${target.join(', ')}` };
    }

    case 'get_env': {
      const projectId = resolveProject(project);
      const r = await vercelFetch(`/v9/projects/${projectId}/env`, token);
      if (!r.ok) return { error: r.data };
      return r.data.envs.map(e => ({ key: e.key, target: e.target, type: e.type }));
    }

    default:
      return { error: `Unknown action "${action}". Valid: list_projects, list_deployments, get_deployment, redeploy, add_domain, list_domains, set_env, get_env` };
  }
}
