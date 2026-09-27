import { useCallback, useRef } from 'react';
import { useStore } from 'jotai';
import { useRecoilCallback } from 'recoil';
import {
  Constants,
  StepTypes,
  StepEvents,
  ContentTypes,
  ToolCallTypes,
  getNonEmptyValue,
  getRunStepDurationMs,
} from 'librechat-data-provider';
import type {
  Agents,
  TMessage,
  PartMetadata,
  ContentMetadata,
  EventSubmission,
  SummaryContentPart,
  TMessageContentParts,
  SubagentUpdateEvent,
  SandboxStartingEvent,
  PtcToolCallEvent,
} from 'librechat-data-provider';
import type { SetterOrUpdater } from 'recoil';
import type { AnnounceOptions } from '~/common';
import {
  closeParentSubagentProgress,
  listRegisteredSubagentProgressKeys,
  reduceSubagentProgress,
  registerSubagentProgressKey,
  removeSubagentProgressAtoms,
  subagentParentStreamOpenByToolCallId,
  subagentProgressByToolCallId,
  takeRegisteredSubagentProgressKeys,
  subagentProgressKey,
} from '~/components/Chat/Subagents/state';
import {
  sandboxStartingByToolCallId,
  ptcTraceByToolCallId,
  PTC_TRACE_MAX_ENTRIES,
  ptcTraceKey,
} from '~/store';
import { isAskUserQuestionPart, isAnsweredAskUserQuestionPart } from '~/utils/approval';
import { MESSAGE_UPDATE_INTERVAL } from '~/common';

type TUseStepHandler = {
  announcePolite: (options: AnnounceOptions) => void;
  setMessages: (messages: TMessage[]) => void;
  getMessages: () => TMessage[] | undefined;
  /** @deprecated - isSubmitting should be derived from submission state */
  setIsSubmitting?: SetterOrUpdater<boolean>;
  lastAnnouncementTimeRef: React.MutableRefObject<number>;
  /**
   * Fired when a completed `create_file`/`edit_file` call targeted a
   * `skills/...` path. The caller owns the side effect (skill query cache
   * invalidation) so this hook stays free of query-client coupling.
   */
  onSkillAuthoringComplete?: () => void;
  onSubagentIndexChange?: (conversationId: string) => void;
};

type TStepEvent =
  | { event: StepEvents.ON_RUN_STEP; data: Agents.RunStep }
  | { event: StepEvents.ON_AGENT_UPDATE; data: Agents.AgentUpdate }
  | { event: StepEvents.ON_MESSAGE_DELTA; data: Agents.MessageDeltaEvent }
  | { event: StepEvents.ON_REASONING_DELTA; data: Agents.ReasoningDeltaEvent }
  | { event: StepEvents.ON_RUN_STEP_DELTA; data: Agents.RunStepDeltaEvent }
  | { event: StepEvents.ON_RUN_STEP_COMPLETED; data: { result: Agents.ToolEndEvent } }
  | { event: StepEvents.ON_RUN_STEP_CLOSED; data: Agents.RunStepClosedEvent }
  | { event: StepEvents.ON_SUMMARIZE_START; data: Agents.SummarizeStartEvent }
  | { event: StepEvents.ON_SUMMARIZE_DELTA; data: Agents.SummarizeDeltaEvent }
  | { event: StepEvents.ON_SUMMARIZE_COMPLETE; data: Agents.SummarizeCompleteEvent }
  | { event: StepEvents.ON_SUBAGENT_UPDATE; data: SubagentUpdateEvent }
  | { event: StepEvents.ON_SANDBOX_STARTING; data: SandboxStartingEvent }
  | { event: StepEvents.ON_PTC_TOOL_CALL; data: PtcToolCallEvent };

type MessageDeltaUpdate = {
  type: ContentTypes.TEXT;
  text: string;
  tool_call_ids?: string[];
  phase?: 'commentary' | 'final_answer';
};

type ReasoningDeltaUpdate = { type: ContentTypes.THINK; think: string };

/** Starts a fresh label-revision domain when a different reasoning step
 * reuses or folds into an existing THINK slot. The step id is stamped before
 * the first generated title so compacted resume snapshots can still correlate
 * later label events by identity rather than relying only on a sparse index. */
function prepareReasoningPartForStep(message: TMessage, index: number, stepId: string): TMessage {
  const current = message.content?.[index];
  if (current?.type !== ContentTypes.THINK || current.reasoning_label_step_id === stepId) {
    return message;
  }
  const nextPart = { ...current };
  delete nextPart.reasoning_label;
  delete nextPart.reasoning_label_attempts;
  delete nextPart.reasoning_label_submitted_chars;
  delete nextPart.reasoning_label_revision;
  delete nextPart.reasoning_label_status;
  nextPart.reasoning_label_step_id = stepId;
  const nextContent = [...(message.content ?? [])];
  nextContent[index] = nextPart;
  return { ...message, content: nextContent };
}

type AllContentTypes =
  | ContentTypes.TEXT
  | ContentTypes.THINK
  | ContentTypes.TOOL_CALL
  | ContentTypes.IMAGE_FILE
  | ContentTypes.IMAGE_URL
  | ContentTypes.SUMMARY
  | ContentTypes.ERROR;

/** Mirrors `SKILL_FILE_PREFIX` in `@librechat/api` file-authoring handlers. */
const SKILL_FILE_PREFIX = 'skills/';
const FILE_AUTHORING_TOOLS = new Set(['create_file', 'edit_file']);

/**
 * True when a completed tool call authored a skill file (`create_file` /
 * `edit_file` targeting a `skills/...` path). Skills created or edited
 * mid-chat must invalidate the cached skill queries, or the Skills panel
 * and builder keep showing the pre-authoring catalog.
 */
function isSkillAuthoringToolCall(toolCall?: Agents.ToolCall): boolean {
  if (!toolCall?.name || !FILE_AUTHORING_TOOLS.has(toolCall.name)) {
    return false;
  }
  const { args } = toolCall;
  let filePath: unknown;
  if (typeof args === 'object' && args !== null) {
    filePath = (args as { file_path?: unknown }).file_path;
  } else if (typeof args === 'string') {
    try {
      filePath = (JSON.parse(args) as { file_path?: unknown }).file_path;
    } catch {
      return false;
    }
  }
  return typeof filePath === 'string' && filePath.startsWith(SKILL_FILE_PREFIX);
}

const isOAuthToolCallName = (name?: string) =>
  typeof name === 'string' && name.startsWith(`oauth${Constants.mcp_delimiter}`);

const isOAuthToolCallContent = (part?: Partial<TMessageContentParts>) => {
  if (part?.type !== ContentTypes.TOOL_CALL || !('tool_call' in part)) {
    return false;
  }
  const { tool_call: toolCall } = part;
  const name = toolCall != null && 'name' in toolCall ? toolCall.name : undefined;
  return isOAuthToolCallName(name);
};

