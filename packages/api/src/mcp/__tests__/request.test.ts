import { EventEmitter } from 'events';
import { logger } from '@librechat/data-schemas';

import {
  createMCPRuntimeRequestBody,
  createMCPRequestContext,
  getMCPRequestSignal,
  retainMCPRequestContext,
  quiesceMCPRequestContext,
  cleanupMCPRequestContext,
  getMCPRequestContext,
  cleanupMCPRequestContextForReq,
} from '~/mcp/request';
import { getMissingRuntimeBodyPlaceholderFields } from '~/mcp/utils';

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    warn: jest.fn(),
  },
}));

function createResponse({ ended = false } = {}): EventEmitter & {
  writableEnded: boolean;
  finished: boolean;
  destroyed: boolean;
} {
  const res = new EventEmitter() as EventEmitter & {
    writableEnded: boolean;
    finished: boolean;
    destroyed: boolean;
  };
  res.writableEnded = ended;
  res.finished = ended;
  res.destroyed = false;
  return res;
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('MCP request context', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not create a response-scoped context after the response has finished', () => {
    const req = {};
    const res = createResponse({ ended: true });

    expect(getMCPRequestContext(req, res)).toBeUndefined();
  });

  it('keeps job-scoped contexts alive after response finish until explicit cleanup', async () => {
    const req = {};
    const res = createResponse();
    const context = getMCPRequestContext(req, undefined, { cleanupOnResponse: false });
    const disconnect = jest.fn().mockResolvedValue(undefined);
    context?.connections.set('server', { disconnect });

    expect(getMCPRequestContext(req, res)).toBe(context);

    res.emit('finish');
    await nextTick();

    expect(disconnect).not.toHaveBeenCalled();

    await cleanupMCPRequestContextForReq(req);

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(context?.connections.size).toBe(0);
    expect(context?.pending.size).toBe(0);
  });

  it('cleans response-scoped contexts when the response finishes', async () => {
    const req = {};
    const res = createResponse();
    const context = getMCPRequestContext(req, res);
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const dispose = jest.fn().mockResolvedValue(undefined);
    const pendingDisconnect = jest.fn().mockResolvedValue(undefined);
    const pendingDispose = jest.fn().mockResolvedValue(undefined);

    context?.connections.set('server', { disconnect, dispose });
    context?.pending.set(
      'pending-server',
      Promise.resolve({ disconnect: pendingDisconnect, dispose: pendingDispose }),
    );

    res.emit('finish');
    await nextTick();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(pendingDispose).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
    expect(pendingDisconnect).not.toHaveBeenCalled();
    expect(context?.connections.size).toBe(0);
    expect(context?.pending.size).toBe(0);
  });

  it('uses the lifecycle disposer supplied by the connection manager', async () => {
    const req = {};
    const res = createResponse();
    const context = getMCPRequestContext(req, res);
    const connection = { disconnect: jest.fn().mockResolvedValue(undefined) };
    const disposeConnection = jest.fn().mockResolvedValue(undefined);
    if (context) {
      context.disposeConnection = disposeConnection;
      context.connections.set('user:server', connection);
    }

    res.emit('close');
    await nextTick();

    expect(disposeConnection).toHaveBeenCalledWith('user:server', connection);
    expect(connection.disconnect).not.toHaveBeenCalled();
  });
});

