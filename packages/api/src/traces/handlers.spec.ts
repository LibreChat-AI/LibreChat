import http from 'http';
import express from 'express';
import request from 'supertest';
import { MemoryStore } from 'express-rate-limit';
import { TRACE_RECORD_ID_MAX_LENGTH } from 'librechat-data-provider';
import type { TTracePage, TTraceRecordDetail, TTraceViewerConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { RequestHandler } from 'express';
import type { AddressInfo } from 'net';
import type { TraceHandlerDeps, TraceRequest, TraceRouteHandler } from './handlers';
import type { TraceReader } from './types';
import { createTraceReadLimiter } from './limiter';
import { createTraceHandlers } from './handlers';
import { TraceReadError } from './types';

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

const record: TTraceRecordDetail['record'] = {
  id: 'obs-1',
  traceId: 'trace-1',
  messageId: 'response-1',
  parentId: null,
  kind: 'agent',
  name: 'AgentGraph',
  startTime: '2026-09-12T11:30:00.000Z',
  endTime: '2026-09-12T11:30:05.000Z',
  status: 'ok',
};

function createReader(overrides: Partial<TraceReader> = {}): jest.Mocked<TraceReader> {
  return {
    isAvailable: jest.fn(async () => ({ available: true })),
    listRecords: jest.fn(async (): Promise<TTracePage> => ({ records: [record] })),
    getRecord: jest.fn(
      async (): Promise<TTraceRecordDetail> => ({ record, contentAvailable: false }),
    ),
    ...overrides,
  } as jest.Mocked<TraceReader>;
}

function createApp({
  reader = createReader(),
  traceViewer = { enabled: true },
  userId = 'owner',
  tenantId,
  contextCost,
  getConvoOwnership = jest.fn(async () => ({ user: userId, tenantId })),
}: {
  reader?: TraceReader;
  traceViewer?: TTraceViewerConfig;
  tenantId?: string;
  contextCost?: boolean;
  getConvoOwnership?: TraceHandlerDeps['getConvoOwnership'];
  userId?: string;
} = {}) {
  const handlers = createTraceHandlers({ reader, getConvoOwnership });
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, {
      user: { id: userId, role: 'USER', tenantId },
      config: { interfaceConfig: { traceViewer, contextCost } } as AppConfig,
    });
    next();
  });
  const limiter = createTraceReadLimiter();
  const route =
    (handler: TraceRouteHandler): RequestHandler =>
    (req, res) =>
      handler(req as TraceRequest, res);
  app.get('/api/traces/:conversationId/availability', route(handlers.availability));
  app.get('/api/traces/:conversationId/records', limiter, route(handlers.records));
  app.get('/api/traces/:conversationId/records/:recordId', limiter, route(handlers.record));
  return { app, reader, getConvoOwnership };
}

