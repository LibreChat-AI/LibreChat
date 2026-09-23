import { useCallback, useEffect, useRef } from 'react';
import { v4 } from 'uuid';
import { useStore } from 'jotai';
import { cloneDeep } from 'lodash';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useSetRecoilState, useRecoilValue, useRecoilCallback } from 'recoil';
import {
  Constants,
  QueryKeys,
  ContentTypes,
  EModelEndpoint,
  getEndpointField,
  isAgentsEndpoint,
  parseCompactConvo,
  replaceSpecialVars,
  isAssistantsEndpoint,
  getDefaultParamsEndpoint,
  isReasoningOverrideSupported,
  resolveReasoningSettingForTarget,
} from 'librechat-data-provider';
import type {
  Agent,
  TMessage,
  TSubmission,
  TConversation,
  TStartupConfig,
  TEndpointOption,
  TEndpointsConfig,
  EndpointSchemaKey,
} from 'librechat-data-provider';
import type { SetterOrUpdater } from 'recoil';
import type { TAskFunction, ExtendedFile } from '~/common';
import {
  logger,
  requestChatFocus,
  resolveAgentTarget,
  markPasteSubmitted,
  hasStreamStartFailed,
  isSubmittableMessage,
  createDualMessageContent,
  getRouteChatProjectId,
  stripStreamedIndexStamps,
} from '~/utils';
import {
  getReasoningStateKey,
  pendingReasoningOverrideFamily,
} from '~/components/Chat/Input/Composer/state';
import useFocusRegeneratedResponse from '~/hooks/Chat/useFocusRegeneratedResponse';
import useGetConversation from '~/hooks/Conversations/useGetConversation';
import useCodeApprovalMode from '~/hooks/Agents/useCodeApprovalMode';
import useSetFilesToDelete from '~/hooks/Files/useSetFilesToDelete';
import { useAgentsMapContext } from '~/Providers/AgentsMapContext';
import useCodeWorkspace from '~/hooks/Agents/useCodeWorkspace';
import useGetSender from '~/hooks/Conversations/useGetSender';
import { activeUsageResponseIdFamily } from '~/store/usage';
import { revealedQueuedTurnFamily } from '~/store/steer';
import store, { useGetEphemeralAgent } from '~/store';
import { startupConfigKey } from '~/data-provider';
import useUserKey from '~/hooks/Input/useUserKey';
import { useAuthContext } from '~/hooks';

/** A revalidating cache younger than this is locally authoritative (the run
 * that just streamed wrote it) and stays sendable; older ones wait for the
 * refetch so a send can't fork from an outdated tail. */
const STALE_SEND_REVALIDATION_MS = 5_000;

const logChatRequest = (request: Record<string, unknown>) => {
  logger.log('=====================================\nAsk function called with:');
  logger.dir(request);
  logger.log('=====================================');
};

const getAppendParentMessageId = ({
  latestMessage,
  currentMessages,
}: {
  latestMessage: TMessage | null;
  currentMessages: TMessage[];
}) => {
  if (!latestMessage) {
    return Constants.NO_PARENT;
  }

  if (!hasStreamStartFailed(latestMessage)) {
    return latestMessage.messageId;
  }

  const failedUserMessage = currentMessages.find(
    (message) => message.messageId === latestMessage.parentMessageId,
  );
  if (failedUserMessage?.isCreatedByUser !== true) {
    return latestMessage.messageId;
  }

  return failedUserMessage.parentMessageId ?? Constants.NO_PARENT;
};

const hasPendingAssistantParent = (message: TMessage | null) =>
  !!message?.messageId &&
  message.isCreatedByUser !== true &&
  message.messageId.endsWith('_') &&
  message.createdAt == null &&
  message.updatedAt == null &&
  !hasStreamStartFailed(message);

type RegenerateTargetResponseArgs = {
  messages: TMessage[];
  parentMessageId?: string | null;
  targetResponseMessageId?: string | null;
  latestMessage?: TMessage | null;
};

