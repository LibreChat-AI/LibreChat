import { logger } from '@librechat/data-schemas';
import type { GenerationSettledListener } from './GenerationJobManager';
import type { GenerationSettlementState } from './interfaces/IJobStore';

const DEFAULT_RECHECK_MS = 60_000;

export interface GenerationSettledSource {
  getGenerationSettlementState: (
    streamId: string,
  ) => Promise<GenerationSettlementState | undefined>;
  onGenerationSettled: (listener: GenerationSettledListener) => () => void;
}

export interface GenerationSettledWaitOptions {
  recheckMs?: number;
  /** Pin the dispatch generation even if it was replaced before the first read. */
  generationCreatedAt?: number;
  /** Optional caller deadline. Store errors are not evidence of settlement. */
  maxWaitMs?: number;
  /** Stops waiting (resolving `false`) once the caller no longer needs the answer. */
  signal?: AbortSignal;
}

/** Waits for the dispatch generation, including terminal persistence. Events request
 * a fresh read; they cannot settle an unrelated epoch or bypass an unfinished save.
 * The first successful read pins the epoch if the caller did not supply it. Reads
 * are single-flight, with a bounded periodic fallback for remote events and outages. */
export function waitForGenerationSettled(
  source: GenerationSettledSource,
  conversationId: string,
  {
    recheckMs = DEFAULT_RECHECK_MS,
    generationCreatedAt,
    maxWaitMs,
    signal,
  }: GenerationSettledWaitOptions = {},
): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let done = false;
    let reading = false;
    let readRequested = false;
    let epoch = generationCreatedAt;
    let observedActive = epoch != null;
    let unsubscribe: (() => void) | undefined = undefined;
    let recheck: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    const abort = (): void => finish(false);
    const finish = (settled: boolean): void => {
      if (done) return;
      done = true;
      unsubscribe?.();
      signal?.removeEventListener('abort', abort);
      clearTimeout(recheck);
      clearTimeout(deadline);
      resolve(settled);
    };
    const readState = async (): Promise<void> => {
      if (done) return;
      if (reading) {
        readRequested = true;
        return;
      }
      reading = true;
      clearTimeout(recheck);
      try {
        const job = await source.getGenerationSettlementState(conversationId);
        if (done) return;
        if (job == null || (epoch != null && epoch !== job.createdAt)) {
          finish(observedActive);
          return;
        }
        epoch = job.createdAt;
        const active =
          job.status === 'running' ||
          job.status === 'requires_action' ||
          job.terminalPersistencePending === true;
        if (!active) {
          finish(observedActive);
          return;
        }
        observedActive = true;
      } catch (error) {
        logger.warn(
          `[GenerationSettled] Failed to read generation state for ${conversationId}:`,
          error,
        );
      } finally {
        reading = false;
        if (!done) {
          if (readRequested) {
            readRequested = false;
            void readState();
          } else {
            recheck = setTimeout(() => void readState(), recheckMs);
            recheck.unref?.();
          }
        }
      }
    };
    if (maxWaitMs != null) {
      deadline = setTimeout(() => finish(false), maxWaitMs);
      deadline.unref?.();
    }
    signal?.addEventListener('abort', abort, { once: true });
    unsubscribe = source.onGenerationSettled((event) => {
      if (event.conversationId === conversationId) void readState();
    });
    if (done) unsubscribe();
    else void readState();
  });
}
