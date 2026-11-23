import { memo, useRef, useMemo, useEffect, useCallback, useContext, Fragment } from 'react';
import { useStore } from 'jotai';
import { ContentTypes, imageGenTools } from 'librechat-data-provider';
import type { TMessageContentParts, TAttachment } from 'librechat-data-provider';
import type { NamedExoticComponent, ReactNode, ReactElement } from 'react';
import type { ReasoningDisclosures, ToolDisclosures } from '../react/parts/disclosure';
import type { ToolCallStepOwner, ToolCallStepOwners } from '../core/parts/owners';
import type { ContentPartsProps, ContentPartsSlots } from './contentTypes';
import type { ToolCallGroupExpansionState } from './parts/ToolCallGroup';
import type { ActivityPhaseSegment } from '../core/parts/activityLabels';
import type { WorkspaceChangeAttachment } from '../core/attachments';
import type { MCPAppResourceOccurrence } from '../core/apps';
import type { RenderIdentity } from '../core/parts/identity';
import type { PartWithIndex } from '../core/content';
import {
  isFileOutput,
  partAgentId,
  partToolCallId,
  attachmentScopes,
  toolCallStepOwners,
  acceptedAttachments,
  collectMessageContent,
  collectPartAttachments,
} from '../core/parts/owners';
import {
  SoleToolContext,
  reasoningDisclosure,
  ToolDisclosureContext,
  ToolDisclosureKeyContext,
  ReasoningDisclosureContext,
} from '../react/parts/disclosure';
import {
  useStoredSubagentHints,
  routeNestedAttachments,
  useLiveSubagentToolCalls,
  SubagentAttachmentsContext,
} from '../react/subagents/attachments';
import {
  groupActivityPhases,
  lastCursorContentIdx,
  getActivityLabelText,
  shareActivitySegments,
} from '../core/parts/activityLabels';
import {
  toolGroupId,
  toolGroupAnchor,
  toolGroupOccurrences,
  groupSequentialToolCalls,
} from '../core/parts/groups';
import { PreviewedToolCallPart, isPreviewedToolCallPart } from './parts/hydration';
import { mapAttachments, partitionWorkspaceChanges } from '../core/attachments';
import MemoryArtifacts, { hasMemoryArtifacts } from './parts/MemoryArtifacts';
import { attachmentRenderKey, buildAttachmentsByName } from '../core/media';
import { hasParallelLanes, parallelLaneGroups } from '../core/lanes';
import { getPartKeyIndex, isEmptyTextPart } from '../core/content';
import { advanceRenderIdentity } from '../core/parts/identity';
import { AppSuppressionContext } from '../react/parts/apps';
import ActivityPhaseGroup from './parts/ActivityPhaseGroup';
import { sameItems, sameMap, sameSet } from '../core/same';
import { hasPendingApprovalInPart } from '../core/pending';
import { AGENT_STYLE_TOOLS } from '../core/parts/routing';
import { HiddenAttachmentsContext } from './parts/media';
import { selectToolCallUIResources } from '../core/apps';
import { blocksLiveFold } from './parts/phase/activity';
import PendingSkillCall from './parts/PendingSkillCall';
import { SearchContext } from '../react/parts/search';
import { ParallelContentRenderer } from './Parallel';
import { AttachmentGroup } from './parts/Attachment';
import { MediaContext } from '../react/parts/media';
import { MessageContext } from '../react/message';
import ToolCallGroup from './parts/ToolCallGroup';
import ApprovalProvider from './approval/context';
import { useShared } from '../react/shared';
import Container from './parts/Container';
import AgentUpdate from './AgentUpdate';
import EmptyText from './EmptyText';
import { Part } from './Part';

const sameOwner = (a: ToolCallStepOwner, b: ToolCallStepOwner): boolean =>
  a.stepId === b.stepId && a.agentId === b.agentId;

const sameOwners = (a: ToolCallStepOwners, b: ToolCallStepOwners): boolean =>
  sameMap(
    a,
    b,
    (left, right) =>
      left.length === right.length && left.every((owner, index) => sameOwner(owner, right[index])),
  );

const sameAssignments = <K,>(
  a: ReadonlyMap<K, TAttachment[]>,
  b: ReadonlyMap<K, TAttachment[]>,
): boolean => sameMap(a, b, sameItems);

const NO_SLOTS: ContentPartsSlots = {};
const NO_ANSWERS: [] = [];
const NO_ATTACHMENTS: TAttachment[] = [];
const NO_CHANGES: WorkspaceChangeAttachment[] = [];
const useAppsAllowed = (): boolean => true;
const useNoAttachmentCalls = (): [] => NO_ANSWERS;

