#!/usr/bin/env node

/**
 * Fake code-execution API for mock e2e file-provisioning tests.
 *
 * Stands in for the LibreChat code sandbox that `@librechat/agents` reaches at
 * `LIBRECHAT_CODE_BASEURL`. It implements just enough of the real contract to
 * exercise the unified-upload provisioning paths end to end (real backend + DB)
 * without a live sandbox:
 *
 * - `POST /v1/upload`        — single-file provisioning (`uploadCodeEnvFile`).
 * - `POST /v1/upload/batch`  — batch provisioning (`batchUploadCodeEnvFiles`).
 * - `GET  /v1/files/:sid`    — session liveness (`checkSessionsAlive`).
 * - `POST /v1/exec`          — code execution (`execute_code` tool run).
 *
 * Uploads are grouped into a deterministic `storage_session_id` per `kind:id`,
 * mirroring codeapi's sessionKey bucketing so liveness checks resolve. Every
 * request is recorded and surfaced at `GET /__debug/uploads` so specs can assert
 * a file's bytes actually reached the code env, independent of the DB write.
 */

const http = require('http');
const busboy = require('busboy');
const { randomUUID } = require('crypto');

const PORT = parseInt(process.env.E2E_CODE_API_PORT || '8790', 10);
const HOST = '127.0.0.1';

/** @type {Map<string, Array<{ fileId: string; filename: string }>>} */
const sessions = new Map();
/** @type {Array<{ filename: string; kind: string; id: string; storage_session_id: string; fileId: string; apiKey: string; userId: string; bytes: number }>} */
const uploads = [];
/** @type {Array<{ lang: string; codeLength: number; fileCount: number }>} */
const execs = [];
/** @type {Map<string, { name: string; content: Buffer }>} */
const generated = new Map();

function sessionIdFor(kind, id) {
  return `sess-${kind || 'user'}-${id || 'anon'}`;
}

