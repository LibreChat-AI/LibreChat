import { useRef, createContext, useContext } from 'react';
import type {
  Agent,
  TFile,
  TMessage,
  Assistant,
  TConversation,
  SearchResultData,
  TForkConvoRequest,
} from 'librechat-data-provider';
import type { Dispatch, ReactNode, MouseEvent, RefObject, SetStateAction } from 'react';

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

/** The renderer a message is displayed with: `full` for model text, `lite` for user markdown. */
export type MarkdownVariant = 'full' | 'lite';

/** What a row asks the host to copy. */
export type MessageCopyInput = {
  message: TMessage;
  /** Search results the message cites, resolved into the copied text. */
  searchResults?: { [key: string]: SearchResultData };
  /** The renderer the row displayed the message with, when it is not the authorship default. */
  variant?: MarkdownVariant;
};

/** A row's copy action: `copyToClipboard` flips `setIsCopied` on while the copied state shows. */
export type MessageCopy = {
  copyToClipboard: (setIsCopied: Dispatch<SetStateAction<boolean>>) => void;
  canCopy: boolean;
};

/** What a message author's icon is drawn from: the endpoint and model, or the agent or
 *  assistant that wrote it. */
export type MessageIconData = { endpoint?: string | null; isCreatedByUser?: boolean } & Pick<
  TConversation,
  'modelLabel'
> &
  Pick<TMessage, 'model' | 'iconURL'>;

/** The props the app's message icon renders from. */
export type MessageIconProps = {
  iconData?: MessageIconData;
  assistant?: Assistant;
  agent?: Agent;
};

/** The button a read-aloud control draws, through the row's toolbar styling. */
export type MessageAudioButtonProps = {
  onClick: (e?: MouseEvent<HTMLButtonElement>) => void;
  title: string;
  icon: ReactNode;
  isActive?: boolean;
  isVisible?: boolean;
  isDisabled?: boolean;
  className?: string;
};

/** What a row hands the app's read-aloud control: the text to speak and how to draw its button. */
export type MessageAudioProps = {
  isLast?: boolean;
  index: number;
  messageId: string;
  content: string;
  className?: string;
  renderButton?: (props: MessageAudioButtonProps) => ReactNode;
};

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
  /** Copies a message the way the app renders it; `canCopy` is `false` where copying is unavailable. */
  useMessageCopy: (input: MessageCopyInput) => MessageCopy;
  /** Reads the visible thread at call time; returns `undefined` outside a messages view. */
  useGetMessages: () => () => TMessage[] | undefined;
  /** Whether a queued follow-up is about to start in this conversation, so no rerun races it. */
  useHasPendingTurn: (conversationId: string) => boolean;
  /** Renders the app's read-aloud control, or `null` while read-aloud is off. */
  renderMessageAudio: (props: MessageAudioProps) => ReactNode;
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

  /** Renders a message author's icon with the app's endpoint and avatar icons. */
  renderMessageIcon: (props: MessageIconProps) => ReactNode;
  /** Renders one message of the thread: its header, body and controls. */
  renderMessageRow: (props: MessageRowSlotProps) => ReactNode;
  /** Renders the background activity (subagent runs) launched from a row. */
  renderActivity: (props: ActivitySlotProps) => ReactNode;
  /** The conversation's files by id, which hydrate the files of a thread row. */
  useFileMap: () => Record<string, TFile> | undefined;
}

const noop = (): void => undefined;

const fallbackMessageCopy: MessageCopy = { copyToClipboard: noop, canCopy: false };

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

const noMessages = (): TMessage[] | undefined => undefined;

/** The host rows read outside any provider before an app registers one: locale clock, no slots,
 *  no forking, no copying, no thread, no queued turn, no read-aloud, inert scrolling. */
const fallbackHost: MessagesHost = {
  useHour12: () => undefined,
  renderFiles: () => null,
  useForkPreferences: () => fallbackForkPreferences,
  useForkConversation: () => null,
  useMessageCopy: () => fallbackMessageCopy,
  useGetMessages: () => noMessages,
  useHasPendingTurn: () => false,
  renderMessageAudio: () => null,
  useScrolling: useInertScrolling,
  useScreenshotTarget: () => useRef<HTMLDivElement>(null),
  useAutoScroll: () => false,
  useConversationSeen: () => ignoreNearBottom,
  renderMessageIcon: () => null,
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

/** A message author's icon, drawn by the host's slot. */
export function MessageIconSlot(props: MessageIconProps): ReactNode {
  return useMessagesHost().renderMessageIcon(props);
}

/** A row's read-aloud control, drawn by the host's slot. */
export function MessageAudioSlot(props: MessageAudioProps): ReactNode {
  return useMessagesHost().renderMessageAudio(props);
}
