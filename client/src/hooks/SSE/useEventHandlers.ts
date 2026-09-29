import { useCallback, useEffect, useRef } from 'react';
import { v4 } from 'uuid';
import { useQueryClient } from '@tanstack/react-query';
import { useSetRecoilState, useRecoilCallback } from 'recoil';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  QueryKeys,
  Constants,
  EndpointURLs,
  ContentTypes,
  tPresetSchema,
  tMessageSchema,
  tConvoUpdateSchema,
  isAssistantsEndpoint,
} from 'librechat-data-provider';
import type {
  TPreset,
  TMessage,
  TConversation,
  TStartupConfig,
  EventSubmission,
  TMessageContentParts,
} from 'librechat-data-provider';
import type { InfiniteData } from '@tanstack/react-query';
import type { SetterOrUpdater } from 'recoil';
import type { TResData, TFinalResData, ConvoGenerator } from '~/common';
import type { ConversationCursorData } from '~/utils';
import {
  logger,
  setDraft,
  getConversationDraftId,
  scrollToEnd,
  hasRealTitle,
  withoutListFlags,
  setDocumentTitle,
  requestChatFocus,
  getAllContentText,
  upsertConvoInAllQueries,
  updateConvoInAllQueries,
  removeConvoFromAllQueries,
  findConversationInInfinite,
  preserveStreamedContentIdentity,
  isEmptyContentPart,
  getPartKeyIndex,
} from '~/utils';
import {
  startupConfigKey,
  queueTitleGeneration,
  markTitleGenerationProcessed,
  useReconcileConversationCodeEnvironmentMutation,
} from '~/data-provider';
import {
  getFailedCodeDecisionRequest,
  withSubmittedCodeDecision,
} from '~/hooks/Agents/codeDecision';
import useFocusRegeneratedResponse from '~/hooks/Chat/useFocusRegeneratedResponse';
import { shouldResetSubagentAtomsOnConversationChange } from './cleanup';
import useAttachmentHandler from '~/hooks/SSE/useAttachmentHandler';
import useContentHandler from '~/hooks/SSE/useContentHandler';
import useStepHandler from '~/hooks/SSE/useStepHandler';
import { useApplyAgentTemplate } from '~/hooks/Agents';
import { useAuthContext } from '~/hooks/AuthContext';
import { MESSAGE_UPDATE_INTERVAL } from '~/common';
import { useLiveAnnouncer } from '~/Providers';
import store from '~/store';

type TSyncData = {
  sync: boolean;
  thread_id: string;
  messages?: TMessage[];
  requestMessage: TMessage;
  responseMessage: TMessage;
  conversationId: string;
};

type TTitleEvent = {
  event: 'title';
  data?: {
    conversationId?: string;
    title?: string;
  };
};

/** Skill caches refreshed when a chat turn authors a skill via `create_file`/`edit_file`. */
const SKILL_QUERY_KEYS = [
  QueryKeys.skills,
  QueryKeys.skill,
  QueryKeys.skillFiles,
  QueryKeys.skillFileContent,
  QueryKeys.skillTree,
  QueryKeys.skillNodeContent,
] as const;

export const buildCreatedInitialResponse = ({
  initialResponse,
  userMessage,
  isRegenerate = false,
}: Pick<EventSubmission, 'initialResponse' | 'userMessage' | 'isRegenerate'>): TMessage => ({
  ...initialResponse,
  parentMessageId:
    isRegenerate && initialResponse.parentMessageId
      ? initialResponse.parentMessageId
      : userMessage.messageId,
  messageId:
    isRegenerate && initialResponse.messageId
      ? initialResponse.messageId
      : `${userMessage.messageId}_`,
  conversationId: userMessage.conversationId ?? initialResponse.conversationId,
});

/** Apply the resolved request choice only after acknowledgement. A saved decision may have
 *  moved since this event was emitted, so replay must never replace it. */
function acknowledgedCodeEnvironment(
  current: TConversation | null,
  submission: EventSubmission,
): Pick<TConversation, 'codeEnvironmentMode' | 'codeWorkspaces'> {
  const { codeEnvironmentMode, codeWorkspaces } = submission;
  if (codeEnvironmentMode == null && !codeWorkspaces?.length) return {};
  const saved =
    current?.conversationId != null &&
    current.conversationId !== Constants.NEW_CONVO &&
    current.conversationId !== Constants.PENDING_CONVO;
  if (saved && (current.codeEnvironmentMode != null || current.codeWorkspaces?.length)) return {};
  return {
    codeEnvironmentMode,
    codeWorkspaces: codeEnvironmentMode === 'without_attached' ? undefined : codeWorkspaces,
  };
}

export const isInitialNewConversationSubmission = ({
  userMessage,
}: Pick<EventSubmission, 'userMessage'>): boolean =>
  userMessage?.parentMessageId === Constants.NO_PARENT;

/**
 * Whether the run was sent from the unsaved-chat composer, which is the only case where
 * finishing it may drop the pane's new-chat draft. Regenerating or resubmitting the first turn
 * of a saved conversation keeps the root parent id, so the root parent alone cannot decide it.
 */
export const startedAsNewConversation = ({
  conversation,
  userMessage,
  isEdited,
  isRegenerate,
}: Pick<
  EventSubmission,
  'conversation' | 'userMessage' | 'isEdited' | 'isRegenerate'
>): boolean => {
  const conversationId = conversation?.conversationId;
  if (
    !conversationId ||
    conversationId === Constants.NEW_CONVO ||
    conversationId === Constants.PENDING_CONVO
  ) {
    return true;
  }

  return (
    isEdited !== true &&
    isRegenerate !== true &&
    isInitialNewConversationSubmission({ userMessage })
  );
};