function recordUpload({ kind, id, filename, bytes, apiKey, userId }) {
  const storage_session_id = sessionIdFor(kind, id);
  const fileId = `fid-${randomUUID()}`;
  if (!sessions.has(storage_session_id)) {
    sessions.set(storage_session_id, []);
  }
  sessions.get(storage_session_id).push({ fileId, filename });
  uploads.push({ filename, kind, id, storage_session_id, fileId, apiKey, userId, bytes });
  return { storage_session_id, fileId };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = busboy({ headers: req.headers });
    /** @type {Record<string, string>} */
    const fields = {};
    /** @type {Array<{ field: string; filename: string; bytes: number }>} */
    const files = [];
    bb.on('field', (name, value) => {
      fields[name] = value;
    });
    bb.on('file', (name, stream, info) => {
      let bytes = 0;
      stream.on('data', (chunk) => {
        bytes += chunk.length;
      });
      stream.on('end', () => {
        files.push({ field: name, filename: info.filename, bytes });
      });
      stream.on('error', reject);
    });
    bb.on('close', () => resolve({ fields, files }));
    bb.on('error', reject);
    req.pipe(bb);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function handleUpload(req, res) {
  const { fields, files } = await parseMultipart(req);
  if (files.length === 0) {
    sendJson(res, 400, { message: 'error', error: 'no file provided' });
    return;
  }
  const apiKey = req.headers['x-api-key'] || '';
  const userId = req.headers['user-id'] || '';
  const { storage_session_id, fileId } = recordUpload({
    kind: fields.kind,
    id: fields.id,
    filename: files[0].filename,
    bytes: files[0].bytes,
    apiKey,
    userId,
  });
  sendJson(res, 200, {
    message: 'success',
    storage_session_id,
    files: [{ fileId, filename: files[0].filename }],
  });
}

async function handleUploadBatch(req, res) {
  const { fields, files } = await parseMultipart(req);
  if (files.length === 0) {
    sendJson(res, 400, { message: 'error', error: 'no files provided' });
    return;
  }
  const apiKey = req.headers['x-api-key'] || '';
  const userId = req.headers['user-id'] || '';
  const storage_session_id = sessionIdFor(fields.kind, fields.id);
  const responseFiles = files.map((file) => {
    const fileId = `fid-${randomUUID()}`;
    if (!sessions.has(storage_session_id)) {
      sessions.set(storage_session_id, []);
    }
    sessions.get(storage_session_id).push({ fileId, filename: file.filename });
    uploads.push({
      filename: file.filename,
      kind: fields.kind,
      id: fields.id,
      storage_session_id,
      fileId,
      apiKey,
      userId,
      bytes: file.bytes,
    });
    return { status: 'success', fileId, filename: file.filename };
  });
  sendJson(res, 200, {
    message: 'success',
    storage_session_id,
    files: responseFiles,
    succeeded: responseFiles.length,
    failed: 0,
  });
}

function handleRunFileVersion(body, res, label, operation) {
  const sessionId = `e2e-run-file-versions-${label}`;
  const fileId = `e2e-versioned-${label}`;
  const name = 'analysis.csv';
  const key = `${sessionId}/${fileId}`;
  const files = Array.isArray(body.files) ? body.files : [];
  const inputNames = [`e2e-run-file-versions-${label}.pdf`, `e2e-run-file-versions-${label}.csv`];
  if (!inputNames.every((filename) => files.some((file) => file.name === filename))) {
    sendJson(res, 400, { message: 'version scenario requires both current uploaded inputs' });
    return;
  }
  if (
    operation !== 'write-v1' &&
    (!generated.has(key) ||
      !files.some((file) => file.id === fileId && file.storage_session_id === sessionId))
  ) {
    sendJson(res, 400, { message: 'version scenario lost the previous sandbox output' });
    return;
  }
  if (operation !== 'inspect') {
    const content = Buffer.from(
      operation === 'write-v1' ? 'version,total\n1,30\n' : 'version,total\n2,35\n',
    );
    /** Reuse the storage identity so only LibreChat's capture can preserve earlier bytes. */
    generated.set(key, { name, content });
    sessions.set(sessionId, [{ fileId, filename: name }]);
  }
  const file = generated.get(key);
  sendJson(res, 200, {
    session_id: sessionId,
    stdout: `${operation} ${name}\n${file.content.toString('utf8')}`,
    stderr: '',
    files: [{ id: fileId, name }],
  });
}

async function handleExec(req, res) {
  const body = await readJson(req);
  execs.push({
    lang: body.lang || '',
    codeLength: typeof body.code === 'string' ? body.code.length : 0,
    fileCount: Array.isArray(body.files) ? body.files.length : 0,
  });
  const versionMarker = body.code?.match(
    /E2E_RUN_FILE_VERSION:([A-Za-z0-9-]+):(write-v1|inspect|write-v2)/,
  );
  if (versionMarker) {
    handleRunFileVersion(body, res, versionMarker[1], versionMarker[2]);
    return;
  }
  const runFileLabel = body.code?.match(/E2E_RUN_FILE_ARTIFACT:([A-Za-z0-9-]+)/)?.[1];
  if (runFileLabel) {
    const sessionId = `e2e-run-files-${runFileLabel}`;
    const fileId = `e2e-generated-${runFileLabel}`;
    const name = `e2e-run-files-${runFileLabel}.csv`;
    const content = Buffer.from('source,count\npdf,1\n');
    generated.set(`${sessionId}/${fileId}`, { name, content });
    sessions.set(sessionId, [{ fileId, filename: name }]);
    sendJson(res, 200, {
      session_id: sessionId,
      stdout: `Created ${name}\n`,
      stderr: '',
      files: [{ id: fileId, name }],
    });
    return;
  }
  sendJson(res, 200, { stdout: 'E2E code exec ok\n', stderr: '', files: [] });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  const handle = async () => {
    if (pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (pathname === '/__debug/uploads' && req.method === 'GET') {
      sendJson(res, 200, { uploads, execs });
      return;
    }

    if (pathname === '/__debug/reset' && req.method === 'POST') {
      sessions.clear();
      generated.clear();
      uploads.length = 0;
      execs.length = 0;
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/v1/upload' && req.method === 'POST') {
      await handleUpload(req, res);
      return;
    }

    if (pathname === '/v1/upload/batch' && req.method === 'POST') {
      await handleUploadBatch(req, res);
      return;
    }

    if (pathname === '/v1/exec' && req.method === 'POST') {
      await handleExec(req, res);
      return;
    }

    const downloadMatch = pathname.match(/^\/v1\/download\/([^/]+)\/([^/]+)$/);
    if (downloadMatch && req.method === 'GET') {
      const key = `${decodeURIComponent(downloadMatch[1])}/${decodeURIComponent(downloadMatch[2])}`;
      const file = generated.get(key);
      if (!file) {
        sendJson(res, 404, { message: 'file not found' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Length': file.content.length,
        'Content-Disposition': `attachment; filename="${file.name}"`,
        'X-Original-Filename': file.name,
      });
      res.end(file.content);
      return;
    }

    const filesMatch = pathname.match(/^\/v1\/files\/([^/]+)$/);
    if (filesMatch && req.method === 'GET') {
      sendJson(res, 200, sessions.get(decodeURIComponent(filesMatch[1])) ?? []);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'not found' }));
  };

  handle().catch((error) => {
    console.error('[e2e] fake code server error:', error);
    sendJson(res, 500, { message: 'error', error: String(error?.message ?? error) });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[e2e] fake code API listening on http://${HOST}:${PORT}/v1`);
});
