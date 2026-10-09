import { Types } from 'mongoose';
import { EventEmitter } from 'events';
import { MAX_AUDIT_EXPORT_ROWS, MAX_AUDIT_VERIFY_ROWS } from '@librechat/data-schemas';
import type {
  AdminAuditLogEntry,
  AuditChainVerification,
  AuditLogPage,
} from '@librechat/data-schemas';
import type { Response } from 'express';
import type { AdminAuditLogDeps } from './auditLog';
import type { ServerRequest } from '~/types/http';
import { createAdminAuditLogHandlers } from './auditLog';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const validObjectId = new Types.ObjectId().toString();

function mockEntry(overrides: Partial<AdminAuditLogEntry> = {}): AdminAuditLogEntry {
  return {
    id: new Types.ObjectId().toString(),
    schemaVersion: 1,
    category: 'grant',
    action: 'grant.assigned',
    outcome: 'success',
    severity: 'warning',
    actor: { type: 'user', id: new Types.ObjectId().toString(), name: 'Alice Admin' },
    target: { type: 'role', id: 'ADMIN', name: 'ADMIN' },
    metadata: { capability: 'manage:users' },
    context: { ip: '10.0.0.1', requestId: 'req-1' },
    integrity: { seq: 1, hash: 'a'.repeat(64), prevHash: '0'.repeat(64) },
    timestamp: new Date('2025-01-15T10:30:00.000Z').toISOString(),
    ...overrides,
  };
}

function mockPage(overrides: Partial<AuditLogPage> = {}): AuditLogPage {
  return { entries: [], total: 0, nextCursor: null, ...overrides };
}

function mockVerification(overrides: Partial<AuditChainVerification> = {}): AuditChainVerification {
  return {
    ok: true,
    chainKey: 'tenant-a',
    checked: 3,
    range: { firstSeq: 1, lastSeq: 3 },
    ...overrides,
  };
}

function createReqRes(
  overrides: {
    params?: Record<string, string>;
    query?: Record<string, string | string[]>;
    user?: { _id?: Types.ObjectId; id?: string; role?: string; tenantId?: string } | undefined;
  } = {},
) {
  const req = {
    params: overrides.params ?? {},
    query: overrides.query ?? {},
    body: {},
    user: 'user' in overrides ? overrides.user : { _id: new Types.ObjectId(), role: 'admin' },
  } as unknown as ServerRequest;

  const emitter = new EventEmitter();
  const reqEmitter = new EventEmitter();
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = Object.assign(emitter, {
    status,
    json,
    removeListener: emitter.removeListener.bind(emitter),
  }) as unknown as Response;
  const eventReq = Object.assign(reqEmitter, req, {
    removeListener: reqEmitter.removeListener.bind(reqEmitter),
  }) as unknown as ServerRequest;

  return { req: eventReq, res, status, json, emitter, reqEmitter };
}

interface CsvCaptureContext {
  req: ServerRequest;
  res: Response;
  emitter: EventEmitter;
  reqEmitter: EventEmitter;
  chunks: string[];
  endCalled: () => boolean;
  emitClose: () => void;
}

/**
 * Wraps request/response in EventEmitter shims so the streaming handler can
 * register `close` / `aborted` / `drain` listeners and the test can drive them.
 */
function createCsvContext(
  overrides: {
    query?: Record<string, string | string[]>;
    user?: { _id?: Types.ObjectId; id?: string; role?: string; tenantId?: string } | undefined;
    writeReturns?: boolean;
  } = {},
): CsvCaptureContext {
  const emitter = new EventEmitter();
  const reqEmitter = new EventEmitter();
  const chunks: string[] = [];
  let ended = false;

  const res = Object.assign(emitter, {
    setHeader: jest.fn(),
    write: jest.fn((chunk: string) => {
      chunks.push(chunk);
      return overrides.writeReturns ?? true;
    }),
    end: jest.fn(() => {
      ended = true;
    }),
    headersSent: false,
    status: jest.fn().mockReturnValue({ json: jest.fn() }),
    removeListener: emitter.removeListener.bind(emitter),
  }) as unknown as Response;

  const req = Object.assign(reqEmitter, {
    params: {},
    query: overrides.query ?? {},
    body: {},
    user: 'user' in overrides ? overrides.user : { _id: new Types.ObjectId(), role: 'admin' },
    removeListener: reqEmitter.removeListener.bind(reqEmitter),
  }) as unknown as ServerRequest;

  return {
    req,
    res,
    emitter,
    reqEmitter,
    chunks,
    endCalled: () => ended,
    emitClose: () => emitter.emit('close'),
  };
}

