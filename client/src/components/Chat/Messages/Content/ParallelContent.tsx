import { memo, useMemo, Fragment } from 'react';
import { ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts, SearchResultData, TAttachment } from 'librechat-data-provider';
import {
  getActivityLabelPart,
  getActivityLabelText,
  lastCursorContentIdx,
} from '~/utils/activityLabels';
import { MIN_PARALLEL_LANES, UNATTRIBUTED_LANE, isLaneMarkerPart } from '~/utils/lanes';
import MemoryArtifacts from './MemoryArtifacts';
import Sources from '~/components/Web/Sources';
import { cn, getPartKeyIndex } from '~/utils';
import { SearchContext } from '~/Providers';
import SiblingHeader from './SiblingHeader';
import { EmptyText } from './Parts';
import Container from './Container';

export type PartWithIndex = { part: TMessageContentParts; idx: number };

export type ParallelColumn = {
  agentId: string;
  parts: PartWithIndex[];
};

export type ParallelSection = {
  groupId: number;
  columns: ParallelColumn[];
};

/**
 * Groups content parts by groupId for parallel rendering.
 * Parts with same groupId are displayed in columns, grouped by agentId.
 *
 * @param content - Array of content parts
 * @returns Object containing parallel sections and sequential parts
 */
export function groupParallelContent(
  content: Array<TMessageContentParts | undefined> | undefined,
  contentIndexOffset = 0,
  contentIndices?: ReadonlyArray<number>,
  laneGroups?: ReadonlySet<number>,
): { parallelSections: ParallelSection[]; sequentialParts: PartWithIndex[] } {
  if (!content) {
    return { parallelSections: [], sequentialParts: [] };
  }

  const groupMap = new Map<number, PartWithIndex[]>();
  // Track placeholder agentIds per groupId (parts with empty type that establish columns)
  const placeholderAgents = new Map<number, Set<string>>();
  const noGroup: PartWithIndex[] = [];

  content.forEach((part, localIdx) => {
    if (!part) {
      return;
    }
    const idx = contentIndices?.[localIdx] ?? localIdx + contentIndexOffset;

    // Read metadata directly from content part (TMessageContentParts includes ContentMetadata)
    const { groupId } = part;

    // Check for placeholder (empty type) before narrowing - access agentId via casting
    const partAgentId = (part as { agentId?: string }).agentId;

    if (groupId != null) {
      // Track placeholder parts (empty type) to establish columns for pending agents
      if (!part.type && partAgentId) {
        if (!placeholderAgents.has(groupId)) {
          placeholderAgents.set(groupId, new Set());
        }
        placeholderAgents.get(groupId)!.add(partAgentId);
        return; // Don't add to groupMap - we'll handle these separately
      }

      if (!groupMap.has(groupId)) {
        groupMap.set(groupId, []);
      }
      groupMap.get(groupId)!.push({ part, idx });
    } else {
      noGroup.push({ part, idx });
    }
  });

  // Collect all groupIds (from both real content and placeholders)
  const allGroupIds = new Set([...groupMap.keys(), ...placeholderAgents.keys()]);

  // Build parallel sections with columns grouped by agentId
  const sections: ParallelSection[] = [];
  for (const groupId of allGroupIds) {
    const columnMap = new Map<string, PartWithIndex[]>();
    const parts = groupMap.get(groupId) ?? [];

    for (const { part, idx } of parts) {
      // Read agentId directly from content part (TMessageContentParts includes ContentMetadata)
      const agentId = part.agentId ?? UNATTRIBUTED_LANE;

      if (!columnMap.has(agentId)) {
        columnMap.set(agentId, []);
      }
      columnMap.get(agentId)!.push({ part, idx });
    }

    // Add empty columns for placeholder agents that don't have real content yet
    const groupPlaceholders = placeholderAgents.get(groupId);
    if (groupPlaceholders) {
      for (const placeholderAgentId of groupPlaceholders) {
        if (!columnMap.has(placeholderAgentId)) {
          // Empty array signals this column should show loading state
          columnMap.set(placeholderAgentId, []);
        }
      }
    }

    // Sort columns: primary agent (no ____N suffix) first, added agents (with suffix) second
    // This ensures consistent column ordering regardless of which agent responds first
    const sortedAgentIds = Array.from(columnMap.keys()).sort((a, b) => {
      const aHasSuffix = a.includes('____');
      const bHasSuffix = b.includes('____');
      if (aHasSuffix && !bHasSuffix) {
        return 1;
      }
      if (!aHasSuffix && bHasSuffix) {
        return -1;
      }
      return 0;
    });

    const columns = sortedAgentIds.map((agentId) => ({
      agentId,
      parts: columnMap.get(agentId)!,
    }));

    /** Which columns are an agent's own output, mirroring `laneAgentsByGroup`:
     *  the sentinel column belongs to no agent, and a column holding only a
     *  handoff marker is nothing to compare against. A placeholder column has
     *  no parts at all and still claims its lane — that is how a dual run
     *  shows both agents from the first render. */
    const claimedColumns = columns.filter(
      ({ agentId, parts }) =>
        agentId !== UNATTRIBUTED_LANE &&
        (parts.length === 0 || parts.some(({ part }) => !isLaneMarkerPart(part))),
    ).length;

    /** One column is not a comparison. Its parts rejoin the sequential flow,
     *  where tool grouping, activity-label headers and phase folds apply and
     *  the message's own author header is the only attribution shown.
     *
     *  `laneGroups` is the message-level verdict: a phase slice holding one
     *  agent of a real two-agent group keeps its columns, because the group
     *  is a comparison even where this slice cannot show it. */
    if (claimedColumns < MIN_PARALLEL_LANES && laneGroups?.has(groupId) !== true) {
      for (const column of columns) {
        noGroup.push(...column.parts);
      }
      continue;
    }

    sections.push({ groupId, columns });
  }

  // Sort sections by the minimum index in each section (sections with only placeholders go last)
  sections.sort((a, b) => {
    const aParts = a.columns.flatMap((c) => c.parts.map((p) => p.idx));
    const bParts = b.columns.flatMap((c) => c.parts.map((p) => p.idx));
    const aMin = aParts.length > 0 ? Math.min(...aParts) : Infinity;
    const bMin = bParts.length > 0 ? Math.min(...bParts) : Infinity;
    return aMin - bMin;
  });

  /** Demoted lane parts are appended after the parts that preceded them, so
   *  restore transcript order before the before/after split reads indexes. */
  noGroup.sort((a, b) => a.idx - b.idx);

  return { parallelSections: sections, sequentialParts: noGroup };
}

