import { useRef, createContext, useContext } from 'react';
import type { TMessage, TForkConvoRequest } from 'librechat-data-provider';
import type { MouseEvent, ReactNode, RefObject } from 'react';

/** The scroll machinery of the message list, as the app's scrolling hook drives it. */
export type MessagesScrolling = {
  /** The conversation the scrolling follows. */
  conversationId?: string | null;
  /** Wraps the rendered thread. */
  contentRef: RefObject<HTMLDivElement>;
  /** The scroll container. */
  scrollableRef: RefObject<HTMLDivElement>;
  /** The zero-height marker after the last row. */
  messagesEndRef: RefObject<HTMLDivElement>;
  /** Scrolls smoothly to the end, from the scroll-to-bottom control. */
  handleSmoothToRef: (event: MouseEvent<HTMLButtonElement>) => void;
  /** The container's scroll listener. */
  debouncedHandleScroll: () => void;
  /** Reports whether the end marker is in view. */
  handleNearBottomChange: (isNearBottom: boolean) => void;
};

/** Reports, from the end marker's visibility, that the reader has seen the conversation. */
export type ReportNearBottom = (isNearBottom: boolean) => void;

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

  /**
   * Drives the list's scrolling: follows the stream, lands on a conversation's end and keeps
   * the reader's position.
   *
   * @deprecated On arrival: a bridge to the app's `useMessageScrolling`, which reads the app's
   * messages providers, until it moves into this package and the list runs it itself.
   */
  useScrolling: (messagesTree: TMessage[] | null | undefined) => MessagesScrolling;
  /** The element the app's conversation screenshot captures; none outside a screenshot provider. */
  useScreenshotTarget: () => RefObject<HTMLDivElement> | undefined;
  /** Whether the viewer asked the thread to follow new content to the bottom. */
  useAutoScroll: () => boolean;
  /** Marks the conversation seen once its latest reply is on screen; returns the reporter the
   *  end marker's visibility feeds. */
  useConversationSeen: (
    conversationId: string | undefined,
    isSubmitting: boolean,
    measureNearBottom: () => boolean | null,
    isResponseRendered: (messageId: string) => boolean,
  ) => ReportNearBottom;
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

/** Scrolling with nothing behind it: live refs, inert handlers. */
function useInertScrolling(): MessagesScrolling {
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollableRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  return {
    contentRef,
    scrollableRef,
    messagesEndRef,
    handleSmoothToRef: () => undefined,
    debouncedHandleScroll: () => undefined,
    handleNearBottomChange: () => undefined,
  };
}

const ignoreNearBottom: ReportNearBottom = () => undefined;

/** The host rows read outside any provider before an app registers one: locale clock, no slots, no forking. */
const fallbackHost: MessagesHost = {
  useHour12: () => undefined,
  renderFiles: () => null,
  useForkPreferences: () => fallbackForkPreferences,
  useForkConversation: () => null,

  useScrolling: useInertScrolling,
  useScreenshotTarget: () => useRef<HTMLDivElement>(null),
  useAutoScroll: () => false,
  useConversationSeen: () => ignoreNearBottom,
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
