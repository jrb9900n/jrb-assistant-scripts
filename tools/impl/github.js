// tools/impl/github.js
// GitHub API tool — read, write, branch, PR, merge operations
// All operations are scoped to approved repos only.

import { logger } from '../../core/logger.js';

const GH_BASE = 'https://api.github.com';

const APPROVED_REPOS = [
  'jrb-assistant-scripts',
  'FleetOps',
  'FieldOps',
  'AuditMatchingEngine',
];

function ghHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

// Resolve repo to full owner/repo format and validate it's approved
function resolveRepo(repo) {
  const username = process.env.GITHUB_USERNAME ?? 'jrb9900n';

  // Already in owner/repo format
  if (repo?.includes('/')) {
    const name = repo.split('/')[1];
    if (!APPROVED_REPOS.includes(name)) {
      throw new Error(`Repo "${repo}" is not in the approved list: ${APPROVED_REPOS.join(', ')}`);
    }
    return repo;
  }

  // Just a repo name — prepend username
  const name = repo ?? 'jrb-assistant-scripts';
  if (!APPROVED_REPOS.includes(name)) {
    throw new Error(`Repo "${name}" is not in the approved list: ${APPROVED_REPOS.join(', ')}`);
  }
  return `${username}/${name}`;
}

async function ghFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...ghHeaders(), ...(options.headers ?? {}) },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API error ${res.status} at ${url}: ${body.slice(0, 300)}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── Read a file ───────────────────────────────────────────────────────────────

export async function readFile({ repo, path, branch = 'main' }) {
  const fullRepo = resolveRepo(repo);
  const data = await ghFetch(
    `${GH_BASE}/repos/${fullRepo}/contents/${path}?ref=${branch}`
  );
  const content = Buffer.from(data.content, 'base64').toString('utf8');
  logger.info('GitHub file read', { repo: fullRepo, path, branch });
  return { path, content, sha: data.sha, repo: fullRepo, branch };
}

// ── List files in a directory ─────────────────────────────────────────────────

export async function listFiles({ repo, path = '', branch = 'main' }) {
  const fullRepo = resolveRepo(repo);
  const data = await ghFetch(
    `${GH_BASE}/repos/${fullRepo}/contents/${path}?ref=${branch}`
  );
  const items = Array.isArray(data) ? data : [data];
  logger.info('GitHub files listed', { repo: fullRepo, path, branch, count: items.length });
  return {
    repo: fullRepo,
    path,
    branch,
    items: items.map(i => ({ name: i.name, path: i.path, type: i.type, size: i.size })),
  };
}

// ── Push (create or update) a file ───────────────────────────────────────────

export async function pushFile({ repo, path, content, message, branch = 'main' }) {
  const fullRepo = resolveRepo(repo);

  // Refuse direct pushes to main — enforce branch workflow
  if (branch === 'main') {
    throw new Error(
      `Direct pushes to main are not allowed. Create a branch first using github_create_branch, ` +
      `then push to that branch and open a PR.`
    );
  }

  const url = `${GH_BASE}/repos/${fullRepo}/contents/${path}`;

  // Get existing SHA if file already exists (required for updates)
  let sha;
  try {
    const existing = await ghFetch(`${url}?ref=${branch}`);
    sha = existing.sha;
  } catch {
    // File doesn't exist yet — that's fine
  }

  const body = {
    message,
    content: Buffer.from(content).toString('base64'),
    branch,
    ...(sha ? { sha } : {}),
  };

  await ghFetch(url, { method: 'PUT', body: JSON.stringify(body) });
  logger.info('GitHub file pushed', { repo: fullRepo, path, branch });
  return { pushed: true, repo: fullRepo, path, branch };
}

// ── Create a branch ───────────────────────────────────────────────────────────

export async function createBranch({ repo, branch, from_branch = 'main' }) {
  const fullRepo = resolveRepo(repo);

  // Enforce claude/ prefix naming convention
  if (!branch.startsWith('claude/')) {
    throw new Error(
      `Branch name must start with "claude/" (e.g. "claude/my-feature"). Got: "${branch}"`
    );
  }

  // Get SHA of the source branch
  const ref = await ghFetch(`${GH_BASE}/repos/${fullRepo}/git/ref/heads/${from_branch}`);
  const sha = ref.object.sha;

  await ghFetch(`${GH_BASE}/repos/${fullRepo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  });

  logger.info('GitHub branch created', { repo: fullRepo, branch, from_branch });
  return { created: true, repo: fullRepo, branch, from_branch, sha };
}

// ── Get SHA of latest commit on a branch ─────────────────────────────────────

export async function getBranchSha({ repo, branch = 'main' }) {
  const fullRepo = resolveRepo(repo);
  const ref = await ghFetch(`${GH_BASE}/repos/${fullRepo}/git/ref/heads/${branch}`);
  return { repo: fullRepo, branch, sha: ref.object.sha };
}

// ── Open a Pull Request ───────────────────────────────────────────────────────

export async function openPR({ repo, title, body, branch, base = 'main' }) {
  const fullRepo = resolveRepo(repo);

  if (!branch.startsWith('claude/')) {
    throw new Error(`PRs must come from a "claude/" branch. Got: "${branch}"`);
  }

  const pr = await ghFetch(`${GH_BASE}/repos/${fullRepo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ title, body, head: branch, base }),
  });

  logger.info('GitHub PR opened', { repo: fullRepo, pr: pr.number, title });
  return {
    opened: true,
    repo: fullRepo,
    pr_number: pr.number,
    pr_url: pr.html_url,
    title: pr.title,
    branch,
    base,
  };
}

// ── Merge a Pull Request ──────────────────────────────────────────────────────
// Only called after explicit approval from Michael.

export async function mergePR({ repo, pr_number, merge_message }) {
  const fullRepo = resolveRepo(repo);

  await ghFetch(`${GH_BASE}/repos/${fullRepo}/pulls/${pr_number}/merge`, {
    method: 'PUT',
    body: JSON.stringify({
      commit_title: merge_message ?? `Merge PR #${pr_number}`,
      merge_method: 'merge',
    }),
  });

  logger.info('GitHub PR merged', { repo: fullRepo, pr_number });
  return { merged: true, repo: fullRepo, pr_number };
}

// ── List open PRs ─────────────────────────────────────────────────────────────

export async function listPRs({ repo, state = 'open' }) {
  const fullRepo = resolveRepo(repo);
  const prs = await ghFetch(`${GH_BASE}/repos/${fullRepo}/pulls?state=${state}`);
  logger.info('GitHub PRs listed', { repo: fullRepo, state, count: prs.length });
  return {
    repo: fullRepo,
    prs: prs.map(p => ({
      number: p.number,
      title: p.title,
      branch: p.head.ref,
      state: p.state,
      url: p.html_url,
      created: p.created_at,
    })),
  };
}
