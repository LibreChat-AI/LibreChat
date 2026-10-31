import { useRef, createContext, useContext } from 'react';
import type { Dispatch, MouseEvent, ReactNode, RefObject, SetStateAction } from 'react';
import type { TFile, TMessage } from 'librechat-data-provider';

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

/** What the message slot renders one visible row of the thread from. */
export type MessageRowSlotProps = {
  message: TMessage;
  /** Position of the message among its siblings, oldest first. */
  siblingIdx: number;
  siblingCount: number;
  /** Shows the sibling at the given position, oldest first. */
  setSiblingIdx: (value: number) => void;
  currentEditId: string | number | null;
  setCurrentEditId: Dispatch<SetStateAction<string | number | null>>;
};

/** What the activity slot renders the background activity of a row from. */
export type ActivitySlotProps = {
  conversationId: string;
  /** The messages whose activity the group shows, in order. */
  parentMessageIds: string[];
  hasParallelContent: boolean;
};

/** Reports, from the end marker's visibility, that the reader has seen the conversation. */
export type ReportNearBottom = (isNearBottom: boolean) => void;

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
  /** Renders one message of the thread: its header, body and controls. */
  renderMessageRow: (props: MessageRowSlotProps) => ReactNode;
  /** Renders the background activity (subagent runs) launched from a row. */
  renderActivity: (props: ActivitySlotProps) => ReactNode;
  /** The conversation's files by id, which hydrate the files of a thread row. */
  useFileMap: () => Record<string, TFile> | undefined;
}

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

/** The host rows read outside any provider before an app registers one: locale clock, no slots. */
const fallbackHost: MessagesHost = {
  useHour12: () => undefined,
  renderFiles: () => null,

  useScrolling: useInertScrolling,
  useScreenshotTarget: () => useRef<HTMLDivElement>(null),
  useAutoScroll: () => false,
  useConversationSeen: () => ignoreNearBottom,
  renderMessageRow: () => null,
  renderActivity: () => null,
  useFileMap: () => undefined,
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
