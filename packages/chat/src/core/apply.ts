import { StepEvents } from 'librechat-data-provider';
import type {
  TMessage,
  ChatEvent,
  ChatFrame,
  ChatSyncFrame,
  EventSubmission,
  ChatCreatedFrame,
} from 'librechat-data-provider';
import type { StepEvent, StepEffect, StepContext } from './reducer';
import type { ChatEventContext } from './chat';
import {
  reduceStep,
  flushSummary,
  flushResponses,
  resetStreamState,
  syncStreamMessage,
  createStreamState,
} from './reducer';
import { buildResumeEventSubmission, buildSubmissionFromResumeState } from './resumable/resume';
import { buildCreatedInitialResponse } from './resumable/messages';
import { placeResumedResponse } from './resumable/placement';
import { normalizeFrame } from './transport/frames';
import { mergeFinalFrame } from './chat';

/** A step's side channel that is not a write to the message list. */
export type EventApplierEffect = Exclude<StepEffect, { type: 'flush' | 'summary' }>;

export type EventApplierInit = {
  /**
   * Defers the write of streamed tokens and returns how to cancel it, so a burst of deltas costs
   * one write. A browser passes `requestAnimationFrame`. Without it every delta writes at once.
   */
  schedule?: (flush: () => void) => () => void;
  /** Live status a step reports beside the list: sandbox start, nested subagents, announcements. */
  onEffect?: (effect: EventApplierEffect) => void;
};

export type EventApplier = {
  /** `ChatInit.applyEvent`: folds a turn's `created`, `sync`, `step` and `final` frames in. */
  applyEvent: (event: ChatEvent, context: ChatEventContext) => void;
  /** Writes the streamed tokens a scheduled flush still holds. */
  flush: () => void;
  /** Forgets the turn being applied and drops any scheduled write. */
  reset: () => void;
};

type HeldFlush = { responses: Set<string>; summaries: Set<string>; messages: TMessage[] };

const stepContext = (submission: EventSubmission, context: ChatEventContext): StepContext => ({
  submission,
  getMessages: () => context.messages,
  setMessages: (messages) => context.write(messages),
});

/** The turn a `created` frame names: its user message, and the reply the list already holds. */
function createdSubmission(data: ChatCreatedFrame, messages: TMessage[]): EventSubmission {
  const loaded = messages.find((message) => message.messageId === data.message.messageId);
  const userMessage = { ...loaded, ...data.message, isCreatedByUser: true } as TMessage;
  let placeholder: TMessage | undefined;
  for (let index = messages.length - 1; index >= 0 && placeholder == null; index--) {
    const message = messages[index];
    if (!message.isCreatedByUser && message.parentMessageId === userMessage.messageId) {
      placeholder = message;
    }
  }
  const initialResponse =
    placeholder ??
    buildCreatedInitialResponse({
      initialResponse: { text: '', isCreatedByUser: false } as TMessage,
      userMessage,
    });
  return {
    conversation: { conversationId: userMessage.conversationId },
    endpointOption: {},
    isRegenerate: false,
    messages,
    userMessage,
    initialResponse,
  } as EventSubmission;
}

/**
 * The event application main chat runs, as a `Chat` reducer: the step reducer for a turn's
 * graph events, and a resume snapshot rebuilt and placed by the same code a reattached stream
 * uses there. A `Chat` constructed with it holds, for the same frames, the messages main chat
 * holds.
 *
 * Stateful, one per `Chat`: it keeps the streaming copy of each response between events. Frames
 * that describe something other than message content (usage, titles, attachments, steers, labels
 * and pauses) are left to `onEvent`.
 */
