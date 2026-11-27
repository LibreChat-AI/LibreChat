import path from 'path';
import http from 'node:http';
import { MongoClient } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { expect, test } from '@playwright/test';
import type { AddressInfo } from 'node:net';
import type { Db } from 'mongodb';
import { getMongoUri } from '../db';

/**
 * Startup search sync against search documents written before `user` joined the
 * projection. Meilisearch is an external service the harness does not run, so the
 * scenario serves the few endpoints the sync calls; MongoDB and the sync itself are real.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const DRIVER = path.join(__dirname, 'meili-index-sync.cjs');
const NO_AUTO_INDEX = path.join(__dirname, 'no-auto-index.cjs');
const OWNERLESS_FILTER = 'user NOT EXISTS OR user IS NULL OR user IS EMPTY';

type SearchDocument = Record<string, unknown>;

interface SearchIndex {
  primaryKey: string;
  documents: Map<string, SearchDocument>;
}

interface FakeSearch {
  url: string;
  indexes: Map<string, SearchIndex>;
  added: Map<string, string[]>;
  close: () => Promise<void>;
}

const isOwnerless = (document: SearchDocument): boolean =>
  document.user == null || document.user === '';

const pick = (document: SearchDocument, fields?: string[]): SearchDocument =>
  fields ? Object.fromEntries(fields.map((field) => [field, document[field]])) : document;

async function readBody(request: http.IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
  }
  return raw ? JSON.parse(raw) : undefined;
}

async function startFakeSearch(seed: Record<string, SearchIndex>): Promise<FakeSearch> {
  const indexes = new Map(Object.entries(seed));
  const added = new Map<string, string[]>();
  let taskUid = 0;

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://search');
    const parts = url.pathname.split('/').filter(Boolean);
    const body = await readBody(request);
    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    const task = (indexUid?: string) =>
      send(202, {
        taskUid: ++taskUid,
        indexUid,
        status: 'enqueued',
        type: 'documentAdditionOrUpdate',
        enqueuedAt: new Date().toISOString(),
      });

    if (parts[0] === 'health') {
      return send(200, { status: 'available' });
    }
    if (parts[0] === 'tasks') {
      return send(200, {
        uid: Number(parts[1]),
        status: 'succeeded',
        type: 'documentAdditionOrUpdate',
      });
    }
    if (parts[0] !== 'indexes') {
      return send(404, { code: 'not_found', message: url.pathname });
    }
    if (parts.length === 1 && request.method === 'POST') {
      const { uid, primaryKey } = body as { uid: string; primaryKey: string };
      indexes.set(uid, indexes.get(uid) ?? { primaryKey, documents: new Map() });
      return task(uid);
    }

    const uid = parts[1];
    const index = indexes.get(uid);
    if (!index) {
      return send(404, {
        code: 'index_not_found',
        type: 'invalid_request',
        message: `Index \`${uid}\` not found.`,
      });
    }
    const resource = parts.slice(2).join('/');

    if (resource === '' && request.method === 'GET') {
      return send(200, { uid, primaryKey: index.primaryKey });
    }
    if (resource === 'settings') {
      return request.method === 'GET' ? send(200, { filterableAttributes: ['user'] }) : task(uid);
    }
    if (resource === 'documents/fetch' || (resource === 'documents' && request.method === 'GET')) {
      const query =
        resource === 'documents/fetch'
          ? (body as { filter?: string; fields?: string[]; limit?: number; offset?: number })
          : {
              fields: url.searchParams.get('fields')?.split(','),
              limit: Number(url.searchParams.get('limit') ?? 20),
              offset: Number(url.searchParams.get('offset') ?? 0),
            };
      if ('filter' in query && query.filter !== OWNERLESS_FILTER) {
        return send(400, { code: 'invalid_document_filter', message: String(query.filter) });
      }
      const matching = [...index.documents.values()].filter(
        (document) => !('filter' in query) || isOwnerless(document),
      );
      const offset = query.offset ?? 0;
      const limit = query.limit ?? 20;
      return send(200, {
        results: matching.slice(offset, offset + limit).map((doc) => pick(doc, query.fields)),
        offset,
        limit,
        total: matching.length,
      });
    }
    if (resource === 'documents' && (request.method === 'POST' || request.method === 'PUT')) {
      for (const document of body as SearchDocument[]) {
        const id = String(document[index.primaryKey]);
        const merged =
          request.method === 'PUT' ? { ...index.documents.get(id), ...document } : document;
        index.documents.set(id, merged);
        added.set(uid, [...(added.get(uid) ?? []), id]);
      }
      return task(uid);
    }
    if (resource === 'documents/delete-batch') {
      for (const id of body as string[]) {
        index.documents.delete(String(id));
      }
      return task(uid);
    }
    if (parts[2] === 'documents' && parts[3] && request.method === 'DELETE') {
      index.documents.delete(decodeURIComponent(parts[3]));
      return task(uid);
    }
    return send(404, { code: 'not_found', message: `${request.method} ${url.pathname}` });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    indexes,
    added,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function searchIndex(primaryKey: string, documents: SearchDocument[]): SearchIndex {
  return {
    primaryKey,
    documents: new Map(documents.map((document) => [String(document[primaryKey]), document])),
  };
}

/** A database of its own, so the progress counts see only this scenario's records. */
function scenarioMongoUri(): string {
  const uri = new URL(getMongoUri());
  uri.pathname = `/meili-ownerless-${randomUUID().slice(0, 8)}`;
  return uri.toString();
}

