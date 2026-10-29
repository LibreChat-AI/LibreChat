import { useCallback, useEffect, useRef } from 'react';
import { useStore, useSetAtom } from 'jotai';
import { QueryKeys } from 'librechat-data-provider';
import { buildRecoveryPreset } from '@librechat/chat';
import { useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  submissionStartFamily,
  getReasoningStateKey,
  pendingQuotesByConvoId,
  pendingReasoningOverrideFamily,
} from '@librechat/chat/react';
import type { TMessage, TConversation, EventSubmission } from 'librechat-data-provider';
import type { EventHandlerContext } from './handlers';
import type { ConvoGenerator } from '~/common';
import useFocusRegeneratedResponse from '~/hooks/Chat/useFocusRegeneratedResponse';
import { useReconcileConversationCodeEnvironmentMutation } from '~/data-provider';
import { getFailedCodeDecisionRequest } from '~/hooks/Agents/codeDecision';
import { shouldResetSubagentAtomsOnConversationChange } from './cleanup';
import useAttachmentHandler from '~/hooks/SSE/useAttachmentHandler';
import useContentHandler from '~/hooks/SSE/useContentHandler';
import useStepHandler from '~/hooks/SSE/useStepHandler';
import { useApplyAgentTemplate } from '~/hooks/Agents';
import { useLiveAnnouncer } from '~/Providers';
import useTurnHandlers from './opening';
import useAbortHandlers from './abort';
import useFinalHandler from './final';

/** Skill caches refreshed when a chat turn authors a skill via `create_file`/`edit_file`. */
const SKILL_QUERY_KEYS = [
  QueryKeys.skills,
  QueryKeys.skill,
  QueryKeys.skillFiles,
  QueryKeys.skillFileContent,
  QueryKeys.skillTree,
  QueryKeys.skillNodeContent,
] as const;

export type EventHandlerParams = {
  isAddedRequest?: boolean;
  runIndex?: number;
  setCompleted: React.Dispatch<React.SetStateAction<Set<unknown>>>;
  setMessages: (messages: TMessage[]) => void;
  getMessages: () => TMessage[] | undefined;
  setIsSubmitting: React.Dispatch<React.SetStateAction<boolean>>;
  setConversation?: React.Dispatch<React.SetStateAction<TConversation | null>>;
  newConversation?: ConvoGenerator;
  setShowStopButton: React.Dispatch<React.SetStateAction<boolean>>;
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
  const reasoningStore = useStore();
  const { announcePolite } = useLiveAnnouncer();
  const applyAgentTemplate = useApplyAgentTemplate();
  /** Cleared on every terminal path below: the elapsed anchor must not outlive
   *  its generation, or a later externally-started run attached at this index
   *  would inherit a stale baseline. Navigation teardown deliberately does not
   *  clear it: a reattach to a still-live run keeps its original start. */
  const setSubmissionStart = useSetAtom(submissionStartFamily(runIndex));
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

  /** Re-stage request context when an early abort restores the draft, so a
   *  retry keeps the references and one-shot reasoning selection already
   *  drained from the composer on submit. */
  const restorePendingContext = useCallback(
    (convoId: string, quotes?: string[], reasoningOverride?: TMessage['reasoningOverride']) => {
      if (Array.isArray(quotes) && quotes.length > 0) {
        reasoningStore.set(pendingQuotesByConvoId(convoId), quotes);
      }
      if (reasoningOverride != null) {
        const reasoningAtom = pendingReasoningOverrideFamily(
          getReasoningStateKey(convoId, runIndex),
        );
        reasoningStore.set(reasoningAtom, (current) => current ?? reasoningOverride);
      }
    },
    [reasoningStore, runIndex],
  );

  const lastAnnouncementTimeRef = useRef(Date.now());
  const { conversationId: paramId } = useParams();

  const { contentHandler, resetContentHandler } = useContentHandler({ setMessages, getMessages });
  /** `refetchType: 'all'` so cached-but-unmounted skill queries refresh too:
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
    lastAnnouncementTimeRef,
    onSkillAuthoringComplete,
    onSubagentIndexChange,
  });
  const attachmentHandler = useAttachmentHandler(queryClient);

  /** Wipe the per-subagent Recoil atoms on conversation navigation.
   *  Historical subagent dialogs rehydrate from the persisted
   *  `subagent_content` on each `tool_call` (written by the backend
   *  at message-save time), so clearing live atoms on switch
   *  doesn't lose any viewable history; it just keeps `atomFamily`
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
      resetSubagentAtoms({ preserveSelectedTask: true });
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

  const focusRegeneratedResponse = useFocusRegeneratedResponse();

  const ctx: EventHandlerContext = {
    queryClient,
    setMessages,
    getMessages,
    setCompleted,
    isAddedRequest,
    runIndex,
    setConversation,
    setIsSubmitting,
    setShowStopButton,
    setSubmissionStart,
    announcePolite,
    lastAnnouncementTimeRef,
    applyAgentTemplate,
    focusRegeneratedResponse,
    location,
    navigate,
    paramId,
    restorePendingContext,
    reconcileFailedCodeDecision,
    recoverConversation,
    attachmentHandler,
    preserveSubagentAtomsForNewConvoIdRef,
  };
  const { messageHandler, syncHandler, createdHandler, titleHandler } = useTurnHandlers(ctx);
  const finalHandler = useFinalHandler(ctx);
  const { errorHandler, abortConversation } = useAbortHandlers(ctx, finalHandler);

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
