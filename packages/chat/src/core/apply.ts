import { StepEvents } from 'librechat-data-provider';
import type {
  Agents,
  TMessage,
  ChatEvent,
  ChatFrame,
  TAttachment,
  TSubmission,
  ChatSyncFrame,
  ChatFinalFrame,
  EventSubmission,
  ChatCreatedFrame,
} from 'librechat-data-provider';
import type { ResumableUsage, ResumableSteers, ResumableEvents } from './resumable/host';
import type { StepEvent, StepEffect, StepContext } from './reducer';
import type { Placement, PlacementContext } from './parts/place';
import type { GenerationProtocolVersion } from './protocol';
import type { FinalSteers } from './resumable/steers';
import type { ChatEventContext } from './chat';
import {
  reduceStep,
  flushSummary,
  flushResponses,
  resetStreamState,
  syncStreamMessage,
  createStreamState,
} from './reducer';
import {
  placeSteer,
  oauthPromptSteps,
  placeActivityLabel,
  placePendingAction,
  placeReasoningLabel,
} from './parts/place';
import { buildResumeEventSubmission, buildSubmissionFromResumeState } from './resumable/resume';
import { getStepEventId, isOAuthStepEvent, nameStepResponse } from './resumable/events';
import { buildCreatedInitialResponse } from './resumable/messages';
import { placeResumedResponse } from './resumable/placement';
import { supportsGenerationProtocolV2 } from './protocol';
import { settleFinalSteers } from './resumable/steers';
import { ABORT_SWEEP_STATUSES } from './steer/chips';
import { normalizeFrame } from './transport/frames';
import { getEditPrefix } from './steps/content';
import { withEditedPart } from './content';
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
  /**
   * What a stream changes beside the message list, in the hands main chat's own stream session
   * puts it in: its usage handlers, its attachment collector, its title handler and its steer
   * chips. Each is called for the frames, live or carried by a snapshot, that main chat calls it
   * for, so a `Chat` given main chat's handlers keeps the state main chat keeps. One left out is
   * simply not kept; the frame still reaches `onEvent`.
   */
  usage?: ResumableUsage;
  onAttachment?: ResumableEvents['attachmentHandler'];
  onTitle?: ResumableEvents['titleHandler'];
  steers?: Pick<ResumableSteers, 'resolve' | 'markLiveApplied' | 'update' | 'seed'> & FinalSteers;
  /**
   * The protocol version of the generation whose frames are being applied, when the caller
   * knows it: what main chat's session reads off its stream. It decides whether the steers a
   * terminal frame carries are ones this client may turn into queued turns.
   */
  protocol?: () => GenerationProtocolVersion | undefined;
  /**
   * The turn this chat sent and drew rows for, while the stream it opened for it runs. The
   * server stores the turn's message under an id of its own and names that in its `created`
   * frame. With the turn known, the frame is read as naming the row already drawn, which stays
   * until the final frame brings the stored one, as main chat's handlers keep it. Without it
   * the frame's message is a row the list does not hold, and is added.
   */
  turn?: () => TSubmission | undefined;
};

export type EventApplier = {
  /**
   * `ChatInit.applyEvent`: folds in every frame that writes a message. That is a turn's
   * `created`, `sync`, `step` and `final` frames, and the side frames a stream carries beside its
   * deltas: an injected steer, an activity label, a reasoning title and a pause.
   */
  applyEvent: (event: ChatEvent, context: ChatEventContext) => void;
  /** Writes the streamed tokens a scheduled flush still holds. */
  flush: () => void;
  /** Forgets the turn being applied and drops any scheduled write. */
  reset: () => void;
};

type HeldFlush = { responses: Set<string>; summaries: Set<string>; messages: TMessage[] };

/** A frame that writes onto a response beside the stream's deltas. */
type SideFrame = Extract<
  ChatEvent,
  { type: 'steer_applied' | 'activity_label' | 'reasoning_label' | 'pending_action' }
>;

const sideTypes = new Set<ChatEvent['type']>([
  'steer_applied',
  'activity_label',
  'reasoning_label',
  'pending_action',
]);

const isSideFrame = (event: ChatEvent): event is SideFrame => sideTypes.has(event.type);

