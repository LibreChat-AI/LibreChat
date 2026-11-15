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
import { Chat, createEventApplier } from '../core';
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
   * run that starts after the conversation was opened.
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
 * stored messages again once the generation ends. The conversation is a core `Chat` over the
 * message cache, so anything that reads `[QueryKeys.messages, id]` sees what it writes.
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
  const host = useRef({ transport, loadMessages, onEffect, onEvent, onFinish });
  host.current = { transport, loadMessages, onEffect, onEvent, onFinish };
  const [attempt, setAttempt] = useState(0);
  const [entry, setEntry] = useState<Entry>();
  const [load, setLoad] = useState<Load>({ id, attempt, state: 'loading' });

  useEffect(() => {
    let stale = false;
    let loaded = false;
    let attaching = false;
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
      onEvent: (event) => host.current.onEvent?.(event),
      onFinish: (result) => host.current.onFinish?.(result),
    });

    const read = async (): Promise<void> => {
      const messages = await host.current.loadMessages();
      if (!stale) {
        await chat.setMessages(messages);
      }
    };

    /** Follows whatever is running to its end, then takes the stored rows as the result. */
    const attach = async (): Promise<void> => {
      if (stale || !loaded || attaching) {
        return;
      }
      attaching = true;
      try {
        await chat.resumeStream();
        await read();
      } catch {
        /** The chat reports a stream failure itself; a failed re-read leaves what it streamed. */
      } finally {
        attaching = false;
      }
    };

    const open = async (): Promise<void> => {
      try {
        /** Asked before the read, so a run that had already ended is fully in what is read. */
        const status = await host.current.transport.getStatus?.(id);
        await read();
        if (stale) {
          return;
        }
        loaded = true;
        setLoad({ id, attempt, state: 'ready' });
        if (status?.active === true) {
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