describe('retained MCP request contexts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns from parent cleanup without closing either child owner', async () => {
    const req = {};
    const res = createResponse();
    const context = getMCPRequestContext(req, res)!;
    const signal = getMCPRequestSignal(context);
    const disconnect = jest.fn().mockResolvedValue(undefined);
    context.connections.set('server', { disconnect });
    const releaseFirst = retainMCPRequestContext(context);
    const releaseSecond = retainMCPRequestContext(context);

    res.writableEnded = true;
    res.emit('finish');
    await cleanupMCPRequestContextForReq(req);

    expect(context.cleanupStarted).toBe(false);
    expect(signal.aborted).toBe(false);
    expect(getMCPRequestContext(req, res)).toBe(context);
    expect(disconnect).not.toHaveBeenCalled();

    expect(releaseFirst()).toBeUndefined();
    releaseFirst();
    res.emit('close');
    await cleanupMCPRequestContextForReq(req);
    expect(context.cleanupStarted).toBe(false);
    expect(disconnect).not.toHaveBeenCalled();

    expect(releaseSecond()).toBeUndefined();
    expect(context.cleanupStarted).toBe(true);
    expect(signal.aborted).toBe(true);
    await cleanupMCPRequestContext(context);
    releaseSecond();
    await cleanupMCPRequestContextForReq(req);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(context.connections.size).toBe(0);
    expect(context.pending.size).toBe(0);
  });

  it('includes a child connection opened lazily after parent cleanup was requested', async () => {
    const context = createMCPRequestContext();
    const release = retainMCPRequestContext(context);
    await cleanupMCPRequestContext(context);

    const connection = { disconnect: jest.fn().mockResolvedValue(undefined) };
    let resolve!: (value: typeof connection) => void;
    context.pending.set(
      'late-server',
      new Promise<typeof connection>((settle) => {
        resolve = settle;
      }),
    );
    release();
    await nextTick();
    expect(connection.disconnect).not.toHaveBeenCalled();

    resolve(connection);
    await cleanupMCPRequestContext(context);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(context.pending.size).toBe(0);
  });

  it('returns from parent cleanup without waiting for a pending child connection', async () => {
    const context = {
      connections: new Map<string, unknown>(),
      pending: new Map<string, Promise<unknown>>(),
    };
    const connection = { disconnect: jest.fn().mockResolvedValue(undefined) };
    let resolve!: (value: typeof connection) => void;
    context.pending.set(
      'pending-server',
      new Promise<typeof connection>((settle) => {
        resolve = settle;
      }),
    );
    const signal = getMCPRequestSignal(context);
    const release = retainMCPRequestContext(context);

    await expect(
      Promise.race([
        cleanupMCPRequestContext(context).then(() => 'returned'),
        nextTick().then(() => 'blocked'),
      ]),
    ).resolves.toBe('returned');
    expect(signal.aborted).toBe(false);
    expect(context.pending.size).toBe(1);

    release();
    expect(signal.aborted).toBe(true);
    resolve(connection);
    await cleanupMCPRequestContext(context);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(context.pending.size).toBe(0);
  });

  it('does not close a context released before parent cleanup', async () => {
    const context = createMCPRequestContext();
    const signal = getMCPRequestSignal(context);
    const disconnect = jest.fn().mockResolvedValue(undefined);
    context.connections.set('server', { disconnect });
    const release = retainMCPRequestContext(context);

    release();
    release();
    await nextTick();
    expect(context.cleanupStarted).toBe(false);
    expect(signal.aborted).toBe(false);
    expect(disconnect).not.toHaveBeenCalled();

    const releaseAgain = retainMCPRequestContext(context);
    releaseAgain();
    await cleanupMCPRequestContext(context);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'quiesces immediately with child owners (parent cleanup requested: %s)',
    async (cleanupRequested) => {
      const context = createMCPRequestContext();
      const signal = getMCPRequestSignal(context);
      const disconnect = jest.fn().mockResolvedValue(undefined);
      context.connections.set('server', { disconnect });
      context.pending.set(
        'resolver',
        new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        ),
      );
      const releaseFirst = retainMCPRequestContext(context);
      const releaseSecond = retainMCPRequestContext(context);
      if (cleanupRequested) await cleanupMCPRequestContext(context);

      const closing = quiesceMCPRequestContext(context);
      expect(context.cleanupStarted).toBe(true);
      expect(context.quiesceStarted).toBe(true);
      expect(signal.aborted).toBe(true);
      expect(() => retainMCPRequestContext(context)).toThrow('MCP request has settled.');
      await closing;
      expect(disconnect).toHaveBeenCalledTimes(1);

      releaseFirst();
      releaseSecond();
      await cleanupMCPRequestContext(context);
      expect(disconnect).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves strict admission failure when quiescing a retained context', async () => {
    const context = createMCPRequestContext();
    const failure = Object.assign(new Error('generation retired'), { name: 'AbortError' });
    const dispose = jest.fn().mockRejectedValue(failure);
    context.connections.set('server', { disconnect: jest.fn(), dispose });
    const release = retainMCPRequestContext(context);
    await cleanupMCPRequestContext(context);

    await expect(quiesceMCPRequestContext(context)).rejects.toBe(failure);
    release();
    await nextTick();
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(quiesceMCPRequestContext(context)).rejects.toBe(failure);
  });

  it('allows an active child to retain a nested task after parent cleanup is requested', async () => {
    const context = createMCPRequestContext();
    const disconnect = jest.fn().mockResolvedValue(undefined);
    context.connections.set('server', { disconnect });
    const releaseChild = retainMCPRequestContext(context);
    await cleanupMCPRequestContext(context);

    expect(context.cleanupStarted).toBe(false);
    const releaseNested = retainMCPRequestContext(context);
    releaseChild();
    await nextTick();
    expect(context.cleanupStarted).toBe(false);
    expect(disconnect).not.toHaveBeenCalled();

    releaseNested();
    expect(context.cleanupStarted).toBe(true);
    expect(() => retainMCPRequestContext(context)).toThrow('MCP request has settled.');
    await cleanupMCPRequestContext(context);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it.each(['cleanup', 'quiesce'] as const)('rejects new owners after %s starts', async (mode) => {
    const context = createMCPRequestContext();
    const closing =
      mode === 'cleanup' ? cleanupMCPRequestContext(context) : quiesceMCPRequestContext(context);

    expect(() => retainMCPRequestContext(context)).toThrow('MCP request has settled.');
    await closing;
    expect(() => retainMCPRequestContext(context)).toThrow('MCP request has settled.');
  });

  it.each(['release', 'quiesce'] as const)(
    'keeps the original scope for lazy request lookups without reopening it after %s',
    async (cutoff) => {
      const req = {};
      const context = getMCPRequestContext(req)!;
      const release = retainMCPRequestContext(context);

      await cleanupMCPRequestContextForReq(req);
      expect(getMCPRequestContext(req)).toBe(context);
      expect(getMCPRequestContext(req, undefined, { cleanupOnResponse: false })).toBe(context);
      await cleanupMCPRequestContextForReq(req);
      expect(getMCPRequestContext(req)).toBe(context);

      if (cutoff === 'quiesce') await quiesceMCPRequestContext(context);
      else release();
      expect(getMCPRequestContext(req)).toBeUndefined();
      await cleanupMCPRequestContextForReq(req);
      expect(getMCPRequestContext(req)).toBeUndefined();
      expect(getMCPRequestContext(req, undefined, { cleanupOnResponse: false })).toBeUndefined();
      release();
    },
  );

  it('preserves request reuse for contexts that were never retained', async () => {
    const req = {};
    const context = getMCPRequestContext(req)!;
    await cleanupMCPRequestContextForReq(req);

    const replacement = getMCPRequestContext(req);
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(context);
    await cleanupMCPRequestContextForReq(req);
  });

  it('logs asynchronous disposal failure without rejecting the synchronous release', async () => {
    const context = createMCPRequestContext();
    const dispose = jest.fn().mockRejectedValue(new Error('disposal failed'));
    context.connections.set('server', { disconnect: jest.fn(), dispose });
    const release = retainMCPRequestContext(context);
    await cleanupMCPRequestContext(context);

    expect(release()).toBeUndefined();
    await nextTick();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '[MCP Request Context] Failed to dispose request-scoped connection',
    );
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(context.connections.size).toBe(0);
  });
});

