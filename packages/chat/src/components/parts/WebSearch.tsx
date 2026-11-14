import { useContext, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Tools } from 'librechat-data-provider';
import { ChevronDown, Globe, Info } from 'lucide-react';
import {
  Button,
  HoverCard,
  HoverCardContent,
  HoverCardPortal,
  HoverCardTrigger,
  Shimmer,
  disclosureChevronVariants,
  useLocalize,
} from '@librechat/client';
import type {
  AnswerBoxResult,
  PartMetadata,
  SearchResultData,
  TAttachment,
  ValidSource,
} from 'librechat-data-provider';
import type { ReactNode } from 'react';
import {
  GeneratedToolLabelContext,
  toolPanelSpacingClassName,
  useToolContentRequest,
  useToolExpansion,
} from '../../react/parts/disclosure';
import { collectSources, getCleanDomain, getUniqueDomainSources } from './sources';
import useLazyCollapseBody from '../../react/parts/useLazyCollapseBody';
import { parseJsonField } from '../../core/parts/parseJsonField';
import { useToolCallIntent } from '../../react/parts/intent';
import useRowHandoff from '../../react/parts/handoff';
import useExpandCollapse from './useExpandCollapse';
import { useToolPreparation } from './preparation';
import { isError } from '../../core/parts/output';
import { ROW_GLYPH_SLOT } from './rows';
import { classes } from './classes';

/** What the app's tool card renders when a search fails. */
export type WebSearchFailedCall = {
  name: string;
  args: string | Record<string, unknown>;
  output?: string | null;
  initialProgress: number;
  isSubmitting: boolean;
  isLast?: boolean;
  runStepStatus?: PartMetadata['runStepStatus'];
  attachments?: TAttachment[];
  hideAttachments?: boolean;
  onExpand?: () => void;
};

export type WebSearchFaviconProps = {
  domain: string;
  className?: string;
};

export type WebSearchStackProps = {
  sources: ValidSource[];
  start?: number;
};

type ProgressKeys =
  | 'com_ui_web_searching'
  | 'com_ui_web_searching_again'
  | 'com_ui_web_search_processing'
  | 'com_ui_web_search_reading';

const MAX_VISIBLE_FAVICONS = 3;

function SourceFaviconStack({
  sources,
  renderFavicon,
}: {
  sources: ValidSource[];
  renderFavicon: (props: WebSearchFaviconProps) => ReactNode;
}) {
  const visible = getUniqueDomainSources(sources, MAX_VISIBLE_FAVICONS);
  return (
    <div className="flex items-center" aria-hidden="true">
      {visible.map((source, i) => (
        <div
          key={source.link}
          className={classes(
            'border-border-medium bg-surface-secondary relative flex items-center justify-center rounded-full border',
            'h-[1.375rem] w-[1.375rem]',
            i > 0 && '-ms-2.5',
          )}
          style={{ zIndex: MAX_VISIBLE_FAVICONS - i }}
        >
          {renderFavicon({ domain: getCleanDomain(source.link), className: 'size-3 rounded-full' })}
        </div>
      ))}
    </div>
  );
}

