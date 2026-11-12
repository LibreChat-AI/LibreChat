/**
 * HTTPS fixture standing in for a GitHub Enterprise Server host, for the pull request scenarios.
 *
 * The mock config points `endpoints.agents.pullRequests.host` at `localhost:<port>`, so the
 * server's GitHub source sends every request of a lookup to `/api/v3` here, over TLS with the
 * self-signed certificate `playwright.config.mock.ts` generates and hands the app server through
 * `NODE_EXTRA_CA_CERTS`. It serves one repository with one open pull request per branch named in
 * `PULLS`, and records what it was asked so a scenario can prove which host a lookup reached.
 *
 * `GET /__requests` lists the recorded requests (method, path, whether a bearer token came with
 * it); `POST /__reset` clears them. Neither is under `/api/v3`, so a lookup never reaches them.
 */
const fs = require('fs');
const https = require('https');

const PORT = Number(process.env.E2E_GIT_HOST_PORT) || 8793;
const HOST = `localhost:${PORT}`;
const REPO = 'e2e-org/e2e-app';
const API_PREFIX = '/api/v3';

/** One open pull request per branch; the scenarios record the same head on their lane. */
const PULLS = {
  'feat/enterprise-header': {
    number: 7,
    title: 'Enterprise header pull request',
    sha: 'a'.repeat(40),
  },
  'feat/override-ignored': {
    number: 8,
    title: 'Override ignored pull request',
    sha: 'b'.repeat(40),
  },
};

const requests = [];

const byNumber = (number) =>
  Object.entries(PULLS).find(([, pull]) => pull.number === number) ?? null;

function listItem([, pull]) {
  return { number: pull.number, state: 'open', head: { sha: pull.sha } };
}

function detail([branch, pull]) {
  return {
    number: pull.number,
    title: pull.title,
    html_url: `https://${HOST}/${REPO}/pull/${pull.number}`,
    state: 'open',
    merged: false,
    draft: false,
    additions: 12,
    deletions: 3,
    mergeable: true,
    head: { sha: pull.sha, ref: branch, repo: { full_name: REPO } },
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function route(url) {
  const repoBase = `${API_PREFIX}/repos/${REPO}`;
  if (!url.pathname.startsWith(repoBase)) return null;
  const rest = url.pathname.slice(repoBase.length);
  if (rest === '/pulls') {
    const state = url.searchParams.get('state');
    const headFilter = url.searchParams.get('head') ?? '';
    const branch = headFilter.slice(headFilter.indexOf(':') + 1);
    const pull = PULLS[branch];
    return [200, state === 'open' && pull != null ? [listItem([branch, pull])] : []];
  }
  const pullMatch = /^\/pulls\/(\d+)$/.exec(rest);
  if (pullMatch) {
    const found = byNumber(Number(pullMatch[1]));
    return found ? [200, detail(found)] : [404, { message: 'Not Found' }];
  }
  if (/^\/commits\/[a-f0-9]{40}\/check-runs$/.test(rest)) {
    return [200, { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success' }] }];
  }
  if (/^\/commits\/[a-f0-9]{40}\/pulls$/.test(rest)) {
    return [200, []];
  }
  return null;
}

const server = https.createServer(
  {
    key: fs.readFileSync(process.env.E2E_GIT_HOST_KEY),
    cert: fs.readFileSync(process.env.E2E_GIT_HOST_CERT),
  },
  (req, res) => {
    const url = new URL(req.url ?? '/', `https://${HOST}`);
    if (url.pathname === '/') {
      send(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/__requests' && req.method === 'GET') {
      send(res, 200, requests);
      return;
    }
    if (url.pathname === '/__reset' && req.method === 'POST') {
      requests.length = 0;
      send(res, 200, { ok: true });
      return;
    }
    requests.push({
      method: req.method,
      path: `${url.pathname}${url.search}`,
      authorized: (req.headers.authorization ?? '').startsWith('Bearer '),
    });
    const answer = req.method === 'GET' ? route(url) : null;
    if (answer == null) {
      send(res, 404, { message: 'Not Found' });
      return;
    }
    send(res, answer[0], answer[1]);
  },
);

/** Every local address, since `localhost` may resolve to either family. */
server.listen(PORT, () => {
  console.log(`[fake-git-host] listening on https://${HOST}`);
});
