import { Constants } from 'librechat-data-provider';
import type { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import type { TitleTiming } from '~/endpoints/config/providers';
import type { AgentTitleOptions } from './title';
import { getSafeErrorMetadata } from '~/utils/errors';

type TitleEvent = { conversationId: string; title: string };
type TitleWork = Omit<AgentTitleOptions, 'client' | 'text' | 'response' | 'conversationId'>;

interface AgentTurnTitle {
  prepare(): Promise<void>;
  startImmediate(): void;
  complete(outcome: { stopped: boolean; preempted: boolean }): Promise<void> | undefined;
  pause(): void;
  discard(): void;
  finish(release: () => void): void;
  dispose(release: () => void): void;
  settled(): Promise<void> | undefined;
}

/** Owns a single turn's title, independently of the live chat stream's lifetime. */
export function createAgentTurnTitle({
  timing,
  signal,
  hasGenerator,
  parentMessageId,
  isNewConvo,
  isTemporary,
  streamId,
  epoch,
  convoReady,
  openConvoReady,
  trackTrailingAbort,
  generate,
  jobs,
  logger,
}: {
  timing: TitleTiming;
  signal: AbortSignal;
  hasGenerator: boolean;
  parentMessageId?: string | null;
  isNewConvo: boolean;
  isTemporary?: boolean;
  streamId: string;
  epoch: number;
  convoReady: Promise<void>;
  openConvoReady: () => void;
  trackTrailingAbort: (cancel: () => void) => Promise<boolean>;
  generate: (options: TitleWork) => Promise<void>;
  jobs: Pick<GenerationJobManagerClass, 'getJob' | 'emitChunk'>;
  logger: { error: (message: string, metadata: ReturnType<typeof getSafeErrorMetadata>) => void };
}): AgentTurnTitle {
  const model = new AbortController();
  const discard = new AbortController();
  const cancel = () => model.abort();
  let eligible = false;
  let acceptsTitleEvents = true;
  let allowFinal = false;
  let eventPromise: Promise<void> | undefined;
  let titlePromise: Promise<void> | undefined;
  let cleanup: Promise<void> | undefined;
  let disposalScheduled = false;

  const report = (message: string) => (error: unknown) =>
    logger.error(message, getSafeErrorMetadata(error));

  const emit = (data: TitleEvent) => {
    eventPromise = (async () => {
      if (!acceptsTitleEvents || model.signal.aborted) return;
      const current = await jobs.getJob(streamId);
      if (!acceptsTitleEvents || model.signal.aborted || current?.createdAt !== epoch) return;
      await jobs.emitChunk(streamId, { event: 'title', data }, { expectedCreatedAt: epoch });
    })().catch(report('[ResumableAgentController] Error emitting title event'));
    return eventPromise;
  };

  const launch = (options: TitleWork) =>
    Promise.resolve()
      .then(() =>
        generate({ epoch, signal: model.signal, discardSignal: discard.signal, ...options }),
      )
      .catch(report('[ResumableAgentController] Error in title generation'));

  const close = (outcome: 'complete' | 'stop' | 'pause' | 'discard') => {
    acceptsTitleEvents = false;
    signal.removeEventListener('abort', cancel);
    if (outcome !== 'complete') cancel();
    if (outcome === 'discard') discard.abort();
    openConvoReady();
  };

  const dispose = (release: () => void) => {
    if (disposalScheduled) return;
    disposalScheduled = true;
    if (titlePromise) {
      cleanup = titlePromise
        .finally(release)
        .catch(report('[ResumableAgentController] Error disposing title client'));
    } else {
      release();
    }
  };

  return {
    async prepare() {
      if (!hasGenerator || !isNewConvo || isTemporary || parentMessageId !== Constants.NO_PARENT) {
        return;
      }
      if (signal.aborted) {
        cancel();
        return;
      }
      signal.addEventListener('abort', cancel, { once: true });
      eligible = await trackTrailingAbort(cancel);
    },
    startImmediate() {
      if (!eligible || timing !== 'immediate') return;
      titlePromise = launch({
        immediate: true,
        convoReady,
        canPublishEarly: () => acceptsTitleEvents,
        onTitleGenerated: emit,
      });
    },
    complete({ stopped, preempted }: { stopped: boolean; preempted: boolean }) {
      allowFinal = eligible && !stopped && !preempted;
      close(allowFinal ? 'complete' : 'stop');
      return eventPromise;
    },
    pause: () => close('pause'),
    discard: () => close('discard'),
    finish(release: () => void) {
      if (timing === 'final' && allowFinal) titlePromise = launch({});
      dispose(release);
    },
    dispose,
    settled: () => cleanup ?? titlePromise,
  };
}