export default function WebSearch({
  initialProgress: progress = 0.1,
  isSubmitting,
  isLast,
  args,
  output,
  attachments,
  hideAttachments = false,
  onExpand,
  runStepStatus,
  searchResults,
  headerSlot = null,
  renderFavicon,
  renderStackedFavicons,
  renderVerticals,
  renderFailedCall,
}: {
  isLast?: boolean;
  isSubmitting: boolean;
  args?: string | Record<string, unknown>;
  output?: string | null;
  initialProgress: number;
  attachments?: TAttachment[];
  hideAttachments?: boolean;
  onExpand?: () => void;
  runStepStatus?: PartMetadata['runStepStatus'];
  /** Streaming results for this message, used until attachments carry the turn. */
  searchResults?: { [key: string]: SearchResultData };
  /** The fold header's action slot, when a generated title replaced this row. */
  headerSlot?: HTMLElement | null;
  /** One site's icon. Absent, a finished row with sources keeps the globe. */
  renderFavicon?: (props: WebSearchFaviconProps) => ReactNode;
  /** Overlapping icons while results are still arriving. */
  renderStackedFavicons?: (props: WebSearchStackProps) => ReactNode;
  /** Image, shopping and place strips under a finished search. */
  renderVerticals?: (attachments?: TAttachment[]) => ReactNode;
  /** The app's tool card for a failed search. Absent, a failure renders nothing. */
  renderFailedCall?: (props: WebSearchFailedCall) => ReactNode;
}): ReactNode {
  const localize = useLocalize();
  /** Model-authored live label (web_search carries `intent` natively);
   *  persists as the settled label like the other tool cards. */
  const intent = useToolCallIntent(args);
  const preparationText = useToolPreparation();
  const error = (typeof output === 'string' && isError(output)) || runStepStatus === 'failed';
  const legacyError =
    !error && typeof output === 'string' && output.toLowerCase().includes('error processing');
  const isClosed = runStepStatus != null;

  // Server tool calls (srvtoolu_) never receive ON_RUN_STEP_COMPLETED, so progress
  // stays at the default 0.1. Treat the search as complete if attachments have results.
  const hasResults = useMemo(
    () =>
      attachments?.some((att) => att.type === Tools.web_search && att[Tools.web_search]) ?? false,
    [attachments],
  );
  const effectiveProgress = isClosed || (hasResults && !isSubmitting) ? 1 : progress;
  /** Older search errors with only the loose "error processing" text were
   * hidden, not counted as failures. Preserve that legacy behavior rather
   * than labeling them completed; recognized failures get a real disclosure
   * below so the group pill can reach their error. */
  const cancelled = isClosed
    ? runStepStatus === 'cancelled' || legacyError
    : (!isSubmitting && effectiveProgress < 1) || legacyError;

  const finalizing = !isClosed && isSubmitting && isLast && effectiveProgress === 1;
  /** A search that is the message's FINAL part stays "finalizing" only while
   *  the submission is live. Afterwards it must settle like any other call,
   *  or the completed label (and its settled intent announcement) never
   *  renders and the card shimmers forever. A closed step settles immediately
   *  on its own status instead of waiting for the submission to end. */
  const complete = isClosed
    ? !cancelled
    : effectiveProgress === 1 && !finalizing && (!isLast || !isSubmitting);

  const ownTurn = useMemo((): string => {
    if (!attachments) {
      return '0';
    }
    for (const att of attachments) {
      if (att.type === Tools.web_search && att[Tools.web_search]) {
        const turn = att[Tools.web_search].turn;
        return typeof turn === 'number' ? String(turn) : '0';
      }
    }
    return '0';
  }, [attachments]);

  const allSources = useMemo((): ValidSource[] => {
    if (attachments != null) {
      const turnMap: Record<string, SearchResultData> = {};
      for (const att of attachments) {
        if (att.type === Tools.web_search && att[Tools.web_search]) {
          const data = att[Tools.web_search];
          const key = typeof data.turn === 'number' ? String(data.turn) : '0';
          turnMap[key] = data;
        }
      }
      return collectSources(turnMap);
    }
    const turnResults = searchResults?.[ownTurn];
    if (turnResults) {
      return collectSources({ [ownTurn]: turnResults });
    }
    return [];
  }, [searchResults, attachments, ownTurn]);

  /** Direct-answer card shown at the top of the source list. Attachment-only:
   *  answer boxes are provider extras (Serper) that never carry citations, so
   *  the streaming path does not need them. */
  const answerBox = useMemo((): AnswerBoxResult | undefined => {
    if (!attachments) {
      return undefined;
    }
    for (const att of attachments) {
      const answer = att.type === Tools.web_search ? att[Tools.web_search]?.answerBox : undefined;
      if (answer) {
        return answer;
      }
    }
    return undefined;
  }, [attachments]);
  /** `snippet` and `snippetHighlighted` are independently optional, and
   *  `hasDetails` opens the card for ANY answer box, so a provider result
   *  carrying only highlights rendered a heading with an empty body. */
  const answerText = useMemo(
    () => answerBox?.snippet || answerBox?.snippetHighlighted?.join(' ') || undefined,
    [answerBox],
  );

  // Show favicons from the raw SERP results immediately rather than waiting for
  // each source to flip to `processed`; the agents scrape barrier would otherwise
  // freeze the stack on "Searching the web" for the slowest scrape's duration.
  const streamingSources = useMemo(() => {
    if (complete && !finalizing) {
      return [];
    }
    return allSources;
  }, [allSources, complete, finalizing]);

  const showSources = streamingSources.length > 0;
  /** Stable phase text: the live region must not re-announce the growing
   *  intent on every delta, so it always gets this value while streaming;
   *  the settled intent is announced once via the completed branch. */
  const genericProgressText = useMemo(() => {
    if (preparationText != null) {
      return preparationText;
    }
    let text: ProgressKeys =
      ownTurn !== '0' ? 'com_ui_web_searching_again' : 'com_ui_web_searching';
    if (showSources) {
      text = 'com_ui_web_search_processing';
    }
    if (finalizing) {
      text = 'com_ui_web_search_reading';
    }
    return localize(text);
  }, [ownTurn, localize, showSources, finalizing, preparationText]);
  const progressText = preparationText ?? intent ?? genericProgressText;

  const generatedLabel = useContext(GeneratedToolLabelContext);
  const bare = generatedLabel && complete && !error && !cancelled && allSources.length > 0;
  const rowRef = useRowHandoff(bare);
  const sourceCount = allSources.length;
  const [showDetails, setShowDetails] = useState(false);
  useToolContentRequest(showDetails);
  const [expandedSources, setShowSourceList] = useToolExpansion(sourceCount > 0);
  const showSourceList = bare || expandedSources;
  useToolContentRequest(bare);
  const { ref: sourceExpandRef } = useExpandCollapse(showSourceList);
  const { shouldRenderBody, mountBody, handleTransitionEnd } = useLazyCollapseBody(showSourceList);

  const handleToggleSources = () => {
    mountBody();
    setShowSourceList(!showSourceList);
    if (!showSourceList) {
      onExpand?.();
    }
  };

  if (error && runStepStatus !== 'cancelled') {
    return (
      renderFailedCall?.({
        name: Tools.web_search,
        args: args ?? '',
        output,
        initialProgress: progress,
        isSubmitting,
        isLast,
        runStepStatus,
        attachments,
        hideAttachments,
        onExpand,
      }) ?? null
    );
  }

  if (cancelled) {
    return null;
  }

  if (complete) {
    const hasSourceData = sourceCount > 0;
    const completedText = intent ?? localize('com_ui_web_searched');
    const query = parseJsonField(args, 'query');
    const hasDetails = !!query || !!answerBox;

    /** A generated title replaced the row, so its action moves to the title line. */
    const inHeader = bare && headerSlot != null;
    const details = (
      <div
        className={classes(
          'ms-auto',
          /** On the title line it sits beside the always-visible chevron. */
          !inHeader &&
            'opacity-0 group-focus-within/websearch:opacity-100 group-hover/websearch:opacity-100',
        )}
      >
        <HoverCard openDelay={50} open={showDetails} onOpenChange={setShowDetails}>
          {/* Composed through `asChild` so the shared Button owns the
            rounding, hover fill, focus ring and motion (and gives a real
            <button> instead of Radix's default anchor). The reveal lives on
            the wrapper so the button itself stays a quiet icon control. */}
          <HoverCardTrigger asChild>
            <Button
              variant="quiet"
              size="icon-inline"
              className="cursor-help"
              onFocus={() => setShowDetails(true)}
              onBlur={() => setShowDetails(false)}
              aria-label={localize('com_ui_web_search_details')}
            >
              <Info className="size-3.5" aria-hidden="true" />
            </Button>
          </HoverCardTrigger>
          <HoverCardPortal>
            <HoverCardContent side="top" className="z-[999] w-80">
              <div className="max-h-[60vh] space-y-2 overflow-y-auto">
                {query && (
                  <div>
                    <div className="text-text-secondary text-3xs font-medium tracking-wide uppercase">
                      {localize('com_ui_search_query')}
                    </div>
                    <div className="text-text-primary mt-0.5 text-sm">{query}</div>
                  </div>
                )}
                <div className="text-text-secondary text-xs">
                  {localize(
                    sourceCount === 1 ? 'com_ui_web_search_source' : 'com_ui_web_search_sources',
                    { count: sourceCount },
                  )}
                </div>
                {answerBox && (answerBox.title || answerText) && (
                  <div className="border-border-inset border-t pt-2">
                    {answerBox.title && (
                      <div className="text-text-primary text-sm font-medium">{answerBox.title}</div>
                    )}
                    {answerText && (
                      <div className="text-text-secondary mt-1 text-xs leading-relaxed">
                        {answerText}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </HoverCardContent>
          </HoverCardPortal>
        </HoverCard>
      </div>
    );

    return (
      <div className={classes('group/websearch', bare && 'my-1.5')}>
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {completedText}
        </span>
        <div className={classes('relative flex items-center gap-1.5', bare ? 'h-0' : 'my-1.5 h-5')}>
          {!bare && (
            <Button
              ref={rowRef}
              variant="disclosure-search"
              className="group/disclosure min-w-0"
              disabled={!hasSourceData}
              onClick={hasSourceData ? handleToggleSources : undefined}
              aria-expanded={hasSourceData ? showSourceList : undefined}
              aria-label={
                hasSourceData
                  ? `${completedText} - ${localize(sourceCount === 1 ? 'com_ui_web_search_source' : 'com_ui_web_search_sources', { count: sourceCount })}`
                  : completedText
              }
            >
              <span className={ROW_GLYPH_SLOT} aria-hidden="true">
                {hasSourceData && renderFavicon != null ? (
                  <SourceFaviconStack sources={allSources} renderFavicon={renderFavicon} />
                ) : (
                  <Globe className="text-text-secondary size-4 shrink-0" />
                )}
              </span>
              <span className="min-w-0 truncate font-medium">{completedText}</span>
              {hasSourceData && (
                <ChevronDown
                  className={classes(
                    disclosureChevronVariants({ expanded: showSourceList }),
                    'ms-auto size-3.5',
                  )}
                  aria-hidden="true"
                />
              )}
            </Button>
          )}
          {hasDetails && !bare && details}
          {hasDetails && inHeader && headerSlot && createPortal(details, headerSlot)}
        </div>
        {hasSourceData && (
          <div
            className="part-expand"
            data-expanded={showSourceList ? 'true' : 'false'}
            onTransitionEnd={handleTransitionEnd}
          >
            <div className="min-h-0 overflow-hidden" ref={sourceExpandRef}>
              {shouldRenderBody && (
                <div
                  className={classes(
                    toolPanelSpacingClassName,
                    'border-border-light mt-1.5 max-h-[17.5rem] overflow-y-auto rounded-lg border',
                  )}
                >
                  {allSources.map((source, i) => {
                    const domain = getCleanDomain(source.link);
                    const snippet = 'snippet' in source ? source.snippet : undefined;
                    return (
                      <a
                        key={source.link}
                        href={source.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={classes(
                          'hover:bg-surface-hover flex gap-2.5 px-3 py-2 transition-colors',
                          snippet ? 'items-start' : 'items-center',
                          i > 0 && 'border-border-light border-t',
                        )}
                      >
                        {renderFavicon != null ? (
                          renderFavicon({
                            domain,
                            className: classes('size-4 shrink-0 rounded-sm', snippet && 'mt-0.5'),
                          })
                        ) : (
                          <Globe
                            className={classes(
                              'text-text-secondary size-4 shrink-0',
                              snippet && 'mt-0.5',
                            )}
                            aria-hidden="true"
                          />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="text-text-primary block truncate text-xs font-medium">
                            {source.title || domain}
                          </span>
                          {snippet && (
                            <span className="text-text-secondary text-2xs mt-0.5 line-clamp-2 block leading-relaxed">
                              {snippet}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-end">
                          <span className="text-text-secondary text-2xs block">{domain}</span>
                          {source.date && (
                            <span className="text-text-secondary text-3xs block">
                              {source.date}
                            </span>
                          )}
                        </span>
                      </a>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
        {!hideAttachments && renderVerticals?.(attachments)}
      </div>
    );
  }

  return (
    <div className="text-text-secondary relative my-1.5 flex h-5 shrink-0 items-center gap-2">
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {genericProgressText}
      </span>
      <span className={ROW_GLYPH_SLOT} aria-hidden="true">
        {showSources && renderStackedFavicons?.({ sources: streamingSources, start: -5 })}
        <Globe className="text-text-secondary size-4 shrink-0" />
      </span>
      <Shimmer className="tool-status-text min-w-0 truncate font-medium">{progressText}</Shimmer>
    </div>
  );
}