async function withScenarioDb<T>(uri: string, run: (db: Db) => Promise<T>): Promise<T> {
  const client = new MongoClient(uri);
  await client.connect();
  try {
    return await run(client.db());
  } finally {
    await client.close();
  }
}

function runStartupSync(mongoUri: string, searchUrl: string): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MONGO_URI: mongoUri,
    MEILI_HOST: searchUrl,
    MEILI_MASTER_KEY: 'scenario-master-key',
    SEARCH: 'true',
    USE_REDIS: 'false',
    MEILI_SYNC_DELAY_MS: '1',
    NODE_OPTIONS: process.env.NODE_OPTIONS
      ? `${process.env.NODE_OPTIONS} --require ${NO_AUTO_INDEX}`
      : `--require ${NO_AUTO_INDEX}`,
  };
  delete env.MEILI_NO_SYNC;
  const child = spawn(process.execPath, [DRIVER], { cwd: REPO_ROOT, env });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(output) : reject(new Error(`sync exited ${code}:\n${output}`)),
    );
  });
}

const indexed = {
  isCreatedByUser: true,
  expiredAt: null,
  _meiliIndex: true,
  _meiliIndexSchemaVersion: 1,
};

test('a legacy search document without an owner is reindexed with its owner @scenario:legacy-search-document-is-reindexed-with-its-owner', async () => {
  test.setTimeout(120_000);
  const mongoUri = scenarioMongoUri();
  const user = `owner-${randomUUID().slice(0, 8)}`;
  const conversationId = randomUUID();
  const search = await startFakeSearch({
    messages: searchIndex('messageId', [
      { messageId: 'current', conversationId, user, text: 'indexed with its owner' },
      { messageId: 'legacy', conversationId, text: 'indexed before the owner field' },
    ]),
    convos: searchIndex('conversationId', [{ conversationId, user: null, title: 'Legacy chat' }]),
  });

  try {
    await withScenarioDb(mongoUri, async (db) => {
      await db.collection('messages').insertMany([
        { ...indexed, messageId: 'current', conversationId, user, text: 'indexed with its owner' },
        {
          ...indexed,
          messageId: 'legacy',
          conversationId,
          user,
          text: 'indexed before the owner field',
        },
      ]);
      await db
        .collection('conversations')
        .insertOne({ ...indexed, conversationId, user, title: 'Legacy chat', endpoint: 'openAI' });
    });

    await runStartupSync(mongoUri, search.url);

    const messages = search.indexes.get('messages')!.documents;
    expect(messages.get('legacy')).toMatchObject({ messageId: 'legacy', user });
    expect(messages.get('current')).toMatchObject({ messageId: 'current', user });
    expect(search.indexes.get('convos')!.documents.get(conversationId)).toMatchObject({ user });
    expect(search.added.get('messages')).toEqual(['legacy']);

    const records = await withScenarioDb(mongoUri, async (db) => ({
      messages: await db.collection('messages').find({}).sort({ messageId: 1 }).toArray(),
      conversation: await db.collection('conversations').findOne({ conversationId }),
    }));
    expect(records.messages.map((doc) => [doc.messageId, doc._meiliIndex])).toEqual([
      ['current', true],
      ['legacy', true],
    ]);
    expect(records.conversation).toMatchObject({ _meiliIndex: true });
  } finally {
    await search.close();
    await withScenarioDb(mongoUri, (db) => db.dropDatabase());
  }
});

test('an orphaned search document without an owner is deleted without a full rebuild @scenario:orphaned-search-document-is-deleted-without-a-full-rebuild', async () => {
  test.setTimeout(120_000);
  const mongoUri = scenarioMongoUri();
  const user = `owner-${randomUUID().slice(0, 8)}`;
  const conversationId = randomUUID();
  const search = await startFakeSearch({
    messages: searchIndex('messageId', [
      { messageId: 'current', conversationId, user, text: 'kept' },
      { messageId: 'orphan-missing', text: 'no record, no owner' },
      { messageId: 'orphan-empty', user: '', text: 'no record, empty owner' },
    ]),
    convos: searchIndex('conversationId', [{ conversationId, user, title: 'Current chat' }]),
  });

  try {
    await withScenarioDb(mongoUri, async (db) => {
      await db
        .collection('messages')
        .insertOne({ ...indexed, messageId: 'current', conversationId, user, text: 'kept' });
      await db
        .collection('conversations')
        .insertOne({ ...indexed, conversationId, user, title: 'Current chat', endpoint: 'openAI' });
    });

    await runStartupSync(mongoUri, search.url);

    expect([...search.indexes.get('messages')!.documents.keys()]).toEqual(['current']);
    expect([...search.indexes.get('convos')!.documents.keys()]).toEqual([conversationId]);
    expect(search.added.size).toBe(0);

    const current = await withScenarioDb(mongoUri, (db) =>
      db.collection('messages').findOne({ messageId: 'current' }),
    );
    expect(current).toMatchObject({ _meiliIndex: true });
    expect(current).not.toHaveProperty('_meiliIndexAttempted');
  } finally {
    await search.close();
    await withScenarioDb(mongoUri, (db) => db.dropDatabase());
  }
});
