import type {
  TPreset,
  TMessage,
  TAttachment,
  TModelsConfig,
  TConversation,
  TEditedContent,
  UIMappingOptions,
  TReasoningOverride,
} from 'librechat-data-provider';
import type { SetStateAction, Dispatch, MouseEvent } from 'react';
import type { PaneOptionSettings } from '../pane';
import type { ExtendedFile } from '../../core';

/** The user turn an `ask` call submits. */
export type TAskProps = {
  text: string;
  overrideConvoId?: string;
  overrideUserMessageId?: string;
  parentMessageId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  clientTimestamp?: string;
};

/** How an `ask` call submits its turn: an edit, a regenerate, a continue or a compaction. */
export type TOptions = {
  editedMessageId?: string | null;
  editedContent?: TEditedContent;
  isRegenerate?: boolean;
  isContinued?: boolean;
  isEdited?: boolean;
  /**
   * Manual context compaction: a summarize-only turn hung off the branch's
   * leaf (`messageId`). Shaped like a regenerate on the client (no new user
   * bubble, the response placeholder parents onto the leaf) and sent with
   * `compact: true` so the server runs the graph summarize-only.
   */
  compact?: boolean;
  overrideMessages?: TMessage[];
  /**
   * Authoritative attachment list for this submission: a rerun replays the edited
   * message's stored files, and an auto-drained queued message replays the ones taken
   * out of the composer when it was queued. Authoritative even when empty, so a drain
   * never vacuums up attachments the user staged for their next send.
   */
  overrideFiles?: TMessage['files'];
  /**
   * Assistant message being regenerated. Used to derive the optimistic response
   * id for non-tail regenerations without accidentally keying the stream to the
   * conversation tail.
   */
  targetResponseMessageId?: string | null;
  /**
   * Carry forward a user message's manually-invoked skills when the caller
   * is resubmitting or regenerating that same message: the compose-time
   * atom has already been drained on the original submit, so without this
   * the second turn would run without any manual priming even though the
   * pills are still visible on the user bubble.
   */
  overrideManualSkills?: string[];
  /**
   * Carry forward a user message's quoted excerpts when resubmitting or
   * regenerating that same message: the compose-time atom is drained on the
   * original submit, so without this the second turn would lose the quoted
   * context even though the references still show on the user bubble.
   */
  overrideQuotes?: string[];
  /** Request-scoped reasoning selection for this exact submission. */
  overrideReasoning?: TReasoningOverride | null;
  /** Added conversation for multi-convo feature - sent to server as part of submission payload */
  addedConvo?: TConversation;
  /** Reuse a durable submission identity (terminal steer recovery). */
  overrideClientRequestId?: string;
  /** Exact parked steer source for a recovery attempt. */
  overrideRecoverySteerId?: string;
  /** Exact terminal generation observed before an automatic queued start. */
  overrideExpectedPredecessorCreatedAt?: number;
  /** Client-only exact queue position restored if admission is rejected. */
  overrideQueuedMessageOrigin?: unknown;
};

export type TAskFunction = (props: TAskProps, options?: TOptions) => false | void;

/** What a new conversation is built from. */
export type NewConversationParams = {
  template?: Partial<TConversation>;
  preset?: Partial<TPreset>;
  modelsData?: TModelsConfig;
  buildDefault?: boolean;
  keepAddedConvos?: boolean;
  disableParams?: boolean;
};

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
  optionSettings: PaneOptionSettings;
  /** Replaces the legacy per-pane option toggles. */
  setOptionSettings: Dispatch<SetStateAction<PaneOptionSettings>>;
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
  /**
   * Subscribes to writes of the messages cached under `messagesKey` and returns the
   * unsubscribe. Only writes that can change the data are delivered, after the current task
   * rather than inside the render that caused them. Stable while `messagesKey` is.
   */
  subscribeMessages: (onChange: () => void) => () => void;
  /**
   * How many times the messages cached under `messagesKey` have been written. A stream frame
   * can rewrite a message in place and keep the array, so this, not the array, tells one write
   * from the next. Stable while `messagesKey` is.
   */
  getMessagesRevision: () => number;
  /** Selects the visible sibling under the latest message's parent. */
  setSiblingIdx: (update: SetStateAction<number>) => void;
  /** Id of the tail of the active branch, if loaded. */
  latestMessageId: string | undefined;
  /** Depth of the tail of the active branch, if loaded. */
  latestMessageDepth: number | undefined;
  /**
   * Attachments delivered by message id while the message cache holds none of them yet: tool
   * artifacts streamed mid-run and previews resolved after it. A hook, so only a caller that
   * merges them re-renders when one arrives; stable across renders. AI SDK: the data parts a
   * stream writes onto its message.
   */
  useLiveAttachments: () => Record<string, TAttachment[] | undefined>;
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
  /** Whether message feedback controls are enabled by the startup config. */
  feedbackEnabled: boolean;
  /**
   * The app's tool outcome rules for viewing one message as a `UIMessage`, given the
   * attachments that arrived for it outside the message cache. Stable across renders.
   */
  getMappingOptions: (live: TAttachment[] | undefined) => UIMappingOptions;
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
