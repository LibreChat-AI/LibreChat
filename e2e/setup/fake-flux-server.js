/**
 * Black Forest Labs (BFL) HTTP fixture for the Flux tool scenarios. The mock harness points
 * `FLUX_API_BASE_URL` here, and the fake model asks for an image with a prompt of
 * `flux-e2e:<mode>:<label>`, so each task picks how this endpoint behaves:
 *
 * - `polling`: like the global `api.bfl.ai`, the task lives on a cluster path returned as
 *   `polling_url`, and `/v1/get_result` on the base answers 404 for it.
 * - `legacy`: no `polling_url`; the result is only served from `/v1/get_result`.
 * - `foreign`: the `polling_url` names another origin (`localhost` rather than `127.0.0.1`),
 *   which the tool must not send its key to; `/v1/get_result` serves the result.
 *
 * Every request is recorded with its path, host and whether it carried the API key, so a
 * spec asserts where the key went rather than only that an image rendered.
 */
const http = require('http');

const PORT = Number(process.env.E2E_FLUX_PORT) || 8794;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const FOREIGN_ORIGIN = `http://localhost:${PORT}`;
const CLUSTER_PATH = '/cluster/v1/get_result';

/** 8x8 opaque PNG, enough for the browser to decode the image. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4o6aGFTEMLQkAF/tKAS/fz4YAAAAASUVORK5CYII=',
  'base64',
);

/** id -> { mode, label } */
const tasks = new Map();
/** { label, method, path, host, hasKey } in arrival order. */
const requests = [];
let taskCount = 0;

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => resolve(raw));
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function parsePrompt(prompt) {
  const match = /flux-e2e:(polling|legacy|foreign):([A-Za-z0-9._-]+)/.exec(prompt ?? '');
  return match ? { mode: match[1], label: match[2] } : { mode: 'legacy', label: 'unlabeled' };
}

function readyResult(id) {
  return { id, status: 'Ready', result: { sample: `${ORIGIN}/samples/${id}.png` } };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const id = url.searchParams.get('id') ?? '';
  const task = tasks.get(id);
  if (url.pathname !== '/' && url.pathname !== '/__requests') {
    requests.push({
      label: task?.label ?? null,
      method: req.method,
      path: url.pathname,
      host: req.headers.host ?? '',
      hasKey: Boolean(req.headers['x-key']),
    });
  }

  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/__requests') {
    const label = url.searchParams.get('label');
    return send(res, 200, { requests: requests.filter((entry) => entry.label === label) });
  }

  if (req.method === 'POST' && url.pathname.startsWith('/v1/')) {
    const raw = await readBody(req);
    let prompt = '';
    try {
      prompt = JSON.parse(raw).prompt;
    } catch {
      return send(res, 422, { detail: 'invalid json' });
    }
    const { mode, label } = parsePrompt(prompt);
    const taskId = `task-${label}-${++taskCount}`;
    tasks.set(taskId, { mode, label });
    requests[requests.length - 1].label = label;
    if (mode === 'legacy') {
      return send(res, 200, { id: taskId });
    }
    const origin = mode === 'foreign' ? FOREIGN_ORIGIN : ORIGIN;
    return send(res, 200, { id: taskId, polling_url: `${origin}${CLUSTER_PATH}?id=${taskId}` });
  }

  if (req.method === 'GET' && url.pathname === CLUSTER_PATH && task) {
    return send(res, 200, readyResult(id));
  }

  if (req.method === 'GET' && url.pathname === '/v1/get_result' && task) {
    if (task.mode === 'polling') {
      return send(res, 404, { detail: 'Task not found' });
    }
    return send(res, 200, readyResult(id));
  }

  if (req.method === 'GET' && url.pathname.startsWith('/samples/')) {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(PNG);
  }

  return send(res, 404, { detail: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[fake-flux] listening on ${ORIGIN}`);
});