/** Without a host row for workspace changes, those files stay beside the calls that wrote them. */
const splitWorkspace = (
  attachments: TAttachment[] | undefined,
  summarized: boolean,
): { inlineAttachments: TAttachment[]; workspaceChanges: WorkspaceChangeAttachment[] } =>
  summarized
    ? partitionWorkspaceChanges(attachments)
    : { inlineAttachments: attachments ?? NO_ATTACHMENTS, workspaceChanges: NO_CHANGES };

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
  renderers?: ContentPartsSlots['renderers'];
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
  renderers,
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
      ? JSON.stringify([partAgentId(part) ?? '', partToolCallId(part), getPartKeyIndex(part, idx)])
      : undefined;

  const renderPart = (renderedPart: TMessageContentParts) => (
    <Part
      part={renderedPart}
      attachments={partAttachments}
      isSubmitting={isSubmitting}
      key={`part-${messageId}-${getPartKeyIndex(part, idx)}`}
      isCreatedByUser={isCreatedByUser}
      isLast={holdsCursor}
      showCursor={holdsCursor}
      hideAttachments={hideAttachments}
      onToolExpand={onToolExpand}
      renderers={renderers}
    />
  );

  return (
    <MessageContext.Provider value={contextValue}>
      <ToolDisclosureKeyContext.Provider value={toolDisclosureKey}>
        {isPreviewedToolCallPart(part) ? (
          <PreviewedToolCallPart part={part}>{renderPart}</PreviewedToolCallPart>
        ) : (
          renderPart(part)
        )}
      </ToolDisclosureKeyContext.Provider>
    </MessageContext.Provider>
  );
});

type FileRow = { key: string; files: TAttachment[]; source: TAttachment[] };

type PhaseSegment = Extract<ActivityPhaseSegment, { type: 'phase' }>;

/** The props every body nested under one body shares. */
type NestedBodyProps = Pick<
  ContentPartsProps,
  | 'messageId'
  | 'mediaScope'
  | 'createdAt'
  | 'authorHeader'
  | 'conversationId'
  | 'attachments'
  | 'searchResults'
  | 'isCreatedByUser'
  | 'isSubmitting'
  | 'isLatestMessage'
  | 'nestedActivityPhase'
  | 'showThinking'
  | 'workspaceAttachmentsPartitioned'
  | 'laneGroups'
  | 'toolGroupExpansionState'
  | 'toolGroupOccurrenceByIndex'
  | 'toolCallStepOwnersById'
  | 'slots'
> & { resumeAuthors: ReadonlyMap<number, string | undefined> };

/** Whether a synthesized span is waiting on its reader, and so draws unfolded for now. */
const awaitsReader = (segment: PhaseSegment, showThinking: boolean): boolean => {
  if (segment.live !== true) {
    return segment.content.some((part) => part != null && hasPendingApprovalInPart(part));
  }
  return (
    (showThinking && segment.content.some((part) => part?.type === ContentTypes.THINK)) ||
    segment.content.some(blocksLiveFold)
  );
};

type PhaseCardProps = {
  segment: PhaseSegment;
  /** The card's render identity; see `stableCardKey`. */
  cardKey: string;
  nested: NestedBodyProps;
  /** Transcript index of a position in the parent body's content. */
  indexAt: (localIndex: number) => number;
  attachmentsFor: (part: TMessageContentParts) => TAttachment[] | undefined;
  /** Whether the body inside holds the message's tail, and with it the cursor. */
  holdsTail: boolean;
  showCursor: boolean;
  animateEntrance: boolean;
  cursorOwnedElsewhere: boolean;
};

/**
 * One activity phase: its card, and the body of the span it folds. Memoized, and given only
 * values a streamed update leaves alone once the phase has settled, so the phases a long run has
 * already finished cost nothing while its tail streams.
 */
