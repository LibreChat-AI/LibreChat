import { runAsSystem, tenantStorage } from '@librechat/data-schemas';
import type { createChannelFeedbackService } from './feedback';
import { createIdleRecoveryLoop } from '~/agents/recovery';

export interface ChannelFeedbackWorkerDependencies {
  /** Bounded channel metadata scan only. Called in deliberate system context. */
  listChannels: (
    cursor: string | undefined,
    limit: number,
  ) => Promise<{ channels: Array<{ tenantId?: string }>; next?: string }>;
  feedback: Pick<ReturnType<typeof createChannelFeedbackService>, 'recover' | 'flush'>;
  batchSize: number;
  intervalMs: number;
  maxIdleIntervalMs: number;
  onError: (error: unknown) => void;
}

/** Construction never starts timers or exports. Host starts/stops this with its normal worker lifecycle. */
export function createChannelFeedbackWorker(
  deps: ChannelFeedbackWorkerDependencies,
): ReturnType<typeof createIdleRecoveryLoop> {
  if (!Number.isSafeInteger(deps.batchSize) || deps.batchSize <= 0)
    throw new Error('Feedback batch size must be positive');
  let cursor: string | undefined;
  return createIdleRecoveryLoop({
    intervalMs: deps.intervalMs,
    maxIdleIntervalMs: deps.maxIdleIntervalMs,
    onError: deps.onError,
    scan: async () => {
      const page = await runAsSystem(async () => deps.listChannels(cursor, deps.batchSize));
      cursor = page.next;
      let idle = !page.next;
      for (const tenantId of new Set(page.channels.map((channel) => channel.tenantId ?? '_'))) {
        await tenantStorage.run({ tenantId }, async () => {
          try {
            const recovered = await deps.feedback.recover(tenantId, deps.batchSize);
            const exported = await deps.feedback.flush(tenantId, deps.batchSize);
            if (recovered || exported) idle = false;
          } catch (error) {
            idle = false;
            deps.onError(error);
          }
        });
      }
      return idle;
    },
  });
}
