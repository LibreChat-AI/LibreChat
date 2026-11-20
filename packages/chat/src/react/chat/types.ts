import type { UIMessage, UITextPart, UIMessageMetadata } from 'librechat-data-provider';
import type { TAskProps, TOptions } from './contract';

/** AI SDK `ChatStatus`. */
export type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error';

/**
 * A user turn in the AI SDK's `sendMessage` shape: its text parts, plus the message it attaches
 * under. It goes to the facade's own chat, as AI SDK `useChat` does, so it names no conversation.
 * File parts are left out because the turn takes its files from the composer, not the message.
 */
export type SendMessageInput = {
  parts: UITextPart[];
  metadata?: Partial<Pick<UIMessageMetadata, 'parentMessageId'>>;
};

/**
 * Submits a turn. Takes the contract's `ask` arguments, or a user message in the AI SDK shape,
 * which is sent as the `ask` call it describes; `{ text }` is already both.
 */
export type SendMessage = (
  message: TAskProps | SendMessageInput,
  options?: TOptions,
) => false | void;

/**
 * The `useChat` surface of `@ai-sdk/react@4.0.117` (`UseChatHelpers`), over LibreChat's chat
 * contract. Members the contract cannot back (`addToolOutput`, `clearError`) are left out rather
 * than stubbed.
 */
export type UseChatHelpers = {
  /** The conversation the messages are read from (the contract's `messagesKey`); AI SDK's chat id. */
  id: string | undefined;
  /** The cached messages as `UIMessage`s, re-read whenever the message cache is written. */
  messages: UIMessage[];
  status: ChatStatus;
  /** Set when the latest message is an error; LibreChat reports errors as messages. */
  error: Error | undefined;
  /** Submits a turn through the contract's `ask`; see {@link SendMessage}. */
  sendMessage: SendMessage;
  /** Regenerates the response to `messageId`, or the latest message of the branch. */
  regenerate: (options?: { messageId?: string }) => void;
  stop: () => Promise<void>;
  /**
   * Reattaches this chat to its running generation, if the server has one. The request is
   * answered by the resume-on-load path the chat view mounts for its pane, which checks the
   * stream status and attaches through the host transport. It resolves once requested. It does
   * nothing for a new chat or one already attached, and a request for a conversation no chat view
   * shows waits until one does.
   */
  resumeStream: () => Promise<void>;
  /**
   * Writes messages back to the cache, keeping the stored fields the UI view omits. A message
   * with no stored counterpart joins the active conversation under the message before it, or
   * under the active branch's tail when the message before it is on another branch, unless its
   * metadata names a parent. A message keeps the conversation it is stored under.
   */
  setMessages: (messages: UIMessage[] | ((messages: UIMessage[]) => UIMessage[])) => void;
};

/** The `useChat` members that need no message list. */
export type ChatActions = Pick<
  UseChatHelpers,
  'id' | 'status' | 'sendMessage' | 'regenerate' | 'stop' | 'resumeStream'
>;