export const mergeRegenerateFinalMessages = ({
  messages,
  responseMessage,
  initialResponseId,
}: {
  messages: TMessage[];
  responseMessage: TMessage;
  initialResponseId?: string | null;
}): TMessage[] => {
  const finalMessages: TMessage[] = [];
  let inserted = false;

  for (const message of messages) {
    if (!message?.messageId || message.messageId === initialResponseId) {
      continue;
    }

    if (message.messageId === responseMessage.messageId) {
      finalMessages.push(responseMessage);
      inserted = true;
      continue;
    }

    finalMessages.push(message);
  }

  if (!inserted) {
    finalMessages.push(responseMessage);
  }

  return finalMessages;
};

export const getExistingConversationAbortMessages = ({
  messages,
  currentMessages,
  regenerateMessages,
  isRegenerate = false,
}: Pick<EventSubmission, 'messages' | 'regenerateMessages' | 'isRegenerate'> & {
  currentMessages?: TMessage[];
}): TMessage[] => {
  if (!isRegenerate) {
    return [...messages];
  }

  if (regenerateMessages?.length) {
    return [...regenerateMessages];
  }

  const sourceMessages = currentMessages?.length ? currentMessages : messages;
  return [...sourceMessages];
};

export const mergeErrorMessages = ({
  messages,
  regenerateMessages,
  userMessage,
  errorMessage,
  isRegenerate = false,
}: Pick<EventSubmission, 'messages' | 'regenerateMessages' | 'userMessage' | 'isRegenerate'> & {
  errorMessage: TMessage;
}): TMessage[] => {
  if (isRegenerate) {
    const finalMessages: TMessage[] = [];
    let replaced = false;
    for (const message of regenerateMessages ?? messages) {
      if (message.messageId === errorMessage.messageId) {
        finalMessages.push(errorMessage);
        replaced = true;
      } else {
        finalMessages.push(message);
      }
    }
    if (!replaced) {
      finalMessages.push(errorMessage);
    }
    return finalMessages;
  }

  return [...messages, userMessage, errorMessage];
};

export type EventHandlerParams = {
  isAddedRequest?: boolean;
  runIndex?: number;
  setCompleted: React.Dispatch<React.SetStateAction<Set<unknown>>>;
  setMessages: (messages: TMessage[]) => void;
  getMessages: () => TMessage[] | undefined;
  setIsSubmitting: SetterOrUpdater<boolean>;
  setConversation?: SetterOrUpdater<TConversation | null>;
  newConversation?: ConvoGenerator;
  setShowStopButton: SetterOrUpdater<boolean>;
};

const CONNECTION_ERROR_TEXT = 'Error connecting to server, try refreshing the page.';

/**
 * The parts the in-flight response has streamed so far: the transcript's tail (a user row there
 * means no response was placed), without the holes an interrupted stream leaves. Whether anything
 * streamed is judged without the slots that never received content — a comparison run's
 * `type: ''` placeholders, a text or think part opened before its first delta — but once something
 * did, those slots stay: a placeholder is what keeps a comparison lane's layout and attribution
 * when only the other lane produced output. The parts carry the render identity they streamed
 * under, as the final path stamps it, so the settled row does not remount.
 */
const getStreamedContent = (message?: TMessage): TMessageContentParts[] => {
  if (message == null || message.isCreatedByUser === true) {
    return [];
  }
  const streamed = message.content ?? [];
  const parts = streamed.filter((part): part is TMessageContentParts => part != null);
  if (!parts.some((part) => !isEmptyContentPart(part))) {
    return [];
  }
  return preserveStreamedContentIdentity(streamed, parts) ?? parts;
};

/** Keys the appended failure past every key the kept parts render under, physical or stamped. */
const appendErrorPart = (
  content: TMessageContentParts[],
  errorText: string,
): TMessageContentParts[] => {
  const keyIndex = content.reduce(
    (next, part, idx) => Math.max(next, getPartKeyIndex(part, idx) + 1),
    0,
  );
  const errorPart: TMessageContentParts = { type: ContentTypes.ERROR, error: errorText };
  return [
    ...content,
    keyIndex === content.length ? errorPart : { ...errorPart, streamedIndex: keyIndex },
  ];
};

/**
 * A failure that lands after the run has streamed keeps what streamed and takes the failure as
 * one more part, the way the server records a failure inside a run; one that lands before
 * anything streamed is the whole row.
 */
const createErrorMessage = ({
  errorMetadata,
  getMessages,
  submission,
  error,
}: {
  getMessages: () => TMessage[] | undefined;
  errorMetadata?: Partial<TMessage>;
  submission: EventSubmission;
  error?: Error | unknown;
}): TMessage => {
  const currentMessages = getMessages();
  const latestMessage = currentMessages?.[currentMessages.length - 1];
  const text = submission.initialResponse.text.length > 45 ? submission.initialResponse.text : '';
  const errorText =
    (errorMetadata?.text || text || (error as Error | undefined)?.message) ??
    'Error cancelling request';
  const streamedContent = getStreamedContent(latestMessage);
  if (latestMessage?.conversationId && latestMessage.messageId && streamedContent.length > 0) {
    /** The row keeps the envelope it streamed under — author, model, icon, creation time — and
     *  takes from the failure only what describes the failure: a server payload names `System`
     *  as its sender and the schema dates a fresh envelope now, neither of which applies to a
     *  response that is merely gaining a part. */
    const errorMessage: TMessage = {
      ...latestMessage,
      ...(errorMetadata?.metadata != null
        ? { metadata: { ...latestMessage.metadata, ...errorMetadata.metadata } }
        : {}),
      error: undefined,
      text: '',
      content: appendErrorPart(streamedContent, errorText),
    };
    if (
      submission.userMessage.messageId &&
      submission.userMessage.messageId !== errorMessage.parentMessageId
    ) {
      errorMessage.parentMessageId = submission.userMessage.messageId;
    }
    return errorMessage;
  }
  if (errorMetadata) {
    return errorMetadata as TMessage;
  }
  return tMessageSchema.parse({
    ...submission,
    ...submission.initialResponse,
    text: errorText,
    unfinished: !!text.length,
    error: true,
  }) as TMessage;
};

