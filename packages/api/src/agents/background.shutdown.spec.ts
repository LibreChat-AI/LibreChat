import { AGENT_BACKGROUND_SHUTDOWN_INTERRUPT_GRACE_MS_DEFAULT } from 'librechat-data-provider';
import type { BackgroundTask, BackgroundTaskShutdownHandle } from './background';
import {
  BACKGROUND_TASK_SHUTDOWN_MESSAGE,
  BACKGROUND_SHUTDOWN_FLUSH_RESERVE_MS,
  BACKGROUND_SHUTDOWN_TEARDOWN_RESERVE_MS,
} from './backgroundCompletion';
import {
  BackgroundTaskRegistryClass,
  buildBackgroundCapacityContent,
  registerBackgroundTaskShutdown,
} from './background';
import * as shutdown from '~/app/shutdown';

const REASON = 'server shutting down';

function createTask(registry: BackgroundTaskRegistryClass, toolCallId: string): BackgroundTask {
  const created = registry.create({
    userId: 'shutdown-owner',
    conversationId: 'shutdown-conversation',
    toolCallId,
    toolName: 'bash_tool',
  });
  if ('atCapacity' in created) {
    throw new Error('unexpected capacity');
  }
  return created.task;
}

interface ControlledHandle {
  handle: BackgroundTaskShutdownHandle;
  interrupt: jest.Mock;
  flush: jest.Mock;
  settle: () => void;
}

/** A handle whose settlement the test drives; `onInterrupt`/`flushResult` model the tool. */
function controlledHandle(
  options: { onInterrupt?: 'settle' | 'ignore'; flushResult?: 'settle' | 'hang' } = {},
): ControlledHandle {
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const interrupt = jest.fn(() => {
    if (options.onInterrupt === 'settle') {
      settle();
    }
  });
  const flush = jest.fn(() => {
    if (options.flushResult === 'hang') {
      return new Promise<void>(() => undefined);
    }
    settle();
    return Promise.resolve();
  });
  return { handle: { settled, interrupt, flush }, interrupt, flush, settle: () => settle() };
}

const drainOptions = (overrides: { deadlineMs?: number; interruptGraceMs?: number } = {}) => ({
  deadlineAt: Date.now() + (overrides.deadlineMs ?? 400),
  interruptGraceMs: overrides.interruptGraceMs ?? 100,
  flushReserveMs: 50,
  reason: REASON,
});

