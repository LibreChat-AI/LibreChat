import { useEffect, useState, useRef, useCallback } from 'react';
import { v4 } from 'uuid';
import { SSE } from 'sse.js';
import { useStore } from 'jotai';
import { useQueryClient } from '@tanstack/react-query';
import { useSetRecoilState, useRecoilCallback } from 'recoil';
import {
  request,
  Constants,
  QueryKeys,
  ErrorTypes,
  StepEvents,
  StepTypes,
  apiBaseUrl,
  SteerEvents,
  dataService,
  ContentTypes,
  ToolCallTypes,
  ActivityLabelEvents,
  ReasoningLabelEvents,
  UsageEvents,
  createPayload,
  ApprovalEvents,
  ViolationTypes,
  removeNullishValues,
} from 'librechat-data-provider';
import type {
  Agents,
  TMessage,
  TPayload,
  TSubmission,
  TConversation,
  TPendingSteer,
  EventSubmission,
  TSteerAppliedEvent,
  TSteerUpdatedEvent,
  TActivityLabelEvent,
  TReasoningLabelEvent,
} from 'librechat-data-provider';
import type { ActiveJobsResponse, StreamStatusResponse } from '~/data-provider';
import type { DrainAfterAbort, QueuedMessageOrigin } from '~/store/families';
import type { GenerationProtocolVersion } from '~/data-provider';
import type { EventHandlerParams } from './useEventHandlers';
import type { TResData } from '~/common';
import {
  logger,
  clearComposerDrafts,
  applySteerPart,
  applyPendingAction,
  carriedSteerContext,
  resolveRunEndTarget,
  findSteerMessageIndex,
  applyActivityLabelPart,
  applyReasoningLabel,
  offsetActivityPhaseBoundary,
  findActivityLabelMessageIndex,
  findReasoningLabelMessageIndex,
  appendAppliedSteerIds,
  collectAppliedSteerIds,
  collectDroppedSteerQuotes,
  mergeRestagedQuotes,
  removeConvoFromAllQueries,
  upsertConvoInAllQueries,
  invalidateConversationLists,
  countTaggedApprovalParts,
  countTrailingOutputChars,
  markStreamStartFailedMetadata,
  findPendingActionMessageIndex,
  insertQueuedOrigin,
  hydrateFileDeliveryMetadata,
  isCompactionAnchorProjection,
} from '~/utils';
import {
  useGetUserBalance,
  fetchStreamStatus,
  useGetStartupConfig,
  queueTitleGeneration,
  streamStatusQueryKey,
  generationProtocolHeaders,
  getGenerationProtocolVersion,
  postGenerationRequest,
  supportsGenerationProtocolV2,
  GENERATION_PROTOCOL_VERSION,
} from '~/data-provider';
import {
  recoveryDispositionsFamily,
  canRestoreRecovery,
  blockRecovery,
} from '~/components/Chat/Steering/recovery';
import useEventHandlers, {
  buildCreatedInitialResponse,
  keepLocalCodeApprovalMode,
} from './useEventHandlers';
import { pendingApprovalActionFamily } from '~/components/Chat/approval/state';
import useSteerConvert from '~/hooks/Chat/useSteerConvert';
import { useAuthContext } from '~/hooks/AuthContext';
import { useFileMapContext } from '~/Providers';
import useUsageHandler from './useUsageHandler';
import useLocalize from '~/hooks/useLocalize';
import store from '~/store';

type ChatHelpers = Pick<
  EventHandlerParams,
  'setMessages' | 'getMessages' | 'setConversation' | 'setIsSubmitting' | 'newConversation'
>;

/**
 * Reconciliation often crosses async query boundaries. By the time an old
 * generation settles, this pane may have armed "interrupt & send" for a new
 * conversation/generation. Recoil applies functional setters against the
 * latest value, so only consume the exact intent owned by this terminal path.
 */
const clearMatchingDrainAfterAbort = (
  armed: DrainAfterAbort | false,
  conversationId: string,
  generationCreatedAt: number,
): DrainAfterAbort | false =>
  armed !== false &&
  armed.conversationId === conversationId &&
  armed.generationCreatedAt === generationCreatedAt
    ? false
    : armed;

const MAX_RETRIES = 5;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const getReconnectDelay = (attempt: number) =>
  Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1), RECONNECT_MAX_DELAY_MS);
const START_GENERATION_NETWORK_RETRIES = 3;
const START_GENERATION_READINESS_TIMEOUT_MS = 120000;
const SERVER_NOT_READY_CODE = 'SERVER_NOT_READY';
const PREDECESSOR_MISMATCH_CODE = 'GENERATION_PREDECESSOR_MISMATCH';
const STEER_RECOVERY_REQUEST_PREFIX = 'steer-recovery:';

type StartGenerationError = {
  code?: string;
  response?: {
    status?: number;
    data?: unknown;
    headers?: Record<string, string | number | string[] | undefined>;
  };
};

const toStartGenerationError = (error: unknown): StartGenerationError | undefined =>
  error != null && typeof error === 'object' ? (error as StartGenerationError) : undefined;

const getStartGenerationStreamId = (data: unknown): string | null => {
  if (data == null || typeof data !== 'object' || !('streamId' in data)) {
    return null;
  }

  const streamId = (data as { streamId?: unknown }).streamId;
  return typeof streamId === 'string' && streamId.length > 0 ? streamId : null;
};

/** The server returns `status: 'resumed'` when a duplicate start request was deduped to an
 *  already-running stream — the client must subscribe with resume=true to replay its state
 *  (prior content and any pending-action) rather than only receiving live events. */
const isResumedStartResponse = (data: unknown): boolean =>
  data != null && typeof data === 'object' && (data as { status?: unknown }).status === 'resumed';

const isSettledStartResponse = (data: unknown): boolean =>
  supportsGenerationProtocolV2(data) &&
  data != null &&
  typeof data === 'object' &&
  (data as { status?: unknown }).status === 'settled';

const isReplacedStartResponse = (data: unknown): boolean =>
  supportsGenerationProtocolV2(data) &&
  data != null &&
  typeof data === 'object' &&
  (data as { status?: unknown }).status === 'replaced';

const isUnnegotiatedV2StartControl = (data: unknown): boolean => {
  if (supportsGenerationProtocolV2(data) || data == null || typeof data !== 'object') {
    return false;
  }
  const status = (data as { status?: unknown }).status;
  return status === 'settled' || status === 'replaced';
};

const getStartGenerationConversationId = (data: unknown): string | null => {
  if (data == null || typeof data !== 'object' || !('conversationId' in data)) {
    return null;
  }
  const conversationId = (data as { conversationId?: unknown }).conversationId;
  return typeof conversationId === 'string' && conversationId.length > 0 ? conversationId : null;
};

const getStartGenerationCreatedAt = (data: unknown): number | null => {
  if (data == null || typeof data !== 'object' || !('generationCreatedAt' in data)) {
    return null;
  }
  const createdAt = (data as { generationCreatedAt?: unknown }).generationCreatedAt;
  return typeof createdAt === 'number' && Number.isSafeInteger(createdAt) && createdAt >= 0
    ? createdAt
    : null;
};

type PredecessorMismatchStartResponse = {
  streamId: string;
  conversationId: string;
  generationCreatedAt: number;
  active: boolean;
};

const getPredecessorMismatchStartResponse = (
  error: unknown,
): PredecessorMismatchStartResponse | null => {
  const startError = toStartGenerationError(error);
  const data = startError?.response?.data;
  if (
    startError?.response?.status !== 409 ||
    data == null ||
    typeof data !== 'object' ||
    (data as { status?: unknown }).status !== 'predecessor_mismatch' ||
    (data as { code?: unknown }).code !== PREDECESSOR_MISMATCH_CODE
  ) {
    return null;
  }

  const streamId = getStartGenerationStreamId(data);
  const conversationId = getStartGenerationConversationId(data);
  if (!streamId || !conversationId) {
    return null;
  }

  const generationCreatedAt = getStartGenerationCreatedAt(data);
  const active = (data as { active?: unknown }).active;
  if (generationCreatedAt == null || typeof active !== 'boolean') {
    return null;
  }
  return {
    streamId,
    conversationId,
    generationCreatedAt,
    active,
  };
};

/** Recovery submissions use a deterministic request id tied to the parked
 * source. A status read performed only after this exact submission is proven
 * terminal may authorize that source past the client-side live-event
 * tombstone; unrelated status snapshots must remain deduped. */
const getRecoverySteerId = (submission: TSubmission): string | null => {
  if (typeof submission.recoverySteerId === 'string' && submission.recoverySteerId.length > 0) {
    return submission.recoverySteerId;
  }
  const clientRequestId = submission.clientRequestId;
  if (
    typeof clientRequestId !== 'string' ||
    !clientRequestId.startsWith(STEER_RECOVERY_REQUEST_PREFIX)
  ) {
    return null;
  }
  const steerId = clientRequestId.slice(STEER_RECOVERY_REQUEST_PREFIX.length);
  return steerId.length > 0 ? steerId : null;
};

type StartGenerationResult =
  | {
      status: 'stream';
      streamId: string;
      resumed: boolean;
      generationCreatedAt?: number;
      generationProtocolVersion: GenerationProtocolVersion;
    }
  | {
      status: 'settled';
      conversationId: string;
      generationProtocolVersion: typeof GENERATION_PROTOCOL_VERSION;
    }
  | {
      status: 'replaced';
      streamId: string;
      conversationId: string;
      generationCreatedAt: number;
      generationProtocolVersion: typeof GENERATION_PROTOCOL_VERSION;
    }
  | {
      status: 'predecessor_mismatch';
      streamId: string;
      conversationId: string;
      generationCreatedAt: number;
      active: boolean;
      generationProtocolVersion: typeof GENERATION_PROTOCOL_VERSION;
    };

const parseSSEErrorData = (body: string): unknown | null => {
  const blocks = body.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const event = lines
      .find((line) => line.startsWith('event:'))
      ?.slice('event:'.length)
      .trim();
    if (event !== 'error') {
      continue;
    }

    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n')
      .trim();

    if (!data) {
      return null;
    }

    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }

  return null;
};

const getSSEErrorText = (payload: unknown): string | null => {
  if (typeof payload === 'string') {
    return payload;
  }

  if (payload == null || typeof payload !== 'object') {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const text = record.text ?? record.message ?? record.error;
  return typeof text === 'string' && text.length > 0 ? text : null;
};

const getStreamStartFailureText = (errorData?: unknown): string => {
  if (typeof errorData === 'string') {
    const sseErrorData = parseSSEErrorData(errorData);
    if (sseErrorData != null) {
      return getSSEErrorText(sseErrorData) ?? JSON.stringify(sseErrorData);
    }

    return errorData || 'Error connecting to server, try refreshing the page.';
  }

  return errorData
    ? JSON.stringify(errorData)
    : 'Error connecting to server, try refreshing the page.';
};

const getStreamStartFailureData = (errorData?: unknown): TResData =>
  ({
    text: getStreamStartFailureText(errorData),
    metadata: markStreamStartFailedMetadata(),
  }) as unknown as TResData;

const isRetryableNetworkError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false;
  }

  const { code } = toStartGenerationError(error) ?? {};
  return code === 'ERR_NETWORK' || code === 'ERR_INTERNET_DISCONNECTED';
};

const isServerNotReadyError = (error: unknown) => {
  const candidate = toStartGenerationError(error);
  const data = candidate?.response?.data;
  const code =
    data != null && typeof data === 'object' && 'code' in data
      ? (data as { code?: unknown }).code
      : undefined;
  return candidate?.response?.status === 503 && code === SERVER_NOT_READY_CODE;
};

const getRetryAfterDelay = (error: unknown, fallbackDelay: number) => {
  const headers = toStartGenerationError(error)?.response?.headers;
  const rawValue = headers?.['retry-after'] ?? headers?.['Retry-After'];
  const retryAfter = Array.isArray(rawValue) ? rawValue[0] : rawValue;
  const seconds = typeof retryAfter === 'number' ? retryAfter : Number(retryAfter);

  if (!Number.isFinite(seconds) || seconds < 0) {
    return fallbackDelay;
  }

  return Math.min(seconds * 1000, 30000);
};

const waitForRetryDelay = (delay: number, signal?: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }

    function cleanup() {
      signal?.removeEventListener('abort', onAbort);
    }
    function onAbort() {
      clearTimeout(timeout);
      cleanup();
      resolve(false);
    }
    const timeout = setTimeout(() => {
      cleanup();
      resolve(true);
    }, delay);

    signal?.addEventListener('abort', onAbort, { once: true });
  });

const hasConcreteConversationId = (conversationId?: string | null) =>
  !!conversationId &&
  conversationId !== Constants.NEW_CONVO &&
  conversationId !== Constants.PENDING_CONVO;

const isInitialNewConversation = (submission: TSubmission) => {
  const conversationId = submission.conversation?.conversationId;
  return !hasConcreteConversationId(conversationId);
};

const getToolCallName = (toolCall: unknown) =>
  toolCall != null && typeof toolCall === 'object' && 'name' in toolCall
    ? (toolCall.name as unknown)
    : undefined;

const isOAuthToolCallName = (name: unknown) =>
  typeof name === 'string' && name.startsWith(`oauth${Constants.mcp_delimiter}`);

const hasOAuthToolCall = (toolCalls: unknown) =>
  Array.isArray(toolCalls) &&
  toolCalls.some((toolCall) => isOAuthToolCallName(getToolCallName(toolCall)));

const isOAuthStepEvent = (data: unknown) => {
  if (data == null || typeof data !== 'object' || !('event' in data)) {
    return false;
  }

  const event = data.event;
  const payload = 'data' in data ? data.data : undefined;
  if (payload == null || typeof payload !== 'object') {
    return false;
  }

  if (event === StepEvents.ON_RUN_STEP) {
    const stepDetails = 'stepDetails' in payload ? payload.stepDetails : undefined;
    return (
      stepDetails != null &&
      typeof stepDetails === 'object' &&
      'tool_calls' in stepDetails &&
      hasOAuthToolCall(stepDetails.tool_calls)
    );
  }

  if (event === StepEvents.ON_RUN_STEP_DELTA) {
    const delta = 'delta' in payload ? payload.delta : undefined;
    if (delta == null || typeof delta !== 'object') {
      return false;
    }
    return (
      ('auth' in delta && delta.auth != null) ||
      ('tool_calls' in delta && hasOAuthToolCall(delta.tool_calls))
    );
  }

  if (event === StepEvents.ON_RUN_STEP_COMPLETED) {
    const result = 'result' in payload ? payload.result : undefined;
    if (result == null || typeof result !== 'object' || !('tool_call' in result)) {
      return false;
    }
    return isOAuthToolCallName(getToolCallName(result.tool_call));
  }

  return false;
};

const getStepEventId = (event: unknown): string | undefined => {
  if (event == null || typeof event !== 'object' || !('data' in event)) {
    return undefined;
  }
  const data = event.data;
  if (data == null || typeof data !== 'object') {
    return undefined;
  }
  if ('id' in data && typeof data.id === 'string') {
    return data.id;
  }
  const result = 'result' in data ? data.result : undefined;
  return result != null &&
    typeof result === 'object' &&
    'id' in result &&
    typeof result.id === 'string'
    ? result.id
    : undefined;
};

const replaceNewConversationUrl = (conversationId: string) => {
  if (window.location.pathname !== `/c/${Constants.NEW_CONVO}`) {
    return;
  }

  window.history.replaceState(
    window.history.state,
    '',
    `/c/${conversationId}${window.location.search}`,
  );
};

const shouldHydrateMessage = (message: TMessage) =>
  !hasConcreteConversationId(message.conversationId);

/** Recovery must identify the response itself: regenerations share a user
 * parent, and array order says nothing about which sibling just completed.
 * A fresh-turn placeholder has no server response ID yet; only an unambiguous
 * persisted child can stand in for it. */
const completedResponseMessageId = (
  messages: TMessage[] | undefined,
  userMessageId: string | undefined,
  responseMessageId: string | undefined,
): string | undefined => {
  if (messages == null || userMessageId == null) {
    return undefined;
  }
  const target = responseMessageId?.replace(/_+$/, '');
  const hasResponseIdentity = target != null && target !== userMessageId;
  let candidate: string | undefined;
  let ambiguous = false;
  for (const message of messages) {
    if (message.isCreatedByUser !== false || message.parentMessageId !== userMessageId) {
      continue;
    }
    if (hasResponseIdentity) {
      if (message.messageId === target) {
        return message.messageId;
      }
      continue;
    }
    ambiguous ||= candidate != null;
    candidate = message.messageId;
  }
  return hasResponseIdentity || ambiguous ? undefined : candidate;
};

const hydrateMessageConversationId = (message: TMessage, conversationId: string): TMessage =>
  shouldHydrateMessage(message) ? { ...message, conversationId } : message;

const preferDefinedString = (value?: string | null, fallback?: string): string | undefined =>
  value != null && value !== '' ? value : fallback;

const getOptimisticMessages = (
  submission: TSubmission,
  conversationId: string,
  messages?: TMessage[],
): TMessage[] => {
  const sourceMessages =
    messages && messages.length > 0
      ? messages
      : [submission.userMessage, submission.initialResponse].filter(
          (message): message is TMessage => message != null,
        );

  return sourceMessages.map((message) => hydrateMessageConversationId(message, conversationId));
};

const buildOptimisticConversation = (
  submission: TSubmission,
  conversationId: string,
): TConversation => {
  const now = new Date().toISOString();
  const messageIds = [
    submission.userMessage?.messageId,
    submission.initialResponse?.messageId,
  ].filter((messageId): messageId is string => typeof messageId === 'string' && messageId !== '');

  return {
    ...submission.conversation,
    conversationId,
    endpoint: submission.conversation.endpoint ?? null,
    title: submission.conversation.title ?? 'New Chat',
    messages: messageIds.length > 0 ? messageIds : submission.conversation.messages,
    createdAt: submission.conversation.createdAt ?? now,
    updatedAt: now,
    /** Temporary mode lives on the submission, not on the draft conversation, so
     * the optimistic record has to carry it forward or every consumer of this
     * cache entry reads a new temporary chat as an ordinary one. Only stamped
     * when true, leaving the legacy `expiredAt` inference untouched otherwise. */
    ...(submission.isTemporary === true ? { isTemporary: true } : {}),
  } as TConversation;
};

const hydrateSubmissionMessages = (
  submission: TSubmission,
  conversationId: string,
): TSubmission => ({
  ...submission,
  conversation: {
    ...submission.conversation,
    conversationId,
  },
  userMessage: hydrateMessageConversationId(submission.userMessage, conversationId),
  initialResponse: submission.initialResponse
    ? hydrateMessageConversationId(submission.initialResponse, conversationId)
    : submission.initialResponse,
});

const buildResumeEventSubmission = (
  currentSubmission: TSubmission,
  currentUserMessage: TMessage,
  resumeState?: Agents.ResumeState | null,
): EventSubmission => {
  if (!resumeState) {
    return { ...currentSubmission, userMessage: currentUserMessage } as EventSubmission;
  }

  const conversationId =
    resumeState.conversationId ??
    resumeState.userMessage?.conversationId ??
    currentUserMessage.conversationId ??
    currentSubmission.conversation?.conversationId;

  /**
   * A compaction submits no user turn: its user-message slot names the LEAF it
   * summarizes up to, and the server projects that anchor as identity only
   * (`projectCompactionAnchor` — no parent, no author). Adopting the projection
   * as a user row would rewrite the leaf into an empty, parentless message, so
   * an anchored run keeps the identity it resumed with.
   */
  /** Read from the projection as well as the flag: a re-attach whose submission
   *  never learned it was a compaction still has to recognize the anchor. */
  const anchoredUserMessage =
    currentSubmission.compact === true || isCompactionAnchorProjection(resumeState.userMessage);

  const userMessage = (
    anchoredUserMessage
      ? { ...currentUserMessage, conversationId }
      : {
          ...currentUserMessage,
          ...resumeState.userMessage,
          conversationId,
          isCreatedByUser: true,
        }
  ) as TMessage;

  const responseMessageId =
    resumeState.responseMessageId ??
    currentSubmission.initialResponse?.messageId ??
    `${userMessage.messageId}_`;

  const initialResponse = {
    ...(currentSubmission.initialResponse as TMessage),
    messageId: responseMessageId,
    parentMessageId: userMessage.messageId,
    conversationId,
    content:
      resumeState.aggregatedContent ??
      (currentSubmission.initialResponse as TMessage | undefined)?.content,
    sender: resumeState.sender ?? currentSubmission.initialResponse?.sender,
    iconURL: preferDefinedString(currentSubmission.initialResponse?.iconURL, resumeState.iconURL),
    model: preferDefinedString(currentSubmission.initialResponse?.model, resumeState.model),
    isCreatedByUser: false,
  } as TMessage;

  return {
    ...currentSubmission,
    conversation: {
      ...currentSubmission.conversation,
      conversationId,
    },
    userMessage,
    initialResponse,
    /** Carried so every consumer of the resumed submission — the merges below,
     *  the abort-error write — reads the same answer this resolved. */
    ...(anchoredUserMessage && { compact: true }),
  } as EventSubmission;
};

