import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRecoilValue } from 'recoil';
import { useAtom, useStore } from 'jotai';
import { Constants } from 'librechat-data-provider';
import type { Agents } from 'librechat-data-provider';
import type { AskAnswerStatus } from '~/components/Chat/ask/state';
import {
  useSubmitToolApprovalMutation,
  useSubmitAskAnswerMutation,
  type ResumeAgentFields,
} from '~/data-provider';
import { pendingApprovalActionFamily } from '~/components/Chat/approval/state';
import { askSubmitStatusAtom } from '~/components/Chat/ask/state';
import { resolveAskUserQuestionPart } from '~/utils/approval';
import { ChatContext } from '~/Providers/ChatContext';
import { useGetEphemeralAgent } from '~/store/agents';
import store from '~/store';

/** Shared read/write for the ask-answer submit status. */
export function useAskSubmitStatus(): {
  getAskStatus: (actionId: string) => AskAnswerStatus;
  setAskStatus: (actionId: string, status: AskAnswerStatus) => void;
} {
  const [statusMap, setStatusMap] = useAtom(askSubmitStatusAtom);
  const getAskStatus = useCallback(
    (actionId: string): AskAnswerStatus => statusMap[actionId] ?? 'idle',
    [statusMap],
  );
  const setAskStatus = useCallback(
    (actionId: string, status: AskAnswerStatus) =>
      setStatusMap((prev) => ({ ...prev, [actionId]: status })),
    [setStatusMap],
  );
  return { getAskStatus, setAskStatus };
}

interface ApprovalContextValue {
  /**
   * Bumped whenever registrations or decisions change. Decisions live in refs
   * (synchronous reads), so this is what makes the context value a NEW reference
   * on each change; without it, consumers never re-render and never re-read
   * `isReady`/`getLeadToolCallId` after an update.
   */
  version: number;
  /** Record (or clear) a card's decision for its tool_call within an action. */
  setDecision: (
    actionId: string,
    toolCallId: string,
    decision: Agents.ToolApprovalResolution | null,
  ) => void;
  /** Current decision a card holds, if any (drives selected-state styling). */
  getDecision: (actionId: string, toolCallId: string) => Agents.ToolApprovalResolution | undefined;
  /** Shared form state for duplicated timeline/composer review surfaces. */
  getDecisionDraft: (actionId: string, toolCallId: string) => ToolApprovalDecisionDraft | undefined;
  /** Replace a tool call's shared form state and notify every rendered surface. */
  setDecisionDraft: (
    actionId: string,
    toolCallId: string,
    draft: ToolApprovalDecisionDraft,
  ) => void;
  /** Every recorded decision for an action, in registration order (the submit batch). */
  getDecisions: (actionId: string) => Agents.ToolApprovalResolution[];
  /** Declare that a tool_call belongs to an action so submit can require all. */
  registerToolCall: (actionId: string, toolCallId: string) => void;
  /** Drop a tool_call's registration when its card unmounts, so a resolved/removed
   *  card can't keep `isReady` false and wedge the batch submit. */
  unregisterToolCall: (actionId: string, toolCallId: string) => void;
  /** The first-registered tool_call for an action — the single card that owns
   *  the batch submit button (avoids N buttons across sibling cards). */
  getLeadToolCallId: (actionId: string) => string | undefined;
  /** Number of tool calls paused under an action (for a "1 of N" label). */
  getRegisteredCount: (actionId: string) => number;
  /** True once every registered tool_call in the action has a decision. */
  isReady: (actionId: string) => boolean;
  /** Lifecycle status for an action (so cards can disable / show messages). */
  getStatus: (actionId: string) => AskAnswerStatus;
  /** Set an action's submission status (driven by the cards' submit via `useResumeSubmit`). */
  setStatus: (actionId: string, status: AskAnswerStatus) => void;
  /** Atomically claim submission for an action across every rendered review surface. */
  beginToolSubmission: (actionId: string) => boolean;
  /** Release a claimed action after a retryable submission failure. */
  endToolSubmission: (actionId: string) => void;
  /** Restore a free-form question answer after transient phase-slice remounts. */
  getAskAnswerDraft: (actionId: string) => string;
  /** Retain a free-form question answer for this response message's lifetime. */
  setAskAnswerDraft: (actionId: string, answer: string) => void;
}

