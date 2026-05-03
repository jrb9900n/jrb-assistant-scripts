// tools/impl/github.js
import axios from 'axios';
import { logger } from '../../core/logger.js';

const GH_BASE = 'https://api.github.com';

function headers() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function repoPath(repo) {
  if (repo?.includes('/')) return repo;
  return `${process.env.GITHUB_ORG}/${repo ?? process.env.GITHUB_DEFAULT_REPO}`;
}

export async function pushFile({ repo, path, content, message, branch = 'main' }) {
  const fullRepo = repoPath(repo);
  const url = `${GH_BASE}/repos/${fullRepo}/contents/${path}`;

  // Check if file exists to get its SHA (required for updates)
  let sha;
  try {
    const existing = await axios.get(url, {
      params: { ref: branch },
      headers: headers(),
    });
    sha = existing.data.sha;
  } catch {
    // File doesn't exist yet — that's fine
  }

  const body = {
    message,
    content: Buffer.from(content).toString('base64'),
    branch,
    ...(sha ? { sha } : {}),
  };

  await axios.put(url, body, { headers: headers() });
  logger.info('GitHub file pushed', { repo: fullRepo, path, branch });
  return { pushed: true, repo: fullRepo, path, branch };
}

export async function readFile({ repo, path, branch = 'main' }) {
  const fullRepo = repoPath(repo);
  const res = await axios.get(
    `${GH_BASE}/repos/${fullRepo}/contents/${path}`,
    { params: { ref: branch }, headers: headers() }
  );
  const content = Buffer.from(res.data.content, 'base64').toString('utf8');
  return { path, content, sha: res.data.sha };
}