export interface ErrorTurn {
  conversationId: string;
  errorResponse: TMessage;
  /** The conversation must be rebuilt: it never learned its id, the transport failed, or the
   *  server named a conversation the new-chat route has not navigated to. */
  recover: boolean;
}

/** Builds the row a failed turn leaves in the transcript and names the conversation it belongs to. */
export const resolveErrorTurn = ({
  data,
  submission,
  getMessages,
  isNewConversationRoute,
}: {
  data?: TResData;
  submission: EventSubmission;
  getMessages: () => TMessage[] | undefined;
  isNewConversationRoute: boolean;
}): ErrorTurn => {
  const { userMessage, initialResponse } = submission;
  const conversationId =
    userMessage.conversationId ?? submission.conversation?.conversationId ?? '';

  const parseErrorResponse = (payload: TResData | Partial<TMessage>): TMessage => {
    const metadata = payload['responseMessage'] ?? payload;
    const errorMessage: Partial<TMessage> = {
      ...initialResponse,
      ...metadata,
      error: true,
      parentMessageId: userMessage.messageId,
    };

    if (errorMessage.messageId === undefined || errorMessage.messageId === '') {
      errorMessage.messageId = v4();
    }

    return tMessageSchema.parse(errorMessage) as TMessage;
  };
  const build = (errorMetadata: TMessage): TMessage =>
    createErrorMessage({ errorMetadata, getMessages, submission });

  if (!data) {
    const convoId = conversationId || `_${v4()}`;
    return {
      conversationId: convoId,
      recover: true,
      errorResponse: build(
        parseErrorResponse({ text: CONNECTION_ERROR_TEXT, ...submission, conversationId: convoId }),
      ),
    };
  }

  const receivedConvoId = data.conversationId ?? '';
  if (!conversationId && !receivedConvoId) {
    return {
      conversationId: `_${v4()}`,
      recover: true,
      errorResponse: build(parseErrorResponse(data)),
    };
  }
  if (!receivedConvoId) {
    return { conversationId, recover: false, errorResponse: build(parseErrorResponse(data)) };
  }
  return {
    conversationId: receivedConvoId,
    recover: isNewConversationRoute,
    errorResponse: build(
      tMessageSchema.parse({
        ...data,
        error: true,
        parentMessageId: userMessage.messageId,
      }) as TMessage,
    ),
  };
};

/**
 * A code approval mode picked locally is newer than any server copy of the
 * conversation: the final and abort events return the mode the run STARTED
 * with, and error recovery rebuilds from the pre-run capture. The local mode
 * therefore survives every merge and the next send carries it. Identity is
 * checked because the conversation atom is index-global: after navigating
 * elsewhere mid-run, that conversation's mode must not land in this one.
 */
export const keepLocalCodeApprovalMode = <T extends Partial<TConversation>>(
  merged: T,
  local: Partial<TConversation> | null | undefined,
  conversationId: string | null | undefined,
): T => {
  const localMode = local?.codeApprovalMode;
  if (localMode == null || local?.conversationId !== conversationId) {
    return merged;
  }
  return merged.codeApprovalMode === localMode
    ? merged
    : { ...merged, codeApprovalMode: localMode };
};

/** Preset for a conversation rebuilt after a failed or aborted run. The detail
 *  cache holds a mode picked while that run streamed; the capture only the
 *  pre-run one. */
export const buildRecoveryPreset = (
  submissionConvo: Partial<TConversation>,
  cachedConvo: TConversation | null | undefined,
  conversationId: string,
  submittedDecision?: Pick<EventSubmission, 'codeEnvironmentMode' | 'codeWorkspaces'>,
): TPreset =>
  tPresetSchema.parse(
    keepLocalCodeApprovalMode(
      submittedDecision == null
        ? submissionConvo
        : withSubmittedCodeDecision(submissionConvo as TConversation, submittedDecision)!,
      cachedConvo,
      conversationId,
    ),
  );

export const getConvoTitle = ({
  parentId,
  queryClient,
  currentTitle,
  conversationId,
}: {
  parentId?: string | null;
  queryClient: ReturnType<typeof useQueryClient>;
  currentTitle?: string | null;
  conversationId?: string | null;
}): string | null | undefined => {
  if (
    parentId !== Constants.NO_PARENT &&
    (currentTitle?.toLowerCase().includes('new chat') ?? false)
  ) {
    const currentConvo = queryClient.getQueryData<TConversation>([
      QueryKeys.conversation,
      conversationId,
    ]);
    if (currentConvo?.title) {
      return currentConvo.title;
    }
    const convos = queryClient.getQueryData<InfiniteData<ConversationCursorData>>([
      QueryKeys.allConversations,
    ]);
    const cachedConvo = findConversationInInfinite(convos, conversationId ?? '');
    return cachedConvo?.title ?? currentConvo?.title ?? null;
  }
  return currentTitle;
};

