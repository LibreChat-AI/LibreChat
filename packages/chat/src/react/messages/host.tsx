import { createContext, useContext } from 'react';
import type { TMessage, SearchResultData, TForkConvoRequest } from 'librechat-data-provider';
import type { Dispatch, ReactNode, MouseEvent, SetStateAction } from 'react';

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
  /** Renders the app's read-aloud control, or `null` while read-aloud is off. */
  renderMessageAudio: (props: MessageAudioProps) => ReactNode;
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

const noMessages = (): TMessage[] | undefined => undefined;

/** The host rows read outside any provider before an app registers one: locale clock, no slots,
 *  no forking, no copying, no thread, no read-aloud. */
const fallbackHost: MessagesHost = {
  useHour12: () => undefined,
  renderFiles: () => null,
  useForkPreferences: () => fallbackForkPreferences,
  useForkConversation: () => null,
  useMessageCopy: () => fallbackMessageCopy,
  useGetMessages: () => noMessages,
  renderMessageAudio: () => null,
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

/** A row's read-aloud control, drawn by the host's slot. */
export function MessageAudioSlot(props: MessageAudioProps): ReactNode {
  return useMessagesHost().renderMessageAudio(props);
}
