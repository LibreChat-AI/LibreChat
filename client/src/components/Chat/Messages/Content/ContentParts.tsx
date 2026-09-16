import { memo, useRef, useMemo, useEffect, useCallback, useContext, Fragment } from 'react';
import { useStore } from 'jotai';
import { Constants, ContentTypes, Tools } from 'librechat-data-provider';
import type {
  TMessageContentParts,
  SearchResultData,
  TAttachment,
  Agents,
} from 'librechat-data-provider';
import type { ReactNode, ReactElement } from 'react';
import type { ReasoningDisclosures, ToolDisclosures } from './disclosure';
import type { ToolCallGroupExpansionState } from './ToolCallGroup';
import type { ActivityPhaseSegment } from '~/utils/activityLabels';
import {
  mapAttachments,
  getPartKeyIndex,
  attachmentRenderKey,
  buildAttachmentsByName,
  filterAttachmentsForPart,
  groupSequentialToolCalls,
} from '~/utils';
import {
  ReasoningDisclosureContext,
  reasoningDisclosure,
  ToolDisclosureContext,
  ToolDisclosureKeyContext,
} from './disclosure';
import {
  groupActivityPhases,
  lastCursorContentIdx,
  getActivityLabelText,
} from '~/utils/activityLabels';
import WorkspaceChanges, { partitionWorkspaceChanges } from './Parts/WorkspaceChanges';
import { MCPAppSuppressionContext, MCPAppViews } from '~/components/MCPUIResource';
import { ParallelContentRenderer, type PartWithIndex } from './ParallelContent';
import { MediaContext, MessageContext, SearchContext } from '~/Providers';
import MemoryArtifacts, { hasMemoryArtifacts } from './MemoryArtifacts';
import { hasParallelLanes, parallelLaneGroups } from '~/utils/lanes';
import PendingSkillCall from './Parts/PendingSkillCall';
import ActivityPhaseGroup from './ActivityPhaseGroup';
import { hasPendingApprovalInPart } from '~/utils';
import EditContentParts from './EditContentParts';
import { EmptyText, AgentUpdate } from './Parts';
import ApprovalProvider from './ApprovalContext';
import Sources from '~/components/Web/Sources';
import ToolCallGroup from './ToolCallGroup';
import { blocksLiveFold } from './live';
import Container from './Container';
import Part from './Part';

/** An empty TEXT part — the placeholder some endpoints seed in
 * `initialResponse.content` before the model produces anything. */
const isEmptyTextPart = (part: TMessageContentParts | undefined): boolean => {
  if (part == null || part.type !== ContentTypes.TEXT) {
    return false;
  }
  const text = typeof part.text === 'string' ? part.text : (part.text?.value ?? '');
  return text.length === 0;
};

const getToolCallId = (part: TMessageContentParts): string =>
  (part?.[ContentTypes.TOOL_CALL] as Agents.ToolCall | undefined)?.id ?? '';

const getPartAgentId = (part: TMessageContentParts): string | undefined =>
  (part as { agentId?: string })?.agentId ??
  (part?.[ContentTypes.TOOL_CALL] as { agentId?: string } | undefined)?.agentId;

const getPartStepId = (part: TMessageContentParts): string | undefined =>
  (part?.[ContentTypes.TOOL_CALL] as Agents.ToolCall | undefined)?.stepId;

const getToolGroupAnchorIndex = (parts: PartWithIndex[]): number => {
  for (const { part, idx } of parts) {
    if (getToolCallId(part) || part?.type === ContentTypes.TOOL_CALL) {
      return idx;
    }
  }
  return parts[0]?.idx ?? -1;
};

type ToolCallStepOwner = { agentId?: string; stepId: string };

const getSiblingStepIds = (
  part: TMessageContentParts,
  ownersByToolCallId: ReadonlyMap<string, readonly ToolCallStepOwner[]>,
): ReadonlySet<string> | undefined => {
  if (getPartStepId(part) != null) {
    return;
  }
  const toolCallId = getToolCallId(part);
  const owners = ownersByToolCallId.get(toolCallId);
  if (toolCallId === '' || owners == null) {
    return;
  }
  const agentId = getPartAgentId(part);
  const siblingStepIds = new Set<string>();
  for (const owner of owners) {
    if (agentId == null || owner.agentId == null || owner.agentId === agentId) {
      siblingStepIds.add(owner.stepId);
    }
  }
  return siblingStepIds.size === 0 ? undefined : siblingStepIds;
};

const buildToolCallStepOwners = (
  content: Array<TMessageContentParts | undefined> | undefined,
): ReadonlyMap<string, readonly ToolCallStepOwner[]> => {
  const owners = new Map<string, ToolCallStepOwner[]>();
  for (const part of content ?? []) {
    if (part == null) {
      continue;
    }
    const toolCallId = getToolCallId(part);
    const stepId = getPartStepId(part);
    if (toolCallId === '' || stepId == null) {
      continue;
    }
    const entries = owners.get(toolCallId) ?? [];
    entries.push({ stepId, agentId: getPartAgentId(part) });
    owners.set(toolCallId, entries);
  }
  return owners;
};

const collectMessageAppAttachments = (
  content: Array<TMessageContentParts | undefined> | undefined,
  attachments: TAttachment[] | undefined,
): TAttachment[] => {
  const attachmentMap = mapAttachments(attachments ?? []);
  const ownersByToolCallId = buildToolCallStepOwners(content);
  const collected = new Set<TAttachment>();
  for (const part of content ?? []) {
    if (part == null) {
      continue;
    }
    const routed = filterAttachmentsForPart(
      attachmentMap[getToolCallId(part)],
      getPartAgentId(part),
      getPartStepId(part),
      getSiblingStepIds(part, ownersByToolCallId),
    );
    for (const attachment of routed ?? []) {
      if (attachment.type === Tools.ui_resources) {
        collected.add(attachment);
      }
    }
  }
  return Array.from(collected);
};

const getToolGroupId = (parts: PartWithIndex[], fallbackScope: number): string => {
  const firstPart = parts[0];
  if (!firstPart) {
    return 'empty';
  }
  /** Keyed on the first TOOL CALL, not the first part. An activity label
   *  absorbs the block's leading THINK part when its text lands, so keying on
   *  `parts[0]` would flip the key mid-run — remounting the group and losing
   *  whatever the user had expanded. The tool calls themselves do not move. */
  let firstToolKeyIdx: number | undefined;
  for (const { part, idx } of parts) {
    const toolCallId = getToolCallId(part);
    if (toolCallId) {
      const agentId = getPartAgentId(part);
      /** `stepId` is stamped only when a tool finishes, so it cannot be part
       * of the render identity without remounting a live group at completion.
       * Agent + provider id are available from the first render; message-wide
       * occurrence numbering below distinguishes later reuse in the same row. */
      return agentId == null ? `tool:${toolCallId}` : `tool:${toolCallId}:${agentId}`;
    }
    if (firstToolKeyIdx === undefined && part?.type === ContentTypes.TOOL_CALL) {
      firstToolKeyIdx = getPartKeyIndex(part, idx);
    }
  }
  /** Same reasoning for id-less tool calls: anchor to the first TOOL entry's
   *  index rather than the block's first part, which shifts when reasoning is
   *  absorbed. Only a block with no tool call at all falls back to `parts[0]`. */
  return `fallback:${fallbackScope}:${firstToolKeyIdx ?? getPartKeyIndex(firstPart.part, firstPart.idx)}`;
};

