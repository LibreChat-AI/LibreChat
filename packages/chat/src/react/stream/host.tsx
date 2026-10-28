import { createContext, useContext } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { TSubmission } from 'librechat-data-provider';
import type { ResumableHost, ResumableRun } from '../../core';
import type { ChatContract } from '../chat/contract';

/** The chat members a stream writes through: the message cache, the pane's conversation and its
 *  in-flight flag, and the generator a stream calls when the server starts a new chat. */
export type StreamChat = Pick<
  ChatContract,
  'setMessages' | 'getMessages' | 'setConversation' | 'setIsSubmitting' | 'newConversation'
>;

/** One pane's resumable stream, as the host builds the services it runs on. */
export type ResumableStreamParams = {
  run: ResumableRun;
  chat: StreamChat;
  /** `0` for the main pane, `1` for the added (multi-convo) pane. */
  runIndex: number;
  isAddedRequest: boolean;
  /** Reports the stream the pane is attached to, or `null` once it detaches. */
  setStreamId: Dispatch<SetStateAction<string | null>>;
};

/** Everything a resumable stream runs on except how it re-attaches, which the binding owns. */
export type ResumableServices = Omit<ResumableHost, 'subscribe'>;

/**
 * What the stream bindings need from the app that hosts them. Members are hooks, called
 * unconditionally on every render, so the host can back each one with its own query cache,
 * transport and store. A host must stay the same object for the life of the tree it wraps.
 */
export interface StreamHost {
  /**
   * Builds the services one pane's resumable stream runs on. The returned function is called
   * whenever the stream mounts or re-attaches, so each attachment reads the services of the
   * latest render; it changes only when they do.
   */
  useResumableServices(params: ResumableStreamParams): () => ResumableServices;
  /** Streams a turn that carries its own response (Assistants), for `submission` or none. */
  useLegacyStream(
    submission: TSubmission | null,
    chat: StreamChat,
    isAddedRequest: boolean,
    runIndex: number,
  ): void;
}

const StreamHostContext = createContext<StreamHost | null>(null);

/** Supplies the host the stream bindings read from. */
export function StreamHostProvider({
  host,
  children,
}: {
  host: StreamHost;
  children?: ReactNode;
}): ReactNode {
  return <StreamHostContext.Provider value={host}>{children}</StreamHostContext.Provider>;
}

export function useStreamHost(): StreamHost {
  const host = useContext(StreamHostContext);
  if (host == null) {
    throw new Error('The stream hooks need a StreamHostProvider above them.');
  }
  return host;
}
