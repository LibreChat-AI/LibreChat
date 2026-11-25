import { logger, runAsSystem } from '@librechat/data-schemas';
import type { SubscriptionHost } from './subject';
import type { RunSettings } from './settings';

/** How often a pass runs: a third of the stale age, between one and ten minutes. */
export function cadence(settings: Pick<RunSettings, 'staleMs'>): number {
  return Math.min(Math.max(Math.floor(settings.staleMs / 3), 60_000), 600_000);
}

/** The loop's controls: one pass on demand, and its start and stop. */
export interface SubscriptionReconciler {
  /** One pass; answers how many runs it finished. */
  pass: () => Promise<number>;
  initialize: () => void;
  stop: () => Promise<void>;
}

/**
 * The loop that finishes a subscription's runs nobody else will. Built without timers;
 * `initialize` starts it and `stop`, which the host registers for shutdown, ends it and waits
 * for a pass under way. Each pass runs as the system, since stranded runs belong to every
 * tenant.
 */
export function createSubscriptionReconciler(
  host: Pick<SubscriptionHost, 'reconcile' | 'bounds'>,
): SubscriptionReconciler {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> | undefined;
  let stopped = false;

  async function pass(): Promise<number> {
    return runAsSystem(() => host.reconcile());
  }

  async function next(): Promise<void> {
    if (stopped) return;
    const wait = cadence(await host.bounds());
    if (stopped) return;
    timer = setTimeout(() => {
      running = pass()
        .catch((error: unknown) =>
          logger.error('[events] subscription run reconciliation failed', {
            error: error instanceof Error ? error.name : 'unknown',
          }),
        )
        .finally(() => {
          running = undefined;
          void next();
        });
    }, wait);
    timer.unref?.();
  }

  return {
    pass,
    initialize(): void {
      if (stopped || timer) return;
      void next().catch(() => undefined);
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await running;
    },
  };
}