type PartWithContextProps = {
  part: TMessageContentParts;
  idx: number;
  isLastPart: boolean;
  messageId: string;
  conversationId?: string | null;
  nextType?: string;
  isSubmitting: boolean;
  isLatestMessage?: boolean;
  isCreatedByUser: boolean;
  isLast: boolean;
  partAttachments: TAttachment[] | undefined;
  hideAttachments?: boolean;
  onToolExpand?: () => void;
};

const PartWithContext = memo(function PartWithContext({
  part,
  idx,
  isLastPart,
  messageId,
  conversationId,
  nextType,
  isSubmitting,
  isLatestMessage,
  isCreatedByUser,
  isLast,
  partAttachments,
  hideAttachments,
  onToolExpand,
}: PartWithContextProps) {
  const contextValue = useMemo(
    () => ({
      messageId,
      isExpanded: true as const,
      conversationId,
      partIndex: idx,
      nextType,
      isSubmitting,
      isLatestMessage,
    }),
    [messageId, conversationId, idx, nextType, isSubmitting, isLatestMessage],
  );

  /** Being last WITHIN a body is not being last in the message: activity
   *  phases split one response into several bodies, so every settled phase has
   *  a trailing part too. Only the body that holds the message's cursor can
   *  own a live part — otherwise a phase from minutes ago keeps its reasoning
   *  shimmering and its peek scrolling while later phases stream. */
  const holdsCursor = isLastPart && isLast;
  /** Position distinguishes provider-id reuse within a response. Neither the
   *  final-only stepId nor messageId belongs in the card's disclosure identity. */
  const toolDisclosureKey =
    part.type === ContentTypes.TOOL_CALL
      ? JSON.stringify([
          getPartAgentId(part) ?? '',
          getToolCallId(part),
          getPartKeyIndex(part, idx),
        ])
      : undefined;

  return (
    <MessageContext.Provider value={contextValue}>
      <ToolDisclosureKeyContext.Provider value={toolDisclosureKey}>
        <Part
          part={part}
          attachments={partAttachments}
          isSubmitting={isSubmitting}
          key={`part-${messageId}-${getPartKeyIndex(part, idx)}`}
          isCreatedByUser={isCreatedByUser}
          isLast={holdsCursor}
          showCursor={holdsCursor}
          hideAttachments={hideAttachments}
          onToolExpand={onToolExpand}
        />
      </ToolDisclosureKeyContext.Provider>
    </MessageContext.Provider>
  );
});

type ContentPartsProps = {
  content: Array<TMessageContentParts | undefined> | undefined;
  messageId: string;
  /** Client-only parent anchor carried by one response while its server identities hydrate. */
  renderOwnerId?: string;
  /**
   * Skill names the user invoked manually via the `$` popover on this turn.
   * `createdHandler` seeds this on the assistant placeholder from
   * `submission.manualSkills`, and `finalHandler`'s server-backed
   * `responseMessage` replacement drops it — so the field is naturally
   * present only for the lifetime of the stream. Scalar string array (not
   * the full message object) so `React.memo` stays shallow-happy.
   */
  manualSkills?: string[];
  /** ISO timestamp of the parent message, surfaced in parallel column headers. */
  createdAt?: string | null;
  /**
   * Author icon + label node re-rendered before content that resumes after an
   * inline STEER part — the steer renders as a full user turn inside the
   * response, so what follows must be visibly re-attributed to the author.
   */
  authorHeader?: ReactNode;
  conversationId?: string | null;
  attachments?: TAttachment[];
  searchResults?: { [key: string]: SearchResultData };
  isCreatedByUser: boolean;
  showThinking: boolean;
  isLast: boolean;
  isSubmitting: boolean;
  isLatestMessage?: boolean;
  edit?: boolean;
  enterEdit?: (cancel?: boolean) => void | null | undefined;
  siblingIdx?: number;
  setSiblingIdx?:
    | ((value: number) => void | React.Dispatch<React.SetStateAction<number>>)
    | null
    | undefined;
  /** Whether the span a run is still writing folds into one row. The host
   *  decides: false when the reader asked for tools expanded by default, and
   *  for a surface that IS the detail view of a run — a subagent's activity
   *  panel — where one row would hide what the panel was opened to watch. */
  foldLiveActivity?: boolean;
  /** Internal recursion guard for nested phase segments. */
  nestedActivityPhase?: boolean;
  /** Internal signal that the parent phase card lifted this segment's
   *  attachments into its own media row — the parts below must not render
   *  them a second time inside the fold. */
  hideAttachments?: boolean;
  /** Internal signal that this segment renders inside a completed phase card. */
  withinActivityPhase?: boolean;
  /** Internal signal that a phase card already carries this message's
   *  streaming cursor. A solitary empty provider slot looks like the initial
   *  waiting state from inside its own segment, so without this it renders a
   *  second cursor beside the one already on screen. */
  cursorOwnedElsewhere?: boolean;
  /** Internal signal that the parent already removed message-level workspace attachments. */
  workspaceAttachmentsPartitioned?: boolean;
  /** Absolute transcript index represented by `content[0]` in a phase slice. */
  contentIndexOffset?: number;
  /** Absolute transcript index for each compacted sparse segment entry. */
  contentIndices?: ReadonlyArray<number>;
  /** Message-wide lane cardinality retained across nested phase segments, so a
   *  slice holding one agent of a real two-agent group keeps its columns. */
  laneGroups?: ReadonlySet<number>;
  /** Message-wide steer attribution retained across nested phase segments. */
  resumeAuthors?: ReadonlyMap<number, string | undefined>;
  /** Message-wide tool-group expansion overrides retained across phase slices. */
  toolGroupExpansionState?: Map<string, ToolCallGroupExpansionState>;
  /** Message-wide occurrence number for each grouped tool block's first tool. */
  toolGroupOccurrenceByIndex?: ReadonlyMap<number, number>;
  /** Completed step owners used to keep older attachments off a live repeated call. */
  toolCallStepOwnersById?: ReadonlyMap<string, readonly ToolCallStepOwner[]>;
};

/**
 * ContentParts renders message content parts, handling both sequential and parallel layouts.
 *
 * For 90% of messages (single-agent, no parallel execution), this renders sequentially.
 * For multi-agent parallel execution, it uses ParallelContentRenderer to show columns.
 */
