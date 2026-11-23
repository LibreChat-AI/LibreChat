import Redis from 'ioredis';
import http from 'node:http';
import type { SubagentTaskControlHandler } from './subagentTaskRouting';
import type { RespServer } from '~/cache/__tests__/resp.helper';
import {
  RedisSubagentTaskControlTransport,
  SubagentTaskOwnerUnavailableError,
} from './subagentTaskRouting';
import {
  setupGracefulShutdown,
  registerShutdownTask,
  __resetShutdownStateForTests,
} from '~/app/shutdown';
import { createIoRedisSubscriber, duplicateIoRedisClient } from '~/cache/redisUtils';
import { startRespServer, waitFor } from '~/cache/__tests__/resp.helper';

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils/math'),
  ...jest.requireActual('~/utils/common'),
}));

const handler: SubagentTaskControlHandler = {
  claim: () => ({ status: 'not_found' }),
  control: () => ({ status: 'not_found' }),
  list: () => [],
  retainsTaskOwnership: () => false,
  cancelScope: () => 0,
};
const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGQUIT', 'SIGHUP'];

describe('Redis task-routing lifecycle', () => {
  let server: RespServer;
  let shared: Redis;
  let publisher: Redis;
  let subscriber: Redis;
  let transport: RedisSubagentTaskControlTransport;
  let shutdownExit: jest.SpyInstance | undefined;
  let originalListeners: Map<NodeJS.Signals, NodeJS.SignalsListener[]>;

  beforeEach(async () => {
    originalListeners = new Map(signals.map((signal) => [signal, process.listeners(signal)]));
    __resetShutdownStateForTests();
    shutdownExit = undefined;
    server = await startRespServer();
    shared = new Redis(server.url, {
      maxRetriesPerRequest: 0,
      autoResendUnfulfilledCommands: false,
      retryStrategy: () => 20,
    });
    shared.on('error', () => undefined);
    await waitFor(() => shared.status === 'ready');
    publisher = duplicateIoRedisClient(shared, { enableOfflineQueue: false }) as Redis;
    publisher.on('error', () => undefined);
    subscriber = createIoRedisSubscriber(shared, 'task-lifecycle-subscriber') as Redis;
    transport = new RedisSubagentTaskControlTransport(publisher, subscriber);
  });

  afterEach(async () => {
    try {
      await transport.destroy();
      subscriber.disconnect();
      publisher.disconnect();
      shared.disconnect();
      await server.close();
      await new Promise((resolve) => setImmediate(resolve));
      if (shutdownExit) await waitFor(() => shutdownExit!.mock.calls.length === 1, 500);
    } finally {
      __resetShutdownStateForTests();
      for (const signal of signals) {
        for (const listener of process.listeners(signal)) {
          if (!originalListeners.get(signal)?.includes(listener)) {
            process.removeListener(signal, listener);
          }
        }
      }
      shutdownExit?.mockRestore();
    }
  });

  it('cancels a readiness wait when destroyed without closing its borrowed publisher', async () => {
    await waitFor(() => publisher.status === 'ready' && subscriber.status === 'ready');
    await server.close();
    await waitFor(
      () => publisher.status === 'reconnecting' && subscriber.status === 'reconnecting',
    );
    const publisherDisconnect = jest.spyOn(publisher, 'disconnect');
    const publisherOnce = jest.spyOn(publisher, 'once');
    const subscriberOnce = jest.spyOn(subscriber, 'once');
    let result: unknown;
    void transport.bind(handler).then(
      () => {
        result = 'bound';
      },
      (error: unknown) => {
        result = error;
      },
    );

    const readinessListeners = [publisherOnce, subscriberOnce].map((spy) =>
      spy.mock.calls.filter(([event]) => event === 'ready' || event === 'end'),
    );
    let destroyed = false;
    void transport.destroy().then(() => {
      destroyed = true;
    });
    await waitFor(() => result != null && destroyed, 500);

    expect(result).toBeInstanceOf(SubagentTaskOwnerUnavailableError);
    for (const [index, client] of [publisher, subscriber].entries()) {
      for (const [event, listener] of readinessListeners[index]) {
        expect(client.listeners(event)).not.toContain(listener);
      }
    }
    expect(publisherDisconnect).not.toHaveBeenCalled();
  });

  it('does not subscribe when readiness resolves just before destruction', async () => {
    await waitFor(() => publisher.status === 'ready' && subscriber.status === 'ready');
    const subscribe = jest.spyOn(subscriber, 'subscribe');
    const binding = transport.bind(handler).then(
      () => 'bound',
      (error: unknown) => error,
    );

    await transport.destroy();

    expect(await binding).toBeInstanceOf(SubagentTaskOwnerUnavailableError);
    expect(subscribe).not.toHaveBeenCalled();
    expect(subscriber.listenerCount('message')).toBe(0);
    await expect(publisher.ping()).resolves.toBe('PONG');
  });

  it('cancels an unacknowledged initial subscription on destruction', async () => {
    await waitFor(() => publisher.status === 'ready' && subscriber.status === 'ready');
    server.silent = true;
    let result: unknown;
    void transport.bind(handler).then(
      () => {
        result = 'bound';
      },
      (error: unknown) => {
        result = error;
      },
    );
    await waitFor(() => server.commands.some((frame) => frame[0] === 'subscribe'));

    let destroyed = false;
    void transport.destroy().then(() => {
      destroyed = true;
    });
    await waitFor(() => result != null && destroyed, 500);

    expect(result).toBeInstanceOf(SubagentTaskOwnerUnavailableError);
    expect(subscriber.listenerCount('message')).toBe(0);
  });

  it('stops its heartbeat on intentional disconnect even when the closed socket emits no end', async () => {
    await transport.bind(handler);
    await server.close();
    await waitFor(() => subscriber.status === 'reconnecting');
    const listeners = subscriber.listenerCount('end');
    expect(listeners).toBeGreaterThan(0);

    subscriber.disconnect(true);
    expect(subscriber.listenerCount('end')).toBe(listeners);
    subscriber.disconnect();

    expect(subscriber.listenerCount('end')).toBe(listeners - 1);
  });

  it('allows later shutdown tasks to run while Redis is unreachable', async () => {
    await transport.bind(handler);
    await server.close();
    await waitFor(() => subscriber.status === 'reconnecting');
    const steps: string[] = [];
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    shutdownExit = exit;
    registerShutdownTask(
      'generation job manager',
      () => {
        steps.push('generation');
      },
      { priority: 100 },
    );
    registerShutdownTask(
      'subagent task store',
      async () => {
        await transport.destroy();
        publisher.disconnect();
        steps.push('task-routing');
      },
      { priority: 90 },
    );
    registerShutdownTask(
      'favorites persistence',
      () => {
        steps.push('favorites');
      },
      { priority: -100 },
    );
    setupGracefulShutdown(http.createServer());

    const listener = process
      .listeners('SIGTERM')
      .find(
        (entry) => !originalListeners.get('SIGTERM')?.includes(entry),
      ) as NodeJS.SignalsListener;
    listener('SIGTERM');
    await waitFor(() => exit.mock.calls.length === 1, 500);

    expect(steps).toEqual(['generation', 'task-routing', 'favorites']);
    expect(exit).toHaveBeenCalledWith(0);
    await transport.destroy();
  });
});
