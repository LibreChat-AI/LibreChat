import type {
  Agents,
  TMessage,
  TSubmission,
  TConversation,
  TPendingSteer,
  TAttachment,
  ChatTransport,
  ChatTransportRequest,
  ChatTitleFrame,
  ChatFinalFrame,
  EventSubmission,
  ChatCreatedFrame,
  ChatContentFrame,
  TTokenUsageEvent,
  TContextUsageEvent,
  TSteerUpdatedEvent,
  TSteerAppliedEvent,
  TActivityLabelEvent,
  TReasoningLabelEvent,
} from 'librechat-data-provider';
import type { GenerationProtocolVersion } from '../protocol';
import type { RunEnd } from '../steer/types';
import type { StepEvent } from '../reducer';
import type { ResumableRun } from './run';

/** Where a resumable run reports what it is doing. The app passes its own logger. */
export interface ResumableLogger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** Whether the page is in the foreground, and a way to hear when that changes. */
export interface PageVisibility {
  isVisible: () => boolean;
  /** Calls `listener` on every visibility change; returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void;
}

/** The document's own visibility. */
export const documentVisibility: PageVisibility = {
  isVisible: () => document.visibilityState === 'visible',
  subscribe: (listener) => {
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
};

/** The status route's answer for a conversation's generation. */
export interface StreamStatusResponse {
  /** Exact protocol selected by the job. Missing/1 is always legacy. */
  generationProtocolVersion?: number;
  active: boolean;
  /** Client-local cache marker used to force useResumeOnLoad to replace a
   * stale generation attachment with the newer epoch occupying this stream. */
  generationHandoff?: boolean;
  streamId?: string;
  status?: 'running' | 'complete' | 'error' | 'aborted' | 'requires_action';
  aggregatedContent?: Array<{ type: string; text?: string }>;
  createdAt?: number;
  /** Generation age computed on the server's clock, so a reattaching client
   *  can rebuild a clock-local elapsed baseline free of cross-machine skew. */
  elapsedMs?: number;
  resumeState?: Agents.ResumeState;
  /** The run's temporary state as the server recorded it at admission, so a rebuilt
   *  submission keeps a hidden chat out of history and titling after a reload. */
  isTemporary?: boolean;
  /** Live pending approval when `status === 'requires_action'`; mirrors
   *  `resumeState.pendingAction`, surfaced top-level for the resume-on-load path. */
  pendingAction?: Agents.PendingAction;
  /** Acknowledged steers a terminal drain parked because no subscriber was
   *  live for the final/abort event. Reads are replayable until an exact
   *  recovery turn persists or the user discards the item. */
  unrecoveredSteers?: TPendingSteer[];
}

/** Reads a conversation's generation status. */
export type FetchStreamStatus = (conversationId: string) => Promise<StreamStatusResponse>;

/** The generation one subscription attaches to, and how. */
export interface SubscriptionTarget {
  streamId: string;
  submission: TSubmission;
  /** Asks the server to replay the run's state (`sync`) before live events. */
  isResume: boolean;
  generationCreatedAt?: number;
  generationProtocolVersion: GenerationProtocolVersion;
  /** The pane's lifecycle: once aborted, nothing this subscription does lands. */
  signal?: AbortSignal;
}

/** How a subscription reaches the stream and decides when to re-attach. */
export interface SubscriptionHost {
  logger: ResumableLogger;
  visibility: PageVisibility;
  fetchStatus: FetchStreamStatus;
  /** Attaches a fresh subscription to `target`; how a subscription re-attaches itself. */
  subscribe: (target: SubscriptionTarget) => void;
}

/** How steers the run never injected are turned into queued follow-ups. */
export interface SteerQueueOptions {
  /** Reconcile the parked server copy of live-delivered terminal steers. */
  claimParked?: boolean;
  /** Protocol selected for the source generation. */
  generationProtocolVersion?: GenerationProtocolVersion;
  /** Exact recovery sources a post-terminal status read proved were not consumed. */
  allowPreviouslyConvertedIds?: readonly string[];
  /** Local failures have no durable receipt to reclaim on a later send. */
  bindRecoverySource?: boolean;
  /** Leave the converted rows for an explicit send instead of the run-end drain. */
  needsExplicitSend?: boolean;
}

/** The pane's steer chips: what the composer shows for steers sent into the running turn. */
export interface ResumableSteers {
  /**
   * Removes the pending chip once its steer is injected, records the ids as applied, and
   * returns the ids applied for the first time.
   */
  resolve: (
    conversationId: string,
    steerId: string,
    clientSteerId?: string,
    appliedPartQuotes?: string[],
  ) => string[];
  /** Marks the steer whose inline part just mounted, so it plays its draw-in once. */
  markLiveApplied: (steerId: string) => void;
  /** Patches the chips the server re-labelled (preempt capability); never removes one. */
  update: (event: TSteerUpdatedEvent) => void;
  /** Whether the user has already dealt with the parked steer a recovery start replays. */
  isRecoveryHeld: (conversationId: string, recoverySteerId: string) => boolean;
  /** Refuses further recovery of a parked steer the server rejected. */
  blockRecovery: (conversationId: string, recoverySteerId: string) => void;
  /** Puts a queued turn whose start was refused back in its queue position. */
  restoreQueued: (submission: TSubmission, expectedPredecessorCreatedAt?: number) => void;
  /** Re-seeds the chips from the server's still-queued steers. */
  seed: (
    conversationId: string,
    steers: TPendingSteer[],
    generationCreatedAt?: number,
    generationProtocolVersion?: GenerationProtocolVersion,
  ) => void;
  /** The steer ids the given messages or content parts already hold as applied parts. */
  appliedIds: (values: unknown[] | undefined) => string[];
  /** Settles the chips whose steers the given content already holds. */
  settleApplied: (conversationId: string, values: unknown[] | undefined) => void;
  convertToQueued: (
    conversationId: string,
    steers: TPendingSteer[],
    options?: SteerQueueOptions,
  ) => void;
  /** Sweeps the pane's local chips into queued follow-ups. */
  convertLocalToQueued: (
    conversationId: string,
    options?: {
      claimParked?: boolean;
      statuses?: readonly ('sending' | 'pending' | 'failed')[];
      excludeSteerIds?: Iterable<string>;
      generationProtocolVersion?: GenerationProtocolVersion;
    },
  ) => void;
}

/** The app's query cache, as far as a resumable run reads and refreshes it. */
export interface ResumableCache {
  /** Marks the conversation's messages stale; `all` refetches them now, `none` leaves that to
   *  the next read. */
  invalidateMessages: (conversationId: string, refetch: 'all' | 'active' | 'none') => Promise<void>;
  /** Fetches the conversation's messages through its query. `fallback` reads them directly
   *  when no query for the conversation is mounted yet. */
  fetchMessages: (conversationId: string, fallback?: boolean) => Promise<unknown>;
  /** Marks the conversation stale and refetches it. */
  refreshConversation: (conversationId: string) => Promise<void>;
  /** Refetches every conversation list. */
  refreshConversationLists: () => Promise<void>;
  refreshPinnedConversations: () => Promise<void>;
  setStreamStatus: (conversationId: string, status: StreamStatusResponse) => void;
  removeStreamStatus: (conversationId: string) => void;
  invalidateStreamStatus: (conversationId: string) => void;
  addActiveJob: (streamId: string) => void;
  removeActiveJob: (streamId: string) => void;
  /** Reads the conversation's saved record; rejects with the HTTP failure, a 404 included. */
  fetchConversation: (conversationId: string) => Promise<TConversation | undefined>;
  setConversation: (conversationId: string, conversation: TConversation) => void;
  /** Places the conversation's snapshot into every conversation list. */
  upsertConversation: (conversation: TConversation) => void;
  /** Drops the conversation from every conversation list. */
  removeConversation: (conversationId: string) => void;
  getConversation: (conversationId: string) => TConversation | undefined;
  /** Drops the conversation's own record and messages from the cache. */
  removeConversationQueries: (conversationId: string) => void;
  /** Polls for the title the server generates for a new conversation. */
  queueTitleGeneration: (conversationId: string) => void;
  /**
   * Gives a new chat its conversation record and messages under the id the server assigned,
   * before any stream event names it; returns the submission rewritten onto that id.
   */
  addOptimisticConversation: (conversationId: string, submission: TSubmission) => TSubmission;
}

/** The run markers the queue drain reads for a conversation this pane may leave mid-run. */
export interface ResumableQueue {
  /** Clears the stop and detached-run markers an earlier generation left, keeping the ones
   *  `isSameGeneration` says belong to the generation being resumed. */
  clearSupersededMarkers: (
    conversationId: string,
    isSameGeneration: (generationCreatedAt?: number) => boolean,
  ) => void;
  /** Whether the user stopped this generation. */
  isStopped: (conversationId: string, generationCreatedAt: number) => boolean;
  /** Records a run the pane left while it was still generating. */
  rememberDetachedRun: (
    conversationId: string,
    run: { userMessageId: string; responseMessageId?: string; generationCreatedAt: number },
  ) => void;
}

/** The pane's controls and run bookkeeping a resumable run drives. */
export interface ResumablePane {
  setIsSubmitting: (isSubmitting: boolean) => void;
  setShowStopButton: (show: boolean) => void;
  setSubmission: (submission: TSubmission | null) => void;
  setStreamId: (streamId: string | null) => void;
  /** Records the generation epoch a conversation's controls fence against; with `expected`,
   *  only while it still holds that epoch. Returns whether it was written. */
  setGenerationEpoch: (
    conversationId: string,
    next: number | null,
    expected?: number,
    generationProtocolVersion?: GenerationProtocolVersion,
  ) => boolean;
  setPendingAction: (conversationId: string, action: Agents.PendingAction | null) => void;
  /** Drops the composer drafts the finished run consumed. */
  clearComposerDrafts: (
    conversationId: string | null | undefined,
    options: { includeNewChatDraft: boolean },
  ) => void;
  publishRunEnd: (end: RunEnd, options?: { retainDetached?: boolean }) => void;
  /** Consumes an armed "interrupt & send" for exactly this generation. */
  clearDrainAfterAbort: (conversationId: string, generationCreatedAt?: number) => void;
  /** Refreshes the token balance, when the deployment tracks one. */
  refreshBalance: () => void;
  setAbortScroll: (abort: boolean) => void;
  /** Starts a new identity for the run the pane displays (a `created` or resume `sync`). */
  renewActiveRun: () => void;
  /** Where a run's end lands: an early-aborted first turn keys under the new-chat id. */
  runEndTarget: (params: {
    conversationId: string;
    earlyAbort: boolean;
    startedAsNewConvo: boolean;
  }) => { conversationId: string; startedAsNewConvo: boolean };
  /** Sets the pane's conversation, whatever response the pane adds. */
  setConversation?: (update: (current: TConversation | null) => TConversation | null) => void;
  /** Resets the pane to a fresh new chat. */
  startNewConversation?: () => void;
  /** Moves the address bar off `/c/new` onto the conversation the server assigned. */
  replaceNewConversationUrl: (conversationId: string) => void;
  /** Updates the pane's conversation; absent for a pane that only adds a comparison response. */
  updateConversation?: (update: (current: TConversation | null) => TConversation | null) => void;
  /**
   * The end of a run this pane left mid-stream and is now reattached to, as `messages` record
   * it. `resolvable` is false when no such run is remembered or the user stopped it.
   */
  resolveDetachedEnd: (
    conversationId: string,
    messages: TMessage[] | undefined,
  ) => { resolvable: boolean; end: RunEnd | null };
}

/** What the event handlers that render the stream expose to the run. */
export interface ResumableEvents {
  stepHandler: (event: StepEvent, submission: EventSubmission) => void;
  finalHandler: (data: ChatFinalFrame, submission: EventSubmission) => void;
  createdHandler: (data: ChatCreatedFrame, submission: EventSubmission) => void;
  attachmentHandler: (params: { data: TAttachment; submission: EventSubmission }) => void;
  titleHandler: (data: ChatTitleFrame) => void;
  contentHandler: (params: { data: ChatContentFrame; submission: EventSubmission }) => void;
  /** Legacy streams' cumulative text. */
  messageHandler: (text: string | undefined, submission: EventSubmission) => void;
  /** Marks programmatic tool calls a resume cannot rebuild as interrupted. */
  prunePtcTraces: () => void;
  resetContentHandler: () => void;
  /** Replaces the step handler's copy of a message the run patched outside it. */
  syncStepMessage: (message: TMessage) => void;
  clearStepMaps: () => void;
  flushPendingDeltas: () => void;
  /** Discards the live usage estimate for a run that stopped streaming. */
  resetLive: (submission: TSubmission) => void;
  /** Writes the error card for a start that failed, from the response body it failed with, or
   *  for a recovery start the user already dealt with. */
  showStartFailure: (
    submission: TSubmission,
    errorData?: unknown,
    reason?: 'recovery_held',
  ) => void;
  /** Writes the failed turn's error card from the text (or raw error value) the server sent. */
  showError: (text: string | boolean | { message?: string }, submission: TSubmission) => void;
}

/** The run's token usage: the live estimate while it streams and the totals it settles to. */
export interface ResumableUsage {
  bindResponse: (submission: TSubmission) => void;
  contextHandler: (data: TContextUsageEvent, submission: TSubmission) => void;
  usageHandler: (data: TTokenUsageEvent, submission: TSubmission) => void;
  tapStream: (data: { delta?: { content?: unknown } }, submission: TSubmission) => void;
  tapContent: (text: unknown, submission: TSubmission) => void;
  finalizeUsage: (data: ChatFinalFrame, submission: TSubmission) => void;
  backfillUsage: (entries: TTokenUsageEvent[], submission: TSubmission) => void;
  /** Seeds the live estimate with the output a resume snapshot already holds. */
  seedLiveFromContent: (content: unknown[] | undefined, submission: TSubmission) => void;
}

/** The pane's message list. */
export interface ResumableMessages {
  get: () => TMessage[] | undefined;
  set: (messages: TMessage[]) => void;
}

/**
 * How the app places the parts a run reports beside its deltas onto a response message, and
 * finds the response each one targets among the pane's messages.
 */
export interface ResumableParts {
  applySteer: (message: TMessage, event: TSteerAppliedEvent) => TMessage;
  findSteerTarget: (
    messages: TMessage[],
    event: TSteerAppliedEvent,
    fallbackMessageIds?: readonly (string | null | undefined)[],
  ) => number;
  applyActivityLabel: (message: TMessage, event: TActivityLabelEvent) => TMessage;
  findActivityLabelTarget: (
    messages: TMessage[],
    event: TActivityLabelEvent,
    fallbackMessageIds?: readonly (string | null | undefined)[],
  ) => number;
  /** Shifts a phase label's end boundary past an edit's retained prefix. */
  offsetActivityPhaseBoundary: (
    endIndex: number,
    prefixLength: number,
    foldedFirstPart: boolean,
  ) => number;
  applyReasoningLabel: (message: TMessage, event: TReasoningLabelEvent) => TMessage;
  findReasoningLabelTarget: (messages: TMessage[], event: TReasoningLabelEvent) => number;
}

/** Everything a resumable run needs from the app it runs in. */
export interface ResumableHost extends SubscriptionHost {
  cache: ResumableCache;
  queue: ResumableQueue;
  pane: ResumablePane;
  steers: ResumableSteers;
  events: ResumableEvents;
  messages: ResumableMessages;
  parts: ResumableParts;
  usage: ResumableUsage;
  /** The stream side of the app's transport, bound to the signed-in user. */
  stream: ChatTransport;
  /** POSTs a turn to the resumable generation route; resolves to the start response. */
  start: (request: ChatTransportRequest, options?: { signal?: AbortSignal }) => Promise<unknown>;
  /** Receives the dev-only controls that simulate a dropped or a clean close. */
  exposeDebugControls?: (controls: { killNetwork: () => void; closeClean: () => void }) => void;
}

/** One submission the pane serves, from its start (or resume) until it is replaced. */
export interface MountContext {
  run: ResumableRun;
  host: ResumableHost;
  submission: TSubmission;
  /** Aborted once the pane moves to another submission or unmounts. */
  signal: AbortSignal;
  /** Whether this submission is still the one the pane serves. */
  isCurrent: () => boolean;
}
