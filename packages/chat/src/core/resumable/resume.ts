import { Constants, tMessageSchema } from 'librechat-data-provider';
import type {
  Agents,
  TMessage,
  TSubmission,
  TConversation,
  EventSubmission,
} from 'librechat-data-provider';
import type { GenerationProtocolVersion } from '../protocol';
import { preferDefinedString } from './messages';
import { applyPendingAction } from '../pending';

/** A submission that attaches to a generation already running on the server instead of
 *  starting one. */
export type ResumeSubmission = TSubmission & {
  resumeStreamId: string;
  resumeGenerationCreatedAt?: number;
  resumeGenerationProtocolVersion: GenerationProtocolVersion;
};

/**
 * True when a resumed run's user-message slot is a compaction ANCHOR rather than
 * a turn the run created.
 *
 * A compaction submits no user turn: the slot names the LEAF it summarizes up
 * to, which the server projects as identity only (`projectCompactionAnchor`:
 * id, conversation, empty text, and no parent). Every other run publishes the
 * turn it created, parent included (`getPreliminaryUserMessage`), so the absent
 * parent is what separates the two.
 *
 * The anchor's author cannot separate them: Compact runs on whatever leaf the
 * branch ends with and `canCompact` does not restrict its author, so the anchor
 * is an assistant answer on one branch and a user message on the next (see
 * `isUserInitiatedCompaction`). Testing for a non-user row recognized only the
 * first kind and left the second rewritten on every re-attach.
 */
export const isCompactionAnchorProjection = (
  userMessage?: {
    messageId?: string;
    parentMessageId?: string | null;
    text?: string | null;
  } | null,
): boolean =>
  userMessage?.messageId != null &&
  userMessage.messageId !== '' &&
  userMessage.parentMessageId == null &&
  (userMessage.text == null || userMessage.text === '');

export const buildResumeEventSubmission = (
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
   * (`projectCompactionAnchor`: no parent, no author). Adopting the projection
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
    /** Carried so every consumer of the resumed submission (the merges below,
     *  the abort-error write) reads the same answer this resolved. */
    ...(anchoredUserMessage && { compact: true }),
  } as EventSubmission;
};

/**
 * Build a submission object from resume state for reconnected streams.
 * This provides the minimum data needed for useResumableSSE to subscribe.
 */
