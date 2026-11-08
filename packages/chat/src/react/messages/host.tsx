import { useRef, createContext, useContext } from 'react';
import type {
  Agent,
  TFile,
  TMessage,
  Assistant,
  TAttachment,
  TConversation,
  SearchResultData,
  TForkConvoRequest,
  TUpdateFeedbackRequest,
  TUpdateFeedbackResponse,
} from 'librechat-data-provider';
import type { Dispatch, ReactNode, MouseEvent, RefObject, SetStateAction } from 'react';
import type { WakeupDisplay } from '../../core/parts/wakeup';
import type { TAskFunction } from '../../core';

/** What a row's text body renders from. */
export type MessageBodySlotProps = {
  ask: TAskFunction;
  edit: boolean;
  isLast: boolean;
  text: string;
  message: TMessage;
  enterEdit: (cancel: boolean) => void;
  error: boolean;
  isSubmitting: boolean;
  unfinished: boolean;
  isCreatedByUser: boolean;
  siblingIdx: number;
  setSiblingIdx: (value: number) => void;
};

/** What the wake-up card renders from. */
export type WakeupSlotProps = {
  display: WakeupDisplay;
  conversationId?: string | null;
};

/** The message a row hands a slot that draws one piece of it. */
export type MessageSlotProps = {
  message: TMessage;
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

/** A conversation's newest reply, as the app's conversation store holds it. */
export type SeenReply = {
  /** When the newest reply landed; absent when the conversation has none. */
  lastResponseAt?: string;
  /** The reply that stamp belongs to; absent for a manual marker or a legacy stamp. */
  lastResponseMessageId?: string;
  /** Whether the stamp is a manual "mark as unread" marker rather than a real reply. */
  lastResponseIsManual?: boolean;
  /** Whether the reply landed after the viewer last caught up with the conversation. */
  unseen: boolean;
};

/** Where a message reply's proof of being on screen came from: a terminal stream event that
 *  committed it locally, or a messages fetch from the server. */
export type ReplyProofSource = 'local' | 'server';

/** The app's read-state storage and transport, which the list's seen reporting reads and
 *  writes. Its members keep their identity across renders. */
export type ConversationSeenSource = {
  /** Reads the conversation's newest reply from the app's conversation store. */
  readReply: (conversationId: string) => SeenReply | undefined;
  /** Whether the cached messages of the conversation are still the ones that proved the reply
   *  with this stamp, from the given source. */
  hasReplyProof: (
    conversationId: string,
    lastResponseAt: string,
    from: ReplyProofSource,
  ) => boolean;
  /** Acknowledges the reply with this stamp, and no newer one, on the server. */
  markSeen: (input: { conversationId: string; lastResponseAt: string }) => void;
  /** Takes the flag a notification click raises before it focuses the window, so that focus
   *  is not read as the viewer returning to the open conversation. */
  consumeFocusSuppression: () => boolean;
};

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

/** What a feedback write reports back. */
export type MessageFeedbackEvents = {
  onSuccess: (data: TUpdateFeedbackResponse) => void;
  onError: (error: unknown) => void;
};

/** Writes a message's feedback to the server. */
export type MessageFeedbackWrite = (
  payload: TUpdateFeedbackRequest,
  events: MessageFeedbackEvents,
) => void;

/** The renderer a message is displayed with: `full` for model text, `lite` for user markdown. */
export type MarkdownVariant = 'full' | 'lite';

/** What a row asks the host to copy. */
export type MessageCopyInput = {
  message: TMessage | null | undefined;
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
  /** The element the app's conversation screenshot captures; none outside a screenshot provider. */
  useScreenshotTarget: () => RefObject<HTMLDivElement> | undefined;
  /** Whether the viewer asked the thread to follow new content to the bottom. */
  useAutoScroll: () => boolean;
  /** The read-state storage the list marks a conversation seen through. */
  useSeenSource: () => ConversationSeenSource;
  /** The conversation's cached messages, refreshed as they stream when isStreaming is set; undefined until loaded or without a conversation. */
  useConversationMessages: (
    conversationId: string | null | undefined,
    isStreaming: boolean,
  ) => TMessage[] | undefined;

  /** The assistant a reply on an assistants endpoint came from, by endpoint and assistant id. */
  useAssistant: (
    endpoint: string | null | undefined,
    model: string | null | undefined,
  ) => Assistant | undefined;
  /**
   * Reads the second pane's conversation at call time, without subscribing to it, so a row does
   * not re-render when that conversation changes. `null` where there is no second pane.
   */
  useGetAddedConvo: () => () => TConversation | null;
  /** The attachments that arrived while a message streamed; `useStreamedAttachments` reads them. */
  useStreamedAttachments: (messageId: string) => TAttachment[] | undefined;
  /** Writes feedback on one message of a conversation. */
  useMessageFeedback: (conversationId: string, messageId: string) => MessageFeedbackWrite;

  /** Renders a message author's icon with the app's endpoint and avatar icons. */
  renderMessageIcon: (props: MessageIconProps) => ReactNode;
  /** Whether rows drop the reading-width cap and fill the pane. */
  useMaximizeChatSpace: () => boolean;
  /** Whether a response by the agent the header's model selector shows drops its avatar and name
   *  (`interface.messageAuthor: whenDifferent`). */
  useHideSelectedAuthor: () => boolean;
  /** The agents the viewer can see by id, or `undefined` until they load. */
  useAgentsMap: () => Record<string, Agent | undefined> | undefined;
  /** Renders a row's text body when it has no content parts. */
  renderMessageBody: (props: MessageBodySlotProps) => ReactNode;
  /** Renders the card of a wake-up turn a background task posted. */
  renderWakeup: (props: WakeupSlotProps) => ReactNode;
  /** Renders the owner's original text of a message stored with a privacy revision. */
  renderPrivateText: (props: MessageSlotProps) => ReactNode;
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

/** Read state with nothing behind it: no conversation is ever unseen, so nothing is written. */
const inertSeenSource: ConversationSeenSource = {
  readReply: () => undefined,
  hasReplyProof: () => false,
  markSeen: noop,
  consumeFocusSuppression: () => false,
};

const noAddedConvo = (): TConversation | null => null;

const noFeedback: MessageFeedbackWrite = noop;

const noMessages = (): TMessage[] | undefined => undefined;

/** The host rows read outside any provider before an app registers one: locale clock, no slots,
 *  no forking, no copying, no thread, no queued turn, no read-aloud, no read state. */
const fallbackHost: MessagesHost = {
  useHour12: () => undefined,
  renderFiles: () => null,
  useForkPreferences: () => fallbackForkPreferences,
  useForkConversation: () => null,
  useMessageCopy: () => fallbackMessageCopy,
  useGetMessages: () => noMessages,
  useHasPendingTurn: () => false,
  renderMessageAudio: () => null,
  useScreenshotTarget: () => useRef<HTMLDivElement>(null),
  useAutoScroll: () => false,
  useSeenSource: () => inertSeenSource,
  useConversationMessages: () => undefined,
  useAssistant: () => undefined,
  useGetAddedConvo: () => noAddedConvo,
  useStreamedAttachments: () => undefined,
  useMessageFeedback: () => noFeedback,
  renderMessageIcon: () => null,
  useMaximizeChatSpace: () => false,
  useHideSelectedAuthor: () => false,
  useAgentsMap: () => undefined,
  renderMessageBody: () => null,
  renderWakeup: () => null,
  renderPrivateText: () => null,
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