describe('MCP runtime request body', () => {
  it('preserves a supplied parent message id', () => {
    expect(
      createMCPRuntimeRequestBody({
        messageId: 'response-1',
        conversationId: 'conversation-1',
        parentMessageId: 'parent-1',
      }),
    ).toEqual({
      messageId: 'response-1',
      conversationId: 'conversation-1',
      parentMessageId: 'parent-1',
    });
  });

  it('uses the root-turn parent sentinel for an explicit root parent', () => {
    expect(
      createMCPRuntimeRequestBody({
        messageId: 'response-1',
        conversationId: 'conversation-1',
        parentMessageId: null,
      }),
    ).toEqual(expect.objectContaining({ parentMessageId: '00000000-0000-0000-0000-000000000000' }));
  });

  it('leaves the parent absent when the protocol cannot supply that identity', () => {
    const requestBody = createMCPRuntimeRequestBody({
      messageId: 'response-1',
      conversationId: 'conversation-1',
    });

    expect(requestBody).toEqual({ messageId: 'response-1', conversationId: 'conversation-1' });
    expect(
      getMissingRuntimeBodyPlaceholderFields(
        {
          source: 'yaml',
          headers: { 'X-Parent': '{{LIBRECHAT_BODY_PARENTMESSAGEID}}' },
        },
        requestBody,
      ),
    ).toEqual(['parentMessageId']);
  });
});

