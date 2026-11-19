import { useCallback, useEffect, useRef } from 'react';
import { useStore, useSetAtom } from 'jotai';
import { useQueryClient } from '@tanstack/react-query';
import { Constants, EModelEndpoint, isAssistantsEndpoint } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { TAskFunction, TAskProps, TOptions, TRegenerateFunction } from '../../core';
import type { ChatTurnsParams, TurnServices, TurnReadiness } from './host';
import {
  buildTurn,
  resolveSender,
  createRegenerate,
  isSubmittableMessage,
  isInlineablePastedText,
  markComposerFilesTaken,
  hasPendingAssistantParent,
} from '../../core';
import {
  getReasoningStateKey,
  pendingQuotesByConvoId,
  pendingManualSkillsByConvoId,
  pendingReasoningOverrideFamily,
} from '../composer';
import {
  submissionStartFamily,
  showStopButtonByIndex,
  launchedConversationFamily,
} from '../generation';
import { resolveTurnCodeResult } from '../../core/code/turn';
import { revealedQueuedTurnFamily } from '../steer/atoms';
import { siblingIdxFamily, siblingKey } from '../thread';
import { resolveSubmittedReasoning } from './reasoning';
import { activeUsageResponseIdFamily } from '../usage';
import { isSubmittingFamily } from '../submission';
import { isHistoryRevalidating } from './guards';
import { filesFamily } from '../pane';