export default function useEventHandlers({
  setMessages,
  getMessages,
  setCompleted,
  isAddedRequest = false,
  runIndex = 0,
  setConversation,
  setIsSubmitting,
  newConversation,
  setShowStopButton,
}: EventHandlerParams) {
  const queryClient = useQueryClient();
  const { announcePolite } = useLiveAnnouncer();
  const applyAgentTemplate = useApplyAgentTemplate();
  const setAbortScroll = useSetRecoilState(store.abortScroll);
  /** Cleared on every terminal path below: the elapsed anchor must not outlive
   *  its generation, or a later externally-started run attached at this index
   *  would inherit a stale baseline. Navigation teardown deliberately does not
   *  clear it — a reattach to a still-live run keeps its original start. */
  const setSubmissionStart = useSetRecoilState(store.submissionStartFamily(runIndex));
  const { mutate: reconcileCodeDecision } =
    useReconcileConversationCodeEnvironmentMutation(setConversation);
  const reconcileFailedCodeDecision = useCallback(
    (submission: EventSubmission, conversationId?: string) => {
      if (isAddedRequest) return;
      const request = getFailedCodeDecisionRequest(submission, conversationId);
      if (request != null) reconcileCodeDecision(request);
    },
    [isAddedRequest, reconcileCodeDecision],
  );

  const recoverConversation = useCallback(
    (conversationId: string, submission: EventSubmission) => {
      if (!newConversation) {
        return;
      }
      const cachedConvo = queryClient.getQueryData<TConversation>([
        QueryKeys.conversation,
        conversationId,
      ]);
      const preset = buildRecoveryPreset(
        submission.conversation,
        cachedConvo,
        conversationId,
        submission,
      );
      newConversation({
        // Endpoint preset parsing omits code decisions. Carry them on the conversation template
        // too, so rebuilding after a first-turn stream failure cannot discard the implicit pick.
        template: {
          conversationId,
          codeEnvironmentMode: preset.codeEnvironmentMode,
          codeWorkspaces: preset.codeWorkspaces,
        },
        preset,
      });
    },
    [newConversation, queryClient],
  );
  const navigate = useNavigate();
  const location = useLocation();

  /** Re-queue the turn's quoted excerpts when an early abort restores the draft,
   *  so retrying the restored message still sends the references — the pending
   *  queue was already drained on submit. */
  const restorePendingQuotes = useRecoilCallback(
    ({ set }) =>
      (convoId: string, quotes?: string[]) => {
        if (Array.isArray(quotes) && quotes.length > 0) {
          set(store.pendingQuotesByConvoId(convoId), quotes);
        }
      },
    [],
  );

  const lastAnnouncementTimeRef = useRef(Date.now());
  const { conversationId: paramId } = useParams();
  const { token } = useAuthContext();

  const { contentHandler, resetContentHandler } = useContentHandler({ setMessages, getMessages });
  /** `refetchType: 'all'` so cached-but-unmounted skill queries refresh too —
   *  they opt out of `refetchOnMount`, so a plain invalidation would leave
   *  the Skills panel stale until a manual refresh. */
  const onSkillAuthoringComplete = useCallback(() => {
    for (const key of SKILL_QUERY_KEYS) {
      queryClient.invalidateQueries({ queryKey: [key], refetchType: 'all' });
    }
  }, [queryClient]);
  const onSubagentIndexChange = useCallback(
    (conversationId: string) => {
      void queryClient.invalidateQueries([QueryKeys.parentSubagents, conversationId]);
    },
    [queryClient],
  );
  const {
    stepHandler,
    clearStepMaps,
    resetSubagentAtoms,
    resetPtcAtoms,
    prunePtcTraces,
    syncStepMessage,
    cancelPendingDeltaFlush,
    flushPendingDeltas,
  } = useStepHandler({
    setMessages,
    getMessages,
    announcePolite,
    setIsSubmitting,
    lastAnnouncementTimeRef,
    onSkillAuthoringComplete,
    onSubagentIndexChange,
  });
  const attachmentHandler = useAttachmentHandler(queryClient);

  /** Wipe the per-subagent Recoil atoms on conversation navigation.
   *  Historical subagent dialogs rehydrate from the persisted
   *  `subagent_content` on each `tool_call` (written by the backend
   *  at message-save time), so clearing live atoms on switch
   *  doesn't lose any viewable history — it just keeps `atomFamily`
   *  bounded across multi-conversation sessions.
   *
   *  Rule: reset on real conversation switches, but preserve atoms for
   *  the single `new` → saved-id transition created by this active run.
   *  Transitions FROM null or undefined pass through:
   *    - initial mount on a new-chat route: nothing to clear.
   *    - new-chat URL stamp mid-stream (`new` → savedId): the final
   *      handler marks that saved id before navigation so the in-flight
   *      subagent ticker/content state survives. Cancelled subagent
   *      runs depend on this live atom because the server may not have
   *      persisted `subagent_content` before interruption.
   *  Cases that DO reset (previous non-null, value changed):
   *    - id1 → id2 (switching between established chats)
   *    - new → id (user selected an existing chat from the sidebar)
   *    - id → null (user clicked "new chat")
   *    - id → undefined (route teardown / navigate away) */
  const lastConversationIdRef = useRef<string | null | undefined>(paramId);
  const preserveSubagentAtomsForNewConvoIdRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = lastConversationIdRef.current;
    const preserveNewConversationId = preserveSubagentAtomsForNewConvoIdRef.current;
    lastConversationIdRef.current = paramId;
    preserveSubagentAtomsForNewConvoIdRef.current = null;
    if (
      shouldResetSubagentAtomsOnConversationChange(previous, paramId, preserveNewConversationId)
    ) {
      resetSubagentAtoms();
      /** PTC traces are live-only for the same reason and share the boundary:
       *  keep them through a run so a finished program stays auditable, drop
       *  them when the conversation changes. */
      resetPtcAtoms();
    }
  }, [paramId, resetSubagentAtoms, resetPtcAtoms]);

  /** Final cleanup on component unmount. `useStepHandler` keeps the
   *  set of known atom keys in a ref; when the hook unmounts (user
   *  navigates away from the chat route entirely) that ref is lost,
   *  so a subsequent remount can't clear atoms it never saw created.
   *  Flush at the teardown boundary to keep `atomFamily` bounded
   *  across route changes. */
  useEffect(
    () => () => {
      resetSubagentAtoms();
      resetPtcAtoms();
    },
    [resetSubagentAtoms, resetPtcAtoms],
  );

  const messageHandler = useCallback(
    (data: string | undefined, submission: EventSubmission) => {
      const { messages, userMessage, initialResponse, isRegenerate = false } = submission;
      const text = data ?? '';
      setIsSubmitting(true);

      const currentTime = Date.now();
      if (currentTime - lastAnnouncementTimeRef.current > MESSAGE_UPDATE_INTERVAL) {
        announcePolite({ message: 'composing', isStatus: true });
        lastAnnouncementTimeRef.current = currentTime;
      }

      if (isRegenerate) {
        setMessages([
          ...messages,
          {
            ...initialResponse,
            text,
          },
        ]);
      } else {
        setMessages([
          ...messages,
          userMessage,
          {
            ...initialResponse,
            text,
          },
        ]);
      }
    },
    [setMessages, announcePolite, setIsSubmitting],
  );

  const cancelHandler = useCallback(
    (data: TResData, submission: EventSubmission) => {
      const { requestMessage, responseMessage, conversation } = data;
      const { messages, isRegenerate = false } = submission;
      const convoUpdate =
        (conversation as TConversation | null) ?? (submission.conversation as TConversation);

      // update the messages
      if (isRegenerate) {
        const messagesUpdate = (
          [...messages, responseMessage] as Array<TMessage | undefined>
        ).filter((msg) => msg);
        setMessages(messagesUpdate as TMessage[]);
      } else {
        const messagesUpdate = (
          [...messages, requestMessage, responseMessage] as Array<TMessage | undefined>
        ).filter((msg) => msg);
        setMessages(messagesUpdate as TMessage[]);
      }

      const isNewConvo = conversation.conversationId !== submission.conversation.conversationId;
      if (isNewConvo) {
        removeConvoFromAllQueries(queryClient, submission.conversation.conversationId as string);
      }

      if (setConversation && !isAddedRequest) {
        setConversation((prevState) =>
          keepLocalCodeApprovalMode(
            { ...prevState, ...convoUpdate },
            prevState,
            convoUpdate.conversationId,
          ),
        );
      }

      setIsSubmitting(false);
    },
    [setMessages, setConversation, isAddedRequest, queryClient, setIsSubmitting],
  );

  const syncHandler = useCallback(
    (data: TSyncData, submission: EventSubmission) => {
      const { conversationId, thread_id, responseMessage, requestMessage } = data;
      const { initialResponse, messages: _messages, userMessage, isTemporary = false } = submission;
      /** Swap the optimistic user row for the server-stamped one IN PLACE.
       *  Filtering it out and re-appending at the tail would order any of its
       *  already-present children (abandoned responses from preempted
       *  attempts) before their parent, and the message tree hoists such rows
       *  into phantom root branches — a folded thread. */
      const userIndex = _messages.findIndex((msg) => msg.messageId === userMessage.messageId);
      const messages =
        userIndex >= 0
          ? _messages.map((msg, i) => (i === userIndex ? requestMessage : msg))
          : [..._messages, requestMessage];

      const nextResponseMessage = {
        ...initialResponse,
        ...responseMessage,
      };

      setMessages([...messages, nextResponseMessage]);

      announcePolite({
        message: 'start',
        isStatus: true,
      });

      let update = {} as TConversation;
      if (setConversation && !isAddedRequest) {
        setConversation((prevState) => {
          const parentId = requestMessage.parentMessageId;
          const title = getConvoTitle({
            parentId,
            queryClient,
            conversationId,
            currentTitle: prevState?.title,
          });
          update = tConvoUpdateSchema.parse({
            ...prevState,
            ...acknowledgedCodeEnvironment(prevState, submission),
            conversationId,
            thread_id,
            title,
            messages: [requestMessage.messageId, responseMessage.messageId],
          }) as TConversation;
          return update;
        });

        if (!isTemporary) {
          const sidebarUpdate = withoutListFlags(update);
          if (requestMessage.parentMessageId === Constants.NO_PARENT) {
            upsertConvoInAllQueries(queryClient, sidebarUpdate);
          } else {
            updateConvoInAllQueries(queryClient, update.conversationId!, () => sidebarUpdate, true);
          }
          if (update.chatProjectId) {
            queryClient.invalidateQueries([QueryKeys.projects]);
            queryClient.invalidateQueries([QueryKeys.project, update.chatProjectId]);
          }
        }
      } else if (setConversation) {
        setConversation((prevState) => {
          update = tConvoUpdateSchema.parse({
            ...prevState,
            ...acknowledgedCodeEnvironment(prevState, submission),
            conversationId,
            thread_id,
            messages: [requestMessage.messageId, responseMessage.messageId],
          }) as TConversation;
          return update;
        });
      }

      setShowStopButton(true);
    },
    [queryClient, setMessages, isAddedRequest, announcePolite, setConversation, setShowStopButton],
  );

  const focusRegeneratedResponse = useFocusRegeneratedResponse();

  const createdHandler = useCallback(
    (data: TResData, submission: EventSubmission) => {
      const { messages, userMessage, isRegenerate = false, isTemporary = false } = submission;
      /**
       * The spread carries `manualSkills` through from
       * `submission.initialResponse` — `useChatFunctions` seeds the field
       * there at construction so the assistant placeholder already has it
       * by the time this handler fires. Subsequent `useStepHandler`
       * spreads and `updateContent` spreads preserve it, and
       * `finalHandler`'s server-backed `responseMessage` replacement
       * drops it, which is the right behavior: by finalize the real
       * `skill` tool_call is in `content` and takes over rendering.
       */
      const initialResponse = buildCreatedInitialResponse({
        initialResponse: submission.initialResponse,
        userMessage,
        isRegenerate,
      });
      if (isRegenerate) {
        setMessages([...messages, initialResponse]);
        focusRegeneratedResponse(initialResponse.parentMessageId);
      } else {
        setMessages([...messages, userMessage, initialResponse]);
      }

      const { conversationId, parentMessageId } = userMessage;
      lastAnnouncementTimeRef.current = Date.now();
      announcePolite({
        message: 'start',
        isStatus: true,
      });

      let update = {} as TConversation;
      if (setConversation && !isAddedRequest) {
        setConversation((prevState) => {
          const parentId = isRegenerate ? userMessage.overrideParentMessageId : parentMessageId;
          const title = getConvoTitle({
            parentId,
            queryClient,
            conversationId,
            currentTitle: prevState?.title,
          });
          update = tConvoUpdateSchema.parse({
            ...prevState,
            ...acknowledgedCodeEnvironment(prevState, submission),
            conversationId,
            title,
          }) as TConversation;
          return update;
        });

        if (!isTemporary) {
          const sidebarUpdate = withoutListFlags(update);
          if (parentMessageId === Constants.NO_PARENT) {
            upsertConvoInAllQueries(queryClient, sidebarUpdate);
          } else {
            updateConvoInAllQueries(queryClient, update.conversationId!, () => sidebarUpdate, true);
          }
          if (update.chatProjectId) {
            queryClient.invalidateQueries([QueryKeys.projects]);
            queryClient.invalidateQueries([QueryKeys.project, update.chatProjectId]);
          }
        }
      } else if (setConversation) {
        setConversation((prevState) => {
          update = tConvoUpdateSchema.parse({
            ...prevState,
            ...acknowledgedCodeEnvironment(prevState, submission),
            conversationId,
          }) as TConversation;
          return update;
        });
      }

      if (conversationId) {
        applyAgentTemplate({
          targetId: conversationId,
          sourceId: submission.conversation?.conversationId,
          ephemeralAgent: submission.ephemeralAgent,
          specName: submission.conversation?.spec,
          startupConfig: queryClient.getQueryData<TStartupConfig>(startupConfigKey(true)),
        });
      }

      scrollToEnd(() => setAbortScroll(false));
    },
    [
      setMessages,
      queryClient,
      setAbortScroll,
      isAddedRequest,
      announcePolite,
      setConversation,
      applyAgentTemplate,
      focusRegeneratedResponse,
    ],
  );

  const titleHandler = useCallback(
    (event: TTitleEvent) => {
      const { conversationId, title } = event.data ?? {};
      if (!conversationId || !hasRealTitle(title)) {
        return;
      }

      queryClient.setQueryData<TConversation>([QueryKeys.conversation, conversationId], (convo) =>
        convo ? { ...convo, title } : convo,
      );
      updateConvoInAllQueries(queryClient, conversationId, (convo) => ({ ...convo, title }));
      markTitleGenerationProcessed(conversationId);

      if (location.pathname.includes(conversationId)) {
        setDocumentTitle(title);
      }

      if (setConversation && !isAddedRequest) {
        setConversation((prevState) => {
          if (!prevState) {
            return prevState;
          }
          if (prevState.conversationId && prevState.conversationId !== conversationId) {
            return prevState;
          }
          return {
            ...prevState,
            conversationId,
            title,
          };
        });
      }
    },
    [queryClient, location.pathname, setConversation, isAddedRequest],
  );

  const finalHandler = useCallback(
    (data: TFinalResData, submission: EventSubmission) => {
      const { requestMessage, responseMessage, conversation, runMessages } = data;
      const {
        messages,
        conversation: submissionConvo,
        isRegenerate = false,
        isTemporary: _isTemporary = false,
      } = submission;
      const serverConversation = conversation as TConversation;
      setSubmissionStart(null);

      try {
        // Handle early abort - aborted before any response message was saved.
        if ((data as Record<string, unknown>).earlyAbort) {
          console.log('[finalHandler] Early abort detected - no response message saved');
          setShowStopButton(false);
          setIsSubmitting(false);

          const currentConvoId = submissionConvo.conversationId;
          const isInitialNewConvo = isInitialNewConversationSubmission(submission);
          const isExistingConvo =
            currentConvoId && currentConvoId !== Constants.NEW_CONVO && !isInitialNewConvo;
          if (isExistingConvo) {
            reconcileFailedCodeDecision(submission, currentConvoId);
            const abortMessages = getExistingConversationAbortMessages({
              messages,
              isRegenerate,
              currentMessages: getMessages(),
              regenerateMessages: submission.regenerateMessages,
            });
            setMessages(abortMessages);
            queryClient.setQueryData<TMessage[]>(
              [QueryKeys.messages, currentConvoId],
              abortMessages,
            );
            setDraft({ id: currentConvoId, value: requestMessage?.text });
            restorePendingQuotes(currentConvoId, requestMessage?.quotes);
            return;
          }

          if (currentConvoId && currentConvoId !== Constants.NEW_CONVO) {
            removeConvoFromAllQueries(queryClient, currentConvoId);
            queryClient.removeQueries({ queryKey: [QueryKeys.conversation, currentConvoId] });
            queryClient.removeQueries({ queryKey: [QueryKeys.messages, currentConvoId] });
          }
          setMessages([]);
          queryClient.setQueryData<TMessage[]>([QueryKeys.messages, Constants.NEW_CONVO], []);
          setDraft({
            id: getConversationDraftId(runIndex, Constants.NEW_CONVO),
            value: requestMessage?.text,
          });
          restorePendingQuotes(String(Constants.NEW_CONVO), requestMessage?.quotes);
          if (location.pathname !== `/c/${Constants.NEW_CONVO}`) {
            navigate(`/c/${Constants.NEW_CONVO}`, { replace: true });
          }
          return;
        }

        if (responseMessage?.attachments && responseMessage.attachments.length > 0) {
          // Process each attachment through the attachmentHandler
          responseMessage.attachments.forEach((attachment) => {
            const attachmentData = {
              ...attachment,
              messageId: responseMessage.messageId,
            };

            attachmentHandler({
              data: attachmentData,
              submission: submission as EventSubmission,
            });
          });
        }

        setCompleted((prev) => new Set(prev.add(submission.initialResponse.messageId)));

        const currentMessages = getMessages();
        /* Early return if messages are empty; i.e., the user navigated away */
        if (!currentMessages || currentMessages.length === 0) {
          return;
        }

        /* a11y announcements */
        announcePolite({ message: 'end', isStatus: true });
        announcePolite({ message: getAllContentText(responseMessage) });

        const isNewConvo = conversation.conversationId !== submissionConvo.conversationId;

        // Skip temporary conversations — the server never generates titles for them.
        if (isNewConvo && conversation.conversationId && !_isTemporary) {
          queueTitleGeneration(conversation.conversationId);
        }

        const setFinalMessages = (id: string | null, _messages: TMessage[]) => {
          setMessages(_messages);
          queryClient.setQueryData<TMessage[]>([QueryKeys.messages, id], _messages);
        };

        const hasNoResponse =
          responseMessage?.content?.[0]?.['text']?.value ===
            submission.initialResponse?.content?.[0]?.['text']?.value ||
          !!responseMessage?.content?.[0]?.['tool_call']?.auth;

        /** Handle edge case where stream is cancelled before any response, which creates a blank page */
        if (!conversation.conversationId && hasNoResponse) {
          const currentConvoId =
            (submissionConvo.conversationId ?? conversation.conversationId) || Constants.NEW_CONVO;
          if (isNewConvo && submissionConvo.conversationId) {
            removeConvoFromAllQueries(queryClient, submissionConvo.conversationId);
          }

          const isNewChat =
            location.pathname === `/c/${Constants.NEW_CONVO}` &&
            currentConvoId === Constants.NEW_CONVO;

          setFinalMessages(currentConvoId, isNewChat ? [] : [...messages]);
          setDraft({
            id: getConversationDraftId(runIndex, currentConvoId),
            value: requestMessage?.text,
          });
          restorePendingQuotes(currentConvoId, requestMessage?.quotes);
          if (isNewChat) {
            requestChatFocus();
            navigate(`/c/${Constants.NEW_CONVO}`, { replace: true });
          }
          return;
        }

        /* Update messages; if assistants endpoint, client doesn't receive responseMessage */
        let finalMessages: TMessage[] = [];
        if (runMessages) {
          finalMessages = [...runMessages];
        } else if (isRegenerate && responseMessage) {
          finalMessages = mergeRegenerateFinalMessages({
            messages: submission.regenerateMessages ?? currentMessages ?? messages,
            responseMessage,
            initialResponseId: submission.initialResponse.messageId,
          });
        } else if (requestMessage != null && responseMessage != null) {
          finalMessages = [...messages, requestMessage, responseMessage];
        }

        /* Preserve files and streamed content identity from current messages:
         * files fill in when the server response lacks them, and the persisted
         * (compacted) content is stamped with the indexes it streamed at so
         * index-keyed renders don't remount the settled message. */
        if (finalMessages.length > 0) {
          const currentMsgMap = new Map(currentMessages.map((m) => [m.messageId, m]));
          for (let i = 0; i < finalMessages.length; i++) {
            const msg = finalMessages[i];
            const currentMsg = currentMsgMap.get(msg.messageId);
            if (!currentMsg) {
              continue;
            }
            const preservedFiles =
              msg.files == null && currentMsg.files?.length ? currentMsg.files : undefined;
            const content = preserveStreamedContentIdentity(currentMsg.content, msg.content);
            if (preservedFiles == null && content === msg.content) {
              continue;
            }
            finalMessages[i] = {
              ...msg,
              ...(preservedFiles != null ? { files: preservedFiles } : {}),
              ...(content !== msg.content ? { content } : {}),
            };
          }
        }

        if (finalMessages.length > 0) {
          setFinalMessages(conversation.conversationId, finalMessages);
        } else if (
          isAssistantsEndpoint(submissionConvo.endpoint) &&
          (!submissionConvo.conversationId ||
            submissionConvo.conversationId === Constants.NEW_CONVO)
        ) {
          queryClient.setQueryData<TMessage[]>(
            [QueryKeys.messages, conversation.conversationId],
            [...currentMessages],
          );
        }

        if (isNewConvo && submissionConvo.conversationId) {
          removeConvoFromAllQueries(queryClient, submissionConvo.conversationId);
        }

        /** A title applied locally (e.g. an immediate-mode title fetched while the
         *  response was still streaming) must survive the final event, whose
         *  `conversation` was built before the title was saved and so carries no
         *  title yet — otherwise the chat reverts to "New Chat" until reload. This
         *  holds for a stopped turn too: the server persists a title that finished
         *  generating before the Stop, so the local one stays in sync. */
        if (setConversation && isAddedRequest !== true) {
          setConversation((prevState) => {
            const update = keepLocalCodeApprovalMode(
              { ...prevState, ...(conversation as TConversation) },
              prevState,
              conversation.conversationId,
            );
            if (prevState?.model != null && prevState.model !== submissionConvo.model) {
              update.model = prevState.model;
            }
            const prevTitle = prevState?.title;
            if (!hasRealTitle(conversation.title) && hasRealTitle(prevTitle)) {
              update.title = prevTitle;
            }
            if (conversation.conversationId) {
              queryClient.setQueryData<TConversation>(
                [QueryKeys.conversation, conversation.conversationId],
                (cachedConvo) => {
                  const merged = keepLocalCodeApprovalMode(
                    { ...cachedConvo, ...serverConversation } as TConversation,
                    prevState?.conversationId === conversation.conversationId
                      ? prevState
                      : cachedConvo,
                    conversation.conversationId,
                  );
                  const cachedTitle = cachedConvo?.title;
                  if (!hasRealTitle(serverConversation.title) && hasRealTitle(cachedTitle)) {
                    merged.title = cachedTitle;
                  }
                  return merged;
                },
              );
            }
            return update;
          });

          if (conversation.conversationId && submission.ephemeralAgent) {
            applyAgentTemplate({
              targetId: conversation.conversationId,
              sourceId: submissionConvo.conversationId,
              ephemeralAgent: submission.ephemeralAgent,
              specName: submission.conversation?.spec,
              startupConfig: queryClient.getQueryData<TStartupConfig>(startupConfigKey(true)),
            });
          }

          if (conversation.chatProjectId) {
            queryClient.invalidateQueries([QueryKeys.projects]);
            queryClient.invalidateQueries([QueryKeys.project, conversation.chatProjectId]);
          }

          if (location.pathname === `/c/${Constants.NEW_CONVO}`) {
            preserveSubagentAtomsForNewConvoIdRef.current = conversation.conversationId;
            navigate(`/c/${conversation.conversationId}`, { replace: true });
          }
        }
      } finally {
        setShowStopButton(false);
        setIsSubmitting(false);
      }
    },
    [
      navigate,
      getMessages,
      setMessages,
      queryClient,
      setCompleted,
      runIndex,
      isAddedRequest,
      announcePolite,
      setConversation,
      setIsSubmitting,
      setShowStopButton,
      location.pathname,
      applyAgentTemplate,
      attachmentHandler,
      setSubmissionStart,
      restorePendingQuotes,
      reconcileFailedCodeDecision,
    ],
  );

  const errorHandler = useCallback(
    ({ data, submission }: { data?: TResData; submission: EventSubmission }) => {
      setCompleted((prev) => new Set(prev.add(submission.initialResponse.messageId)));
      setSubmissionStart(null);

      const { conversationId, errorResponse, recover } = resolveErrorTurn({
        data,
        submission,
        getMessages,
        isNewConversationRoute: paramId === Constants.NEW_CONVO,
      });
      const finalMessages = mergeErrorMessages({ ...submission, errorMessage: errorResponse });
      setMessages(finalMessages);
      queryClient.setQueryData<TMessage[]>([QueryKeys.messages, conversationId], finalMessages);
      if (recover) {
        recoverConversation(conversationId, submission);
      }
      reconcileFailedCodeDecision(submission, conversationId);
      setIsSubmitting(false);
    },
    [
      setCompleted,
      setMessages,
      paramId,
      setIsSubmitting,
      setSubmissionStart,
      getMessages,
      queryClient,
      recoverConversation,
      reconcileFailedCodeDecision,
    ],
  );

  const abortConversation = useCallback(
    async (conversationId = '', submission: EventSubmission, messages?: TMessage[]) => {
      const runAbortKey = `${conversationId}:${messages?.[messages.length - 1]?.messageId ?? ''}`;
      const { endpoint: _endpoint, endpointType } =
        (submission.conversation as TConversation | null) ?? {};
      const endpoint = endpointType ?? _endpoint;
      if (
        !isAssistantsEndpoint(endpoint) &&
        messages?.[messages.length - 1] != null &&
        messages[messages.length - 2] != null
      ) {
        let requestMessage = messages[messages.length - 2];
        const _responseMessage = messages[messages.length - 1];
        if (requestMessage.messageId !== _responseMessage.parentMessageId) {
          // the request message is the parent of response, which we search for backwards
          for (let i = messages.length - 3; i >= 0; i--) {
            if (messages[i].messageId === _responseMessage.parentMessageId) {
              requestMessage = messages[i];
              break;
            }
          }
        }
        /** Sanitize content array to remove undefined parts from interrupted streaming */
        const responseMessage = {
          ..._responseMessage,
          content: _responseMessage.content?.filter((part) => part != null),
        };
        try {
          finalHandler(
            {
              conversation: {
                conversationId,
              },
              requestMessage,
              responseMessage,
            },
            submission,
          );
        } catch (error) {
          console.error('Error in finalHandler during abort:', error);
          setShowStopButton(false);
          setIsSubmitting(false);
          setSubmissionStart(null);
        }
        return;
      } else if (!isAssistantsEndpoint(endpoint)) {
        const convoId = conversationId || `_${v4()}`;
        logger.log('conversation', 'Aborted conversation with minimal messages, ID: ' + convoId);
        recoverConversation(convoId, submission);
        setIsSubmitting(false);
        return;
      }

      try {
        const response = await fetch(`${EndpointURLs[endpoint ?? '']}/abort`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            abortKey: runAbortKey,
            endpoint,
          }),
        });

        // Check if the response is JSON
        const contentType = response.headers.get('content-type');
        if (contentType != null && contentType.includes('application/json')) {
          const data = await response.json();
          if (response.status === 404) {
            setIsSubmitting(false);
            return;
          }
          if (data.final === true) {
            finalHandler(data, submission);
          } else {
            cancelHandler(data, submission);
          }
        } else if (response.status === 204 || response.status === 200) {
          setIsSubmitting(false);
        } else {
          throw new Error(
            'Unexpected response from server; Status: ' +
              response.status +
              ' ' +
              response.statusText,
          );
        }
      } catch (error) {
        const errorResponse = createErrorMessage({
          getMessages,
          submission,
          error,
        });
        /** A compaction has no user row: its `userMessage` slot names the leaf
         *  the turn hangs off, which `messages` already holds. Writing it here
         *  would duplicate that id as an empty, self-parented user message —
         *  a phantom root the thread then folds into. */
        setMessages(
          submission.compact === true
            ? [...submission.messages, errorResponse]
            : [...submission.messages, submission.userMessage, errorResponse],
        );
        recoverConversation(conversationId || errorResponse.conversationId || v4(), submission);
        setIsSubmitting(false);
      }
    },
    [
      token,
      getMessages,
      setMessages,
      finalHandler,
      cancelHandler,
      setIsSubmitting,
      setShowStopButton,
      setSubmissionStart,
      recoverConversation,
    ],
  );

  return {
    stepHandler,
    syncHandler,
    finalHandler,
    errorHandler,
    clearStepMaps,
    messageHandler,
    contentHandler,
    createdHandler,
    titleHandler,
    syncStepMessage,
    prunePtcTraces,
    cancelPendingDeltaFlush,
    flushPendingDeltas,
    attachmentHandler,
    abortConversation,
    resetContentHandler,
  };
}
