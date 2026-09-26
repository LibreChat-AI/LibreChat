import type { TConversation, TMessage, TPreset } from 'librechat-data-provider';
import type { SetStateAction, Dispatch, MouseEvent } from 'react';
import type { NewConversationParams, TOptionSettings, ExtendedFile, TAskFunction } from '~/common';

/** Options accepted by {@link ChatConversationContract.newConversation}: the shared params plus
 *  the two flags only the root pane's generator honors. */
export type NewConversationOptions = NewConversationParams & {
  /** Skips focusing the composer after the new conversation renders. */
  disableFocus?: boolean;
  /** Set when the call re-renders a composer an earlier call already opened, such as agent
   * metadata arriving late. The user never left that composer, so its draft identity and its
   * in-flight attachments outlive the refresh. */
  keepComposerState?: boolean;
};

/** Target of a regenerate: a response to redo, or the user message whose response to redo. */
export type RegenerateTarget = Partial<
  Pick<TMessage, 'messageId' | 'parentMessageId' | 'isCreatedByUser'>
>;

/** Conversation identity and the per-pane settings attached to it. */
export type ChatConversationContract = {
  /** The pane this chat renders into; `0` is the root pane, `1` the added (multi-convo) pane. */
  index: number;
  /** The active conversation for this pane, or `null` before one is created. */
  conversation: TConversation | null;
  /** Replaces or updates the active conversation for this pane. */
  setConversation: Dispatch<SetStateAction<TConversation | null>>;
  /** Starts a fresh conversation in this pane from a template and/or preset. */
  newConversation: (options?: NewConversationOptions) => void;
  /** The preset applied to this pane, if any. */
  preset: TPreset | null;
  /** Replaces the preset applied to this pane. */
  setPreset: Dispatch<SetStateAction<TPreset | null>>;
  /** Legacy per-pane option toggles (examples, code chat). */
  optionSettings: TOptionSettings;
  /** Replaces the legacy per-pane option toggles. */
  setOptionSettings: Dispatch<SetStateAction<TOptionSettings>>;
};

/** The message tree as cached for this conversation. AI SDK: `messages` / `setMessages`. */
export type ChatMessagesContract = {
  /**
   * Reads the cached message list for this pane's conversation, or for `targetConversationId`.
   * AI SDK: `messages`, read on demand instead of subscribed.
   */
  getMessages: (targetConversationId?: string | null) => TMessage[] | undefined;
  /**
   * The conversation key `getMessages()` reads when called without one: the route's id, which
   * can run ahead of `conversation` while navigation settles, or `''` before the pane has either.
   * AI SDK: the chat `id`.
   */
  messagesKey: string;
  /** Writes the full message list to every cache key this pane reads. AI SDK: `setMessages`. */
  setMessages: (messages: TMessage[]) => void;
  /** Selects the visible sibling under the latest message's parent. */
  setSiblingIdx: (update: SetStateAction<number>) => void;
  /** Id of the tail of the active branch, if loaded. */
  latestMessageId: string | undefined;
  /** Depth of the tail of the active branch, if loaded. */
  latestMessageDepth: number | undefined;
};

/** Sending, regenerating and continuing turns. AI SDK: `sendMessage` / `regenerate` / `status`. */
export type ChatSubmissionContract = {
  /** Submits a user turn (or an edit, continue or compaction of one). AI SDK: `sendMessage`. */
  ask: TAskFunction;
  /** Re-runs the response to a message on the current branch. AI SDK: `regenerate`. */
  regenerate: (target: RegenerateTarget, options?: { addedConvo?: TConversation | null }) => void;
  /**
   * Whether a turn is in flight for this pane. AI SDK: `status`, collapsed to
   * `submitted | streaming` (true) versus `ready | error` (false).
   */
  isSubmitting: boolean;
  /**
   * The response `ask` submitted the in-flight turn with, before any streamed output. Its content
   * holds the parts the response was seeded with (a retained edit prefix, empty lane placeholders)
   * at their indices: the stream appends after them or fills an empty one, and never rewrites a
   * seeded part that has content. Compare by position, not identity, since the cache may hold
   * equal copies. `undefined` while no turn is in flight, for a run restored after a reload
   * (whose response already holds streamed output), and in any chat but the one it was sent from,
   * which includes a new chat once it takes its saved id (its seed holds only empty placeholders).
   */
  initialResponse: TMessage | undefined;
  /** Sets the in-flight flag for this pane. */
  setIsSubmitting: Dispatch<SetStateAction<boolean>>;
  /** Button handler that regenerates the latest response. AI SDK: `regenerate`. */
  handleRegenerate: (e: MouseEvent<HTMLButtonElement>) => void;
  /** Button handler that continues the latest response from where it stopped. */
  handleContinue: (e: MouseEvent<HTMLButtonElement>) => void;
};

/** Stopping an in-flight turn. AI SDK: `stop`. */
export type ChatAbortContract = {
  /** Aborts the in-flight generation for this pane's conversation. AI SDK: `stop`. */
  stopGenerating: () => Promise<void>;
  /** Button handler around `stopGenerating`. AI SDK: `stop`. */
  handleStopGenerating: (e: MouseEvent<HTMLButtonElement>) => void;
  /** Whether a stop just happened and the view should hold its scroll position. */
  abortScroll: boolean;
  /** Sets the post-stop scroll hold. */
  setAbortScroll: Dispatch<SetStateAction<boolean>>;
};

/** Composer attachments for this pane. AI SDK: the `files` option of `sendMessage`. */
export type ChatFilesContract = {
  /** Attachments staged in the composer, keyed by file id. */
  files: Map<string, ExtendedFile>;
  /** Replaces the staged attachments. */
  setFiles: Dispatch<SetStateAction<Map<string, ExtendedFile>>>;
  /** Whether an attachment is still uploading. */
  filesLoading: boolean;
  /** Sets the attachment upload flag. */
  setFilesLoading: Dispatch<SetStateAction<boolean>>;
};

/** Chat-scoped view state that has no AI SDK counterpart. */
export type ChatViewContract = {
  /** Whether the pane's settings popover is open. */
  showPopover: boolean;
  /** Opens or closes the pane's settings popover. */
  setShowPopover: Dispatch<SetStateAction<boolean>>;
  /** Whether message feedback controls are enabled by the startup config. */
  feedbackEnabled: boolean;
};

/**
 * Public surface of `useChatHelpers`, served through `ChatContext`.
 *
 * Queue and steering are not part of it: they live in `useQueueDrain`, `useSteering` and
 * the SSE handlers, and reach the composer directly rather than through this context.
 * AI SDK `error` has no member here either; errors arrive as message content.
 * Setters are typed as React dispatchers, so the contract names no state library.
 */
export type ChatContract = ChatConversationContract &
  ChatMessagesContract &
  ChatSubmissionContract &
  ChatAbortContract &
  ChatFilesContract &
  ChatViewContract;

/** Public surface of `useAddedResponse`, served through `AddedChatContext`. */
export type AddedChatContract = {
  /** The added pane's conversation, or `null` when multi-convo is off. */
  conversation: TConversation | null;
  /** Replaces or updates the added pane's conversation. */
  setConversation: Dispatch<SetStateAction<TConversation | null>>;
  /** Builds and stores a conversation for the added pane from a template and/or preset. */
  generateConversation: (params?: NewConversationParams) => TConversation;
};
