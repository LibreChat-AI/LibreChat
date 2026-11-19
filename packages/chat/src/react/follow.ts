import { useRef, useState, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { TMessage, ChatEvent, ChatFinalFrame } from 'librechat-data-provider';
import type {
  ChatStatus,
  ChatTransport,
  SubmittedTurn,
  ChatConnection,
  AnnounceOptions,
  ChatFinishResult,
  EventApplierInit,
  EventApplierEffect,
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
};

/** One page of stored messages, oldest first. */
export type FollowedPage = {
  messages: TMessage[];
  /** The cursor that reads the page before this one; nothing when this page holds the first row. */
  earlier?: string | null;
};

type AppliedBeside = Pick<EventApplierInit, 'usage' | 'onAttachment' | 'onTitle' | 'steers'>;

export type FollowBeside = AppliedBeside & {
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
};

type Entry = {
  id: string;
  chat: Chat;
  attach: () => Promise<void>;
  settle: () => Promise<void>;
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
      /** Not when the server answered the start with a generation that is not this turn. */
      turn: () => (attachment?.foreign === true ? undefined : sent?.submission),
    });
    const chat = new Chat({
      id,
      state: new ReactQueryChatState({ queryClient, key: id }),
      /** Read on every call, so a transport rebuilt for a refreshed token is the one used. */
      transport: {
        sendMessages: async (request) => {
          const turn = attachment;
          const sent = await host.current.transport.sendMessages(request);
          if (turn != null) {
            turn.foreign =
              sent.status === 'replaced' ||
              (sent.status === 'stream' && sent.stream.resumed === true);
          }
          return sent;
        },
        reconnectToStream: (request) => host.current.transport.reconnectToStream(request),
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
      try {
        for (let failures = 0, absences = 0; !stale; ) {
          const { finished, received } = await follow();
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
            reached = false;
            return;
          }
          await pause(getReconnectDelay(failures));
        }
        if (stale) {
          return;
        }
        reading = true;
        await read();
      } catch {
        /** The chat reports a stream failure itself; a failed re-read leaves what it streamed. */
      } finally {
        attaching = false;
        reading = false;
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

    /** The caller saw the run end. A stream still open reads the stored rows itself when it ends. */
    const settle = async (): Promise<void> => {
      if (stale || !loaded || attaching || driving) {
        return;
      }
      try {
        await read();
      } catch {
        /** What is shown stays; the next open reads again. */
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
          if (current.withdrawn === true) {
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
      if (dropped || owed) {
        owed = false;
        await attach();
        return;
      }
      if (!own) {
        await settle();
        return;
      }
      /** The turn's own final frame is its result, and the list as it stands is what it left. */
      if (ended != null) {
        settled();
        return;
      }
      /**
       * It ended with no final frame: it failed, or was stopped before the server kept anything
       * of it. Nothing settles what was counted for its reply, so that count is dropped here, as
       * main chat drops it, instead of being added to the conversation's next reply.
       */
      host.current.beside?.usage?.resetLive?.(turn.submission);
    };

    /**
     * A stop the chat could not address is a turn the server has not answered: it may be running
     * with nothing naming it yet. The server finds it by its conversation, and if it only
     * appears afterwards, by the generation the status route then names.
     */
    const stop = (): Promise<void> => {
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
  };
}