const ContentPartsBody = memo(function ContentPartsBody({
  edit,
  isLast,
  content,
  manualSkills,
  messageId,
  enterEdit,
  siblingIdx,
  attachments,
  isSubmitting,
  setSiblingIdx,
  searchResults,
  authorHeader,
  conversationId,
  isCreatedByUser,
  showThinking,
  isLatestMessage,
  createdAt,
  foldLiveActivity = true,
  nestedActivityPhase = false,
  withinActivityPhase = false,
  cursorOwnedElsewhere = false,
  hideAttachments = false,
  workspaceAttachmentsPartitioned = false,
  contentIndexOffset = 0,
  contentIndices,
  laneGroups,
  resumeAuthors,
  toolGroupExpansionState,
  toolGroupOccurrenceByIndex,
  toolCallStepOwnersById,
}: ContentPartsProps) {
  const { inlineAttachments, workspaceChanges } = useMemo(
    () =>
      workspaceAttachmentsPartitioned
        ? { inlineAttachments: attachments ?? [], workspaceChanges: [] }
        : partitionWorkspaceChanges(attachments),
    [attachments, workspaceAttachmentsPartitioned],
  );
  const attachmentMap = useMemo(() => mapAttachments(inlineAttachments), [inlineAttachments]);
  const resolvedToolCallStepOwners = useMemo(() => {
    if (toolCallStepOwnersById != null) {
      return toolCallStepOwnersById;
    }
    return buildToolCallStepOwners(content);
  }, [toolCallStepOwnersById, content]);
  const attachmentsForPart = useCallback(
    (part: TMessageContentParts): TAttachment[] | undefined =>
      filterAttachmentsForPart(
        attachmentMap[getToolCallId(part)],
        getPartAgentId(part),
        getPartStepId(part),
        getSiblingStepIds(part, resolvedToolCallStepOwners),
      ),
    [attachmentMap, resolvedToolCallStepOwners],
  );
  const disclosureStore = useStore();
  const reasoningDisclosures = useContext(ReasoningDisclosureContext);
  const effectiveIsSubmitting = isLatestMessage ? isSubmitting : false;
  const localToolGroupExpansionRef = useRef(new Map<string, ToolCallGroupExpansionState>());
  const expansionState = toolGroupExpansionState ?? localToolGroupExpansionRef.current;
  const fallbackScopeRef = useRef({ messageId, scope: 0 });
  /** Keys a phase card has already rendered under, by its computed key and by
   *  where its span starts. See `stableCardKey`. */
  const cardKeyAliasesRef = useRef(new Map<string, string>());
  const cardScopeRef = useRef(0);
  if (fallbackScopeRef.current.messageId !== messageId) {
    if (!effectiveIsSubmitting) {
      fallbackScopeRef.current.scope += 1;
      expansionState.clear();
    }
    cardScopeRef.current += 1;
    /** Positions belong to one response, even when the next sibling is live.
     * Tool-backed aliases still bridge placeholder hydration and finalization. */
    for (const alias of cardKeyAliasesRef.current.keys()) {
      if (alias.startsWith('start:') || alias.startsWith('key:fallback:')) {
        cardKeyAliasesRef.current.delete(alias);
      }
    }
    fallbackScopeRef.current.messageId = messageId;
  }
  const fallbackScope = fallbackScopeRef.current.scope;
  const localIndexByAbsolute = useMemo(
    () =>
      contentIndices == null
        ? undefined
        : new Map(contentIndices.map((absoluteIndex, localIndex) => [absoluteIndex, localIndex])),
    [contentIndices],
  );
  const absoluteIndexAt = useCallback(
    (localIndex: number) => contentIndices?.[localIndex] ?? localIndex + contentIndexOffset,
    [contentIndexOffset, contentIndices],
  );
  /** Hoisted above the early returns to feed the entrance-detection hook
   *  below, so it is memoized rather than re-walked on every unrelated
   *  re-render of a message that has no phases at all. */
  /** Resolved once over the whole message and handed to every slice below —
   *  and to `groupActivityPhases`, so a streamed delta scans content once. */
  const messageLaneGroups = useMemo(
    () => laneGroups ?? parallelLaneGroups(content),
    [laneGroups, content],
  );

  const foldsLiveTail = foldLiveActivity && isLast && effectiveIsSubmitting;
  const phaseSegments = useMemo(
    () =>
      nestedActivityPhase
        ? undefined
        : groupActivityPhases(content, messageLaneGroups, foldsLiveTail),
    [nestedActivityPhase, content, messageLaneGroups, foldsLiveTail],
  );
  /** Every file a phase's parts produced, in transcript order, deduplicated
   *  across parts that share a tool call. */
  const collectPhaseAttachments = useCallback(
    (parts: ReadonlyArray<TMessageContentParts | undefined>): TAttachment[] | undefined => {
      const collected: TAttachment[] = [];
      /** Position of each identity already collected, so a repeat REPLACES it
       *  in place. A tool that writes the same file twice emits two records
       *  and the later one carries the fresher lifecycle fields — status,
       *  preview text, generated contents — which is why the attachment
       *  renderer gives duplicates distinct keys and lets the latest win.
       *  Hoisting makes this row the only surface for those files, so keeping
       *  the first-seen record would pin a stale one on screen. */
      const positionOf = new Map<string, number>();
      for (const part of parts) {
        if (part == null) {
          continue;
        }
        for (const attachment of attachmentsForPart(part) ?? []) {
          /** No identity means nothing to compare against — two rows that
           *  cannot be told apart are two rows, so both are kept rather than
           *  silently collapsed onto whichever arrived first. */
          const identity = attachmentRenderKey(attachment);
          if (identity == null) {
            collected.push(attachment);
            continue;
          }
          const at = positionOf.get(identity);
          if (at != null) {
            collected[at] = attachment;
            continue;
          }
          positionOf.set(identity, collected.length);
          collected.push(attachment);
        }
      }
      return collected.length > 0 ? collected : undefined;
    },
    [attachmentsForPart],
  );
  const completedPhaseKeys = useMemo(() => {
    const indices = new Set<number>();
    const labels = new Map<string, number>();
    const ordinals = new Map<number, number>();
    for (const segment of phaseSegments ?? []) {
      if (segment.type !== 'phase') {
        continue;
      }
      /** Synthesized cards are excluded: their header key moves with the
       *  ticker, and a moving key reads here as a re-key — which would
       *  suppress the entrance fold on every real marker after it. */
      if (segment.synthesized === true) {
        continue;
      }
      const text = getActivityLabelText(segment.labelPart);
      const occurrence = (labels.get(text) ?? 0) + 1;
      indices.add(getPartKeyIndex(segment.labelPart, segment.labelIndex));
      labels.set(text, occurrence);
      ordinals.set(getPartKeyIndex(segment.labelPart, segment.labelIndex), occurrence);
    }
    return { indices, labels, ordinals };
  }, [phaseSegments]);
  /** A phase label can finish after the root text stream settles, so
   *  `isSubmitting` is not a reliable entrance signal. Compare committed
   *  phase markers instead: a marker that appears after this renderer has
   *  mounted is live; markers present on the first render are history.
   *
   *  Both the render key AND the label text identify a known marker. The
   *  final event swaps in the server's compacted content, and when the
   *  streamed-index stamp cannot pair the two arrays every index-derived key
   *  shifts — an index-only guard then reads each already-settled phase as
   *  new and replays its fold over content the reader already watched fold.
   *  The label text survives any re-key, so a re-keyed marker whose text was
   *  already on screen mounts settled instead. The text layer engages ONLY
   *  when a previously rendered key has vanished — the signature of a
   *  re-key. A pure addition keeps key identity authoritative, so a marker
   *  that fills out of order behind an already-rendered twin (concurrent
   *  fills can resolve later-index first, with identical summaries) still
   *  animates. Under a re-key, texts are counted and each marker paired
   *  with a prior occurrence by position: a run may legitimately generate
   *  two phases with identical summaries, and only an occurrence past the
   *  previously rendered count deserves its entrance.
   *
   *  The recorded sets are scoped to the message they described.
   *  `MultiMessage` renders siblings without a key, so this instance survives
   *  a sibling switch with its refs intact — unscoped sets would report the
   *  previous sibling's phases and animate the newly selected sibling's
   *  history. */
  const previousPhaseRef = useRef<{
    messageId: string;
    indices: Set<number>;
    labels: Map<string, number>;
  } | null>(null);
  const previousPhases =
    previousPhaseRef.current?.messageId === messageId ? previousPhaseRef.current : null;
  const hasPhaseRekey = useMemo(() => {
    if (previousPhases == null) {
      return false;
    }
    for (const key of previousPhases.indices) {
      if (!completedPhaseKeys.indices.has(key)) {
        return true;
      }
    }
    return false;
  }, [previousPhases, completedPhaseKeys]);
  useEffect(() => {
    previousPhaseRef.current = {
      messageId,
      indices: completedPhaseKeys.indices,
      labels: completedPhaseKeys.labels,
    };
  }, [messageId, completedPhaseKeys]);

  const handleGroupExpansionChange = useCallback(
    (groupId: string, state: ToolCallGroupExpansionState) => {
      if (!state.userOverride) {
        expansionState.delete(groupId);
        return;
      }
      expansionState.set(groupId, state);
    },
    [expansionState],
  );

  /**
   * Interim skill cards — rendered in a separate slot ABOVE the Parts
   * iteration based purely on the `manualSkills` message field. `content`
   * is only read to determine the "Running → Ran" visual transition
   * (`hasRealContent`), never to gate visibility, so backend deltas /
   * optimistic emissions can't race the pending cards off the screen.
   *
   * Lifecycle:
   *  - `useChatFunctions` seeds `manualSkills` on the assistant placeholder
   *    at construction → cards appear immediately on submit, with the
   *    shimmering "Running X" state (no content yet).
   *  - Through the stream, `useStepHandler` spreads the response on every
   *    update so `manualSkills` rides along; once the first real content
   *    part lands, `hasRealContent` flips true and the cards switch to
   *    the static "Ran X" state — matching what users see for
   *    model-invoked skills as they finish priming.
   *  - At finalize, `finalHandler` replaces the message with the server
   *    response (no `manualSkills` field) → interim cards disappear and
   *    the real `skill` tool_call part in `content` takes over.
   *
   * Skipped on the user side (they get `SkillPills` on the user
   * bubble) and when no skills were invoked on this turn.
   */
  const pendingSkills = useMemo(
    () => (!isCreatedByUser && manualSkills != null ? manualSkills : []),
    [isCreatedByUser, manualSkills],
  );
  const hasPendingSkills = pendingSkills.length > 0;

  /**
   * True once the assistant has started streaming something meaningful —
   * any non-text part, OR a text part with non-empty content. Drives the
   * "Running X → Ran X" transition on pending cards. An empty-text
   * placeholder (some endpoints seed one in `initialResponse.content` on
   * assistant-side) does NOT count as real content, to avoid flipping
   * the transition before the model has actually produced anything.
   */
  const hasRealContent = useMemo(
    () => (content ?? []).some((part) => part != null && !isEmptyTextPart(part)),
    [content],
  );

  const renderPendingSkills = () =>
    pendingSkills.map((name) => (
      <PendingSkillCall key={`pending-skill-${name}`} skillName={name} loaded={hasRealContent} />
    ));

  const renderPart = useCallback(
    (part: TMessageContentParts, idx: number, isLastPart: boolean) => {
      const localIdx = localIndexByAbsolute?.get(idx) ?? idx - contentIndexOffset;
      return (
        <PartWithContext
          key={`provider-${messageId}-${getPartKeyIndex(part, idx)}`}
          idx={idx}
          part={part}
          isLast={isLast}
          messageId={messageId}
          isLastPart={isLastPart}
          conversationId={conversationId}
          isLatestMessage={isLatestMessage}
          isCreatedByUser={isCreatedByUser}
          nextType={content?.[localIdx + 1]?.type}
          isSubmitting={effectiveIsSubmitting}
          partAttachments={attachmentsForPart(part)}
          hideAttachments={hideAttachments}
        />
      );
    },
    [
      attachmentsForPart,
      content,
      contentIndexOffset,
      localIndexByAbsolute,
      conversationId,
      effectiveIsSubmitting,
      hideAttachments,
      isCreatedByUser,
      isLast,
      isLatestMessage,
      messageId,
    ],
  );

  const renderGroupedPart = useCallback(
    (part: TMessageContentParts, idx: number, isLastPart: boolean, onToolExpand?: () => void) => {
      const localIdx = localIndexByAbsolute?.get(idx) ?? idx - contentIndexOffset;
      return (
        <PartWithContext
          key={`provider-${messageId}-${getPartKeyIndex(part, idx)}`}
          idx={idx}
          part={part}
          isLast={isLast}
          messageId={messageId}
          isLastPart={isLastPart}
          conversationId={conversationId}
          isLatestMessage={isLatestMessage}
          isCreatedByUser={isCreatedByUser}
          nextType={content?.[localIdx + 1]?.type}
          isSubmitting={effectiveIsSubmitting}
          partAttachments={attachmentsForPart(part)}
          hideAttachments
          onToolExpand={onToolExpand}
        />
      );
    },
    [
      attachmentsForPart,
      content,
      contentIndexOffset,
      localIndexByAbsolute,
      conversationId,
      effectiveIsSubmitting,
      isCreatedByUser,
      isLast,
      isLatestMessage,
      messageId,
    ],
  );

  /** `postSteerAuthors` marks each part that resumes the response after a
   *  steer block — where attribution is re-rendered. The value is the ACTIVE
   *  agent id when a preceding AGENT_UPDATE handed the run off (the resumed
   *  content belongs to that agent, not the message-level author), undefined
   *  for the top-level `authorHeader`. Read BEFORE applying the current
   *  part's own handoff, so a resume point that IS an agent update keeps the
   *  pre-handoff author and lets the real marker announce the transition. */
  const { sequentialParts, detectedResumeAuthors } = useMemo(() => {
    const parts: PartWithIndex[] = [];
    const authors = new Map<number, string | undefined>();
    if (!content) {
      return { sequentialParts: parts, detectedResumeAuthors: authors };
    }
    let prevType: string | undefined;
    let activeAgentId: string | undefined;
    content.forEach((part, localIdx) => {
      if (!part) {
        return;
      }
      const idx = absoluteIndexAt(localIdx);
      if (prevType === ContentTypes.STEER && part.type !== ContentTypes.STEER) {
        authors.set(idx, activeAgentId);
      }
      if (part.type === ContentTypes.AGENT_UPDATE) {
        activeAgentId = part[ContentTypes.AGENT_UPDATE]?.agentId || undefined;
      }
      prevType = part.type;
      parts.push({ part, idx });
    });
    return { sequentialParts: parts, detectedResumeAuthors: authors };
  }, [absoluteIndexAt, content]);
  const postSteerAuthors = resumeAuthors ?? detectedResumeAuthors;

  const resolvedToolGroupOccurrences = useMemo(() => {
    if (toolGroupOccurrenceByIndex != null) {
      return toolGroupOccurrenceByIndex;
    }
    const occurrences = new Map<number, number>();
    const counts = new Map<string, number>();
    for (const group of groupSequentialToolCalls(sequentialParts)) {
      if (group.type === 'single') {
        continue;
      }
      const baseGroupId = getToolGroupId(group.parts, fallbackScope);
      const occurrence = (counts.get(baseGroupId) ?? 0) + 1;
      counts.set(baseGroupId, occurrence);
      occurrences.set(getToolGroupAnchorIndex(group.parts), occurrence);
    }
    return occurrences;
  }, [toolGroupOccurrenceByIndex, sequentialParts, fallbackScope]);

  const groupedParts = useMemo(() => {
    return groupSequentialToolCalls(sequentialParts).map((group) => {
      if (group.type === 'single') {
        return group;
      }
      const baseGroupId = getToolGroupId(group.parts, fallbackScope);
      const occurrence =
        resolvedToolGroupOccurrences.get(getToolGroupAnchorIndex(group.parts)) ?? 1;
      const groupId = occurrence === 1 ? baseGroupId : `${baseGroupId}:occurrence:${occurrence}`;
      /** Collected even when a parent phase hoists the files: the header still
       *  reads them for the sites a web search visited. */
      const seenAttachments = new Set<TAttachment>();
      for (const { part } of group.parts) {
        for (const attachment of attachmentsForPart(part) ?? []) {
          seenAttachments.add(attachment);
        }
      }
      const groupAttachments = hideAttachments ? undefined : Array.from(seenAttachments);
      return {
        ...group,
        groupId,
        groupAttachments,
        sourceAttachments: Array.from(seenAttachments),
      };
    });
  }, [
    sequentialParts,
    attachmentsForPart,
    fallbackScope,
    hideAttachments,
    resolvedToolGroupOccurrences,
  ]);

  /** The re-attribution node for a part resuming after a steer block, shared
   *  by the sequential path and the parallel renderer's sequential stretches. */
  const renderResumeAttribution = useCallback(
    (idx: number, keyIdx: number = idx): ReactElement | null => {
      if (authorHeader == null || !postSteerAuthors.has(idx)) {
        return null;
      }
      const activeAgentId = postSteerAuthors.get(idx);
      if (activeAgentId != null) {
        return <AgentUpdate key={`author-${messageId}-${keyIdx}`} currentAgentId={activeAgentId} />;
      }
      return <Fragment key={`author-${messageId}-${keyIdx}`}>{authorHeader}</Fragment>;
    },
    [authorHeader, postSteerAuthors, messageId],
  );

  // Early return: no content to render AND no pending skill cards
  if (!content && !hasPendingSkills && workspaceChanges.length === 0) {
    return null;
  }

  // Interim skill cards are a mid-stream concern, not relevant in edit mode.
  if (edit === true && enterEdit && setSiblingIdx) {
    return (
      <ApprovalProvider>
        <SearchContext.Provider value={{ searchResults }}>
          <MemoryArtifacts attachments={attachments} />
          <EditContentParts
            content={content ?? []}
            contentIndexOffset={contentIndexOffset}
            messageId={messageId}
            isSubmitting={isSubmitting}
            enterEdit={enterEdit}
            siblingIdx={siblingIdx ?? null}
            setSiblingIdx={setSiblingIdx}
            renderReadOnlyPart={(part, idx, isLastPart) => renderPart(part, idx, isLastPart)}
          />
          <WorkspaceChanges attachments={workspaceChanges} />
        </SearchContext.Provider>
      </ApprovalProvider>
    );
  }

  if (phaseSegments != null) {
    const relativeGlobalLastContentIdx = lastCursorContentIdx(content ?? []);
    const globalLastContentIdx =
      relativeGlobalLastContentIdx < 0 ? -1 : absoluteIndexAt(relativeGlobalLastContentIdx);
    /** Segment keys anchor to their first defined part's stable index, never
     *  to the segment's ordinal: hole-only slots form phantom segments while
     *  a run streams and vanish from the compacted final content, so ordinal
     *  keys shift at settle and remount every segment body after them. */
    const segmentKeyIndex = (segment: {
      content: Array<TMessageContentParts | undefined>;
      contentIndices: number[];
      startIndex: number;
    }): number => {
      for (let i = 0; i < segment.content.length; i++) {
        const part = segment.content[i];
        if (part != null) {
          return getPartKeyIndex(part, absoluteIndexAt(segment.contentIndices[i]));
        }
      }
      return absoluteIndexAt(segment.startIndex);
    };
    /** Stable render identity for a phase card. See the key comment below.
     *
     *  Anchored to the first TOOL CALL, not the span's first part, for the
     *  reason `getToolGroupId` gives: an empty leading TEXT or THINK is
     *  DROPPED by `preserveStreamedContentIdentity` at settle, which would
     *  move a first-part anchor and remount the card exactly when the run
     *  finishes. The tool calls themselves do not move. */
    const phaseCardKey = (segment: Extract<ActivityPhaseSegment, { type: 'phase' }>): string => {
      for (let position = 0; position < segment.content.length; position += 1) {
        const part = segment.content[position];
        const toolCallId = part == null ? '' : getToolCallId(part);
        if (toolCallId) {
          const anchor = getPartKeyIndex(part, absoluteIndexAt(segment.contentIndices[position]));
          return `${toolCallId}:${anchor}`;
        }
      }
      /** No provider id in the span at all — id-less legacy calls,
       *  reasoning-only, or children compacted away. A bare position cannot
       *  separate two siblings whose cards start at the same index, so this
       *  branch carries the message-change counter, exactly as
       *  `getToolGroupId` does for its own id-less fallback. The tradeoff is
       *  the same one accepted there: the counter also advances at settle, so
       *  these cards remount then. */
      const position = segment.hasContent
        ? segmentKeyIndex(segment)
        : getPartKeyIndex(segment.labelPart, segment.labelIndex);
      return `fallback:${cardScopeRef.current}:${position}`;
    };
    /** A live card can exist before its first tool call — a span that is only
     *  a thought so far has no provider id, so `phaseCardKey` gives it the
     *  positional fallback, and would hand it a different, tool-anchored key
     *  the moment a call is appended. That is a remount mid-thought: the row
     *  blinks and a reader who opened it is shut out. The first key a span
     *  renders under is therefore kept, and remembered both by where the span
     *  starts and by the key it would otherwise move to, so the summary that
     *  later claims the same calls from a different start still lands on it. */
    const stableCardKey = (segment: Extract<ActivityPhaseSegment, { type: 'phase' }>): string => {
      const computed = phaseCardKey(segment);
      const start = absoluteIndexAt(segment.contentIndices[0] ?? segment.startIndex);
      const aliases = cardKeyAliasesRef.current;
      const key = aliases.get(`key:${computed}`) ?? aliases.get(`start:${start}`) ?? computed;
      aliases.set(`key:${computed}`, key);
      aliases.set(`start:${start}`, key);
      return key;
    };
    /** Exactly one thing may hold the streaming cursor. A card carries it
     *  below its own header whenever the tail of the run sits inside its
     *  span, which puts every sibling segment out of the running. */
    const cursorOwnedByCard =
      isLast &&
      effectiveIsSubmitting &&
      phaseSegments.some((segment) => {
        if (segment.type !== 'phase') {
          return false;
        }
        return segment.synthesized === true
          ? segment.contentIndices.map(absoluteIndexAt).includes(globalLastContentIdx)
          : absoluteIndexAt(segment.labelIndex) === globalLastContentIdx;
      });
    const renderSegment = (
      segmentContent: Array<TMessageContentParts | undefined>,
      segmentStartIndex: number,
      segmentIndices: ReadonlyArray<number>,
      key: string,
      withinPhase = false,
      ownsCursor = false,
      hoisted = false,
    ) => {
      return (
        <ContentPartsBody
          key={key}
          content={segmentContent}
          messageId={messageId}
          createdAt={createdAt}
          authorHeader={authorHeader}
          conversationId={conversationId}
          attachments={inlineAttachments}
          searchResults={searchResults}
          isCreatedByUser={isCreatedByUser}
          isLast={!ownsCursor && isLast && segmentIndices.includes(globalLastContentIdx)}
          isSubmitting={isSubmitting}
          isLatestMessage={isLatestMessage}
          nestedActivityPhase
          showThinking={showThinking}
          withinActivityPhase={withinPhase}
          cursorOwnedElsewhere={cursorOwnedByCard}
          hideAttachments={hoisted}
          workspaceAttachmentsPartitioned
          contentIndexOffset={segmentStartIndex}
          contentIndices={segmentIndices}
          laneGroups={messageLaneGroups}
          resumeAuthors={postSteerAuthors}
          toolGroupExpansionState={expansionState}
          toolGroupOccurrenceByIndex={resolvedToolGroupOccurrences}
          toolCallStepOwnersById={resolvedToolCallStepOwners}
        />
      );
    };
    const hasParallelContent = hasParallelLanes(content, messageLaneGroups);
    return (
      <ApprovalProvider>
        <SearchContext.Provider value={{ searchResults }}>
          <MemoryArtifacts attachments={attachments} />
          {hasParallelContent && (
            <Sources messageId={messageId} conversationId={conversationId || undefined} />
          )}
          {renderPendingSkills()}
          {phaseSegments.map((segment) => {
            if (segment.type !== 'phase') {
              return renderSegment(
                segment.content,
                absoluteIndexAt(segment.startIndex),
                segment.contentIndices.map(absoluteIndexAt),
                `phase-adjacent-${segmentKeyIndex(segment)}`,
              );
            }
            const synthesized = segment.synthesized === true;
            const live = segment.live === true;
            /** Entrance bookkeeping still keys on the marker. */
            const phaseKeyIndex = getPartKeyIndex(segment.labelPart, segment.labelIndex);
            /** The RENDER key is the span, not the header. A synthesized card's
             *  header ticks with the newest child label, so keying on it would
             *  remount the card on every tick — and when the summary finally
             *  lands, a card keyed the same way as the fold it replaces is
             *  RECONCILED rather than remounted, so a reader who opened the
             *  ticker keeps it open with no state to hand over. A phase with no
             *  children has no span to anchor to and keeps its marker key.
             *
             *  The first tool call carries it — its provider id paired with
             *  its own position. No message identity goes into it, and none
             *  can: `MultiMessage` reuses this instance across siblings, but
             *  `messageId` moves at settle (batched with
             *  `setIsSubmitting(false)`, so that commit is indistinguishable
             *  from a sibling switch) and the positional `siblingIdx` moves
             *  under background churn that deliberately PRESERVES the viewed
             *  response. Both halves survive those: the position is
             *  content-derived, and the provider id is what separates two
             *  siblings whose cards start at the same index. Pairing them also
             *  keeps repeated provider ids in one message apart, the way
             *  `getToolGroupId` uses an occurrence counter. */
            const cardKey = stableCardKey(segment);
            const labelText = getActivityLabelText(segment.labelPart);
            const segmentIndices = segment.contentIndices.map(absoluteIndexAt);
            /** While a run streams, the cursor sits INSIDE a synthesized span.
             *  A collapsed card would swallow it, so the card carries it below
             *  the header and the nested body stands down. */
            const ownsCursor =
              synthesized &&
              isLast &&
              effectiveIsSubmitting &&
              segmentIndices.includes(globalLastContentIdx);
            const hasPendingApproval = segment.content.some(
              (part) => part != null && hasPendingApprovalInPart(part),
            );
            /** The span's files, lifted out of the fold into their own row
             *  under the header.
             *
             *  This is why a span carrying attachments no longer has to skip
             *  folding. `ToolCallGroup` hoists `groupAttachments` outside its
             *  own panel so generated output survives collapsing the group,
             *  and folding that group into a card used to put the hoist back
             *  inside a disclosure — so a synthesized span with any output
             *  rendered unfolded rather than swallow it. Hoisting one level
             *  further makes the card safe for exactly that content, and
             *  agent runs that produce files are the ones with the longest
             *  lists to fold. */
            const phaseAttachments = collectPhaseAttachments(segment.content);
            /** A fold summarizes work that is DONE. An unresolved approval is
             *  the run asking the reader for something and blocking until it
             *  gets it — never put that behind a disclosure they have to find.
             *  A server marker cannot hit this (it is emitted after the batch
             *  resolves), but a subagent nested in an already-labeled group
             *  can raise one long after its parent's label filled. The span
             *  renders exactly as it would without the feature until it
             *  clears, then folds. */
            /** "Open thinking dropdowns by default" is the reader asking to
             *  see reasoning as it streams. A collapsed live row would unmount
             *  it, so a reasoning-bearing span stays unfolded for them — the
             *  same exception `ToolCallGroup` makes to its auto-collapse. */
            const keepsThinkingOpen =
              live &&
              showThinking &&
              segment.content.some((part) => part?.type === ContentTypes.THINK);
            const awaitsReader = live
              ? keepsThinkingOpen || segment.content.some(blocksLiveFold)
              : hasPendingApproval;
            if (synthesized && awaitsReader) {
              return renderSegment(
                segment.content,
                absoluteIndexAt(segment.startIndex),
                segmentIndices,
                `phase-awaiting-${cardKey}`,
              );
            }
            return (
              <ActivityPhaseGroup
                key={`activity-phase-${cardKey}`}
                labelPart={segment.labelPart}
                hasContent={segment.hasContent}
                attachments={phaseAttachments}
                hasPendingApproval={hasPendingApproval}
                onExpansionChange={
                  live &&
                  reasoningDisclosures != null &&
                  !segment.content.some((part) => part?.type === ContentTypes.TOOL_CALL)
                    ? (expanded) => {
                        segment.content.forEach((part, position) => {
                          if (part?.type !== ContentTypes.THINK) {
                            return;
                          }
                          const index = getPartKeyIndex(part, segmentIndices[position]);
                          disclosureStore.set(
                            reasoningDisclosure(reasoningDisclosures, index),
                            expanded,
                          );
                        });
                      }
                    : undefined
                }
                liveParts={live ? segment.content : undefined}
                spanParts={segment.hasContent ? segment.content : undefined}
                animateEntrance={
                  /** Never for a synthesized card. The entrance mounts a card
                   *  OPEN and folds it shut, and this component remounts
                   *  mid-run — the key carries `messageId`, which changes when
                   *  the placeholder hydrates to the server id, and a reconnect
                   *  mounts straight onto existing labeled content. Either
                   *  would flash the whole fold back open. Fold GROWTH is
                   *  already unanimated, so formation matching it is the
                   *  consistent behavior, not a downgrade. */
                  !synthesized &&
                  previousPhases != null &&
                  !previousPhases.indices.has(phaseKeyIndex) &&
                  (!hasPhaseRekey ||
                    (completedPhaseKeys.ordinals.get(phaseKeyIndex) ?? 1) >
                      (previousPhases.labels.get(labelText) ?? 0))
                }
                showCursor={
                  /** A live header shimmers; a cursor row beneath it would be
                   *  a second liveness signal and a second row. */
                  synthesized
                    ? ownsCursor && !live
                    : isLast &&
                      effectiveIsSubmitting &&
                      absoluteIndexAt(segment.labelIndex) === globalLastContentIdx
                }
              >
                {renderSegment(
                  segment.content,
                  absoluteIndexAt(segment.startIndex),
                  segmentIndices,
                  `phase-content-${cardKey}`,
                  /** Opening a live row should show the calls running, so its
                   *  groups keep their own live expansion rather than the
                   *  settled-phase default of staying shut. */
                  !live,
                  ownsCursor,
                  true,
                )}
              </ActivityPhaseGroup>
            );
          })}
          <WorkspaceChanges attachments={workspaceChanges} />
        </SearchContext.Provider>
      </ApprovalProvider>
    );
  }

  const safeContent = content ?? [];
  /** A solitary seeded empty TEXT part (useChatFunctions' assistant-side
   *  placeholder) is the same waiting state as no content at all — route it
   *  through EmptyText instead of Markdown's flush initializing dot so both
   *  flows share the gated header-axis nudge. Never solitary mid-stream, so
   *  empty TEXT after real parts keeps its flush in-flow cursor. */
  const solitaryEmptyText = safeContent.length === 1 && isEmptyTextPart(safeContent[0]);
  const showEmptyCursor =
    (safeContent.length === 0 || solitaryEmptyText) &&
    effectiveIsSubmitting &&
    !cursorOwnedElsewhere;
  /** Skips trailing blank label reservations and empty provider placeholders,
   * keeping the cursor attached to the last visible output. */
  const relativeLastContentIdx = lastCursorContentIdx(safeContent);
  const lastContentIdx = relativeLastContentIdx < 0 ? -1 : absoluteIndexAt(relativeLastContentIdx);

  /** Columns only when at least two agents share a group — a lone group
   *  renders here, where tool grouping and activity labels apply. */
  const hasParallelContent = hasParallelLanes(safeContent, messageLaneGroups);
  if (hasParallelContent) {
    const parallelContent = (
      <>
        {renderPendingSkills()}
        <ParallelContentRenderer
          content={content}
          messageId={messageId}
          createdAt={createdAt}
          conversationId={conversationId}
          attachments={attachments}
          searchResults={searchResults}
          isSubmitting={effectiveIsSubmitting}
          renderPart={renderPart}
          renderResumeAttribution={renderResumeAttribution}
          showDecorations={!nestedActivityPhase}
          contentIndexOffset={contentIndexOffset}
          contentIndices={contentIndices}
          laneGroups={messageLaneGroups}
        />
        {!nestedActivityPhase && <WorkspaceChanges attachments={workspaceChanges} />}
      </>
    );
    return nestedActivityPhase ? (
      parallelContent
    ) : (
      <ApprovalProvider>{parallelContent}</ApprovalProvider>
    );
  }

  // Sequential content: render parts in order (90% of cases)
  const sequentialContent = (
    <SearchContext.Provider value={{ searchResults }}>
      {!nestedActivityPhase && <MemoryArtifacts attachments={attachments} />}
      {!nestedActivityPhase && renderPendingSkills()}
      {showEmptyCursor && (
        <Container>
          {/** Nudge only when the dot is truly first under the header — leading
           * memory/skill rows and nested phases keep it flush. */}
          <EmptyText
            underHeaderIcon={
              !nestedActivityPhase && !hasPendingSkills && !hasMemoryArtifacts(attachments)
            }
          />
        </Container>
      )}
      {!showEmptyCursor &&
        groupedParts.flatMap((group) => {
          const first = group.type === 'single' ? group.part : group.parts[0];
          const firstIdx = first?.idx ?? -1;
          const nodes: ReactElement[] = [];
          const attribution = renderResumeAttribution(
            firstIdx,
            first ? getPartKeyIndex(first.part, first.idx) : firstIdx,
          );
          if (attribution != null) {
            nodes.push(attribution);
          }
          if (group.type === 'single') {
            const { part, idx } = group.part;
            nodes.push(renderPart(part, idx, idx === lastContentIdx));
            return nodes;
          }
          const { groupId } = group;
          nodes.push(
            <ToolCallGroup
              key={`tool-group-${groupId}`}
              parts={group.parts}
              isSubmitting={effectiveIsSubmitting}
              /** The label part is CONSUMED into the header, not listed in
               *  `parts` — a filled label at the content tail must still
               *  mark its group as last or nothing holds the streaming
               *  cursor until the next delta. */
              isLast={
                isLast &&
                (group.parts.some((p) => p.idx === lastContentIdx) ||
                  group.labelPart?.idx === lastContentIdx)
              }
              renderPart={renderGroupedPart}
              lastContentIdx={lastContentIdx}
              groupAttachments={group.groupAttachments}
              sourceAttachments={group.sourceAttachments}
              initialExpansionState={expansionState.get(groupId)}
              showThinking={showThinking}
              onExpansionChange={(state) => handleGroupExpansionChange(groupId, state)}
              labelPart={group.labelPart}
              withinActivityPhase={withinActivityPhase}
            />,
          );
          return nodes;
        })}
      {!nestedActivityPhase && <WorkspaceChanges attachments={workspaceChanges} />}
    </SearchContext.Provider>
  );
  if (nestedActivityPhase) {
    return sequentialContent;
  }
  return <ApprovalProvider>{sequentialContent}</ApprovalProvider>;
});

