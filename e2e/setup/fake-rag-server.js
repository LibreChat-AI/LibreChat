#!/usr/bin/env node

/**
 * Fake RAG (vector DB) API for mock e2e file-provisioning tests.
 *
 * Stands in for the external RAG service LibreChat reaches at `RAG_API_URL`. It
 * implements just enough of the contract to exercise the vector-DB provisioning
 * path end to end (real backend + DB) without a live embedding service:
 *
 * - `POST /embed`: embed an uploaded file (`uploadVectors`); returns
 *   `known_type: true` so the file is marked `embedded`.
 * - `POST /query`: semantic query from the `file_search` tool; returns an
 *   empty result set (valid, handled gracefully). A query for `PROBE_K` chunks
 *   is priming's presence check, recorded under `probes` and answered from the
 *   stored embeds the way RAG authorizes chunks: a hit only when the file was
 *   embedded under the queried `entity_id`.
 * - `DELETE /documents`: delete embeddings (`deleteVectors`).
 *
 * Every embed is recorded and surfaced at `GET /__debug/embedded` so specs can
 * assert a file's bytes actually reached the RAG env, independent of the DB write.
 * `/__debug/reset` clears those recordings only; the stored embeds behind presence
 * checks persist like real vectors until `DELETE /documents` removes them.
 *
 * `POST /__debug/stall` with `{ stall: true }` records file_search queries but never
 * answers them, standing in for a hung RAG API; reset or `{ stall: false }` clears it.
 */

const http = require('http');
const busboy = require('busboy');

const PORT = parseInt(process.env.E2E_RAG_API_PORT || '8791', 10);
/** Mirrors ENTITY_EMBEDDINGS_PROBE_K in packages/api/src/files/rag.ts; file_search asks for 5. */
const PROBE_K = 10;
const HOST = '127.0.0.1';

/** @type {Array<{ file_id: string; filename: string; entity_id: string; bytes: number; auth: string }>} */
const embedded = [];
/** @type {Array<{ file_id: string; query: string }>} */
const queries = [];
/** @type {Array<{ file_id: string; entity_id: string; present: boolean }>} */
const probes = [];
/** @type {Array<{ file_id: string; entity_id: string }>} */
const stored = [];
let stallQueries = false;
/** @type {string[]} */
const deleted = [];

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
  embedded.push({
    file_id: fields.file_id || '',
    filename: files[0]?.filename || '',
    entity_id: fields.entity_id || '',
    bytes: files[0]?.bytes ?? 0,
    auth: req.headers['authorization'] || '',
  });
  stored.push({ file_id: fields.file_id || '', entity_id: fields.entity_id || '' });
  sendJson(res, 200, { status: true, known_type: true });
}

async function handleQuery(req, res) {
  const body = await readJson(req);
  const entityId = body.entity_id || '';
  if (body.k !== PROBE_K) {
    queries.push({ file_id: body.file_id || '', query: body.query || '' });
    if (stallQueries) {
      return;
    }
    sendJson(res, 200, []);
    return;
  }
  const present = stored.some(
    (entry) => entry.file_id === body.file_id && entry.entity_id === entityId,
  );
  probes.push({ file_id: body.file_id || '', entity_id: entityId, present });
  sendJson(
    res,
    200,
    present
      ? [
          [
            {
              page_content: '',
              metadata: { source: '', file_id: body.file_id, user_id: entityId },
            },
            0,
          ],
        ]
      : [],
  );
}

async function handleDeleteDocuments(req, res) {
  const body = await readJson(req);
  if (Array.isArray(body)) {
    const ids = body.map(String);
    deleted.push(...ids);
    for (let i = stored.length - 1; i >= 0; i--) {
      if (ids.includes(stored[i].file_id)) {
        stored.splice(i, 1);
      }
    }
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
      sendJson(res, 200, { embedded, queries, probes, deleted });
      return;
    }

    if (pathname === '/__debug/stall' && req.method === 'POST') {
      stallQueries = (await readJson(req)).stall === true;
      sendJson(res, 200, { ok: true, stall: stallQueries });
      return;
    }

    if (pathname === '/__debug/reset' && req.method === 'POST') {
      stallQueries = false;
      embedded.length = 0;
      queries.length = 0;
      probes.length = 0;
      deleted.length = 0;
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