const ApprovalContext = createContext<ApprovalContextValue | null>(null);

export interface ToolApprovalDecisionDraft {
  active: Agents.ToolApprovalDecisionType | null;
  editText: string;
  responseText: string;
  reason: string;
}

/** Cards call this; outside a provider it degrades to inert no-ops so a tool
 *  call without an active approval never crashes. */
export const useApprovalContext = (): ApprovalContextValue => {
  const ctx = useContext(ApprovalContext);
  return ctx ?? FALLBACK;
};

const FALLBACK: ApprovalContextValue = {
  version: 0,
  setDecision: () => undefined,
  getDecision: () => undefined,
  getDecisionDraft: () => undefined,
  setDecisionDraft: () => undefined,
  getDecisions: () => [],
  registerToolCall: () => undefined,
  unregisterToolCall: () => undefined,
  getLeadToolCallId: () => undefined,
  getRegisteredCount: () => 0,
  isReady: () => false,
  getStatus: () => 'idle',
  setStatus: () => undefined,
  beginToolSubmission: () => false,
  endToolSubmission: () => undefined,
  getAskAnswerDraft: () => '',
  setAskAnswerDraft: () => undefined,
};

const isExpiredError = (error: unknown): boolean => {
  const status = (error as { response?: { status?: number } } | undefined)?.response?.status;
  return status === 409;
};

/**
 * Coordinates human-in-the-loop decisions for a single response message.
 *
 * An action may pause multiple tool calls (same `actionId`); each `ToolApproval`
 * card registers its `tool_call_id` and records a decision here, and the lead card
 * submits ONCE with the full `decisions[]` covering every paused call (the server
 * rejects a partial batch).
 *
 * Intentionally PURE state — it does NOT read `ChatContext`, the agent store, or
 * React Query. Message content renders in places without those providers (shared /
 * exported views, tests), so the provider must be safe to mount anywhere. The
 * context-dependent submit lives in {@link useResumeSubmit}, which the cards call —
 * and the cards only render inside a live chat view where those providers exist.
 */
export default function ApprovalProvider({
  children,
  pendingAction,
}: {
  children: React.ReactNode;
  pendingAction?: Agents.PendingAction | null;
}) {
  /** Content slices keep their historical local provider so exported/read-only
   *  renderers remain self-contained. Inside a live chat, reuse the provider
   *  spanning messages and composer instead of shadowing its decisions. */
  const parent = useContext(ApprovalContext);
  if (parent != null) {
    return <>{children}</>;
  }
  return <ApprovalStateProvider pendingAction={pendingAction}>{children}</ApprovalStateProvider>;
}