export default function useStepHandler({
  setMessages,
  getMessages,
  announcePolite,
  lastAnnouncementTimeRef,
  onSkillAuthoringComplete,
  onSubagentIndexChange,
}: TUseStepHandler) {
  const subagentStore = useStore();
  const toolCallIdMap = useRef(new Map<string, string | undefined>());
  const messageMap = useRef(new Map<string, TMessage>());
  const stepMap = useRef(new Map<string, Agents.RunStep>());
  /** Buffer for deltas that arrive before their corresponding run step */
  const pendingDeltaBuffer = useRef(new Map<string, TStepEvent[]>());
  /** Coalesces rapid-fire summarize delta renders into a single rAF frame */
  const summarizeDeltaRaf = useRef<number | null>(null);
  /** Coalesces per-token message/reasoning delta cache writes into one rAF frame.
   * `deltaFlushScheduled` (not the handle) gates scheduling: the handle is
   * assigned after `requestAnimationFrame` returns, which would race a
   * synchronously-invoked callback. */
  const messageDeltaRaf = useRef<number | null>(null);
  const deltaFlushScheduled = useRef(false);
  const pendingDeltaFlushIds = useRef(new Set<string>());
  const pendingDeltaFlushRef = useRef<(() => void) | null>(null);
  /**
   * Maps `SubagentUpdateEvent.subagentRunId` → one concrete parent content-part
   * occurrence. `payload.parentToolCallId` narrows the candidates when present,
   * but provider IDs are not unique enough to be the atom identity: they may be
   * reused across messages or even within one message. Forward (oldest-first)
   * claiming preserves creation order for both modern and legacy envelopes.
   */
  const subagentRunToInvocationKey = useRef(new Map<string, string>());
  const claimedSubagentInvocationKeys = useRef(new Set<string>());
  /**
   * Buffers for envelopes that arrive before their `subagent` tool call is
   * reflected in `messageMap`. Keyed by `subagentRunId`. Once a tool call is
   * claimed we drain the buffer into the Recoil atom in arrival order.
   */
  const pendingSubagentBuffer = useRef(
    new Map<string, { parentMessageId: string; events: SubagentUpdateEvent[] }>(),
  );
  const getCurrentMessages = useCallback(
    (messages: TMessage[]) => {
      const freshMessages = getMessages();
      return freshMessages && freshMessages.length >= messages.length ? freshMessages : messages;
    },
    [getMessages],
  );

  /** Both content parts and ticker lines are aggregated incrementally
   *  into the atom as each `ON_SUBAGENT_UPDATE` arrives — we never
   *  retain the raw event array, so no rolling window is needed. A
   *  talkative subagent can emit thousands of deltas without growing
   *  memory past what the structural output requires. */

  /**
   * Resolves a subagent run to an occurrence-scoped parent invocation key.
   */
  const resolveSubagentInvocationKey = useCallback(
    (payload: SubagentUpdateEvent, parentMessageId: string): string | undefined => {
      const cached = subagentRunToInvocationKey.current.get(payload.subagentRunId);
      if (cached != null) return cached;
      if (parentMessageId === '') return undefined;

      // Claim one concrete content-part occurrence. Providers can repeat a
      // tool_call ID even within one assistant message, so raw IDs alone are
      // not sufficient identity for either the card or its live progress.
      const preferred = messageMap.current.get(parentMessageId);
      // `runId` gives us the expected parent message. If that message has not
      // arrived yet, buffer instead of claiming a same-ID call from another
      // parallel response; the mapping is permanent once claimed.
      if (preferred == null) return undefined;
      for (const [messageId, message] of [[parentMessageId, preferred] as const]) {
        const content = message.content;
        if (!Array.isArray(content)) continue;
        for (let i = 0; i < content.length; i++) {
          const part = content[i];
          if (part?.type !== ContentTypes.TOOL_CALL) continue;
          const tc = (part as { [ContentTypes.TOOL_CALL]?: { id?: string; name?: string } })[
            ContentTypes.TOOL_CALL
          ];
          if (
            tc?.name === Constants.SUBAGENT &&
            tc.id &&
            (payload.parentToolCallId == null || tc.id === payload.parentToolCallId) &&
            !claimedSubagentInvocationKeys.current.has(subagentProgressKey(messageId, tc.id, i))
          ) {
            const invocationKey = subagentProgressKey(messageId, tc.id, i);
            subagentRunToInvocationKey.current.set(payload.subagentRunId, invocationKey);
            claimedSubagentInvocationKeys.current.add(invocationKey);
            return invocationKey;
          }
        }
      }

      return undefined;
    },
    [],
  );

  /**
   * Merges an incoming {@link SubagentUpdateEvent} into the atom bucket keyed
   * by the parent `tool_call_id`. Buffers early-arriving events whose tool call
   * is not yet mapped, and replays the buffer once correlation completes.
   */
  const applySubagentUpdate = useCallback(
    (payload: SubagentUpdateEvent, parentMessageId: string): void => {
      const invocationKey = resolveSubagentInvocationKey(payload, parentMessageId);

      if (!invocationKey) {
        const pending = pendingSubagentBuffer.current.get(payload.subagentRunId) ?? {
          parentMessageId,
          events: [],
        };
        pending.events.push(payload);
        pendingSubagentBuffer.current.set(payload.subagentRunId, pending);
        return;
      }

      const pending = pendingSubagentBuffer.current.get(payload.subagentRunId);
      if (pending && pending.events.length > 0) {
        pendingSubagentBuffer.current.delete(payload.subagentRunId);
      }
      const toApply = pending ? [...pending.events, payload] : [payload];

      registerSubagentProgressKey(invocationKey);
      subagentStore.set(subagentParentStreamOpenByToolCallId(invocationKey), true);
      subagentStore.set(subagentProgressByToolCallId(invocationKey), (prev) =>
        reduceSubagentProgress(prev, toApply, 'parent', true),
      );
    },
    [resolveSubagentInvocationKey, subagentStore],
  );

  /**
   * Resets all accumulated subagent state. Kept for conversation-switch
   * cleanup (see top-level hook usage) but NOT called from `clearStepMaps` —
   * the collapsed SubagentCall ticker and its panel read from these atoms to
   * render the child's content parts, and we want that history to remain
   * visible after the stream ends so the user can reopen the panel for
   * auditability. The atoms are bounded by aggregated structure and
   * per-conversation (one atom per subagent spawn), so growth is proportional
   * to messages — the same growth profile as the rest of the conversation
   * state.
   */
  const resetSubagentAtoms = useCallback((): void => {
    for (const invocationKey of takeRegisteredSubagentProgressKeys()) {
      /** Clear before freeing: `remove` drops the cached family member but
       *  tells nothing still subscribed to it, so anything mounted at this
       *  boundary has to see the empty value first. */
      subagentStore.set(subagentProgressByToolCallId(invocationKey), null);
      subagentStore.set(subagentParentStreamOpenByToolCallId(invocationKey), false);
      removeSubagentProgressAtoms(invocationKey);
    }
  }, [subagentStore]);

  const closeParentSubagentStreams = useCallback((): void => {
    for (const invocationKey of listRegisteredSubagentProgressKeys()) {
      subagentStore.set(subagentParentStreamOpenByToolCallId(invocationKey), false);
      subagentStore.set(subagentProgressByToolCallId(invocationKey), closeParentSubagentProgress);
    }
  }, [subagentStore]);

  /** Tool-call ids whose sandbox-starting atom is set, so completion can clear them. */
  const knownSandboxAtomKeys = useRef(new Set<string>());

  const sandboxStore = useStore();
  const setSandboxStarting = useCallback(
    (toolCallId: string): void => {
      knownSandboxAtomKeys.current.add(toolCallId);
      sandboxStore.set(sandboxStartingByToolCallId(toolCallId), true);
    },
    [sandboxStore],
  );

  const clearSandboxStarting = useCallback(
    (toolCallId?: string | null): void => {
      if (!toolCallId || !knownSandboxAtomKeys.current.has(toolCallId)) {
        return;
      }
      knownSandboxAtomKeys.current.delete(toolCallId);
      sandboxStore.set(sandboxStartingByToolCallId(toolCallId), false);
    },
    [sandboxStore],
  );

  const resetSandboxAtoms = useCallback((): void => {
    for (const toolCallId of knownSandboxAtomKeys.current) {
      sandboxStore.set(sandboxStartingByToolCallId(toolCallId), false);
    }
    knownSandboxAtomKeys.current.clear();
  }, [sandboxStore]);

  /** PTC tool call ids with a live trace, so the atoms can be released. */
  const knownPtcAtomKeys = useRef(new Set<string>());

  /**
   * Folds one `on_ptc_tool_call` envelope into its program's trace: the
   * `running` event appends a row, the settling event updates that row in
   * place by `call_id`. Order follows the sandbox's dispatch order, which is
   * what the code reads like — a round trip can settle out of order.
   */
  const applyPtcToolCall = useRecoilCallback(
    ({ set }) =>
      (event: PtcToolCallEvent, parentMessageId: string): void => {
        const { tool_call_id: toolCallId, call_id: callId, name, status } = event;
        /** No parent message means no occurrence to scope this to; a raw
         *  `tool_call_id` would leak the rows into whichever card reused it. */
        if (!toolCallId || !callId || !parentMessageId) {
          return;
        }
        const atomKey = ptcTraceKey(parentMessageId, toolCallId);
        knownPtcAtomKeys.current.add(atomKey);
        set(ptcTraceByToolCallId(atomKey), (previous) => {
          const index = previous.entries.findIndex((entry) => entry.callId === callId);
          const entry = {
            callId,
            name,
            status,
            ...(event.args ? { args: event.args } : {}),
            ...(event.error ? { error: event.error } : {}),
            ...(event.durationMs != null ? { durationMs: event.durationMs } : {}),
          };

          if (index !== -1) {
            const next = [...previous.entries];
            next[index] = { ...previous.entries[index], ...entry };
            return { entries: next, dropped: previous.dropped };
          }

          /** A settle whose row is gone — evicted by the cap, or pruned across
           *  a resume gap — must not reappear at the tail out of order. */
          if (status !== 'running') {
            return previous;
          }

          const appended = [...previous.entries, entry];
          const overflow = appended.length - PTC_TRACE_MAX_ENTRIES;
          if (overflow <= 0) {
            return { entries: appended, dropped: previous.dropped };
          }
          return {
            entries: appended.slice(overflow),
            dropped: previous.dropped + overflow,
          };
        });
      },
    [],
  );

  const resetPtcAtoms = useRecoilCallback(
    ({ reset }) =>
      (): void => {
        for (const atomKey of knownPtcAtomKeys.current) {
          reset(ptcTraceByToolCallId(atomKey));
        }
        knownPtcAtomKeys.current.clear();
      },
    [],
  );

  /**
   * Settles rows still marked `running` after a stream gap as `interrupted`.
   * Inner calls carry no durable state — they are not content parts, so the
   * resume snapshot cannot rebuild them and a settling event lost in the gap
   * is never replayed — which means such a row would otherwise spin forever.
   *
   * Marked, not removed: a call can also still be executing across the
   * reconnect, and its settling event then arrives normally on the restored
   * live stream. That event updates this row in place, so the call reports its
   * real outcome. Deleting the row would strand it — a settle whose row is
   * gone is dropped rather than re-appended out of order — and the call would
   * vanish from the trace despite having run. Settled rows are untouched.
   */
  const prunePtcTraces = useRecoilCallback(
    ({ set }) =>
      (): void => {
        for (const atomKey of knownPtcAtomKeys.current) {
          set(ptcTraceByToolCallId(atomKey), (previous) =>
            previous.entries.some((entry) => entry.status === 'running')
              ? {
                  ...previous,
                  entries: previous.entries.map((entry) =>
                    entry.status === 'running'
                      ? { ...entry, status: 'interrupted' as const }
                      : entry,
                  ),
                }
              : previous,
          );
        }
      },
    [],
  );

  /**
   * Calculate content index for a run step.
   *
   * Takes the edit-prefix OFFSET rather than the prefix array: after a resume
   * sync the live array no longer describes the retained prefix, so deriving
   * the offset here from its length would disagree with the offset every
   * other event path applies.
   */
  const calculateContentIndex = useCallback(
    (
      serverIndex: number,
      editPrefixOffset: number,
      incomingContentType: string,
      existingContent?: TMessageContentParts[],
      incomingPhase?: 'commentary' | 'final_answer',
    ): number => {
      /** Only apply -1 adjustment for TEXT or THINK types when they match existing content */
      if (
        editPrefixOffset > 0 &&
        (incomingContentType === ContentTypes.TEXT || incomingContentType === ContentTypes.THINK)
      ) {
        const targetIndex = serverIndex + editPrefixOffset - 1;
        const existingPart = existingContent?.[targetIndex];
        const existingType = existingPart?.type;
        const existingPhase =
          existingPart?.type === ContentTypes.TEXT ? existingPart.phase : undefined;
        /** Match final assembly: phased and legacy/unphased text cannot share
         *  a content part because the phase controls client grouping. */
        const phaseCompatible =
          incomingContentType !== ContentTypes.TEXT ||
          (incomingPhase ?? null) === (existingPhase ?? null);
        if (existingType === incomingContentType && phaseCompatible) {
          return targetIndex;
        }
      }
      return serverIndex + editPrefixOffset;
    },
    [],
  );

  /** Metadata to propagate onto content parts for parallel rendering - uses ContentMetadata from data-provider */

  const updateContent = (
    message: TMessage,
    index: number,
    contentPart: Agents.MessageContentComplex,
    finalUpdate = false,
    metadata?: ContentMetadata,
  ) => {
    const contentType = contentPart.type ?? '';
    if (!contentType) {
      console.warn('No content type found in content part');
      return message;
    }

    const incomingOAuthToolCall =
      contentType === ContentTypes.TOOL_CALL &&
      'tool_call' in contentPart &&
      isOAuthToolCallName(contentPart.tool_call?.name);

    let updatedContent = [...(message.content || [])] as Array<
      Partial<TMessageContentParts> | undefined
    >;

    const oauthPromptOccupiesSlot = isOAuthToolCallContent(updatedContent[index]);
    if (!incomingOAuthToolCall && oauthPromptOccupiesSlot) {
      updatedContent = updatedContent.filter((part) => !isOAuthToolCallContent(part));
    }

    /**
     * The synthetic ask-user-question card is pause-scoped UI appended at the end
     * of the content — exactly the ABSOLUTE index the resumed segment streams
     * into. Once real content arrives for that slot the pause is over: displace
     * the card (same displacement pattern as the OAuth prompt above) instead of
     * dropping the incoming part as a type mismatch. Covers the streaming
     * handler's own in-flight message copy, reconnecting tabs, and other devices
     * — the store-level strip on answer submit can't reach those.
     */
    if (isAskUserQuestionPart(updatedContent[index])) {
      updatedContent[index] = undefined;
    } else if (updatedContent.some(isAnsweredAskUserQuestionPart)) {
      /**
       * An ALREADY-ANSWERED card the resumed segment streams around rather than
       * into: the first event after the resume re-renders the ask tool_call at
       * ITS OWN index, so the slot test above never fires and this handler's
       * cached copy — which still holds the card the answer-submit stripped from
       * the store — gets written back, reopening the popover with its options
       * locked. Only cards the user actually answered are dropped, so an event
       * racing a still-live pause can't take its card down. Preserve sparse
       * absolute indices: compacting holes can move an older tool call into a
       * text slot until the terminal snapshot repairs the rendered order.
       */
      updatedContent = updatedContent.map((part) =>
        isAnsweredAskUserQuestionPart(part) ? undefined : part,
      );
    }

    if (!updatedContent[index] && contentType !== ContentTypes.TOOL_CALL) {
      updatedContent[index] = { type: contentPart.type as AllContentTypes };
    }

    /** Prevent overwriting an existing content part with a different type */
    const existingType = (updatedContent[index]?.type as string | undefined) ?? '';
    if (
      existingType &&
      existingType !== contentType &&
      !contentType.startsWith(existingType) &&
      !existingType.startsWith(contentType)
    ) {
      console.warn('Content type mismatch', { existingType, contentType, index });
      return message;
    }

    if (
      contentType.startsWith(ContentTypes.TEXT) &&
      ContentTypes.TEXT in contentPart &&
      typeof contentPart.text === 'string'
    ) {
      const currentContent = updatedContent[index] as MessageDeltaUpdate;
      const incomingContent = contentPart as MessageDeltaUpdate;
      const phase = incomingContent.phase ?? currentContent.phase;
      const update: MessageDeltaUpdate = {
        type: ContentTypes.TEXT,
        text: (currentContent.text || '') + incomingContent.text,
        ...(phase != null && { phase }),
      };

      if ('tool_call_ids' in contentPart && contentPart.tool_call_ids != null) {
        update.tool_call_ids = contentPart.tool_call_ids;
      }
      updatedContent[index] = update;
    } else if (
      contentType.startsWith(ContentTypes.AGENT_UPDATE) &&
      ContentTypes.AGENT_UPDATE in contentPart &&
      contentPart.agent_update
    ) {
      const update: Agents.AgentUpdate = {
        type: ContentTypes.AGENT_UPDATE,
        agent_update: contentPart.agent_update,
      };

      updatedContent[index] = update;
    } else if (
      contentType.startsWith(ContentTypes.THINK) &&
      ContentTypes.THINK in contentPart &&
      typeof contentPart.think === 'string'
    ) {
      const currentContent = updatedContent[index] as ReasoningDeltaUpdate;
      const update: ReasoningDeltaUpdate = {
        ...currentContent,
        type: ContentTypes.THINK,
        think: (currentContent.think || '') + contentPart.think,
      };

      updatedContent[index] = update;
    } else if (contentType === ContentTypes.IMAGE_URL && 'image_url' in contentPart) {
      const currentContent = updatedContent[index] as {
        type: ContentTypes.IMAGE_URL;
        image_url: string;
      };
      updatedContent[index] = {
        ...currentContent,
      };
    } else if (contentType === ContentTypes.SUMMARY) {
      const currentSummary = updatedContent[index] as SummaryContentPart | undefined;
      const incoming = contentPart as SummaryContentPart;
      updatedContent[index] = {
        ...incoming,
        content: [...(currentSummary?.content ?? []), ...(incoming.content ?? [])],
      };
    } else if (contentType === ContentTypes.TOOL_CALL && 'tool_call' in contentPart) {
      const existingContent = updatedContent[index] as Agents.ToolCallContent | undefined;
      const existingToolCall = existingContent?.tool_call;
      const toolCallArgs = (contentPart.tool_call as Agents.ToolCall).args;
      /** When args are a valid object, they are likely already invoked */
      let args =
        finalUpdate ||
        typeof existingToolCall?.args === 'object' ||
        typeof toolCallArgs === 'object'
          ? contentPart.tool_call.args
          : (existingToolCall?.args ?? '') + (toolCallArgs ?? '');
      /** Preserve previously streamed args when final update omits them */
      if (finalUpdate && args == null && existingToolCall?.args != null) {
        args = existingToolCall.args;
      }

      const id = getNonEmptyValue([contentPart.tool_call.id, existingToolCall?.id]) ?? '';
      const name = getNonEmptyValue([contentPart.tool_call.name, existingToolCall?.name]) ?? '';

      const newToolCall: Agents.ToolCall & PartMetadata = {
        id,
        name,
        args,
        stepId: getNonEmptyValue([contentPart.tool_call.stepId, existingToolCall?.stepId]),
        type: ToolCallTypes.TOOL_CALL,
        auth: contentPart.tool_call.auth,
        expires_at: contentPart.tool_call.expires_at,
      };

      if (finalUpdate) {
        newToolCall.progress = 1;
        newToolCall.output = contentPart.tool_call.output;
        if (
          'inputValidationError' in contentPart.tool_call &&
          contentPart.tool_call.inputValidationError === true
        ) {
          Object.assign(newToolCall, { inputValidationError: true });
        }
      }

      updatedContent[index] = {
        type: ContentTypes.TOOL_CALL,
        tool_call: newToolCall,
      };
    }

    // Apply metadata to the content part for parallel rendering
    // This must happen AFTER all content updates to avoid being overwritten
    if (metadata?.agentId != null || metadata?.groupId != null) {
      const part = updatedContent[index] as TMessageContentParts & ContentMetadata;
      if (metadata.agentId != null) {
        part.agentId = metadata.agentId;
      }
      if (metadata.groupId != null) {
        part.groupId = metadata.groupId;
      }
    }

    return { ...message, content: updatedContent as TMessageContentParts[] };
  };

  /** Extract metadata from runStep for parallel content rendering */
  const getStepMetadata = (runStep: Agents.RunStep | undefined): ContentMetadata | undefined => {
    if (!runStep?.agentId && runStep?.groupId == null) {
      return undefined;
    }
    const metadata = {
      agentId: runStep.agentId,
      // Only set groupId when explicitly provided by the server
      // Sequential handoffs have agentId but no groupId
      // Parallel execution has both agentId AND groupId
      groupId: runStep.groupId,
    };
    return metadata;
  };

  const stepHandler = useCallback(
    (stepEvent: TStepEvent, submission: EventSubmission) => {
      const submissionMessages = submission.messages ?? [];
      const getEventMessages = (candidateMessages: TMessage[]) =>
        submission.isRegenerate ? candidateMessages : getCurrentMessages(candidateMessages);
      const messages = getEventMessages(submissionMessages);
      const { userMessage } = submission;
      const getRegenerateResponseIds = (responseMessageId: string) => {
        const ids = new Set<string>();
        const addId = (id?: string | null) => {
          if (!id) {
            return;
          }
          ids.add(id);
          ids.add(id.replace(/_+$/, ''));
        };
        addId(responseMessageId);
        addId(submission.initialResponse?.messageId);
        addId(submission.userMessage?.responseMessageId);
        return ids;
      };
      const shouldRemoveRegenerateResponse = (message: TMessage, responseMessageId: string) =>
        submission.isRegenerate &&
        !message.isCreatedByUser &&
        /** A compaction's preliminary response is `${anchorId}_`. The ordinary
         *  regenerate alias set strips that suffix, but here the base ID is the
         *  assistant ANCHOR, not a response being replaced. Keep it so the
         *  summary remains its child instead of becoming an orphan root. */
        (submission.compact !== true || message.messageId !== userMessage.messageId) &&
        getRegenerateResponseIds(responseMessageId).has(message.messageId);
      const shouldRemoveInitialResponse = (message: TMessage, responseMessageId: string) => {
        const initialResponseId = submission.initialResponse?.messageId;
        return (
          !submission.isRegenerate &&
          !message.isCreatedByUser &&
          initialResponseId != null &&
          initialResponseId !== responseMessageId &&
          message.messageId === initialResponseId &&
          message.parentMessageId === userMessage.messageId
        );
      };
      const ensureUserMessagePresent = (
        candidateMessages: TMessage[],
        responseMessageId: string,
      ) => {
        if (
          submission.isRegenerate ||
          !userMessage?.messageId ||
          candidateMessages.some((message) => message.messageId === userMessage.messageId)
        ) {
          return candidateMessages;
        }

        /** Insert before the row's first CHILD as well as before the response
         *  row: abandoned responses from preempted attempts are children of
         *  this user message and may already sit in the list. Landing the
         *  parent after them orders children before their parent, which the
         *  message tree renders as phantom root branches (a folded thread). */
        let insertIndex = candidateMessages.length;
        for (let i = 0; i < candidateMessages.length; i++) {
          const message = candidateMessages[i];
          if (
            message.messageId === responseMessageId ||
            message.parentMessageId === userMessage.messageId
          ) {
            insertIndex = i;
            break;
          }
        }
        if (insertIndex >= candidateMessages.length) {
          return [...candidateMessages, userMessage as TMessage];
        }

        const nextMessages = [...candidateMessages];
        nextMessages.splice(insertIndex, 0, userMessage as TMessage);
        return nextMessages;
      };
      const getResponseBaseMessages = (
        candidateMessages: TMessage[],
        responseMessageId: string,
        ensureUserMessage = false,
      ) => {
        const currentMessages = getEventMessages(candidateMessages);
        if (!submission.isRegenerate) {
          const nextMessages = currentMessages.filter(
            (message) => !shouldRemoveInitialResponse(message, responseMessageId),
          );
          return ensureUserMessage
            ? ensureUserMessagePresent(nextMessages, responseMessageId)
            : nextMessages;
        }
        return currentMessages.filter(
          (message) => !shouldRemoveRegenerateResponse(message, responseMessageId),
        );
      };
      const mergeResponseMessage = (
        candidateMessages: TMessage[],
        updatedResponse: TMessage,
        responseMessageId: string,
        options?: { ensureUserMessage?: boolean },
      ) => {
        const currentMessages = getResponseBaseMessages(
          candidateMessages,
          responseMessageId,
          options?.ensureUserMessage === true,
        );
        const hasResponseMessage = currentMessages.some(
          (msg) => msg.messageId === responseMessageId,
        );
        return hasResponseMessage
          ? currentMessages.map((msg) =>
              msg.messageId === responseMessageId ? updatedResponse : msg,
            )
          : [...currentMessages, updatedResponse];
      };
      /**
       * Per-token deltas fold into `messageMap` immediately (authoritative), but
       * the cache write — and the buildTree + message-tree walk it triggers —
       * flushes at most once per frame. Non-delta events keep writing
       * synchronously from `messageMap`, so a trailing flush after them merges
       * the same authoritative state; `clearStepMaps` cancels the flush at run
       * boundaries (same lifecycle as the summarize coalescing above).
       */
      const scheduleCoalescedMessagesFlush = (responseMessageId: string) => {
        pendingDeltaFlushIds.current.add(responseMessageId);
        const flush = () => {
          deltaFlushScheduled.current = false;
          messageDeltaRaf.current = null;
          pendingDeltaFlushRef.current = null;
          const ids = pendingDeltaFlushIds.current;
          pendingDeltaFlushIds.current = new Set();
          let candidate = messages;
          for (const id of ids) {
            const latest = messageMap.current.get(id);
            if (!latest) {
              continue;
            }
            candidate = mergeResponseMessage(candidate, latest, id, { ensureUserMessage: true });
            setMessages(candidate);
          }
        };
        /** Exposed so terminal/read boundaries (abort, error, pending-action)
         * can apply the queued tokens synchronously via `flushPendingDeltas`. */
        pendingDeltaFlushRef.current = flush;
        if (deltaFlushScheduled.current) {
          return;
        }
        deltaFlushScheduled.current = true;
        messageDeltaRaf.current = requestAnimationFrame(flush);
      };
      let parentMessageId =
        submission.isRegenerate && submission.initialResponse?.parentMessageId
          ? submission.initialResponse.parentMessageId
          : userMessage.messageId;

      const currentTime = Date.now();
      if (currentTime - lastAnnouncementTimeRef.current > MESSAGE_UPDATE_INTERVAL) {
        announcePolite({ message: 'composing', isStatus: true });
        lastAnnouncementTimeRef.current = currentTime;
      }

      /**
       * Index offset for an edited resubmission: the server indexes only the
       * NEW content, so incoming indices shift past the prefix the client
       * kept.
       *
       * Reads the length CAPTURED when the submission was built rather than
       * the live `initialResponse.content` array, because a resume sync
       * REPLACES that array with the server's completion-local snapshot —
       * whose length describes the new generation, not the retained prefix.
       * They are equal until a reconnect, so the non-resumed path is
       * unaffected.
       *
       * `editPrefixCleared` means that sync also replaced the RENDERED
       * content: the prefix is gone from the message and server indices are
       * already absolute, so any offset would write past the end. Activity
       * labels honor the same flag — both must agree, or a batch's tool
       * cards and its header land in different index spaces.
       *
       * `initialContent` stays the live array: it seeds a response that is
       * not in the map yet, and post-sync the seeding path correctly falls
       * back to the rendered content instead.
       */
      let initialContent: TMessageContentParts[] = [];
      let editPrefixOffset = 0;
      if (submission?.editedContent != null && submission?.editPrefixCleared !== true) {
        initialContent = submission?.initialResponse?.content ?? initialContent;
        editPrefixOffset = submission?.editPrefixLength ?? initialContent.length;
      }

      if (stepEvent.event === StepEvents.ON_RUN_STEP) {
        const runStep = stepEvent.data;
        let responseMessageId = runStep.runId ?? '';
        if (responseMessageId === Constants.USE_PRELIM_RESPONSE_MESSAGE_ID) {
          responseMessageId = submission?.initialResponse?.messageId ?? '';
          parentMessageId = submission?.initialResponse?.parentMessageId ?? '';
        }
        if (!responseMessageId) {
          console.warn('No message id found in run step event');
          return;
        }

        stepMap.current.set(runStep.id, runStep);

        // Calculate content index - use server index, offset by the retained edit prefix
        const contentIndex = runStep.index + editPrefixOffset;

        let response = messageMap.current.get(responseMessageId);

        if (!response) {
          // Find the actual response message. Regenerate submissions can target
          // an earlier branch while the visible history still ends at a later
          // assistant message, so never seed a regenerated response from the
          // conversation tail.
          const lastMessage = messages[messages.length - 1] as TMessage;
          const responseMessage =
            !submission.isRegenerate && lastMessage && !lastMessage.isCreatedByUser
              ? lastMessage
              : (submission?.initialResponse as TMessage);

          // For edit scenarios, initialContent IS the complete starting content (not to be merged)
          // For resume scenarios (no editedContent), initialContent is empty and we use existingContent
          const existingContent = responseMessage?.content ?? [];
          const mergedContent: TMessageContentParts[] =
            initialContent.length > 0 ? initialContent : existingContent;

          response = {
            ...responseMessage,
            parentMessageId,
            conversationId: userMessage.conversationId,
            messageId: responseMessageId,
            content: mergedContent,
          };

          messageMap.current.set(responseMessageId, response);

          // Get fresh messages to handle multi-tab scenarios where messages may have loaded
          // after this handler started (Tab 2 may have more complete history now)
          const currentMessages = getResponseBaseMessages(messages, responseMessageId, true);

          // Remove any existing response placeholder
          let updatedMessages = currentMessages.filter(
            (message) =>
              message.messageId !== responseMessageId &&
              !shouldRemoveRegenerateResponse(message, responseMessageId) &&
              !shouldRemoveInitialResponse(message, responseMessageId),
          );

          // Ensure userMessage is present (multi-tab: Tab 2 may not have it yet).
          // Regenerate reuses an existing user turn; its submission userMessage is only
          // a transport placeholder and must not become a new visible branch.
          // (`ensureUserMessagePresent` no-ops for regenerate and inserts in
          // parent-before-children order otherwise.)
          updatedMessages = ensureUserMessagePresent(updatedMessages, responseMessageId);

          setMessages([...updatedMessages, response]);
        }

        // Store tool call IDs if present
        if (runStep.stepDetails.type === StepTypes.TOOL_CALLS) {
          let updatedResponse = { ...response };
          ((runStep.stepDetails.tool_calls ?? []) as Agents.ToolCall[]).forEach((toolCall) => {
            const toolCallId = toolCall.id ?? '';
            if ('id' in toolCall && toolCallId) {
              toolCallIdMap.current.set(runStep.id, toolCallId);
            }

            const contentPart: Agents.MessageContentComplex = {
              type: ContentTypes.TOOL_CALL,
              tool_call: {
                name: toolCall.name ?? '',
                args: toolCall.args,
                id: toolCallId,
                stepId: runStep.id,
              },
            };

            // Use the pre-calculated contentIndex which handles parallel agent indexing
            updatedResponse = updateContent(
              updatedResponse,
              contentIndex,
              contentPart,
              false,
              getStepMetadata(runStep),
            );
          });

          messageMap.current.set(responseMessageId, updatedResponse);
          setMessages(
            mergeResponseMessage(messages, updatedResponse, responseMessageId, {
              ensureUserMessage: true,
            }),
          );
        }

        if (runStep.summary != null) {
          const summaryPart: SummaryContentPart = {
            type: ContentTypes.SUMMARY,
            content: [],
            summarizing: true,
            model: runStep.summary.model,
            provider: runStep.summary.provider,
          };

          let updatedResponse = { ...(messageMap.current.get(responseMessageId) ?? response) };
          updatedResponse = updateContent(
            updatedResponse,
            contentIndex,
            summaryPart,
            false,
            getStepMetadata(runStep),
          );

          messageMap.current.set(responseMessageId, updatedResponse);
          setMessages(
            mergeResponseMessage(messages, updatedResponse, responseMessageId, {
              ensureUserMessage: true,
            }),
          );
        }

        const bufferedDeltas = pendingDeltaBuffer.current.get(runStep.id);
        if (bufferedDeltas && bufferedDeltas.length > 0) {
          pendingDeltaBuffer.current.delete(runStep.id);
          for (const bufferedDelta of bufferedDeltas) {
            stepHandler(bufferedDelta, submission);
          }
        }
      } else if (stepEvent.event === StepEvents.ON_AGENT_UPDATE) {
        const { agent_update } = stepEvent.data;
        let responseMessageId = agent_update.runId || '';
        if (responseMessageId === Constants.USE_PRELIM_RESPONSE_MESSAGE_ID) {
          responseMessageId = submission?.initialResponse?.messageId ?? '';
          parentMessageId = submission?.initialResponse?.parentMessageId ?? '';
        }
        if (!responseMessageId) {
          console.warn('No message id found in agent update event');
          return;
        }

        const response = messageMap.current.get(responseMessageId);
        if (response) {
          // Agent updates don't need index adjustment
          const currentIndex = agent_update.index + editPrefixOffset;
          // Agent updates carry their own agentId - use default groupId if agentId is present
          const agentUpdateMeta: ContentMetadata | undefined = agent_update.agentId
            ? { agentId: agent_update.agentId, groupId: 1 }
            : undefined;
          const updatedResponse = updateContent(
            response,
            currentIndex,
            stepEvent.data,
            false,
            agentUpdateMeta,
          );
          messageMap.current.set(responseMessageId, updatedResponse);
          setMessages(
            mergeResponseMessage(messages, updatedResponse, responseMessageId, {
              ensureUserMessage: true,
            }),
          );
        }
      } else if (stepEvent.event === StepEvents.ON_MESSAGE_DELTA) {
        const messageDelta = stepEvent.data;
        const runStep = stepMap.current.get(messageDelta.id);
        let responseMessageId = runStep?.runId ?? '';
        if (responseMessageId === Constants.USE_PRELIM_RESPONSE_MESSAGE_ID) {
          responseMessageId = submission?.initialResponse?.messageId ?? '';
          parentMessageId = submission?.initialResponse?.parentMessageId ?? '';
        }

        if (!runStep || !responseMessageId) {
          const buffer = pendingDeltaBuffer.current.get(messageDelta.id) ?? [];
          buffer.push({ event: StepEvents.ON_MESSAGE_DELTA, data: messageDelta });
          pendingDeltaBuffer.current.set(messageDelta.id, buffer);
          return;
        }

        const response = messageMap.current.get(responseMessageId);
        if (response && messageDelta.delta.content) {
          /** A delta may carry several parts (e.g. Google server-side tool
           *  chunks) — every entry must be applied, in order, or streamed
           *  text is silently dropped. */
          const contentParts = Array.isArray(messageDelta.delta.content)
            ? messageDelta.delta.content
            : [messageDelta.delta.content];

          let updatedResponse = response;
          let hasUpdate = false;
          for (const contentPart of contentParts) {
            if (contentPart == null) {
              continue;
            }
            const messageCreation =
              runStep.stepDetails.type === StepTypes.MESSAGE_CREATION
                ? (runStep.stepDetails.message_creation as {
                    phase?: 'commentary' | 'final_answer';
                  })
                : undefined;
            const phase = messageCreation?.phase;
            const phasedContentPart =
              contentPart.type === ContentTypes.TEXT &&
              (phase === 'commentary' || phase === 'final_answer')
                ? { ...contentPart, phase }
                : contentPart;
            const currentIndex = calculateContentIndex(
              runStep.index,
              editPrefixOffset,
              phasedContentPart.type || '',
              updatedResponse.content,
              phase,
            );
            if (
              submission != null &&
              runStep.index === 0 &&
              editPrefixOffset > 0 &&
              currentIndex === editPrefixOffset - 1
            ) {
              submission.editPrefixFirstPartFolded = true;
            }
            if (phasedContentPart.type === ContentTypes.THINK) {
              updatedResponse = prepareReasoningPartForStep(
                updatedResponse,
                currentIndex,
                messageDelta.id,
              );
            }
            updatedResponse = updateContent(
              updatedResponse,
              currentIndex,
              phasedContentPart,
              false,
              getStepMetadata(runStep),
            );
            hasUpdate = true;
          }
          if (hasUpdate) {
            messageMap.current.set(responseMessageId, updatedResponse);
            scheduleCoalescedMessagesFlush(responseMessageId);
          }
        }
      } else if (stepEvent.event === StepEvents.ON_REASONING_DELTA) {
        const reasoningDelta = stepEvent.data;
        const runStep = stepMap.current.get(reasoningDelta.id);
        let responseMessageId = runStep?.runId ?? '';
        if (responseMessageId === Constants.USE_PRELIM_RESPONSE_MESSAGE_ID) {
          responseMessageId = submission?.initialResponse?.messageId ?? '';
          parentMessageId = submission?.initialResponse?.parentMessageId ?? '';
        }

        if (!runStep || !responseMessageId) {
          const buffer = pendingDeltaBuffer.current.get(reasoningDelta.id) ?? [];
          buffer.push({ event: StepEvents.ON_REASONING_DELTA, data: reasoningDelta });
          pendingDeltaBuffer.current.set(reasoningDelta.id, buffer);
          return;
        }

        const response = messageMap.current.get(responseMessageId);
        if (response && reasoningDelta.delta.content != null) {
          /** Same multi-part contract as message deltas: Google server-side
           *  tool chunks emit several think entries in one delta. */
          const contentParts = Array.isArray(reasoningDelta.delta.content)
            ? reasoningDelta.delta.content
            : [reasoningDelta.delta.content];

          let updatedResponse = response;
          let hasUpdate = false;
          for (const contentPart of contentParts) {
            if (contentPart == null) {
              continue;
            }
            const currentIndex = calculateContentIndex(
              runStep.index,
              editPrefixOffset,
              contentPart.type || '',
              updatedResponse.content,
            );
            if (
              submission != null &&
              runStep.index === 0 &&
              editPrefixOffset > 0 &&
              currentIndex === editPrefixOffset - 1
            ) {
              submission.editPrefixFirstPartFolded = true;
            }
            updatedResponse = prepareReasoningPartForStep(
              updatedResponse,
              currentIndex,
              reasoningDelta.id,
            );
            updatedResponse = updateContent(
              updatedResponse,
              currentIndex,
              contentPart,
              false,
              getStepMetadata(runStep),
            );
            hasUpdate = true;
          }
          if (hasUpdate) {
            messageMap.current.set(responseMessageId, updatedResponse);
            scheduleCoalescedMessagesFlush(responseMessageId);
          }
        }
      } else if (stepEvent.event === StepEvents.ON_RUN_STEP_DELTA) {
        const runStepDelta = stepEvent.data;
        const runStep = stepMap.current.get(runStepDelta.id);
        let responseMessageId = runStep?.runId ?? '';
        if (responseMessageId === Constants.USE_PRELIM_RESPONSE_MESSAGE_ID) {
          responseMessageId = submission?.initialResponse?.messageId ?? '';
          parentMessageId = submission?.initialResponse?.parentMessageId ?? '';
        }

        if (!runStep || !responseMessageId) {
          const buffer = pendingDeltaBuffer.current.get(runStepDelta.id) ?? [];
          buffer.push({ event: StepEvents.ON_RUN_STEP_DELTA, data: runStepDelta });
          pendingDeltaBuffer.current.set(runStepDelta.id, buffer);
          return;
        }

        const response = messageMap.current.get(responseMessageId);
        if (
          response &&
          runStepDelta.delta.type === StepTypes.TOOL_CALLS &&
          runStepDelta.delta.tool_calls
        ) {
          let updatedResponse = { ...response };

          runStepDelta.delta.tool_calls.forEach((toolCallDelta) => {
            const toolCallId = toolCallIdMap.current.get(runStepDelta.id) ?? '';

            const contentPart: Agents.MessageContentComplex = {
              type: ContentTypes.TOOL_CALL,
              tool_call: {
                name: toolCallDelta.name ?? '',
                args: toolCallDelta.args ?? '',
                id: toolCallId,
                stepId: runStepDelta.id,
              },
            };

            if (runStepDelta.delta.auth != null) {
              contentPart.tool_call.auth = runStepDelta.delta.auth;
              contentPart.tool_call.expires_at = runStepDelta.delta.expires_at;
            }

            // Use server's index, offset by the retained edit prefix
            const currentIndex = runStep.index + editPrefixOffset;
            updatedResponse = updateContent(
              updatedResponse,
              currentIndex,
              contentPart,
              false,
              getStepMetadata(runStep),
            );
          });

          messageMap.current.set(responseMessageId, updatedResponse);
          setMessages(
            mergeResponseMessage(messages, updatedResponse, responseMessageId, {
              ensureUserMessage: true,
            }),
          );
        }
      } else if (stepEvent.event === StepEvents.ON_RUN_STEP_COMPLETED) {
        const { result } = stepEvent.data;

        const { id: stepId } = result;
        clearSandboxStarting(result.tool_call?.id);

        const runStep = stepMap.current.get(stepId);
        let responseMessageId = runStep?.runId ?? '';
        if (responseMessageId === Constants.USE_PRELIM_RESPONSE_MESSAGE_ID) {
          responseMessageId = submission?.initialResponse?.messageId ?? '';
          parentMessageId = submission?.initialResponse?.parentMessageId ?? '';
        }

        if (!runStep || !responseMessageId) {
          console.warn('No run step or runId found for completed tool call event');
          return;
        }

        if (isSkillAuthoringToolCall(result.tool_call)) {
          onSkillAuthoringComplete?.();
        }

        const response = messageMap.current.get(responseMessageId);
        if (response) {
          let updatedResponse = { ...response };

          const contentPart: Agents.MessageContentComplex = {
            type: ContentTypes.TOOL_CALL,
            tool_call: { ...result.tool_call, stepId },
          };

          // Use server's index, offset by the retained edit prefix
          const currentIndex = runStep.index + editPrefixOffset;
          updatedResponse = updateContent(
            updatedResponse,
            currentIndex,
            contentPart,
            true,
            getStepMetadata(runStep),
          );

          messageMap.current.set(responseMessageId, updatedResponse);
          setMessages(
            mergeResponseMessage(messages, updatedResponse, responseMessageId, {
              ensureUserMessage: true,
            }),
          );
        }
      } else if (stepEvent.event === StepEvents.ON_RUN_STEP_CLOSED) {
        const closed = stepEvent.data;
        const runStep = stepMap.current.get(closed.id);
        let responseMessageId = runStep?.runId ?? '';
        if (responseMessageId === Constants.USE_PRELIM_RESPONSE_MESSAGE_ID) {
          responseMessageId = submission?.initialResponse?.messageId ?? '';
          parentMessageId = submission?.initialResponse?.parentMessageId ?? '';
        }

        /**
         * A closure for a step this client never saw opened is not an error
         * worth surfacing — it happens on reconnect, where the replay may
         * start after the step was created.
         */
        if (!runStep || !responseMessageId) {
          return;
        }

        const response = messageMap.current.get(responseMessageId);
        if (!response) {
          return;
        }

        const currentIndex = runStep.index + editPrefixOffset;
        const existing = response.content?.[currentIndex];
        /**
         * Only tool calls render a running state, so only they need the
         * terminal status. Leaving other part types untouched keeps this from
         * disturbing text or reasoning content.
         */
        if (!existing || existing.type !== ContentTypes.TOOL_CALL) {
          return;
        }

        const existingToolCall = existing[ContentTypes.TOOL_CALL];
        if (!existingToolCall) {
          return;
        }

        /** Spread conditionally so an unknowable duration leaves any value the
         *  server already stamped in place, rather than overwriting it with
         *  `undefined`. */
        const durationMs = getRunStepDurationMs(closed);
        const updatedContent = [...(response.content ?? [])];
        updatedContent[currentIndex] = {
          ...existing,
          [ContentTypes.TOOL_CALL]: {
            ...existingToolCall,
            runStepStatus: closed.status,
            ...(durationMs != null && { runStepDurationMs: durationMs }),
          },
        };

        const updatedResponse = { ...response, content: updatedContent };
        messageMap.current.set(responseMessageId, updatedResponse);
        setMessages(
          mergeResponseMessage(messages, updatedResponse, responseMessageId, {
            ensureUserMessage: true,
          }),
        );
      } else if (stepEvent.event === StepEvents.ON_SANDBOX_STARTING) {
        setSandboxStarting(stepEvent.data.tool_call_id);
      } else if (stepEvent.event === StepEvents.ON_PTC_TOOL_CALL) {
        /** `runId` is the response message id (the run configurable's
         *  `run_id`), the same correlation the subagent path uses. */
        let responseMessageId = stepEvent.data.runId ?? '';
        if (responseMessageId === Constants.USE_PRELIM_RESPONSE_MESSAGE_ID) {
          responseMessageId = submission?.initialResponse?.messageId ?? '';
        }
        applyPtcToolCall(stepEvent.data, responseMessageId);
      } else if (stepEvent.event === StepEvents.ON_SUBAGENT_UPDATE) {
        let responseMessageId = stepEvent.data.runId;
        if (responseMessageId === Constants.USE_PRELIM_RESPONSE_MESSAGE_ID) {
          responseMessageId = submission?.initialResponse?.messageId ?? '';
        }
        applySubagentUpdate(stepEvent.data, responseMessageId);
        if (
          stepEvent.data.phase === 'start' ||
          stepEvent.data.phase === 'stop' ||
          stepEvent.data.phase === 'error'
        ) {
          const conversationId = [
            submission?.userMessage?.conversationId,
            submission?.initialResponse?.conversationId,
            submission?.conversation?.conversationId,
          ].find((id) => id && id !== Constants.NEW_CONVO && id !== Constants.PENDING_CONVO);
          if (conversationId) onSubagentIndexChange?.(conversationId);
        }
      } else if (stepEvent.event === StepEvents.ON_SUMMARIZE_START) {
        announcePolite({ message: 'summarize_started', isStatus: true });
      } else if (stepEvent.event === StepEvents.ON_SUMMARIZE_DELTA) {
        const deltaData = stepEvent.data;
        const runStep = stepMap.current.get(deltaData.id);
        let responseMessageId = runStep?.runId ?? '';
        if (responseMessageId === Constants.USE_PRELIM_RESPONSE_MESSAGE_ID) {
          responseMessageId = submission?.initialResponse?.messageId ?? '';
          parentMessageId = submission?.initialResponse?.parentMessageId ?? '';
        }

        if (!runStep || !responseMessageId) {
          const buffer = pendingDeltaBuffer.current.get(deltaData.id) ?? [];
          buffer.push({ event: StepEvents.ON_SUMMARIZE_DELTA, data: deltaData });
          pendingDeltaBuffer.current.set(deltaData.id, buffer);
          return;
        }

        const response = messageMap.current.get(responseMessageId);
        if (response) {
          const contentPart: SummaryContentPart = {
            ...deltaData.delta.summary,
            summarizing: true,
          };

          const contentIndex = runStep.index + editPrefixOffset;
          const updatedResponse = updateContent(
            response,
            contentIndex,
            contentPart,
            false,
            getStepMetadata(runStep),
          );
          messageMap.current.set(responseMessageId, updatedResponse);
          if (summarizeDeltaRaf.current == null) {
            summarizeDeltaRaf.current = requestAnimationFrame(() => {
              summarizeDeltaRaf.current = null;
              const latest = messageMap.current.get(responseMessageId);
              if (latest) {
                const currentMessages = submission.isRegenerate ? messages : getMessages() || [];
                setMessages(mergeResponseMessage(currentMessages, latest, responseMessageId));
              }
            });
          }
        }
      } else if (stepEvent.event === StepEvents.ON_SUMMARIZE_COMPLETE) {
        const completeData = stepEvent.data;
        const completeRunStep = stepMap.current.get(completeData.id);
        let completeMessageId = completeRunStep?.runId ?? '';
        if (completeMessageId === Constants.USE_PRELIM_RESPONSE_MESSAGE_ID) {
          completeMessageId = submission?.initialResponse?.messageId ?? '';
        }

        const targetMessage = messageMap.current.get(completeMessageId);
        if (!targetMessage || !Array.isArray(targetMessage.content)) {
          return;
        }

        /**
         * Scoped to the owning step's slot when the step is known: a global
         * scan finalizes a NEWER round's in-flight part when summarize
         * cycles run back-to-back (tiny context windows re-trigger
         * summarization every graph step). Unknown step falls back to
         * finalizing every in-flight part.
         */
        const completeIndex =
          completeRunStep != null ? completeRunStep.index + editPrefixOffset : -1;
        let didFinalize = false;
        const updatedContent = targetMessage.content.map((part, index) => {
          if (part?.type !== ContentTypes.SUMMARY || !(part as SummaryContentPart).summarizing) {
            return part;
          }
          if (completeIndex >= 0 && index !== completeIndex) {
            return part;
          }
          didFinalize = true;
          if (!completeData.error && completeData.summary) {
            return { ...completeData.summary, summarizing: false } as SummaryContentPart;
          }
          /**
           * Failed rounds keep their slot. Splicing the part out shifts every
           * later part under the index-keyed renderer (remounting rows and
           * collapsing whatever the user expanded mid-stream) and breaks the
           * content-position == step-index invariant that `updateContent`
           * writes rely on. Flipping the flag alone hides an empty row
           * (`Summary` renders null without text) and matches the persisted
           * message, which retains the part server-side. An errored round
           * carries `failed` so partial deltas that already streamed in are
           * not presented as a completed summary.
           */
          if (completeData.error) {
            return { ...part, summarizing: false, failed: true } as SummaryContentPart;
          }
          return { ...part, summarizing: false } as SummaryContentPart;
        });
        if (didFinalize) {
          announcePolite({
            message: completeData.error ? 'summarize_failed' : 'summarize_completed',
            isStatus: true,
          });
          const finalized = { ...targetMessage, content: updatedContent };
          const currentMessages = submission.isRegenerate ? messages : getMessages() || [];
          messageMap.current.set(completeMessageId, finalized);
          setMessages(mergeResponseMessage(currentMessages, finalized, completeMessageId));
        }
      } else {
        const _exhaustive: never = stepEvent;
        console.warn('Unhandled step event', (_exhaustive as TStepEvent).event);
      }
    },
    [
      getMessages,
      lastAnnouncementTimeRef,
      announcePolite,
      setMessages,
      calculateContentIndex,
      getCurrentMessages,
      applySubagentUpdate,
      onSubagentIndexChange,
      setSandboxStarting,
      clearSandboxStarting,
      applyPtcToolCall,
      onSkillAuthoringComplete,
    ],
  );

  /** Cancels a queued delta flush so it can't overwrite a terminal write:
   * once a final handler has written the server's authoritative message, a
   * trailing frame reading the older streaming copy from `messageMap` must
   * never land on top of it. */
  const cancelPendingDeltaFlush = useCallback(() => {
    if (messageDeltaRaf.current != null) {
      cancelAnimationFrame(messageDeltaRaf.current);
      messageDeltaRaf.current = null;
    }
    deltaFlushScheduled.current = false;
    pendingDeltaFlushRef.current = null;
    pendingDeltaFlushIds.current.clear();
  }, []);

  /** Applies a queued delta flush synchronously (then cancels the frame).
   * For boundaries that READ the cache or synthesize from it — abort's
   * partial-response capture, error cards, pending-action application — the
   * queued tokens must land first or the stopped/errored message loses them. */
  const flushPendingDeltas = useCallback(() => {
    if (messageDeltaRaf.current != null) {
      cancelAnimationFrame(messageDeltaRaf.current);
      messageDeltaRaf.current = null;
    }
    const flush = pendingDeltaFlushRef.current;
    pendingDeltaFlushRef.current = null;
    deltaFlushScheduled.current = false;
    if (flush) {
      flush();
    }
  }, []);

  const clearStepMaps = useCallback(() => {
    if (summarizeDeltaRaf.current != null) {
      cancelAnimationFrame(summarizeDeltaRaf.current);
      summarizeDeltaRaf.current = null;
    }
    cancelPendingDeltaFlush();
    toolCallIdMap.current.clear();
    messageMap.current.clear();
    stepMap.current.clear();
    pendingDeltaBuffer.current.clear();
    subagentRunToInvocationKey.current.clear();
    claimedSubagentInvocationKeys.current.clear();
    pendingSubagentBuffer.current.clear();
    closeParentSubagentStreams();
    /** Unlike subagent atoms below, sandbox-starting flags are transient
     *  status with no audit value — reset them at this boundary so an
     *  interrupted cold boot can't leak a stale "starting" label onto a
     *  later tool call that reuses the same id (e.g. `call_0`). */
    resetSandboxAtoms();
    /** Intentionally NOT calling `resetSubagentAtoms()` here — users need
     *  to be able to reopen the SubagentCall dialog after completion to
     *  audit what the child did. `resetSubagentAtoms` is returned below
     *  so callers can wipe atoms on conversation-switch (see
     *  `useEventHandlers`) — that's the correct cleanup boundary:
     *  persisted `subagent_content` takes over for historical messages
     *  once the conversation is saved, and we prevent unbounded
     *  atomFamily growth across multi-conversation sessions. */
  }, [cancelPendingDeltaFlush, closeParentSubagentStreams, resetSandboxAtoms]);

  /**
   * Sync a message into the step handler's messageMap.
   * Call this after receiving sync event to ensure subsequent deltas
   * build on the synced content, not stale content.
   */
  const syncStepMessage = useCallback(
    (message: TMessage) => {
      if (!message?.messageId) return;
      messageMap.current.set(message.messageId, { ...message });
      const ready = [...pendingSubagentBuffer.current.entries()].filter(
        ([, pending]) => pending.parentMessageId === message.messageId,
      );
      for (const [subagentRunId, pending] of ready) {
        pendingSubagentBuffer.current.delete(subagentRunId);
        for (const event of pending.events) {
          applySubagentUpdate(event, message.messageId);
        }
      }
    },
    [applySubagentUpdate],
  );

  return {
    stepHandler,
    clearStepMaps,
    resetSubagentAtoms,
    resetPtcAtoms,
    prunePtcTraces,
    syncStepMessage,
    cancelPendingDeltaFlush,
    flushPendingDeltas,
  };
}
