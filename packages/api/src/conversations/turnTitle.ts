import { Constants } from 'librechat-data-provider';
import type { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import type { TitleTiming } from '~/endpoints/config/providers';
import type { AssistantConfig } from '~/protection/assistant';
import type { AgentTitleOptions } from './title';
import { allowsAssistantSideEffects } from '~/protection/assistant';
import { SAFE_CONVERSATION_TITLE } from '~/protection/title';
import { getSafeErrorMetadata } from '~/utils/errors';
import { isEnabled } from '~/utils/common';

type TitleEvent = { conversationId: string; title: string };
type TitleWork = Omit<AgentTitleOptions, 'client' | 'text' | 'response' | 'conversationId'>;

type TitleState = { title?: string | null; titleSetByUser?: boolean; isTemporary?: boolean };

function canRetitle(conversation?: TitleState | null): boolean {
  return (
    conversation != null &&
    !conversation.isTemporary &&
    !conversation.titleSetByUser &&
    (conversation.title == null ||
      conversation.title === '' ||
      conversation.title === SAFE_CONVERSATION_TITLE)
  );
}

interface AgentTurnTitle {
  prepare(): Promise<void>;
  startImmediate(): void;
  complete(outcome: { stopped: boolean; preempted: boolean }): Promise<void> | undefined;
  retryFrame(conversation: TitleState): { titleRetryEpoch?: number };
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
  conversation,
  followUp,
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
  conversation?: TitleState | null;
  followUp?: {
    setting?: string;
    endpointEnabled?: boolean;
    config?: AssistantConfig;
    isRegenerate?: boolean;
    isContinued?: boolean;
    isCompaction?: boolean;
    editedContent?: unknown;
    isAgentTrigger?: boolean;
    isScheduledFire?: boolean;
    overrideConvoId?: string | null;
  };
  streamId: string;
  epoch: number;
  convoReady: Promise<void>;
  openConvoReady: () => void;
  trackTrailingAbort: (cancel: () => void) => Promise<boolean>;
  generate: (options: TitleWork) => Promise<void>;
  jobs: Pick<GenerationJobManagerClass, 'getJob' | 'emitChunk'>;
  logger: { error: (message: string, metadata: ReturnType<typeof getSafeErrorMetadata>) => void };
}): AgentTurnTitle {
  // Replacement drains the old title. A normal new user turn can title the same
  // untitled chat, without reusing any prompt from a superseded request.
  const retry =
    !isNewConvo &&
    !!parentMessageId &&
    parentMessageId !== Constants.NO_PARENT &&
    followUp != null &&
    isEnabled(followUp.setting ?? true) &&
    allowsAssistantSideEffects(followUp.config, followUp.endpointEnabled) &&
    !followUp.isRegenerate &&
    !followUp.isContinued &&
    !followUp.isCompaction &&
    followUp.editedContent == null &&
    !followUp.isAgentTrigger &&
    !followUp.isScheduledFire &&
    !followUp.overrideConvoId &&
    canRetitle(conversation);
  const first = isNewConvo && parentMessageId === Constants.NO_PARENT;
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
      if (!hasGenerator || isTemporary || (!first && !retry)) {
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
    retryFrame: (state) =>
      retry && allowFinal && canRetitle(state) ? { titleRetryEpoch: epoch } : {},
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