/** A frame that changes state kept beside the message list, and writes no message. */
type BesideFrame = Extract<
  ChatEvent,
  { type: 'attachment' | 'title' | 'context_usage' | 'token_usage' | 'steer_updated' }
>;

const besideTypes = new Set<ChatEvent['type']>([
  'attachment',
  'title',
  'context_usage',
  'token_usage',
  'steer_updated',
]);

const isBesideFrame = (event: ChatEvent): event is BesideFrame => besideTypes.has(event.type);

const isOutputDelta = (event: StepEvent): boolean =>
  event.event === StepEvents.ON_MESSAGE_DELTA || event.event === StepEvents.ON_REASONING_DELTA;

/** How the turn's list differs from the index space the server claims; see `PlacementContext`. */
const placementContext = (submission: EventSubmission): PlacementContext => {
  const userMessageId = submission.userMessage?.messageId;
  return {
    placeholderIds: [
      submission.initialResponse?.messageId,
      userMessageId ? `${userMessageId}_` : undefined,
    ],
    prefixLength: getEditPrefix(submission).editPrefixOffset,
    foldedFirstPart: submission.editPrefixFirstPartFolded === true,
  };
};

const locate = (
  frame: SideFrame,
  messages: TMessage[],
  context: PlacementContext,
): Placement | undefined => {
  if (frame.type === 'steer_applied') {
    return placeSteer(messages, frame.data, context);
  }
  if (frame.type === 'activity_label') {
    return placeActivityLabel(messages, frame.data, context);
  }
  if (frame.type === 'reasoning_label') {
    return placeReasoningLabel(messages, frame.data, context);
  }
  return placePendingAction(messages, frame.data);
};

const stepContext = (submission: EventSubmission, context: ChatEventContext): StepContext => ({
  submission,
  getMessages: () => context.messages,
  setMessages: (messages) => context.write(messages),
});

/**
 * Whether a frame's message is the identity of a row the list holds, not a turn's content: a
 * compaction names the leaf it summarizes up to, whoever wrote it, and sends no text for it.
 */
const isAnchor = (held: TMessage, named: Partial<TMessage>): boolean =>
  held.isCreatedByUser !== true || !named.text;

/**
 * A final frame as its turn settles it. A turn that made no user row still names one in its
 * request: a regeneration its saved turn, a compaction its anchor. Merging that onto the row
 * would blank what it holds, so such a turn settles its response alone, as main chat's final
 * handler does. A chat that saw only the final frame recognizes the anchor from the frame.
 */
function settledFinal(
  data: ChatFinalFrame,
  turn: EventSubmission | undefined,
  messages: TMessage[],
): ChatFinalFrame {
  const request = data.requestMessage;
  if (request?.messageId == null) {
    return data;
  }
  const held = messages.find((message) => message.messageId === request.messageId);
  const reused = turn?.isRegenerate === true || (held != null && isAnchor(held, request));
  return reused ? { ...data, requestMessage: null } : data;
}

/**
 * The row a turn drew for its message, when the frame names that message under another id. Only
 * a turn that makes a message draws one: a rerun, a continued reply and an edited one name rows
 * the list already held. The frame's message answers the row the drawn one answers.
 */
function drawnMessage(
  turn: TSubmission | undefined,
  data: ChatCreatedFrame,
  messages: TMessage[],
): TMessage | undefined {
  if (
    turn == null ||
    turn.isRegenerate === true ||
    turn.isContinued === true ||
    turn.isEdited === true
  ) {
    return undefined;
  }
  const { messageId } = turn.userMessage;
  if (messageId === data.message.messageId) {
    return undefined;
  }
  const drawn = messages.find((message) => message.messageId === messageId);
  if (drawn == null || drawn.isCreatedByUser !== true) {
    return undefined;
  }
  const parent = data.message.parentMessageId;
  return parent == null || parent === drawn.parentMessageId ? drawn : undefined;
}