function ApprovalStateProvider({
  children,
  pendingAction,
}: {
  children: React.ReactNode;
  pendingAction?: Agents.PendingAction | null;
}) {
  /** actionId → (tool_call_id → resolution). Mutable refs so reads are
   *  synchronous for `isReady`/submit; `version` is threaded into the context
   *  value so each bump produces a new value reference and consumers re-render
   *  (the callbacks alone are referentially stable, so without it a bump would
   *  never propagate past the memoized value). */
  const decisionsRef = useRef(new Map<string, Map<string, Agents.ToolApprovalResolution>>());
  const decisionDraftsRef = useRef(new Map<string, Map<string, ToolApprovalDecisionDraft>>());
  const registeredRef = useRef(new Map<string, Map<string, number>>());
  /** Server-owned batch membership. Unlike card registrations, this survives
   *  folding, virtualization, late tool parts, and a second composer surface. */
  const authoritativeRef = useRef(new Map<string, string[]>());
  const authoritativeActionIdRef = useRef<string | null>(null);
  const askAnswerDraftsRef = useRef(new Map<string, string>());
  const submittingToolActionIdsRef = useRef(new Set<string>());
  const [version, bump] = useState(0);
  const rerender = useCallback(() => bump((v) => v + 1), []);
  const [statusByAction, setStatusByAction] = useState<Record<string, AskAnswerStatus>>({});

  useEffect(() => {
    if (pendingAction?.payload.type !== 'tool_approval') {
      authoritativeRef.current.clear();
      authoritativeActionIdRef.current = null;
      rerender();
      return;
    }
    const { actionId } = pendingAction;
    const nextIds = Array.from(
      new Set(pendingAction.payload.action_requests.map((request) => request.tool_call_id)),
    );
    if (authoritativeActionIdRef.current !== actionId) {
      decisionsRef.current.clear();
      decisionDraftsRef.current.clear();
      registeredRef.current.clear();
      authoritativeRef.current.clear();
      submittingToolActionIdsRef.current.clear();
      setStatusByAction({});
    }
    authoritativeActionIdRef.current = actionId;
    authoritativeRef.current.set(actionId, nextIds);
    rerender();
  }, [pendingAction, rerender]);

  const registerToolCall = useCallback(
    (actionId: string, toolCallId: string) => {
      const counts = registeredRef.current.get(actionId) ?? new Map<string, number>();
      counts.set(toolCallId, (counts.get(toolCallId) ?? 0) + 1);
      registeredRef.current.set(actionId, counts);
      /** A newly-registered call shifts the lead / "of N" count for sibling
       *  cards — re-render so they reflect it. */
      rerender();
    },
    [rerender],
  );

  const unregisterToolCall = useCallback(
    (actionId: string, toolCallId: string) => {
      const counts = registeredRef.current.get(actionId);
      const count = counts?.get(toolCallId);
      if (!counts || count == null) {
        return;
      }
      if (count > 1) {
        counts.set(toolCallId, count - 1);
      } else {
        counts.delete(toolCallId);
      }
      if (counts.size === 0) {
        registeredRef.current.delete(actionId);
      }
      /** Keep the decision for the provider's message-scoped lifetime. A
       *  phase label can resolve while an approval card is visible, moving
       *  that card through a nested phase segment; its transient unmount must
       *  not erase the user's selection. Unregistered decisions are excluded
       *  from submit/readiness and disappear with this provider. */
      rerender();
    },
    [rerender],
  );

  const getLeadToolCallId = useCallback(
    (actionId: string) =>
      authoritativeRef.current.get(actionId)?.[0] ??
      registeredRef.current.get(actionId)?.keys().next().value,
    [],
  );

  const getRegisteredCount = useCallback(
    (actionId: string) =>
      authoritativeRef.current.get(actionId)?.length ??
      registeredRef.current.get(actionId)?.size ??
      0,
    [],
  );

  const setDecision = useCallback(
    (actionId: string, toolCallId: string, decision: Agents.ToolApprovalResolution | null) => {
      const map = decisionsRef.current.get(actionId) ?? new Map();
      if (decision == null) {
        map.delete(toolCallId);
      } else {
        map.set(toolCallId, decision);
      }
      decisionsRef.current.set(actionId, map);
      rerender();
    },
    [rerender],
  );

  const getDecision = useCallback(
    (actionId: string, toolCallId: string) => decisionsRef.current.get(actionId)?.get(toolCallId),
    [],
  );

  const getDecisionDraft = useCallback(
    (actionId: string, toolCallId: string) =>
      decisionDraftsRef.current.get(actionId)?.get(toolCallId),
    [],
  );

  const setDecisionDraft = useCallback(
    (actionId: string, toolCallId: string, draft: ToolApprovalDecisionDraft) => {
      const drafts = decisionDraftsRef.current.get(actionId) ?? new Map();
      drafts.set(toolCallId, draft);
      decisionDraftsRef.current.set(actionId, drafts);
      rerender();
    },
    [rerender],
  );

  const getDecisions = useCallback((actionId: string) => {
    const required = authoritativeRef.current.get(actionId) ?? [
      ...(registeredRef.current.get(actionId)?.keys() ?? []),
    ];
    const decisions = decisionsRef.current.get(actionId);
    if (required.length === 0 || decisions == null) {
      return [];
    }
    return required.flatMap((toolCallId) => {
      const decision = decisions.get(toolCallId);
      return decision == null ? [] : [decision];
    });
  }, []);

  const isReady = useCallback((actionId: string) => {
    const required = authoritativeRef.current.get(actionId) ?? [
      ...(registeredRef.current.get(actionId)?.keys() ?? []),
    ];
    const decided = decisionsRef.current.get(actionId);
    if (required.length === 0) {
      return false;
    }
    for (const toolCallId of required) {
      if (!decided?.has(toolCallId)) {
        return false;
      }
    }
    return true;
  }, []);

  const getStatus = useCallback(
    (actionId: string): AskAnswerStatus => statusByAction[actionId] ?? 'idle',
    [statusByAction],
  );

  const setStatus = useCallback((actionId: string, status: AskAnswerStatus) => {
    setStatusByAction((prev) => ({ ...prev, [actionId]: status }));
  }, []);

  const beginToolSubmission = useCallback((actionId: string): boolean => {
    if (submittingToolActionIdsRef.current.has(actionId)) {
      return false;
    }
    submittingToolActionIdsRef.current.add(actionId);
    return true;
  }, []);

  const endToolSubmission = useCallback((actionId: string) => {
    submittingToolActionIdsRef.current.delete(actionId);
  }, []);

  const getAskAnswerDraft = useCallback(
    (actionId: string) => askAnswerDraftsRef.current.get(actionId) ?? '',
    [],
  );

  const setAskAnswerDraft = useCallback((actionId: string, answer: string) => {
    if (answer.length === 0) {
      askAnswerDraftsRef.current.delete(actionId);
      return;
    }
    askAnswerDraftsRef.current.set(actionId, answer);
  }, []);

  const value = useMemo<ApprovalContextValue>(
    () => ({
      version,
      setDecision,
      getDecision,
      getDecisionDraft,
      setDecisionDraft,
      getDecisions,
      registerToolCall,
      unregisterToolCall,
      getLeadToolCallId,
      getRegisteredCount,
      isReady,
      getStatus,
      setStatus,
      beginToolSubmission,
      endToolSubmission,
      getAskAnswerDraft,
      setAskAnswerDraft,
    }),
    [
      version,
      setDecision,
      getDecision,
      getDecisionDraft,
      setDecisionDraft,
      getDecisions,
      registerToolCall,
      unregisterToolCall,
      getLeadToolCallId,
      getRegisteredCount,
      isReady,
      getStatus,
      setStatus,
      beginToolSubmission,
      endToolSubmission,
      getAskAnswerDraft,
      setAskAnswerDraft,
    ],
  );

  return <ApprovalContext.Provider value={value}>{children}</ApprovalContext.Provider>;
}