export function buildSubmissionFromResumeState(
  resumeState: Agents.ResumeState,
  streamId: string,
  messages: TMessage[],
  conversationId: string,
  generationCreatedAt?: number,
  generationProtocolVersion: GenerationProtocolVersion = 1,
  isTemporary = false,
): ResumeSubmission {
  const userMessageData = resumeState.userMessage;
  const responseMessageId =
    resumeState.responseMessageId ?? `${userMessageData?.messageId ?? 'resume'}_`;

  /**
   * The run's user-message slot as the loaded history already holds it. Message
   * ids are unique per row, so a match is that row whoever wrote it: a
   * compaction submits no user turn and puts the LEAF it summarizes up to in
   * this slot (`useCompactConversation` client-side, `projectCompactionAnchor`
   * server-side), which is usually the assistant answer. Adopting the row keeps
   * the anchor's own identity; synthesizing an empty, parentless USER row over
   * it rewrites that answer into a phantom root and folds the thread.
   */
  const existingSlotMessage = messages.find((m) => m.messageId === userMessageData?.messageId);
  /** An anchored run (a compaction) created no user turn: the slot names a row
   *  the transcript already holds. Judged from the projection's shape, never from
   *  the anchor's author, which is a user message as often as an answer. Either
   *  way the run is regenerate-shaped for every consumer: no user turn of its
   *  own, the response parented onto an existing message. */
  const isAnchoredRun = isCompactionAnchorProjection(userMessageData);

  // A trailing underscore distinguishes an in-flight regeneration from the persisted
  // response it replaces. Only the exact response id proves generation ownership.
  const existingResponseMessage = messages.find(
    (m) => !m.isCreatedByUser && m.messageId === responseMessageId,
  );
  // The persisted row may seed display metadata, but never identity or deduplication.
  const unpaddedResponseMessageId = responseMessageId.replace(/_+$/, '');
  const persistedRegenerationResponse =
    unpaddedResponseMessageId !== responseMessageId
      ? messages.find((m) => !m.isCreatedByUser && m.messageId === unpaddedResponseMessageId)
      : undefined;
  const responseMetadataMessage = existingResponseMessage ?? persistedRegenerationResponse;
  const isRegenerateResume =
    resumeState.isRegenerate === true || persistedRegenerationResponse != null || isAnchoredRun;
  let regenerateMessages: TMessage[] | undefined;
  if (isRegenerateResume) {
    regenerateMessages =
      unpaddedResponseMessageId === responseMessageId
        ? [...messages]
        : messages.filter((message) => message.messageId !== responseMessageId);
  }

  // Create or use the row the slot already names
  const userMessage: TMessage =
    existingSlotMessage ??
    (userMessageData
      ? (tMessageSchema.parse({
          messageId: userMessageData.messageId,
          parentMessageId: userMessageData.parentMessageId ?? Constants.NO_PARENT,
          conversationId: userMessageData.conversationId ?? conversationId,
          text: userMessageData.text ?? '',
          isCreatedByUser: true,
          role: 'user',
        }) as TMessage)
      : (messages[messages.length - 2] ??
        ({
          messageId: 'resume_user_msg',
          conversationId,
          text: '',
          isCreatedByUser: true,
        } as TMessage)));

  // ALWAYS use aggregatedContent from resumeState - it has the latest content from the running job.
  // DB content may be stale (saved at disconnect, but generation continued).
  let initialResponse: TMessage = {
    messageId: existingResponseMessage?.messageId ?? responseMessageId,
    parentMessageId: existingResponseMessage?.parentMessageId ?? userMessage.messageId,
    conversationId,
    text: '',
    // aggregatedContent is authoritative - it reflects actual job state
    content: (resumeState.aggregatedContent as TMessage['content']) ?? [],
    isCreatedByUser: false,
    role: 'assistant',
    sender: responseMetadataMessage?.sender ?? resumeState.sender,
    model: preferDefinedString(responseMetadataMessage?.model, resumeState.model),
    iconURL: preferDefinedString(responseMetadataMessage?.iconURL, resumeState.iconURL),
  } as TMessage;

  // Re-paused turn: seed the approval / ask-user controls straight onto the
  // placeholder so they render on load without waiting for the SSE sync replay.
  if (resumeState.pendingAction) {
    initialResponse = applyPendingAction(initialResponse, resumeState.pendingAction);
  }

  const conversation: TConversation = {
    conversationId,
    title: 'Resumed Chat',
    endpoint: null,
  } as TConversation;

  // Non-regenerate resumes strip the persisted request/response pair before handlers
  // re-supply it. A regeneration keeps the original branch for early-abort rollback;
  // explicit resume metadata covers edited regenerations that reuse the exact response id.
  const dedupedMessages = messages.filter(
    (m) =>
      m.messageId !== initialResponse.messageId &&
      (isRegenerateResume || m.messageId !== userMessage.messageId),
  );

  return {
    messages: dedupedMessages,
    userMessage,
    initialResponse,
    conversation,
    isRegenerate: isRegenerateResume,
    ...(isAnchoredRun && { compact: true }),
    ...(regenerateMessages && { regenerateMessages }),
    isTemporary,
    endpointOption: {},
    // Signal to useResumableSSE to subscribe to existing stream instead of starting new
    resumeStreamId: streamId,
    ...(generationCreatedAt != null && { resumeGenerationCreatedAt: generationCreatedAt }),
    resumeGenerationProtocolVersion: generationProtocolVersion,
  } as ResumeSubmission;
}

/**
 * The submission for a running generation whose status carries no resume state (an older
 * server): the loaded history's last user turn and an empty placeholder response under it.
 * The placeholder is a parented assistant row, so a failure the reattached stream reports
 * still parses into the error turn.
 */
export function buildMinimalResumeSubmission({
  messages,
  streamId,
  createdAt,
  isTemporary,
  conversationId,
  aggregatedContent,
  generationProtocolVersion,
}: {
  messages: TMessage[];
  streamId: string;
  createdAt?: number;
  isTemporary: boolean;
  conversationId: string;
  aggregatedContent?: Array<{ type: string; text?: string }>;
  generationProtocolVersion: GenerationProtocolVersion;
}): ResumeSubmission {
  const lastUserMessage = [...messages].reverse().find((m) => m.isCreatedByUser);
  const userMessage =
    lastUserMessage ??
    ({ messageId: 'resume', conversationId, text: '', isCreatedByUser: true } as TMessage);
  return {
    messages,
    userMessage,
    initialResponse: {
      messageId: 'resume_',
      parentMessageId: userMessage.messageId,
      conversationId,
      text: '',
      content: aggregatedContent ?? [{ type: 'text', text: '' }],
      isCreatedByUser: false,
    } as TMessage,
    conversation: { conversationId, title: 'Resumed Chat' } as TConversation,
    isRegenerate: false,
    isTemporary,
    endpointOption: {},
    // Signal to useResumableSSE to subscribe to existing stream instead of starting new
    resumeStreamId: streamId,
    ...(createdAt != null && { resumeGenerationCreatedAt: createdAt }),
    resumeGenerationProtocolVersion: generationProtocolVersion,
  } as ResumeSubmission;
}