type ParallelColumnsProps = {
  columns: ParallelColumn[];
  groupId: number;
  messageId: string;
  createdAt?: string | null;
  isSubmitting: boolean;
  lastContentIdx: number;
  conversationId?: string | null;
  renderPart: (part: TMessageContentParts, idx: number, isLastPart: boolean) => React.ReactNode;
};

/**
 * Renders parallel content columns for a single groupId.
 */
export const ParallelColumns = memo(function ParallelColumns({
  columns,
  groupId,
  messageId,
  createdAt,
  conversationId,
  isSubmitting,
  lastContentIdx,
  renderPart,
}: ParallelColumnsProps) {
  return (
    <div className={cn('flex w-full flex-col gap-3 md:flex-row', 'sibling-content-group')}>
      {columns.map(({ agentId, parts: allColumnParts }, colIdx) => {
        /** Lanes render raw parts, so an activity label cannot become a
         *  collapsible header here (tracked separately). An UNFILLED one has
         *  nothing to render at all, and every batch now publishes its
         *  reservation immediately — so drop empty labels rather than emit a
         *  blank line into the column while generation is pending. */
        const columnParts = allColumnParts.filter(
          ({ part }) =>
            part?.type !== ContentTypes.ACTIVITY_LABEL ||
            getActivityLabelText(getActivityLabelPart(part)).length > 0,
        );
        const lastColumnCursorIdx = lastParallelColumnCursorIdx(columnParts);
        // Show loading cursor if column has no content parts yet (empty array from placeholder)
        const showLoadingCursor = isSubmitting && columnParts.length === 0;

        return (
          <div
            key={`column-${messageId}-${groupId}-${agentId || colIdx}`}
            className="min-w-0 flex-1 rounded-lg border border-border-light p-3"
          >
            <SiblingHeader
              agentId={agentId}
              messageId={messageId}
              createdAt={createdAt}
              isSubmitting={isSubmitting}
              conversationId={conversationId}
            />
            {showLoadingCursor ? (
              <Container>
                <EmptyText />
              </Container>
            ) : (
              columnParts.map(({ part, idx }) => {
                const isLastInColumn = idx === lastColumnCursorIdx;
                const isLastContent = idx === lastContentIdx;
                return renderPart(part, idx, isLastInColumn && isLastContent);
              })
            )}
          </div>
        );
      })}
    </div>
  );
});

export function lastParallelColumnCursorIdx(
  parts: ReadonlyArray<{ part: TMessageContentParts; idx: number }>,
): number {
  const relativeIdx = lastCursorContentIdx(parts.map(({ part }) => part));
  return relativeIdx < 0 ? -1 : (parts[relativeIdx]?.idx ?? -1);
}