const isAssistantResponseForParent = (
  message: TMessage | null | undefined,
  parentMessageId?: string | null,
): message is TMessage =>
  !!message &&
  !message.isCreatedByUser &&
  !!parentMessageId &&
  message.parentMessageId === parentMessageId;

export function getPreliminaryRegenerateResponseMessageId(
  responseMessageId?: string | null,
): string | null {
  if (typeof responseMessageId !== 'string' || responseMessageId.length === 0) {
    return null;
  }

  return `${responseMessageId.replace(/_+$/, '')}_`;
}

export function getRegenerateTargetResponseMessage({
  messages,
  parentMessageId,
  targetResponseMessageId,
  latestMessage,
}: RegenerateTargetResponseArgs): TMessage | null {
  if (!parentMessageId) {
    return null;
  }

  if (targetResponseMessageId) {
    const targetResponse = messages.find(
      (message) =>
        message.messageId === targetResponseMessageId &&
        isAssistantResponseForParent(message, parentMessageId),
    );
    if (targetResponse) {
      return targetResponse;
    }
  }

  if (isAssistantResponseForParent(latestMessage, parentMessageId)) {
    return latestMessage;
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isAssistantResponseForParent(message, parentMessageId)) {
      return message;
    }
  }

  return null;
}

export function getRegenerateSubmissionMessages({
  messages,
  targetResponseMessage,
  initialResponseId,
}: {
  messages: TMessage[];
  targetResponseMessage?: TMessage | null;
  initialResponseId?: string | null;
}): TMessage[] {
  if (targetResponseMessage?.messageId) {
    /**
     * Remove the response being regenerated and its descendants only: NOT a
     * flat `slice(0, targetIndex)`, which also drops unrelated sibling branches
     * that merely sit later in the array. That collapse made the optimistic
     * render briefly lose other branches mid-regenerate (visible flash, and the
     * scroll jumping to the shrunken content). Keeping them holds the thread
     * (and scroll) steady. This array is render-only; the server regenerates
     * from `parentMessageId`, so removing by subtree never affects the payload.
     */
    const removed = new Set<string>([targetResponseMessage.messageId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const message of messages) {
        const parentMessageId = message.parentMessageId;
        if (
          parentMessageId != null &&
          removed.has(parentMessageId) &&
          !removed.has(message.messageId)
        ) {
          removed.add(message.messageId);
          grew = true;
        }
      }
    }
    return messages.filter((message) => !removed.has(message.messageId));
  }

  return messages.filter((msg) => msg.messageId !== initialResponseId);
}