type ResumeMessageIndexes = {
  userIndex: number;
  responseIndex: number;
  preliminaryUserIndex: number;
  preliminaryResponseIndex: number;
};

const getResumeMessageIndexes = (
  messages: TMessage[],
  userMessageId: string,
  responseMessageId: string,
  preliminaryUserMessageId?: string,
  preliminaryResponseMessageId?: string,
): ResumeMessageIndexes => {
  let userIndex = -1;
  let responseIndex = -1;
  let preliminaryUserIndex = -1;
  let preliminaryResponseIndex = -1;
  const hasPreliminaryResponse = preliminaryResponseMessageId?.endsWith('_') === true;
  const eligiblePreliminaryUserId =
    hasPreliminaryResponse && preliminaryUserMessageId && preliminaryUserMessageId !== userMessageId
      ? preliminaryUserMessageId
      : undefined;
  const eligiblePreliminaryResponseId =
    hasPreliminaryResponse && preliminaryResponseMessageId !== responseMessageId
      ? preliminaryResponseMessageId
      : undefined;

  for (let index = 0; index < messages.length; index++) {
    const messageId = messages[index]?.messageId;
    if (userIndex < 0 && messageId === userMessageId) {
      userIndex = index;
    }
    if (responseIndex < 0 && messageId === responseMessageId) {
      responseIndex = index;
    }
    if (
      preliminaryUserIndex < 0 &&
      eligiblePreliminaryUserId &&
      messageId === eligiblePreliminaryUserId
    ) {
      preliminaryUserIndex = index;
    }
    if (
      preliminaryResponseIndex < 0 &&
      eligiblePreliminaryResponseId &&
      messageId === eligiblePreliminaryResponseId
    ) {
      preliminaryResponseIndex = index;
    }
  }

  return { userIndex, responseIndex, preliminaryUserIndex, preliminaryResponseIndex };
};

const mergeResumeMessages = (
  messages: TMessage[],
  userMessage: TMessage,
  responseMessage: TMessage,
  indexes: ResumeMessageIndexes,
  /**
   * An anchored run — a compaction — owns no user row. Its user-message slot
   * holds the leaf the summary hangs off, a row the transcript already has:
   * merging the slot onto it would replace that answer with an empty user
   * message, and inserting it would duplicate its id. Either way the row loses
   * its parent and `buildTree` files it as a phantom root, folding the thread.
   */
  anchoredUserMessage = false,
): TMessage[] => {
  const nextMessages = [...messages];
  let { userIndex, responseIndex, preliminaryResponseIndex } = indexes;
  const { preliminaryUserIndex } = indexes;

  if (preliminaryUserIndex >= 0 && !anchoredUserMessage) {
    if (userIndex >= 0) {
      nextMessages.splice(preliminaryUserIndex, 1);
      if (userIndex > preliminaryUserIndex) {
        userIndex -= 1;
      }
      if (responseIndex > preliminaryUserIndex) {
        responseIndex -= 1;
      }
      if (preliminaryResponseIndex > preliminaryUserIndex) {
        preliminaryResponseIndex -= 1;
      }
    } else {
      nextMessages[preliminaryUserIndex] = {
        ...nextMessages[preliminaryUserIndex],
        ...userMessage,
      };
      userIndex = preliminaryUserIndex;
    }
  }

  if (preliminaryResponseIndex >= 0) {
    if (responseIndex >= 0) {
      nextMessages.splice(preliminaryResponseIndex, 1);
      if (userIndex > preliminaryResponseIndex) {
        userIndex -= 1;
      }
      if (responseIndex > preliminaryResponseIndex) {
        responseIndex -= 1;
      }
    } else {
      nextMessages[preliminaryResponseIndex] = {
        ...nextMessages[preliminaryResponseIndex],
        ...responseMessage,
      };
      responseIndex = preliminaryResponseIndex;
    }
  }

  if (userIndex >= 0 && !anchoredUserMessage) {
    nextMessages[userIndex] = { ...nextMessages[userIndex], ...userMessage };
  }

  if (responseIndex >= 0) {
    nextMessages[responseIndex] = { ...nextMessages[responseIndex], ...responseMessage };
  }

  if (anchoredUserMessage) {
    return responseIndex >= 0 ? nextMessages : [...nextMessages, responseMessage];
  }

  if (userIndex >= 0 && responseIndex >= 0) {
    return nextMessages;
  }

  if (userIndex >= 0) {
    return [...nextMessages, responseMessage];
  }

  if (responseIndex >= 0) {
    nextMessages.splice(responseIndex, 0, userMessage);
    return nextMessages;
  }

  return [...nextMessages, userMessage, responseMessage];
};

/**
 * Hook for resumable SSE streams.
 * Separates generation start (POST) from stream subscription (GET EventSource).
 * Supports auto-reconnection with exponential backoff.
 *
 * Key behavior:
 * - Navigation away does NOT abort the generation (just closes SSE)
 * - Only explicit abort (via stop button → backend abort endpoint) stops generation
 * - Backend emits `done` event with `aborted: true` on abort, handled via finalHandler
 */