/**
 * Submit hook for the approval cards. Sources the resume body's agent/endpoint
 * fields from the active conversation (so the route's shared `buildEndpointOption`
 * middleware reconstructs the same agent) and fires the resume mutation, threading
 * the result back into the action's status.
 *
 * Reads `ChatContext` / the agent store / React Query. The cards render it from
 * live chat views but ALSO from contexts without a `ChatContext.Provider` (e.g. a
 * subagent tool paused inside an isolated activity surface, or a search/citation render that
 * passes chat context as a prop), so it reads the context non-throwingly: with no
 * conversation, `buildResumeFields` returns null and the controls are inert rather
 * than crashing.
 */
export function useResumeSubmit() {
  const jotaiStore = useStore();
  const chatContext = useContext(ChatContext);
  const conversation = chatContext?.conversation;
  const getEphemeralAgent = useGetEphemeralAgent();
  const approvalMutation = useSubmitToolApprovalMutation();
  const askMutation = useSubmitAskAnswerMutation();
  const { getDecisions, isReady, setStatus, beginToolSubmission, endToolSubmission } =
    useApprovalContext();
  const submittingAskActionIdsRef = useRef(new Set<string>());
  /** Ask status lives in Jotai so it works from the composer (outside the
   *  provider); tool-approval status stays on the context. */
  const { setAskStatus } = useAskSubmitStatus();
  const activeGenerationCreatedAt = useRecoilValue(
    store.activeGenerationCreatedAtByConvoId(conversation?.conversationId ?? Constants.NEW_CONVO),
  );

  const buildResumeFields = useCallback((): ResumeAgentFields | null => {
    const conversationId = conversation?.conversationId;
    if (
      !conversationId ||
      conversationId === Constants.NEW_CONVO ||
      activeGenerationCreatedAt == null
    ) {
      return null;
    }
    return {
      conversationId,
      generationCreatedAt: activeGenerationCreatedAt,
      endpoint: conversation?.endpoint,
      endpointType: conversation?.endpointType,
      agent_id: conversation?.agent_id,
      model: conversation?.model,
      spec: conversation?.spec,
      // Ephemeral agents derive their instructions from promptPrefix — re-send it so
      // the resumed run rebuilds the same graph and matches the server fingerprint.
      promptPrefix: conversation?.promptPrefix,
      ephemeralAgent: getEphemeralAgent(conversationId),
    };
  }, [conversation, getEphemeralAgent, activeGenerationCreatedAt]);

  const submitToolApproval = useCallback(
    (actionId: string) => {
      const fields = buildResumeFields();
      const decisions = getDecisions(actionId);
      if (!fields || decisions.length === 0 || !isReady(actionId)) {
        return;
      }
      if (!beginToolSubmission(actionId)) {
        return;
      }
      setStatus(actionId, 'submitting');
      approvalMutation.mutate(
        { ...fields, actionId, decisions },
        {
          onSuccess: () => {
            setStatus(actionId, 'submitted');
            const pendingAtom = pendingApprovalActionFamily(fields.conversationId);
            if (jotaiStore.get(pendingAtom)?.actionId === actionId) {
              jotaiStore.set(pendingAtom, null);
            }
          },
          onError: (error) => {
            const expired = isExpiredError(error);
            if (!expired) {
              // Network/validation failures are retryable; a 409 is terminal.
              endToolSubmission(actionId);
            }
            setStatus(actionId, expired ? 'expired' : 'error');
          },
        },
      );
    },
    [
      approvalMutation,
      beginToolSubmission,
      buildResumeFields,
      endToolSubmission,
      getDecisions,
      isReady,
      jotaiStore,
      setStatus,
    ],
  );

  const submitAskAnswer = useCallback(
    (
      actionId: string,
      resolution: string | Record<string, string>,
      opts?: { onSuccess?: () => void },
    ) => {
      const fields = buildResumeFields();
      const isBatch = typeof resolution !== 'string';
      const hasAnswer = isBatch ? Object.keys(resolution).length > 0 : resolution.length > 0;
      if (!fields || !hasAnswer) {
        return;
      }
      if (submittingAskActionIdsRef.current.has(actionId)) {
        return;
      }
      submittingAskActionIdsRef.current.add(actionId);
      setAskStatus(actionId, 'submitting');
      askMutation.mutate(
        {
          ...fields,
          actionId,
          ...(isBatch ? { answers: resolution } : { answer: resolution }),
        },
        {
          onSuccess: () => {
            setAskStatus(actionId, 'submitted');
            /**
             * Drop the synthetic question part now that the run is resuming: the
             * server streams the resumed segment at ABSOLUTE content indices
             * continuing after the pre-pause parts — the exact slot this appended
             * part occupies. Left in place it blocks that index and the resumed
             * output doesn't render until finalize. The Q&A's durable record is
             * the ask_user_question tool call itself.
             */
            const messages = chatContext?.getMessages?.();
            if (messages && chatContext?.setMessages) {
              let changed = false;
              const next = messages.map((message) => {
                const resolved = resolveAskUserQuestionPart(message, actionId, resolution);
                if (resolved !== message) {
                  changed = true;
                }
                return resolved;
              });
              if (changed) {
                chatContext.setMessages(next);
              }
            }
            /**
             * Caller cleanup (clearing the composer / selection) runs ONLY on
             * success: the composer is the user's sole copy of a free-form
             * answer, so a failed resume (400 on the answer cap, expiry, a
             * network error) must leave it intact for the user to trim/retry.
             */
            opts?.onSuccess?.();
          },
          onError: (error) => {
            const expired = isExpiredError(error);
            if (!expired) {
              submittingAskActionIdsRef.current.delete(actionId);
            }
            setAskStatus(actionId, expired ? 'expired' : 'error');
          },
        },
      );
    },
    [askMutation, buildResumeFields, setAskStatus, chatContext],
  );

  return { submitToolApproval, submitAskAnswer };
}
