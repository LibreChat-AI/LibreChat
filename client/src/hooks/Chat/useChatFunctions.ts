import { useCallback, useEffect, useRef } from 'react';
import { cloneDeep } from 'lodash';
import { useStore, useSetAtom } from 'jotai';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { hasPendingAssistantParent } from '@librechat/chat';
import {
  Constants,
  QueryKeys,
  EModelEndpoint,
  isAssistantsEndpoint,
} from 'librechat-data-provider';
import {
  isSubmittingFamily,
  submissionStartFamily,
  showStopButtonByIndex,
  revealedQueuedTurnFamily,
} from '@librechat/chat/react';
import {
  getReasoningStateKey,
  pendingQuotesByConvoId,
  pendingManualSkillsByConvoId,
  pendingReasoningOverrideFamily,
} from '@librechat/chat/react';
import type {
  TMessage,
  TSubmission,
  TConversation,
  TEndpointsConfig,
} from 'librechat-data-provider';
import type { Dispatch, SetStateAction } from 'react';
import type { TAskFunction, ExtendedFile } from '~/common';
import {
  logger,
  requestChatFocus,
  markPasteSubmitted,
  isSubmittableMessage,
  bindComposerLaunch,
} from '~/utils';
import {
  withSubmittedCodeDecision,
  resolveSubmittedCodeApprovalMode,
} from '~/hooks/Agents/codeDecision';
import { activeUsageResponseIdFamily } from '~/components/Chat/Input/TokenUsage/store';
import useFocusRegeneratedResponse from '~/hooks/Chat/useFocusRegeneratedResponse';
import useGetConversation from '~/hooks/Conversations/useGetConversation';
import useCodeApprovalMode from '~/hooks/Agents/useCodeApprovalMode';
import useSetFilesToDelete from '~/hooks/Files/useSetFilesToDelete';
import { useAgentsMapContext } from '~/Providers/AgentsMapContext';
import { useChatSettings } from '~/Providers/ChatSettingsContext';
import useCodeWorkspace from '~/hooks/Agents/useCodeWorkspace';
import useGetSender from '~/hooks/Conversations/useGetSender';
import { resolveSubmittedReasoning } from './ask/reasoning';
import { isHistoryRevalidating } from './ask/guards';
import { createRegenerate } from './ask/regenerate';
import useUserKey from '~/hooks/Input/useUserKey';
import { buildTurn } from './ask/turn';

export {
  getRegenerateTargetResponseMessage,
  getRegenerateSubmissionMessages,
  getPreliminaryRegenerateResponseMessageId,
} from '@librechat/chat';

