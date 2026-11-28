import { memo, useMemo, Fragment } from 'react';
import { cn } from '@librechat/client';
import { ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts, SearchResultData, TAttachment } from 'librechat-data-provider';
import type { NamedExoticComponent, ReactNode } from 'react';
import type { ParallelColumn, ParallelSection } from '../core/parallel';
import type { PartWithIndex } from '../core/content';
import {
  getActivityLabelPart,
  getActivityLabelText,
  lastCursorContentIdx,
} from '../core/parts/activityLabels';
import { groupParallelContent, lastParallelColumnCursorIdx } from '../core/parallel';
import { SearchContext } from '../react/parts/search';
import MemoryArtifacts from './parts/MemoryArtifacts';
import { getPartKeyIndex } from '../core/content';
import Container from './parts/Container';
import EmptyText from './EmptyText';

/** Who a column belongs to, for the header a host draws above it. */
export type ParallelColumnHeaderProps = {
  agentId: string;
  messageId: string;
  createdAt?: string | null;
  isSubmitting: boolean;
  conversationId?: string | null;
};

type RenderPart = (
  part: TMessageContentParts,
  idx: number,
  isLastPart: boolean,
  nextInLane?: TMessageContentParts['type'] | null,
) => ReactNode;

/** Draws the header of one column: the agent it belongs to. Without it a column has none. */
type RenderColumnHeader = (props: ParallelColumnHeaderProps) => ReactNode;

export type ParallelColumnsProps = {
  columns: ParallelColumn[];
  groupId: number;
  messageId: string;
  createdAt?: string | null;
  isSubmitting: boolean;
  lastContentIdx: number;
  conversationId?: string | null;
  renderPart: RenderPart;
  renderColumnHeader?: RenderColumnHeader;
};

/**
 * Renders parallel content columns for a single groupId.
 */
export const ParallelColumns: NamedExoticComponent<ParallelColumnsProps> = memo(
  function ParallelColumns({
    columns,
    groupId,
    messageId,
    createdAt,
    conversationId,
    isSubmitting,
    lastContentIdx,
    renderPart,
    renderColumnHeader,
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
              data-fold-column=""
              className="border-border-light min-w-0 flex-1 rounded-lg border p-3"
            >
              {renderColumnHeader?.({
                agentId,
                messageId,
                createdAt,
                isSubmitting,
                conversationId,
              })}
              {showLoadingCursor ? (
                <Container>
                  <EmptyText />
                </Container>
              ) : (
                columnParts.map(({ part, idx }, index) => {
                  const isLastInColumn = idx === lastColumnCursorIdx;
                  const isLastContent = idx === lastContentIdx;
                  return renderPart(
                    part,
                    idx,
                    isLastInColumn && isLastContent,
                    columnParts[index + 1]?.part.type ?? null,
                  );
                })
              )}
            </div>
          );
        })}
      </div>
    );
  },
);

export type ParallelContentRendererProps = {
  content?: Array<TMessageContentParts | undefined>;
  messageId: string;
  createdAt?: string | null;
  conversationId?: string | null;
  attachments?: TAttachment[];
  searchResults?: { [key: string]: SearchResultData };
  isSubmitting: boolean;
  renderPart: RenderPart;
  renderColumnHeader?: RenderColumnHeader;
  /**
   * Author re-attribution for a part that resumes after an inline steer —
   * returns the header node to render before that part, or null. Only the
   * sequential before/after stretches consult it: column content already
   * carries per-agent identity.
   */
  renderResumeAttribution?: (idx: number, keyIdx?: number) => ReactNode;
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
export const ParallelContentRenderer: NamedExoticComponent<ParallelContentRendererProps> = memo(
  function ParallelContentRenderer({
    content,
    messageId,
    createdAt,
    conversationId,
    attachments,
    searchResults,
    isSubmitting,
    renderPart,
    renderColumnHeader,
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
        const leading: PartWithIndex[] = [];
        while (cursor < sequentialParts.length && sequentialParts[cursor].idx < section.start) {
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
              renderColumnHeader={renderColumnHeader}
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
  },
);