export default function useResumableSSE(
  submission: TSubmission | null,
  chatHelpers: ChatHelpers,
  isAddedRequest = false,
  runIndex = 0,
) {
  const jotaiStore = useStore();
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const setActiveRunId = useSetRecoilState(store.activeRunFamily(runIndex));

  const { token, isAuthenticated } = useAuthContext();
  const fileMap = useFileMapContext();
  const fileMapRef = useRef(fileMap);
  fileMapRef.current = fileMap;
  const { setMessages, getMessages, setConversation, setIsSubmitting, newConversation } =
    chatHelpers;

  /**
   * Optimistically add a job ID to the active jobs cache.
   * Called when generation starts.
   */
  const addActiveJob = useCallback(
    (jobId: string) => {
      queryClient.setQueryData<ActiveJobsResponse>([QueryKeys.activeJobs], (old) => ({
        activeJobIds: [...new Set([...(old?.activeJobIds ?? []), jobId])],
      }));
    },
    [queryClient],
  );

  /**
   * Optimistically remove a job ID from the active jobs cache.
   * Called when generation completes, aborts, or errors.
   */
  const removeActiveJob = useCallback(
    (jobId: string) => {
      queryClient.setQueryData<ActiveJobsResponse>([QueryKeys.activeJobs], (old) => ({
        activeJobIds: (old?.activeJobIds ?? []).filter((id) => id !== jobId),
      }));
    },
    [queryClient],
  );

  const addOptimisticConversation = useCallback(
    (conversationId: string, currentSubmission: TSubmission): TSubmission => {
      if (!isInitialNewConversation(currentSubmission)) {
        return currentSubmission;
      }

      const optimisticConversation = buildOptimisticConversation(currentSubmission, conversationId);
      const optimisticMessages = getOptimisticMessages(
        currentSubmission,
        conversationId,
        getMessages(),
      );

      queryClient.setQueryData<TConversation>(
        [QueryKeys.conversation, conversationId],
        (current) => current ?? optimisticConversation,
      );
      queryClient.setQueryData<TMessage[]>(
        [QueryKeys.messages, conversationId],
        optimisticMessages,
      );
      queryClient.setQueryData<TMessage[]>(
        [QueryKeys.messages, Constants.NEW_CONVO],
        optimisticMessages,
      );
      upsertConvoInAllQueries(queryClient, optimisticConversation);

      return hydrateSubmissionMessages(currentSubmission, conversationId);
    },
    [getMessages, queryClient],
  );
  const [_completed, setCompleted] = useState(new Set());
  const [streamId, setStreamId] = useState<string | null>(null);
  const setAbortScroll = useSetRecoilState(store.abortScrollFamily(runIndex));
  const setSubmission = useSetRecoilState(store.submissionByIndex(runIndex));
  const setShowStopButton = useSetRecoilState(store.showStopButtonByIndex(runIndex));
  const setLiveAppliedSteerIds = useSetRecoilState(store.liveAppliedSteerIds);

  const sseRef = useRef<SSE | null>(null);
  /** Removes the foreground re-attach listener owned by the newest
   *  subscription; exactly one is registered at a time. */
  const stopForegroundReattachRef = useRef<(() => void) | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const submissionRef = useRef<TSubmission | null>(null);
  /** Suppresses the normal close/cleanup idle transition while a stale
   * generation is being atomically handed off to its live replacement. */
  const replacementHandoffRef = useRef(false);
  const optimisticStreamIdsRef = useRef(new Set<string>());
  const createdStreamIdsRef = useRef(new Set<string>());
  /** Pending action whose tool-call content part hasn't rendered yet — retried
   *  on the next frame so a fast pause-before-render race still attaches. */
  const pendingActionRetryRef = useRef<number | null>(null);
  /** EVERY steer retry frame, not only the newest one. Several steers can be
   *  applied before their shared response placeholder renders; retaining one
   *  handle let the older chains outlive navigation/terminal cleanup and
   *  mutate a later generation that reused the same response id. */
  const steerRetryFramesRef = useRef<Set<number>>(new Set());
  /** EVERY outstanding label-retry frame, not a single handle: labels fire
   *  two events per slot (reservation, then fill), so concurrent retry
   *  chains are the norm — a single ref would let cleanup cancel only the
   *  newest chain while the others kept running for up to 120 frames and
   *  could apply a stale label to a replacement generation that reuses the
   *  same response id (edits do). */
  const activityLabelRetryFramesRef = useRef<Set<number>>(new Set());
  /**
   * Set once a SYNC has replaced the response with the server's
   * completion-local snapshot, which discards the prefix an edited
   * resubmission retained. From that point incoming indices are absolute and
   * `editPrefixLength` must no longer be applied — by run steps or labels.
   */
  const editPrefixClearedRef = useRef(false);
  const editPrefixFirstPartFoldedRef = useRef(false);
  /** Generation the cleared-prefix state above belongs to, so it is dropped
   *  when a new generation starts rather than when a subscribe happens to be
   *  live. Keyed by response message id — the stream id is the conversation
   *  id and is therefore shared by every generation within it. */
  const prefixStateGenerationIdRef = useRef<string | null>(null);

  const restoreQueuedSubmission = useRecoilCallback(
    ({ set }) =>
      (failedSubmission: TSubmission, expectedPredecessorCreatedAt?: number) => {
        const conversationId = failedSubmission.conversation?.conversationId;
        const origin = failedSubmission.queuedMessageOrigin as QueuedMessageOrigin | undefined;
        if (!conversationId || origin == null) {
          return;
        }
        set(store.queuedMessagesByConvoId(conversationId), (prev) =>
          canRestoreRecovery(
            jotaiStore.get(recoveryDispositionsFamily(conversationId)),
            origin.item,
          )
            ? insertQueuedOrigin(prev, origin, expectedPredecessorCreatedAt)
            : prev,
        );
      },
    [jotaiStore],
  );

  /** Removes the pending chip once its steer is injected (the inline content
   *  part becomes the durable record), and records the id so a 202 ACK that
   *  arrives AFTER the applied event drops its chip instead of re-minting it. */
  const resolveSteerChip = useRecoilCallback(
    ({ snapshot, set }) =>
      (
        conversationId: string,
        steerId: string,
        clientSteerId?: string,
        appliedPartQuotes?: string[],
      ): string[] => {
        const settledIds = clientSteerId ? [steerId, clientSteerId] : [steerId];
        /** A part applied by a pre-quotes server carries no quotes while the
         *  chip being settled may hold the only copy of the user's excerpts
         *  (its 202 was lost, so the ACK-echo restore never ran). Re-stage
         *  them before removal; `mergeRestagedQuotes` keeps this idempotent
         *  with the ACK path for the same excerpts. */
        if (appliedPartQuotes == null || appliedPartQuotes.length === 0) {
          const chips = snapshot
            .getLoadable(store.pendingSteersByConvoId(conversationId))
            .getValue();
          const droppedQuotes = chips.find(
            (steer) => settledIds.includes(steer.steerId) && (steer.quotes?.length ?? 0) > 0,
          )?.quotes;
          if (droppedQuotes != null && droppedQuotes.length > 0) {
            set(store.pendingQuotesByConvoId(conversationId), (prev) =>
              mergeRestagedQuotes(prev, droppedQuotes),
            );
          }
        }
        /** Ids seen by the durable set for the first time — the caller stamps
         *  these as live-applied only when it actually commits the inline
         *  part, so an abandoned placement (navigation away, placeholder never
         *  found) or a replayed event cannot arm a draw-in with no part
         *  mounting to consume it. */
        const alreadyApplied = snapshot
          .getLoadable(store.appliedSteerIdsByConvoId(conversationId))
          .getValue();
        const firstApplication = settledIds.filter((id) => !alreadyApplied.includes(id));
        set(store.appliedSteerIdsByConvoId(conversationId), (prev) =>
          appendAppliedSteerIds(prev, settledIds),
        );
        set(store.pendingSteersByConvoId(conversationId), (prev) =>
          prev.some((steer) => settledIds.includes(steer.steerId))
            ? prev.filter((steer) => !settledIds.includes(steer.steerId))
            : prev,
        );
        /** A terminal boundary may have re-homed this steer while its applied
         *  event was waiting for the response placeholder. The applied event
         *  is authoritative, so evict that recovery copy before it can be
         *  drained as a duplicate follow-up. */
        set(store.queuedMessagesByConvoId(conversationId), (prev) =>
          prev.some(
            (item) =>
              (item.recoverySteerId != null && settledIds.includes(item.recoverySteerId)) ||
              (item.recoveryClientSteerId != null &&
                settledIds.includes(item.recoveryClientSteerId)),
          )
            ? prev.filter(
                (item) =>
                  !(
                    (item.recoverySteerId != null && settledIds.includes(item.recoverySteerId)) ||
                    (item.recoveryClientSteerId != null &&
                      settledIds.includes(item.recoveryClientSteerId))
                  ),
              )
            : prev,
        );
        return firstApplication;
      },
    [],
  );

  /** Capability can change while the same generation resumes after HITL.
   * Patch labels in place; this event never removes/reorders a chip. */
  const updateSteerChips = useRecoilCallback(
    ({ set }) =>
      (event: TSteerUpdatedEvent) => {
        const byId = new Map<string, TSteerUpdatedEvent['steers'][number]>();
        for (const steer of event.steers) {
          byId.set(steer.steerId, steer);
          if (steer.clientSteerId) {
            byId.set(steer.clientSteerId, steer);
          }
        }
        const acceptedClientIds = event.steers.flatMap((steer) =>
          steer.clientSteerId ? [steer.clientSteerId] : [],
        );
        if (acceptedClientIds.length > 0) {
          set(store.acceptedSteerClientIdsByConvoId(event.conversationId), (prev) =>
            appendAppliedSteerIds(prev, acceptedClientIds),
          );
        }
        set(store.pendingSteersByConvoId(event.conversationId), (prev) => {
          let changed = false;
          const next = prev.map((steer) => {
            const update = byId.get(steer.steerId);
            if (update == null) {
              return steer;
            }
            const correlated =
              update.clientSteerId === steer.steerId && steer.steerId !== update.steerId;
            const base = correlated
              ? {
                  ...steer,
                  steerId: update.steerId,
                  clientSteerId: update.clientSteerId,
                  status: 'pending' as const,
                }
              : steer;
            if (update.preemptRevision < (base.preemptRevision ?? 0)) {
              changed ||= base !== steer;
              return base;
            }
            if (
              Boolean(base.preempt) === update.preempt &&
              base.preemptRevision === update.preemptRevision
            ) {
              changed ||= base !== steer;
              return base;
            }
            changed = true;
            if (update.preempt) {
              return {
                ...base,
                preempt: true,
                preemptRevision: update.preemptRevision,
              };
            }
            const { preempt: _preempt, ...ordinary } = base;
            return { ...ordinary, preemptRevision: update.preemptRevision };
          });
          return changed ? next : prev;
        });
      },
    [],
  );

  /** Replaces the chip list with the server's still-queued steers (reconnect).
   *  Local `failed` entries are kept so their text stays recoverable, and a
   *  reseeded chip keeps its quotes/skill picks (from the local chip, or the
   *  server item's persisted quotes when no chip survives). */
  const seedSteerChips = useRecoilCallback(
    ({ set }) =>
      (
        conversationId: string,
        steers: TPendingSteer[],
        generationCreatedAt?: number,
        generationProtocolVersion: GenerationProtocolVersion = 1,
      ) => {
        const acceptedClientIds = steers.flatMap((steer) =>
          steer.clientSteerId ? [steer.clientSteerId] : [],
        );
        if (acceptedClientIds.length > 0) {
          set(store.acceptedSteerClientIdsByConvoId(conversationId), (prev) =>
            appendAppliedSteerIds(prev, acceptedClientIds),
          );
        }
        set(store.pendingSteersByConvoId(conversationId), (prev) => {
          const chipById = new Map(prev.map((chip) => [chip.steerId, chip]));
          const claimedIds = new Set(
            steers.flatMap((steer) =>
              steer.clientSteerId ? [steer.steerId, steer.clientSteerId] : [steer.steerId],
            ),
          );
          return [
            ...steers.map((steer) => {
              const localChip =
                chipById.get(steer.steerId) ??
                (steer.clientSteerId ? chipById.get(steer.clientSteerId) : undefined);
              const keepLocalPreempt =
                (localChip?.preemptRevision ?? 0) > (steer.preemptRevision ?? 0);
              const chipGenerationCreatedAt = generationCreatedAt ?? localChip?.generationCreatedAt;
              const restoredFiles = hydrateFileDeliveryMetadata(
                steer.files,
                localChip?.files,
                fileMapRef.current,
              );
              return {
                steerId: steer.steerId,
                ...(steer.clientSteerId && { clientSteerId: steer.clientSteerId }),
                text: steer.text,
                status: 'pending' as const,
                createdAt: steer.createdAt ?? Date.now(),
                ...(restoredFiles && restoredFiles.length > 0 && { files: restoredFiles }),
                ...((keepLocalPreempt ? localChip?.preempt : steer.preempt) === true && {
                  preempt: true,
                }),
                ...((keepLocalPreempt ? localChip?.preemptRevision : steer.preemptRevision) !=
                  null && {
                  preemptRevision: keepLocalPreempt
                    ? localChip?.preemptRevision
                    : steer.preemptRevision,
                }),
                ...(localChip?.queuedOrigin && { queuedOrigin: localChip.queuedOrigin }),
                ...(chipGenerationCreatedAt != null && {
                  generationCreatedAt: chipGenerationCreatedAt,
                }),
                generationProtocolVersion,
                // The local chip carries skill picks the server never sees; a
                // fresh tab has no chip, so fall back to the server item's
                // persisted quotes rather than reseeding the chip without them.
                ...carriedSteerContext(localChip ?? steer),
              };
            }),
            ...prev.filter((steer) => steer.status === 'failed' && !claimedIds.has(steer.steerId)),
          ];
        });
      },
    [],
  );

  const settleAppliedSteerParts = useRecoilCallback(
    ({ snapshot, set }) =>
      (conversationId: string, values: unknown[] | undefined) => {
        const ids = collectAppliedSteerIds(values);
        if (ids.length === 0) {
          return;
        }
        const settled = new Set(ids);
        /** Chips settled by quote-less applied parts hold the only copy of
         *  their excerpts (a pre-quotes server injected the words bare) —
         *  re-stage them as composer chips before the removal below. */
        const droppedQuotes = collectDroppedSteerQuotes(
          values,
          snapshot.getLoadable(store.pendingSteersByConvoId(conversationId)).getValue(),
        );
        if (droppedQuotes.length > 0) {
          set(store.pendingQuotesByConvoId(conversationId), (prev) =>
            mergeRestagedQuotes(prev, droppedQuotes),
          );
        }
        set(store.appliedSteerIdsByConvoId(conversationId), (prev) =>
          appendAppliedSteerIds(prev, ids),
        );
        set(store.pendingSteersByConvoId(conversationId), (prev) =>
          prev.filter((steer) => !settled.has(steer.steerId)),
        );
      },
    [],
  );

  /** Converts steers that never reached an injection boundary into queued
   *  follow-up messages (reported on the run's final/abort event; the abort
   *  HTTP response consumes the same data as a fallback in useChatHelpers). */
  const convertSteersToQueued = useSteerConvert();

  /** Error events carry no `pendingSteers` payload (the server drops its copy
   *  on failure), but every acknowledged chip's text is local — convert them
   *  to queued follow-ups so the user's words survive a failed run. `sending`
   *  chips settle through their own POST callbacks (404 falls back to
   *  queue/send) and `failed` chips keep their manual controls. */
  const convertLocalSteersToQueued = useRecoilCallback(
    ({ snapshot }) =>
      (
        conversationId: string,
        options?: {
          claimParked?: boolean;
          excludeSteerIds?: Iterable<string>;
          generationProtocolVersion?: GenerationProtocolVersion;
        },
      ) => {
        const chips = snapshot.getLoadable(store.pendingSteersByConvoId(conversationId)).getValue();
        const excluded = new Set(options?.excludeSteerIds ?? []);
        const settled = chips
          .filter(
            (steer) =>
              steer.status === 'pending' &&
              !excluded.has(steer.steerId) &&
              (steer.clientSteerId == null || !excluded.has(steer.clientSteerId)),
          )
          .map((steer) => ({
            steerId: steer.steerId,
            ...(steer.clientSteerId && { clientSteerId: steer.clientSteerId }),
            text: steer.text,
            createdAt: steer.createdAt,
            ...(steer.files && steer.files.length > 0 && { files: steer.files }),
            ...(steer.queuedOrigin && { queuedOrigin: steer.queuedOrigin }),
          }));
        if (settled.length > 0) {
          convertSteersToQueued(conversationId, settled, {
            claimParked: options?.claimParked,
            generationProtocolVersion: options?.generationProtocolVersion,
          });
        }
      },
    [convertSteersToQueued],
  );

  /** Conversation ids are reused by successive agent turns. Keep the exact
   * live epoch beside the UI controls, and only clear it if the terminal event
   * still belongs to the epoch that installed it. */
  const updateActiveGenerationCreatedAt = useRecoilCallback(
    ({ snapshot, set }) =>
      (
        conversationId: string,
        next: number | null,
        expected?: number,
        generationProtocolVersion: GenerationProtocolVersion = 1,
      ): boolean => {
        const state = store.activeGenerationCreatedAtByConvoId(conversationId);
        if (expected != null && snapshot.getLoadable(state).getValue() !== expected) {
          return false;
        }
        set(state, next);
        set(
          store.activeGenerationProtocolVersionByConvoId(conversationId),
          next == null ? 1 : generationProtocolVersion,
        );
        return true;
      },
    [],
  );

  const setRunEnd = useSetRecoilState(store.runEndByIndex(runIndex));
  const setDrainAfterAbort = useSetRecoilState(store.drainAfterAbortByIndex(runIndex));
  const clearDrainAfterAbort = useCallback(
    (conversationId: string, generationCreatedAt?: number) => {
      if (generationCreatedAt == null) {
        return;
      }
      setDrainAfterAbort((armed) =>
        clearMatchingDrainAfterAbort(armed, conversationId, generationCreatedAt),
      );
    },
    [setDrainAfterAbort],
  );

  const {
    stepHandler: rawStepHandler,
    finalHandler,
    errorHandler,
    clearStepMaps,
    messageHandler,
    contentHandler,
    createdHandler,
    titleHandler,
    syncStepMessage,
    prunePtcTraces,
    attachmentHandler,
    resetContentHandler,
    flushPendingDeltas,
  } = useEventHandlers({
    setMessages,
    getMessages,
    setCompleted,
    isAddedRequest,
    runIndex,
    setConversation,
    setIsSubmitting,
    newConversation,
    setShowStopButton,
  });

  /**
   * Run steps and activity labels must resolve indices in ONE space, and the
   * resume SYNC boundary that invalidates the edit prefix is owned here — so
   * this transport stamps its cleared state onto every dispatched
   * submission. `useStepHandler` reads the flag (alongside the captured
   * `editPrefixLength`) instead of measuring the live
   * `initialResponse.content`, which SYNC replaces with the server's
   * completion-local snapshot.
   *
   * Only allocates once the prefix is actually cleared; before that, and on
   * the non-resumable transport, the submission passes through untouched.
   */
  const stepHandler = useCallback(
    (...[event, submission]: Parameters<typeof rawStepHandler>) => {
      const eventSubmission = editPrefixClearedRef.current
        ? ({ ...submission, editPrefixCleared: true } as EventSubmission)
        : submission;
      rawStepHandler(event, eventSubmission);
      if (eventSubmission.editPrefixFirstPartFolded === true) {
        editPrefixFirstPartFoldedRef.current = true;
      }
    },
    [rawStepHandler],
  );

  const { data: startupConfig } = useGetStartupConfig();
  const balanceQuery = useGetUserBalance({
    enabled: !!isAuthenticated && startupConfig?.balance?.enabled,
  });
  const {
    contextHandler,
    usageHandler,
    tapStream,
    tapContent,
    finalizeUsage,
    backfillUsage,
    resetLive,
    seedLive,
  } = useUsageHandler();

  /**
   * Subscribe to stream via SSE library (supports custom headers)
   * Follows same auth pattern as useSSE
   * @param isResume - If true, adds ?resume=true to trigger sync event from server
   */
  const subscribeToStream = useCallback(
    (
      currentStreamId: string,
      currentSubmission: TSubmission,
      isResume = false,
      generationCreatedAt?: number,
      generationProtocolVersion: GenerationProtocolVersion = 1,
      lifecycleSignal?: AbortSignal,
    ) => {
      /** Every effect owns one AbortSignal, while every reconnect owns one SSE
       * instance. Both identities matter: cleanup can close an attachment after
       * its async listener has already crossed an `await`, and a reconnect can
       * supersede an older attachment without changing the submission object.
       * The captured submission check is the final fence against a later
       * conversation installing its own submission in this pane. */
      if (lifecycleSignal?.aborted || submissionRef.current !== currentSubmission) {
        return;
      }
      const startedAsNewConversation = optimisticStreamIdsRef.current.has(currentStreamId);
      /** Terminal handlers below are fenced by this subscription and its generation.
       * Clear every key the same run may have occupied, including the temporary
       * new-chat key, so aborts and resumes from another tab cannot leave a stale
       * approval card beside an idle composer. */
      const clearPendingApprovalForTerminal = (conversationId?: string | null) => {
        const conversationIds = new Set<string>([
          currentStreamId,
          ...(conversationId ? [conversationId] : []),
          ...(currentSubmission.conversation?.conversationId
            ? [currentSubmission.conversation.conversationId]
            : []),
          ...(startedAsNewConversation ? [String(Constants.NEW_CONVO)] : []),
        ]);
        for (const id of conversationIds) {
          jotaiStore.set(pendingApprovalActionFamily(id), null);
        }
      };
      const clearAttachedGenerationCreatedAt = () => {
        updateActiveGenerationCreatedAt(currentStreamId, null, generationCreatedAt);
        if (startedAsNewConversation) {
          updateActiveGenerationCreatedAt(Constants.NEW_CONVO, null, generationCreatedAt);
        }
      };
      if (generationCreatedAt != null) {
        updateActiveGenerationCreatedAt(
          currentStreamId,
          generationCreatedAt,
          undefined,
          generationProtocolVersion,
        );
        /** Until CREATED moves the conversation context off `/c/new`, Stop and
         *  approval controls still read the placeholder key. Mirror the exact
         *  epoch there briefly; the server's user-wide fallback plus this fence
         *  can safely resolve the just-started job. */
        if (startedAsNewConversation) {
          updateActiveGenerationCreatedAt(
            Constants.NEW_CONVO,
            generationCreatedAt,
            undefined,
            generationProtocolVersion,
          );
        }
        setShowStopButton(true);
      } else {
        /** Generation-scoped mutations are unsafe until the server supplies
         *  the epoch they must fence against. Keep Stop hidden if an old or
         *  malformed response omitted it. */
        setShowStopButton(false);
      }
      /**
       * A NEW generation starts with its retained prefix intact, so the
       * cleared-prefix state from a previous one must not carry over — the
       * hook outlives any single submission, and a later edited resubmission
       * would otherwise dispatch with no offset and overwrite the content it
       * kept.
       *
       * Keyed on `clientRequestId`, the per-submission uuid. Each of the
       * narrower keys tried before it crossed a real boundary:
       *   - `isResume` — a submission whose POST succeeded but lost its
       *     response retries and returns `resumed: true`, so a NEW generation
       *     arrives in resume mode and skipped the reset.
       *   - the stream id — `request.js` sets `streamId = conversationId`, so
       *     every generation in a conversation shares it.
       *   - the response message id — editing an assistant response reuses
       *     that same id (`editedMessageId`), so re-editing one response
       *     produced the same key twice.
       * `clientRequestId` is minted per submission and forwarded unchanged on
       * retries, which is exactly "new per edit attempt, stable across
       * reconnects".
       */
      const generationId =
        currentSubmission.clientRequestId ??
        (currentSubmission.initialResponse as TMessage | undefined)?.messageId ??
        currentStreamId;
      if (prefixStateGenerationIdRef.current !== generationId) {
        prefixStateGenerationIdRef.current = generationId;
        editPrefixClearedRef.current = false;
        editPrefixFirstPartFoldedRef.current = false;
      }
      let { userMessage } = currentSubmission;
      let textIndex: number | null = null;
      let finalReceived = false;
      /** This subscription must never be revived. Set by the terminal
       *  recoveries that do not ride a FINAL or served-error frame — the 404
       *  and retry-ceiling reconciles both leave the attachment pointing at a
       *  stream the server no longer has — and by the dev-only navigation
       *  simulator below. `finalReceived` covers the frame-carried terminals. */
      let subscriptionRetired = false;
      const preCreatedStepEvents: Array<Parameters<typeof stepHandler>[0]> = [];
      const replayPreCreatedStepEvents = () => {
        if (!isCurrentSubscription() || preCreatedStepEvents.length === 0) {
          return;
        }

        const submission = { ...currentSubmission, userMessage } as EventSubmission;
        for (const event of preCreatedStepEvents.splice(0)) {
          stepHandler(event, submission);
        }
      };
      const applyPendingOAuthPrompt = (
        prompt: Agents.PendingMCPOAuthPrompt,
        submission: EventSubmission,
      ) => {
        const toolCall: Agents.ToolCall = {
          id: prompt.toolCallId,
          name: prompt.toolName,
          args: '',
          type: ToolCallTypes.TOOL_CALL,
        };
        const toolCallDelta: Agents.ToolCallChunk = {
          id: prompt.toolCallId,
          name: prompt.toolName,
          args: '',
        };
        stepHandler(
          {
            event: StepEvents.ON_RUN_STEP,
            data: {
              id: prompt.stepId,
              runId: prompt.runId,
              index: prompt.index,
              type: StepTypes.TOOL_CALLS,
              stepDetails: {
                type: StepTypes.TOOL_CALLS,
                tool_calls: [toolCall],
              },
            },
          },
          submission,
        );
        stepHandler(
          {
            event: StepEvents.ON_RUN_STEP_DELTA,
            data: {
              id: prompt.stepId,
              delta: {
                type: StepTypes.TOOL_CALLS,
                tool_calls: [toolCallDelta],
                auth: prompt.authURL,
                expires_at: prompt.expiresAt,
              },
            },
          },
          submission,
        );
      };

      /**
       * Maps a pending action onto the in-flight response message so the
       * approval / ask-user UI renders. Syncs the result back into the step
       * handler's map so subsequent deltas build on the approval-tagged content
       * rather than clobbering it.
       *
       * If the mapping is a no-op (the paused tool-call content part hasn't
       * rendered yet — a pause-before-render race), retry on subsequent frames
       * so the approval still attaches. `ask_user_question` always applies (it
       * appends a synthetic part), so only `tool_approval` ever retries.
       */
      // Keep retrying across frames (not just once): Recoil/React message updates from
      // the preceding created/step events are async and can take several frames under
      // load, so a single retry would drop a valid pause and leave the run with no
      // approval controls. Bounded so a genuinely-absent target can't spin forever.
      const PENDING_ACTION_MAX_RETRY_FRAMES = 120;
      const cancelSteerRetryFrames = () => {
        for (const frameId of steerRetryFramesRef.current) {
          cancelAnimationFrame(frameId);
        }
        steerRetryFramesRef.current.clear();
      };
      const applyPendingActionToMessages = (pendingAction: Agents.PendingAction, attempt = 0) => {
        if (!isCurrentSubscription()) {
          return;
        }
        const pendingConversationId =
          pendingAction.conversationId ??
          currentSubmission.conversation?.conversationId ??
          currentStreamId;
        jotaiStore.set(pendingApprovalActionFamily(pendingConversationId), pendingAction);
        const retryNextFrame = () => {
          if (attempt < PENDING_ACTION_MAX_RETRY_FRAMES) {
            pendingActionRetryRef.current = requestAnimationFrame(() => {
              if (isCurrentSubscription()) {
                applyPendingActionToMessages(pendingAction, attempt + 1);
              }
            });
          }
        };
        /** The pause card must attach to the same message state the stream
         * produced — apply any queued delta before reading the cache, or the
         * later flush would clobber the card (and `syncStepMessage` below
         * would sync a pre-delta copy). */
        flushPendingDeltas();
        const messages = getMessages() ?? [];
        const index = findPendingActionMessageIndex(messages, pendingAction);
        if (index < 0) {
          retryNextFrame();
          return;
        }
        const updated = applyPendingAction(messages[index], pendingAction);
        const changed = updated !== messages[index];
        if (changed) {
          const nextMessages = [...messages];
          nextMessages[index] = updated;
          setMessages(nextMessages);
          syncStepMessage(updated);
        }
        // A `tool_approval` pause can carry several `action_requests` whose tool-call
        // parts render on different frames; tagging only the first to arrive would leave
        // late siblings with no approval card, and the resume route then 400s the partial
        // batch ("every paused tool call must be decided"). Keep retrying (bounded) until
        // EVERY paused call is tagged. `ask_user_question` applies its single synthetic
        // part in one shot, so it only needs the original "did anything change" retry.
        if (pendingAction.payload.type === 'tool_approval') {
          const expected = pendingAction.payload.action_requests.length;
          if (countTaggedApprovalParts(updated, pendingAction.actionId) < expected) {
            retryNextFrame();
          }
        } else if (!changed) {
          retryNextFrame();
        }
      };

      /**
       * The identities this pane may be rendering the in-flight response under
       * before the first run step renames it to the server's pre-allocated id:
       * the submission's placeholder (updated on `created`) and the padded form
       * of the live user message. Read at call time — `created` reassigns both.
       */
      const livePlaceholderIds = () => [
        currentSubmission.initialResponse?.messageId,
        userMessage?.messageId ? `${userMessage.messageId}_` : undefined,
      ];

      /**
       * A regenerate seeds the renamed response from `submission.initialResponse`
       * rather than the store tail (an edited resubmission seeds from its
       * content), so a part committed to the placeholder only in the store would
       * be dropped by the first run step's rename. Keep the submission the step
       * handler receives in step with the placeholder this pane mutated.
       */
      const syncSubmissionPlaceholder = (updated: TMessage) => {
        if (updated.messageId !== currentSubmission.initialResponse?.messageId) {
          return;
        }
        currentSubmission = { ...currentSubmission, initialResponse: updated };
        submissionRef.current = currentSubmission;
      };

      /**
       * Edit-and-resubmit keeps the retained prefix on the client while the
       * server indexes only the NEW content, so every server-claimed index —
       * run steps (`useStepHandler`), labels and steers — shifts past it or
       * lands inside the prefix and overwrites kept content. The captured
       * length is used over the live array because a resume sync replaces
       * `initialResponse.content` with the server's completion-local snapshot.
       */
      const editPrefixLength = () =>
        currentSubmission.editedContent != null && !editPrefixClearedRef.current
          ? (currentSubmission.editPrefixLength ??
            currentSubmission.initialResponse?.content?.length ??
            0)
          : 0;

      /**
       * Places an injected steer part on the in-flight response message and
       * resolves its pending chip. Same bounded next-frame retry as pending
       * actions for the inject-before-render race (the assistant placeholder
       * can land a few frames after the created event under load).
       */
      const applySteerToMessages = (
        event: TSteerAppliedEvent,
        attempt = 0,
        liveSteerIds: string[] = [],
      ) => {
        if (!isCurrentSubscription()) {
          return;
        }
        const chipConvoId =
          event.conversationId ?? currentSubmission.conversation?.conversationId ?? currentStreamId;
        /** The server's applied event settles ownership immediately. Rendering
         *  the inline part can wait for React to mount the target, but leaving
         *  the chip pending during that wait lets an intervening error/final
         *  convert already-applied words into a duplicate queued message. */
        const firstApplicationIds =
          attempt === 0
            ? (resolveSteerChip(
                chipConvoId,
                event.steerId,
                event.clientSteerId,
                event.part?.quotes,
              ) ?? [])
            : liveSteerIds;
        const retryNextFrame = () => {
          if (attempt < PENDING_ACTION_MAX_RETRY_FRAMES) {
            const frameId = requestAnimationFrame(() => {
              steerRetryFramesRef.current.delete(frameId);
              if (isCurrentSubscription()) {
                applySteerToMessages(event, attempt + 1, firstApplicationIds);
              }
            });
            steerRetryFramesRef.current.add(frameId);
          }
        };
        /** Same boundary as pending actions: land queued deltas before the
         * steer part is placed and synced. */
        flushPendingDeltas();
        const messages = getMessages() ?? [];
        const index = findSteerMessageIndex(messages, event, livePlaceholderIds());
        if (index < 0) {
          retryNextFrame();
          return;
        }
        const prefixLength = editPrefixLength();
        const updated = applySteerPart(
          messages[index],
          typeof event.index === 'number' && prefixLength > 0
            ? { ...event, index: event.index + prefixLength }
            : event,
        );
        if (updated !== messages[index]) {
          /** Stamped only when the inline part is actually committed, in the
           *  same batch, so its first render sees the flag and plays the
           *  one-shot draw-in (`SteerPart` consumes the id on mount). A
           *  replayed event is referentially stable here and an abandoned
           *  placement never reaches this branch, so neither can strand a
           *  stale id that would animate a historical part on a later visit.
           *  Only the id the part RENDERS with (`part.steerId`) is stamped:
           *  the part consumes exactly that id, so a client alias would sit
           *  in the set forever as dead weight. */
          const renderedSteerId = event.part?.steerId ?? event.steerId;
          if (firstApplicationIds.includes(renderedSteerId)) {
            setLiveAppliedSteerIds((prev) => appendAppliedSteerIds(prev, [renderedSteerId]));
          }
          const nextMessages = [...messages];
          nextMessages[index] = updated;
          setMessages(nextMessages);
          syncStepMessage(updated);
          syncSubmissionPlaceholder(updated);
        }
      };

      /**
       * Places an activity-label part at its claimed content index on the
       * in-flight response message. Fires twice per block (the empty
       * reservation at batch end, the generated label on resolve);
       * `applyActivityLabelPart` is referentially stable on duplicate replays
       * and refuses to overwrite filled text with a stale placeholder. Same
       * bounded next-frame retry as steers for the inject-before-render race.
       */
      const applyActivityLabelToMessages = (event: TActivityLabelEvent, attempt = 0) => {
        if (!isCurrentSubscription()) {
          return;
        }
        const retryNextFrame = () => {
          if (attempt < PENDING_ACTION_MAX_RETRY_FRAMES) {
            const frameId = requestAnimationFrame(() => {
              activityLabelRetryFramesRef.current.delete(frameId);
              if (isCurrentSubscription()) {
                applyActivityLabelToMessages(event, attempt + 1);
              }
            });
            activityLabelRetryFramesRef.current.add(frameId);
          }
        };
        /** Same boundary as pending actions and steers: land queued deltas
         * before the label part is placed and synced, or the later flush
         * would clobber it (and `syncStepMessage` would sync a pre-delta
         * copy back into the step handler's authoritative map). */
        flushPendingDeltas();
        const messages = getMessages() ?? [];
        const index = findActivityLabelMessageIndex(messages, event, livePlaceholderIds());
        if (index < 0) {
          retryNextFrame();
          return;
        }
        /** Edit-and-resubmit replays the kept prefix into the response before
         *  the run starts, and the server indexes only the NEW content — so
         *  run steps offset by that prefix (`useStepHandler`). The label index
         *  is claimed in the same server-side space and needs the identical
         *  shift, or it lands inside the prefix and overwrites kept content.
         *
         *  Uses `editPrefixLength`, captured when the submission was built,
         *  for the same reason `useStepHandler` does: a resume sync replaces
         *  `initialResponse.content` with the server's completion-local
         *  snapshot, so its length no longer describes the retained prefix.
         *  Tool cards and the label heading them must land in one index
         *  space — a label shifting differently from its tools would overwrite
         *  another part, and a gap fill would miss its own reservation and
         *  leave the placeholder pending forever. */
        const prefixLength = editPrefixLength();
        const phasePart = event.part as TActivityLabelEvent['part'] & {
          activity_label_type?: 'phase';
          activity_start_index?: number;
          activity_end_index?: number;
        };
        let offsetEvent = event;
        if (prefixLength > 0) {
          let offsetPart: TActivityLabelEvent['part'] & {
            activity_label_type?: 'phase';
            activity_start_index?: number;
            activity_end_index?: number;
          } = phasePart;
          if (
            phasePart.activity_label_type === 'phase' &&
            typeof phasePart.activity_start_index === 'number'
          ) {
            let activityStartIndex = phasePart.activity_start_index + prefixLength;
            const foldedFirstPart = editPrefixFirstPartFoldedRef.current;
            const targetContent = messages[index]?.content;
            /** The step handler records an actual server-index-zero text/think
             *  merge. An empty +prefix slot is insufficient evidence because
             *  a delayed tool may not have materialized there yet. */
            if (
              phasePart.activity_start_index === 0 &&
              activityStartIndex > 0 &&
              foldedFirstPart &&
              targetContent?.[activityStartIndex - 1] != null
            ) {
              activityStartIndex -= 1;
            }
            offsetPart = {
              ...phasePart,
              activity_start_index: activityStartIndex,
              ...(typeof phasePart.activity_end_index === 'number' && {
                activity_end_index: offsetActivityPhaseBoundary(
                  phasePart.activity_end_index,
                  prefixLength,
                  foldedFirstPart,
                ),
              }),
            };
          }
          offsetEvent = {
            ...event,
            index: event.index + prefixLength,
            part: offsetPart,
          };
        }
        const updated = applyActivityLabelPart(messages[index], offsetEvent);
        if (updated !== messages[index]) {
          const nextMessages = [...messages];
          nextMessages[index] = updated;
          setMessages(nextMessages);
          syncStepMessage(updated);
          syncSubmissionPlaceholder(updated);
        }
      };

      /** Patches a generated title onto its existing reasoning part. */
      const applyReasoningLabelToMessages = (event: TReasoningLabelEvent, attempt = 0) => {
        if (!isCurrentSubscription()) {
          return;
        }
        const retryNextFrame = () => {
          if (attempt < PENDING_ACTION_MAX_RETRY_FRAMES) {
            const frameId = requestAnimationFrame(() => {
              activityLabelRetryFramesRef.current.delete(frameId);
              if (isCurrentSubscription()) {
                applyReasoningLabelToMessages(event, attempt + 1);
              }
            });
            activityLabelRetryFramesRef.current.add(frameId);
          }
        };
        flushPendingDeltas();
        const messages = getMessages() ?? [];
        const messageIndex = findReasoningLabelMessageIndex(messages, event);
        if (messageIndex < 0) {
          retryNextFrame();
          return;
        }
        const prefixLength = editPrefixLength();
        let contentIndex = event.index + prefixLength;
        if (
          prefixLength > 0 &&
          event.index === 0 &&
          editPrefixFirstPartFoldedRef.current &&
          messages[messageIndex]?.content?.[contentIndex - 1]?.type === ContentTypes.THINK
        ) {
          contentIndex -= 1;
        }
        const updated = applyReasoningLabel(messages[messageIndex], {
          ...event,
          index: contentIndex,
        });
        if (updated === messages[messageIndex]) {
          const part = messages[messageIndex]?.content?.[contentIndex];
          if (part?.type !== ContentTypes.THINK && attempt < PENDING_ACTION_MAX_RETRY_FRAMES) {
            retryNextFrame();
          }
          return;
        }
        const nextMessages = [...messages];
        nextMessages[messageIndex] = updated;
        setMessages(nextMessages);
        syncStepMessage(updated);
      };

      const baseUrl = `${apiBaseUrl()}/api/agents/chat/stream/${encodeURIComponent(currentStreamId)}`;
      const query = new URLSearchParams();
      if (isResume) {
        query.set('resume', 'true');
      }
      if (generationCreatedAt != null) {
        query.set('generationCreatedAt', String(generationCreatedAt));
      }
      query.set('generationProtocolVersion', String(GENERATION_PROTOCOL_VERSION));
      const queryString = query.toString();
      const url = queryString ? `${baseUrl}?${queryString}` : baseUrl;
      logger.log('ResumableSSE', 'Subscribing to stream:', url, { isResume });

      const sse = new SSE(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...generationProtocolHeaders(),
        },
        method: 'GET',
      });
      sseRef.current = sse;
      const isCurrentSubscription = () =>
        lifecycleSignal?.aborted !== true &&
        sseRef.current === sse &&
        submissionRef.current === currentSubmission;

      /**
       * Whether THIS connection was closed by this hook. The abort listener
       * used to infer that from `reconnectAttemptRef`, but that ref is shared
       * across the reconnect ladder and stays raised from the moment a retry is
       * scheduled until the replacement connection opens — so a user agent that
       * cancelled the replacement before it opened (the ordinary case when the
       * retry timer fires while the tab is still backgrounded) read as the
       * previous connection's deliberate close, and recovery stopped there.
       * Ownership is per connection, so the flag must be too.
       */
      let closedByUs = false;
      const closeStream = () => {
        closedByUs = true;
        sse.close();
      };

      let foregroundStatusCheckInFlight = false;
      const reattachOnForeground = () => {
        logger.log('ResumableSSE', 'Re-attaching stream on foreground');
        /** Any backoff still pending targets this same attachment, so returning
         *  to the app supersedes it rather than waiting the delay out; its
         *  callback finds a superseded subscription and does nothing. */
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
        reconnectAttemptRef.current = Math.max(reconnectAttemptRef.current, 1);
        closeStream();
        subscribeToStream(
          currentStreamId,
          currentSubmission,
          true,
          generationCreatedAt,
          generationProtocolVersion,
          lifecycleSignal,
        );
      };

      /**
       * A suspended page can lose its stream without the transport ever
       * reporting it. When a mobile browser freezes the tab, an intermediary
       * closes the response body underneath it, and XHR surfaces that as an
       * ordinary load — sse.js dispatches nothing for a body that simply ends,
       * so neither the error nor the abort recovery above ever runs. Nothing
       * else re-reads the conversation while the pane stays mounted, which is
       * why the response the run finished writing only appears after a reload.
       *
       * Some mobile WebViews leave the XHR marked OPEN even after the suspended
       * request stopped delivering events. In that case the durable run status
       * is the only authority that distinguishes a healthy live attachment from
       * a terminal one holding stale partial content. A terminal status forces
       * the same resume path as a closed transport; it returns the synthesized
       * terminal frame or 404 that reconciles persisted messages.
       */
      const handleForegroundReattach = () => {
        if (
          document.visibilityState !== 'visible' ||
          finalReceived ||
          subscriptionRetired ||
          replacementHandoffRef.current ||
          !isCurrentSubscription() ||
          !submissionRef.current
        ) {
          return;
        }

        if (sse.readyState === SSE.CLOSED) {
          reattachOnForeground();
          return;
        }

        if (foregroundStatusCheckInFlight) {
          return;
        }
        foregroundStatusCheckInFlight = true;
        const foregroundConvoId = currentSubmission.conversation?.conversationId ?? currentStreamId;
        void fetchStreamStatus(foregroundConvoId)
          .then((status) => {
            if (
              status.active !== false ||
              (status.createdAt != null &&
                generationCreatedAt != null &&
                status.createdAt !== generationCreatedAt) ||
              !isCurrentSubscription() ||
              finalReceived ||
              subscriptionRetired ||
              replacementHandoffRef.current ||
              document.visibilityState !== 'visible'
            ) {
              return;
            }
            logger.log(
              'ResumableSSE',
              'Apparently open stream is terminal - reconciling on foreground',
              { conversationId: foregroundConvoId, generationCreatedAt },
            );
            reattachOnForeground();
          })
          .catch((error) => {
            if (!isCurrentSubscription()) {
              return;
            }
            logger.warn('ResumableSSE', 'Could not verify stream on foreground', {
              conversationId: foregroundConvoId,
              generationCreatedAt,
              error,
            });
          })
          .finally(() => {
            foregroundStatusCheckInFlight = false;
          });
      };
      stopForegroundReattachRef.current?.();
      document.addEventListener('visibilitychange', handleForegroundReattach);
      stopForegroundReattachRef.current = () =>
        document.removeEventListener('visibilitychange', handleForegroundReattach);

      sse.addEventListener('open', () => {
        if (!isCurrentSubscription()) {
          return;
        }
        logger.log('ResumableSSE', 'Stream connected');
        setAbortScroll(false);
        // Restore UI state on successful connection (including reconnection)
        setIsSubmitting(true);
        setShowStopButton(generationCreatedAt != null);
        reconnectAttemptRef.current = 0;
      });

      sse.addEventListener('message', async (e: MessageEvent) => {
        try {
          if (!isCurrentSubscription()) {
            return;
          }
          const data = JSON.parse(e.data);
          if (finalReceived) {
            return;
          }

          if (data.final === true && data.reconcile === true) {
            if (
              generationProtocolVersion !== GENERATION_PROTOCOL_VERSION ||
              !supportsGenerationProtocolV2(data)
            ) {
              logger.warn('ResumableSSE', 'Ignoring unnegotiated lifecycle reconciliation frame');
              return;
            }
            // Synthesized lifecycle frames deliberately carry no ordinary
            // response payload. Reconcile durable history (or hand off to a
            // replacement epoch) instead of passing them to finalHandler.
            finalReceived = true;
            cancelSteerRetryFrames();
            void reconcileGenerationLifecycle(data);
            return;
          }

          if (data.final != null) {
            finalReceived = true;
            const finalConvoId =
              data.conversation?.conversationId ??
              currentSubmission.conversation?.conversationId ??
              currentStreamId;
            if (
              !(await authorizeTerminalTeardown(finalConvoId, 'FINAL')) ||
              !isCurrentSubscription()
            ) {
              return;
            }
            cancelSteerRetryFrames();
            if (reconnectTimeoutRef.current) {
              clearTimeout(reconnectTimeoutRef.current);
              reconnectTimeoutRef.current = null;
            }
            reconnectAttemptRef.current = 0;
            logger.log('ResumableSSE', 'Received FINAL event', {
              aborted: data.aborted,
              conversationId: data.conversation?.conversationId,
              hasResponseMessage: !!data.responseMessage,
            });
            clearPendingApprovalForTerminal(finalConvoId);
            clearComposerDrafts(runIndex, currentSubmission.conversation?.conversationId, {
              includeNewChatDraft:
                !currentSubmission.conversation?.conversationId ||
                currentSubmission.conversation.conversationId === Constants.NEW_CONVO ||
                optimisticStreamIdsRef.current.has(currentStreamId) ||
                isInitialNewConversation(currentSubmission),
            });
            // A steer-applied event may still be waiting for its next-frame
            // message target when FINAL arrives. Reconcile directly from the
            // authoritative final message before converting leftovers so a
            // late 202 ACK cannot resurrect (or queue) an already-applied steer.
            const finalAppliedSteerIds = new Set(
              collectAppliedSteerIds(data.responseMessage ? [data.responseMessage] : []),
            );
            settleAppliedSteerParts(
              finalConvoId,
              data.responseMessage ? [data.responseMessage] : undefined,
            );
            // Steers the run never injected ride the final event; convert them
            // to queued follow-ups before the run-end signal fires the drain
            // (also resets the applied-id set for the finished run).
            // `claimParked` reconciles the replayable parked copy of the same
            // steers; explicit dismissal or a persisted recovery removes it.
            convertSteersToQueued(
              finalConvoId,
              (generationProtocolVersion === 1 || supportsGenerationProtocolV2(data)) &&
                Array.isArray(data.pendingSteers)
                ? (data.pendingSteers as TPendingSteer[]).filter(
                    (steer) =>
                      !finalAppliedSteerIds.has(steer.steerId) &&
                      (steer.clientSteerId == null ||
                        !finalAppliedSteerIds.has(steer.clientSteerId)),
                  )
                : [],
              {
                claimParked: true,
                generationProtocolVersion,
              },
            );
            let finalHandled = false;
            try {
              finalHandler(data, currentSubmission as EventSubmission);
              finalHandled = true;
              finalizeUsage(data, { ...currentSubmission, userMessage });
            } catch (error) {
              logger.error('ResumableSSE', 'Error in finalHandler:', error);
              setIsSubmitting(false);
              setShowStopButton(false);
            }
            // One-shot run-end signal for the queue drain. Written AFTER
            // finalHandler so `isSubmitting` has flipped false by the time the
            // drain effect observes it (both land in the same Recoil batch).
            // An early-aborted FIRST turn keys under NEW_CONVO: finalHandler
            // restored /c/new, so the optimistic id would strand the queue.
            const runEndTarget = resolveRunEndTarget({
              conversationId: finalConvoId,
              earlyAbort: data.earlyAbort === true,
              startedAsNewConvo: optimisticStreamIdsRef.current.has(currentStreamId),
            });
            let finalOutcome: 'completed' | 'aborted' | 'error' = 'error';
            if (data.aborted === true || data.responseMessage?.unfinished === true) {
              finalOutcome = 'aborted';
            } else if (finalHandled) {
              finalOutcome = 'completed';
            }
            setRunEnd({
              conversationId: runEndTarget.conversationId,
              // A Stop that lands before completion can arrive as a final with
              // `unfinished: true` and no `aborted` flag (request.js's
              // wasAbortedBeforeComplete branch) — it must not auto-drain.
              outcome: finalOutcome,
              startedAsNewConvo: runEndTarget.startedAsNewConvo,
              endedAt: Date.now(),
              generationCreatedAt,
              ...(data.responseMessage?.messageId != null && {
                responseMessageId: data.responseMessage.messageId,
              }),
            });
            // Clear handler maps on stream completion to prevent memory leaks
            clearStepMaps();
            // Optimistically remove from active jobs
            removeActiveJob(currentStreamId);
            clearAttachedGenerationCreatedAt();
            (startupConfig?.balance?.enabled ?? false) && balanceQuery.refetch();
            closeStream();
            setStreamId(null);
            optimisticStreamIdsRef.current.delete(currentStreamId);
            createdStreamIdsRef.current.delete(currentStreamId);
            return;
          }

          if (data.created != null) {
            logger.log('ResumableSSE', 'Received CREATED event', {
              messageId: data.message?.messageId,
              conversationId: data.message?.conversationId,
            });
            createdStreamIdsRef.current.add(currentStreamId);
            if (startedAsNewConversation) {
              updateActiveGenerationCreatedAt(Constants.NEW_CONVO, null, generationCreatedAt);
            }
            const runId = v4();
            setActiveRunId(runId);
            userMessage = {
              ...userMessage,
              ...data.message,
              overrideParentMessageId: userMessage.overrideParentMessageId,
            };
            const createdInitialResponse = buildCreatedInitialResponse({
              initialResponse: currentSubmission.initialResponse as TMessage,
              userMessage,
              isRegenerate: currentSubmission.isRegenerate,
            });
            currentSubmission = {
              ...currentSubmission,
              userMessage,
              initialResponse: createdInitialResponse,
            };
            submissionRef.current = currentSubmission;
            createdHandler(data, currentSubmission as EventSubmission);
            replayPreCreatedStepEvents();
            return;
          }

          if (data.event === 'attachment' && data.data) {
            attachmentHandler({
              data: data.data,
              submission: currentSubmission as EventSubmission,
            });
            return;
          }

          if (data.event === 'title') {
            titleHandler(data);
            return;
          }

          if (data.event === UsageEvents.ON_CONTEXT_USAGE) {
            contextHandler(data.data, { ...currentSubmission, userMessage });
            return;
          }

          if (data.event === UsageEvents.ON_TOKEN_USAGE) {
            usageHandler(data.data, { ...currentSubmission, userMessage });
            return;
          }

          if (data.event === ApprovalEvents.ON_PENDING_ACTION) {
            applyPendingActionToMessages(data.data as Agents.PendingAction);
            setIsSubmitting(true);
            return;
          }

          if (data.event === SteerEvents.ON_STEER_APPLIED) {
            applySteerToMessages(data.data as TSteerAppliedEvent);
            return;
          }

          if (data.event === SteerEvents.ON_STEER_UPDATED) {
            updateSteerChips(data.data as TSteerUpdatedEvent);
            return;
          }

          if (data.event === ActivityLabelEvents.ON_ACTIVITY_LABEL) {
            applyActivityLabelToMessages(data.data as TActivityLabelEvent);
            return;
          }

          if (data.event === ReasoningLabelEvents.ON_REASONING_LABEL) {
            applyReasoningLabelToMessages(data.data as TReasoningLabelEvent);
            return;
          }

          if (data.event === ReasoningLabelEvents.ON_REASONING_LABEL_ATTEMPT) {
            return;
          }

          if (data.event != null) {
            if (
              data.event === StepEvents.ON_MESSAGE_DELTA ||
              data.event === StepEvents.ON_REASONING_DELTA
            ) {
              tapStream(data.data, { ...currentSubmission, userMessage });
            }
            if (!isResume && !createdStreamIdsRef.current.has(currentStreamId)) {
              if (isOAuthStepEvent(data)) {
                preCreatedStepEvents.push(data);
                stepHandler(data, { ...currentSubmission, userMessage } as EventSubmission);
                return;
              }
              preCreatedStepEvents.push(data);
              return;
            }
            stepHandler(data, { ...currentSubmission, userMessage } as EventSubmission);
            return;
          }

          if (data.sync != null) {
            logger.log('ResumableSSE', 'SYNC received', {
              runSteps: data.resumeState?.runSteps?.length ?? 0,
              pendingEvents: data.pendingEvents?.length ?? 0,
            });

            const runId = v4();
            setActiveRunId(runId);
            /** Keep the current run's preliminary id long enough to replace that optimistic
             *  row in place if this snapshot assigns its durable response id. */
            const preliminaryResponseMessageId = currentSubmission.initialResponse?.messageId;
            const currentUserMessageId = currentSubmission.userMessage?.messageId;
            const preliminaryUserMessageId =
              currentUserMessageId &&
              (currentSubmission.initialResponse?.parentMessageId === currentUserMessageId ||
                preliminaryResponseMessageId === `${currentUserMessageId}_`)
                ? currentUserMessageId
                : undefined;
            const resumeSubmission = buildResumeEventSubmission(
              currentSubmission,
              userMessage,
              data.resumeState,
            );
            currentSubmission = resumeSubmission;
            submissionRef.current = resumeSubmission;
            userMessage = resumeSubmission.userMessage;
            /**
             * Totals rebuild from the persisted backfill at sync. Replayed or
             * gap usage events already represented in the snapshot are skipped
             * via multiset matching; events that raced past the snapshot read
             * still fold so multi-call runs don't undercount.
             */
            /** Fold the run's persisted usage; events also replayed below are
             *  deduped by (runId, seq) inside the handler, so prior prompts in
             *  this conversation keep their usage and gap events still count */
            backfillUsage(data.resumeState?.collectedUsage ?? [], resumeSubmission);
            if (data.resumeState?.contextUsage) {
              /** Already reconciled to the call's real prompt tokens server-side
               *  (GenerationJobManager.persistTokenUsage) when the snapshot's call
               *  completed, so install it as-is — no client backfill reconcile. */
              contextHandler(data.resumeState.contextUsage, resumeSubmission);
            }
            /** Output streamed before this resume is not re-delivered as deltas
             *  — estimate it from the trailing aggregated content. This is
             *  needed even with a snapshot: the snapshot is pre-invoke, so the
             *  in-flight output it precedes rides on the live estimate.
             *  countTrailingOutputChars only counts output at the very end (0
             *  when paused at a tool call), so a snapshot's budget is never
             *  double-counted. */
            seedLive(
              countTrailingOutputChars(data.resumeState?.aggregatedContent),
              resumeSubmission,
            );

            const pendingOAuthPrompts = data.resumeState?.pendingOAuthPrompts ?? [];
            const pendingOAuthStepIds = new Set(pendingOAuthPrompts.map((prompt) => prompt.stepId));
            if (data.resumeState?.runSteps) {
              for (const runStep of data.resumeState.runSteps) {
                if (pendingOAuthStepIds.has(runStep.id)) {
                  continue;
                }
                stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, resumeSubmission);
              }
            }

            if (data.resumeState?.aggregatedContent && userMessage?.messageId) {
              const messages = getMessages() ?? [];
              const userMsgId = userMessage.messageId;
              const hasResumedContent = data.resumeState.aggregatedContent.length > 0;
              const responseId = resumeSubmission.initialResponse.messageId;
              const messageIndexes = getResumeMessageIndexes(
                messages,
                userMsgId,
                responseId,
                preliminaryUserMessageId,
                preliminaryResponseMessageId,
              );
              const responseIdx =
                messageIndexes.responseIndex >= 0
                  ? messageIndexes.responseIndex
                  : messageIndexes.preliminaryResponseIndex;

              logger.log('ResumableSSE', 'SYNC update', {
                userMsgId,
                responseId,
                responseIdx,
                foundMessageId: responseIdx >= 0 ? messages[responseIdx]?.messageId : null,
                messagesCount: messages.length,
                aggregatedContentLength: data.resumeState.aggregatedContent?.length,
              });

              if (responseIdx >= 0) {
                const oldContent = messages[responseIdx]?.content;
                /** An EMPTY resume snapshot is not authoritative over content we already loaded
                 *  for the SAME generation-owned response: assigning it would erase that content
                 *  and leave a bare cursor. Require an existing content array so it is never
                 *  swapped for `undefined`. */
                const preserveLoadedContent =
                  !hasResumedContent && Array.isArray(oldContent) && oldContent.length > 0;
                /**
                 * Replacing the response with `aggregatedContent` drops the
                 * prefix an edited resubmission had retained: the snapshot is
                 * completion-local, indexed from zero. Every later event must
                 * therefore stop offsetting, or it writes past the end of the
                 * shorter array — for an activity label that means the fill
                 * misses its own reservation and the placeholder never
                 * resolves. Preserving `oldContent` keeps the prefix, and with
                 * it the offset. Run steps and labels both read this.
                 */
                if (!preserveLoadedContent) {
                  editPrefixClearedRef.current = true;
                }
                const responseMessage = {
                  ...resumeSubmission.initialResponse,
                  ...messages[responseIdx],
                  messageId: responseId,
                  parentMessageId: userMsgId,
                  content: preserveLoadedContent ? oldContent : data.resumeState.aggregatedContent,
                  sender: messages[responseIdx]?.sender ?? resumeSubmission.initialResponse.sender,
                  iconURL: preferDefinedString(
                    messages[responseIdx]?.iconURL,
                    resumeSubmission.initialResponse.iconURL ?? data.resumeState.iconURL,
                  ),
                  model: preferDefinedString(
                    messages[responseIdx]?.model,
                    resumeSubmission.initialResponse.model ?? data.resumeState.model,
                  ),
                } as TMessage;
                const updated = mergeResumeMessages(
                  messages,
                  userMessage,
                  responseMessage,
                  messageIndexes,
                  resumeSubmission.compact === true,
                );
                logger.log('ResumableSSE', 'SYNC updating message', {
                  messageId: responseMessage.messageId,
                  oldContentLength: Array.isArray(oldContent) ? oldContent.length : 0,
                  newContentLength: data.resumeState.aggregatedContent?.length,
                  preservedExistingContent: preserveLoadedContent,
                });
                setMessages(updated);
                resetContentHandler();
                syncStepMessage(responseMessage);
                logger.log('ResumableSSE', 'SYNC complete, handlers synced');
              } else {
                /** Same reasoning as the matched branch above: this row is
                 *  built straight from the server's completion-local
                 *  `aggregatedContent`, so it holds no retained prefix and
                 *  later steps and labels must stop offsetting. Setting it
                 *  only in the matched branch left this path adding an offset
                 *  to indices that were already absolute. */
                editPrefixClearedRef.current = true;
                const newMessage = {
                  ...resumeSubmission.initialResponse,
                  messageId: responseId,
                  parentMessageId: userMsgId,
                  content: data.resumeState.aggregatedContent,
                  isCreatedByUser: false,
                } as TMessage;
                setMessages(
                  mergeResumeMessages(
                    messages,
                    userMessage,
                    newMessage,
                    messageIndexes,
                    resumeSubmission.compact === true,
                  ),
                );
                resetContentHandler();
                syncStepMessage(newMessage);
              }
            }

            for (const prompt of pendingOAuthPrompts) {
              applyPendingOAuthPrompt(prompt, resumeSubmission);
            }

            /**
             * Re-pause on reconnect: the run is parked on a human-review
             * interrupt. Re-apply the pending action so the approval / ask-user
             * controls render after a reload or dropped connection.
             */
            if (data.resumeState?.pendingAction) {
              applyPendingActionToMessages(data.resumeState.pendingAction as Agents.PendingAction);
            }

            /**
             * Re-seed steer chips from the server's still-queued steers.
             * Injected steers are already inside `aggregatedContent`, so this
             * covers exactly the remainder a reloading client can't know about.
             */
            // Always reconcile against the server's still-queued list: a steer
            // applied while this client was disconnected is absent here (its
            // inline part rides aggregatedContent instead), so an EMPTY list
            // must clear stale local pending chips, not leave them stranded.
            const steerConvoId = currentSubmission.conversation?.conversationId ?? currentStreamId;
            seedSteerChips(
              steerConvoId,
              (data.resumeState?.pendingSteers ?? []) as TPendingSteer[],
              generationCreatedAt,
              generationProtocolVersion,
            );
            // Seed first, then remove anything already represented in the
            // authoritative content. Reversing this order can re-mint a stale
            // server snapshot entry after it was just settled.
            settleAppliedSteerParts(
              steerConvoId,
              data.resumeState?.aggregatedContent as unknown[] | undefined,
            );

            if (data.resumeState?.titleEvent) {
              titleHandler(data.resumeState.titleEvent);
            }

            /** PTC inner calls are not content parts, so the resume snapshot
             *  can't rebuild them and a settling event lost in this gap is
             *  never replayed. Mark rows still `running` as interrupted rather
             *  than leave a spinner that never resolves — and rather than drop
             *  them, since a call still executing across the reconnect settles
             *  normally on the restored stream and updates its row in place. */
            prunePtcTraces();

            if (data.resumeState?.replayEvents?.length > 0) {
              logger.log(
                'ResumableSSE',
                `Replaying ${data.resumeState.replayEvents.length} resume events`,
              );
              for (const replayEvent of data.resumeState.replayEvents) {
                const replayStepId = getStepEventId(replayEvent);
                if (
                  replayStepId != null &&
                  pendingOAuthStepIds.has(replayStepId) &&
                  isOAuthStepEvent(replayEvent)
                ) {
                  continue;
                }
                if (replayEvent.event === UsageEvents.ON_CONTEXT_USAGE) {
                  contextHandler(replayEvent.data, resumeSubmission);
                } else if (replayEvent.event === UsageEvents.ON_TOKEN_USAGE) {
                  usageHandler(replayEvent.data, resumeSubmission);
                } else if (replayEvent.event === ApprovalEvents.ON_PENDING_ACTION) {
                  // A pause that landed after the resume snapshot must still render its
                  // controls (mirror the live handler), not fall through to stepHandler.
                  applyPendingActionToMessages(replayEvent.data as Agents.PendingAction);
                } else if (replayEvent.event === SteerEvents.ON_STEER_APPLIED) {
                  applySteerToMessages(replayEvent.data as TSteerAppliedEvent);
                } else if (replayEvent.event === SteerEvents.ON_STEER_UPDATED) {
                  updateSteerChips(replayEvent.data as TSteerUpdatedEvent);
                } else if (replayEvent.event === ActivityLabelEvents.ON_ACTIVITY_LABEL) {
                  applyActivityLabelToMessages(replayEvent.data as TActivityLabelEvent);
                } else if (replayEvent.event === ReasoningLabelEvents.ON_REASONING_LABEL) {
                  applyReasoningLabelToMessages(replayEvent.data as TReasoningLabelEvent);
                } else if (replayEvent.event === ReasoningLabelEvents.ON_REASONING_LABEL_ATTEMPT) {
                  // Durable provider-call budget reservations never render.
                } else if (replayEvent.event != null) {
                  if (
                    replayEvent.event === StepEvents.ON_MESSAGE_DELTA ||
                    replayEvent.event === StepEvents.ON_REASONING_DELTA
                  ) {
                    tapStream(replayEvent.data, resumeSubmission);
                  }
                  stepHandler(replayEvent, resumeSubmission);
                }
              }
            }

            if (data.pendingEvents?.length > 0) {
              logger.log('ResumableSSE', `Replaying ${data.pendingEvents.length} pending events`);
              for (const pendingEvent of data.pendingEvents) {
                if (pendingEvent.event === 'title') {
                  titleHandler(pendingEvent);
                } else if (pendingEvent.event === UsageEvents.ON_CONTEXT_USAGE) {
                  contextHandler(pendingEvent.data, resumeSubmission);
                } else if (pendingEvent.event === UsageEvents.ON_TOKEN_USAGE) {
                  usageHandler(pendingEvent.data, resumeSubmission);
                } else if (pendingEvent.event === ApprovalEvents.ON_PENDING_ACTION) {
                  // In-memory mode can surface a pause that landed between getResumeState()
                  // and the subscription here; route it to the same handler as a live event
                  // so the approval / ask-user controls render (else the stream sits paused
                  // with no UI until a full status reload).
                  applyPendingActionToMessages(pendingEvent.data as Agents.PendingAction);
                } else if (pendingEvent.event === SteerEvents.ON_STEER_APPLIED) {
                  applySteerToMessages(pendingEvent.data as TSteerAppliedEvent);
                } else if (pendingEvent.event === SteerEvents.ON_STEER_UPDATED) {
                  updateSteerChips(pendingEvent.data as TSteerUpdatedEvent);
                } else if (pendingEvent.event === ActivityLabelEvents.ON_ACTIVITY_LABEL) {
                  applyActivityLabelToMessages(pendingEvent.data as TActivityLabelEvent);
                } else if (pendingEvent.event === ReasoningLabelEvents.ON_REASONING_LABEL) {
                  applyReasoningLabelToMessages(pendingEvent.data as TReasoningLabelEvent);
                } else if (pendingEvent.event === ReasoningLabelEvents.ON_REASONING_LABEL_ATTEMPT) {
                  // Durable provider-call budget reservations never render.
                } else if (pendingEvent.event != null) {
                  if (
                    pendingEvent.event === StepEvents.ON_MESSAGE_DELTA ||
                    pendingEvent.event === StepEvents.ON_REASONING_DELTA
                  ) {
                    tapStream(pendingEvent.data, resumeSubmission);
                  }
                  stepHandler(pendingEvent, resumeSubmission);
                } else if (pendingEvent.type != null) {
                  /** Gap output streamed past the resume snapshot must reach the
                   *  live estimate too, not just the message UI */
                  tapContent(pendingEvent.text, resumeSubmission);
                  contentHandler({ data: pendingEvent, submission: resumeSubmission });
                }
              }
            }

            setIsSubmitting(true);
            setShowStopButton(generationCreatedAt != null);
            return;
          }

          if (data.type != null) {
            const { text, index } = data;
            if (text != null && index !== textIndex) {
              textIndex = index;
            }
            tapContent(text, { ...currentSubmission, userMessage });
            contentHandler({ data, submission: currentSubmission as EventSubmission });
            return;
          }

          if (data.message != null) {
            const text = data.text ?? data.response;
            const initialResponse = {
              ...(currentSubmission.initialResponse as TMessage),
              parentMessageId: data.parentMessageId,
              messageId: data.messageId,
            };
            /** Legacy non-agent streams send cumulative text here — feed the
             *  live estimate like the content path above */
            tapContent(text, { ...currentSubmission, userMessage });
            messageHandler(text, { ...currentSubmission, userMessage, initialResponse });
          }
        } catch (error) {
          logger.error('ResumableSSE', 'Error processing message:', error);
        }
      });

      async function handoffToReplacement(
        conversationId: string,
        knownStatus?: Awaited<ReturnType<typeof fetchStreamStatus>>,
      ): Promise<boolean> {
        if (!isCurrentSubscription() || generationProtocolVersion !== GENERATION_PROTOCOL_VERSION) {
          return false;
        }
        let replacementStatus = knownStatus;
        if (replacementStatus == null) {
          try {
            // Deliberately unfenced: this read discovers the newer generation
            // after the epoch-fenced SSE endpoint rejects the stale attachment.
            replacementStatus = await fetchStreamStatus(conversationId);
            if (!isCurrentSubscription()) {
              return false;
            }
          } catch (error) {
            if (!isCurrentSubscription()) {
              return false;
            }
            logger.warn('ResumableSSE', 'Could not inspect replacement generation', {
              conversationId,
              generationCreatedAt,
              error,
            });
            return false;
          }
        }

        if (
          !supportsGenerationProtocolV2(replacementStatus) ||
          replacementStatus.active !== true ||
          !replacementStatus.streamId ||
          replacementStatus.createdAt == null ||
          replacementStatus.createdAt === generationCreatedAt
        ) {
          return false;
        }

        logger.log('ResumableSSE', 'Handing stale attachment to replacement generation', {
          conversationId,
          staleCreatedAt: generationCreatedAt,
          replacementCreatedAt: replacementStatus.createdAt,
        });
        replacementHandoffRef.current = true;
        cancelSteerRetryFrames();
        closeStream();
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
        queryClient.setQueryData(streamStatusQueryKey(conversationId), {
          ...replacementStatus,
          generationHandoff: true,
        });
        updateActiveGenerationCreatedAt(
          conversationId,
          replacementStatus.createdAt,
          undefined,
          GENERATION_PROTOCOL_VERSION,
        );
        if (startedAsNewConversation) {
          updateActiveGenerationCreatedAt(
            Constants.NEW_CONVO,
            replacementStatus.createdAt,
            undefined,
            GENERATION_PROTOCOL_VERSION,
          );
        }
        addActiveJob(replacementStatus.streamId);
        seedSteerChips(
          conversationId,
          (replacementStatus.resumeState?.pendingSteers ?? []) as TPendingSteer[],
          replacementStatus.createdAt,
          GENERATION_PROTOCOL_VERSION,
        );
        settleAppliedSteerParts(
          conversationId,
          replacementStatus.resumeState?.aggregatedContent ?? replacementStatus.aggregatedContent,
        );
        if (replacementStatus.pendingAction ?? replacementStatus.resumeState?.pendingAction) {
          applyPendingActionToMessages(
            (replacementStatus.pendingAction ??
              replacementStatus.resumeState?.pendingAction) as Agents.PendingAction,
          );
        }
        resetLive({ ...currentSubmission, userMessage });
        clearStepMaps();
        reconnectAttemptRef.current = 0;
        submissionRef.current = null;
        setIsSubmitting(true);
        setShowStopButton(true);
        setSubmission(null);
        return true;
      }

      /**
       * A terminal frame proves only what happened on this SSE attachment. A
       * fresh status read is the authority for whether terminal UI teardown is
       * safe: a newer epoch may already own the conversation, while the exact
       * epoch can still be active despite a racing FINAL/error frame.
       */
      function retryFencedTerminalAttachment(reason: string): void {
        if (!isCurrentSubscription()) {
          return;
        }
        logger.warn('ResumableSSE', 'Deferring terminal teardown and retrying fenced attachment', {
          conversationId: currentSubmission.conversation?.conversationId ?? currentStreamId,
          generationCreatedAt,
          reason,
        });
        reconnectAttemptRef.current = Math.max(reconnectAttemptRef.current, 1);
        closeStream();
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
        }
        reconnectTimeoutRef.current = setTimeout(() => {
          if (isCurrentSubscription() && submissionRef.current) {
            subscribeToStream(
              currentStreamId,
              submissionRef.current,
              true,
              generationCreatedAt,
              generationProtocolVersion,
              lifecycleSignal,
            );
          }
        }, 250);
      }

      async function authorizeTerminalTeardown(
        conversationId: string,
        terminalKind: 'FINAL' | 'error',
      ): Promise<boolean> {
        if (!isCurrentSubscription()) {
          return false;
        }
        if (generationProtocolVersion !== GENERATION_PROTOCOL_VERSION) {
          return true;
        }

        let status: Awaited<ReturnType<typeof fetchStreamStatus>>;
        try {
          status = await fetchStreamStatus(conversationId);
          if (!isCurrentSubscription()) {
            return false;
          }
        } catch (error) {
          if (!isCurrentSubscription()) {
            return false;
          }
          logger.warn('ResumableSSE', `Could not verify ${terminalKind} generation status`, {
            conversationId,
            generationCreatedAt,
            error,
          });
          retryFencedTerminalAttachment(`${terminalKind.toLowerCase()} status unavailable`);
          return false;
        }

        if (!supportsGenerationProtocolV2(status)) {
          retryFencedTerminalAttachment(`${terminalKind.toLowerCase()} status was unnegotiated`);
          return false;
        }

        if (status.active === true) {
          const handedOff =
            status.createdAt != null &&
            generationCreatedAt != null &&
            status.createdAt !== generationCreatedAt &&
            (await handoffToReplacement(conversationId, status));
          if (!isCurrentSubscription()) {
            return false;
          }
          if (handedOff) {
            return false;
          }
          retryFencedTerminalAttachment(
            status.createdAt == null || generationCreatedAt == null
              ? `${terminalKind.toLowerCase()} status epoch was inconclusive`
              : `${terminalKind.toLowerCase()} generation remains active`,
          );
          return false;
        }

        if (status.active !== false) {
          retryFencedTerminalAttachment(`${terminalKind.toLowerCase()} status was inconclusive`);
          return false;
        }

        return true;
      }

      const reconcileGenerationLifecycle = async (event: {
        reconcileReason?: string;
        terminalStatus?: 'complete' | 'error' | 'aborted';
        generationCreatedAt?: number;
        conversation?: { conversationId?: string };
      }): Promise<void> => {
        if (!isCurrentSubscription()) {
          return;
        }
        const reconciliationConvoId =
          event.conversation?.conversationId ??
          currentSubmission.conversation?.conversationId ??
          currentStreamId;
        if (
          generationCreatedAt != null &&
          event.generationCreatedAt != null &&
          event.generationCreatedAt !== generationCreatedAt
        ) {
          return;
        }

        if (event.reconcileReason === 'generation_replaced') {
          const handedOff = await handoffToReplacement(reconciliationConvoId);
          if (!isCurrentSubscription()) {
            return;
          }
          if (handedOff) {
            return;
          }
          // Replacement visibility can lag its notification by a round trip.
          // Retry the stale epoch; the fenced HTTP endpoint will return the
          // dedicated replacement response as soon as the new job is visible.
          reconnectAttemptRef.current = Math.max(reconnectAttemptRef.current, 1);
          closeStream();
          reconnectTimeoutRef.current = setTimeout(() => {
            if (isCurrentSubscription() && submissionRef.current) {
              subscribeToStream(
                currentStreamId,
                submissionRef.current,
                true,
                generationCreatedAt,
                generationProtocolVersion,
                lifecycleSignal,
              );
            }
          }, 250);
          return;
        }

        reconnectAttemptRef.current = Math.max(reconnectAttemptRef.current, 1);
        closeStream();
        clearStepMaps();
        let persistedMessages: TMessage[] | undefined;
        const messageQueryKey = [QueryKeys.messages, reconciliationConvoId] as const;
        try {
          /** Force a fetch through the already-registered messages query and
           *  use its returned value. Merely awaiting invalidateQueries and
           *  reading the cache can mistake stale pre-run history for a
           *  successful reconciliation because React Query normally swallows
           *  refetch errors. */
          await queryClient.invalidateQueries({
            queryKey: messageQueryKey,
            refetchType: 'none',
          });
          if (!isCurrentSubscription()) {
            return;
          }
          const fetched = await queryClient.fetchQuery<TMessage[]>({
            queryKey: messageQueryKey,
          });
          if (!isCurrentSubscription()) {
            return;
          }
          if (Array.isArray(fetched)) {
            persistedMessages = fetched;
          }
        } catch (error) {
          if (!isCurrentSubscription()) {
            return;
          }
          logger.warn('ResumableSSE', 'Could not refetch synthesized terminal state', {
            conversationId: reconciliationConvoId,
            error,
          });
        }
        try {
          await queryClient.invalidateQueries({
            queryKey: [QueryKeys.conversation, reconciliationConvoId],
            refetchType: 'all',
          });
          if (!isCurrentSubscription()) {
            return;
          }
          await invalidateConversationLists(queryClient);
          if (!isCurrentSubscription()) {
            return;
          }
          await queryClient.invalidateQueries({ queryKey: [QueryKeys.pinnedConversations] });
          if (!isCurrentSubscription()) {
            return;
          }
        } catch (error) {
          if (!isCurrentSubscription()) {
            return;
          }
          logger.warn('ResumableSSE', 'Could not refresh synthesized conversation metadata', {
            conversationId: reconciliationConvoId,
            error,
          });
        }

        let status: Awaited<ReturnType<typeof fetchStreamStatus>> | undefined;
        try {
          status = await fetchStreamStatus(reconciliationConvoId);
          if (!isCurrentSubscription()) {
            return;
          }
        } catch (error) {
          if (!isCurrentSubscription()) {
            return;
          }
          logger.warn('ResumableSSE', 'Could not inspect synthesized terminal status', {
            conversationId: reconciliationConvoId,
            error,
          });
        }
        if (status != null && !supportsGenerationProtocolV2(status)) {
          /** A v2 control frame cannot be reconciled with a legacy status
           * snapshot (for example during a rolling deploy). Preserve the
           * attachment and retry the exact fenced generation. */
          reconnectTimeoutRef.current = setTimeout(() => {
            if (isCurrentSubscription() && submissionRef.current) {
              subscribeToStream(
                currentStreamId,
                submissionRef.current,
                true,
                generationCreatedAt,
                generationProtocolVersion,
                lifecycleSignal,
              );
            }
          }, 250);
          return;
        }
        if (
          status?.active === true &&
          status.createdAt != null &&
          (generationCreatedAt == null || status.createdAt !== generationCreatedAt)
        ) {
          const handedOff = await handoffToReplacement(reconciliationConvoId, status);
          if (!isCurrentSubscription()) {
            return;
          }
          if (handedOff) {
            return;
          }
        }
        if (
          status?.active === true &&
          (generationCreatedAt == null || status.createdAt === generationCreatedAt)
        ) {
          // Durable state still calls this exact epoch active. Prefer another
          // fenced resume over terminalizing on a racing synthesized frame.
          reconnectTimeoutRef.current = setTimeout(() => {
            if (isCurrentSubscription() && submissionRef.current) {
              subscribeToStream(
                currentStreamId,
                submissionRef.current,
                true,
                generationCreatedAt,
                generationProtocolVersion,
                lifecycleSignal,
              );
            }
          }, 250);
          return;
        }

        const authoritativeValues = [
          ...(persistedMessages ?? []),
          ...(status?.resumeState?.aggregatedContent ?? status?.aggregatedContent ?? []),
        ];
        const reconciledIds = new Set(collectAppliedSteerIds(authoritativeValues));
        settleAppliedSteerParts(reconciliationConvoId, authoritativeValues);
        const unrecovered = status?.unrecoveredSteers ?? [];
        if (unrecovered.length > 0) {
          const recoverySteerId = getRecoverySteerId(currentSubmission);
          convertSteersToQueued(reconciliationConvoId, unrecovered, {
            ...(recoverySteerId != null && {
              allowPreviouslyConvertedIds: [recoverySteerId],
            }),
          });
          for (const steer of unrecovered) {
            reconciledIds.add(steer.steerId);
            if (steer.clientSteerId) {
              reconciledIds.add(steer.clientSteerId);
            }
          }
        }
        if (persistedMessages) {
          convertLocalSteersToQueued(reconciliationConvoId, {
            excludeSteerIds: reconciledIds,
            generationProtocolVersion,
          });
        }

        resetLive({ ...currentSubmission, userMessage });
        removeActiveJob(currentStreamId);
        clearAttachedGenerationCreatedAt();
        clearPendingApprovalForTerminal(reconciliationConvoId);
        clearComposerDrafts(runIndex, reconciliationConvoId, {
          includeNewChatDraft:
            !reconciliationConvoId ||
            reconciliationConvoId === Constants.NEW_CONVO ||
            optimisticStreamIdsRef.current.has(currentStreamId) ||
            isInitialNewConversation(currentSubmission),
        });
        setIsSubmitting(false);
        setShowStopButton(false);
        if (event.reconcileReason === 'abort_persistence_failed') {
          /** Interrupt & send arms an override that drains even an `aborted`
           * run. This terminal frame explicitly says durable persistence is
           * unknown, so consume that override before publishing runEnd; the
           * queued words remain available for a deliberate retry. */
          clearDrainAfterAbort(
            currentSubmission.conversation?.conversationId || String(Constants.NEW_CONVO),
            generationCreatedAt,
          );
        }
        let reconciliationOutcome: 'completed' | 'aborted' | 'error' = 'aborted';
        if (event.terminalStatus === 'complete') {
          reconciliationOutcome = persistedMessages != null ? 'completed' : 'error';
        } else if (event.terminalStatus === 'error') {
          reconciliationOutcome = 'error';
        }
        const reconciledResponseMessageId =
          reconciliationOutcome === 'completed'
            ? completedResponseMessageId(
                persistedMessages,
                userMessage?.messageId,
                status?.resumeState?.responseMessageId ??
                  currentSubmission.initialResponse?.messageId,
              )
            : undefined;
        setRunEnd({
          conversationId: reconciliationConvoId,
          outcome: reconciliationOutcome,
          endedAt: Date.now(),
          generationCreatedAt: status?.createdAt ?? generationCreatedAt,
          ...(reconciledResponseMessageId != null && {
            responseMessageId: reconciledResponseMessageId,
          }),
        });
        setSubmission(null);
        setStreamId(null);
        optimisticStreamIdsRef.current.delete(currentStreamId);
        createdStreamIdsRef.current.delete(currentStreamId);
        reconnectAttemptRef.current = 0;
      };

      /**
       * Error event handler - handles BOTH:
       * 1. HTTP-level errors (responseCode present) - 404, 401, network failures
       * 2. Server-sent error events (event: error with data) - known errors like ViolationTypes/ErrorTypes
       *
       * Order matters: check responseCode first since HTTP errors may also include data
       */
      const handleTransportFailure = async (e: MessageEvent) => {
        if (!isCurrentSubscription()) {
          return;
        }
        const responseCode = (e as MessageEvent & { responseCode?: number }).responseCode;

        if (finalReceived) {
          logger.log('ResumableSSE', 'Ignoring error after FINAL event', {
            responseCode,
            hasData: !!e.data,
          });
          return;
        }

        (startupConfig?.balance?.enabled ?? false) && balanceQuery.refetch();

        if (responseCode === 409) {
          const replacementConvoId =
            currentSubmission.conversation?.conversationId ?? currentStreamId;
          const handedOff = await handoffToReplacement(replacementConvoId);
          if (!isCurrentSubscription()) {
            return;
          }
          if (handedOff) {
            return;
          }
        }

        // 404 → job completed & was cleaned up; messages are persisted in DB.
        // Refetch and reconcile them before recovering local steers: the final
        // response may contain an applied steer whose live event was missed.
        if (responseCode === 404) {
          const convoId = currentSubmission.conversation?.conversationId;
          logger.log('ResumableSSE', 'Stream 404, invalidating messages for:', convoId);
          // Keep the UI non-idle while the status read decides whether this is
          // terminal cleanup or a handoff to a newer generation epoch.
          reconnectAttemptRef.current = Math.max(reconnectAttemptRef.current, 1);
          cancelSteerRetryFrames();
          closeStream();
          /** Terminal: drop any in-flight live estimate so the gauge doesn't
           *  keep counting stale streamed output after the stream ends */
          resetLive({ ...currentSubmission, userMessage });
          clearComposerDrafts(runIndex, convoId, {
            includeNewChatDraft:
              !convoId ||
              convoId === Constants.NEW_CONVO ||
              optimisticStreamIdsRef.current.has(currentStreamId) ||
              isInitialNewConversation(currentSubmission),
          });
          clearStepMaps();
          let persistedMessages: TMessage[] | undefined;
          if (convoId) {
            try {
              const messageQueryKey = [QueryKeys.messages, convoId] as const;
              await queryClient.invalidateQueries({
                queryKey: messageQueryKey,
                refetchType: 'none',
              });
              if (!isCurrentSubscription()) {
                return;
              }
              const fetched = await queryClient.fetchQuery<TMessage[]>({
                queryKey: messageQueryKey,
                // The first stream can finish before CREATED mounts the saved-chat query.
                queryFn: () => dataService.getMessagesByConvoId(convoId),
              });
              if (!isCurrentSubscription()) {
                return;
              }
              if (Array.isArray(fetched)) {
                persistedMessages = fetched;
              }
            } catch (error) {
              if (!isCurrentSubscription()) {
                return;
              }
              logger.warn('ResumableSSE', 'Could not reconcile persisted messages after 404', {
                conversationId: convoId,
                error,
              });
            }
            queryClient.removeQueries({ queryKey: streamStatusQueryKey(convoId) });
          }
          const recoveryConvoId = convoId ?? currentStreamId;
          const reconciledIds = new Set(
            persistedMessages ? collectAppliedSteerIds(persistedMessages) : [],
          );
          if (persistedMessages) {
            settleAppliedSteerParts(recoveryConvoId, persistedMessages);
          }

          // The status replay is owner-gated and non-destructive; creating a
          // recovered follow-up consumes its exact source. Prefer these
          // authoritative leftovers over guessing from local chips.
          let confirmedV2Terminal = false;
          try {
            const status = await fetchStreamStatus(recoveryConvoId);
            if (!isCurrentSubscription()) {
              return;
            }
            if (
              generationProtocolVersion === GENERATION_PROTOCOL_VERSION &&
              !supportsGenerationProtocolV2(status)
            ) {
              reconnectTimeoutRef.current = setTimeout(() => {
                if (isCurrentSubscription() && submissionRef.current) {
                  subscribeToStream(
                    currentStreamId,
                    submissionRef.current,
                    true,
                    generationCreatedAt,
                    generationProtocolVersion,
                    lifecycleSignal,
                  );
                }
              }, 1_000);
              return;
            }
            if (
              status.active === true &&
              status.createdAt != null &&
              (generationCreatedAt == null || status.createdAt !== generationCreatedAt)
            ) {
              const handedOff = await handoffToReplacement(recoveryConvoId, status);
              if (!isCurrentSubscription()) {
                return;
              }
              if (handedOff) {
                return;
              }
              /** Legacy generations have no replacement-handoff contract.
               * Never attach this submission to a different epoch. */
              reconnectTimeoutRef.current = setTimeout(() => {
                if (isCurrentSubscription() && submissionRef.current) {
                  subscribeToStream(
                    currentStreamId,
                    submissionRef.current,
                    true,
                    generationCreatedAt,
                    generationProtocolVersion,
                    lifecycleSignal,
                  );
                }
              }, 1_000);
              return;
            }
            if (status.active === true) {
              /** A stream lookup can briefly lose its routing record while the
               * authoritative job status still proves the same generation is
               * alive. Preserve ownership and retry the attachment instead of
               * publishing a terminal run-end (which could auto-drain queued
               * text into a still-running generation). */
              const activeStreamId = status.streamId ?? currentStreamId;
              queryClient.setQueryData(streamStatusQueryKey(recoveryConvoId), status);
              if (status.createdAt != null) {
                updateActiveGenerationCreatedAt(
                  recoveryConvoId,
                  status.createdAt,
                  undefined,
                  generationProtocolVersion,
                );
              }
              addActiveJob(activeStreamId);
              seedSteerChips(
                recoveryConvoId,
                (status.resumeState?.pendingSteers ?? []) as TPendingSteer[],
                status.createdAt,
                generationProtocolVersion,
              );
              settleAppliedSteerParts(
                recoveryConvoId,
                status.resumeState?.aggregatedContent ?? status.aggregatedContent,
              );
              if (status.pendingAction ?? status.resumeState?.pendingAction) {
                applyPendingActionToMessages(
                  (status.pendingAction ??
                    status.resumeState?.pendingAction) as Agents.PendingAction,
                );
              }
              setIsSubmitting(true);
              setShowStopButton(status.createdAt != null);
              reconnectAttemptRef.current = Math.max(reconnectAttemptRef.current, 1);
              reconnectTimeoutRef.current = setTimeout(() => {
                if (isCurrentSubscription() && submissionRef.current) {
                  subscribeToStream(
                    activeStreamId,
                    submissionRef.current,
                    true,
                    status.createdAt,
                    generationProtocolVersion,
                    lifecycleSignal,
                  );
                }
              }, 1_000);
              return;
            }
            confirmedV2Terminal =
              generationProtocolVersion === GENERATION_PROTOCOL_VERSION &&
              supportsGenerationProtocolV2(status);
            const canRecoverTerminalSteers = generationProtocolVersion === 1 || confirmedV2Terminal;
            const unrecovered = canRecoverTerminalSteers ? (status.unrecoveredSteers ?? []) : [];
            if (unrecovered.length > 0) {
              const recoverySteerId = getRecoverySteerId(currentSubmission);
              convertSteersToQueued(recoveryConvoId, unrecovered, {
                generationProtocolVersion,
                ...(recoverySteerId != null && {
                  allowPreviouslyConvertedIds: [recoverySteerId],
                }),
              });
              for (const steer of unrecovered) {
                reconciledIds.add(steer.steerId);
                if (steer.clientSteerId) {
                  reconciledIds.add(steer.clientSteerId);
                }
              }
            }
          } catch (error) {
            if (!isCurrentSubscription()) {
              return;
            }
            logger.warn('ResumableSSE', 'Could not recover parked steers after 404', {
              conversationId: recoveryConvoId,
              error,
            });
          }

          removeActiveJob(currentStreamId);
          clearAttachedGenerationCreatedAt();
          clearPendingApprovalForTerminal(recoveryConvoId);
          if (
            !createdStreamIdsRef.current.has(currentStreamId) &&
            optimisticStreamIdsRef.current.has(currentStreamId)
          ) {
            // Both fresh and resumed subscriptions can miss every event of a fast turn.
            // A missing job proves neither that the conversation was saved nor that it failed.
            try {
              const persisted = await dataService.getConversationById(recoveryConvoId);
              if (!isCurrentSubscription()) return;
              if (persisted?.conversationId === recoveryConvoId) {
                queryClient.setQueryData([QueryKeys.conversation, recoveryConvoId], persisted);
                upsertConvoInAllQueries(queryClient, persisted);
                if (!isAddedRequest) {
                  setConversation?.((current) => {
                    if (
                      current?.conversationId != null &&
                      current.conversationId !== Constants.NEW_CONVO &&
                      current.conversationId !== recoveryConvoId
                    )
                      return current;
                    return keepLocalCodeApprovalMode(
                      { ...current, ...persisted },
                      current,
                      current?.conversationId,
                    );
                  });
                }
              }
            } catch (error) {
              if (!isCurrentSubscription()) return;
              if (toStartGenerationError(error)?.response?.status === 404) {
                removeConvoFromAllQueries(queryClient, currentStreamId);
              }
            }
            // An inconclusive read must not turn a saved chat into a phantom.
            invalidateConversationLists(queryClient);
            queryClient.invalidateQueries({ queryKey: [QueryKeys.pinnedConversations] });
          }
          if (persistedMessages) {
            setMessages(persistedMessages);
          }
          subscriptionRetired = true;
          setIsSubmitting(false);
          setShowStopButton(false);

          // Only infer recovery from local accepted chips after the persisted
          // final was successfully inspected. If that fetch failed, their
          // applied-vs-leftover outcome is unknown and converting could send
          // already-applied words twice.
          if (persistedMessages && (generationProtocolVersion === 1 || confirmedV2Terminal)) {
            convertLocalSteersToQueued(recoveryConvoId, {
              excludeSteerIds: reconciledIds,
              generationProtocolVersion,
            });
          }
          // The true outcome is unknown here (job record already cleaned up):
          // a non-'completed' outcome releases parked interrupt flags without
          // auto-sending queued messages the user may not want fired.
          setRunEnd({
            conversationId: recoveryConvoId,
            outcome: 'aborted',
            startedAsNewConvo: optimisticStreamIdsRef.current.has(currentStreamId),
            endedAt: Date.now(),
          });
          setStreamId(null);
          optimisticStreamIdsRef.current.delete(currentStreamId);
          createdStreamIdsRef.current.delete(currentStreamId);
          reconnectAttemptRef.current = 0;
          return;
        }

        // Check for 401 and try to refresh token (same pattern as useSSE)
        if (responseCode === 401) {
          try {
            const refreshResponse = await request.refreshToken();
            if (!isCurrentSubscription()) {
              return;
            }
            const newToken = refreshResponse?.token ?? '';
            if (!newToken) {
              throw new Error('Token refresh failed.');
            }
            sse.headers = {
              ...sse.headers,
              ...generationProtocolHeaders(),
              Authorization: `Bearer ${newToken}`,
            };
            request.dispatchTokenUpdatedEvent(newToken);
            sse.stream();
            return;
          } catch (error) {
            if (!isCurrentSubscription()) {
              return;
            }
            logger.log('ResumableSSE', 'Token refresh failed:', error);
          }
        }

        /**
         * Server-sent error event (event: error with data) - no responseCode.
         * These are known errors (ErrorTypes, ViolationTypes) that should be displayed to user.
         * Only check e.data if there's no HTTP responseCode, since HTTP errors may also have body data.
         * Note: responseCode === 0 means transport failure (connection dropped) - treat as network error,
         * not a server-sent error payload. Use `== null` to only match undefined/null (no HTTP status).
         */
        if (responseCode == null && e.data) {
          finalReceived = true;
          const recoveryConvoId = currentSubmission.conversation?.conversationId ?? currentStreamId;
          if (
            !(await authorizeTerminalTeardown(recoveryConvoId, 'error')) ||
            !isCurrentSubscription()
          ) {
            return;
          }
          logger.log('ResumableSSE', 'Server-sent error event received:', e.data);
          cancelSteerRetryFrames();
          closeStream();
          /** FLUSH (not cancel): the error card below is built from the cache
           * tail, so queued tokens must land first — and a stale trailing
           * frame must never overwrite the error write. */
          flushPendingDeltas();
          removeActiveJob(currentStreamId);
          clearAttachedGenerationCreatedAt();
          clearPendingApprovalForTerminal(recoveryConvoId);
          resetLive({ ...currentSubmission, userMessage });
          if (
            !createdStreamIdsRef.current.has(currentStreamId) &&
            optimisticStreamIdsRef.current.has(currentStreamId)
          ) {
            removeConvoFromAllQueries(queryClient, currentStreamId);
          }

          let errorSupportsV2 = false;
          try {
            const errorData = JSON.parse(e.data);
            errorSupportsV2 = supportsGenerationProtocolV2(errorData);
            const errorString = errorData.error ?? errorData.message ?? JSON.stringify(errorData);

            // Check if it's a known error type (ViolationTypes or ErrorTypes)
            let isKnownError = false;
            try {
              const parsed =
                typeof errorString === 'string' ? JSON.parse(errorString) : errorString;
              const errorType = parsed?.type ?? parsed?.code;
              if (errorType) {
                const violationValues = Object.values(ViolationTypes) as string[];
                const errorTypeValues = Object.values(ErrorTypes) as string[];
                isKnownError =
                  violationValues.includes(errorType) || errorTypeValues.includes(errorType);
              }
            } catch {
              // Not JSON or parsing failed - treat as generic error
            }

            logger.log('ResumableSSE', 'Error type check:', { isKnownError, errorString });

            // Display the error to user via errorHandler
            errorHandler({
              data: { text: errorString } as unknown as Parameters<typeof errorHandler>[0]['data'],
              submission: currentSubmission as EventSubmission,
            });
          } catch (parseError) {
            logger.error('ResumableSSE', 'Failed to parse server error:', parseError);
            errorHandler({
              data: { text: e.data } as unknown as Parameters<typeof errorHandler>[0]['data'],
              submission: currentSubmission as EventSubmission,
            });
          }

          setIsSubmitting(false);
          setShowStopButton(false);
          const recoverySteerId = getRecoverySteerId(currentSubmission);
          if (
            recoverySteerId != null &&
            generationProtocolVersion === GENERATION_PROTOCOL_VERSION &&
            errorSupportsV2
          ) {
            try {
              /** The error was received on the exact generation-fenced stream.
               * Read status only now, after terminal was observed: a claim
               * started before this recovery could return a stale parked copy
               * after a successful commit and must never authorize redelivery. */
              const terminalStatus = await fetchStreamStatus(recoveryConvoId);
              if (!isCurrentSubscription()) {
                return;
              }
              const releasedSource = terminalStatus.unrecoveredSteers?.find(
                (steer) => steer.steerId === recoverySteerId,
              );
              if (
                terminalStatus.active === false &&
                supportsGenerationProtocolV2(terminalStatus) &&
                releasedSource != null
              ) {
                convertSteersToQueued(recoveryConvoId, [releasedSource], {
                  generationProtocolVersion,
                  allowPreviouslyConvertedIds: [recoverySteerId],
                });
              }
            } catch (error) {
              if (!isCurrentSubscription()) {
                return;
              }
              logger.warn('ResumableSSE', 'Could not recover source after generation error', {
                conversationId: recoveryConvoId,
                error,
              });
            }
          }
          // The error terminal's backstop parks acked leftovers server-side;
          // claim it now so a reload can't resurrect the chips converted here.
          if (generationProtocolVersion === 1 || errorSupportsV2) {
            convertLocalSteersToQueued(recoveryConvoId, {
              claimParked: true,
              generationProtocolVersion,
            });
          }
          setRunEnd({
            conversationId: recoveryConvoId,
            outcome: 'error',
            endedAt: Date.now(),
            generationCreatedAt,
          });
          setStreamId(null);
          optimisticStreamIdsRef.current.delete(currentStreamId);
          createdStreamIdsRef.current.delete(currentStreamId);
          reconnectAttemptRef.current = 0;
          return;
        }

        // Network failure or unknown HTTP error - attempt reconnection with backoff
        logger.log('ResumableSSE', 'Stream error (network failure) - will attempt reconnect', {
          responseCode,
          hasData: !!e.data,
        });

        if (reconnectAttemptRef.current < MAX_RETRIES) {
          // Increment counter BEFORE close() so abort handler knows we're reconnecting
          reconnectAttemptRef.current++;
          const delay = getReconnectDelay(reconnectAttemptRef.current);

          logger.log(
            'ResumableSSE',
            `Reconnecting in ${delay}ms (attempt ${reconnectAttemptRef.current}/${MAX_RETRIES})`,
          );

          closeStream();

          reconnectTimeoutRef.current = setTimeout(() => {
            if (isCurrentSubscription() && submissionRef.current) {
              // Reconnect with isResume=true to get sync event with any missed content
              subscribeToStream(
                currentStreamId,
                submissionRef.current,
                true,
                generationCreatedAt,
                generationProtocolVersion,
                lifecycleSignal,
              );
            }
          }, delay);

          // Keep UI in "submitting" state during reconnection attempts
          // so user knows we're still trying (abort handler may have reset these)
          setIsSubmitting(true);
          setShowStopButton(generationCreatedAt != null);
        } else {
          logger.error('ResumableSSE', 'Max reconnect attempts reached');
          closeStream();
          flushPendingDeltas();
          const recoveryConvoId = currentSubmission.conversation?.conversationId ?? currentStreamId;
          let status: Awaited<ReturnType<typeof fetchStreamStatus>> | undefined;
          try {
            status = await fetchStreamStatus(recoveryConvoId);
            if (!isCurrentSubscription()) {
              return;
            }
          } catch (error) {
            if (!isCurrentSubscription()) {
              return;
            }
            logger.warn('ResumableSSE', 'Could not determine job state after reconnect limit', {
              conversationId: recoveryConvoId,
              error,
            });
          }

          if (
            status != null &&
            generationProtocolVersion === GENERATION_PROTOCOL_VERSION &&
            !supportsGenerationProtocolV2(status)
          ) {
            // A legacy responder cannot adjudicate a v2 job during rollout.
            status = undefined;
          }

          if (
            status?.active === true &&
            status.createdAt != null &&
            (generationCreatedAt == null || status.createdAt !== generationCreatedAt)
          ) {
            const handedOff = await handoffToReplacement(recoveryConvoId, status);
            if (!isCurrentSubscription()) {
              return;
            }
            if (handedOff) {
              return;
            }
            reconnectAttemptRef.current = 0;
            reconnectTimeoutRef.current = setTimeout(() => {
              if (isCurrentSubscription() && submissionRef.current) {
                subscribeToStream(
                  currentStreamId,
                  submissionRef.current,
                  true,
                  generationCreatedAt,
                  generationProtocolVersion,
                  lifecycleSignal,
                );
              }
            }, 30_000);
            return;
          }

          if (status?.active === true) {
            // The transport gave up, not the generation. Keep the active-job
            // marker and accepted chips intact, then release this stale
            // submission so useResumeOnLoad can establish a fresh attachment.
            queryClient.setQueryData(streamStatusQueryKey(recoveryConvoId), status);
            seedSteerChips(
              recoveryConvoId,
              (status.resumeState?.pendingSteers ?? []) as TPendingSteer[],
              status.createdAt,
              generationProtocolVersion,
            );
            settleAppliedSteerParts(
              recoveryConvoId,
              status.resumeState?.aggregatedContent ?? status.aggregatedContent,
            );
            if (status.pendingAction ?? status.resumeState?.pendingAction) {
              applyPendingActionToMessages(
                (status.pendingAction ?? status.resumeState?.pendingAction) as Agents.PendingAction,
              );
            }
            setIsSubmitting(true);
            setShowStopButton(generationCreatedAt != null);
            reconnectAttemptRef.current = 0;
            reconnectTimeoutRef.current = setTimeout(() => {
              if (isCurrentSubscription() && submissionRef.current) {
                subscribeToStream(
                  currentStreamId,
                  submissionRef.current,
                  true,
                  generationCreatedAt,
                  generationProtocolVersion,
                  lifecycleSignal,
                );
              }
            }, 30_000);
            return;
          }

          if (status == null) {
            // An inconclusive status read is still not proof of termination.
            // Preserve server/client ownership and let the normal resume-on-load
            // status query retry rather than duplicating accepted words.
            queryClient.invalidateQueries({ queryKey: streamStatusQueryKey(recoveryConvoId) });
            setIsSubmitting(true);
            setShowStopButton(generationCreatedAt != null);
            reconnectAttemptRef.current = 0;
            reconnectTimeoutRef.current = setTimeout(() => {
              if (isCurrentSubscription() && submissionRef.current) {
                subscribeToStream(
                  currentStreamId,
                  submissionRef.current,
                  true,
                  generationCreatedAt,
                  generationProtocolVersion,
                  lifecycleSignal,
                );
              }
            }, 30_000);
            return;
          }

          // The status endpoint proved the job terminal. Reconcile persisted
          // content before recovering leftovers, just like the 404 path.
          cancelSteerRetryFrames();
          let persistedMessages: TMessage[] | undefined;
          try {
            const messageQueryKey = [QueryKeys.messages, recoveryConvoId] as const;
            await queryClient.invalidateQueries({
              queryKey: messageQueryKey,
              refetchType: 'none',
            });
            if (!isCurrentSubscription()) {
              return;
            }
            const fetched = await queryClient.fetchQuery<TMessage[]>({
              queryKey: messageQueryKey,
            });
            if (!isCurrentSubscription()) {
              return;
            }
            if (Array.isArray(fetched)) {
              persistedMessages = fetched;
            }
          } catch (error) {
            if (!isCurrentSubscription()) {
              return;
            }
            logger.warn('ResumableSSE', 'Could not reconcile terminal messages after disconnect', {
              conversationId: recoveryConvoId,
              error,
            });
          }

          const authoritativeValues = [
            ...(persistedMessages ?? []),
            ...(status.resumeState?.aggregatedContent ?? status.aggregatedContent ?? []),
          ];
          const confirmedV2Terminal =
            generationProtocolVersion === GENERATION_PROTOCOL_VERSION &&
            supportsGenerationProtocolV2(status);
          const reconciledIds = new Set(collectAppliedSteerIds(authoritativeValues));
          settleAppliedSteerParts(recoveryConvoId, authoritativeValues);
          const canRecoverTerminalSteers = generationProtocolVersion === 1 || confirmedV2Terminal;
          const unrecovered = canRecoverTerminalSteers ? (status.unrecoveredSteers ?? []) : [];
          if (unrecovered.length > 0) {
            const recoverySteerId = getRecoverySteerId(currentSubmission);
            convertSteersToQueued(recoveryConvoId, unrecovered, {
              generationProtocolVersion,
              ...(recoverySteerId != null && {
                allowPreviouslyConvertedIds: [recoverySteerId],
              }),
            });
            for (const steer of unrecovered) {
              reconciledIds.add(steer.steerId);
              if (steer.clientSteerId) {
                reconciledIds.add(steer.clientSteerId);
              }
            }
          }
          if (persistedMessages && (generationProtocolVersion === 1 || confirmedV2Terminal)) {
            convertLocalSteersToQueued(recoveryConvoId, {
              excludeSteerIds: reconciledIds,
              generationProtocolVersion,
            });
          }

          resetLive({ ...currentSubmission, userMessage });
          removeActiveJob(currentStreamId);
          clearAttachedGenerationCreatedAt();
          clearPendingApprovalForTerminal(recoveryConvoId);
          if (
            !createdStreamIdsRef.current.has(currentStreamId) &&
            optimisticStreamIdsRef.current.has(currentStreamId)
          ) {
            removeConvoFromAllQueries(queryClient, currentStreamId);
          }
          subscriptionRetired = true;
          setIsSubmitting(false);
          setShowStopButton(false);
          let recoveryOutcome: 'completed' | 'aborted' | 'error' = 'error';
          if (status.status === 'complete' && persistedMessages != null) {
            recoveryOutcome = 'completed';
          } else if (status.status === 'aborted') {
            recoveryOutcome = 'aborted';
          }
          const recoveredResponseMessageId =
            recoveryOutcome === 'completed'
              ? completedResponseMessageId(
                  persistedMessages,
                  userMessage?.messageId,
                  status?.resumeState?.responseMessageId ??
                    currentSubmission.initialResponse?.messageId,
                )
              : undefined;
          setRunEnd({
            conversationId: recoveryConvoId,
            outcome: recoveryOutcome,
            endedAt: Date.now(),
            generationCreatedAt: status.createdAt ?? generationCreatedAt,
            ...(recoveredResponseMessageId != null && {
              responseMessageId: recoveredResponseMessageId,
            }),
          });
          setSubmission(null);
          setStreamId(null);
          optimisticStreamIdsRef.current.delete(currentStreamId);
          createdStreamIdsRef.current.delete(currentStreamId);
          reconnectAttemptRef.current = 0;
        }
      };

      sse.addEventListener('error', handleTransportFailure);

      /**
       * Abort event - fired when the underlying XHR is cancelled, either by one
       * of this hook's own closes or by the user agent.
       */
      sse.addEventListener('abort', () => {
        if (!isCurrentSubscription()) {
          return;
        }

        /**
         * A cancellation this hook did not issue came from the user agent,
         * which cancels in-flight requests when a mobile browser is
         * backgrounded or the page is frozen — and the generation it was
         * carrying is still running server-side.
         *
         * Treating that as a deliberate close is what strands the response:
         * the pane goes idle holding whatever partial content arrived before
         * the switch, looking finished, and nothing re-reads the conversation
         * until a reload or a navigation remounts the messages query. It is a
         * dropped connection by every meaningful measure, so hand it to the
         * transport-failure path verbatim rather than re-deriving a ladder
         * beside it: that one already climbs its backoff, adjudicates the
         * retry ceiling against durable status, and terminalizes into the
         * refetch when the job turns out to have finished meanwhile.
         */
        if (!closedByUs) {
          logger.log(
            'ResumableSSE',
            'Stream aborted by the user agent - recovering as transport failure',
          );
          void handleTransportFailure({
            responseCode: 0,
          } as MessageEvent & { responseCode?: number });
          return;
        }

        if (replacementHandoffRef.current) {
          logger.log('ResumableSSE', 'Stream closed for generation handoff - preserving state');
          return;
        }
        // If we're in a reconnection cycle, don't reset state
        // (error handler will set up the reconnect timeout)
        if (reconnectAttemptRef.current > 0) {
          logger.log('ResumableSSE', 'Stream closed for reconnect - preserving state');
          return;
        }

        logger.log('ResumableSSE', 'Stream aborted (intentional close) - no reconnect');
        cancelSteerRetryFrames();
        // Clear any pending reconnect attempts
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
        // Reset UI state - useResumeOnLoad will restore if user returns to this conversation
        setIsSubmitting(false);
        setShowStopButton(false);
        setStreamId(null);
        /** Intentional close without a final event (explicit stop, or navigation
         *  while generating): discard the in-flight pending usage so it can't
         *  merge into the next response in this conversation. On a resume the
         *  collected usage is re-folded via backfillUsage, so nothing is lost. */
        resetLive({ ...currentSubmission, userMessage });
      });

      // Start the SSE connection
      sse.stream();

      // Debug hooks for testing reconnection vs clean close behavior (dev only)
      if (import.meta.env.DEV) {
        const debugWindow = window as Window & {
          __sse?: SSE;
          __killNetwork?: () => void;
          __closeClean?: () => void;
        };
        debugWindow.__sse = sse;

        /** Simulate network drop - triggers error event → reconnection */
        debugWindow.__killNetwork = () => {
          logger.log('Debug', 'Simulating network drop...');
          // @ts-ignore - sse.js types are incorrect, dispatchEvent actually takes Event
          sse.dispatchEvent(new Event('error'));
        };

        /** Simulate clean close (navigation away) - triggers abort event → no reconnection */
        debugWindow.__closeClean = () => {
          logger.log('Debug', 'Simulating clean close (navigation away)...');
          subscriptionRetired = true;
          closeStream();
        };
      }
    },
    [
      isAddedRequest,
      setConversation,
      runIndex,
      token,
      setAbortScroll,
      setActiveRunId,
      setShowStopButton,
      finalHandler,
      createdHandler,
      attachmentHandler,
      titleHandler,
      stepHandler,
      contentHandler,
      resetContentHandler,
      syncStepMessage,
      prunePtcTraces,
      clearStepMaps,
      messageHandler,
      errorHandler,
      flushPendingDeltas,
      setIsSubmitting,
      getMessages,
      setMessages,
      startupConfig?.balance?.enabled,
      balanceQuery,
      removeActiveJob,
      queryClient,
      contextHandler,
      usageHandler,
      tapStream,
      tapContent,
      finalizeUsage,
      backfillUsage,
      resetLive,
      seedLive,
      setRunEnd,
      clearDrainAfterAbort,
      resolveSteerChip,
      setLiveAppliedSteerIds,
      updateSteerChips,
      seedSteerChips,
      settleAppliedSteerParts,
      convertSteersToQueued,
      convertLocalSteersToQueued,
      addActiveJob,
      setSubmission,
      updateActiveGenerationCreatedAt,
      jotaiStore,
    ],
  );

  /**
   * Start generation (POST request that returns streamId)
   * Uses the generation protocol request wrapper, including auth refresh.
   * Retries transient network failures and startup readiness responses.
   * Readiness retries honor Retry-After until cleanup or the readiness window expires.
   */
  const startGeneration = useCallback(
    async (
      currentSubmission: TSubmission,
      signal?: AbortSignal,
    ): Promise<StartGenerationResult | null> => {
      const payloadData = createPayload(currentSubmission);
      let { payload } = payloadData;
      payload = removeNullishValues(payload) as TPayload;

      clearStepMaps();

      const url = payloadData.server;

      let lastError: unknown = null;
      let requestAttempts = 0;
      let networkAttempts = 0;
      let readinessAttempts = 0;
      const readinessDeadline = Date.now() + START_GENERATION_READINESS_TIMEOUT_MS;

      while (!signal?.aborted) {
        const recoverySteerId = getRecoverySteerId(currentSubmission);
        const conversationId = currentSubmission.conversation?.conversationId;
        if (
          recoverySteerId != null &&
          conversationId &&
          jotaiStore.get(recoveryDispositionsFamily(conversationId))[recoverySteerId] != null
        ) {
          restoreQueuedSubmission(currentSubmission);
          errorHandler({
            data: getStreamStartFailureData(localize('com_ui_steer_recovery_held')),
            submission: currentSubmission as EventSubmission,
          });
          setShowStopButton(false);
          setIsSubmitting(false);
          setSubmission(null);
          return null;
        }
        requestAttempts += 1;
        try {
          const data = await postGenerationRequest<unknown>(url, payload, { signal });
          if (signal?.aborted) {
            return null;
          }
          if (isSettledStartResponse(data)) {
            const conversationId = getStartGenerationConversationId(data);
            if (conversationId) {
              logger.log('ResumableSSE', 'Generation already settled:', { conversationId });
              return {
                status: 'settled',
                conversationId,
                generationProtocolVersion: GENERATION_PROTOCOL_VERSION,
              };
            }
            lastError = { response: { data } };
            break;
          }
          if (isReplacedStartResponse(data)) {
            const streamId = getStartGenerationStreamId(data);
            const conversationId = getStartGenerationConversationId(data);
            const generationCreatedAt = getStartGenerationCreatedAt(data);
            if (streamId && conversationId && generationCreatedAt != null) {
              return {
                status: 'replaced',
                streamId,
                conversationId,
                generationCreatedAt,
                generationProtocolVersion: GENERATION_PROTOCOL_VERSION,
              };
            }
            lastError = { response: { data } };
            break;
          }
          if (isUnnegotiatedV2StartControl(data)) {
            /** Never reinterpret a v2-only control word as a legacy stream
             * response merely because it also carries a stream id. */
            lastError = { response: { data } };
            break;
          }
          const streamId = getStartGenerationStreamId(data);
          if (streamId) {
            const resumed = isResumedStartResponse(data);
            const generationCreatedAt = getStartGenerationCreatedAt(data);
            const generationProtocolVersion = getGenerationProtocolVersion(data);
            logger.log('ResumableSSE', 'Generation started:', {
              streamId,
              resumed,
              generationCreatedAt,
              generationProtocolVersion,
            });
            return {
              status: 'stream',
              streamId,
              resumed,
              generationProtocolVersion,
              ...(generationCreatedAt != null && { generationCreatedAt }),
            };
          }

          lastError = { response: { data } };
          break;
        } catch (error) {
          if (signal?.aborted) {
            return null;
          }

          const predecessorMismatch = getPredecessorMismatchStartResponse(error);
          if (predecessorMismatch != null) {
            /** Admission was atomically rejected before this queued turn
             * created anything. Put the exact row back immediately and let
             * the caller reconcile or hand off to the generation that won. */
            restoreQueuedSubmission(currentSubmission);
            logger.log('ResumableSSE', 'Queued generation lost predecessor fence', {
              expectedPredecessorCreatedAt: currentSubmission.expectedPredecessorCreatedAt,
              ...predecessorMismatch,
            });
            return {
              status: 'predecessor_mismatch',
              ...predecessorMismatch,
              generationProtocolVersion: GENERATION_PROTOCOL_VERSION,
            };
          }

          lastError = error;
          const isNetworkError = isRetryableNetworkError(error);
          const isServerNotReady = isServerNotReadyError(error);
          const remainingReadinessMs = readinessDeadline - Date.now();
          const shouldRetryNetwork =
            isNetworkError && networkAttempts < START_GENERATION_NETWORK_RETRIES - 1;
          const shouldRetryServerNotReady = isServerNotReady && remainingReadinessMs > 0;

          if (shouldRetryNetwork || shouldRetryServerNotReady) {
            networkAttempts += isNetworkError ? 1 : 0;
            readinessAttempts += isServerNotReady ? 1 : 0;
            const fallbackDelay = Math.min(1000 * Math.pow(2, requestAttempts - 1), 8000);
            const retryDelay = isServerNotReady
              ? Math.min(getRetryAfterDelay(error, fallbackDelay), remainingReadinessMs)
              : fallbackDelay;
            const reason = isServerNotReady ? 'Server not ready' : 'Network error';
            const attempt = isServerNotReady ? readinessAttempts : networkAttempts;
            const limit = isServerNotReady
              ? `${Math.ceil(START_GENERATION_READINESS_TIMEOUT_MS / 1000)}s readiness window`
              : `${START_GENERATION_NETWORK_RETRIES}`;
            logger.log(
              'ResumableSSE',
              `${reason} starting generation, retrying in ${retryDelay}ms (attempt ${attempt}/${limit})`,
            );
            const shouldContinue = await waitForRetryDelay(retryDelay, signal);
            if (!shouldContinue) {
              return null;
            }
            continue;
          }

          // Don't retry: either not a network error or max retries reached
          break;
        }
      }

      if (signal?.aborted) {
        return null;
      }

      logger.error('ResumableSSE', 'Error starting generation:', lastError);

      const startError = toStartGenerationError(lastError);
      const errorData = startError?.response?.data;
      const responseStatus = startError?.response?.status;
      if (responseStatus != null && responseStatus >= 400 && responseStatus < 500) {
        const recoverySteerId = getRecoverySteerId(currentSubmission);
        const conversationId = currentSubmission.conversation?.conversationId;
        const recoveryRejected =
          errorData != null &&
          typeof errorData === 'object' &&
          'code' in errorData &&
          (errorData.code === 'RECOVERY_PAYLOAD_MISMATCH' ||
            errorData.code === 'INVALID_RECOVERY_REQUEST');
        if (recoveryRejected && recoverySteerId != null && conversationId) {
          jotaiStore.set(recoveryDispositionsFamily(conversationId), (previous) =>
            blockRecovery(previous, recoverySteerId),
          );
        }
        // The server rejected admission before exposing a generation. Restore
        // the exact queue row/position; ambiguous transport/5xx outcomes must
        // first reconcile durable state instead of risking a duplicate start.
        restoreQueuedSubmission(currentSubmission);
      } else {
        const recoverySteerId = getRecoverySteerId(currentSubmission);
        const recoveryConvoId = currentSubmission.conversation?.conversationId;
        if (recoverySteerId != null && recoveryConvoId) {
          try {
            const status = await fetchStreamStatus(recoveryConvoId);
            if (signal?.aborted) {
              return null;
            }
            const releasedSource = status.unrecoveredSteers?.find(
              (steer) => steer.steerId === recoverySteerId,
            );
            if (
              status.active === false &&
              supportsGenerationProtocolV2(status) &&
              releasedSource != null
            ) {
              convertSteersToQueued(recoveryConvoId, [releasedSource], {
                generationProtocolVersion: GENERATION_PROTOCOL_VERSION,
                allowPreviouslyConvertedIds: [recoverySteerId],
              });
            }
          } catch (error) {
            if (signal?.aborted) {
              return null;
            }
            logger.warn('ResumableSSE', 'Could not recover source after start failure', {
              conversationId: recoveryConvoId,
              error,
            });
          }
        }
      }
      if (signal?.aborted) {
        return null;
      }
      errorHandler({
        data: getStreamStartFailureData(errorData),
        submission: currentSubmission as EventSubmission,
      });
      setShowStopButton(false);
      setIsSubmitting(false);
      setSubmission(null);
      return null;
    },
    [
      clearStepMaps,
      convertSteersToQueued,
      errorHandler,
      jotaiStore,
      localize,
      restoreQueuedSubmission,
      setIsSubmitting,
      setShowStopButton,
      setSubmission,
    ],
  );

  useEffect(() => {
    if (!submission || Object.keys(submission).length === 0) {
      logger.log('ResumableSSE', 'No submission, cleaning up');
      // Clear reconnect timeout if submission is cleared
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      stopForegroundReattachRef.current?.();
      stopForegroundReattachRef.current = null;
      // Close SSE but do NOT dispatch cancel - navigation should not abort
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }
      setStreamId(null);
      reconnectAttemptRef.current = 0;
      submissionRef.current = null;
      return;
    }

    const resumableSubmission = submission as TSubmission & {
      resumeStreamId?: string;
      resumeGenerationCreatedAt?: number;
      resumeGenerationProtocolVersion?: GenerationProtocolVersion;
    };
    const resumeStreamId = resumableSubmission.resumeStreamId;
    const resumeGenerationCreatedAt = resumableSubmission.resumeGenerationCreatedAt;
    const resumeGenerationProtocolVersion =
      resumableSubmission.resumeGenerationProtocolVersion ?? 1;
    logger.log('ResumableSSE', 'Effect triggered', {
      conversationId: submission.conversation?.conversationId,
      hasResumeStreamId: !!resumeStreamId,
      resumeStreamId,
      userMessageId: submission.userMessage?.messageId,
    });

    submissionRef.current = submission;
    const startController = new AbortController();
    const { signal } = startController;
    const isCurrentEffect = () => !signal.aborted && submissionRef.current === submission;

    const initStream = async () => {
      if (!isCurrentEffect()) {
        return;
      }

      setIsSubmitting(true);
      /** Starting a new generation is the one interval where `isSubmitting`
       *  is true but no generation epoch exists yet. Clear any prior epoch and
       *  withhold live Stop/steer controls; the composer can still queue input.
       *  subscribeToStream exposes controls once the POST/resume installs the
       *  server-provided epoch. */
      const submissionConversationId =
        submission.conversation?.conversationId ?? Constants.NEW_CONVO;
      if (!resumeStreamId || resumeGenerationCreatedAt == null) {
        updateActiveGenerationCreatedAt(resumeStreamId ?? submissionConversationId, null);
      }
      setShowStopButton(false);

      if (resumeStreamId) {
        if (!isCurrentEffect()) {
          return;
        }
        // Resume: just subscribe to existing stream, don't start new generation
        logger.log('ResumableSSE', 'Resuming existing stream:', resumeStreamId);
        setStreamId(resumeStreamId);
        // Optimistically add to active jobs (in case it's not already there)
        addActiveJob(resumeStreamId);
        subscribeToStream(
          resumeStreamId,
          submission,
          true,
          resumeGenerationCreatedAt,
          resumeGenerationProtocolVersion,
          signal,
        );
      } else {
        // New generation: start and then subscribe
        logger.log('ResumableSSE', 'Starting NEW generation');
        const startResult = await startGeneration(submission, signal);
        if (!isCurrentEffect()) {
          return;
        }
        if (startResult) {
          let replacementStart = startResult.status === 'replaced' ? startResult : null;
          let knownReplacementStatus: StreamStatusResponse | null = null;

          if (startResult.status === 'predecessor_mismatch') {
            const expectedPredecessorCreatedAt = submission.expectedPredecessorCreatedAt;
            let refreshedStatus: StreamStatusResponse | null = null;
            try {
              refreshedStatus = await fetchStreamStatus(startResult.conversationId);
              if (!isCurrentEffect()) {
                return;
              }
            } catch (error) {
              if (!isCurrentEffect()) {
                return;
              }
              logger.warn('ResumableSSE', 'Could not refresh predecessor mismatch status', {
                conversationId: startResult.conversationId,
                error,
              });
            }
            if (!isCurrentEffect()) {
              return;
            }

            const reportedReplacement =
              startResult.active === true &&
              startResult.generationCreatedAt != null &&
              startResult.generationCreatedAt !== expectedPredecessorCreatedAt;

            if (
              refreshedStatus?.active === true &&
              supportsGenerationProtocolV2(refreshedStatus) &&
              typeof refreshedStatus.streamId === 'string' &&
              refreshedStatus.streamId.length > 0 &&
              refreshedStatus.createdAt != null &&
              refreshedStatus.createdAt !== expectedPredecessorCreatedAt
            ) {
              replacementStart = {
                status: 'replaced',
                streamId: refreshedStatus.streamId,
                conversationId: startResult.conversationId,
                generationCreatedAt: refreshedStatus.createdAt,
                generationProtocolVersion: GENERATION_PROTOCOL_VERSION,
              };
              knownReplacementStatus = refreshedStatus;
              restoreQueuedSubmission(submission, refreshedStatus.createdAt);
            } else if (reportedReplacement) {
              /** The atomic 409 is itself authoritative at admission time.
               * Status publication can lag that response, so retain its exact
               * epoch as a minimal handoff snapshot; the fenced SSE attach can
               * reconcile if the replacement finishes in the meantime. */
              replacementStart = {
                status: 'replaced',
                streamId: startResult.streamId,
                conversationId: startResult.conversationId,
                generationCreatedAt: startResult.generationCreatedAt!,
                generationProtocolVersion: GENERATION_PROTOCOL_VERSION,
              };
              knownReplacementStatus = {
                active: true,
                status: 'running',
                streamId: startResult.streamId,
                createdAt: startResult.generationCreatedAt,
                generationProtocolVersion: GENERATION_PROTOCOL_VERSION,
              };
              restoreQueuedSubmission(submission, startResult.generationCreatedAt!);
            } else {
              /** No different live epoch is proven. Reconcile away the
               * optimistic C rows, but publish no run-end: doing so would
               * immediately drain and re-send the just-restored queue item. */
              const terminalWinnerCreatedAt =
                refreshedStatus?.createdAt ?? startResult.generationCreatedAt;
              if (terminalWinnerCreatedAt != null) {
                restoreQueuedSubmission(submission, terminalWinnerCreatedAt);
              }
              if (refreshedStatus != null) {
                queryClient.setQueryData(
                  streamStatusQueryKey(startResult.conversationId),
                  refreshedStatus,
                );
              } else {
                queryClient.invalidateQueries({
                  queryKey: streamStatusQueryKey(startResult.conversationId),
                });
              }
              try {
                await queryClient.invalidateQueries({
                  queryKey: [QueryKeys.messages, startResult.conversationId],
                  refetchType: 'all',
                });
                if (!isCurrentEffect()) {
                  return;
                }
                await queryClient.invalidateQueries({
                  queryKey: [QueryKeys.conversation, startResult.conversationId],
                  refetchType: 'all',
                });
                if (!isCurrentEffect()) {
                  return;
                }
                await invalidateConversationLists(queryClient);
                if (!isCurrentEffect()) {
                  return;
                }
                await queryClient.invalidateQueries({ queryKey: [QueryKeys.pinnedConversations] });
                if (!isCurrentEffect()) {
                  return;
                }
              } catch (error) {
                if (!isCurrentEffect()) {
                  return;
                }
                logger.warn('ResumableSSE', 'Could not reconcile predecessor mismatch history', {
                  conversationId: startResult.conversationId,
                  error,
                });
              }
              clearDrainAfterAbort(startResult.conversationId, expectedPredecessorCreatedAt);
              submissionRef.current = null;
              setIsSubmitting(false);
              setShowStopButton(false);
              setSubmission(null);
              return;
            }
          }

          if (replacementStart != null) {
            /** This POST belongs to an older optimistic submission, while the
             * conversation-scoped stream id now belongs to a newer generation.
             * Never attach A's submission directly to B. Discover B's
             * authoritative resume snapshot, refresh durable history, then let
             * useResumeOnLoad construct a new epoch-fenced submission. */
            const replacementStatus =
              knownReplacementStatus ??
              (await fetchStreamStatus(replacementStart.conversationId).catch((error) => {
                if (!isCurrentEffect()) {
                  return null;
                }
                logger.warn('ResumableSSE', 'Could not discover replacement start generation', {
                  conversationId: replacementStart.conversationId,
                  generationCreatedAt: replacementStart.generationCreatedAt,
                  error,
                });
                return null;
              }));
            if (!isCurrentEffect()) {
              return;
            }
            if (
              replacementStatus?.active === true &&
              supportsGenerationProtocolV2(replacementStatus) &&
              replacementStatus.streamId === replacementStart.streamId &&
              replacementStatus.createdAt === replacementStart.generationCreatedAt
            ) {
              const startedAsNewConvo = isInitialNewConversation(submission);
              try {
                await queryClient.invalidateQueries({
                  queryKey: [QueryKeys.messages, replacementStart.conversationId],
                  refetchType: 'all',
                });
                if (!isCurrentEffect()) {
                  return;
                }
                await queryClient.invalidateQueries({
                  queryKey: [QueryKeys.conversation, replacementStart.conversationId],
                  refetchType: 'all',
                });
                if (!isCurrentEffect()) {
                  return;
                }
                await invalidateConversationLists(queryClient);
                if (!isCurrentEffect()) {
                  return;
                }
                await queryClient.invalidateQueries({ queryKey: [QueryKeys.pinnedConversations] });
                if (!isCurrentEffect()) {
                  return;
                }
              } catch (error) {
                if (!isCurrentEffect()) {
                  return;
                }
                logger.warn('ResumableSSE', 'Could not refresh replacement generation history', {
                  conversationId: replacementStart.conversationId,
                  error,
                });
              }
              const authoritativeConversation = queryClient.getQueryData<TConversation>([
                QueryKeys.conversation,
                replacementStart.conversationId,
              ]);
              if (authoritativeConversation?.conversationId === replacementStart.conversationId) {
                const localConversationId = isInitialNewConversation(submission)
                  ? Constants.NEW_CONVO
                  : replacementStart.conversationId;
                setConversation?.((current) =>
                  keepLocalCodeApprovalMode(
                    authoritativeConversation,
                    current,
                    localConversationId,
                  ),
                );
              }
              queryClient.setQueryData(streamStatusQueryKey(replacementStart.conversationId), {
                ...replacementStatus,
                generationHandoff: true,
              });
              updateActiveGenerationCreatedAt(
                replacementStart.conversationId,
                replacementStart.generationCreatedAt,
                undefined,
                replacementStart.generationProtocolVersion,
              );
              addActiveJob(replacementStart.streamId);
              if (startedAsNewConvo) {
                optimisticStreamIdsRef.current.add(replacementStart.streamId);
                updateActiveGenerationCreatedAt(
                  Constants.NEW_CONVO,
                  replacementStart.generationCreatedAt,
                  undefined,
                  replacementStart.generationProtocolVersion,
                );
                replaceNewConversationUrl(replacementStart.conversationId);
              }
              seedSteerChips(
                replacementStart.conversationId,
                (replacementStatus.resumeState?.pendingSteers ?? []) as TPendingSteer[],
                replacementStart.generationCreatedAt,
                replacementStart.generationProtocolVersion,
              );
              settleAppliedSteerParts(
                replacementStart.conversationId,
                replacementStatus.resumeState?.aggregatedContent ??
                  replacementStatus.aggregatedContent,
              );
              replacementHandoffRef.current = true;
              submissionRef.current = null;
              setIsSubmitting(true);
              setShowStopButton(true);
              setSubmission(null);
              return;
            }

            /** The server reported a replacement but its authoritative status
             * could not be confirmed. Drop A without ever attaching it to B;
             * leave history/status invalidated so navigation/reload can recover,
             * and keep any queued text parked (non-completed outcome). */
            queryClient.invalidateQueries({
              queryKey: streamStatusQueryKey(replacementStart.conversationId),
            });
            queryClient.invalidateQueries({
              queryKey: [QueryKeys.messages, replacementStart.conversationId],
            });
            clearDrainAfterAbort(
              replacementStart.conversationId,
              replacementStart.generationCreatedAt,
            );
            setIsSubmitting(false);
            setShowStopButton(false);
            setRunEnd({
              conversationId: replacementStart.conversationId,
              outcome: 'error',
              endedAt: Date.now(),
              generationCreatedAt: replacementStart.generationCreatedAt,
            });
            setSubmission(null);
            return;
          }
          if (startResult.status === 'predecessor_mismatch') {
            // Every mismatch path above either hands off or reconciles.
            return;
          }
          if (startResult.status === 'settled') {
            const settledConversationId = startResult.conversationId;
            const startedAsNewConvo = isInitialNewConversation(submission);
            let persistedConversation: TConversation | undefined;
            let conversationLookup: 'found' | 'not_found' | 'inconclusive' = 'inconclusive';
            try {
              persistedConversation = await dataService.getConversationById(settledConversationId);
              if (!isCurrentEffect()) {
                return;
              }
              conversationLookup = 'found';
            } catch (error) {
              if (!isCurrentEffect()) {
                return;
              }
              conversationLookup =
                toStartGenerationError(error)?.response?.status === 404
                  ? 'not_found'
                  : 'inconclusive';
              logger.warn('ResumableSSE', 'Could not load settled generation conversation', {
                conversationId: settledConversationId,
                conversationLookup,
                error,
              });
            }

            if (persistedConversation != null) {
              /** The persisted copy carries the mode the settled turn started
               *  with; a pick made while the start was pending is newer. The
               *  live conversation still holds the new-chat id here because no
               *  stream event ran for this turn. */
              const settledCopy = persistedConversation;
              const localConversationId = startedAsNewConvo
                ? Constants.NEW_CONVO
                : settledConversationId;
              const conversationRecord = keepLocalCodeApprovalMode(
                settledCopy,
                queryClient.getQueryData<TConversation>([
                  QueryKeys.conversation,
                  settledConversationId,
                ]),
                settledConversationId,
              );
              queryClient.setQueryData(
                [QueryKeys.conversation, settledConversationId],
                conversationRecord,
              );
              upsertConvoInAllQueries(queryClient, conversationRecord);
              setConversation?.((current) =>
                keepLocalCodeApprovalMode(settledCopy, current, localConversationId),
              );
              if (startedAsNewConvo) {
                replaceNewConversationUrl(settledConversationId);
              }
            }

            try {
              await queryClient.invalidateQueries({
                queryKey: [QueryKeys.messages, settledConversationId],
                refetchType: 'all',
              });
              if (!isCurrentEffect()) {
                return;
              }
              await queryClient.invalidateQueries({
                queryKey: [QueryKeys.conversation, settledConversationId],
                refetchType: 'all',
              });
              if (!isCurrentEffect()) {
                return;
              }
              await invalidateConversationLists(queryClient);
              if (!isCurrentEffect()) {
                return;
              }
              await queryClient.invalidateQueries({ queryKey: [QueryKeys.pinnedConversations] });
              if (!isCurrentEffect()) {
                return;
              }
            } catch (error) {
              if (!isCurrentEffect()) {
                return;
              }
              logger.warn('ResumableSSE', 'Could not refresh settled generation history', {
                conversationId: settledConversationId,
                error,
              });
            }

            if (conversationLookup === 'not_found' && startedAsNewConvo) {
              /** A failed/early-aborted first turn can settle without ever
               * creating a conversation. Never mint A's optimistic rows here:
               * prune any partial cache and return to `/c/new` instead of
               * leaving a phantom chat/URL. */
              removeConvoFromAllQueries(queryClient, settledConversationId);
              queryClient.removeQueries({
                queryKey: [QueryKeys.conversation, settledConversationId],
              });
              queryClient.removeQueries({
                queryKey: [QueryKeys.messages, settledConversationId],
              });
              newConversation?.({
                template: { conversationId: String(Constants.NEW_CONVO) },
              });
            }
            if (conversationLookup === 'inconclusive') {
              /** A network/5xx lookup cannot prove the conversation is absent.
               * Preserve its optimistic/cache state for a later refetch and do
               * not navigate or mint a fresh `/c/new` conversation. */
              clearDrainAfterAbort(settledConversationId, submission.expectedPredecessorCreatedAt);
            }
            clearStepMaps();
            setIsSubmitting(false);
            setShowStopButton(false);
            setRunEnd({
              conversationId: settledConversationId,
              outcome: conversationLookup === 'inconclusive' ? 'error' : 'aborted',
              startedAsNewConvo,
              endedAt: Date.now(),
            });
            setSubmission(null);
            return;
          }
          if (startResult.status !== 'stream') {
            return;
          }
          const {
            streamId: newStreamId,
            resumed,
            generationCreatedAt,
            generationProtocolVersion,
          } = startResult;
          setStreamId(newStreamId);
          // Optimistically add to active jobs
          addActiveJob(newStreamId);
          // Queue title generation if this is a new conversation (first message).
          // Skip temporary conversations — the server never generates titles for
          // them, so polling would 404 indefinitely.
          const isNewConvo = isInitialNewConversation(submission);
          if (isNewConvo && !submission.isTemporary) {
            queueTitleGeneration(newStreamId);
          }
          if (isInitialNewConversation(submission)) {
            optimisticStreamIdsRef.current.add(newStreamId);
            replaceNewConversationUrl(newStreamId);
          }
          const streamSubmission = addOptimisticConversation(newStreamId, submission);
          submissionRef.current = streamSubmission;
          // A deduped retry (status: 'resumed') attaches to an already-running stream, so
          // subscribe with resume=true to replay its state instead of only live events.
          subscribeToStream(
            newStreamId,
            streamSubmission,
            resumed,
            generationCreatedAt,
            generationProtocolVersion,
            signal,
          );
        } else {
          logger.error('ResumableSSE', 'Failed to get streamId from startGeneration');
        }
      }
    };

    initStream();

    /** The Set object itself is never reassigned, so this alias reads the
     *  LIVE frame ids at cleanup time (satisfies react-hooks/exhaustive-deps
     *  without changing behavior). */
    const activityLabelRetryFrames = activityLabelRetryFramesRef.current;
    const steerRetryFrames = steerRetryFramesRef.current;
    return () => {
      logger.log('ResumableSSE', 'Cleanup - closing SSE, resetting UI state');
      startController.abort();
      // Cleanup on unmount/navigation - close connection but DO NOT abort backend
      // Reset UI state so it doesn't leak to other conversations
      // If user returns to this conversation, useResumeOnLoad will restore the state
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (pendingActionRetryRef.current != null) {
        cancelAnimationFrame(pendingActionRetryRef.current);
        pendingActionRetryRef.current = null;
      }
      for (const frameId of activityLabelRetryFrames) {
        cancelAnimationFrame(frameId);
      }
      activityLabelRetryFrames.clear();
      for (const frameId of steerRetryFrames) {
        cancelAnimationFrame(frameId);
      }
      steerRetryFrames.clear();
      stopForegroundReattachRef.current?.();
      stopForegroundReattachRef.current = null;
      // Reset reconnect counter before closing (so abort handler doesn't think we're reconnecting)
      reconnectAttemptRef.current = 0;
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }
      // Clear handler maps to prevent memory leaks and stale state
      clearStepMaps();
      // Reset UI state on ordinary cleanup. A generation handoff already
      // cached the replacement and must remain non-idle until resume-on-load
      // installs its epoch-fenced submission.
      if (!replacementHandoffRef.current) {
        setIsSubmitting(false);
        setShowStopButton(false);
      }
      replacementHandoffRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submission]);

  return { streamId };
}
