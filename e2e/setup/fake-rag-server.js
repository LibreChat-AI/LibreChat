#!/usr/bin/env node

/**
 * Fake RAG (vector DB) API for mock e2e file-provisioning tests.
 *
 * Stands in for the external RAG service LibreChat reaches at `RAG_API_URL`. It
 * implements just enough of the contract to exercise the vector-DB provisioning
 * path end to end (real backend + DB) without a live embedding service:
 *
 * - `POST   /embed`      — embed an uploaded file (`uploadVectors`); returns
 *                          `known_type: true` so the file is marked `embedded`.
 * - `POST   /query`      — semantic query from the `file_search` tool; returns an
 *                          empty result set (valid, handled gracefully).
 * - `DELETE /documents`  — delete embeddings (`deleteVectors`).
 *
 * Every embed is recorded and surfaced at `GET /__debug/embedded` so specs can
 * assert a file's bytes actually reached the RAG env, independent of the DB write.
 * Embeds and queries share one sequence (`seq`, never reset): an embed takes its
 * number once its upload is fully received and a query when it arrives, so a spec
 * can show a file was indexed before it was searched.
 */

const http = require('http');
const busboy = require('busboy');

const PORT = parseInt(process.env.E2E_RAG_API_PORT || '8791', 10);
const HOST = '127.0.0.1';

/** @type {Array<{ seq: number; file_id: string; filename: string; entity_id: string; bytes: number; auth: string }>} */
const embedded = [];
/** @type {Array<{ seq: number; file_id: string; query: string }>} */
const queries = [];
let sequence = 0;
/** @type {string[]} */
const deleted = [];
/** Per-file failures let retry tests leave every other upload unaffected. */
const embeddingFailures = new Set();
const failedEmbeds = [];

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

async function handleEmbed(req, res) {
  const { fields, files } = await parseMultipart(req);
  if (embeddingFailures.has(fields.file_id)) {
    failedEmbeds.push({ seq: ++sequence, file_id: fields.file_id });
    sendJson(res, 503, { status: false, message: 'E2E embedding unavailable' });
    return;
  }
  embedded.push({
    seq: ++sequence,
    file_id: fields.file_id || '',
    filename: files[0]?.filename || '',
    entity_id: fields.entity_id || '',
    bytes: files[0]?.bytes ?? 0,
    auth: req.headers['authorization'] || '',
  });
  sendJson(res, 200, { status: true, known_type: true });
}

async function handleQuery(req, res) {
  const seq = ++sequence;
  const body = await readJson(req);
  queries.push({ seq, file_id: body.file_id || '', query: body.query || '' });
  sendJson(res, 200, []);
}

async function handleDeleteDocuments(req, res) {
  const body = await readJson(req);
  if (Array.isArray(body)) {
    deleted.push(...body.map(String));
  }
  sendJson(res, 200, { status: true });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  const handle = async () => {
    if ((pathname === '/health' || pathname === '/') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (pathname === '/__debug/embedded' && req.method === 'GET') {
      sendJson(res, 200, { embedded, queries, deleted, failedEmbeds });
      return;
    }

    if (pathname === '/__debug/reset' && req.method === 'POST') {
      embedded.length = 0;
      queries.length = 0;
      deleted.length = 0;
      failedEmbeds.length = 0;
      embeddingFailures.clear();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/__debug/embedding-failure' && req.method === 'POST') {
      const body = await readJson(req);
      if (typeof body.file_id !== 'string' || typeof body.enabled !== 'boolean') {
        sendJson(res, 400, { message: 'file_id and enabled are required' });
        return;
      }
      if (body.enabled) {
        embeddingFailures.add(body.file_id);
      } else {
        embeddingFailures.delete(body.file_id);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/embed' && req.method === 'POST') {
      await handleEmbed(req, res);
      return;
    }

    if (pathname === '/query' && req.method === 'POST') {
      await handleQuery(req, res);
      return;
    }

    if (pathname === '/documents' && req.method === 'DELETE') {
      await handleDeleteDocuments(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'not found' }));
  };

  handle().catch((error) => {
    console.error('[e2e] fake RAG server error:', error);
    sendJson(res, 500, { status: false, error: String(error?.message ?? error) });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[e2e] fake RAG API listening on http://${HOST}:${PORT}`);
});