describe('background task shutdown', () => {
  describe('admission', () => {
    it('refuses new tasks once admission closes, but still resolves replays and reserved permits', () => {
      const registry = new BackgroundTaskRegistryClass();
      const existing = createTask(registry, 'before-shutdown');
      const permitAdmission = registry.reserveCapacity({
        userId: 'shutdown-owner',
        conversationId: 'shutdown-conversation',
        toolCallId: 'reserved-before-shutdown',
      });
      if (!('permit' in permitAdmission)) {
        throw new Error('expected a capacity permit');
      }

      registry.closeAdmission();

      expect(registry.isAdmissionClosed()).toBe(true);
      expect(
        registry.create({
          userId: 'shutdown-owner',
          conversationId: 'shutdown-conversation',
          toolCallId: 'after-shutdown',
          toolName: 'bash_tool',
        }),
      ).toEqual({ atCapacity: true, scope: 'shutting_down' });
      expect(
        registry.reserveCapacity({
          userId: 'shutdown-owner',
          conversationId: 'shutdown-conversation',
          toolCallId: 'after-shutdown',
        }),
      ).toEqual({ atCapacity: true, scope: 'shutting_down' });
      expect(
        registry.create({
          userId: 'shutdown-owner',
          conversationId: 'shutdown-conversation',
          toolCallId: 'before-shutdown',
          toolName: 'bash_tool',
        }),
      ).toEqual({ task: existing, isNew: false });
      expect(
        registry.create({
          userId: 'shutdown-owner',
          conversationId: 'shutdown-conversation',
          toolCallId: 'reserved-before-shutdown',
          toolName: 'bash_tool',
          capacityPermit: permitAdmission.permit,
        }),
      ).toMatchObject({ isNew: true });
    });

    it('tells the model why a background dispatch was refused', () => {
      const content = JSON.parse(buildBackgroundCapacityContent('bash_tool', 'shutting_down'));
      expect(content).toEqual({
        status: 'rejected',
        tool: 'bash_tool',
        scope: 'shutting_down',
        message: expect.stringContaining('shutting down'),
      });
    });
  });

  describe('drainForShutdown', () => {
    it('returns immediately and closes admission when nothing is tracked', async () => {
      const registry = new BackgroundTaskRegistryClass();
      const startedAt = Date.now();

      const summary = await registry.drainForShutdown(drainOptions({ deadlineMs: 5_000 }));

      expect(summary).toEqual({ tracked: 0, interrupted: 0, flushed: 0, unsettled: 0 });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(registry.isAdmissionClosed()).toBe(true);
    });

    it('waits for tasks that settle on their own without interrupting them', async () => {
      const registry = new BackgroundTaskRegistryClass();
      const task = createTask(registry, 'settles-alone');
      const controlled = controlledHandle();
      registry.trackShutdown(task, controlled.handle);
      setTimeout(controlled.settle, 20);

      const summary = await registry.drainForShutdown(drainOptions());

      expect(summary).toEqual({ tracked: 1, interrupted: 0, flushed: 0, unsettled: 0 });
      expect(controlled.interrupt).not.toHaveBeenCalled();
      expect(controlled.flush).not.toHaveBeenCalled();
    });

    it('interrupts running tasks, then flushes only those that did not settle after the abort', async () => {
      const registry = new BackgroundTaskRegistryClass();
      const cooperative = controlledHandle({ onInterrupt: 'settle' });
      const stubborn = controlledHandle({ onInterrupt: 'ignore' });
      registry.trackShutdown(createTask(registry, 'cooperative'), cooperative.handle);
      registry.trackShutdown(createTask(registry, 'stubborn'), stubborn.handle);

      const summary = await registry.drainForShutdown(drainOptions());

      expect(cooperative.interrupt).toHaveBeenCalledWith(REASON);
      expect(stubborn.interrupt).toHaveBeenCalledWith(REASON);
      expect(cooperative.flush).not.toHaveBeenCalled();
      expect(stubborn.flush).toHaveBeenCalledWith(REASON);
      expect(summary).toEqual({ tracked: 2, interrupted: 2, flushed: 1, unsettled: 0 });
    });

    it('flushes a settled task whose result is not durable yet without aborting it', async () => {
      const registry = new BackgroundTaskRegistryClass();
      const task = createTask(registry, 'settled-not-durable');
      const controlled = controlledHandle();
      registry.trackShutdown(task, controlled.handle);
      registry.complete('shutdown-owner', 'shutdown-conversation', task.id, { content: 'done' });

      const summary = await registry.drainForShutdown(drainOptions());

      expect(controlled.interrupt).not.toHaveBeenCalled();
      expect(controlled.flush).toHaveBeenCalledWith(REASON);
      expect(summary).toEqual({ tracked: 1, interrupted: 0, flushed: 1, unsettled: 0 });
    });

    it('stops at the deadline and reports results it could not confirm', async () => {
      const registry = new BackgroundTaskRegistryClass();
      const hanging = controlledHandle({ flushResult: 'hang' });
      registry.trackShutdown(createTask(registry, 'hanging'), hanging.handle);
      const startedAt = Date.now();

      const summary = await registry.drainForShutdown(drainOptions({ deadlineMs: 300 }));

      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(summary).toEqual({ tracked: 1, interrupted: 1, flushed: 1, unsettled: 1 });
    });

    it('does not retain an unconfirmed result after its task expires', async () => {
      const registry = new BackgroundTaskRegistryClass();
      const task = createTask(registry, 'unconfirmed-expired');
      const controlled = controlledHandle();
      registry.trackShutdown(task, controlled.handle);
      registry.fail('shutdown-owner', 'shutdown-conversation', task.id, 'no durable write');
      const now = jest.spyOn(Date, 'now').mockReturnValue(task.updatedAt + 60 * 60 * 1000 + 1);
      try {
        expect(registry.get('shutdown-owner', 'shutdown-conversation', task.id)).toBeUndefined();
      } finally {
        now.mockRestore();
      }

      expect((await registry.drainForShutdown(drainOptions())).tracked).toBe(0);
    });

    it('does not retain an unconfirmed result after capacity pressure evicts its task', async () => {
      const registry = new BackgroundTaskRegistryClass();
      const task = createTask(registry, 'unconfirmed-evicted');
      const controlled = controlledHandle();
      registry.trackShutdown(task, controlled.handle);
      registry.fail('shutdown-owner', 'shutdown-conversation', task.id, 'no durable write');
      task.updatedAt = Date.now() - 1_000;
      for (let i = 0; i < 199; i++) {
        const settled = createTask(registry, `completed-${i}`);
        registry.complete('shutdown-owner', 'shutdown-conversation', settled.id, { content: 'ok' });
      }
      createTask(registry, 'trigger-eviction');

      expect(registry.get('shutdown-owner', 'shutdown-conversation', task.id)).toBeUndefined();
      expect((await registry.drainForShutdown(drainOptions())).tracked).toBe(0);
    });

    it('stops tracking a task once its result is durable', async () => {
      const registry = new BackgroundTaskRegistryClass();
      const controlled = controlledHandle();
      registry.trackShutdown(createTask(registry, 'released'), controlled.handle);

      controlled.settle();
      await controlled.handle.settled;
      await Promise.resolve();

      const summary = await registry.drainForShutdown(drainOptions());
      expect(summary.tracked).toBe(0);
    });
  });

  describe('registerBackgroundTaskShutdown', () => {
    type RegisteredTask = [string, () => void | Promise<void>, shutdown.ShutdownTaskOptions?];

    function captureRegistrations(): RegisteredTask[] {
      const registered: RegisteredTask[] = [];
      jest.spyOn(shutdown, 'registerShutdownTask').mockImplementation((name, fn, options) => {
        registered.push([name, fn, options]);
      });
      return registered;
    }

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('closes admission before the HTTP drain and settles tasks after generations finalize', async () => {
      const registered = captureRegistrations();
      const registry = new BackgroundTaskRegistryClass();
      const drain = jest.spyOn(registry, 'drainForShutdown');

      registerBackgroundTaskShutdown({ registry, getBudgetMs: () => 10_000 });

      expect(registered.map(([name, , options]) => [name, options])).toEqual([
        ['background task admission', { phase: 'pre-drain', priority: 110 }],
        ['background tasks', { priority: 95 }],
      ]);
      expect(registered[0][2]?.priority).toBeGreaterThan(100);
      registered[0][1]();
      expect(registry.isAdmissionClosed()).toBe(true);

      const startedAt = Date.now();
      await registered[1][1]();
      expect(drain).toHaveBeenCalledWith({
        deadlineAt: expect.any(Number),
        interruptGraceMs: AGENT_BACKGROUND_SHUTDOWN_INTERRUPT_GRACE_MS_DEFAULT,
        flushReserveMs: BACKGROUND_SHUTDOWN_FLUSH_RESERVE_MS,
        reason: BACKGROUND_TASK_SHUTDOWN_MESSAGE,
      });
      const { deadlineAt } = drain.mock.calls[0][0];
      const expected = startedAt + 10_000 - BACKGROUND_SHUTDOWN_TEARDOWN_RESERVE_MS;
      expect(Math.abs(deadlineAt - expected)).toBeLessThan(1_000);
    });

    it('uses the configured interrupt grace', async () => {
      const registered = captureRegistrations();
      const registry = new BackgroundTaskRegistryClass();
      const drain = jest.spyOn(registry, 'drainForShutdown');

      registerBackgroundTaskShutdown({
        registry,
        interruptGraceMs: 1_234,
        getBudgetMs: () => 5_000,
      });
      await registered[1][1]();

      expect(drain.mock.calls[0][0].interruptGraceMs).toBe(1_234);
    });

    it('only closes admission when no shutdown budget is known', async () => {
      const registered = captureRegistrations();
      const registry = new BackgroundTaskRegistryClass();
      const drain = jest.spyOn(registry, 'drainForShutdown');

      registerBackgroundTaskShutdown({ registry, getBudgetMs: () => null });
      await registered[1][1]();

      expect(drain).not.toHaveBeenCalled();
      expect(registry.isAdmissionClosed()).toBe(true);
    });
  });
});
