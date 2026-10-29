import { channelConfigSchema } from 'librechat-data-provider';
import type { ChannelRunStorage } from '@librechat/data-schemas';
import type { ChannelConfig } from 'librechat-data-provider';
import type { RequestHandler } from 'express';
import type { ChannelFeedbackWorkerDependencies } from './feedbackWorker';
import type { ChannelFeedbackHostDependencies } from './feedbackHost';
import type { ChannelServiceGuard } from './runs';
import { createChannelFeedbackHandlers } from './feedbackHttp';
import { createChannelFeedbackWorker } from './feedbackWorker';
import { createChannelFeedbackHost } from './feedbackHost';

export interface ChannelFeedbackRuntimeDependencies {
  getConfig: () => Promise<ChannelConfig | undefined>;
  hostDeps: Omit<
    ChannelFeedbackHostDependencies,
    'runs' | 'maxConflictRetries' | 'exportTimeoutMs' | 'exportLeaseMs' | 'exportRetryMs'
  >;
  workerDeps: Omit<
    ChannelFeedbackWorkerDependencies,
    'feedback' | 'batchSize' | 'intervalMs' | 'maxIdleIntervalMs'
  >;
  guard: ChannelServiceGuard;
  runs: Pick<ChannelRunStorage, 'findDeliveredReply'>;
}

export interface ChannelFeedbackRuntime {
  handlers: ReturnType<typeof createChannelFeedbackHandlers>;
  initialize: () => Promise<void>;
  stop: () => Promise<void>;
}

/** Thin lifecycle boundary: construct without timers; initialize explicitly; host registers stop for shutdown. */
export function createChannelFeedbackRuntime(
  deps: ChannelFeedbackRuntimeDependencies,
): ChannelFeedbackRuntime {
  let worker: ReturnType<typeof createChannelFeedbackWorker> | undefined;
  let handlers: ReturnType<typeof createChannelFeedbackHandlers> | undefined;
  let initialization: Promise<void> | undefined;
  let ready = false;
  let stopped = false;
  const reaction: RequestHandler = async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!ready || stopped || !handlers) {
      res.status(503).json({ error: 'channel_feedback_unavailable' });
      return;
    }
    let enabled = false;
    try {
      enabled = (await deps.getConfig())?.enabled === true;
    } catch {
      /* Fail closed. */
    }
    if (!enabled || stopped) {
      res.status(503).json({ error: 'channel_feedback_unavailable' });
      return;
    }
    await handlers.reaction(req, res, next);
  };
  return {
    handlers: { reaction },
    initialize(): Promise<void> {
      if (stopped) return Promise.resolve();
      if (initialization) return initialization;
      initialization = (async () => {
        const config = channelConfigSchema.parse((await deps.getConfig()) ?? {});
        if (!config.enabled || stopped) return;
        const settings = config.feedback;
        const feedback = createChannelFeedbackHost({
          ...deps.hostDeps,
          runs: deps.runs,
          maxConflictRetries: settings.maxConflictRetries,
          exportTimeoutMs: settings.exportTimeoutMs,
          exportLeaseMs: settings.exportLeaseMs,
          exportRetryMs: settings.exportRetryMs,
        });
        worker = createChannelFeedbackWorker({
          ...deps.workerDeps,
          feedback,
          batchSize: settings.batchSize,
          intervalMs: settings.intervalMs,
          maxIdleIntervalMs: settings.maxIdleIntervalMs,
        });
        handlers = createChannelFeedbackHandlers({
          guard: deps.guard,
          runs: deps.runs,
          feedback,
          wake: () => worker?.wake(),
        });
        try {
          await worker.start();
        } catch (error) {
          await worker.stop().catch(() => undefined);
          throw error;
        }
        if (stopped) await worker.stop();
        else ready = true;
      })();
      return initialization;
    },
    async stop(): Promise<void> {
      stopped = true;
      ready = false;
      try {
        await initialization;
      } catch {
        /* Failed initialization has no active ready handler. */
      }
      await worker?.stop();
    },
  };
}
