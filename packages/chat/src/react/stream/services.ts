import type {
  ImageFile,
  ChatTransport,
  ChatErrorData,
  TSubmission,
  TAttachment,
  PartMetadata,
  TConversation,
  EventSubmission,
} from 'librechat-data-provider';
import type { AnnounceOptions, ConvoTitleState } from '../../core';
import type { ChatContract } from '../chat/contract';
import type { TurnLogger } from '../chat/host';

/** The settled-reply stamp the server writes on a conversation once a reply lands. */
export type ReplyStamp = {
  lastResponseAt: string;
  lastResponseMessageId?: string;
  updatedAt?: string;
};

/** The title fields a stream frame carries, and whether the frame settles the title. */
export type ConvoTitleRequest = {
  conversationId?: string | null;
  currentTitle?: string | null;
  titleSetByUser?: boolean;
  titleRevision?: number;
  authoritative?: boolean;
};

/**
 * The app's conversation lists: every cached page and section that can hold a row (sidebar
 * pages, pinned, search, projects). Writes go to all of them at once.
 */
export type ConversationCacheServices = {
  /** Adds the row to the lists that should show it, or refreshes it where it already is. */
  upsert: (conversation: TConversation) => void;
  /** Rewrites the row in every list that holds it; `moveToTop` reorders it as freshly active. */
  update: (
    conversationId: string,
    updater: (conversation: TConversation) => TConversation,
    moveToTop?: boolean,
  ) => void;
  /** Drops the row from every list. */
  remove: (conversationId: string) => void;
  /** The conversation without the fields only the open chat owns, as a list row carries it. */
  listEntry: (conversation: TConversation) => TConversation;
  /** The title to settle on, keeping a title the user set over a generated or stale one. */
  getTitle: (request: ConvoTitleRequest) => ConvoTitleState;
  /** Records that this tab watched the reply land, then applies the server's stamp to the rows. */
  commitReply: (conversationId: string, stamp: ReplyStamp) => void;
};

/** Title generation for new conversations, and the window title that names the open one. */
export type TitleServices = {
  /** Asks for the generated title of a conversation that just got its id. */
  queue: (conversationId: string) => void;
  /** Marks a conversation's generated title as received. */
  markProcessed: (conversationId: string) => void;
  /** Names the browser tab after the open conversation. */
  setDocumentTitle: (title: string) => void;
};

/** The composer's stored drafts and the launch that ties a send to its conversation. */
export type DraftServices = {
  /** Stores (or clears, when empty) the composer text for a draft id. */
  save: (draft: { id: string; value?: string }) => void;
  /** The draft id a pane uses for a conversation, the pane's new-chat id when it has none. */
  getId: (runIndex: number, conversationId?: string | null) => string;
  /**
   * Moves the composer state a send was launched with onto the conversation the server named.
   * `carryPreferences` also moves the per-conversation tool preferences.
   */
  adopt: (
    conversation: TSubmission['conversation'],
    conversationId: string,
    runIndex: number,
    options?: { carryPreferences?: boolean },
  ) => void;
};

/** The route the pane is on. */
export type NavigationServices = {
  pathname: string;
  /** The conversation id in the route, `new` on a new chat. */
  conversationId?: string;
  navigate: (path: string, options?: { replace?: boolean }) => void;
};

/** Where attention goes as a turn opens and settles. */
export type FocusServices = {
  /** Live-region announcement for assistive technology. */
  announce: (options: AnnounceOptions) => void;
  /** Shows the newest sibling of a regenerated response. */
  showRegenerated: (parentMessageId?: string | null) => void;
  /** Returns keyboard focus to the composer. */
  focusComposer: () => void;
  /** Scrolls the thread to its end. */
  scrollToEnd: () => void;
};

/** What a conversation's agent settings carry over to the conversation the server created. */
export type TemplateRequest = {
  targetId: string;
  sourceId?: string | null;
  ephemeralAgent: TSubmission['ephemeralAgent'];
  specName?: string | null;
};

/** Agent and code settings the app keeps per conversation. */
export type TemplateServices = {
  /** Copies the source conversation's agent settings and model spec tools onto the target. */
  apply: (request: TemplateRequest) => void;
  /** Rolls back a code environment choice the failed turn never committed. */
  reconcileFailedCode: (submission: EventSubmission, conversationId?: string) => void;
};

/** The assistants abort route and the run it stops. */
export type AbortRunRequest = {
  /** The assistants endpoint whose `/abort` route owns the run. */
  endpoint: string;
  /** `conversationId:responseMessageId` of the run to stop. */
  abortKey: string;
};

/** The app's file, memory and preview caches a streamed turn keeps in step. */
export type FileServices = {
  /** Records an attachment a tool produced (a file, a memory update, a preview). */
  onAttachment: (attachment: TAttachment) => void;
  /** Records an image file a content frame carries. */
  onImageFile: (file: ImageFile & PartMetadata) => void;
};

/** The signed-in requests the handlers make themselves. */
export type EventTransportServices = {
  /** Stops an Assistants run, which has no resumable generation to address. */
  abortRun: (request: AbortRunRequest) => Promise<Response>;
};

/**
 * What the Assistants stream needs beyond the event services: it posts its own turn, so it owns
 * the signed-in transport, the balance refresh after a turn and the terms check on a refusal.
 */
export type LegacyStreamServices = {
  /** The signed-in user's stream transport. */
  transport: ChatTransport;
  /** Refetches the user's balance when the deployment tracks one. */
  refreshBalance: () => void;
  /** Reopens the terms dialog when an error is a terms refusal, returning the text to show. */
  reopenTermsOnRefusal: (data: ChatErrorData | null | undefined) => string | null;
  /** Clears the composer drafts a finished send leaves behind. */
  clearComposerDrafts: (
    runIndex: number,
    conversationId?: string | null,
    options?: { includeNewChatDraft?: boolean },
  ) => void;
};

/** The pane a set of event services writes for. */
export type EventServicesParams = {
  setConversation?: ChatContract['setConversation'];
};

/**
 * What the stream event handlers need from the app, grouped by the part of the app that owns
 * each. A host can back each group with its own store, router and caches.
 */
export type EventServices = {
  conversations: ConversationCacheServices;
  titles: TitleServices;
  drafts: DraftServices;
  navigation: NavigationServices;
  focus: FocusServices;
  templates: TemplateServices;
  files: FileServices;
  transport: EventTransportServices;
  logger: TurnLogger;
};