export function createEventApplier(init: EventApplierInit = {}): EventApplier {
  const stream = createStreamState();
  let submission: EventSubmission | undefined;
  let context: ChatEventContext | undefined;
  /** Steps that arrived before a frame named the turn they belong to. */
  let early: StepEvent[] = [];
  let held: HeldFlush | undefined;
  let cancel: (() => void) | undefined;

  const drop = (): void => {
    cancel?.();
    cancel = undefined;
    held = undefined;
  };

  const flush = (): void => {
    const pending = held;
    drop();
    if (pending == null || submission == null || context == null) {
      return;
    }
    const ctx = stepContext(submission, context);
    flushResponses(stream, ctx, pending.responses, pending.messages);
    for (const messageId of pending.summaries) {
      flushSummary(stream, ctx, messageId, pending.messages);
    }
  };

  const reset = (): void => {
    drop();
    resetStreamState(stream);
    submission = undefined;
    early = [];
  };

  const settle = (effects: StepEffect[]): void => {
    for (const effect of effects) {
      if (effect.type !== 'flush' && effect.type !== 'summary') {
        init.onEffect?.(effect);
        continue;
      }
      held ??= { responses: new Set(), summaries: new Set(), messages: effect.messages };
      held.messages = effect.messages;
      (effect.type === 'flush' ? held.responses : held.summaries).add(effect.messageId);
    }
    if (held != null && init.schedule != null) {
      cancel ??= init.schedule(flush);
    }
  };

  const step = (event: StepEvent): void => {
    if (submission == null || context == null) {
      early.push(event);
      return;
    }
    settle(reduceStep(stream, event, stepContext(submission, context)));
  };

  /** Frames a snapshot carries beside its content; only the graph's step events write messages. */
  const replay = (frames: ReadonlyArray<object> | undefined): void => {
    for (const frame of frames ?? []) {
      const event = normalizeFrame(frame as ChatFrame);
      if (event?.type === 'step') {
        step(event.data as StepEvent);
      }
    }
  };

  const created = (data: ChatCreatedFrame, ctx: ChatEventContext): void => {
    if (!data.message?.messageId) {
      return;
    }
    const waiting = early;
    reset();
    const next = createdSubmission(data, ctx.messages);
    const known = ctx.messages.some((message) => message.messageId === next.userMessage.messageId);
    ctx.write(
      known
        ? ctx.messages.map((message) =>
            message.messageId === next.userMessage.messageId ? next.userMessage : message,
          )
        : [...ctx.messages, next.userMessage],
    );
    submission = next;
    for (const event of waiting) {
      step(event);
    }
  };

  const sync = (data: ChatSyncFrame, ctx: ChatEventContext): void => {
    const { resumeState } = data;
    if (resumeState == null) {
      replay(data.pendingEvents);
      return;
    }
    /** What a scheduled write holds predates the snapshot, and so do steps not yet placed. */
    drop();
    early = [];
    const conversationId =
      resumeState.conversationId ??
      resumeState.userMessage?.conversationId ??
      data.conversationId ??
      submission?.conversation?.conversationId ??
      '';
    const previous =
      submission ??
      (buildSubmissionFromResumeState(
        resumeState,
        conversationId,
        ctx.messages,
        conversationId,
      ) as EventSubmission);
    const next = buildResumeEventSubmission(previous, previous.userMessage, resumeState);
    submission = next;

    for (const runStep of resumeState.runSteps ?? []) {
      step({ event: StepEvents.ON_RUN_STEP, data: runStep });
    }

    if (resumeState.aggregatedContent && next.userMessage?.messageId) {
      const placement = placeResumedResponse({
        messages: ctx.messages,
        submission: next,
        userMessage: next.userMessage,
        resumeState,
        previous,
      });
      /** The snapshot's content is indexed from zero, so later steps stop offsetting by an edit. */
      if (!placement.preservedLoadedContent) {
        next.editPrefixCleared = true;
      }
      ctx.write(placement.messages);
      settle(syncStreamMessage(stream, placement.response));
    }

    replay(resumeState.replayEvents);
    replay(data.pendingEvents);
  };

  const applyEvent = (event: ChatEvent, ctx: ChatEventContext): void => {
    context = ctx;
    if (event.type === 'created') {
      created(event.data, ctx);
    } else if (event.type === 'sync') {
      sync(event.data, ctx);
    } else if (event.type === 'step') {
      step(event.data as StepEvent);
    } else if (event.type === 'final') {
      /** The final frame is authoritative; a held copy of the stream must not land on top of it. */
      drop();
      mergeFinalFrame(event.data, ctx);
      reset();
    } else if (event.type === 'abort' || event.type === 'error') {
      /** A turn that stops here keeps every token it streamed. */
      flush();
    }
    if (init.schedule == null) {
      flush();
    }
  };

  return { applyEvent, flush, reset };
}