export default function useChatFunctions({
  index = 0,
  files,
  setFiles,
  getMessages,
  setMessages,
  isSubmitting,
  latestMessage,
  setSubmission,
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
  setFiles?: SetterOrUpdater<Map<string, ExtendedFile>>;
  setSubmission: SetterOrUpdater<TSubmission | null>;
}) {
  const navigate = useNavigate();
  const reasoningStore = useStore();
  const getSender = useGetSender();
  const { user } = useAuthContext();
  const queryClient = useQueryClient();
  const setFilesToDelete = useSetFilesToDelete();
  const getEphemeralAgent = useGetEphemeralAgent();
  const agentsMap = useAgentsMapContext();
  const isTemporary = useRecoilValue(store.isTemporary);
  const { getExpiry } = useUserKey(immutableConversation?.endpoint ?? '');
  const setIsSubmitting = useSetRecoilState(store.isSubmittingFamily(index));
  const setSubmissionStart = useSetRecoilState(store.submissionStartFamily(index));
  const setShowStopButton = useSetRecoilState(store.showStopButtonByIndex(index));
  const focusRegeneratedResponse = useFocusRegeneratedResponse();
  const jotaiStore = useStore();
  const getConversation = useGetConversation(index);
  const addedConversation = useRecoilValue(store.conversationByKeySelector(1));
  const { modes: codeApprovalModes, selected: fallbackCodeApprovalMode } = useCodeApprovalMode(
    immutableConversation,
    addedConversation,
  );
  const codeWorkspaceState = useCodeWorkspace(immutableConversation, addedConversation);

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
   * skills from the `$` popover. Reading and resetting in a single Recoil
   * snapshot guarantees that if the user selects more skills between here and
   * the next submission, their picks are never silently lost into a reset atom.
   *
   * The `hasValue` guard is defensive: this atom has a synchronous default of
   * `[]` so `.contents` is always the resolved value in practice, but reading
   * `.contents` on a loading/errored loadable yields a Promise/Error, which
   * would make the `string[]` cast unsound.
   */
  const drainPendingManualSkills = useRecoilCallback(
    ({ snapshot, reset }) =>
      (convoId: string): string[] => {
        const loadable = snapshot.getLoadable(store.pendingManualSkillsByConvoId(convoId));
        const skills = loadable.state === 'hasValue' ? (loadable.contents as string[]) : [];
        if (skills.length > 0) {
          reset(store.pendingManualSkillsByConvoId(convoId));
        }
        return skills;
      },
    [],
  );

  /**
   * Atomically read + reset the per-conversation queue of quoted excerpts the
   * user added via the "Add to chat" selection popup. Mirrors
   * `drainPendingManualSkills`: a single snapshot read + reset so excerpts
   * added between here and submission are never lost into a reset atom.
   */
  const drainPendingQuotes = useRecoilCallback(
    ({ snapshot, reset }) =>
      (convoId: string): string[] => {
        const loadable = snapshot.getLoadable(store.pendingQuotesByConvoId(convoId));
        const quotes = loadable.state === 'hasValue' ? (loadable.contents as string[]) : [];
        if (quotes.length > 0) {
          reset(store.pendingQuotesByConvoId(convoId));
        }
        return quotes;
      },
    [],
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
    const codeApprovalMode =
      latestCodeApprovalMode != null && codeApprovalModes.includes(latestCodeApprovalMode)
        ? latestCodeApprovalMode
        : fallbackCodeApprovalMode;
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
      const messagesQueryState = queryClient.getQueryState<TMessage[]>([
        QueryKeys.messages,
        conversationId,
      ]);
      const isRevalidating =
        messagesQueryState?.isInvalidated === true && messagesQueryState.fetchStatus === 'fetching';
      const cacheAgeMs = Date.now() - (messagesQueryState?.dataUpdatedAt ?? 0);
      if (isRevalidating && cacheAgeMs > STALE_SEND_REVALIDATION_MS) {
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
    const startupConfig = queryClient.getQueryData<TStartupConfig>(startupConfigKey(true));
    const endpointType = getEndpointField(endpointsConfig, endpoint, 'type');
    const defaultParamsEndpoint = getDefaultParamsEndpoint(endpointsConfig, endpoint);
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
    if (overrideReasoning === undefined && !isRegenerate && !isContinued && !isEdited) {
      reasoningOverride = drainPendingReasoning(getReasoningStateKey(conversationId, index));
    }
    if (reasoningOverride != null) {
      const isAgent = isAgentsEndpoint(endpoint);
      const agentId = isAgent ? conversation?.agent_id : undefined;
      const savedAgent =
        agentId != null
          ? (queryClient.getQueryData<Agent>([QueryKeys.agent, agentId]) ?? agentsMap?.[agentId])
          : undefined;
      const agentTarget = isAgent ? resolveAgentTarget(agentId, savedAgent) : undefined;
      const effectiveEndpoint = isAgent ? agentTarget?.provider : endpoint;
      const effectiveModel = isAgent ? agentTarget?.model : conversation?.model;
      const effectiveEndpointType = getEndpointField(endpointsConfig, effectiveEndpoint, 'type');
      const customParams =
        effectiveEndpoint == null ? undefined : endpointsConfig?.[effectiveEndpoint]?.customParams;
      const supportedSetting =
        effectiveEndpoint == null
          ? undefined
          : resolveReasoningSettingForTarget({
              endpoint: effectiveEndpointType ?? effectiveEndpoint,
              model: effectiveModel,
              isAgent,
              defaultParamsEndpoint: customParams?.defaultParamsEndpoint,
              reasoningFormat: customParams?.reasoningFormat,
              paramDefinitions: customParams?.paramDefinitions,
            });
      if (!isReasoningOverrideSupported(reasoningOverride, supportedSetting)) {
        reasoningOverride = undefined;
      }
    }
    const isEditOrContinue = isEdited || isContinued;

    let currentMessages: TMessage[] = overrideMessages ?? cachedMessages ?? [];

    if (conversation?.promptPrefix) {
      conversation.promptPrefix = replaceSpecialVars({
        text: conversation.promptPrefix,
        user,
      });
    }

    const chatProjectId =
      conversationId === Constants.NEW_CONVO
        ? getRouteChatProjectId()
        : (conversation?.chatProjectId ?? null);
    const conversationForPayload =
      chatProjectId != null ? { ...(conversation ?? {}), chatProjectId } : (conversation ?? {});

    // construct the query message
    // this is not a real messageId, it is used as placeholder before real messageId returned
    const intermediateId = overrideUserMessageId ?? v4();
    /** Stable idempotency key for this submission: fresh per `ask()` (so regenerate differs)
     *  but reused across the client's start-generation network retries, letting the server
     *  dedup a retried request instead of starting a second billed generation. */
    const clientRequestId = overrideClientRequestId ?? v4();
    if (parentMessageId == null) {
      parentMessageId = getAppendParentMessageId({ latestMessage, currentMessages });
    }

    logChatRequest({
      index,
      conversation,
      latestMessage,
      conversationId,
      intermediateId,
      parentMessageId,
      currentMessages,
    });

    if (conversationId == Constants.NEW_CONVO) {
      parentMessageId = Constants.NO_PARENT;
      currentMessages = [];
      conversationId = null;
      const projectSearch = chatProjectId ? `?projectId=${encodeURIComponent(chatProjectId)}` : '';
      requestChatFocus();
      navigate(`/c/new${projectSearch}`);
    }

    const targetParentMessageId = regenerateShaped ? messageId : latestMessage?.parentMessageId;
    /**
     * If the user regenerated or resubmitted the message, the current parent is technically
     * the latest user message, which is passed into `ask`; otherwise, we can rely on the
     * latestMessage to find the parent.
     */
    const targetParentMessage = currentMessages.find(
      (msg) => msg.messageId === targetParentMessageId,
    );
    const targetResponseMessage = isRegenerate
      ? getRegenerateTargetResponseMessage({
          messages: currentMessages,
          parentMessageId: messageId,
          targetResponseMessageId,
          latestMessage,
        })
      : null;

    let thread_id = targetParentMessage?.thread_id ?? latestMessage?.thread_id;
    if (thread_id == null) {
      thread_id = currentMessages.find((message) => message.thread_id)?.thread_id;
    }

    const iconURL = conversation?.iconURL;

    /** This becomes part of the `endpointOption` */
    const convo = parseCompactConvo({
      endpoint: endpoint as EndpointSchemaKey,
      endpointType: endpointType as EndpointSchemaKey,
      conversation: conversationForPayload,
      defaultParamsEndpoint,
    });

    const { modelDisplayLabel } = endpointsConfig?.[endpoint ?? ''] ?? {};
    const endpointOption = Object.assign(
      {
        endpoint,
        endpointType,
        overrideConvoId,
        overrideUserMessageId:
          overrideUserMessageId ??
          (endpoint === EModelEndpoint.agents && !regenerateShaped && !isContinued
            ? `${intermediateId}${Constants.COMMON_DIVIDER}0`
            : undefined),
      },
      convo,
      chatProjectId ? { chatProjectId } : {},
    ) as TEndpointOption;
    if (endpoint !== EModelEndpoint.agents) {
      endpointOption.key = getExpiry();
      endpointOption.thread_id = thread_id;
      endpointOption.modelDisplayLabel = modelDisplayLabel;
    } else {
      endpointOption.key = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    }
    const responseSender = getSender({ model: conversation?.model, ...endpointOption });

    const currentMsg: TMessage = {
      text,
      sender: 'User',
      clientTimestamp: new Date().toLocaleString('sv').replace(' ', 'T'),
      isCreatedByUser: true,
      parentMessageId,
      conversationId,
      /** A compaction's "user message" is the leaf itself, so an error lands under it. */
      messageId:
        (isContinued || compact) && messageId != null && messageId ? messageId : intermediateId,
      thread_id,
      error: false,
      /**
       * UI-only metadata. Survives reload because the backend persists the
       * field on the message schema, and `SkillPills` reads straight
       * off the message so there's no Recoil state to clean up. Runtime
       * skill resolution reads the top-level `manualSkills` payload field.
       */
      manualSkills: manualSkills.length > 0 ? manualSkills : undefined,
      /**
       * Quoted excerpts the user referenced this turn. Persisted on the
       * message (backend echoes it back on `req.body.quotes`) so `MessageQuotes`
       * renders the references on the user bubble after reload. The backend
       * also merges these into the model-facing user text at request time.
       */
      quotes: quotes.length > 0 ? quotes : undefined,
      reasoningOverride,
    };

    /** The leaf's files already sit in history; a compaction re-attaches nothing. */
    const submissionFiles = compact ? undefined : (overrideFiles ?? targetParentMessage?.files);
    const reuseFiles =
      (isRegenerate || (overrideFiles != null && overrideFiles.length)) &&
      submissionFiles &&
      submissionFiles.length > 0;

    if (setFiles && reuseFiles === true) {
      currentMsg.files = [...submissionFiles];
      /** Queued override files were consumed just like composer files, so mark their identities
       * as submitted before later draft cleanup can classify the restored paste as unsent. */
      submissionFiles.forEach((file) => {
        markPasteSubmitted(file.file_id);
        markPasteSubmitted(file.temp_file_id);
      });
      // Caller-supplied overrideFiles were consumed elsewhere (queued
      // during-run messages take theirs out of the composer at queue time);
      // clearing here would eat attachments staged for the user's NEXT send.
      if (isRegenerate) {
        setFiles(new Map());
        setFilesToDelete({});
      }
    } else if (!compact && setFiles && files && files.size > 0 && overrideFiles == null) {
      /** A compaction attaches nothing and must not consume files the user
       *  staged in the composer for their next message. */
      // `overrideFiles` (even empty) is authoritative for the submission:
      // auto-drained queued messages must never vacuum up attachments the
      // user has staged in the composer for their NEXT message.
      currentMsg.files = Array.from(files.values()).map((file) => ({
        file_id: file.file_id,
        filepath: file.filepath,
        filename: file.filename,
        type: file.type ?? '', // Ensure type is not undefined
        llmDeliveryPath: file.llmDeliveryPath,
        height: file.height,
        width: file.width,
      }));
      /** The draft keeps a paste's provenance after the map is emptied, so discarding later has
       * to be able to tell what this message already took with it. */
      files.forEach((file, key) => {
        markPasteSubmitted(key);
        markPasteSubmitted(file.file_id);
        markPasteSubmitted(file.temp_file_id);
      });
      setFiles(new Map());
      setFilesToDelete({});
    }

    const responseMessageId =
      editedMessageId ??
      (isRegenerate
        ? getPreliminaryRegenerateResponseMessageId(
            targetResponseMessage?.messageId ?? targetResponseMessageId,
          )
        : null) ??
      null;
    /** Set only for edited resubmissions; see `TSubmission.editPrefixLength`. */
    let editPrefixLength: number | undefined;
    const initialResponseId =
      responseMessageId ??
      `${regenerateShaped ? messageId : intermediateId}`.replace(/_+$/, '') + '_';

    const initialResponse: TMessage = {
      sender: responseSender,
      text: '',
      endpoint: endpoint ?? '',
      parentMessageId: regenerateShaped ? messageId : intermediateId,
      messageId: initialResponseId,
      thread_id,
      conversationId,
      unfinished: false,
      isCreatedByUser: false,
      model: convo?.model,
      error: false,
      iconURL,
      clientQueueParentMessageId: regenerateShaped ? (messageId ?? undefined) : intermediateId,
      /**
       * Seed the assistant placeholder with the turn's manually-invoked
       * skill names so `ContentParts` can render interim `SkillCall` cards
       * from the very first render: no round-trip through the `created`
       * SSE event required. Rides along with every subsequent spread
       * (`useStepHandler` response construction, `updateContent` result
       * spreads) and drops out naturally at `finalHandler` when the
       * server-backed `responseMessage` replacement takes over.
       */
      manualSkills: manualSkills.length > 0 ? manualSkills : undefined,
    };

    if (isAssistantsEndpoint(endpoint)) {
      initialResponse.model = conversation?.assistant_id ?? '';
      initialResponse.text = '';
      initialResponse.content = [
        {
          type: ContentTypes.TEXT,
          [ContentTypes.TEXT]: {
            value: '',
          },
        },
      ];
    } else if (endpoint != null) {
      initialResponse.model = isAgentsEndpoint(endpoint)
        ? (conversation?.agent_id ?? '')
        : (conversation?.model ?? '');
      initialResponse.text = '';

      if (editedContent && latestMessage?.content) {
        /** Stamps off: the rerun appends provider parts at the prefix LENGTH,
         *  and a retained `streamedIndex` at or above it would collide with an
         *  appended part's render key (see `stripStreamedIndexStamps`). */
        initialResponse.content = stripStreamedIndexStamps(cloneDeep(latestMessage.content));
        /** Captured now, while it is still the retained prefix: a later resume
         *  sync replaces this array with the server's completion-local
         *  snapshot, after which its length no longer describes the offset. */
        editPrefixLength = initialResponse.content.length;
        const { index, type, ...part } = editedContent;
        if (initialResponse.content && index >= 0 && index < initialResponse.content.length) {
          const contentPart = initialResponse.content[index];
          if (type === ContentTypes.THINK && contentPart.type === ContentTypes.THINK) {
            contentPart[ContentTypes.THINK] = part[ContentTypes.THINK];
            delete contentPart.reasoning_label;
            delete contentPart.reasoning_label_step_id;
            delete contentPart.reasoning_label_attempts;
            delete contentPart.reasoning_label_submitted_chars;
            delete contentPart.reasoning_label_revision;
            delete contentPart.reasoning_label_status;
          } else if (type === ContentTypes.TEXT && contentPart.type === ContentTypes.TEXT) {
            contentPart[ContentTypes.TEXT] = part[ContentTypes.TEXT];
          }
        }
      } else if (addedConvo && conversation) {
        // Pre-populate placeholders for smooth UI - these will be overridden/extended
        // as SSE events arrive with actual content, preserving the agent-based agentId
        initialResponse.content = createDualMessageContent(
          conversation,
          addedConvo,
          endpointsConfig,
          startupConfig?.modelSpecs?.list,
        );
      } else {
        initialResponse.content = [];
      }
      setIsSubmitting(true);
      setShowStopButton(true);
    }

    if (isContinued) {
      currentMessages = currentMessages.filter((msg) => msg.messageId !== responseMessageId);
    }

    const submissionMessages = regenerateShaped
      ? getRegenerateSubmissionMessages({
          messages: currentMessages,
          targetResponseMessage,
          initialResponseId: initialResponse.messageId,
        })
      : currentMessages;
    const regenerateMessages = regenerateShaped ? [...currentMessages] : undefined;

    logger.log('message_state', initialResponse);
    const submission: TSubmission = {
      conversation: {
        ...conversation,
        ...(chatProjectId ? { chatProjectId } : {}),
        ...(latestCodeApprovalMode != null ? { codeApprovalMode: latestCodeApprovalMode } : {}),
        conversationId,
      },
      endpointOption,
      userMessage: {
        ...currentMsg,
        responseMessageId,
        overrideParentMessageId: isRegenerate ? messageId : null,
      },
      messages: submissionMessages,
      regenerateMessages,
      isEdited: isEditOrContinue,
      isContinued,
      isRegenerate: regenerateShaped,
      ...(compact && { compact: true }),
      initialResponse,
      isTemporary,
      ephemeralAgent,
      editedContent,
      editPrefixLength,
      addedConvo,
      manualSkills: manualSkills.length > 0 ? manualSkills : undefined,
      codeApprovalMode,
      codeEnvironmentMode,
      codeWorkspaces,
      clientRequestId,
      recoverySteerId: overrideRecoverySteerId,
      expectedPredecessorCreatedAt: overrideExpectedPredecessorCreatedAt,
      queuedMessageOrigin: overrideQueuedMessageOrigin,
    };

    /** Bind before publishing the optimistic tail, not after the first provider
     * event: a waiting request already owns a turn even when no usage exists. */
    jotaiStore.set(
      activeUsageResponseIdFamily(conversationId ?? Constants.NEW_CONVO),
      initialResponse.messageId,
    );

    if (regenerateShaped) {
      setMessages([...submissionMessages, initialResponse]);
      focusRegeneratedResponse(initialResponse.parentMessageId);
    } else {
      setMessages([...submissionMessages, currentMsg, initialResponse]);
    }

    /** Armed at the point of no return: every refusal above returns before it,
     *  so a rejected send never has to unwind the guard, and `ask` runs to
     *  completion synchronously, which is the whole window it has to cover. */
    askInFlightRef.current = true;
    setSubmissionStart(Date.now());
    setSubmission(submission);
    logger.dir('message_stream', submission, { depth: null });
  };

  const regenerate = (
    message: Partial<Pick<TMessage, 'messageId' | 'parentMessageId' | 'isCreatedByUser'>>,
    options?: { addedConvo?: TConversation | null },
  ) => {
    const messages = getMessages();
    const parentMessageId =
      message.isCreatedByUser === true ? message.messageId : message.parentMessageId;
    const targetResponseMessageId =
      message.isCreatedByUser === true ? undefined : message.messageId;
    const parentMessage = messages?.find((element) => element.messageId == parentMessageId);

    if (parentMessage && parentMessage.isCreatedByUser) {
      ask(
        { ...parentMessage },
        {
          isRegenerate: true,
          addedConvo: options?.addedConvo ?? undefined,
          targetResponseMessageId,
          /** Carry the original user message's manual skill picks forward
           *  so the regenerated response is primed with the same skills.
           *  The compose-time atom was drained on the first submit; without
           *  this the model sees an unprimed turn even though the pills
           *  still show on the user bubble. */
          overrideManualSkills: parentMessage.manualSkills,
          /** Carry the original user message's quoted excerpts forward so the
           *  regenerated response is sent the same referenced context. */
          overrideQuotes: parentMessage.quotes,
          /** Replay the exact request-scoped reasoning selection used by this turn. */
          overrideReasoning: parentMessage.reasoningOverride ?? null,
        },
      );
    } else {
      console.error(
        'Failed to regenerate the message: parentMessage not found or not created by user.',
      );
    }
  };

  return {
    ask,
    regenerate,
  };
}