describe('trace handlers', () => {
  it('passes an owned conversation to the reader with resolved settings', async () => {
    const reader = createReader();
    const { app, getConvoOwnership } = createApp({
      reader,
      traceViewer: { enabled: true, maxRecords: 50 },
    });

    const response = await request(app).get('/api/traces/convo-1/records?cursor=abc%3D');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toEqual({ records: [record] });
    expect(getConvoOwnership).toHaveBeenCalledWith('owner', 'convo-1', null);
    expect(reader.listRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner',
        conversationId: 'convo-1',
        cursor: 'abc=',
        settings: expect.objectContaining({ enabled: true, maxRecords: 50 }),
      }),
    );
  });

  it('answers availability without a trace for the disabled viewer', async () => {
    const reader = createReader();
    const { app, getConvoOwnership } = createApp({ reader, traceViewer: { enabled: false } });

    const availability = await request(app).get('/api/traces/convo-1/availability');
    const records = await request(app).get('/api/traces/convo-1/records');

    expect(availability.body).toEqual({ available: false });
    expect(records.status).toBe(404);
    expect(records.body).toEqual({ error: expect.any(String), errorCode: 'disabled' });
    expect(getConvoOwnership).not.toHaveBeenCalled();
    expect(reader.isAvailable).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing conversation', null],
    ["another user's conversation", { user: 'someone-else' }],
    ['a subagent child thread', { user: 'owner', subagentThread: { parentConversationId: 'p' } }],
  ])('treats %s as not found and never reads the trace', async (_label, conversation) => {
    const reader = createReader();
    const { app } = createApp({ reader, getConvoOwnership: jest.fn(async () => conversation) });

    const availability = await request(app).get('/api/traces/convo-1/availability');
    const records = await request(app).get('/api/traces/convo-1/records');
    const detail = await request(app).get('/api/traces/convo-1/records/obs-1?message=response-1');

    expect(availability.body).toEqual({ available: false });
    expect(records.status).toBe(404);
    expect(records.body.errorCode).toBe('not_found');
    expect(detail.status).toBe(404);
    expect(reader.listRecords).not.toHaveBeenCalled();
    expect(reader.getRecord).not.toHaveBeenCalled();
  });

  it("scopes ownership and reads to the requester's tenant", async () => {
    const reader = createReader();
    const { app, getConvoOwnership } = createApp({ reader, tenantId: 'tenant-a' });
    const crossTenant = createApp({
      reader: createReader(),
      tenantId: 'tenant-a',
      getConvoOwnership: jest.fn(async () => ({ user: 'owner', tenantId: 'tenant-b' })),
    });

    await request(app).get('/api/traces/convo-1/records');
    const refused = await request(crossTenant.app).get('/api/traces/convo-1/records');

    expect(getConvoOwnership).toHaveBeenCalledWith('owner', 'convo-1', 'tenant-a');
    expect(reader.listRecords).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner', tenantId: 'tenant-a' }),
    );
    expect(refused.status).toBe(404);
  });

  it('starts the availability lookup alongside the ownership check', async () => {
    let readerStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      readerStarted = resolve;
    });
    const reader = createReader({
      isAvailable: jest.fn(async () => {
        readerStarted();
        return { available: true };
      }),
    });
    /** Owned only if the lookup was already running; a serial handler times out to unowned. */
    const getConvoOwnership = jest.fn(async () =>
      Promise.race([
        started.then(() => ({ user: 'owner' })),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
      ]),
    );
    const { app } = createApp({ reader, getConvoOwnership });

    const response = await request(app).get('/api/traces/convo-1/availability');

    expect(response.body).toEqual({ available: true });
  });

  it('passes a retry hint through only for an owned conversation', async () => {
    const reader = createReader({
      isAvailable: jest.fn(async () => ({ available: false, retryAfterMs: 30_000 })),
    });
    const owned = createApp({ reader });
    const unowned = createApp({ reader, getConvoOwnership: jest.fn(async () => null) });

    const ownedResponse = await request(owned.app).get('/api/traces/convo-1/availability');
    const unownedResponse = await request(unowned.app).get('/api/traces/convo-1/availability');

    expect(ownedResponse.body).toEqual({ available: false, retryAfterMs: 30_000 });
    expect(unownedResponse.body).toEqual({ available: false });
  });

  it('answers unavailable for an unowned conversation even when the lookup fails', async () => {
    const reader = createReader({
      isAvailable: jest.fn(async () => {
        throw new TraceReadError('upstream_error', 'lookup failed');
      }),
    });
    const unowned = createApp({ reader, getConvoOwnership: jest.fn(async () => null) });
    const owned = createApp({ reader });

    const unownedResponse = await request(unowned.app).get('/api/traces/convo-1/availability');
    const ownedResponse = await request(owned.app).get('/api/traces/convo-1/availability');

    expect(unownedResponse.status).toBe(200);
    expect(unownedResponse.body).toEqual({ available: false });
    expect(ownedResponse.status).toBe(502);
  });

  it('rejects the new-conversation placeholder and malformed cursors', async () => {
    const reader = createReader();
    const { app } = createApp({ reader });

    const placeholder = await request(app).get('/api/traces/new/records');
    const cursor = await request(app).get('/api/traces/convo-1/records?cursor=%7B%22x%22%7D');
    const oversized = await request(app).get(
      `/api/traces/convo-1/records?cursor=${'a'.repeat(5000)}`,
    );

    expect(placeholder.status).toBe(400);
    expect(cursor.status).toBe(400);
    expect(cursor.body.errorCode).toBe('invalid_request');
    expect(oversized.status).toBe(400);
    expect(reader.listRecords).not.toHaveBeenCalled();
  });

  it.each([
    ['rate_limited', 429],
    ['timeout', 504],
    ['unauthorized', 502],
    ['unsupported', 501],
    ['upstream_error', 502],
  ] as const)('maps a %s read failure to %s', async (code, status) => {
    const reader = createReader({
      listRecords: jest.fn(async () => {
        throw new TraceReadError(code, 'internal detail');
      }),
    });
    const { app } = createApp({ reader });

    const response = await request(app).get('/api/traces/convo-1/records');

    expect(response.status).toBe(status);
    expect(response.body.errorCode).toBe(code);
    expect(response.body.error).not.toContain('internal detail');
  });

  it('hides unexpected failures behind a generic 500', async () => {
    const reader = createReader({
      getRecord: jest.fn(async () => {
        throw new Error('mongo exploded at 10.0.0.1');
      }),
    });
    const { app } = createApp({ reader });

    const response = await request(app).get('/api/traces/convo-1/records/obs-1?message=response-1');

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('10.0.0.1');
  });

  it('withholds costs unless context cost is enabled', async () => {
    const pricedRecord = { ...record, cost: 0.25 };
    const createPricedApp = (contextCost?: boolean) =>
      createApp({
        contextCost,
        reader: createReader({
          listRecords: jest.fn(async () => ({ records: [pricedRecord] })),
          getRecord: jest.fn(async () => ({ record: pricedRecord, contentAvailable: false })),
        }),
      }).app;

    const hidden = createPricedApp();
    const shown = createPricedApp(true);

    const hiddenList = await request(hidden).get('/api/traces/convo-1/records');
    const hiddenDetail = await request(hidden).get(
      '/api/traces/convo-1/records/obs-1?message=response-1',
    );
    const shownList = await request(shown).get('/api/traces/convo-1/records');
    const shownDetail = await request(shown).get(
      '/api/traces/convo-1/records/obs-1?message=response-1',
    );

    expect(hiddenList.body.records[0]).not.toHaveProperty('cost');
    expect(hiddenDetail.body.record).not.toHaveProperty('cost');
    expect(shownList.body.records[0].cost).toBe(0.25);
    expect(shownDetail.body.record.cost).toBe(0.25);
  });

  it('returns 404 when the reader has no such record', async () => {
    const reader = createReader({ getRecord: jest.fn(async () => null) });
    const { app } = createApp({ reader });

    const response = await request(app).get(
      '/api/traces/convo-1/records/obs-missing?message=response-1',
    );

    expect(response.status).toBe(404);
    expect(reader.getRecord).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'convo-1', recordId: 'obs-missing' }),
    );
  });

  it('reads a detail for the turn and source that listed it, and rejects a malformed or missing one', async () => {
    const reader = createReader();
    const { app } = createApp({ reader });

    await request(app).get(
      '/api/traces/convo-1/records/obs-1?message=response-1&source=central-id',
    );
    const oversized = await request(app).get(
      `/api/traces/convo-1/records/obs-1?message=response-1&source=${'s'.repeat(200)}`,
    );

    const withoutTurn = await request(app).get('/api/traces/convo-1/records/obs-1');
    const longTurn = 'r'.repeat(TRACE_RECORD_ID_MAX_LENGTH + 1);
    const longTurnDetail = await request(app).get(
      `/api/traces/convo-1/records/obs-1?message=${longTurn}`,
    );

    expect(reader.getRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: 'obs-1',
        messageId: 'response-1',
        sourceId: 'central-id',
      }),
    );
    expect(oversized.status).toBe(400);
    expect(withoutTurn.status).toBe(400);
    /** A response id is stored at whatever length the request gave it; the turn it listed opens. */
    expect(longTurnDetail.status).toBe(200);
    expect(reader.getRecord).toHaveBeenCalledWith(expect.objectContaining({ messageId: longTurn }));
    expect(reader.getRecord).toHaveBeenCalledTimes(2);
  });

  it('aborts the read when the client disconnects before the response', async () => {
    let signal: AbortSignal | undefined;
    let readerStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      readerStarted = resolve;
    });
    const reader = createReader({
      listRecords: jest.fn(
        (query) =>
          new Promise<TTracePage>((_resolve, reject) => {
            signal = query.signal;
            readerStarted();
            query.signal?.addEventListener('abort', () =>
              reject(new TraceReadError('upstream_error', 'The trace read was cancelled')),
            );
          }),
      ),
    });
    const { app } = createApp({ reader });
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;

    const clientRequest = http.get(`http://127.0.0.1:${port}/api/traces/convo-1/records`);
    clientRequest.on('error', () => undefined);
    await started;
    clientRequest.destroy();
    await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(signal?.aborted).toBe(true);
    const { logger } = jest.requireMock<{ logger: { warn: jest.Mock } }>('@librechat/data-schemas');
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('cancelled'));
  });

  it('counts the same user id in two tenants as two principals', async () => {
    const store = new MemoryStore();
    const limiter = createTraceReadLimiter({ store });
    const handlers = createTraceHandlers({
      reader: createReader(),
      getConvoOwnership: jest.fn(async (user, _conversationId, tenantId) => ({
        user,
        tenantId,
      })),
    });
    const appFor = (tenantId?: string) => {
      const app = express();
      app.use((req, _res, next) => {
        Object.assign(req, {
          user: { id: 'shared-user-id', tenantId },
          config: { interfaceConfig: { traceViewer: { enabled: true, requestsPerMinute: 1 } } },
        });
        next();
      });
      app.get('/records/:conversationId', limiter, (req, res) =>
        handlers.records(req as TraceRequest, res),
      );
      return app;
    };

    const tenantA = await request(appFor('tenant-a')).get('/records/convo-1');
    const tenantB = await request(appFor('tenant-b')).get('/records/convo-1');
    const tenantless = await request(appFor()).get('/records/convo-1');
    const tenantAAgain = await request(appFor('tenant-a')).get('/records/convo-1');

    expect([tenantA.status, tenantB.status, tenantless.status, tenantAAgain.status]).toEqual([
      200, 200, 200, 429,
    ]);
  });

  it('limits trace reads per user with the configured ceiling', async () => {
    const reader = createReader();
    const { app } = createApp({
      reader,
      userId: 'limited-user',
      traceViewer: { enabled: true, requestsPerMinute: 2 },
    });

    const statuses = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await request(app).get('/api/traces/convo-1/records')).status);
    }
    const availability = await request(app).get('/api/traces/convo-1/availability');

    expect(statuses).toEqual([200, 200, 429]);
    expect(availability.status).toBe(200);
    expect(reader.listRecords).toHaveBeenCalledTimes(2);
  });
});