const PhaseCard = memo(function PhaseCard({
  segment,
  cardKey,
  nested,
  indexAt,
  attachmentsFor,
  holdsTail,
  showCursor,
  animateEntrance,
  cursorOwnedElsewhere,
}: PhaseCardProps) {
  const disclosureStore = useStore();
  const reasoningDisclosures = useContext(ReasoningDisclosureContext);
  const { content } = segment;
  const live = segment.live === true;
  const segmentIndices = useMemo(
    () => segment.contentIndices.map(indexAt),
    [segment.contentIndices, indexAt],
  );
  const hasPendingApproval = useMemo(
    () => content.some((part) => part != null && hasPendingApprovalInPart(part)),
    [content],
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
  const attachments = useMemo(
    () => collectPartAttachments(content, attachmentsFor),
    [content, attachmentsFor],
  );
  const soleTool = useMemo(
    () => content.filter((part) => part?.type === ContentTypes.TOOL_CALL).length === 1,
    [content],
  );
  const foldsReasoning =
    live &&
    reasoningDisclosures != null &&
    !content.some((part) => part?.type === ContentTypes.TOOL_CALL);
  return (
    <ActivityPhaseGroup
      labelPart={segment.labelPart}
      hasContent={segment.hasContent}
      attachments={attachments}
      renderAppViews={nested.slots?.renderAppViews}
      hasPendingApproval={hasPendingApproval}
      onExpansionChange={
        foldsReasoning
          ? (expanded) => {
              content.forEach((part, position) => {
                if (part?.type !== ContentTypes.THINK) {
                  return;
                }
                const index = getPartKeyIndex(part, segmentIndices[position]);
                disclosureStore.set(reasoningDisclosure(reasoningDisclosures, index), expanded);
              });
            }
          : undefined
      }
      liveParts={live ? content : undefined}
      spanParts={segment.hasContent ? content : undefined}
      animateEntrance={animateEntrance}
      showCursor={showCursor}
    >
      <SoleToolContext.Provider value={soleTool}>
        <ContentPartsBody
          key={`phase-content-${cardKey}`}
          {...nested}
          content={content}
          isLast={holdsTail}
          /** Opening a live row should show the calls running, so its
           *  groups keep their own live expansion rather than the
           *  settled-phase default of staying shut. */
          withinActivityPhase={!live}
          parentPhaseOwnsFailurePill
          cursorOwnedElsewhere={cursorOwnedElsewhere}
          hideAttachments
          contentIndexOffset={indexAt(segment.startIndex)}
          contentIndices={segmentIndices}
        />
      </SoleToolContext.Provider>
    </ActivityPhaseGroup>
  );
});

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
  mediaScope = 0,
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
  continuation = false,
  withinActivityPhase = false,
  parentPhaseOwnsFailurePill = false,
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
  slots = NO_SLOTS,
}: ContentPartsProps & { resumeAuthors: ReadonlyMap<number, string | undefined> }) {
  const { renderers, renderWorkspaceChanges } = slots;
  const summarized = renderWorkspaceChanges != null;
  const { inlineAttachments, workspaceChanges } = useMemo(
    () =>
      workspaceAttachmentsPartitioned
        ? { inlineAttachments: attachments ?? [], workspaceChanges: [] }
        : splitWorkspace(attachments, summarized),
    [attachments, workspaceAttachmentsPartitioned, summarized],
  );
  const attachmentMap = useMemo(() => mapAttachments(inlineAttachments), [inlineAttachments]);
  const resolvedToolCallStepOwners = useMemo(
    () => toolCallStepOwnersById ?? toolCallStepOwners(content),
    [toolCallStepOwnersById, content],
  );
  const nestedAttachments = useContext(SubagentAttachmentsContext);
  /** Files the message gave to a subagent run; a top-level call that matches
   *  one only by a reused id does not render it as its own. */
  const nestedFiles = useMemo(
    () => new Set([...nestedAttachments.values()].flat()),
    [nestedAttachments],
  );
  const attachmentsForPart = useCallback(
    (part: TMessageContentParts): TAttachment[] | undefined => {
      const matched = acceptedAttachments(part, attachmentMap, resolvedToolCallStepOwners);
      /** A tool run inside a subagent saves its files under the child tool
       *  call id, which only the subagent call's transcript carries. */
      const nested = nestedAttachments.get(part);
      const own =
        matched == null || nestedFiles.size === 0
          ? matched
          : matched.filter((file) => !nestedFiles.has(file) || nested?.includes(file) === true);
      if (nested == null) {
        return own;
      }
      return own == null ? nested : [...own, ...nested.filter((file) => !own.includes(file))];
    },
    [attachmentMap, resolvedToolCallStepOwners, nestedAttachments, nestedFiles],
  );
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
  const messageLaneGroups = useShared(
    useMemo(() => laneGroups ?? parallelLaneGroups(content), [laneGroups, content]),
    sameSet,
  );

  const foldsLiveTail = foldLiveActivity && isLast && effectiveIsSubmitting;
  /** A streamed update regroups the whole message, but only its tail differs: every segment that
   *  came out as before keeps its object, so the card memoized on it below is skipped. */
  const groupedSegments = useRef<ActivityPhaseSegment[] | undefined>(undefined);
  const phaseSegments = useMemo(() => {
    if (nestedActivityPhase) {
      return undefined;
    }
    const grouped = groupActivityPhases(content, messageLaneGroups, foldsLiveTail);
    groupedSegments.current =
      grouped == null ? undefined : shareActivitySegments(groupedSegments.current, grouped);
    return groupedSegments.current;
  }, [nestedActivityPhase, content, messageLaneGroups, foldsLiveTail]);
  const inheritedHiddenFiles = useContext(HiddenAttachmentsContext);
  const sharedRows = useRef<ReadonlyMap<string, FileRow>>(new Map());
  const fileRows = useMemo(() => {
    const rows = new Map<TMessageContentParts, FileRow>();
    const ownerByFile = new Map<string, { row: FileRow; index: number }>();
    if (
      nestedActivityPhase ||
      hideAttachments ||
      edit ||
      hasParallelLanes(content, messageLaneGroups)
    ) {
      return rows;
    }
    for (const [index, part] of (content ?? []).entries()) {
      if (part?.type !== ContentTypes.TOOL_CALL) continue;
      const call = part[ContentTypes.TOOL_CALL];
      const name = call != null && 'name' in call ? call.name : '';
      // Image-generation tools own a specialized preview with generation details.
      if (imageGenTools.has(name) || AGENT_STYLE_TOOLS.has(name)) {
        continue;
      }
      const files = collectPartAttachments([part], attachmentsForPart)?.filter(
        (file) => isFileOutput(file) && !inheritedHiddenFiles?.has(file),
      );
      if (!files?.length) continue;
      const row: FileRow = {
        key: `files-${mediaScope}-${partToolCallId(part)}-${getPartKeyIndex(part, absoluteIndexAt(index))}`,
        files: [],
        source: attachmentsForPart(part) ?? files,
      };
      for (const file of files) {
        const identity = attachmentRenderKey(file);
        const owner = identity == null ? undefined : ownerByFile.get(identity);
        if (owner != null) {
          owner.row.files[owner.index] = file;
          continue;
        }
        if (identity != null) ownerByFile.set(identity, { row, index: row.files.length });
        row.files.push(file);
      }
      // Keep source-only entries so legacy duplicates are suppressed at every matching part.
      rows.set(part, row);
    }
    /** A row that came out as before keeps its arrays, so its attachment group is skipped. */
    const kept = new Map<string, FileRow>();
    for (const [part, row] of rows) {
      const earlier = sharedRows.current.get(row.key);
      const same =
        earlier != null &&
        sameItems(earlier.files, row.files) &&
        sameItems(earlier.source, row.source);
      const shared = same ? earlier : row;
      kept.set(row.key, shared);
      rows.set(part, shared);
    }
    sharedRows.current = kept;
    return rows;
  }, [
    content,
    messageLaneGroups,
    nestedActivityPhase,
    hideAttachments,
    edit,
    attachmentsForPart,
    inheritedHiddenFiles,
    mediaScope,
    absoluteIndexAt,
  ]);
  const hiddenFilesRef = useRef<ReadonlySet<TAttachment> | null>(null);
  const nextHiddenFiles = new Set(inheritedHiddenFiles);
  for (const { source } of fileRows.values()) {
    for (const file of source) {
      // Hide superseded records too; the stable row renders only the latest version.
      if (isFileOutput(file)) nextHiddenFiles.add(file);
    }
  }
  if (
    hiddenFilesRef.current == null ||
    hiddenFilesRef.current.size !== nextHiddenFiles.size ||
    [...nextHiddenFiles].some((file) => !hiddenFilesRef.current?.has(file))
  ) {
    hiddenFilesRef.current = nextHiddenFiles;
  }
  const hiddenFiles = hiddenFilesRef.current;
  const renderFiles = (parts: ReadonlyArray<TMessageContentParts | undefined>): ReactElement[] => {
    const rows: ReactElement[] = [];
    for (const part of parts) {
      const row = part == null ? undefined : fileRows.get(part);
      if (row == null || row.files.length === 0) continue;
      rows.push(
        <HiddenAttachmentsContext.Provider key={row.key} value={inheritedHiddenFiles}>
          <AttachmentGroup attachments={row.files} />
        </HiddenAttachmentsContext.Provider>,
      );
    }
    return rows;
  };
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
    (
      part: TMessageContentParts,
      idx: number,
      isLastPart: boolean,
      nextInLane?: TMessageContentParts['type'] | null,
    ) => {
      const localIdx = localIndexByAbsolute?.get(idx) ?? idx - contentIndexOffset;
      // A lane tail reports null rather than falling through to another lane's part.
      const nextType = nextInLane === undefined ? content?.[localIdx + 1]?.type : nextInLane;
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
          nextType={nextType ?? undefined}
          isSubmitting={effectiveIsSubmitting}
          partAttachments={attachmentsForPart(part)}
          hideAttachments={hideAttachments}
          renderers={renderers}
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
      renderers,
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
          renderers={renderers}
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
      renderers,
    ],
  );

  const sequentialParts = useMemo(() => {
    const parts: PartWithIndex[] = [];
    content?.forEach((part, localIdx) => {
      if (part != null) {
        parts.push({ part, idx: absoluteIndexAt(localIdx) });
      }
    });
    return parts;
  }, [absoluteIndexAt, content]);

  const resolvedToolGroupOccurrences = useShared(
    useMemo(
      () =>
        toolGroupOccurrenceByIndex ??
        toolGroupOccurrences(groupSequentialToolCalls(sequentialParts), fallbackScope),
      [toolGroupOccurrenceByIndex, sequentialParts, fallbackScope],
    ),
    sameMap,
  );
  /** What every body nested under this one is given. One object that a streamed update leaves
   *  alone, so a settled phase card sees the same props and is skipped. */
  const nested = useMemo<NestedBodyProps>(
    () => ({
      messageId,
      mediaScope,
      createdAt,
      authorHeader,
      conversationId,
      attachments: inlineAttachments,
      searchResults,
      isCreatedByUser,
      isSubmitting,
      isLatestMessage,
      nestedActivityPhase: true,
      showThinking,
      workspaceAttachmentsPartitioned: true,
      laneGroups: messageLaneGroups,
      resumeAuthors,
      toolGroupExpansionState: expansionState,
      toolGroupOccurrenceByIndex: resolvedToolGroupOccurrences,
      toolCallStepOwnersById: resolvedToolCallStepOwners,
      slots,
    }),
    [
      messageId,
      mediaScope,
      createdAt,
      authorHeader,
      conversationId,
      inlineAttachments,
      searchResults,
      isCreatedByUser,
      isSubmitting,
      isLatestMessage,
      showThinking,
      messageLaneGroups,
      resumeAuthors,
      expansionState,
      resolvedToolGroupOccurrences,
      resolvedToolCallStepOwners,
      slots,
    ],
  );

  const groupParts = useCallback(
    (parts: PartWithIndex[]) => {
      return groupSequentialToolCalls(parts).map((group) => {
        if (group.type === 'single') {
          return group;
        }
        const baseGroupId = toolGroupId(group.parts, fallbackScope);
        const occurrence = resolvedToolGroupOccurrences.get(toolGroupAnchor(group.parts)) ?? 1;
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
    },
    [attachmentsForPart, fallbackScope, hideAttachments, resolvedToolGroupOccurrences],
  );
  const groupedParts = useMemo(
    () => (phaseSegments == null ? groupParts(sequentialParts) : []),
    [phaseSegments, groupParts, sequentialParts],
  );

  /** The re-attribution node for a part resuming after a steer block, shared
   *  by the sequential path and the parallel renderer's sequential stretches. */
  const renderResumeAttribution = useCallback(
    (idx: number, keyIdx: number = idx): ReactElement | null => {
      if (authorHeader == null || !resumeAuthors.has(idx)) {
        return null;
      }
      const activeAgentId = resumeAuthors.get(idx);
      if (activeAgentId != null) {
        return <AgentUpdate key={`author-${messageId}-${keyIdx}`} currentAgentId={activeAgentId} />;
      }
      return <Fragment key={`author-${messageId}-${keyIdx}`}>{authorHeader}</Fragment>;
    },
    [authorHeader, resumeAuthors, messageId],
  );

  // Early return: no content to render AND no pending skill cards
  if (!content && !hasPendingSkills && workspaceChanges.length === 0) {
    return null;
  }

  // Interim skill cards are a mid-stream concern, not relevant in edit mode.
  if (edit === true && enterEdit && setSiblingIdx && slots.renderEdit) {
    return (
      <ApprovalProvider>
        <SearchContext.Provider value={{ searchResults }}>
          <MemoryArtifacts attachments={attachments} />
          {slots.renderEdit({
            content: content ?? [],
            contentIndexOffset,
            messageId,
            isSubmitting,
            enterEdit,
            siblingIdx: siblingIdx ?? null,
            setSiblingIdx,
            renderReadOnlyPart: (part, idx, isLastPart) => renderPart(part, idx, isLastPart),
          })}
          {renderWorkspaceChanges?.(workspaceChanges)}
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

  const renderGroups = (groups: ReturnType<typeof groupParts>, lastContentIdx: number) => {
    let lastProseIndex = -1;
    for (const group of groups) {
      if (group.type === 'single' && group.part.part.type === ContentTypes.TEXT) {
        lastProseIndex = Math.max(lastProseIndex, group.part.idx);
      }
    }
    return groups.flatMap((group) => {
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
        nodes.push(renderPart(part, idx, idx === lastContentIdx), ...renderFiles([part]));
        return nodes;
      }
      const { groupId } = group;
      nodes.push(
        <ToolCallGroup
          key={`tool-group-${groupId}`}
          parts={group.parts}
          followedByAnswer={
            lastProseIndex > (group.labelPart?.idx ?? group.parts[group.parts.length - 1].idx)
          }
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
          parentPhaseOwnsFailurePill={parentPhaseOwnsFailurePill}
          renderAppViews={slots.renderAppViews}
        />,
      );
      nodes.push(...renderFiles(group.parts.map(({ part }) => part)));
      return nodes;
    });
  };

  const hasParallelContent = hasParallelLanes(content, messageLaneGroups);
  let phaseContent: ReactElement[] | undefined;
  if (phaseSegments != null) {
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
     *  reason `toolGroupId` gives: an empty leading TEXT or THINK is
     *  DROPPED by `preserveStreamedContentIdentity` at settle, which would
     *  move a first-part anchor and remount the card exactly when the run
     *  finishes. The tool calls themselves do not move. */
    const phaseCardKey = (segment: Extract<ActivityPhaseSegment, { type: 'phase' }>): string => {
      for (let position = 0; position < segment.content.length; position += 1) {
        const part = segment.content[position];
        const toolCallId = part == null ? '' : partToolCallId(part);
        if (toolCallId) {
          const anchor = getPartKeyIndex(part, absoluteIndexAt(segment.contentIndices[position]));
          return `${toolCallId}:${anchor}`;
        }
      }
      /** No provider id in the span at all — id-less legacy calls,
       *  reasoning-only, or children compacted away. A bare position cannot
       *  separate two siblings whose cards start at the same index, so this
       *  branch carries the message-change counter, exactly as
       *  `toolGroupId` does for its own id-less fallback. The tradeoff is
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
          ? segment.contentIndices.map(absoluteIndexAt).includes(lastContentIdx)
          : absoluteIndexAt(segment.labelIndex) === lastContentIdx;
      });
    const renderSegment = (
      segmentContent: Array<TMessageContentParts | undefined>,
      segmentStartIndex: number,
      segmentIndices: ReadonlyArray<number>,
      key: string,
    ) => (
      <ContentPartsBody
        key={key}
        {...nested}
        content={segmentContent}
        isLast={isLast && segmentIndices.includes(lastContentIdx)}
        cursorOwnedElsewhere={cursorOwnedByCard}
        contentIndexOffset={segmentStartIndex}
        contentIndices={segmentIndices}
      />
    );
    phaseContent = phaseSegments.flatMap((segment) => {
      if (segment.type !== 'phase') {
        if (hasParallelContent) {
          return renderSegment(
            segment.content,
            absoluteIndexAt(segment.startIndex),
            segment.contentIndices.map(absoluteIndexAt),
            `phase-adjacent-${segmentKeyIndex(segment)}`,
          );
        }
        /** Unclaimed prose keeps its original parent and part key. A
         * nested body here would remount it whenever a fold appears or
         * disappears, replaying the markdown word fade. */
        const parts: PartWithIndex[] = [];
        segment.content.forEach((part, position) => {
          if (part != null) {
            parts.push({ part, idx: absoluteIndexAt(segment.contentIndices[position]) });
          }
        });
        return renderGroups(groupParts(parts), lastContentIdx);
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
       *  `toolGroupId` uses an occurrence counter. */
      const cardKey = stableCardKey(segment);
      const labelText = getActivityLabelText(segment.labelPart);
      const holdsTail = segment.contentIndices.some(
        (index) => absoluteIndexAt(index) === lastContentIdx,
      );
      /** While a run streams, the cursor sits INSIDE a synthesized span.
       *  A collapsed card would swallow it, so the card carries it below
       *  the header and the nested body stands down. */
      const ownsCursor = synthesized && isLast && effectiveIsSubmitting && holdsTail;
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
      if (synthesized && awaitsReader(segment, showThinking)) {
        return [
          renderSegment(
            segment.content,
            absoluteIndexAt(segment.startIndex),
            segment.contentIndices.map(absoluteIndexAt),
            `phase-awaiting-${cardKey}`,
          ),
          ...renderFiles(segment.content),
        ];
      }
      return [
        <PhaseCard
          key={`activity-phase-${cardKey}`}
          segment={segment}
          cardKey={cardKey}
          nested={nested}
          indexAt={absoluteIndexAt}
          attachmentsFor={attachmentsForPart}
          holdsTail={!ownsCursor && isLast && holdsTail}
          cursorOwnedElsewhere={cursorOwnedByCard}
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
                absoluteIndexAt(segment.labelIndex) === lastContentIdx
          }
        />,
        ...renderFiles(segment.content),
      ];
    });
  }

  /** Columns only when at least two agents share a group — a lone group
   *  renders here, where tool grouping and activity labels apply. */
  if (hasParallelContent && phaseContent == null) {
    const parallelContent = (
      <>
        {!continuation && renderPendingSkills()}
        <ParallelContentRenderer
          content={content}
          messageId={messageId}
          createdAt={createdAt}
          conversationId={conversationId}
          attachments={attachments}
          searchResults={searchResults}
          isSubmitting={effectiveIsSubmitting}
          renderPart={renderPart}
          renderColumnHeader={slots.renderColumnHeader}
          renderResumeAttribution={renderResumeAttribution}
          showDecorations={!nestedActivityPhase && !continuation}
          contentIndexOffset={contentIndexOffset}
          contentIndices={contentIndices}
          laneGroups={messageLaneGroups}
        />
        {!nestedActivityPhase && renderWorkspaceChanges?.(workspaceChanges)}
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
    <HiddenAttachmentsContext.Provider value={hiddenFiles}>
      <SearchContext.Provider value={{ searchResults }}>
        {!nestedActivityPhase && !continuation && <MemoryArtifacts attachments={attachments} />}
        {!nestedActivityPhase && !continuation && renderPendingSkills()}
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
        {!showEmptyCursor && (phaseContent ?? renderGroups(groupedParts, lastContentIdx))}
        {!nestedActivityPhase && renderWorkspaceChanges?.(workspaceChanges)}
      </SearchContext.Provider>
    </HiddenAttachmentsContext.Provider>
  );
  if (nestedActivityPhase) {
    return sequentialContent;
  }
  return <ApprovalProvider>{sequentialContent}</ApprovalProvider>;
});

