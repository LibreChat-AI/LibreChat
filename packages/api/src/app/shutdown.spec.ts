/// <reference types="jest" />
import http from 'http';
import {
  setupGracefulShutdown,
  isShutdownInProgress,
  registerShutdownTask,
  getClusterShutdownBudgetMs,
  __resetShutdownStateForTests,
} from './shutdown';

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const triggerSignal = (signal: NodeJS.Signals): void => {
  const listeners = process.listeners(signal) as NodeJS.SignalsListener[];
  listeners.forEach((listener) => listener(signal));
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('getClusterShutdownBudgetMs', () => {
  it('prefers the primary force-exit deadline over the worker timer', () => {
    expect(
      getClusterShutdownBudgetMs({
        deadlineAt: 14_000,
        forceExitMs: 30_000,
        remainingMs: 60_000,
        elapsedMs: 1_000,
        now: 10_000,
      }),
    ).toBe(4_000);
  });

  it('uses the elapsed estimate when the primary deadline was not received', () => {
    expect(
      getClusterShutdownBudgetMs({
        deadlineAt: null,
        forceExitMs: 30_000,
        remainingMs: 60_000,
        elapsedMs: 2_000,
      }),
    ).toBe(28_000);
  });

  it('honors the tighter local limit and requires an active shutdown', () => {
    expect(
      getClusterShutdownBudgetMs({
        deadlineAt: 15_000,
        forceExitMs: 30_000,
        remainingMs: 1_000,
        elapsedMs: 5_000,
        now: 10_000,
      }),
    ).toBe(1_000);
    expect(
      getClusterShutdownBudgetMs({
        deadlineAt: 15_000,
        forceExitMs: 30_000,
        remainingMs: null,
        elapsedMs: 5_000,
        now: 10_000,
      }),
    ).toBeNull();
  });
});

describe('setupGracefulShutdown', () => {
  let server: http.Server;
  let exitSpy: jest.SpyInstance;
  let originalSigterm: NodeJS.SignalsListener[];
  let originalSigint: NodeJS.SignalsListener[];
  let originalSigquit: NodeJS.SignalsListener[];
  let originalSighup: NodeJS.SignalsListener[];

  beforeEach(() => {
    server = http.createServer();
    // Most tests exercise the close path, so we fake `listening` to true.
    // Tests that want to exercise the not-listening short-circuit override
    // this back to false.
    Object.defineProperty(server, 'listening', { value: true, configurable: true });
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    originalSigterm = process.listeners('SIGTERM').slice() as NodeJS.SignalsListener[];
    originalSigint = process.listeners('SIGINT').slice() as NodeJS.SignalsListener[];
    originalSigquit = process.listeners('SIGQUIT').slice() as NodeJS.SignalsListener[];
    originalSighup = process.listeners('SIGHUP').slice() as NodeJS.SignalsListener[];
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGQUIT');
    process.removeAllListeners('SIGHUP');
    __resetShutdownStateForTests();
  });

  afterEach(() => {
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGQUIT');
    process.removeAllListeners('SIGHUP');
    originalSigterm.forEach((listener) => process.on('SIGTERM', listener));
    originalSigint.forEach((listener) => process.on('SIGINT', listener));
    originalSigquit.forEach((listener) => process.on('SIGQUIT', listener));
    originalSighup.forEach((listener) => process.on('SIGHUP', listener));
    exitSpy.mockRestore();
    if (server.listening) {
      server.close();
    }
    __resetShutdownStateForTests();
    jest.useRealTimers();
  });

  it('registers handlers for SIGTERM, SIGINT, SIGQUIT, and SIGHUP', () => {
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGQUIT', 'SIGHUP'] as NodeJS.Signals[]) {
      expect(process.listenerCount(signal)).toBe(0);
    }
    setupGracefulShutdown(server);
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGQUIT', 'SIGHUP'] as NodeJS.Signals[]) {
      expect(process.listenerCount(signal)).toBe(1);
    }
  });

  it('closes the server and exits 0 on SIGTERM', async () => {
    const closeSpy = jest
      .spyOn(server, 'close')
      .mockImplementation((cb?: (err?: Error) => void) => {
        if (cb) {
          setImmediate(() => cb());
        }
        return server;
      });
    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    await flush();
    await flush();
    expect(closeSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('closes the server and exits 0 on SIGINT', async () => {
    const closeSpy = jest
      .spyOn(server, 'close')
      .mockImplementation((cb?: (err?: Error) => void) => {
        if (cb) {
          setImmediate(() => cb());
        }
        return server;
      });
    setupGracefulShutdown(server);
    triggerSignal('SIGINT');
    await flush();
    await flush();
    expect(closeSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits 1 if server.close yields an error', async () => {
    const closeErr = new Error('close failed');
    jest.spyOn(server, 'close').mockImplementation((cb?: (err?: Error) => void) => {
      if (cb) {
        setImmediate(() => cb(closeErr));
      }
      return server;
    });
    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    await flush();
    await flush();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('treats ERR_SERVER_NOT_RUNNING from close() as a successful shutdown', async () => {
    const notRunning: NodeJS.ErrnoException = Object.assign(new Error('Server is not running.'), {
      code: 'ERR_SERVER_NOT_RUNNING',
    });
    // Force listening=true so the pre-check doesn't short-circuit;
    // we want to exercise the post-check that ignores ERR_SERVER_NOT_RUNNING.
    Object.defineProperty(server, 'listening', { value: true, configurable: true });
    jest.spyOn(server, 'close').mockImplementation((cb?: (err?: Error) => void) => {
      if (cb) {
        setImmediate(() => cb(notRunning));
      }
      return server;
    });
    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    await flush();
    await flush();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('skips close() entirely when the server is not listening yet', async () => {
    // SIGTERM during the startup window (before app.listen finishes binding
    // the socket) must not be treated as a failed shutdown.
    Object.defineProperty(server, 'listening', { value: false, configurable: true });
    const closeSpy = jest.spyOn(server, 'close');
    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    await flush();
    expect(closeSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('is idempotent — a second signal does not trigger another shutdown', async () => {
    const closeSpy = jest.spyOn(server, 'close');
    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    triggerSignal('SIGTERM');
    await flush();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('exposes shutdown state before pre-drain work begins', async () => {
    let observedDuringPreDrain = false;
    jest.spyOn(server, 'close').mockImplementation(() => server);
    registerShutdownTask(
      'observe-shutdown',
      () => {
        observedDuringPreDrain = isShutdownInProgress();
      },
      { phase: 'pre-drain' },
    );
    setupGracefulShutdown(server);

    expect(isShutdownInProgress()).toBe(false);
    triggerSignal('SIGTERM');
    await flush();

    expect(observedDuringPreDrain).toBe(true);
    expect(isShutdownInProgress()).toBe(true);
  });

  it('force-exits with code 1 if shutdown exceeds the timeout', () => {
    jest.useFakeTimers();
    jest.spyOn(server, 'close').mockImplementation(() => server);
    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    jest.advanceTimersByTime(60_000);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('runs registered tasks after server.close and before exit', async () => {
    const calls: string[] = [];
    jest.spyOn(server, 'close').mockImplementation((cb?: (err?: Error) => void) => {
      calls.push('server.close');
      if (cb) {
        setImmediate(() => cb());
      }
      return server;
    });
    registerShutdownTask('task-a', () => {
      calls.push('task-a');
    });
    registerShutdownTask('task-b', () => {
      calls.push('task-b');
    });
    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    await flush();
    await flush();
    expect(calls).toEqual(['server.close', 'task-a', 'task-b']);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('runs pre-drain tasks while server.close is pending, then post-drain tasks', async () => {
    const calls: string[] = [];
    let finishClose: (() => void) | undefined;
    jest.spyOn(server, 'close').mockImplementation((cb?: (err?: Error) => void) => {
      calls.push('server.close');
      finishClose = () => cb?.();
      return server;
    });
    registerShutdownTask(
      'release-held-close',
      () => {
        calls.push('pre-drain');
        finishClose?.();
      },
      { phase: 'pre-drain' },
    );
    registerShutdownTask('post-drain', () => {
      calls.push('post-drain');
    });

    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    await flush();
    await flush();

    expect(calls).toEqual(['server.close', 'pre-drain', 'post-drain']);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('runs tasks in registration order', async () => {
    const order: string[] = [];
    jest.spyOn(server, 'close').mockImplementation((cb?: (err?: Error) => void) => {
      if (cb) {
        setImmediate(() => cb());
      }
      return server;
    });
    ['first', 'second', 'third'].forEach((name) => {
      registerShutdownTask(name, () => {
        order.push(name);
      });
    });
    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    await flush();
    await flush();
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('runs higher-priority cleanup before telemetry while preserving ties', async () => {
    const order: string[] = [];
    jest.spyOn(server, 'close').mockImplementation((cb?: (err?: Error) => void) => {
      if (cb) {
        setImmediate(() => cb());
      }
      return server;
    });
    registerShutdownTask('default-first', () => {
      order.push('default-first');
    });
    registerShutdownTask(
      'telemetry',
      () => {
        order.push('telemetry');
      },
      { priority: -100 },
    );
    registerShutdownTask(
      'generation streams',
      () => {
        order.push('generation streams');
      },
      {
        priority: 100,
      },
    );
    registerShutdownTask('default-second', () => {
      order.push('default-second');
    });

    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    await flush();
    await flush();

    expect(order).toEqual(['generation streams', 'default-first', 'default-second', 'telemetry']);
  });

  it('continues subsequent tasks and exits nonzero if one task throws', async () => {
    const calls: string[] = [];
    jest.spyOn(server, 'close').mockImplementation((cb?: (err?: Error) => void) => {
      if (cb) {
        setImmediate(() => cb());
      }
      return server;
    });
    registerShutdownTask('ok-before', () => {
      calls.push('ok-before');
    });
    registerShutdownTask('throws', () => {
      calls.push('throws');
      throw new Error('boom');
    });
    registerShutdownTask('ok-after', () => {
      calls.push('ok-after');
    });
    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    await flush();
    await flush();
    expect(calls).toEqual(['ok-before', 'throws', 'ok-after']);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('awaits async tasks before exiting', async () => {
    const calls: string[] = [];
    jest.spyOn(server, 'close').mockImplementation((cb?: (err?: Error) => void) => {
      if (cb) {
        setImmediate(() => cb());
      }
      return server;
    });
    registerShutdownTask('async-task', async () => {
      await new Promise((resolve) => setImmediate(resolve));
      calls.push('async-done');
    });
    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    await flush();
    await flush();
    await flush();
    expect(calls).toEqual(['async-done']);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
  it('disarms the force-exit timer when shutdown state is reset', async () => {
    jest.useFakeTimers();
    try {
      // A drain that never settles: the server close callback is never invoked,
      // so `shutdown` stays awaiting and never reaches its own `clearTimeout`.
      jest.spyOn(server, 'close').mockImplementation(() => server);
      setupGracefulShutdown(server);
      triggerSignal('SIGTERM');
      await Promise.resolve();

      // The safety net is armed and would exit the process on its own.
      __resetShutdownStateForTests();
      jest.advanceTimersByTime(120_000);

      // Without the reset clearing it, this timer fires long after the suite
      // that armed it has finished, killing the run with code 1.
      expect(exitSpy).not.toHaveBeenCalledWith(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps a later shutdown's safety net when an earlier drain settles late", async () => {
    // `setImmediate` stays real so the first shutdown's continuation can actually
    // reach its `finally`; only the force-exit timer is faked.
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      let releaseFirstClose: (() => void) | undefined;
      jest.spyOn(server, 'close').mockImplementation((cb?: (err?: Error) => void) => {
        if (cb) {
          releaseFirstClose = () => cb();
        }
        return server;
      });
      setupGracefulShutdown(server);
      triggerSignal('SIGTERM');
      await flush();

      // A second shutdown arms its own net after the first is reset away.
      __resetShutdownStateForTests();
      const secondServer = http.createServer();
      Object.defineProperty(secondServer, 'listening', { value: true, configurable: true });
      jest.spyOn(secondServer, 'close').mockImplementation(() => secondServer);
      setupGracefulShutdown(secondServer);
      triggerSignal('SIGTERM');
      await flush();

      // The first drain settles only now; its `finally` must not disarm the second.
      releaseFirstClose?.();
      await flush();
      await flush();
      await flush();

      jest.advanceTimersByTime(120_000);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