export default function useChatFunctions({
  index = 0,
  files,
  setFiles,
  getMessages,
  setMessages,
  isSubmitting,
  latestMessage,
  setSubmission,
  setConversation,
  conversation: immutableConversation,
}: {
  index?: number;
  isSubmitting: boolean;
  paramId?: string | undefined;
  conversation: TConversation | null;
  latestMessage: TMessage | null;
  getMessages: (conversationId?: string | null) => TMessage[] | undefined;
  setMessages: (messages: TMessage[]) => void;
  files?: Map<string, ExtendedFile>;
  setFiles?: Dispatch<SetStateAction<Map<string, ExtendedFile>>>;
  setSubmission: Dispatch<SetStateAction<TSubmission | null>>;
  /** Supplied by the host that owns the conversation atom, so a send records the decision it
   *  established without this hook becoming a second writer of that state. */
  setConversation: Dispatch<SetStateAction<TConversation | null>>;
}) {
  const navigate = useNavigate();
  const reasoningStore = useStore();
  const getSender = useGetSender();
  const queryClient = useQueryClient();
  const setFilesToDelete = useSetFilesToDelete();
  const agentsMap = useAgentsMapContext();
  const { isTemporary, config, auth, getEphemeralAgent, addedConversation } = useChatSettings();
  const { getExpiry } = useUserKey(immutableConversation?.endpoint ?? '');
  const setIsSubmitting = useSetAtom(isSubmittingFamily(index));
  const setSubmissionStart = useSetAtom(submissionStartFamily(index));
  const setShowStopButton = useSetAtom(showStopButtonByIndex(index));
  const focusRegeneratedResponse = useFocusRegeneratedResponse();
  const jotaiStore = useStore();
  const getConversation = useGetConversation(index);
  const codeWorkspaceState = useCodeWorkspace(immutableConversation, addedConversation);
  const { modes: codeApprovalModes, selected: fallbackCodeApprovalMode } = useCodeApprovalMode(
    immutableConversation,
    addedConversation,
    codeWorkspaceState.mode,
  );

  /**
   * `ask` refuses while `isSubmitting`, but that Recoil value only reads true
   * from the next commit onwards: a double Enter or a double click inside one
   * browser task would both pass that check and start two generations. This
   * ref closes the gap synchronously, matching the queue send lock shared by
   * `useSteering` and `useQueueDrain`.
   *
   * Released on every commit that is not submitting rather than only on a
   * `true -> false` transition: a start that never flips `isSubmitting` here
   * (Assistants set it from the SSE handler, and a start that fails outright
   * never sets it at all) would otherwise latch the composer shut for good.
   */
  const askInFlightRef = useRef(false);
  useEffect(() => {
    if (!isSubmitting) {
      askInFlightRef.current = false;
    }
  });

  /**
   * Atomically read + reset the per-conversation queue of manually-invoked
   * skills from the `$` popover. Reading and resetting in one synchronous
   * store pass guarantees that if the user selects more skills between here and
   * the next submission, their picks are never silently lost into a reset atom.
   *
   * The `hasValue` guard is defensive: this atom has a synchronous default of
   * `[]` so `.contents` is always the resolved value in practice, but reading
   * `.contents` on a loading/errored loadable yields a Promise/Error, which
   * would make the `string[]` cast unsound.
   */
  const drainPendingManualSkills = useCallback(
    (convoId: string): string[] => {
      const skills = jotaiStore.get(pendingManualSkillsByConvoId(convoId));
      if (skills.length > 0) {
        jotaiStore.set(pendingManualSkillsByConvoId(convoId), []);
      }
      return skills;
    },
    [jotaiStore],
  );

  /**
   * Atomically read + reset the per-conversation queue of quoted excerpts the
   * user added via the "Add to chat" selection popup. Mirrors
   * `drainPendingManualSkills`: a single snapshot read + reset so excerpts
   * added between here and submission are never lost into a reset atom.
   */
  const drainPendingQuotes = useCallback(
    (convoId: string): string[] => {
      const quotes = jotaiStore.get(pendingQuotesByConvoId(convoId));
      if (quotes.length > 0) {
        jotaiStore.set(pendingQuotesByConvoId(convoId), []);
      }
      return quotes;
    },
    [jotaiStore],
  );

  const drainPendingReasoning = useCallback(
    (stateKey: string): TMessage['reasoningOverride'] => {
      const reasoningAtom = pendingReasoningOverrideFamily(stateKey);
      const reasoningOverride = reasoningStore.get(reasoningAtom);
      if (reasoningOverride != null) {
        reasoningStore.set(reasoningAtom, undefined);
      }
      return reasoningOverride;
    },
    [reasoningStore],
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
     * Attached files make an otherwise empty draft submittable, e.g. replying
     * to an agent that asked for a document upload. When a caller supplies
     * `overrideFiles`, that array is authoritative, even when empty. A text-only
     * App action must not become submittable just because the user has staged
     * a file for a different, unsent composer message.
     */
    const availableFileCount = overrideFiles == null ? (files?.size ?? 0) : overrideFiles.length;
    /** A compaction sends no text: it replays the branch, like a regenerate,
     *  with the response placeholder parented onto the leaf. */
    const regenerateShaped = isRegenerate || compact;
    if (
      askInFlightRef.current ||
      !!isSubmitting ||
      jotaiStore.get(revealedQueuedTurnFamily(immutableConversation?.conversationId ?? '')) !=
        null ||
      (!regenerateShaped && !isSubmittableMessage(text, availableFileCount))
    ) {
      return false;
    }

    const conversation = cloneDeep(immutableConversation);
    const latestCodeApprovalMode = getConversation()?.codeApprovalMode;
    const latestCodeWorkspaces = getConversation()?.codeWorkspaces ?? conversation?.codeWorkspaces;
    const latestCodeEnvironmentMode =
      getConversation()?.codeEnvironmentMode ?? conversation?.codeEnvironmentMode;
    const workspaceSubmission = codeWorkspaceState.resolveSubmission(
      latestCodeWorkspaces,
      latestCodeEnvironmentMode,
    );
    if (workspaceSubmission == null) {
      logger.warn('[useChatFunctions] Refusing to send without an available code workspace');
      return false;
    }
    const { codeEnvironmentMode, codeWorkspaces } = workspaceSubmission;
    const codeApprovalMode = resolveSubmittedCodeApprovalMode({
      requested: latestCodeApprovalMode,
      modes: codeApprovalModes,
      fallback: fallbackCodeApprovalMode,
      codeEnvironmentMode,
    });

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
      logger.warn('[useChatFunctions] Refusing to send before existing conversation history loads');
      return false;
    }

    /**
     * Warm-switch revalidation guard: a navigation invalidates the target's
     * cache and renders it while a background refetch reconciles. Deriving
     * parentMessageId from that cache could fork from an outdated tail, so
     * refuse (composer keeps the text) until the refetch settles, but only
     * when the cache is actually old: a just-streamed cache (fresh
     * `dataUpdatedAt`) is locally authoritative, and gating it would block
     * rapid follow-ups during the post-run reconcile.
     */
    if (isExistingConversation && overrideMessages == null) {
      const isStale = isHistoryRevalidating(queryClient, conversationId);
      if (isStale) {
        logger.warn('[useChatFunctions] Refusing to send while conversation history revalidates');
        return false;
      }
    }

    if (isContinued && !latestMessage) {
      console.error('cannot continue AI message without latestMessage!');
      return false;
    }

    if (parentMessageId == null && hasPendingAssistantParent(latestMessage)) {
      logger.warn(
        '[useChatFunctions] Refusing to append to a preliminary assistant message',
        latestMessage,
      );
      return false;
    }

    setShowStopButton(false);

    const ephemeralAgent = getEphemeralAgent(conversationId ?? Constants.NEW_CONVO);
    const endpointsConfig = queryClient.getQueryData<TEndpointsConfig>([QueryKeys.endpoints]);
    /**
     * Manual skill selection resolution:
     *  - Explicit `overrideManualSkills` wins (regenerate / save-and-submit
     *    pass the original user message's persisted `manualSkills` so the
     *    resubmitted turn primes the same skills: the pills are still
     *    visible to the user, it would be strange to quietly drop them).
     *  - Regenerate / continue / edit without an override → empty, and the
     *    compose-time atom is deliberately NOT drained (those flows replay
     *    a prior turn, not compose a new one).
     *  - Fresh submit → drain the per-convo atom into the message.
     */
    let manualSkills = overrideManualSkills;
    if (manualSkills == null) {
      manualSkills =
        regenerateShaped || isContinued || isEdited
          ? []
          : drainPendingManualSkills(conversationId ?? Constants.NEW_CONVO);
    }
    /**
     * Quoted-excerpt resolution mirrors manual skills, but is skipped entirely
     * for Assistants endpoints: those bypass the `BaseClient` merge, so the
     * quote UI is hidden there and a selection queued on another endpoint must
     * not silently ride along on a fresh submit. The pending atom is left
     * untouched so the queue survives if the user switches back.
     *  - Explicit `overrideQuotes` wins (regenerate / resubmit replay the
     *    original user message's persisted quotes so the same context is sent).
     *  - Regenerate / continue / edit without an override → empty (those flows
     *    replay a prior turn; the compose-time atom is left untouched).
     *  - Fresh submit → drain the per-convo atom into the message.
     */
    const quotesSupported = !isAssistantsEndpoint(endpoint);
    let quotes: string[] = [];
    if (quotesSupported) {
      if (overrideQuotes != null) {
        quotes = overrideQuotes;
      } else if (!regenerateShaped && !isContinued && !isEdited) {
        quotes = drainPendingQuotes(conversationId ?? Constants.NEW_CONVO);
      }
    }
    let reasoningOverride = overrideReasoning ?? undefined;
    const reasoningStateKey = getReasoningStateKey(conversationId, index);
    const drainedReasoning =
      overrideReasoning === undefined && !regenerateShaped && !isContinued && !isEdited;
    if (drainedReasoning) {
      reasoningOverride = drainPendingReasoning(reasoningStateKey);
    }
    const stagedReasoning = reasoningOverride;
    if (reasoningOverride != null) {
      const resolved = resolveSubmittedReasoning({
        queryClient,
        agentsMap,
        endpoint,
        conversation,
        endpointsConfig,
        reasoningOverride,
        drainedReasoning,
        stagedReasoning,
      });
      reasoningOverride = resolved.reasoningOverride;
      if (resolved.restoreStaged && stagedReasoning != null) {
        reasoningStore.set(pendingReasoningOverrideFamily(reasoningStateKey), stagedReasoning);
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
      index,
      conversation,
      latestMessage,
      cachedMessages,
      files,
      canClearFiles: setFiles != null,
      endpointsConfig,
      modelSpecs: config.modelSpecs,
      user: auth.user,
      isTemporary,
      ephemeralAgent,
      getSender,
      userKey: endpoint !== EModelEndpoint.agents ? getExpiry() : undefined,
      manualSkills,
      quotes,
      reasoningOverride,
      code: {
        approvalMode: codeApprovalMode,
        latestApprovalMode: latestCodeApprovalMode,
        environmentMode: codeEnvironmentMode,
        workspaces: codeWorkspaces,
      },
    });
    const {
      submission,
      currentMsg,
      initialResponse,
      submissionMessages,
      regenerateShaped: isRegenerateShaped,
      isEditOrContinue,
      newChatPath,
      fileEffects,
    } = turn;
    conversationId = turn.conversationId;

    if (newChatPath != null) {
      requestChatFocus();
      navigate(newChatPath);
    }
    if (fileEffects != null && setFiles) {
      markPasteSubmitted(...fileEffects.submittedFileIds);
      if (fileEffects.clearComposer) {
        setFiles(new Map());
        setFilesToDelete({});
      }
    }
    if (turn.startsSubmitting) {
      setIsSubmitting(true);
      setShowStopButton(true);
    }

    /** Bind before publishing the optimistic tail, not after the first provider
     * event: a waiting request already owns a turn even when no usage exists. */
    jotaiStore.set(
      activeUsageResponseIdFamily(conversationId ?? Constants.NEW_CONVO),
      initialResponse.messageId,
    );

    if (isRegenerateShaped) {
      setMessages([...submissionMessages, initialResponse]);
      focusRegeneratedResponse(initialResponse.parentMessageId);
    } else {
      setMessages([...submissionMessages, currentMsg, initialResponse]);
    }

    /** Carry the submitted choice through the first saved-chat event instead of re-deriving it
     *  from agent defaults. This is optimistic: the SSE error path reconciles an existing chat
     *  with its authoritative server decision if admission fails. */
    setConversation((current) =>
      current == null || current.conversationId !== conversation?.conversationId
        ? current
        : withSubmittedCodeDecision(current, workspaceSubmission),
    );
    /** Armed at the point of no return: every refusal above returns before it,
     *  so a rejected send never has to unwind the guard, and `ask` runs to
     *  completion synchronously, which is the whole window it has to cover. */
    askInFlightRef.current = true;
    setSubmissionStart(Date.now());
    bindComposerLaunch(submission.conversation, index);
    setSubmission(submission);
    logger.dir('message_stream', {
      conversationId,
      messageId: currentMsg.messageId,
      parentMessageId: currentMsg.parentMessageId,
      isEdited: isEditOrContinue,
      isRegenerate: isRegenerateShaped,
      isContinued,
    });
  };

  const regenerate = createRegenerate(ask, getMessages);

  return {
    ask,
    regenerate,
  };
}
