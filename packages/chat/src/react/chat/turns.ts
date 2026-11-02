import { useCallback, useEffect, useRef } from 'react';
import { useStore, useSetAtom } from 'jotai';
import { Constants, EModelEndpoint, isAssistantsEndpoint } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { TAskFunction, TRegenerateFunction } from '../../core';
import type { ChatTurnsParams, TurnServices } from './host';
import {
  getReasoningStateKey,
  pendingQuotesByConvoId,
  pendingManualSkillsByConvoId,
  pendingReasoningOverrideFamily,
} from '../composer';
import {
  buildTurn,
  createRegenerate,
  isSubmittableMessage,
  hasPendingAssistantParent,
} from '../../core';
import { submissionStartFamily, showStopButtonByIndex } from '../generation';
import { revealedQueuedTurnFamily } from '../steer/atoms';
import { isSubmittingFamily } from '../submission';

/**
 * Submits and regenerates turns for one pane: refuses a send the chat cannot take yet, drains
 * the composer's queued skills, quotes and reasoning, builds the turn and publishes it. The app
 * supplies only what it owns through `services`: its endpoint and agent catalogs, routing,
 * composer files, code workspace and logging.
 */
export function useTurns(
  {
    index,
    files,
    setFiles,
    getMessages,
    setMessages,
    isSubmitting,
    latestMessage,
    setSubmission,
    setConversation,
    conversation: immutableConversation,
  }: ChatTurnsParams,
  services: TurnServices,
): { ask: TAskFunction; regenerate: TRegenerateFunction } {
  const store = useStore();
  const setIsSubmitting = useSetAtom(isSubmittingFamily(index));
  const setSubmissionStart = useSetAtom(submissionStartFamily(index));
  const setShowStopButton = useSetAtom(showStopButtonByIndex(index));
  const { logger } = services;

  /**
   * `ask` refuses while `isSubmitting`, but that value only reads true from the next commit
   * onwards: a double Enter or a double click inside one browser task would both pass that
   * check and start two generations. This ref closes the gap synchronously, matching the queue
   * send lock shared by `useSteering` and `useQueueDrain`.
   *
   * Released on every commit that is not submitting rather than only on a `true -> false`
   * transition: a start that never flips `isSubmitting` here (Assistants set it from the SSE
   * handler, and a start that fails outright never sets it at all) would otherwise latch the
   * composer shut for good.
   */
  const askInFlightRef = useRef(false);
  useEffect(() => {
    if (!isSubmitting) {
      askInFlightRef.current = false;
    }
  });

  /**
   * Reads and resets one per-conversation composer queue (manual skills, quoted excerpts) in a
   * single synchronous store pass, so an item queued between here and the submission is never
   * lost into a reset atom.
   */
  const drain = useCallback(
    (family: typeof pendingQuotesByConvoId, convoId: string): string[] => {
      const items = store.get(family(convoId));
      if (items.length > 0) {
        store.set(family(convoId), []);
      }
      return items;
    },
    [store],
  );

  const drainPendingReasoning = useCallback(
    (stateKey: string): TMessage['reasoningOverride'] => {
      const reasoningAtom = pendingReasoningOverrideFamily(stateKey);
      const reasoningOverride = store.get(reasoningAtom);
      if (reasoningOverride != null) {
        store.set(reasoningAtom, undefined);
      }
      return reasoningOverride;
    },
    [store],
  );

  const ask: TAskFunction = (
    {
      text,
      overrideConvoId,
      overrideUserMessageId,
      parentMessageId = null,
      conversationId = null,
      messageId = null,
    },
    {
      editedContent = null,
      editedMessageId = null,
      isRegenerate = false,
      isContinued = false,
      isEdited = false,
      compact = false,
      overrideMessages,
      overrideFiles,
      targetResponseMessageId,
      overrideManualSkills,
      overrideQuotes,
      overrideReasoning,
      addedConvo,
      overrideClientRequestId,
      overrideRecoverySteerId,
      overrideExpectedPredecessorCreatedAt,
      overrideQueuedMessageOrigin,
    } = {},
  ) => {
    text = text.trim();
    /**
     * Attached files make an otherwise empty draft submittable, e.g. replying to an agent that
     * asked for a document upload. When a caller supplies `overrideFiles`, that array is
     * authoritative, even when empty. A text-only App action must not become submittable just
     * because the user has staged a file for a different, unsent composer message.
     */
    const availableFileCount = overrideFiles == null ? (files?.size ?? 0) : overrideFiles.length;
    /** A compaction sends no text: it replays the branch, like a regenerate, with the response
     *  placeholder parented onto the leaf. */
    const regenerateShaped = isRegenerate || compact;
    if (
      askInFlightRef.current ||
      !!isSubmitting ||
      store.get(revealedQueuedTurnFamily(immutableConversation?.conversationId ?? '')) != null ||
      (!regenerateShaped && !isSubmittableMessage(text, availableFileCount))
    ) {
      return false;
    }

    /** The builder resolves `promptPrefix` on its copy; the pane's conversation stays as is. */
    const conversation = immutableConversation == null ? null : { ...immutableConversation };
    const codeDecision = services.resolveCode(conversation);
    if (codeDecision == null) {
      logger.warn('[useTurns] Refusing to send without an available code workspace');
      return false;
    }

    const endpoint = conversation?.endpoint;
    if (endpoint === null) {
      console.error('No endpoint available');
      return false;
    }

    conversationId = conversationId ?? conversation?.conversationId ?? null;
    if (conversationId == 'search') {
      console.error('cannot send any message under search view!');
      return false;
    }

    const cachedMessages = getMessages(conversationId);
    const isExistingConversation = conversationId != null && conversationId !== Constants.NEW_CONVO;
    if (isExistingConversation && overrideMessages == null && cachedMessages == null) {
      logger.warn('[useTurns] Refusing to send before existing conversation history loads');
      return false;
    }

    /**
     * Warm-switch revalidation guard: a navigation invalidates the target's cache and renders it
     * while a background refetch reconciles. Deriving parentMessageId from that cache could fork
     * from an outdated tail, so refuse (the composer keeps the text) until the refetch settles.
     */
    if (
      isExistingConversation &&
      overrideMessages == null &&
      services.isHistoryRevalidating(conversationId)
    ) {
      logger.warn('[useTurns] Refusing to send while conversation history revalidates');
      return false;
    }

    if (isContinued && !latestMessage) {
      console.error('cannot continue AI message without latestMessage!');
      return false;
    }

    if (parentMessageId == null && hasPendingAssistantParent(latestMessage)) {
      logger.warn(
        '[useTurns] Refusing to append to a preliminary assistant message',
        latestMessage,
      );
      return false;
    }

    setShowStopButton(false);

    const convoKey = conversationId ?? Constants.NEW_CONVO;
    const endpointsConfig = services.getEndpointsConfig();
    /**
     * Manual skills: an explicit `overrideManualSkills` wins (regenerate and resubmit replay the
     * original user message's picks); a regenerate, continue or edit without one sends none and
     * leaves the compose-time queue alone; a fresh submit drains the queue into the message.
     */
    const replaysTurn = regenerateShaped || isContinued || isEdited;
    const manualSkills =
      overrideManualSkills ?? (replaysTurn ? [] : drain(pendingManualSkillsByConvoId, convoKey));
    /**
     * Quoted excerpts resolve like manual skills, but are skipped entirely for Assistants
     * endpoints: those bypass the server's quote merge, so the quote UI is hidden there and a
     * selection queued on another endpoint must not ride along. The queue is left untouched so
     * it survives a switch back.
     */
    let quotes: string[] = [];
    if (!isAssistantsEndpoint(endpoint)) {
      quotes = overrideQuotes ?? (replaysTurn ? [] : drain(pendingQuotesByConvoId, convoKey));
    }
    let reasoningOverride = overrideReasoning ?? undefined;
    const reasoningStateKey = getReasoningStateKey(conversationId, index);
    const drainedReasoning = overrideReasoning === undefined && !replaysTurn;
    if (drainedReasoning) {
      reasoningOverride = drainPendingReasoning(reasoningStateKey);
    }
    const stagedReasoning = reasoningOverride;
    if (reasoningOverride != null) {
      const resolved = services.resolveReasoning({
        endpoint,
        conversation,
        endpointsConfig,
        reasoningOverride,
      });
      reasoningOverride = resolved.reasoningOverride;
      /** Refused only because the catalog is not loaded yet: put a drained choice back. */
      if (resolved.retryable && drainedReasoning && stagedReasoning != null) {
        store.set(pendingReasoningOverrideFamily(reasoningStateKey), stagedReasoning);
      }
    }

    const turn = buildTurn({
      text,
      params: { text, overrideConvoId, overrideUserMessageId, parentMessageId, messageId },
      options: {
        editedContent: editedContent ?? undefined,
        editedMessageId,
        isRegenerate,
        isContinued,
        isEdited,
        compact,
        overrideMessages,
        overrideFiles,
        targetResponseMessageId,
        addedConvo,
        overrideClientRequestId,
        overrideRecoverySteerId,
        overrideExpectedPredecessorCreatedAt,
        overrideQueuedMessageOrigin,
      },
      conversationId,
      conversation,
      latestMessage,
      cachedMessages,
      files,
      canClearFiles: setFiles != null,
      routeProjectId: services.getRouteProjectId(),
      endpointsConfig,
      modelSpecs: services.modelSpecs,
      user: services.user,
      isTemporary: services.isTemporary,
      ephemeralAgent: services.getEphemeralAgent(convoKey),
      getSender: services.getSender,
      userKey: endpoint !== EModelEndpoint.agents ? services.getUserKey() : undefined,
      manualSkills,
      quotes,
      reasoningOverride,
      code: codeDecision.code,
    });
    const { submission, currentMsg, initialResponse, submissionMessages, fileEffects } = turn;
    conversationId = turn.conversationId;
    logger.log('message_state', initialResponse);

    if (turn.newChatPath != null) {
      services.openNewChat(turn.newChatPath);
    }
    if (fileEffects != null && setFiles) {
      services.releaseFiles(fileEffects.submittedFileIds);
      if (fileEffects.clearComposer) {
        setFiles(new Map());
        services.clearFilesToDelete();
      }
    }
    if (turn.startsSubmitting) {
      setIsSubmitting(true);
      setShowStopButton(true);
    }

    /** Bound before the optimistic tail is published, not after the first provider event: a
     *  waiting request already owns a turn even when no usage exists. */
    services.bindResponse(conversationId ?? Constants.NEW_CONVO, initialResponse.messageId);

    if (turn.regenerateShaped) {
      setMessages([...submissionMessages, initialResponse]);
      services.focusResponse(initialResponse.parentMessageId);
    } else {
      setMessages([...submissionMessages, currentMsg, initialResponse]);
    }

    /** Carries the submitted choice through the first saved-chat event instead of re-deriving
     *  it from agent defaults. Optimistic: the stream's error path reconciles an existing chat
     *  with its authoritative server decision if admission fails. */
    setConversation((current) =>
      current == null || current.conversationId !== conversation?.conversationId
        ? current
        : codeDecision.apply(current),
    );
    /** Armed at the point of no return: every refusal above returns before it, so a rejected
     *  send never has to unwind the guard, and `ask` runs to completion synchronously, which is
     *  the whole window it has to cover. */
    askInFlightRef.current = true;
    setSubmissionStart(Date.now());
    services.bindLaunch(submission.conversation, index);
    setSubmission(submission);
    logger.dir('message_stream', {
      conversationId,
      messageId: currentMsg.messageId,
      parentMessageId: currentMsg.parentMessageId,
      isEdited: turn.isEditOrContinue,
      isRegenerate: turn.regenerateShaped,
      isContinued,
    });
  };

  return { ask, regenerate: createRegenerate(ask, getMessages) };
}