function createDeps(overrides: Partial<AdminAuditLogDeps> = {}): AdminAuditLogDeps {
  return {
    listAuditLogPage: jest.fn<Promise<AuditLogPage>, unknown[]>().mockResolvedValue(mockPage()),
    findAuditLogEntry: jest
      .fn<Promise<AdminAuditLogEntry | null>, unknown[]>()
      .mockResolvedValue(null),
    streamAuditLogEntries: jest
      .fn<Promise<{ count: number; truncated: boolean }>, unknown[]>()
      .mockResolvedValue({ count: 0, truncated: false }),
    verifyAuditChain: jest
      .fn<Promise<AuditChainVerification>, unknown[]>()
      .mockResolvedValue(mockVerification()),
    ...overrides,
  };
}

describe('createAdminAuditLogHandlers', () => {
  describe('listAuditLog', () => {
    it('returns 401 when req.user is missing', async () => {
      const handlers = createAdminAuditLogHandlers(createDeps());
      const { req, res, status, json } = createReqRes({ user: undefined });
      await handlers.listAuditLog(req, res);
      expect(status).toHaveBeenCalledWith(401);
      expect(json).toHaveBeenCalledWith({ error: 'Authentication required' });
    });

    it('returns 200 with the page payload', async () => {
      const page = mockPage({ entries: [mockEntry()], total: 1, nextCursor: 5 });
      const deps = createDeps({ listAuditLogPage: jest.fn().mockResolvedValue(page) });
      const handlers = createAdminAuditLogHandlers(deps);
      const { req, res, status, json } = createReqRes();
      await handlers.listAuditLog(req, res);
      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith(page);
    });

    it('rejects malformed `from` with 400', async () => {
      const deps = createDeps();
      const handlers = createAdminAuditLogHandlers(deps);
      const { req, res, status, json } = createReqRes({ query: { from: '2025-01-01 10:00' } });
      await handlers.listAuditLog(req, res);
      expect(status).toHaveBeenCalledWith(400);
      expect(json.mock.calls[0][0].error).toMatch(/from/);
      expect(deps.listAuditLogPage).not.toHaveBeenCalled();
    });

    it('rejects local-time ISO without a zone offset', async () => {
      const handlers = createAdminAuditLogHandlers(createDeps());
      const { req, res, status } = createReqRes({ query: { to: '2025-01-01T10:00:00' } });
      await handlers.listAuditLog(req, res);
      expect(status).toHaveBeenCalledWith(400);
    });

    it('accepts ISO timestamps with a `+HH:MM` offset', async () => {
      const handlers = createAdminAuditLogHandlers(createDeps());
      const { req, res, status } = createReqRes({ query: { from: '2025-01-01T10:00:00+02:00' } });
      await handlers.listAuditLog(req, res);
      expect(status).toHaveBeenCalledWith(200);
    });

    it('widens a date-only `to` filter to the end of the day UTC', async () => {
      const deps = createDeps();
      const handlers = createAdminAuditLogHandlers(deps);
      const { req, res } = createReqRes({ query: { to: '2025-01-15' } });
      await handlers.listAuditLog(req, res);
      const filtersArg = (deps.listAuditLogPage as jest.Mock).mock.calls[0][1];
      expect((filtersArg.to as Date).toISOString()).toBe('2025-01-15T23:59:59.999Z');
    });

    it('rejects an inverted date range with 400', async () => {
      const handlers = createAdminAuditLogHandlers(createDeps());
      const { req, res, status } = createReqRes({
        query: { from: '2025-02-01', to: '2025-01-01' },
      });
      await handlers.listAuditLog(req, res);
      expect(status).toHaveBeenCalledWith(400);
    });

    it('rejects an out-of-range date-only value instead of normalizing it', async () => {
      const deps = createDeps();
      const handlers = createAdminAuditLogHandlers(deps);
      const { req, res, status } = createReqRes({ query: { from: '2025-02-31' } });
      await handlers.listAuditLog(req, res);
      expect(status).toHaveBeenCalledWith(400);
      expect(deps.listAuditLogPage).not.toHaveBeenCalled();
    });

    it('rejects an out-of-range day in a full ISO timestamp', async () => {
      const deps = createDeps();
      const handlers = createAdminAuditLogHandlers(deps);
      const { req, res, status } = createReqRes({ query: { to: '2025-02-31T00:00:00Z' } });
      await handlers.listAuditLog(req, res);
      expect(status).toHaveBeenCalledWith(400);
      expect(deps.listAuditLogPage).not.toHaveBeenCalled();
    });

    it.each([
      ['action', { action: 'nope' }],
      ['category', { category: 'nope' }],
      ['outcome', { outcome: 'nope' }],
      ['severity', { severity: 'nope' }],
      ['actorType', { actorType: 'nope' }],
    ])('rejects an unknown %s value with 400', async (_label, query) => {
      const handlers = createAdminAuditLogHandlers(createDeps());
      const { req, res, status } = createReqRes({ query });
      await handlers.listAuditLog(req, res);
      expect(status).toHaveBeenCalledWith(400);
    });

    it('passes a multi-value action filter through as an array', async () => {
      const deps = createDeps();
      const handlers = createAdminAuditLogHandlers(deps);
      const { req, res } = createReqRes({
        query: { action: ['grant.assigned', 'grant.removed'] },
      });
      await handlers.listAuditLog(req, res);
      const filtersArg = (deps.listAuditLogPage as jest.Mock).mock.calls[0][1];
      expect(filtersArg.action).toEqual(['grant.assigned', 'grant.removed']);
    });

    it('rejects limit over the cap, negative offset, and cursor < 1', async () => {
      const handlers = createAdminAuditLogHandlers(createDeps());
      const over = createReqRes({ query: { limit: '600' } });
      await handlers.listAuditLog(over.req, over.res);
      expect(over.status).toHaveBeenCalledWith(400);

      const neg = createReqRes({ query: { offset: '-1' } });
      await handlers.listAuditLog(neg.req, neg.res);
      expect(neg.status).toHaveBeenCalledWith(400);

      const badCursor = createReqRes({ query: { cursor: '0' } });
      await handlers.listAuditLog(badCursor.req, badCursor.res);
      expect(badCursor.status).toHaveBeenCalledWith(400);
    });

    it('passes limit/offset/cursor through to the data layer', async () => {
      const deps = createDeps();
      const handlers = createAdminAuditLogHandlers(deps);
      const { req, res } = createReqRes({ query: { limit: '10', cursor: '42' } });
      await handlers.listAuditLog(req, res);
      const filtersArg = (deps.listAuditLogPage as jest.Mock).mock.calls[0][1];
      expect(filtersArg.limit).toBe(10);
      expect(filtersArg.cursor).toBe(42);
    });

    it('sources tenant scope from the JWT and ignores a forged ?tenantId', async () => {
      const deps = createDeps();
      const handlers = createAdminAuditLogHandlers(deps);
      const req = {
        params: {},
        query: { tenantId: 'forged-tenant' },
        body: {},
        user: { _id: new Types.ObjectId(), role: 'admin', tenantId: 'real-tenant' },
      } as unknown as ServerRequest;
      const json = jest.fn();
      const res = { status: jest.fn().mockReturnValue({ json }), json } as unknown as Response;
      await handlers.listAuditLog(req, res);
      expect((deps.listAuditLogPage as jest.Mock).mock.calls[0][0]).toBe('real-tenant');
    });

    it('returns 500 when the data layer throws', async () => {
      const deps = createDeps({
        listAuditLogPage: jest.fn().mockRejectedValue(new Error('db down')),
      });
      const handlers = createAdminAuditLogHandlers(deps);
      const { req, res, status } = createReqRes();
      await handlers.listAuditLog(req, res);
      expect(status).toHaveBeenCalledWith(500);
    });
  });

  describe('getAuditLogEntry', () => {
    it('returns 401 when unauthenticated', async () => {
      const handlers = createAdminAuditLogHandlers(createDeps());
      const { req, res, status } = createReqRes({ user: undefined, params: { id: validObjectId } });
      await handlers.getAuditLogEntry(req, res);
      expect(status).toHaveBeenCalledWith(401);
    });

    it('returns 400 for a non-ObjectId id', async () => {
      const handlers = createAdminAuditLogHandlers(createDeps());
      const { req, res, status } = createReqRes({ params: { id: 'nope' } });
      await handlers.getAuditLogEntry(req, res);
      expect(status).toHaveBeenCalledWith(400);
    });

    it('returns 404 when not found', async () => {
      const handlers = createAdminAuditLogHandlers(createDeps());
      const { req, res, status } = createReqRes({ params: { id: validObjectId } });
      await handlers.getAuditLogEntry(req, res);
      expect(status).toHaveBeenCalledWith(404);
    });

    it('returns 200 with the entry', async () => {
      const entry = mockEntry();
      const deps = createDeps({ findAuditLogEntry: jest.fn().mockResolvedValue(entry) });
      const handlers = createAdminAuditLogHandlers(deps);
      const { req, res, status, json } = createReqRes({ params: { id: validObjectId } });
      await handlers.getAuditLogEntry(req, res);
      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ entry });
    });
  });

  describe('verifyAuditLog', () => {
    it('returns 401 when unauthenticated', async () => {
      const handlers = createAdminAuditLogHandlers(createDeps());
      const { req, res, status } = createReqRes({ user: undefined });
      await handlers.verifyAuditLog(req, res);
      expect(status).toHaveBeenCalledWith(401);
    });

    it('returns the verification result scoped to the caller tenant', async () => {
      const verification = mockVerification({ ok: false, brokenAt: 2, reason: 'hash mismatch' });
      const deps = createDeps({ verifyAuditChain: jest.fn().mockResolvedValue(verification) });
      const handlers = createAdminAuditLogHandlers(deps);
      const { req, res, status, json } = createReqRes({
        user: { _id: new Types.ObjectId(), role: 'admin', tenantId: 'real-tenant' },
      });
      await handlers.verifyAuditLog(req, res);
      expect((deps.verifyAuditChain as jest.Mock).mock.calls[0][0]).toBe('real-tenant');
      expect((deps.verifyAuditChain as jest.Mock).mock.calls[0][1].maxRows).toBe(
        MAX_AUDIT_VERIFY_ROWS,
      );
      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith(verification);
    });

    it('threads cancellation into verification and skips the response after client close', async () => {
      const ctx = createReqRes();
      const deps = createDeps({
        verifyAuditChain: jest.fn(async (_tenantId, options) => {
          ctx.emitter.emit('close');
          options?.isCancelled?.();
          return mockVerification({ ok: false, reason: 'verification cancelled' });
        }),
      });
      const handlers = createAdminAuditLogHandlers(deps);
      await handlers.verifyAuditLog(ctx.req, ctx.res);
      const optionsArg = (deps.verifyAuditChain as jest.Mock).mock.calls[0][1];
      expect(optionsArg.isCancelled()).toBe(true);
      expect(ctx.status).not.toHaveBeenCalled();
    });

    it('returns 500 when verification throws', async () => {
      const deps = createDeps({
        verifyAuditChain: jest.fn().mockRejectedValue(new Error('boom')),
      });
      const handlers = createAdminAuditLogHandlers(deps);
      const { req, res, status } = createReqRes();
      await handlers.verifyAuditLog(req, res);
      expect(status).toHaveBeenCalledWith(500);
    });
  });

  describe('exportAuditLogCsv', () => {
    function streamFrom(entries: AdminAuditLogEntry[]): AdminAuditLogDeps['streamAuditLogEntries'] {
      return jest.fn(async (_tenantId, _filters, onEntry, options) => {
        let count = 0;
        for (const entry of entries) {
          if (options?.isCancelled?.()) break;
          await onEntry(entry);
          count++;
        }
        return { count, truncated: false };
      });
    }

    it('returns 401 when unauthenticated', async () => {
      const ctx = createCsvContext({ user: undefined });
      const handlers = createAdminAuditLogHandlers(createDeps());
      await handlers.exportAuditLogCsv(ctx.req, ctx.res);
      expect(ctx.res.status as jest.Mock).toHaveBeenCalledWith(401);
    });

    it('writes a BOM, header row, and CRLF line endings', async () => {
      const deps = createDeps({ streamAuditLogEntries: streamFrom([mockEntry()]) });
      const handlers = createAdminAuditLogHandlers(deps);
      const ctx = createCsvContext();
      await handlers.exportAuditLogCsv(ctx.req, ctx.res);
      expect(ctx.chunks[0]).toBe('﻿');
      expect(ctx.chunks[1]).toContain('Timestamp');
      expect(ctx.chunks[1]).toContain('Hash');
      expect(ctx.chunks[2]).toBe('\r\n');
      expect(ctx.endCalled()).toBe(true);
    });

    it('defangs formula-injection cells and quotes special characters', async () => {
      const entry = mockEntry({
        actor: { type: 'user', id: 'x', name: '=cmd()' },
        target: { type: 'role', id: 'r', name: 'Ops, North' },
      });
      const deps = createDeps({ streamAuditLogEntries: streamFrom([entry]) });
      const handlers = createAdminAuditLogHandlers(deps);
      const ctx = createCsvContext();
      await handlers.exportAuditLogCsv(ctx.req, ctx.res);
      const body = ctx.chunks.join('');
      expect(body).toContain("'=cmd()");
      expect(body).toContain('"Ops, North"');
    });

    it('threads cancellation and a row cap into the stream', async () => {
      const deps = createDeps();
      const handlers = createAdminAuditLogHandlers(deps);
      const ctx = createCsvContext();
      const promise = handlers.exportAuditLogCsv(ctx.req, ctx.res);
      ctx.emitClose();
      await promise;
      const streamMock = deps.streamAuditLogEntries as jest.Mock;
      const optionsArg = streamMock.mock.calls[0][3];
      expect(optionsArg.isCancelled()).toBe(true);
      expect(optionsArg.maxRows).toBeGreaterThan(0);
    });

    it('returns 400 on malformed filters before streaming', async () => {
      const deps = createDeps();
      const handlers = createAdminAuditLogHandlers(deps);
      const ctx = createCsvContext({ query: { from: 'garbage' } });
      await handlers.exportAuditLogCsv(ctx.req, ctx.res);
      expect(ctx.res.status as jest.Mock).toHaveBeenCalledWith(400);
      expect(deps.streamAuditLogEntries).not.toHaveBeenCalled();
    });

    it('appends an explicit marker when the export is truncated', async () => {
      const deps = createDeps({
        streamAuditLogEntries: jest
          .fn()
          .mockResolvedValue({ count: MAX_AUDIT_EXPORT_ROWS, truncated: true }),
      });
      const handlers = createAdminAuditLogHandlers(deps);
      const ctx = createCsvContext();
      await handlers.exportAuditLogCsv(ctx.req, ctx.res);
      expect(ctx.chunks.join('')).toContain('TRUNCATED');
      expect(ctx.endCalled()).toBe(true);
    });

    it('does not mark an exact-cap export as truncated', async () => {
      const deps = createDeps({
        streamAuditLogEntries: jest
          .fn()
          .mockResolvedValue({ count: MAX_AUDIT_EXPORT_ROWS, truncated: false }),
      });
      const handlers = createAdminAuditLogHandlers(deps);
      const ctx = createCsvContext();
      await handlers.exportAuditLogCsv(ctx.req, ctx.res);
      expect(ctx.chunks.join('')).not.toContain('TRUNCATED');
      expect(ctx.endCalled()).toBe(true);
    });
  });
});