type Attempt = 'accepted' | 'pending' | 'blocked';
type Submit = (props: TAskProps, options?: TOptions, automatic?: boolean) => Attempt;
type Admission = {
  readiness: () => TurnReadiness;
  accepted: () => boolean;
  committed?: () => void;
};

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
    getLatestMessage,
    setSubmission,
    setConversation,
    conversation: immutableConversation,
  }: ChatTurnsParams,
  services: TurnServices,
  admission?: Admission,
): { ask: TAskFunction; attempt: (text: string) => Attempt; regenerate: TRegenerateFunction } {
  const store = useStore();
  const queryClient = useQueryClient();
  const setIsSubmitting = useSetAtom(isSubmittingFamily(index));
  const setSubmissionStart = useSetAtom(submissionStartFamily(index));
  const setShowStopButton = useSetAtom(showStopButtonByIndex(index));
  const { logger } = services;
  const deferred = admission != null;

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

  const submit: Submit = (
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
    automatic = false,
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
    /** An accepted or revealed local turn is newer explicit intent; it must not arm an
     * automatic retry. Temporary transport/workspace phases below keep their pending intent. */
    if (askInFlightRef.current) {
      if (!automatic) return 'blocked';
      const readiness = admission?.readiness() ?? 'pending';
      if (readiness !== 'ready') return readiness;
    }
    if (
      store.get(revealedQueuedTurnFamily(immutableConversation?.conversationId ?? '')) != null ||
      (!regenerateShaped && !isSubmittableMessage(text, availableFileCount))
    ) {
      return 'blocked';
    }
    if (isSubmitting) return 'pending';

    if (!regenerateShaped && overrideFiles == null && files != null) {
      for (const file of files.values()) {
        if (file.progress < 1 && !isInlineablePastedText(file)) {
          return 'pending';
        }
      }
    }

    /** The builder resolves `promptPrefix` on its copy; the pane's conversation stays as is. */
    const conversation = immutableConversation == null ? null : { ...immutableConversation };
    if (services.canSubmit?.(conversation) === false) {
      return admission?.readiness() === 'pending' ? 'pending' : 'blocked';
    }
    const codeResult = resolveTurnCodeResult(services.readCodeInputs(), conversation);
    if (codeResult.state !== 'ready') {
      if (!automatic)
        logger.warn('[useTurns] Refusing to send without an available code workspace');
      return codeResult.state;
    }
    const codeDecision = codeResult.decision;

    const endpoint = conversation?.endpoint;
    if (endpoint === null) {
      console.error('No endpoint available');
      return 'blocked';
    }

    conversationId = conversationId ?? conversation?.conversationId ?? null;
    if (conversationId == 'search') {
      console.error('cannot send any message under search view!');
      return 'blocked';
    }

    const cachedMessages = getMessages(conversationId);
    const isExistingConversation = conversationId != null && conversationId !== Constants.NEW_CONVO;
    if (isExistingConversation && overrideMessages == null && cachedMessages == null) {
      if (!automatic)
        logger.warn('[useTurns] Refusing to send before existing conversation history loads');
      return 'pending';
    }

    /**
     * Warm-switch revalidation guard: a navigation invalidates the target's cache and renders it
     * while a background refetch reconciles. Deriving parentMessageId from that cache could fork
     * from an outdated tail, so refuse (the composer keeps the text) until the refetch settles.
     */
    if (
      isExistingConversation &&
      overrideMessages == null &&
      isHistoryRevalidating(queryClient, conversationId)
    ) {
      if (!automatic)
        logger.warn('[useTurns] Refusing to send while conversation history revalidates');
      return 'pending';
    }

    const latestMessage = getLatestMessage();
    if (isContinued && !latestMessage) {
      console.error('cannot continue AI message without latestMessage!');
      return 'blocked';
    }

    if (parentMessageId == null && hasPendingAssistantParent(latestMessage)) {
      if (!automatic)
        logger.warn(
          '[useTurns] Refusing to append to a preliminary assistant message',
          latestMessage,
        );
      return 'pending';
    }

    if (!deferred) setShowStopButton(false);

    const convoKey = conversationId ?? Constants.NEW_CONVO;
    const endpointsConfig = services.getEndpointsConfig();
    /**
     * Manual skills: an explicit `overrideManualSkills` wins (regenerate and resubmit replay the
     * original user message's picks); a regenerate, continue or edit without one sends none and
     * leaves the compose-time queue alone; a fresh submit drains the queue into the message.
     */
    const replaysTurn = regenerateShaped || isContinued || isEdited;
    const take = (family: typeof pendingQuotesByConvoId): string[] =>
      deferred ? store.get(family(convoKey)) : drain(family, convoKey);
    const manualSkills =
      overrideManualSkills ?? (replaysTurn ? [] : take(pendingManualSkillsByConvoId));
    /**
     * Quoted excerpts resolve like manual skills, but are skipped entirely for Assistants
     * endpoints: those bypass the server's quote merge, so the quote UI is hidden there and a
     * selection queued on another endpoint must not ride along. The queue is left untouched so
     * it survives a switch back.
     */
    let quotes: string[] = [];
    if (!isAssistantsEndpoint(endpoint)) {
      quotes = overrideQuotes ?? (replaysTurn ? [] : take(pendingQuotesByConvoId));
    }
    let reasoningOverride = overrideReasoning ?? undefined;
    const reasoningStateKey = getReasoningStateKey(conversationId, index);
    const drainedReasoning = overrideReasoning === undefined && !replaysTurn;
    if (drainedReasoning) {
      reasoningOverride = deferred
        ? store.get(pendingReasoningOverrideFamily(reasoningStateKey))
        : drainPendingReasoning(reasoningStateKey);
    }
    const stagedReasoning = reasoningOverride;
    let keepReasoning = false;
    if (reasoningOverride != null) {
      const resolved = resolveSubmittedReasoning({
        queryClient,
        agentsMap: services.agentsMap,
        endpoint,
        conversation,
        endpointsConfig,
        reasoningOverride,
        drainedReasoning: true,
        stagedReasoning: reasoningOverride,
      });
      reasoningOverride = resolved.reasoningOverride;
      /** Refused only because the catalog is not loaded yet: put a drained choice back. */
      keepReasoning = resolved.restoreStaged;
      if (!deferred && resolved.restoreStaged && drainedReasoning && stagedReasoning != null) {
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
      getSender: (endpointOption) =>
        resolveSender(endpointOption, endpointsConfig, services.modelSpecs),
      userKey: endpoint !== EModelEndpoint.agents ? services.getUserKey() : undefined,
      manualSkills,
      quotes,
      reasoningOverride,
      code: codeDecision.code,
    });
    const { submission, currentMsg, initialResponse, submissionMessages, fileEffects } = turn;
    conversationId = turn.conversationId;
    logger.log('message_state', initialResponse);

    const capturedFiles = deferred && fileEffects && files ? new Map(files) : undefined;
    const ownsUpload =
      deferred && fileEffects
        ? services.captureFileOwnership?.(
            [
              ...fileEffects.submittedFileIds,
              ...(fileEffects.canceledUploadIds ?? []),
              ...(fileEffects.replacedFileIds ?? []),
            ].filter((id): id is string => !!id),
          )
        : undefined;
    const ownsFile = (id: string): boolean => {
      if (!deferred) return true;
      if (ownsUpload?.(id) === false) return false;
      for (const [key, file] of store.get(filesFamily(index))) {
        if (capturedFiles?.get(key) === file) continue;
        if (
          key === id ||
          file.file_id === id ||
          file.temp_file_id === id ||
          file.replacesFileId === id
        )
          return false;
      }
      return true;
    };
    // Accepted server refs must remain protected from deletion even when deliberately reattached.
    const durableIds = deferred
      ? new Set(currentMsg.files?.map((file) => file.file_id))
      : undefined;
    const clearFilesToDelete =
      deferred && fileEffects?.clearComposer
        ? (services.captureFilesToDelete?.(Array.from(capturedFiles?.keys() ?? []), ownsFile) ??
          services.clearFilesToDelete)
        : services.clearFilesToDelete;
    const commitComposer = (): void => {
      if (turn.newChatPath != null) {
        services.openNewChat(turn.newChatPath);
      }
      if (fileEffects != null && setFiles) {
        const takenIds = [
          ...(fileEffects.canceledUploadIds ?? []),
          ...(fileEffects.replacedFileIds ?? []),
        ];
        markComposerFilesTaken(deferred ? takenIds.filter(ownsFile) : takenIds);
        if (!deferred) {
          services.releaseFiles(fileEffects.submittedFileIds);
          if (fileEffects.canceledUploadIds?.length)
            services.cancelUploads?.(fileEffects.canceledUploadIds);
          if (fileEffects.replacedFileIds?.length)
            services.discardFiles?.(fileEffects.replacedFileIds);
        } else {
          for (const id of new Set(fileEffects.submittedFileIds)) {
            if (id && (durableIds?.has(id) || ownsFile(id))) services.releaseFiles([id]);
          }
          for (const id of fileEffects.canceledUploadIds ?? []) {
            if (ownsFile(id)) services.cancelUploads?.([id], ownsFile);
          }
          for (const id of fileEffects.replacedFileIds ?? []) {
            if (ownsFile(id)) services.discardFiles?.([id], ownsFile);
          }
        }
        if (fileEffects.clearComposer) {
          if (!deferred) setFiles(new Map());
          else
            setFiles((current) => {
              let next = current;
              for (const [key, file] of capturedFiles ?? []) {
                if (current.get(key) !== file) continue;
                if (next === current) next = new Map(current);
                next.delete(key);
              }
              return next;
            });
          clearFilesToDelete();
        }
      }
      if (turn.startsSubmitting) {
        setIsSubmitting(true);
        setShowStopButton(true);
      }

      /** Bound before the optimistic tail is published, not after the first provider event: a
       *  waiting request already owns a turn even when no usage exists. */
      store.set(
        activeUsageResponseIdFamily(conversationId ?? Constants.NEW_CONVO),
        initialResponse.messageId,
      );
    };
    if (!deferred) commitComposer();

    if (turn.regenerateShaped) {
      setMessages([...submissionMessages, initialResponse]);
      if (!deferred && initialResponse.parentMessageId != null) {
        store.set(siblingIdxFamily(siblingKey(initialResponse.parentMessageId)), 0);
      }
    } else {
      setMessages([...submissionMessages, currentMsg, initialResponse]);
    }

    /** Carries the submitted choice through the first saved-chat event instead of re-deriving
     *  it from agent defaults. Optimistic: the stream's error path reconciles an existing chat
     *  with its authoritative server decision if admission fails. */
    const commitConversation = (): void => {
      setConversation((current) =>
        current == null || current.conversationId !== conversation?.conversationId
          ? current
          : codeDecision.apply(current),
      );
    };
    if (!deferred) commitConversation();
    /** Close the synchronous double-submit window before publication. A driven owner that
     * declines after preflight releases this attempt's lock below. */
    askInFlightRef.current = true;
    const commitLaunch = (): void => {
      setSubmissionStart(Date.now());
      store.set(launchedConversationFamily(index), submission.conversation);
    };
    if (!deferred) commitLaunch();
    setSubmission(submission);
    if (admission?.accepted() === false) {
      askInFlightRef.current = false;
      return admission.readiness() === 'pending' ? 'pending' : 'blocked';
    }
    if (deferred) {
      /** Remove only what this accepted turn captured; publication can stage newer inputs. */
      const consume = (family: typeof pendingQuotesByConvoId, captured: string[]): void => {
        if (captured.length === 0) return;
        store.set(family(convoKey), (current) => {
          if (current === captured) return [];
          const sent = new Set(captured);
          const remaining = current.filter((value) => !sent.has(value));
          return remaining.length === current.length ? current : remaining;
        });
      };
      if (!replaysTurn && overrideManualSkills == null)
        consume(pendingManualSkillsByConvoId, manualSkills);
      if (!replaysTurn && overrideQuotes == null && !isAssistantsEndpoint(endpoint))
        consume(pendingQuotesByConvoId, quotes);
      if (drainedReasoning && !keepReasoning && stagedReasoning != null) {
        store.set(pendingReasoningOverrideFamily(reasoningStateKey), (current) =>
          current === stagedReasoning ? undefined : current,
        );
      }
      setShowStopButton(false);
      commitComposer();
      if (turn.regenerateShaped && initialResponse.parentMessageId != null)
        store.set(siblingIdxFamily(siblingKey(initialResponse.parentMessageId)), 0);
      commitConversation();
      commitLaunch();
      admission.committed?.();
    }
    logger.dir('message_stream', {
      conversationId,
      messageId: currentMsg.messageId,
      parentMessageId: currentMsg.parentMessageId,
      isEdited: turn.isEditOrContinue,
      isRegenerate: turn.regenerateShaped,
      isContinued,
    });
    return 'accepted';
  };
  const ask: TAskFunction = (...args) => (submit(...args) === 'accepted' ? undefined : false);
  const attempt = (text: string): Attempt => submit({ text }, undefined, true);

  return { ask, attempt, regenerate: createRegenerate(ask, getMessages) };
}
