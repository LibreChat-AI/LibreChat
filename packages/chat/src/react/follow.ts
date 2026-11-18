import { useRef, useState, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { TMessage, ChatEvent } from 'librechat-data-provider';
import type {
  ChatStatus,
  ChatTransport,
  ChatConnection,
  ChatFinishResult,
  EventApplierInit,
  EventApplierEffect,
} from '../core';
import { Chat, MAX_RETRIES, getReconnectDelay, createEventApplier } from '../core';
import { ReactQueryChatState } from './state';
import { useSnapshot } from './snapshot';

export type FollowChatOptions = {
  /** The conversation followed. Its messages live in the cache under `[QueryKeys.messages, id]`. */
  id: string;
  /** Reaches the conversation's generation; `createGenerationTransport` over the app's routes. */
  transport: ChatTransport;
  /**
   * Reads the conversation's stored messages. Called when the conversation is opened and again
   * when a generation it followed ends, since the stored rows are then the settled truth.
   */
  loadMessages: () => Promise<TMessage[]>;
  /**
   * Whether the caller knows a generation is running. Turning true attaches to it, which covers a
   * run that starts after the conversation was opened; one signalled while the stored messages
   * are still being read is attached to once they are in. Turning false reads the stored
   * messages again, which covers a run that ended without a stream to say so.
   */
  live?: boolean;
  /** False follows nothing: no read, no stream, and an idle result. */
  enabled?: boolean;
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
};

export type FollowBeside = Pick<EventApplierInit, 'usage' | 'onAttachment' | 'onTitle' | 'steers'>;

/** The same handlers, looked up when a frame arrives, so the caller's latest are the ones called. */
const forwardBeside = (read: () => FollowBeside | undefined): Required<FollowBeside> => ({
  usage: {
    bindResponse: (submission) => read()?.usage?.bindResponse(submission),
    contextHandler: (data, submission) => read()?.usage?.contextHandler(data, submission),
    usageHandler: (data, submission) => read()?.usage?.usageHandler(data, submission),
    tapStream: (data, submission) => read()?.usage?.tapStream(data, submission),
    tapContent: (text, submission) => read()?.usage?.tapContent(text, submission),
    finalizeUsage: (data, submission) => read()?.usage?.finalizeUsage(data, submission),
    backfillUsage: (entries, submission) => read()?.usage?.backfillUsage(entries, submission),
    seedLiveFromContent: (content, submission) =>
      read()?.usage?.seedLiveFromContent(content, submission),
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
};

type Entry = { id: string; chat: Chat; attach: () => Promise<void>; settle: () => Promise<void> };
type Load = { id: string; attempt: number; state: 'loading' | 'ready' | 'error' };
/**
 * One attachment: how it ended, unset when nothing was running, and whether it delivered any of
 * the generation. The frame that reports a failure is not a delivery.
 */
type Attachment = { finished?: ChatFinishResult; received: boolean };

/**
 * How many more times a run the caller knows of is looked for after it was not found. Short: a
 * caller with another way to show the run is waiting on the answer.
 */
export const ABSENT_RETRIES = 2;

const noMessages: TMessage[] = [];
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
 * Follows one conversation the reader does not drive: shows its stored messages, attaches to the
 * generation running under it and applies that stream the way main chat does, then reads the
 * stored messages again once the generation ends. A stream that drops is not an end: what it
 * showed stays, and the attachment is made again on main chat's reconnect schedule. The
 * conversation is a core `Chat` over the message cache, so anything that reads
 * `[QueryKeys.messages, id]` sees what it writes.
 *
 * A subagent's child thread is the first of these; a side chat is the same thing with a send.
 */
export function useFollowChat({
  id,
  transport,
  loadMessages,
  live = false,
  enabled = true,
  onEffect,
  beside,
  onEvent,
  onFinish,
}: FollowChatOptions): FollowedChat {
  const queryClient = useQueryClient();
  const host = useRef({ transport, loadMessages, live, onEffect, beside, onEvent, onFinish });
  host.current = { transport, loadMessages, live, onEffect, beside, onEvent, onFinish };
  const [attempt, setAttempt] = useState(0);
  const [entry, setEntry] = useState<Entry>();
  const [load, setLoad] = useState<Load>({ id, attempt, state: 'loading' });
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
    const applier = createEventApplier({
      schedule: perFrame,
      onEffect: (effect) => host.current.onEffect?.(effect),
      ...forwardBeside(() => host.current.beside),
    });
    const chat = new Chat({
      id,
      state: new ReactQueryChatState({ queryClient, key: id }),
      /** Read on every call, so a transport rebuilt for a refreshed token is the one used. */
      transport: {
        sendMessages: (request) => host.current.transport.sendMessages(request),
        reconnectToStream: (request) => host.current.transport.reconnectToStream(request),
        abort: (request) => host.current.transport.abort(request),
        getStatus: (conversationId) =>
          host.current.transport.getStatus?.(conversationId) ?? Promise.resolve({ active: false }),
      },
      prepareRequest: () => {
        throw new Error('A followed conversation takes no turns');
      },
      applyEvent: applier.applyEvent,
      onEvent: (event) => {
        if (attachment != null && event.type !== 'error') {
          attachment.received = true;
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

    const read = async (): Promise<void> => {
      const messages = await host.current.loadMessages();
      if (!stale) {
        await chat.setMessages(messages);
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
      if (stale || !loaded || attaching) {
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

    setEntry({ id, chat, attach, settle });
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
  };
}
