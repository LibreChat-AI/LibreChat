import { useRef, useState, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { TMessage, ChatEvent, ChatFinalFrame } from 'librechat-data-provider';
import type {
  ChatStatus,
  ChatGeneration,
  DetachedRun,
  ChatTransport,
  SubmittedTurn,
  ChatConnection,
  AnnounceOptions,
  ChatFinishResult,
  ResumableSteers,
  EventApplierInit,
  EventApplierEffect,
  GenerationProtocolVersion,
} from '../core';
import {
  Chat,
  MAX_RETRIES,
  getAllContentText,
  MESSAGE_UPDATE_INTERVAL,
  getReconnectDelay,
  rerunTurnMessages,
  createEventApplier,
  failedTurnMessages,
  withdrawnTurnMessages,
  hasPendingAssistantParent,
  prepareSubmittedTurn,
  describeSubmittedTurn,
  getRecoverySteerId,
  settleStoredSteers,
  settleFinishedSteers,
  resolveLostRunOutcome,
  restoreRefusedStart,
  toStartGenerationError,
  restoreReleasedSource,
  completedResponseMessageId,
  GENERATION_PROTOCOL_VERSION,
  supportsGenerationProtocolV2,
  getPredecessorMismatchStartResponse,
} from '../core';
import { ReactQueryChatState } from './state';
import { useSnapshot } from './snapshot';

export type FollowChatOptions = {
  /** The conversation followed. Its messages live in the cache under `[QueryKeys.messages, id]`. */
  id: string;
  /** Reaches the conversation's generation; `createGenerationTransport` over the app's routes. */
  transport: ChatTransport;
  /**
   * Reads the conversation's stored messages: its newest rows, or with `cursor` the rows before
   * a page already read. Called when the conversation is opened, again when a generation it
   * followed ends, since the stored rows are then the settled truth, and for an earlier page
   * when the reader asks for one. A plain list is the whole conversation.
   */
  loadMessages: (cursor?: string) => Promise<TMessage[] | FollowedPage>;
  /**
   * Whether the caller knows a generation is running. Turning true attaches to it, which covers a
   * run that starts after the conversation was opened; one signalled while the stored messages
   * are still being read is attached to once they are in. Turning false reads the stored
   * messages again, which covers a run that ended without a stream to say so.
   */
  live?: boolean;
  /** False follows nothing: no read, no stream, and an idle result. */
  enabled?: boolean;
  /**
   * The endpoint the conversation runs on, which a stop of a generation this chat did not start
   * is addressed to. A chat that only follows needs none.
   */
  endpoint?: string | null;
  /** Live status a step reports beside the message list. */
  onEffect?: (effect: EventApplierEffect) => void;
  /**
   * The handlers for what the stream changes beside the message list: usage, attachments, the
   * title and steer chips. A host that passes main chat's keeps the state main chat keeps, for
   * live frames and for what a late joiner missed. Read on every call.
   */
  beside?: FollowBeside;
  /** Every stream event after it was applied. */
  onEvent?: (event: ChatEvent) => void;
  onFinish?: (result: ChatFinishResult) => void;
  /**
   * A turn sent from here was stopped before the server kept anything of it. Its rows are gone
   * from the list; its words were the reader's and can be offered back to them.
   */
  onWithdrawn?: (turn: SubmittedTurn) => void;
  /**
   * The generation under the conversation as its stream names it, and `null` once it is over
   * or lost. What addresses it for everything done to a run in flight: a stop, a steer.
   */
  onGeneration?: (generation: FollowedGeneration | null) => void;
  /**
   * A generation ended, and the list is what it left: after the stored rows were read back, or
   * with a sent turn's own final frame in. Not for a stream that only dropped.
   */
  onRunEnd?: (end: FollowedRunEnd) => void;
  /**
   * Whether a generation that can no longer be followed is settled from the server's status, as
   * main chat's session settles its own. For a conversation the reader drives, whose queue and
   * steers wait on how its runs end: it is kept and looked for again while the server says it
   * is running or cannot say, and its end is said once the server says it is over. Without it
   * a follower stops at its last retry and says the run is out of reach (`isUnattached`), which
   * is what a caller with another way to show the run wants.
   */
  settlesLost?: boolean;
  /** The reader asked for the generation in flight to be stopped. */
  onStopped?: (generation: FollowedGeneration) => void;
  /**
   * This chat is being let go of while a generation it follows is still running. The server
   * keeps going with no one listening, so nothing will say how it ended: `run` names it, so
   * that its end can be read from the stored rows when the conversation is next shown. Not for
   * a rerun, a run the reader stopped, or one whose turn the server has not named yet.
   */
  onDetached?: (run: DetachedRun) => void;
  /**
   * The conversation was found with nothing running under it: as it opened, or after the stream
   * of a run it was following was gone. `messages` are its stored rows as just read, which hold
   * whatever an earlier run left.
   */
  onIdle?: (messages: TMessage[]) => void;
};

/** A generation as a stream names it. */
export type FollowedGeneration = {
  createdAt: number;
  protocolVersion: GenerationProtocolVersion;
};

/** How a generation ended. */
export type FollowedRunEnd = {
  outcome: 'completed' | 'aborted' | 'error';
  generationCreatedAt?: number;
  /** The reply it left, when it left one. */
  responseMessageId?: string;
  /**
   * Why the run ended on a frame that carried none of it. `abort_persistence_failed` says the
   * stop was not saved, so nothing queued behind the run may be sent on the strength of it.
   */
  reconcileReason?: ChatFinalFrame['reconcileReason'];
};

/** One page of stored messages, oldest first. */
export type FollowedPage = {
  messages: TMessage[];
  /** The cursor that reads the page before this one; nothing when this page holds the first row. */
  earlier?: string | null;
};

type AppliedBeside = Pick<EventApplierInit, 'usage' | 'onAttachment' | 'onTitle' | 'steers'>;

/**
 * Main chat's steer bookkeeping as a followed chat reaches it: what the event applier calls for
 * the frames it applies, and what a queued turn needs when its start is refused.
 */
type FollowedSteers = NonNullable<AppliedBeside['steers']> &
  Pick<ResumableSteers, 'restoreQueued' | 'blockRecovery' | 'isRecoveryHeld'>;

export type FollowBeside = Omit<AppliedBeside, 'steers'> & {
  steers?: FollowedSteers;
  /**
   * The list now holds what the server stores of the conversation: its stored rows were just
   * read, or a turn sent from here ended on its own final frame. `final` is the frame the last
   * generation ended on, when one ended since the list was last settled. It is where main chat's
   * stream session stamps the conversation with the reply it just committed, and where a fetch
   * of its history proves the reply it holds, so that reading the reply can be acknowledged.
   */
  onSettled?: (final?: ChatFinalFrame) => void;
  /**
   * What main chat says to a screen reader over a turn, said for this conversation's: that a
   * reply has started, that it is still being written, and, at its end, that it is done and
   * what it says.
   */
  announce?: (options: AnnounceOptions) => void;
};

/** The same handlers, looked up when a frame arrives, so the caller's latest are the ones called. */
const forwardBeside = (read: () => FollowBeside | undefined): Required<AppliedBeside> => ({
  usage: {
    bindResponse: (submission) => read()?.usage?.bindResponse(submission),
    nameResponse: (responseId, submission) => read()?.usage?.nameResponse?.(responseId, submission),
    contextHandler: (data, submission) => read()?.usage?.contextHandler(data, submission),
    usageHandler: (data, submission) => read()?.usage?.usageHandler(data, submission),
    tapStream: (data, submission) => read()?.usage?.tapStream(data, submission),
    tapContent: (text, submission) => read()?.usage?.tapContent(text, submission),
    finalizeUsage: (data, submission) => read()?.usage?.finalizeUsage(data, submission),
    backfillUsage: (entries, submission) => read()?.usage?.backfillUsage(entries, submission),
    seedLiveFromContent: (content, submission) =>
      read()?.usage?.seedLiveFromContent(content, submission),
    resetLive: (submission) => read()?.usage?.resetLive?.(submission),
  },
  onAttachment: (params) => read()?.onAttachment?.(params),
  onTitle: (frame) => read()?.onTitle?.(frame),
  steers: {
    resolve: (...args) => read()?.steers?.resolve(...args) ?? [],
    markLiveApplied: (steerId) => read()?.steers?.markLiveApplied(steerId),
    update: (event) => read()?.steers?.update(event),
    seed: (...args) => read()?.steers?.seed(...args),
    settleApplied: (...args) => read()?.steers?.settleApplied(...args),
    appliedIds: (values) => read()?.steers?.appliedIds(values) ?? [],
    adoptPromoted: (...args) => read()?.steers?.adoptPromoted(...args) ?? [],
    convertToQueued: (...args) => read()?.steers?.convertToQueued(...args),
    convertLocalToQueued: (...args) => read()?.steers?.convertLocalToQueued(...args),
  },
});

export type FollowedChat = {
  /** The chat, once the conversation's `id` has one. */
  chat: Chat | undefined;
  messages: TMessage[];
  status: ChatStatus;
  connection: ChatConnection;
  /** The stream's failure, if the generation it followed could not be read to its end. */
  error: Error | undefined;
  /** Whether the stored messages are still being read for the first time. */
  isLoading: boolean;
  /**
   * Whether a generation is being followed: from the moment an attach starts until its stream has
   * ended and the stored messages were read again. False with `live` set means there is nothing
   * to attach to.
   */
  isFollowing: boolean;
  /**
   * Whether the last attachment left nothing to follow: no generation was running, or its stream
   * dropped and could not be attached again. With `live` set, the run is out of this chat's reach.
   * False until an attachment has been tried, so a caller does not read "not yet" as "never".
   */
  isUnattached: boolean;
  /** Whether the stored messages could not be read; `retry` reads them again. */
  isLoadError: boolean;
  retry: () => void;
  /** Whether the conversation holds rows older than the ones read so far. */
  hasEarlier: boolean;
  /** Whether a page of older rows is being read. */
  isLoadingEarlier: boolean;
  /** Whether the last read of older rows failed; `loadEarlier` tries it again. */
  isEarlierError: boolean;
  /** Reads the page before the oldest row held, and puts it ahead of the list. */
  loadEarlier: () => void;
  /**
   * Whether the conversation can take a turn at this instant: its stored messages are in, and no
   * generation is being started, followed, looked for or read back. Read when a turn is about to
   * be built, since the answer a render holds can be a commit old.
   */
  canSend: () => boolean;
  /**
   * Sends a turn main chat's `ask` built, over the transport's send: the chat shows its rows,
   * posts its body and applies the generation it starts. False when the chat did not take it,
   * in which case nothing was shown or posted. A turn whose stream drops is attached to again,
   * as a followed one is.
   */
  send: (turn: SubmittedTurn) => boolean;
  /**
   * Stops the generation running under the conversation, whoever started it. A turn sent from
   * here that the server has not answered yet has no generation to name, so it is stopped by its
   * conversation, and is not attached to again.
   */
  stop: () => Promise<void>;
  /**
   * Looks for a generation running under the conversation and follows it to its end, for a
   * caller that learned of one this chat did not start: a turn the server took from the
   * reader's queue, a run begun elsewhere. Nothing happens while one is already followed; asked
   * during a turn sent from here, it looks once that turn is over.
   */
  attach: () => void;
};

type Entry = {
  id: string;
  chat: Chat;
  attach: () => Promise<void>;
  settle: () => Promise<boolean>;
  loadEarlier: () => Promise<void>;
  canSend: FollowedChat['canSend'];
  send: FollowedChat['send'];
  stop: FollowedChat['stop'];
};
/** What is known of the rows before the ones held, for the conversation `id`. */
type History = { id: string; hasEarlier: boolean; isLoading: boolean; isError: boolean };
type Load = { id: string; attempt: number; state: 'loading' | 'ready' | 'error' };
/**
 * One attachment: how it ended, unset when nothing was running, and whether it delivered any of
 * the generation. The frame that reports a failure is not a delivery. For a turn sent from here,
 * `foreign` says the server answered it with a generation that is not that turn: one already
 * running, or a newer one that replaced it; `withdrawn` says it was stopped before the server
 * saved anything of it.
 */
type Attachment = {
  finished?: ChatFinishResult;
  received: boolean;
  foreign?: boolean;
  withdrawn?: boolean;
  /** The final frame it ended on, whether or not that frame carried the run's messages. */
  terminal?: ChatFinalFrame;
  /**
   * It ended on an error the server wrote into the stream; `negotiated` says that error spoke
   * the generation protocol whose parked steers this client may restore.
   */
  failure?: { negotiated: boolean };
  /**
   * For a turn sent from here that was never admitted, so nothing of it stays in the list:
   * `behind` when another generation had taken the place it was queued for, which is then the
   * one to follow; `held` when it would have replayed a steer the reader had already dealt with.
   */
  displaced?: 'behind' | 'held';
  /** For a turn sent from here: its start failed in a way that may still have started it. */
  unanswered?: boolean;
};

/**
 * How many more times a run the caller knows of is looked for after it was not found. Short: a
 * caller with another way to show the run is waiting on the answer.
 */
export const ABSENT_RETRIES = 2;

const noMessages: TMessage[] = [];
const nothing = (): void => undefined;
const toPage = (read: TMessage[] | FollowedPage): Required<FollowedPage> =>
  Array.isArray(read)
    ? { messages: read, earlier: null }
    : { messages: read.messages, earlier: read.earlier ?? null };
const refuse = (): boolean => false;
const idle = (): Promise<void> => Promise.resolve();
const unsubscribed = (): (() => void) => () => undefined;

/** One write per frame for streamed tokens, as main chat's step handler coalesces them. */
const perFrame = (flush: () => void): (() => void) => {
  if (typeof requestAnimationFrame !== 'function') {
    flush();
    return () => undefined;
  }
  const handle = requestAnimationFrame(flush);
  return () => cancelAnimationFrame(handle);
};

/**
 * Follows one conversation: shows its stored messages, attaches to the generation running under
 * it and applies that stream the way main chat does, then reads the stored messages again once
 * the generation ends. A stream that drops is not an end: what it
 * showed stays, and the attachment is made again on main chat's reconnect schedule. The
 * conversation is a core `Chat` over the message cache, so anything that reads
 * `[QueryKeys.messages, id]` sees what it writes.
 *
 * A subagent's child thread is one the reader only follows. One the reader drives is the same
 * thing with `send`, over a transport that can start a generation.
 */
export function useFollowChat({
  id,
  transport,
  loadMessages,
  live = false,
  enabled = true,
  endpoint,
  onEffect,
  beside,
  onEvent,
  onFinish,
  onWithdrawn,
  onGeneration,
  onRunEnd,
  settlesLost = false,
  onStopped,
  onDetached,
  onIdle,
}: FollowChatOptions): FollowedChat {
  const queryClient = useQueryClient();
  const host = useRef({
    transport,
    loadMessages,
    live,
    endpoint,
    onEffect,
    beside,
    onEvent,
    onFinish,
    onWithdrawn,
    onGeneration,
    onRunEnd,
    settlesLost,
    onStopped,
    onDetached,
    onIdle,
  });
  host.current = {
    transport,
    loadMessages,
    live,
    endpoint,
    onEffect,
    beside,
    onEvent,
    onFinish,
    onWithdrawn,
    onGeneration,
    onRunEnd,
    settlesLost,
    onStopped,
    onDetached,
    onIdle,
  };
  const [attempt, setAttempt] = useState(0);
  const [entry, setEntry] = useState<Entry>();
  const [load, setLoad] = useState<Load>({ id, attempt, state: 'loading' });
  const [history, setHistory] = useState<History>({
    id,
    hasEarlier: false,
    isLoading: false,
    isError: false,
  });
  const [following, setFollowing] = useState(false);
  const [unattached, setUnattached] = useState(false);
  const wasLive = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setEntry(undefined);
      return;
    }
    let stale = false;
    let loaded = false;
    let attaching = false;
    /** Whether the attachment in progress is past its stream, reading the stored rows. */
    let reading = false;
    /** A live signal that arrived during that read, when it could only be for a newer run. */
    let owed = false;
    let attachment: Attachment | undefined;
    let wake: (() => void) | undefined;
    /** The turn being handed to the chat, which asks for it back inside the same call. */
    let handed: SubmittedTurn | undefined;
    /** The turn sent from here that is in flight, whose rows the chat drew. */
    let sent: SubmittedTurn | undefined;
    /** Whether a turn sent from here is in flight, which is not an attachment to follow or read over. */
    let driving = false;
    /** Reads of the stored rows in flight, each of which replaces the list when it lands. */
    let reads = 0;
    /** The reader's stop in flight, which the turn it ends waits for instead of reattaching. */
    let stopping: Promise<void> | undefined;
    /** The generation the stream in hand names, until it ends or is lost. */
    let generation: FollowedGeneration | undefined;
    /**
     * The turn that generation answers, once the server has named it: its message, the reply
     * it is writing, and whether it reruns an earlier turn.
     */
    let answering:
      | { userMessageId: string; responseMessageId?: string; rerun: boolean }
      | undefined;
    /** Whether the reader asked for that generation to be stopped. */
    let halted = false;
    const note = (stream: ChatGeneration | null | undefined): void => {
      if (stream?.generationCreatedAt == null) {
        return;
      }
      /** Another generation is another turn; the same one attached to again is the same turn. */
      if (generation?.createdAt !== stream.generationCreatedAt) {
        answering = undefined;
        halted = false;
      }
      generation = {
        createdAt: stream.generationCreatedAt,
        protocolVersion:
          stream.generationProtocolVersion === GENERATION_PROTOCOL_VERSION
            ? GENERATION_PROTOCOL_VERSION
            : 1,
      };
      host.current.onGeneration?.(generation);
    };
    /**
     * One request's generation, which the transport names ahead of its stream: noted then, and
     * not a second time when the stream of that same generation arrives.
     */
    const naming = () => {
      let named: number | undefined;
      return {
        ahead: (told: ChatGeneration): void => {
          named = told.generationCreatedAt;
          note(told);
        },
        arrived: (stream: ChatGeneration | null | undefined): void => {
          if (stream?.generationCreatedAt !== named) {
            note(stream);
          }
        },
      };
    };
    /**
     * Not said once this chat is let go of: the generation may be running on, and whoever shows
     * the conversation next addresses it by the same name.
     */
    const forget = (): FollowedGeneration | undefined => {
      const known = generation;
      generation = undefined;
      answering = undefined;
      halted = false;
      if (known != null && !stale) {
        host.current.onGeneration?.(null);
      }
      return known;
    };
    /**
     * How a generation ended, as main chat's stream session says it, since it decides whether
     * what is queued behind the run is sent. A run that ended on a frame carrying none of it
     * completed only if the server says so and its stored rows were read; a start the server
     * answered as already settled is not a completion of this turn. A stop that lands just
     * before the run completes can end it on a reply marked unfinished with no word of an
     * abort: it was stopped all the same.
     */
    const outcomeOf = (current: Attachment, read: boolean): FollowedRunEnd['outcome'] => {
      const { finished, terminal, withdrawn } = current;
      if (finished?.isError === true) {
        return 'error';
      }
      if (finished?.isSettled === true) {
        if (terminal?.terminalStatus === 'complete') {
          return read ? 'completed' : 'error';
        }
        return 'aborted';
      }
      if (
        finished?.isAbort === true ||
        withdrawn === true ||
        finished?.message?.unfinished === true
      ) {
        return 'aborted';
      }
      return 'completed';
    };
    /**
     * Tells the caller a generation ended, once the list holds what it left. `read` says the
     * stored rows were read since it ended, and `turn` is the turn sent from here, if it was one.
     */
    const runEnded = (
      current: Attachment | undefined,
      read: boolean,
      turn?: SubmittedTurn,
    ): void => {
      const known = forget();
      const finished = current?.finished;
      if (current == null || finished == null || finished.isDisconnect === true) {
        return;
      }
      const outcome = outcomeOf(current, read);
      /** A run with no reply of its own in hand is named by the reply the stored rows hold. */
      const responseMessageId =
        finished.isSettled === true
          ? completedResponseMessageId(
              outcome === 'completed' ? chat.messages : undefined,
              turn?.submission.userMessage?.messageId ??
                current.terminal?.requestMessage?.messageId,
              turn?.submission.initialResponse?.messageId ?? finished.message?.messageId,
            )
          : finished.message?.messageId;
      host.current.onRunEnd?.({
        outcome,
        generationCreatedAt: known?.createdAt,
        responseMessageId,
        ...(finished.reconcileReason != null && { reconcileReason: finished.reconcileReason }),
      });
    };
    /**
     * Whether the run's steers are still to be settled against the stored rows: it ended, and
     * on nothing that carried its reply. A final frame with the reply in it settled them when
     * it was applied, and so did an error the server wrote.
     */
    const unsettled = (current: Attachment | undefined): boolean =>
      current?.finished != null &&
      current.finished.isDisconnect !== true &&
      current.failure == null &&
      (current.terminal == null || current.terminal.reconcile === true);
    /**
     * Settles the reader's steers, for a run this chat followed to an end that carried no reply,
     * against the rows just read and the run's last status. Nothing while a generation is
     * running under the conversation: its own frames settle them.
     */
    const settleSteers = async (current: Attachment, turn?: SubmittedTurn): Promise<void> => {
      const steers = host.current.beside?.steers;
      if (steers == null) {
        return;
      }
      const status = await Promise.resolve(host.current.transport.getStatus?.(id)).catch(
        () => undefined,
      );
      if (stale || status?.active === true) {
        return;
      }
      settleStoredSteers(steers, id, {
        messages: chat.messages,
        status,
        promoted: current.terminal?.promotedSteers,
        recoverySteerId: turn == null ? null : getRecoverySteerId(turn.submission),
        generationProtocolVersion: generation?.protocolVersion,
      });
    };
    /** The final frame the last generation ended on, until the caller is told the list settled. */
    let ended: ChatFinalFrame | undefined;
    const settled = (): void => {
      const final = ended;
      ended = undefined;
      host.current.beside?.onSettled?.(final);
    };
    /** When the reader was last told a reply is being written, so they are not told too often. */
    let announced = 0;
    const announce = (options: AnnounceOptions): void => host.current.beside?.announce?.(options);
    const applier = createEventApplier({
      schedule: perFrame,
      onEffect: (effect) => {
        if (effect.type === 'announce') {
          announce({ message: effect.message, isStatus: true });
        }
        host.current.onEffect?.(effect);
      },
      ...forwardBeside(() => host.current.beside),
      protocol: () => generation?.protocolVersion,
      /** Not when the server answered the start with a generation that is not this turn. */
      turn: () => (attachment?.foreign === true ? undefined : sent?.submission),
    });
    /**
     * A start the server refused leaves a turn taken from the reader's queue where main chat
     * leaves it: back in the queue, in its place. A turn another generation got ahead of (the
     * place it was queued for was taken) was never admitted, so it goes back behind the
     * generation that won, and is marked so that nothing of it stays in the list.
     */
    const refused = (
      turn: SubmittedTurn | undefined,
      current: Attachment | undefined,
      error: unknown,
    ): void => {
      const steers = host.current.beside?.steers;
      if (turn == null || steers == null) {
        return;
      }
      const winner = getPredecessorMismatchStartResponse(error);
      if (winner != null) {
        steers.restoreQueued(turn.submission, winner.generationCreatedAt);
        if (current != null) {
          current.displaced = 'behind';
        }
        return;
      }
      const restored = restoreRefusedStart(steers, turn.submission, toStartGenerationError(error));
      if (!restored && current != null) {
        current.unanswered = true;
      }
    };
    /**
     * A turn that replays a parked steer ended without the server keeping it: its start failed
     * in a way that may have started it, or the stream reported the failure. Only a status
     * read now, after that end, can say the server let the steer go again, and so put it back.
     */
    const recoverSource = async (turn: SubmittedTurn, current: Attachment): Promise<void> => {
      const steers = host.current.beside?.steers;
      const recoverySteerId = getRecoverySteerId(turn.submission);
      const ended =
        current.unanswered === true ||
        (current.failure?.negotiated === true &&
          generation?.protocolVersion === GENERATION_PROTOCOL_VERSION);
      if (steers == null || recoverySteerId == null || !ended) {
        return;
      }
      const status = await Promise.resolve(host.current.transport.getStatus?.(id)).catch(
        () => undefined,
      );
      if (stale || status == null) {
        return;
      }
      restoreReleasedSource(steers, id, recoverySteerId, status, GENERATION_PROTOCOL_VERSION);
    };
    const chat = new Chat({
      id,
      state: new ReactQueryChatState({ queryClient, key: id }),
      /** Read on every call, so a transport rebuilt for a refreshed token is the one used. */
      transport: {
        sendMessages: async (request) => {
          const turn = attachment;
          const asked = sent;
          const steers = host.current.beside?.steers;
          const replayed = asked == null ? null : getRecoverySteerId(asked.submission);
          if (asked != null && replayed != null && steers?.isRecoveryHeld(id, replayed) === true) {
            /** The reader removed or changed the steer this turn would replay: it is not sent. */
            steers.restoreQueued(asked.submission);
            if (turn != null) {
              turn.displaced = 'held';
            }
            throw new Error('The steer this turn would replay is no longer the reader’s to send');
          }
          let answer: Awaited<ReturnType<ChatTransport['sendMessages']>>;
          const told = naming();
          try {
            /**
             * The generation is noted when the server names it, as main chat installs it on
             * its controls before it opens the stream: what is written meanwhile can steer it
             * or queue behind it, and a stop names it.
             */
            answer = await host.current.transport.sendMessages({
              ...request,
              onGeneration: told.ahead,
            });
          } catch (error) {
            refused(asked, turn, error);
            throw error;
          }
          if (turn != null) {
            turn.foreign =
              answer.status === 'replaced' ||
              (answer.status === 'stream' && answer.stream.resumed === true);
          }
          if (answer.status === 'stream') {
            told.arrived(answer.stream);
          }
          return answer;
        },
        reconnectToStream: async (request) => {
          /**
           * A generation the server says is running is noted before its stream is had, as a
           * turn sent from here is. One whose stream then cannot be had is not nothing: it is
           * kept and looked for again, and its end is said when the server says it is over.
           */
          const told = naming();
          const stream = await host.current.transport.reconnectToStream({
            ...request,
            onGeneration: told.ahead,
          });
          told.arrived(stream);
          return stream;
        },
        abort: (request) => host.current.transport.abort(request),
        getStatus: (conversationId) =>
          host.current.transport.getStatus?.(conversationId) ?? Promise.resolve({ active: false }),
      },
      prepareRequest: () => {
        const turn = handed;
        handed = undefined;
        if (turn == null) {
          throw new Error('A followed conversation takes the turns `send` hands it, and no others');
        }
        return prepareSubmittedTurn(turn);
      },
      applyEvent: applier.applyEvent,
      resumeSelection: () => ({ endpoint: host.current.endpoint }),
      onEvent: (event) => {
        if (attachment != null && event.type !== 'error') {
          attachment.received = true;
        }
        if (attachment != null && event.type === 'final') {
          attachment.terminal = event.data;
        } else if (attachment != null && event.type === 'error' && event.status == null) {
          attachment.failure = { negotiated: supportsGenerationProtocolV2(event.data) };
        }
        if (event.type === 'sync') {
          const resumed = event.data.resumeState;
          const named = resumed?.userMessage?.messageId;
          if (named != null) {
            answering = {
              userMessageId: named,
              responseMessageId: resumed?.responseMessageId,
              rerun: false,
            };
          }
        }
        if (event.type === 'final' && event.data.earlyAbort === true) {
          /** Stopped before the server kept anything of it: there is no reply it ended on. */
          if (attachment != null) {
            attachment.withdrawn = true;
          }
        } else if (event.type === 'final') {
          ended = event.data;
          announce({ message: 'end', isStatus: true });
          announce({ message: getAllContentText(event.data.responseMessage as TMessage | null) });
        } else if (event.type === 'created') {
          const own = attachment?.foreign === true ? undefined : sent?.submission;
          const named = event.data.message?.messageId;
          if (named != null) {
            answering = {
              userMessageId: named,
              responseMessageId:
                event.data.turn?.responseMessageId ?? own?.initialResponse?.messageId,
              rerun: own?.isRegenerate === true,
            };
          }
          announced = Date.now();
          announce({ message: 'start', isStatus: true });
        } else if (event.type === 'step' && Date.now() - announced > MESSAGE_UPDATE_INTERVAL) {
          announced = Date.now();
          announce({ message: 'composing', isStatus: true });
        }
        host.current.onEvent?.(event);
      },
      onFinish: (result) => {
        if (attachment != null) {
          attachment.finished = result;
        }
        host.current.onFinish?.(result);
      },
    });

    const pause = (delay: number): Promise<void> =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, delay);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });

    const follow = async (): Promise<Attachment> => {
      const current: Attachment = { received: false };
      attachment = current;
      await chat.resumeStream();
      return current;
    };

    /** The cursor of the page before the oldest row held; nothing when that row is the first. */
    let earlier: string | null = null;
    /**
     * Whether `earlier` describes the rows held. Not until this follower has placed a page of
     * its own: the list it starts with is whatever an earlier follower of the conversation left
     * in the cache, and where those rows begin was that follower's to know.
     */
    let placed = false;
    let readingEarlier = false;

    /**
     * Reads the newest page. Rows the reader already paged back to are older than it and are
     * not read again, so they stay ahead of it: the page starts at a row the list holds, and
     * everything before that row is kept. A page that starts at no row the list holds does not
     * join onto it, so it replaces the list, and what came before it is read from there. So
     * does the first page this follower reads, since only then is the start of the list known.
     */
    const read = async (): Promise<void> => {
      reads += 1;
      try {
        const page = toPage(await host.current.loadMessages());
        if (stale) {
          return;
        }
        const held = chat.messages;
        const first = page.messages[0]?.messageId;
        const joinsAt = first == null ? -1 : held.findIndex((row) => row.messageId === first);
        if (placed && joinsAt > 0) {
          await chat.setMessages([...held.slice(0, joinsAt), ...page.messages]);
          settled();
          return;
        }
        await chat.setMessages(page.messages);
        placed = true;
        earlier = page.earlier;
        setHistory({ id, hasEarlier: earlier != null, isLoading: false, isError: false });
        settled();
      } finally {
        reads -= 1;
      }
    };

    /** Reads the page before the oldest row held and puts it ahead of the list. */
    const loadEarlier = async (): Promise<void> => {
      const cursor = earlier;
      if (stale || !loaded || cursor == null || readingEarlier) {
        return;
      }
      readingEarlier = true;
      setHistory({ id, hasEarlier: true, isLoading: true, isError: false });
      try {
        const page = toPage(await host.current.loadMessages(cursor));
        /** The list was replaced meanwhile, and with it what "before it" means. */
        if (stale || earlier !== cursor) {
          return;
        }
        await chat.setMessages((current) => {
          const known = new Set(current.map((row) => row.messageId));
          return [...page.messages.filter((row) => !known.has(row.messageId)), ...current];
        });
        earlier = page.earlier;
        setHistory({ id, hasEarlier: earlier != null, isLoading: false, isError: false });
      } catch {
        if (!stale && earlier === cursor) {
          setHistory({ id, hasEarlier: true, isLoading: false, isError: true });
        }
      } finally {
        readingEarlier = false;
      }
    };

    /**
     * Follows whatever is running to its end, then takes the stored rows as the result. A dropped
     * stream leaves the generation running, so the rows it showed are kept, not replaced by
     * stored ones that may not hold them yet, and the attachment is made again. An attachment
     * that delivered something starts the count of failed ones over.
     */
    /**
     * A generation this chat was following can no longer be followed, in one of two ways. It is
     * `gone`: its stream dropped and nothing was running when it was looked for again. Or it is
     * `unreachable`: the connection failed past its last retry, which is the transport giving
     * up and not the generation ending. Only the server's status says what became of it, as it
     * does for main chat's session, and only a status from a server that speaks the
     * generation's protocol can say so: during a rollout an older responder cannot adjudicate
     * a newer job.
     *
     * - Unreachable, and the status says it is still running, or cannot say: nothing is settled.
     *   It is kept, and looked for again after a wait.
     * - Gone, and the status names something running or cannot adjudicate: the same, after a
     *   short wait. A stream can briefly lose its record while its generation lives, and a
     *   newer generation is one to follow.
     * - Otherwise it is over. Unreachable: the stored rows are read and its end is said with
     *   the outcome the status gives. Gone: nothing says how it ended, so it is taken as
     *   stopped; but the rows are first handed to a caller that had remembered the run, which
     *   can read its end from them. Either way its steers are settled against the rows, and
     *   the chips still left are swept only when the run is proved over.
     *
     * Returns whether it is kept to be looked for again.
     */
    const settleLost = async (
      how: 'gone' | 'unreachable',
      current?: Attachment,
    ): Promise<boolean> => {
      const known = generation;
      const turn = answering;
      const status = await Promise.resolve(host.current.transport.getStatus?.(id)).catch(
        () => undefined,
      );
      if (stale) {
        return false;
      }
      const speaks =
        known?.protocolVersion !== GENERATION_PROTOCOL_VERSION ||
        supportsGenerationProtocolV2(status);
      const answer = status != null && speaks ? status : undefined;
      const undecided =
        how === 'unreachable'
          ? answer == null || answer.active === true
          : status != null && (answer == null || answer.active === true);
      if (known != null && undecided) {
        await pause(getReconnectDelay(how === 'unreachable' ? MAX_RETRIES : 1));
        owed = !stale;
        return !stale;
      }
      let rows = how === 'gone';
      if (!rows) {
        reading = true;
        rows = await read().then(
          () => true,
          () => false,
        );
        if (stale) {
          return false;
        }
      }
      if (how === 'gone' && answer != null && answer.active !== true) {
        host.current.onIdle?.(chat.messages);
      }
      const steers = host.current.beside?.steers;
      if (steers != null && status?.active !== true) {
        settleStoredSteers(steers, id, {
          messages: rows ? chat.messages : undefined,
          status: answer,
          generationProtocolVersion: known?.protocolVersion,
          sweep: answer != null || known?.protocolVersion === 1,
        });
      }
      if (how === 'gone' && current != null) {
        runEnded(current, true);
        return false;
      }
      forget();
      if (known == null) {
        return false;
      }
      const outcome =
        how === 'unreachable' && answer != null
          ? resolveLostRunOutcome(answer, known.createdAt, rows)
          : 'aborted';
      host.current.onRunEnd?.({
        outcome,
        generationCreatedAt: known.createdAt,
        responseMessageId:
          outcome === 'completed'
            ? completedResponseMessageId(
                chat.messages,
                turn?.userMessageId,
                answer?.resumeState?.responseMessageId ?? turn?.responseMessageId,
              )
            : undefined,
      });
      return false;
    };

    const attach = async (): Promise<void> => {
      if (stale || !loaded) {
        return;
      }
      if (driving) {
        /** The turn in flight is this chat's own; whatever runs after it is asked for then. */
        owed = true;
        return;
      }
      if (attaching) {
        owed ||= reading;
        return;
      }
      attaching = true;
      setFollowing(true);
      setUnattached(false);
      /** Whether a generation was reached and not lost for good. */
      let reached = false;
      /** The last attachment, whose end is the generation's unless it dropped. */
      let last: Attachment | undefined;
      /** Whether attaching failed past its last retry. */
      let unreachable = false;
      /** Whether the generation is kept to be looked for again, its fate not yet known. */
      let kept = false;
      try {
        for (let failures = 0, absences = 0; !stale; ) {
          last = await follow();
          const { finished, received } = last;
          reached ||= received || finished != null;
          /**
           * The caller says a run is going and none was found. Its stream may not be open yet:
           * a run is announced as running before its generation is, so the attachment is tried
           * again shortly before it is taken to have nothing to attach to.
           */
          if (!reached && host.current.live && absences < ABSENT_RETRIES) {
            absences += 1;
            await pause(getReconnectDelay(absences));
            continue;
          }
          if (finished?.isDisconnect !== true) {
            break;
          }
          failures = received ? 1 : failures + 1;
          if (failures > MAX_RETRIES) {
            unreachable = true;
            break;
          }
          await pause(getReconnectDelay(failures));
        }
        if (stale) {
          return;
        }
        const settles = host.current.settlesLost;
        if (unreachable) {
          kept = settles && (await settleLost('unreachable'));
          reached = settles && !kept && generation == null;
        } else {
          reading = true;
          await read();
          const gone = last?.finished?.isSettled === true && last.terminal == null;
          if (settles && gone) {
            kept = await settleLost('gone', last);
          } else if (settles && last?.finished == null && generation != null) {
            /** Kept from an earlier look, and still nothing to follow. */
            kept = await settleLost('gone');
          } else {
            if (last != null && unsettled(last)) {
              await settleSteers(last);
            }
            if (stale) {
              return;
            }
            runEnded(last, true);
          }
        }
      } catch {
        /** The chat reports a stream failure itself; a failed re-read leaves what it streamed. */
      } finally {
        attaching = false;
        reading = false;
        /**
         * Lost, or never read back: nothing is addressed as running any more. Unless it is kept
         * to be looked for again, when it is still the one a stop or a steer addresses.
         */
        if (!kept) {
          forget();
        }
        if (!stale) {
          setFollowing(false);
          setUnattached(!reached);
        }
      }
      if (owed) {
        owed = false;
        await attach();
      }
    };

    /**
     * The caller saw the run end. A stream still open reads the stored rows itself when it ends.
     * Says whether the rows were read.
     */
    const settle = async (): Promise<boolean> => {
      if (stale || !loaded || attaching || driving) {
        return false;
      }
      try {
        await read();
        return true;
      } catch {
        /** What is shown stays; the next open reads again. */
        return false;
      }
    };

    const open = async (): Promise<void> => {
      try {
        /**
         * Asked before the read, so a run that had already ended is fully in what is read. A status
         * that cannot be read says nothing about the stored rows, which are read all the same.
         */
        const status = await Promise.resolve(host.current.transport.getStatus?.(id)).catch(
          () => 'unknown' as const,
        );
        await read();
        if (stale) {
          return;
        }
        loaded = true;
        setLoad({ id, attempt, state: 'ready' });
        /**
         * A run the caller signalled during the read had nothing to attach to until now. With the
         * status unknown the attachment asks again, and reports or retries its own failure.
         */
        if (status === 'unknown' || status?.active === true || host.current.live) {
          await attach();
          return;
        }
        /**
         * Nothing is running, so a steer still shown as waiting is waiting on a run that ended
         * while this conversation was not open: it is settled against what that run left.
         */
        const steers = host.current.beside?.steers;
        if (status != null && steers != null) {
          settleFinishedSteers(steers, id, status, chat.messages);
        }
        if (status != null) {
          host.current.onIdle?.(chat.messages);
        }
      } catch {
        if (!stale) {
          setLoad({ id, attempt, state: 'error' });
        }
      }
    };

    const canSend = (): boolean =>
      !stale &&
      loaded &&
      !attaching &&
      !driving &&
      reads === 0 &&
      (chat.status === 'ready' || chat.status === 'error');

    /**
     * How a turn sent from here ended decides what follows it.
     *
     * - Its stream dropped: the generation runs on, so it is attached to again like any other,
     *   unless the reader's own stop is what dropped it.
     * - The server settled it without a stream, answered it with a generation that is not this
     *   turn (one already running, or a newer one that replaced it), or the reader stopped it
     *   before the server answered: the list is not this turn's to complete, so the stored rows
     *   are read.
     * - Otherwise it ended on its own stream and the list is its result, completed the way main
     *   chat completes it: a turn stopped before the server kept anything of it leaves the rows
     *   from before it, a failure becomes the turn's reply, and a rerun gets back the branches
     *   it set aside.
     */
    const conclude = async (turn: SubmittedTurn, current: Attachment): Promise<void> => {
      const { finished } = current;
      const stopped = stopping;
      if (sent === turn) {
        sent = undefined;
      }
      const dropped = finished?.isDisconnect === true && stopped == null;
      /** Whether the list is this turn's to complete: it ran, as itself, to an end of its own. */
      let own =
        current.foreign !== true && finished?.isDisconnect !== true && finished?.isSettled !== true;
      try {
        if (stopped != null) {
          await stopped.catch(() => undefined);
        }
        if (!stale && own) {
          let completed: TMessage[] | undefined;
          if (current.withdrawn === true || current.displaced != null) {
            completed = withdrawnTurnMessages(turn, chat.messages);
          } else if (finished?.isError === true) {
            completed = failedTurnMessages(turn, chat.messages, chat.error);
          } else {
            completed = rerunTurnMessages(turn, finished?.message);
          }
          if (completed != null) {
            await chat.setMessages(completed);
          }
          if (current.withdrawn === true) {
            host.current.onWithdrawn?.(turn);
          }
          /**
           * However the turn ended, it may not leave its empty reply behind as one still on its
           * way: nothing more will fill it, and the next turn would be refused as answering a
           * reply that has not arrived. What the server kept is then the result.
           */
          const replyId = turn.submission.initialResponse?.messageId;
          const reply = chat.messages.find((message) => message.messageId === replyId);
          own = reply == null || !hasPendingAssistantParent(reply);
        }
      } finally {
        /** Only now can another turn be built: on the list this one left, not the one before it. */
        driving = false;
      }
      if (stale) {
        return;
      }
      if (current.displaced != null) {
        /**
         * The turn was never admitted, and where it belongs it is back in the reader's queue.
         * No run is said to have ended: that would send it again at once. When another
         * generation took its place, that generation is followed to its end.
         */
        chat.clearError();
        forget();
        if (current.displaced === 'behind' || owed) {
          owed = false;
          await attach();
        }
        return;
      }
      await recoverSource(turn, current);
      if (stale) {
        return;
      }
      if (dropped || owed) {
        owed = false;
        /** A turn that ended is over even when another generation is waiting to be followed. */
        if (!dropped) {
          runEnded(current, false, turn);
        }
        await attach();
        return;
      }
      if (!own) {
        const read = await settle();
        if (read && unsettled(current)) {
          await settleSteers(current, turn);
        }
        if (stale) {
          return;
        }
        runEnded(current, read, turn);
        return;
      }
      /** The turn's own final frame is its result, and the list as it stands is what it left. */
      if (ended != null) {
        settled();
      } else {
        /**
         * It ended with no final frame: it failed, or was stopped before the server kept
         * anything of it. Nothing settles what was counted for its reply, so that count is
         * dropped here, as main chat drops it, instead of being added to the conversation's
         * next reply.
         */
        host.current.beside?.usage?.resetLive?.(turn.submission);
      }
      runEnded(current, false, turn);
    };

    /**
     * A stop the chat could not address is a turn the server has not answered: it may be running
     * with nothing naming it yet. The server finds it by its conversation, and if it only
     * appears afterwards, by the generation the status route then names.
     */
    const stop = (): Promise<void> => {
      if (generation != null) {
        halted = true;
        host.current.onStopped?.(generation);
      }
      const asked = (async (): Promise<void> => {
        const result = await chat.stop();
        const endpoint = host.current.endpoint;
        if (result.status !== 'unaddressable' || endpoint == null || endpoint === '') {
          return;
        }
        await host.current.transport.abort({ chatId: id, endpoint });
        const status = await host.current.transport.getStatus?.(id);
        if (status?.active === true) {
          await host.current.transport.abort({
            chatId: id,
            endpoint,
            streamId: status.streamId,
            generationCreatedAt: status.createdAt,
          });
        }
      })();
      stopping = asked;
      const done = (): void => {
        if (stopping === asked) {
          stopping = undefined;
        }
      };
      asked.then(done, done);
      return asked;
    };

    const send = (turn: SubmittedTurn): boolean => {
      if (!canSend()) {
        return false;
      }
      const request = describeSubmittedTurn(turn);
      const current: Attachment = { received: false };
      handed = turn;
      let sending: Promise<void>;
      if (request.trigger === 'submit-message' && request.input != null) {
        sending = chat.sendMessage(request.input);
      } else if (request.trigger === 'continue-message' && request.messageId != null) {
        sending = chat.continue({ messageId: request.messageId });
      } else {
        sending = chat.regenerate({ messageId: request.messageId });
      }
      /** The chat asks for the turn before the call returns, unless it refused the request. */
      const taken = handed == null;
      handed = undefined;
      if (!taken) {
        sending.catch(() => undefined);
        return false;
      }
      driving = true;
      sent = turn;
      attachment = current;
      void sending.then(
        () => conclude(turn, current),
        () => conclude(turn, current),
      );
      return true;
    };

    setEntry({ id, chat, attach, settle, loadEarlier, canSend, send, stop });
    setHistory({ id, hasEarlier: false, isLoading: false, isError: false });
    setLoad({ id, attempt, state: 'loading' });
    setFollowing(false);
    setUnattached(false);
    void open();

    return () => {
      stale = true;
      if (generation != null && answering != null && !answering.rerun && !halted) {
        host.current.onDetached?.({
          userMessageId: answering.userMessageId,
          responseMessageId: answering.responseMessageId,
          generationCreatedAt: generation.createdAt,
        });
      }
      wake?.();
      applier.reset();
      chat.dispose();
    };
  }, [id, attempt, enabled, queryClient]);

  const current = enabled && entry?.id === id ? entry : undefined;
  useEffect(() => {
    if (current == null) {
      return;
    }
    if (live) {
      void current.attach();
    } else if (wasLive.current) {
      void current.settle();
    }
    wasLive.current = live;
  }, [live, current]);

  const chat = current?.chat;
  const subscribe = useCallback(
    (listener: () => void) => chat?.subscribe(listener) ?? unsubscribed(),
    [chat],
  );
  const messages = useSnapshot(subscribe, () => chat?.messages ?? noMessages);
  const status = useSnapshot(subscribe, () => chat?.status ?? 'ready');
  const connection = useSnapshot(subscribe, () => chat?.connection ?? 'idle');
  const error = useSnapshot(subscribe, () => chat?.error);
  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  const pageBack = current?.loadEarlier;
  const loadEarlier = useCallback(() => void pageBack?.(), [pageBack]);
  const older = current != null && history.id === id ? history : undefined;
  const canSend = current?.canSend ?? refuse;
  const send = current?.send ?? refuse;
  const stop = current?.stop ?? idle;
  const look = current?.attach;
  const attach = useCallback(() => void look?.(), [look]);
  const tracked = load.id === id && load.attempt === attempt ? load.state : 'loading';
  const state = enabled ? tracked : 'ready';

  return {
    chat,
    messages,
    status,
    connection,
    error,
    isLoading: state === 'loading',
    isFollowing: following && current != null,
    isUnattached: unattached && current != null,
    isLoadError: state === 'error',
    retry,
    hasEarlier: older?.hasEarlier ?? false,
    isLoadingEarlier: older?.isLoading ?? false,
    isEarlierError: older?.isError ?? false,
    loadEarlier: current == null ? nothing : loadEarlier,
    canSend,
    send,
    stop,
    attach,
  };
}