/**
 * Draws a message's content parts: text, reasoning, tool calls and what they produced, folded
 * into groups and activity phases, in columns where agents ran side by side.
 */
export const ContentParts: NamedExoticComponent<ContentPartsProps> = memo(function ContentParts(
  props: ContentPartsProps,
) {
  const slots = props.slots ?? NO_SLOTS;
  const { renderApp, renderSources, renderWorkspaceChanges } = slots;
  const summarized = renderWorkspaceChanges != null;
  const useAppsEnabled = slots.useAppsEnabled ?? useAppsAllowed;
  const appsEnabled = useAppsEnabled() && renderApp != null;
  const {
    attachments,
    messageId,
    conversationId,
    isCreatedByUser,
    isLatestMessage,
    isSubmitting,
    renderOwnerId,
  } = props;
  /** One mounted response, retained across its optimistic and durable message ids. */
  const appRenderIdentity = useRef<RenderIdentity | null>(null);
  appRenderIdentity.current = advanceRenderIdentity(appRenderIdentity.current, {
    messageId,
    conversationId,
    ownerId: renderOwnerId,
    isLatestMessage: isLatestMessage === true,
    isSubmitting,
    isCreatedByUser,
  });
  const appRenderScope = appRenderIdentity.current.scope;
  const liveSubagentToolCalls = useLiveSubagentToolCalls(
    props.content,
    attachments,
    messageId,
    props.contentIndices,
    props.contentIndexOffset ?? 0,
  );
  const inlineAttachments = useMemo(
    () => splitWorkspace(attachments, summarized).inlineAttachments,
    [attachments, summarized],
  );
  /** Built once for the message: every body it splits into, and each routing pass below, reads
   *  the same owners instead of walking the content again. */
  const owners = useShared(
    useMemo(() => toolCallStepOwners(props.content), [props.content]),
    sameOwners,
  );
  const inlineByToolCall = useMemo(() => mapAttachments(inlineAttachments), [inlineAttachments]);
  const liveRouting = useMemo(
    () =>
      routeNestedAttachments(
        props.content,
        inlineAttachments,
        liveSubagentToolCalls,
        inlineByToolCall,
        owners,
      ),
    [props.content, inlineAttachments, liveSubagentToolCalls, inlineByToolCall, owners],
  );
  /** A file no part owns under its full scope may belong to a child call of a previewed subagent
   *  run whose transcript was left out, such as one a background task delivered after this load. */
  const filesInDoubt = useMemo(() => attachmentScopes(liveRouting.inDoubt), [liveRouting]);
  const storedSubagentHints = useStoredSubagentHints(
    props.content,
    filesInDoubt,
    conversationId,
    messageId,
    slots.useSubagentAttachmentCalls ?? useNoAttachmentCalls,
  );
  /** Assigned once for the whole message: the bodies an MCP App or a phase
   *  splits it into each see a slice, and must agree on every file's owner. */
  const routedAttachments = useMemo(() => {
    if (storedSubagentHints.size === 0) {
      return liveRouting.nested;
    }
    const calls = new Map(liveSubagentToolCalls);
    for (const [index, stored] of storedSubagentHints) {
      calls.set(index, [...(calls.get(index) ?? []), ...stored]);
    }
    return routeNestedAttachments(props.content, inlineAttachments, calls, inlineByToolCall, owners)
      .nested;
  }, [
    props.content,
    inlineAttachments,
    liveRouting,
    liveSubagentToolCalls,
    storedSubagentHints,
    inlineByToolCall,
    owners,
  ]);
  /** Routing runs on every streamed update and usually comes out as before. Handing every body the
   *  earlier map then keeps the context, and each body's attachment lookup, unchanged. */
  const nestedAttachments = useShared(routedAttachments, sameAssignments);
  const byToolCall = useMemo(() => mapAttachments(attachments ?? []), [attachments]);
  const messageContent = useMemo(
    () =>
      collectMessageContent(
        props.content,
        byToolCall,
        owners,
        nestedAttachments,
        props.contentIndexOffset,
        props.contentIndices,
      ),
    [
      props.content,
      byToolCall,
      owners,
      nestedAttachments,
      props.contentIndexOffset,
      props.contentIndices,
    ],
  );
  const drawnApps = useShared(messageContent.attachments, sameItems);
  const resumeAuthors = useShared(messageContent.resumeAuthors, sameMap);
  /** The Apps this message draws as rows of its own, which the views under a tool group or a phase
   *  leave out. Only a host that draws those rows has any: without `renderApp` nothing is held
   *  back, so `renderAppViews` is where its Apps appear. */
  const suppressedAppAttachments = useMemo<ReadonlySet<TAttachment> | null>(
    () => (renderApp == null ? null : new Set(drawnApps)),
    [renderApp, drawnApps],
  );
  const messageContext = useMemo(
    () => ({
      messageId,
      conversationId,
      isExpanded: false as const,
      isSubmitting: isLatestMessage === true && isSubmitting,
      isLatestMessage,
    }),
    [messageId, conversationId, isSubmitting, isLatestMessage],
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
  const appContent = useMemo(() => {
    if (!appsEnabled || renderApp == null || messageContent.atIndex.size === 0 || props.edit) {
      return null;
    }
    const lanes = parallelLaneGroups(props.content);
    const { inlineAttachments, workspaceChanges } = splitWorkspace(attachments, summarized);
    const resourcesByAttachment = new Map<
      TAttachment,
      Array<{ resource: MCPAppResourceOccurrence; ordinal: number }>
    >();
    selectToolCallUIResources(messageContent.attachments).forEach((resource, index) => {
      const entries = resourcesByAttachment.get(resource.attachment) ?? [];
      entries.push({ resource, ordinal: index + 1 });
      resourcesByAttachment.set(resource.attachment, entries);
    });
    const rows: ReactNode[] = [];
    let start = 0;
    const renderSlice = (end: number) => {
      if (end <= start) return;
      // Sparse slices preserve provider/phase indices. App siblings never belong to a fold,
      // parallel column, or tool card that can change parents while the response streams.
      const slice: Array<TMessageContentParts | undefined> = [];
      for (let index = start; index < end; index++) {
        const part = props.content?.[index];
        if (part != null) slice[index] = part;
      }
      rows.push(
        <AppSuppressionContext.Provider key={`body-${start}`} value={suppressedAppAttachments}>
          <SoleToolContext.Provider value={undefined}>
            <ContentPartsBody
              {...props}
              mediaScope={appRenderScope}
              content={slice}
              attachments={inlineAttachments}
              workspaceAttachmentsPartitioned
              continuation={start > 0}
              isLast={props.isLast && end === props.content?.length}
              laneGroups={lanes}
              resumeAuthors={props.resumeAuthors ?? resumeAuthors}
              toolCallStepOwnersById={owners}
            />
          </SoleToolContext.Provider>
        </AppSuppressionContext.Provider>,
      );
    };
    for (const [index, appAttachments] of messageContent.atIndex) {
      renderSlice(index + 1);
      for (const attachment of appAttachments) {
        for (const { resource, ordinal } of resourcesByAttachment.get(attachment) ?? []) {
          rows.push(
            <Fragment key={`app-${appRenderScope}-${resource.key}`}>
              {renderApp(resource, ordinal)}
            </Fragment>,
          );
        }
      }
      start = index + 1;
    }
    renderSlice(props.content?.length ?? 0);
    rows.push(<Fragment key="workspace">{renderWorkspaceChanges?.(workspaceChanges)}</Fragment>);
    return rows;
  }, [
    props,
    attachments,
    messageContent,
    suppressedAppAttachments,
    appRenderScope,
    appsEnabled,
    owners,
    renderApp,
    summarized,
    renderWorkspaceChanges,
    resumeAuthors,
  ]);
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
    <MessageContext.Provider value={messageContext}>
      <MediaContext.Provider value={media}>
        <ReasoningDisclosureContext.Provider value={reasoningDisclosures}>
          <ToolDisclosureContext.Provider value={toolDisclosures}>
            {!props.edit &&
              renderSources != null &&
              hasParallelLanes(props.content, props.laneGroups) && (
                <SearchContext.Provider value={{ searchResults: props.searchResults }}>
                  {renderSources({ messageId, conversationId: conversationId || undefined })}
                </SearchContext.Provider>
              )}
            <SubagentAttachmentsContext.Provider value={nestedAttachments}>
              {appContent ?? (
                <AppSuppressionContext.Provider key="body-0" value={suppressedAppAttachments}>
                  <SoleToolContext.Provider value={undefined}>
                    <ContentPartsBody
                      {...props}
                      mediaScope={appRenderScope}
                      resumeAuthors={props.resumeAuthors ?? resumeAuthors}
                      toolCallStepOwnersById={owners}
                    />
                  </SoleToolContext.Provider>
                </AppSuppressionContext.Provider>
              )}
            </SubagentAttachmentsContext.Provider>
          </ToolDisclosureContext.Provider>
        </ReasoningDisclosureContext.Provider>
      </MediaContext.Provider>
    </MessageContext.Provider>
  );
});
