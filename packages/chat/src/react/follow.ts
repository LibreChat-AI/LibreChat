import { useRef, useState, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { TMessage, ChatEvent } from 'librechat-data-provider';
import type {
  ChatStatus,
  ChatTransport,
  ChatConnection,
  ChatFinishResult,
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
   * are still being read is attached to once they are in.
   */
  live?: boolean;
  /** Live status a step reports beside the message list. */
  onEffect?: (effect: EventApplierEffect) => void;
  /** Every stream event after it was applied: usage, titles, attachments. */
  onEvent?: (event: ChatEvent) => void;
  onFinish?: (result: ChatFinishResult) => void;
};

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
  /** Whether the stored messages could not be read; `retry` reads them again. */
  isLoadError: boolean;
  retry: () => void;
};

type Entry = { id: string; chat: Chat; attach: () => Promise<void> };
type Load = { id: string; attempt: number; state: 'loading' | 'ready' | 'error' };
/**
 * One attachment: how it ended, unset when nothing was running, and whether it delivered any of
 * the generation. The frame that reports a failure is not a delivery.
 */
type Attachment = { finished?: ChatFinishResult; received: boolean };

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
  onEffect,
  onEvent,
  onFinish,
}: FollowChatOptions): FollowedChat {
  const queryClient = useQueryClient();
  const host = useRef({ transport, loadMessages, live, onEffect, onEvent, onFinish });
  host.current = { transport, loadMessages, live, onEffect, onEvent, onFinish };
  const [attempt, setAttempt] = useState(0);
  const [entry, setEntry] = useState<Entry>();
  const [load, setLoad] = useState<Load>({ id, attempt, state: 'loading' });

  useEffect(() => {
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
      try {
        for (let failures = 0; !stale; ) {
          const { finished, received } = await follow();
          if (finished?.isDisconnect !== true) {
            break;
          }
          failures = received ? 1 : failures + 1;
          if (failures > MAX_RETRIES) {
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
      }
      if (owed) {
        owed = false;
        await attach();
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

    setEntry({ id, chat, attach });
    setLoad({ id, attempt, state: 'loading' });
    void open();

    return () => {
      stale = true;
      wake?.();
      applier.reset();
      chat.dispose();
    };
  }, [id, attempt, queryClient]);

  const current = entry?.id === id ? entry : undefined;
  const attach = current?.attach;
  useEffect(() => {
    if (live && attach != null) {
      void attach();
    }
  }, [live, attach]);

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
  const state = load.id === id && load.attempt === attempt ? load.state : 'loading';

  return {
    chat,
    messages,
    status,
    connection,
    error,
    isLoading: state === 'loading',
    isLoadError: state === 'error',
    retry,
  };
}