/**
 * The turn a `created` frame names: its user message and the reply the turn starts from.
 *
 * A row the list already holds is never rewritten from the frame. A regeneration reuses a saved
 * user turn, and a compaction makes no turn at all: its frame names the leaf it summarizes up to,
 * with that leaf's author and no text. Only a message the list does not hold is a new turn to add.
 *
 * Sharing the user message as a parent does not make a row this turn's reply: a regeneration's
 * earlier answers are its children too. Only a row under the id the frame names, or under the
 * padded id a turn draws its reply at before the server names it, is the reply to carry on from.
 * Any other reply already under the message is a saved answer, so the turn starts empty beside
 * it and leaves it in place, as it does under a compaction's anchor.
 *
 * A frame that states the turn's shape (`turn`) is taken at its word: a regeneration, a
 * compaction, a continued reply and an edited one all name messages the list already holds, and
 * only the server knows which this is. A frame without it, from a server that predates it, is
 * read by what the list implies, which cannot tell a continued or edited reply from a
 * regeneration.
 */
function createdSubmission(
  data: ChatCreatedFrame,
  messages: TMessage[],
  drawn?: TMessage,
): EventSubmission {
  const loaded = messages.find((message) => message.messageId === data.message.messageId) ?? drawn;
  const { turn } = data;
  /** What the list implies when the server does not say: a named leaf that is no user turn. */
  const impliedAnchor =
    loaded == null ? data.message.isCreatedByUser === false : isAnchor(loaded, data.message);
  const anchored = turn != null ? turn.compact === true : impliedAnchor;
  const userMessage =
    loaded ??
    ({ ...data.message, isCreatedByUser: data.message.isCreatedByUser !== false } as TMessage);
  const base = {
    conversation: { conversationId: userMessage.conversationId },
    endpointOption: {},
    userMessage,
  };
  const replyById = (id: string | undefined): TMessage | undefined =>
    id == null
      ? undefined
      : messages.find((message) => !message.isCreatedByUser && message.messageId === id);
  /** The reply the turn is stored under, when the list already holds a row for it. */
  const named = replyById(turn?.responseMessageId);
  /** The saved reply a continued or an edited turn starts from. */
  const source =
    turn?.isContinued === true || turn?.editedContent != null
      ? replyById(turn.sourceMessageId ?? turn.responseMessageId)
      : undefined;
  if (source != null && turn != null) {
    /**
     * An edited reply is rerun from its own parts with the edit in place, and what the server
     * streams lands after them; a continued reply with no edit is drawn again from empty. Either
     * way the reply the turn starts from goes to the end of the list in that state, as main chat
     * puts its own placeholder there: the first step builds on the last row, and in a list that
     * holds other branches the last row is otherwise some other answer.
     */
    const prefix =
      turn.editedContent == null
        ? undefined
        : withEditedPart(source.content ?? [], turn.editedContent);
    const restarted: TMessage = {
      ...source,
      parentMessageId: userMessage.messageId,
      ...(prefix == null ? { text: '', content: [] } : { content: prefix }),
    };
    return {
      ...base,
      isRegenerate: false,
      isEdited: true,
      ...(turn.isContinued === true && { isContinued: true }),
      ...(turn.editedContent != null && {
        editedContent: turn.editedContent,
        editPrefixLength: prefix?.length ?? 0,
      }),
      messages: [...messages.filter((message) => message !== source), restarted],
      initialResponse: restarted,
    } as EventSubmission;
  }
  const optimisticId = `${userMessage.messageId}_`;
  let placeholder: TMessage | undefined;
  let answered = false;
  for (const message of messages) {
    if (message.isCreatedByUser || message.parentMessageId !== userMessage.messageId) {
      continue;
    }
    if (
      message === named ||
      message.messageId === optimisticId ||
      message.messageId === userMessage.responseMessageId
    ) {
      placeholder = message;
    } else {
      answered = true;
    }
  }
  const initialResponse =
    placeholder ??
    buildCreatedInitialResponse({
      initialResponse: { text: '', isCreatedByUser: false } as TMessage,
      userMessage,
    });
  /** The server's word on the turn's shape, where it gives one; else what the list implies. */
  const regenerated = turn != null ? turn.isRegenerate === true || anchored : anchored || answered;
  const listed = loaded != null || anchored ? messages : [...messages, userMessage];
  return {
    ...base,
    isRegenerate: regenerated,
    ...(anchored && { compact: true }),
    /**
     * A turn that is not regenerate-shaped builds its first step on the last row of the list,
     * so its reply is put there, as main chat's own handler puts its placeholder: in a list that
     * holds an abandoned reply or another branch, the last row is otherwise some other answer.
     */
    messages: regenerated
      ? listed
      : [...listed.filter((message) => message !== placeholder), initialResponse],
    initialResponse,
  } as EventSubmission;
}