type ParallelContentRendererProps = {
  content?: Array<TMessageContentParts | undefined>;
  messageId: string;
  createdAt?: string | null;
  conversationId?: string | null;
  attachments?: TAttachment[];
  searchResults?: { [key: string]: SearchResultData };
  isSubmitting: boolean;
  renderPart: (part: TMessageContentParts, idx: number, isLastPart: boolean) => React.ReactNode;
  /**
   * Author re-attribution for a part that resumes after an inline steer —
   * returns the header node to render before that part, or null. Only the
   * sequential before/after stretches consult it: column content already
   * carries per-agent identity.
   */
  renderResumeAttribution?: (idx: number, keyIdx?: number) => React.ReactNode;
  showDecorations?: boolean;
  /** Absolute transcript index represented by `content[0]` in a phase slice. */
  contentIndexOffset?: number;
  /** Absolute transcript index for each compacted sparse segment entry. */
  contentIndices?: ReadonlyArray<number>;
  /** Message-level lane cardinality, so a phase slice does not recount. */
  laneGroups?: ReadonlySet<number>;
};

/**
 * Renders content with parallel sections (columns) and sequential parts.
 * Handles the layout of before/parallel/after content sections.
 */
export const ParallelContentRenderer = memo(function ParallelContentRenderer({
  content,
  messageId,
  createdAt,
  conversationId,
  attachments,
  searchResults,
  isSubmitting,
  renderPart,
  renderResumeAttribution,
  showDecorations = true,
  contentIndexOffset = 0,
  contentIndices,
  laneGroups,
}: ParallelContentRendererProps) {
  const { parallelSections, sequentialParts } = useMemo(
    () => groupParallelContent(content, contentIndexOffset, contentIndices, laneGroups),
    [content, contentIndexOffset, contentIndices, laneGroups],
  );

  /** Same walk-back as `ContentParts`: a trailing BLANK label reservation is
   *  filtered out of every lane, so counting it as last would leave NO
   *  rendered part with the last-part cursor until the label fills. */
  const relativeLastContentIdx = lastCursorContentIdx(content);
  const lastContentIdx =
    relativeLastContentIdx < 0
      ? -1
      : (contentIndices?.[relativeLastContentIdx] ?? relativeLastContentIdx + contentIndexOffset);

  /** Sequential parts are laid out AROUND each section rather than split once
   *  around all of them: two groups with ordinary content between them would
   *  otherwise render both groups first and the intervening part last.
   *
   *  A part landing between a section's own first and last index has no column
   *  and no slot inside one, so it falls to the next block — after the lanes it
   *  interleaves with. Bounding it by the last lane index instead dropped it
   *  from the message entirely, and a placeholder-only section made
   *  `Math.min(...[])` Infinity, which rendered every part twice. */
  const { blocks, trailing } = useMemo(() => {
    const laid: Array<{ leading: PartWithIndex[]; section: ParallelSection }> = [];
    let cursor = 0;
    for (const section of parallelSections) {
      const indices = section.columns.flatMap((column) => column.parts.map((part) => part.idx));
      const sectionStart = indices.length > 0 ? Math.min(...indices) : Infinity;
      const leading: PartWithIndex[] = [];
      while (cursor < sequentialParts.length && sequentialParts[cursor].idx < sectionStart) {
        leading.push(sequentialParts[cursor]);
        cursor += 1;
      }
      laid.push({ leading, section });
    }
    return { blocks: laid, trailing: sequentialParts.slice(cursor) };
  }, [parallelSections, sequentialParts]);

  const renderSequential = ({ part, idx }: PartWithIndex) => {
    const attribution = renderResumeAttribution?.(idx, getPartKeyIndex(part, idx));
    const rendered = renderPart(part, idx, idx === lastContentIdx);
    return attribution != null ? [attribution, rendered] : [rendered];
  };

  return (
    <SearchContext.Provider value={{ searchResults }}>
      {showDecorations && <MemoryArtifacts attachments={attachments} />}
      {showDecorations && (
        <Sources messageId={messageId} conversationId={conversationId || undefined} />
      )}

      {/* Each section preceded by the sequential content that runs up to it */}
      {blocks.map(({ leading, section: { groupId, columns } }) => (
        <Fragment key={`parallel-block-${messageId}-${groupId}`}>
          {leading.flatMap(renderSequential)}
          <ParallelColumns
            columns={columns}
            groupId={groupId}
            messageId={messageId}
            createdAt={createdAt}
            renderPart={renderPart}
            isSubmitting={isSubmitting}
            conversationId={conversationId}
            lastContentIdx={lastContentIdx}
          />
        </Fragment>
      ))}

      {/* Sequential content after the last section */}
      {trailing.flatMap(renderSequential)}
    </SearchContext.Provider>
  );
});

export default ParallelContentRenderer;
