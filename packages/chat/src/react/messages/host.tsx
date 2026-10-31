import { createContext, useContext } from 'react';
import type { TMessage, TForkConvoRequest } from 'librechat-data-provider';
import type { ReactNode } from 'react';

/** The viewer's fork defaults, kept across sessions. */
export type ForkPreferences = {
  /** The fork option used without asking, when `rememberOption` is set. */
  option: string;
  setOption: (option: string) => void;
  /** Whether a fork starts its branch at the target message. */
  splitAtTarget: boolean;
  setSplitAtTarget: (value: boolean) => void;
  /** Whether the fork button forks at once with `option` instead of opening the menu. */
  rememberOption: boolean;
  setRememberOption: (value: boolean) => void;
};

/** What a fork reports back. `onSuccess` runs once the app has opened the new conversation. */
export type ForkEvents = {
  onSuccess: () => void;
  onError: (error: unknown) => void;
};

/** Starts a fork of a conversation. */
export type ForkConversation = (request: TForkConvoRequest, events: ForkEvents) => void;

/**
 * Everything the message list reads from the app: viewer preferences, and render slots for the
 * pieces of a row that have not moved into this package yet. Members are hooks or slots, called
 * unconditionally, and a host stays the same object for the life of the tree it wraps.
 *
 * It is an interface so an app can declare members of rows it has not handed to this package
 * yet, by augmenting `@librechat/chat/react`.
 */
export interface MessagesHost {
  /** The viewer's clock preference as `hour12`; `undefined` follows the locale's convention. */
  useHour12: () => boolean | undefined;
  /** Renders the files attached to a user message, above its text. */
  renderFiles: (message: TMessage) => ReactNode;
  /** The viewer's fork defaults. */
  useForkPreferences: () => ForkPreferences;
  /** Forks a conversation and opens the copy; `null` where forking is unavailable. */
  useForkConversation: () => ForkConversation | null;
}

const noop = (): void => undefined;

const fallbackForkPreferences: ForkPreferences = {
  option: '',
  setOption: noop,
  splitAtTarget: false,
  setSplitAtTarget: noop,
  rememberOption: false,
  setRememberOption: noop,
};

/** The host rows read outside any provider before an app registers one: locale clock, no slots, no forking. */
const fallbackHost: MessagesHost = {
  useHour12: () => undefined,
  renderFiles: () => null,
  useForkPreferences: () => fallbackForkPreferences,
  useForkConversation: () => null,
};

const MessagesHostContext = createContext<MessagesHost | null>(null);

let defaultHost: MessagesHost = fallbackHost;

/**
 * Registers the host that rows rendered outside any `MessagesHostProvider` read. An app registers
 * its own once, when the module that builds it loads; a provider always wins over it.
 */
export function setDefaultMessagesHost(host: MessagesHost): void {
  defaultHost = host;
}

/** Supplies the host the message list reads from. */
export function MessagesHostProvider({
  host,
  children,
}: {
  host: MessagesHost;
  children: ReactNode;
}): ReactNode {
  return <MessagesHostContext.Provider value={host}>{children}</MessagesHostContext.Provider>;
}

/** The host of the nearest provider, else the registered default, else the fallback. */
export function useMessagesHost(): MessagesHost {
  return useContext(MessagesHostContext) ?? defaultHost;
}