describe('strict occurrence completion', () => {
  it('joins cleanup and propagates fenced admission after disposing every connection', async () => {
    const context = createMCPRequestContext();
    const failure = Object.assign(new Error('generation retired'), { name: 'AbortError' });
    let reject!: (error: Error) => void;
    const admission = new Promise<void>((_, fail) => {
      reject = fail;
    });
    const first = { disconnect: jest.fn(), dispose: jest.fn(() => admission) };
    const second = { disconnect: jest.fn(), dispose: jest.fn(async () => undefined) };
    context.connections.set('first', first);
    context.connections.set('second', second);
    const observe = quiesceMCPRequestContext(context).catch((error) => error);
    const cleanup = cleanupMCPRequestContext(context);
    expect(context.quiesceStarted).toBe(true);
    reject(failure);
    await expect(observe).resolves.toBe(failure);
    await cleanup;
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).toHaveBeenCalledTimes(1);
    expect(context.connections.size).toBe(0);
    await expect(quiesceMCPRequestContext(context)).rejects.toBe(failure);
  });
});

it.each(['cleanup', 'quiesce'] as const)(
  'aborts %s-owned resolver waits before joining the pending context',
  async (mode) => {
    const context = createMCPRequestContext();
    const other = createMCPRequestContext();
    const signal = getMCPRequestSignal(context);
    const otherSignal = getMCPRequestSignal(other);
    context.pending.set(
      'resolver',
      new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      ),
    );
    const closing =
      mode === 'cleanup' ? cleanupMCPRequestContext(context) : quiesceMCPRequestContext(context);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toMatchObject({ name: 'AbortError' });
    expect(otherSignal.aborted).toBe(false);
    await Promise.all([closing, quiesceMCPRequestContext(context)]);
    expect(context.pending.size).toBe(0);
    expect(getMCPRequestSignal(context)).toBe(signal);
  },
);

it('publishes a joinable cutoff before cancellation listeners can request cleanup again', async () => {
  const context = createMCPRequestContext();
  const signal = getMCPRequestSignal(context);
  const dispose = jest.fn(async () => undefined);
  context.connections.set('server', { disconnect: jest.fn(), dispose });
  let nested: Promise<void> | undefined;
  signal.addEventListener(
    'abort',
    () => {
      expect(context.cleanupStarted).toBe(true);
      nested = quiesceMCPRequestContext(context);
    },
    { once: true },
  );
  const first = quiesceMCPRequestContext(context);
  expect(nested).toBe(first);
  await first;
  expect(dispose).toHaveBeenCalledTimes(1);
});