/**
 * The event application main chat runs, as a `Chat` reducer: the step reducer for a turn's
 * graph events, and a resume snapshot rebuilt and placed by the same code a reattached stream
 * uses there. A `Chat` constructed with it holds, for the same frames, the messages main chat
 * holds.
 *
 * Side frames are placed by the functions main chat's `ResponsePatcher` calls. One whose target
 * has not been drawn yet waits and is placed again when the list next changes, instead of being
 * retried on a timer: every event is applied in order here, so the list only changes when one is.
 *
 * Stateful, one per `Chat`: it keeps the streaming copy of each response between events. Frames
 * that describe something beside the message list (usage, titles, attachments, the composer's
 * steer chips) go to the handlers the caller supplies for them, at the points main chat's
 * stream session calls its own.
 */
export function createEventApplier(init: EventApplierInit = {}): EventApplier {
  const stream = createStreamState();
  let submission: EventSubmission | undefined;
  let context: ChatEventContext | undefined;
  /** Steps that arrived before a frame named the turn they belong to. */
  let early: StepEvent[] = [];
  /** Side frames whose target has not been drawn yet, oldest first. */
  let waiting: SideFrame[] = [];
  /** Frames for the state beside the list that arrived before a frame named their turn. */
  let aside: BesideFrame[] = [];
  /** The chip ids a steer's applied frame settled for the first time, until its part is drawn. */
  const settled = new WeakMap<SideFrame, string[]>();
  /** The id the turn drew its message under, while the server stores it under another. */
  let asked: string | undefined;
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
    asked = undefined;
    early = [];
    waiting = [];
    aside = [];
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
      cancel ??= init.schedule(land);
    }
  };

  /** Places one side frame; false while what it targets has yet to be drawn. */
  const place = (frame: SideFrame): boolean => {
    if (submission == null || context == null) {
      return false;
    }
    const messages = context.messages;
    const placement = locate(frame, messages, placementContext(submission));
    if (placement == null) {
      return false;
    }
    if (placement.changed) {
      if (frame.type === 'steer_applied') {
        /** Marked as its part is drawn, so the part plays its draw-in once. */
        const drawn = frame.data.part?.steerId ?? frame.data.steerId;
        if (settled.get(frame)?.includes(drawn) === true) {
          init.steers?.markLiveApplied(drawn);
        }
      }
      const next = [...messages];
      next[placement.index] = placement.message;
      context.write(next);
      /**
       * A regenerate-shaped turn seeds its reply from the submission's placeholder, not from the
       * list, so a frame placed on that placeholder is carried there too or the first run step
       * drops it.
       */
      if (placement.message.messageId === submission.initialResponse?.messageId) {
        submission = { ...submission, initialResponse: placement.message };
      }
      settle(syncStreamMessage(stream, placement.message));
    }
    return placement.settled;
  };

  const retry = (): void => {
    if (waiting.length > 0) {
      waiting = waiting.filter((frame) => !place(frame));
    }
  };

  /** Writes the held tokens, then places what was waiting on them. */
  function land(): void {
    flush();
    retry();
  }

  /**
   * Held tokens land first: a placement reads the list and then replaces the streaming copy, so
   * placing ahead of them would lose them.
   */
  const side = (frame: SideFrame): void => {
    if (frame.type === 'steer_applied' && init.steers != null) {
      /** The server's word that the steer was taken settles its chip at once; drawing the part
       *  can wait for its target, and a chip left pending meanwhile could be sent again. */
      const { conversationId, steerId, clientSteerId, part } = frame.data;
      settled.set(
        frame,
        init.steers.resolve(
          conversationId ?? submission?.conversation?.conversationId ?? '',
          steerId,
          clientSteerId,
          part?.quotes,
        ) ?? [],
      );
    }
    land();
    if (!place(frame)) {
      waiting.push(frame);
    }
  };

  /** The conversation whose steers a terminal frame settles: the frame's, else the turn's. */
  const steerTarget = (named?: string | null): string | undefined => {
    const target = named ?? submission?.conversation?.conversationId;
    return target == null || target === '' ? undefined : target;
  };

  /**
   * A run that ends with no final frame leaves the reader's steers where main chat's session
   * leaves them. An error the server wrote parks the ones it had accepted, so they are claimed
   * as queued turns and a reload cannot bring their chips back. A stream the reader closed may
   * still be running on the server, which will take the steers it holds: only the ones it
   * refused are moved, so they are not drawn under the next reply. A dropped connection (an
   * error with a status) ends nothing, and moves nothing.
   */
  const sweep = (event: Extract<ChatEvent, { type: 'abort' | 'error' }>): void => {
    const target = steerTarget();
    if (init.steers == null || target == null) {
      return;
    }
    if (event.type === 'abort') {
      init.steers.convertLocalToQueued(target, { statuses: ABORT_SWEEP_STATUSES });
      return;
    }
    const generationProtocolVersion = init.protocol?.();
    if (event.status != null) {
      return;
    }
    if (generationProtocolVersion === 1 || supportsGenerationProtocolV2(event.data)) {
      init.steers.convertLocalToQueued(target, { claimParked: true, generationProtocolVersion });
    }
  };

  /** Applies a frame for the state beside the list, or holds it until its turn is named. */
  const beside = (frame: BesideFrame): void => {
    if (frame.type === 'title') {
      init.onTitle?.(frame.data);
    } else if (frame.type === 'steer_updated') {
      init.steers?.update(frame.data);
    } else if (submission == null) {
      aside.push(frame);
    } else if (frame.type === 'attachment') {
      init.onAttachment?.({ data: frame.data as TAttachment, submission });
    } else if (frame.type === 'context_usage') {
      init.usage?.contextHandler(frame.data, submission);
    } else {
      init.usage?.usageHandler(frame.data, submission);
    }
  };

  /** A turn was just named: its usage is bound to it, and what waited on it is applied. */
  const named = (next: EventSubmission): void => {
    init.usage?.bindResponse(next);
    const queued = aside;
    aside = [];
    for (const frame of queued) {
      beside(frame);
    }
  };

  const step = (event: StepEvent): void => {
    if (submission == null || context == null) {
      early.push(event);
      return;
    }
    /** Streamed output feeds the live usage estimate, as main chat's dispatch feeds it. */
    if (isOutputDelta(event)) {
      init.usage?.tapStream(event.data as { delta?: { content?: unknown } }, submission);
    }
    nameStepResponse(init.usage, event, submission);
    settle(reduceStep(stream, event, stepContext(submission, context)));
  };

  /**
   * The frames a snapshot carries beside its content, in order. `withheld` names the steps that
   * a pending OAuth prompt redraws, whose own OAuth events are skipped.
   */
  const replay = (
    frames: ReadonlyArray<object> | undefined,
    withheld?: ReadonlySet<string>,
  ): void => {
    for (const frame of frames ?? []) {
      const event = normalizeFrame(frame as ChatFrame);
      if (event == null) {
        continue;
      }
      if (isSideFrame(event)) {
        side(event);
        continue;
      }
      if (isBesideFrame(event)) {
        beside(event);
        continue;
      }
      if (event.type !== 'step') {
        continue;
      }
      const stepId = getStepEventId(event.data);
      if (stepId != null && withheld?.has(stepId) === true && isOAuthStepEvent(event.data)) {
        continue;
      }
      step(event.data as StepEvent);
    }
  };

  const created = (data: ChatCreatedFrame, ctx: ChatEventContext): void => {
    if (!data.message?.messageId) {
      return;
    }
    const steps = early;
    const sides = waiting;
    const asides = aside;
    reset();
    const drawn = drawnMessage(init.turn?.(), data, ctx.messages);
    const next = createdSubmission(data, ctx.messages, drawn);
    asked = drawn?.messageId;
    /** The list with the turn's message in it, which a regeneration's steps build on. */
    if (next.messages !== ctx.messages) {
      ctx.write(next.messages);
    }
    submission = next;
    waiting = sides;
    aside = asides;
    named(next);
    for (const event of steps) {
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
    waiting = [];
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
    named(next);
    /** The run's usage so far, which a chat that joins late did not watch arrive: its totals,
     *  its latest context reading, and an estimate of the output the snapshot already holds. */
    init.usage?.backfillUsage(resumeState.collectedUsage ?? [], next);
    if (resumeState.contextUsage != null) {
      init.usage?.contextHandler(resumeState.contextUsage, next);
    }
    init.usage?.seedLiveFromContent(resumeState.aggregatedContent, next);

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
      /** A regeneration's steps rebuild the list from this baseline, so it holds the placed turn. */
      next.messages = placement.messages;
      settle(syncStreamMessage(stream, placement.response));
    }

    /** A step paused on an OAuth prompt is drawn from the prompt, which holds the live sign-in
     *  link; the step's own replayed OAuth events may hold one that has since been replaced. */
    const prompts = resumeState.pendingOAuthPrompts ?? [];
    const prompted = new Set(prompts.map((prompt) => prompt.stepId));
    for (const prompt of prompts) {
      for (const event of oauthPromptSteps(prompt)) {
        step(event);
      }
    }
    /** The run is paused: its controls are drawn again after a reload or a dropped connection. */
    if (resumeState.pendingAction != null) {
      side({ type: 'pending_action', data: resumeState.pendingAction as Agents.PendingAction });
    }

    /** The chips are the server's still-queued steers, less the ones the content already holds:
     *  an empty list clears chips a steer applied while this chat was away would strand. */
    const steerConversationId = next.conversation?.conversationId ?? conversationId;
    init.steers?.seed(steerConversationId, resumeState.pendingSteers ?? []);
    init.steers?.settleApplied(steerConversationId, resumeState.aggregatedContent);
    if (resumeState.titleEvent != null) {
      init.onTitle?.(resumeState.titleEvent);
    }

    replay(resumeState.replayEvents, prompted);
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
      /**
       * A turn that streamed nothing still holds the empty reply it was drawn with, under the
       * id it had before the server named one. The frame's reply is that reply, so it takes its
       * place instead of landing beside it.
       */
      const drawn = submission?.initialResponse.messageId;
      const settled = event.data.responseMessage?.messageId;
      if (drawn != null && settled != null && drawn !== settled) {
        const kept = ctx.messages.filter((message) => message.messageId !== drawn);
        if (kept.length !== ctx.messages.length) {
          ctx.write(kept);
        }
      }
      /**
       * The row the turn drew for its message is the one the server stored, under the id the
       * frame's request names. It takes that id here, so the stored message lands on it
       * instead of beside it.
       */
      const stored = event.data.requestMessage?.messageId;
      const drew = asked;
      if (
        drew != null &&
        stored != null &&
        drew !== stored &&
        !ctx.messages.some((message) => message.messageId === stored)
      ) {
        ctx.write(
          ctx.messages.map((message) =>
            message.messageId === drew ? { ...message, messageId: stored } : message,
          ),
        );
      }
      /**
       * The reader's steers are settled before the list is: one the run never took becomes a
       * queued turn here, ahead of whoever is told the run ended and lets the queue go.
       */
      const ending = steerTarget(event.data.conversation?.conversationId);
      /**
       * Not for a frame that only says the run is over and carries none of it: no reply in it
       * says which steers the run took, so one it took would be queued to be sent again. Those
       * are settled against the stored rows, by whoever reads them.
       */
      if (init.steers != null && ending != null && event.data.reconcile !== true) {
        settleFinalSteers(init.steers, ending, event.data, init.protocol?.());
      }
      mergeFinalFrame(settledFinal(event.data, submission, ctx.messages), ctx);
      if (submission != null) {
        init.usage?.finalizeUsage(event.data, submission);
      }
      reset();
    } else if (isSideFrame(event)) {
      side(event);
    } else if (isBesideFrame(event)) {
      beside(event);
    } else if (event.type === 'abort' || event.type === 'error') {
      /** A turn that stops here keeps every token it streamed. */
      land();
      sweep(event);
    }
    if (init.schedule == null) {
      land();
    } else if (held == null) {
      retry();
    }
  };

  return { applyEvent, flush: land, reset };
}