const ContentParts = memo(function ContentParts(props: ContentPartsProps) {
  const {
    attachments,
    messageId,
    conversationId,
    isCreatedByUser,
    isLatestMessage,
    isSubmitting,
    renderOwnerId,
  } = props;
  const appRenderIdentity = useRef<{
    messageId: string;
    conversationId: string | null | undefined;
    ownerId: string | undefined;
    isLatestMessage: boolean;
    isSubmitting: boolean;
    scope: number;
  } | null>(null);
  const previousIdentity = appRenderIdentity.current;
  const nextIsLatest = isLatestMessage === true;
  /** `clientQueueParentMessageId` follows one response through the local-user → created-user
   *  re-key and disappears when `finalHandler` installs the durable response. It is not unique
   *  across regenerations, so only an already-active latest response may use it to retain scope. */
  const startsAnotherRun = previousIdentity?.isSubmitting === false && isSubmitting;
  const continuesConversation =
    previousIdentity?.conversationId === conversationId ||
    (previousIdentity?.conversationId === Constants.NEW_CONVO &&
      conversationId != null &&
      conversationId !== Constants.NEW_CONVO);
  const exactIdentity =
    previousIdentity?.messageId === messageId &&
    previousIdentity.conversationId === conversationId &&
    (previousIdentity.ownerId === renderOwnerId ||
      previousIdentity.ownerId == null ||
      renderOwnerId == null);
  const createdIdentityHydration =
    !isCreatedByUser &&
    previousIdentity?.isSubmitting === true &&
    isSubmitting &&
    previousIdentity.isLatestMessage &&
    nextIsLatest &&
    continuesConversation &&
    previousIdentity.ownerId != null &&
    previousIdentity.ownerId === renderOwnerId &&
    previousIdentity.messageId.endsWith('_');
  const durableIdentityHydration =
    !isCreatedByUser &&
    previousIdentity?.isSubmitting === true &&
    !isSubmitting &&
    previousIdentity.isLatestMessage &&
    nextIsLatest &&
    continuesConversation &&
    previousIdentity.ownerId != null &&
    (renderOwnerId == null || renderOwnerId === previousIdentity.ownerId) &&
    !messageId.endsWith('_');
  const continuesResponse =
    !startsAnotherRun && (exactIdentity || createdIdentityHydration || durableIdentityHydration);
  if (previousIdentity == null) {
    appRenderIdentity.current = {
      messageId,
      conversationId,
      ownerId: renderOwnerId,
      isLatestMessage: nextIsLatest,
      isSubmitting,
      scope: 0,
    };
  } else if (!continuesResponse) {
    appRenderIdentity.current = {
      messageId,
      conversationId,
      ownerId: renderOwnerId,
      isLatestMessage: nextIsLatest,
      isSubmitting,
      scope: previousIdentity.scope + 1,
    };
  } else {
    previousIdentity.messageId = messageId;
    previousIdentity.conversationId = conversationId;
    previousIdentity.ownerId = renderOwnerId ?? previousIdentity.ownerId;
    previousIdentity.isLatestMessage = nextIsLatest;
    previousIdentity.isSubmitting = isSubmitting;
  }
  const appRenderScope = appRenderIdentity.current!.scope;
  const messageAppAttachments = useMemo(
    () => collectMessageAppAttachments(props.content, attachments),
    [props.content, attachments],
  );
  const suppressedAppAttachments = useMemo<ReadonlySet<TAttachment>>(
    () => new Set(messageAppAttachments),
    [messageAppAttachments],
  );
  const toolState = useRef<{
    messageId: string;
    conversationId: string | null | undefined;
    disclosures: ToolDisclosures;
  } | null>(null);
  const previousToolState = toolState.current;
  /** The optimistic assistant id ends in `_`. Finalization replaces it with
   *  the server id, not a new response. Ordinary sibling/conversation switches
   *  get a fresh map, even if a provider reuses the same tool-call ids. */
  const finalizing =
    previousToolState?.messageId.endsWith('_') === true &&
    !messageId.endsWith('_') &&
    isLatestMessage === true;
  if (
    previousToolState == null ||
    previousToolState.conversationId !== conversationId ||
    (previousToolState.messageId !== messageId && !finalizing)
  ) {
    toolState.current = { messageId, conversationId, disclosures: new Map() };
  } else {
    previousToolState.messageId = messageId;
  }
  const toolDisclosures = toolState.current!.disclosures;
  const reasoningState = useRef<{ messageId: string; disclosures: ReasoningDisclosures } | null>(
    null,
  );
  if (reasoningState.current?.messageId !== messageId) {
    reasoningState.current = { messageId, disclosures: new Map() };
  }
  const reasoningDisclosures = reasoningState.current.disclosures;
  /** Published once for the whole message so every markdown block below —
   *  including the ones nested inside phase cards — resolves a bare
   *  `![DTI](5_dti.png)` against the files this turn actually produced.
   *
   *  `buildAttachmentsByName` indexes only what an `<img>` can display, so a
   *  `![report](report.csv)` keeps its download chip instead of resolving to a
   *  picture element that shows nothing.
   *
   *  Memoized in two steps on purpose. `useAttachments` hands back a fresh
   *  `[]` whenever its inputs move, and a turn with no files is the common
   *  case — indexing through the shared empty map keeps the context value
   *  itself referentially stable there, so a churning array cannot push a new
   *  value at every markdown block in the message. */
  const attachmentsByName = useMemo(() => buildAttachmentsByName(attachments), [attachments]);
  const media = useMemo(() => ({ attachmentsByName }), [attachmentsByName]);
  return (
    <MediaContext.Provider value={media}>
      <ReasoningDisclosureContext.Provider value={reasoningDisclosures}>
        <ToolDisclosureContext.Provider value={toolDisclosures}>
          <MCPAppSuppressionContext.Provider value={suppressedAppAttachments}>
            <ContentPartsBody {...props} />
          </MCPAppSuppressionContext.Provider>
          <MCPAppViews key={`message-apps-${appRenderScope}`} attachments={messageAppAttachments} />
        </ToolDisclosureContext.Provider>
      </ReasoningDisclosureContext.Provider>
    </MediaContext.Provider>
  );
});

export default ContentParts;
