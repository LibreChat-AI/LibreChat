import { DEFAULT_REDIS_FINALIZATION_RECOVERY_TIMEOUT_MS } from 'librechat-data-provider';
import type { TAgentsEndpoint } from 'librechat-data-provider';
import type { GenerationJobManagerClass, TerminalJobClaim } from './GenerationJobManager';
import { filterPersistableAbortContent, hasPersistableAbortContent } from './abortContent';
import { isRedisStreamInterrupted } from './redisOutage';

type Jobs = Pick<
  GenerationJobManagerClass,
  | 'isRedis'
  | 'beginProviderExecution'
  | 'claimTerminalJob'
  | 'completeJob'
  | 'markProviderExecutionDrained'
>;

type Response = { text?: string; content?: unknown; unfinished?: boolean };
type Content = ReturnType<typeof filterPersistableAbortContent>;

export interface ChatFinalization {
  begin(): Promise<void>;
  claim(response?: Response): Promise<TerminalJobClaim | null>;
  stopped(error: Error): boolean;
  fail(
    message: string,
    readContent: () => unknown,
    persist: (content: Content | undefined) => Promise<void>,
    settleSnapshots: () => Promise<void>,
  ): Promise<boolean>;
  drain(release?: () => void | Promise<void>): Promise<void>;
}

export function createChatFinalization({
  jobs,
  config,
  streamId,
  createdAt,
  provider,
  signal,
}: {
  jobs: Jobs;
  config?: Partial<Pick<TAgentsEndpoint, 'redisFinalizationRecoveryTimeoutMs'>>;
  streamId: string;
  createdAt: number;
  provider?: string;
  signal: AbortSignal;
}): ChatFinalization {
  const redis = jobs.isRedis && provider != null;
  const scope = redis ? { expectedProviderExecutionId: provider } : undefined;
  const interrupted = () => isRedisStreamInterrupted(signal);
  return {
    async begin() {
      if (!provider) return;
      const timeout =
        config?.redisFinalizationRecoveryTimeoutMs ??
        DEFAULT_REDIS_FINALIZATION_RECOVERY_TIMEOUT_MS;
      const started = redis
        ? await jobs.beginProviderExecution(streamId, createdAt, provider, undefined, timeout)
        : await jobs.beginProviderExecution(streamId, createdAt, provider);
      if (!started) {
        throw Object.assign(new Error('Generation stopped before provider startup'), {
          code: 'RUN_REPLACED',
          status: 409,
        });
      }
    },
    async claim(response) {
      const wasInterrupted = interrupted();
      if (
        wasInterrupted &&
        response &&
        !response.text?.trim() &&
        !hasPersistableAbortContent(response.content)
      ) {
        throw signal.reason;
      }
      const claim = await jobs.claimTerminalJob(
        streamId,
        signal.aborted ? 'aborted' : 'complete',
        undefined,
        createdAt,
        { persistencePending: true, ...scope },
      );
      if (claim && response && wasInterrupted) {
        response.unfinished = true;
      }
      return claim;
    },
    stopped: (error) =>
      !interrupted() && (signal.aborted || error.message?.includes('abort') === true),
    fail(message, readContent, persist, settleSnapshots) {
      return jobs.completeJob(streamId, message, createdAt, {
        ...scope,
        beforeErrorPublication: () =>
          persist(interrupted() ? filterPersistableAbortContent(readContent()) : undefined),
        beforeTerminalCleanup: settleSnapshots,
      });
    },
    async drain(release) {
      try {
        if (provider) await jobs.markProviderExecutionDrained?.(streamId, createdAt, provider);
      } finally {
        await release?.();
      }
    },
  };
}
