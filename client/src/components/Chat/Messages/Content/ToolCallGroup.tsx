import { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { useRecoilValue } from 'recoil';
import { Button } from '@librechat/client';
import { ChevronDown, MessageCircleQuestion, Users } from 'lucide-react';
import { Tools, Constants, ContentTypes } from 'librechat-data-provider';
import type { TAttachment, TMessageContentParts } from 'librechat-data-provider';
import type { PartWithIndex } from './ParallelContent';
import type { ToolMeta } from './outcome';
import {
  cn,
  getToolDisplayLabel,
  getPartKeyIndex,
  hasPendingAuthInPart,
  hasPendingApprovalInPart,
  getBatchActivityLabelPart,
  getActivityLabelText,
} from '~/utils';
import {
  FailedRevealContext,
  FailedRevealPill,
  useFailedReveal,
  useFailedRevealTrigger,
} from './reveal';
import { useLocalize, useExpandCollapse, scheduleMessageContentLayoutReconcile } from '~/hooks';
import { ASK_USER_QUESTION, getSubmittedAskAnswer } from '~/utils/approval';
import { ToolAuthWarning, ToolAuthWarningContext } from './auth';
import { useMCPIconMap, useMCPServerNames } from '~/hooks/MCP';
import { AttachmentGroup, ReasoningCompact } from './Parts';
import { getOutcomeStatus, summarizeSpan } from './outcome';
import { FOLD_RAIL_CLASSES, ROW_GLYPH_SLOT } from './rows';
import { StackedToolIcons } from './ToolOutput';
import { mapAttachments } from '~/utils/map';
import { getSourceDomains } from './sources';
import SearchVerticals from './verticals';
import store from '~/store';

interface ToolCallGroupProps {
  parts: PartWithIndex[];
  isSubmitting: boolean;
  isLast: boolean;
  showThinking: boolean;
  renderPart: (
    part: TMessageContentParts,
    idx: number,
    isLastPart: boolean,
    onToolExpand?: () => void,
  ) => React.ReactNode;
  lastContentIdx: number;
  groupAttachments?: TAttachment[];
  /** The group's owned attachments for header glyphs AND outcomes, even when
   *  a parent phase hoists the files and `groupAttachments` is withheld. */
  sourceAttachments?: TAttachment[];
  initialExpansionState?: ToolCallGroupExpansionState;
  onExpansionChange?: (state: ToolCallGroupExpansionState) => void;
  /** Activity-label part terminating this block; when it carries generated
   *  text the header shows that text instead of the default tool summary. */
  labelPart?: PartWithIndex;
  /** True inside a completed phase card. The phase summary already speaks for
   *  this activity, so the group defaults collapsed and never auto-expands —
   *  a remount into the folding card must not toggle open and shut again
   *  while the parent entrance is playing. A pending approval overrides the
   *  suppression: a phase can resolve while an approval inside it still
   *  blocks the run, and hiding that card behind a second collapsed
   *  disclosure would bury the action the run is waiting on. */
  withinActivityPhase?: boolean;
}

export type ToolCallGroupExpansionState = {
  isExpanded: boolean;
  userOverride: boolean;
};

export default function ToolCallGroup({
  parts,
  isSubmitting,
  isLast,
  showThinking,
  renderPart,
  lastContentIdx,
  groupAttachments,
  sourceAttachments,
  initialExpansionState,
  onExpansionChange,
  labelPart,
  withinActivityPhase = false,
}: ToolCallGroupProps) {
  const localize = useLocalize();
  const mcpIconMap = useMCPIconMap();
  const mcpServerNames = useMCPServerNames();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cancelLayoutReconcileRef = useRef<(() => void) | null>(null);
  const retainedForPendingApprovalRef = useRef(false);

  /** Re-keyed by tool-call id so each part's metadata sees only its own
   *  attachments: `groupAttachments` arrives flattened across the group. */
  const attachmentsByToolCallId = useMemo(
    () => mapAttachments(sourceAttachments ?? groupAttachments ?? []),
    [sourceAttachments, groupAttachments],
  );
  /** `parts` may include interleaved reasoning ("Thoughts") parts that render
   *  inside the body but are not actions. Count and summarize only the real
   *  tool calls so the header and stacked icons stay accurate. */
  const toolMetadata = useMemo(() => {
    const summary = summarizeSpan(
      parts.map(({ part }) => part),
      attachmentsByToolCallId,
    );
    return parts.map(({ part }) => summary.metaOf(part)).filter((m): m is ToolMeta => m != null);
  }, [parts, attachmentsByToolCallId]);
  const count = toolMetadata.length;
  /** Approval state is read from the RAW parts, not `toolMetadata`: a pending
   *  call can be nested inside a subagent's content, which never surfaces as
   *  a tool entry here. */
  const hasPendingApproval = useMemo(
    () => parts.some(({ part }) => hasPendingApprovalInPart(part)),
    [parts],
  );
  const activityLabel = getBatchActivityLabelPart(labelPart?.part);
  const activityLabelText = getActivityLabelText(activityLabel);
  const activityFailed = activityLabel?.status === 'failed' || activityLabel?.status === 'partial';
  /** A settled, filled label is itself a completion proof: the PostToolBatch
   *  claim only happens after every output in the batch returned. Without
   *  it, a tool that legitimately returns an empty string reads as
   *  `hasOutput: false` forever and its labeled group never auto-collapses. */
  const labelSettled =
    activityLabelText.length > 0 &&
    (labelPart?.part as { pending?: boolean } | undefined)?.pending !== true;
  const allCompleted = useMemo(
    () => labelSettled || toolMetadata.every((m) => m.hasOutput === true),
    [toolMetadata, labelSettled],
  );
  const sourceDomains = useMemo(
    () => getSourceDomains(sourceAttachments ?? groupAttachments, 3),
    [sourceAttachments, groupAttachments],
  );
  const iconToolNames = useMemo(() => toolMetadata.map((m) => m.iconName), [toolMetadata]);

  /** Turn raw tool ids into an activity summary. Repeated calls retain their
   *  count (`Web Search ×3`) instead of disappearing behind de-duplication,
   *  while the primary label can use an outcome verb such as "Searched". */
  const activitySummary = useMemo(() => {
    const labelCounts = new Map<string, number>();
    let webSearchCount = 0;
    let fileSearchCount = 0;
    let subagentCount = 0;
    let askQuestionCount = 0;
    let failedCount = 0;
    let cancelledCount = 0;

    for (const tool of toolMetadata) {
      if (tool.name === Tools.web_search) {
        webSearchCount++;
      } else if (tool.name === 'file_search' || tool.name === 'retrieval') {
        fileSearchCount++;
      } else if (tool.name === Constants.SUBAGENT) {
        subagentCount++;
      } else if (tool.name === ASK_USER_QUESTION) {
        askQuestionCount++;
      }
      if (tool.failed) {
        failedCount++;
      }
      if (tool.cancelled) {
        cancelledCount++;
      }
      if (!tool.name) {
        continue;
      }
      const label = getToolDisplayLabel(tool.name, localize, mcpServerNames);
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }

    const labels = Array.from(labelCounts, ([label, labelCount]) =>
      labelCount > 1 ? `${label} ×${labelCount}` : label,
    );
    const toolNameSummary =
      labels.length <= 3
        ? labels.join(', ')
        : `${labels.slice(0, 3).join(', ')}, +${labels.length - 3}`;

    return {
      webSearchCount,
      fileSearchCount,
      subagentCount,
      askQuestionCount,
      failedCount,
      cancelledCount,
      toolNameSummary,
    };
  }, [toolMetadata, localize, mcpServerNames]);

  /** Reasoning interleaved with the tool calls renders inside the body but is
   *  hidden while collapsed. Note it in the header's accessible label so screen
   *  readers know the group also contains thoughts. */
  const hasReasoning = useMemo(
    () => parts.some((p) => p.part.type === ContentTypes.THINK),
    [parts],
  );

  /** Subagent tool calls get their own label verb ("Running/Ran N agents")
   *  since "Used N tools" reads oddly when the "tools" are actually child
   *  agents. `subagentCount === count` ⇒ the group is 100% subagents. */
  const allSubagents = activitySummary.subagentCount > 0 && activitySummary.subagentCount === count;
  /** Past-tense label once the parent stream is no longer live OR every
   *  child has a terminal signal (output / progress === 1). Without the
   *  `!isSubmitting` branch, a cancelled or errored subagent that never
   *  reached `progress === 1` would leave the header stuck on "Running
   *  N agents" forever — each individual card already renders its own
   *  terminal state ("Cancelled agent", "Agent errored"), so the group
   *  summary needs to match that tense. */
  const subagentsDone = allSubagents && (allCompleted || !isSubmitting);

  /** `ask_user_question` calls form their own category, mirroring subagents:
   *  a homogeneous group reads "Asking/Asked N questions" (never "Used N
   *  tools: ask_user_question") with a question glyph. */
  const allAskQuestions =
    activitySummary.askQuestionCount > 0 && activitySummary.askQuestionCount === count;
  /**
   * An answered question is the group's completion proof. The `tool_call`
   * part carries no output until the turn finalizes, so `allCompleted` stays
   * false and the header read "Asking 1 question" for the rest of the turn,
   * long after the user answered. Position cannot settle it either: a LIVE
   * pause appends its interactive card after this group, so the group is not
   * the message's last part precisely while the question is open.
   *
   * The locally-recorded answer is the same fallback the durable record card
   * uses — the streaming handler's message copy can overwrite the optimistic
   * output stamp mid-stream, and only this survives it.
   */
  const askQuestionsAnswered = useMemo(
    () =>
      parts.every(({ part }) => {
        if (part.type !== ContentTypes.TOOL_CALL) {
          return true;
        }
        const toolCall = part[ContentTypes.TOOL_CALL] as
          | { name?: string; id?: string; output?: string | null }
          | undefined;
        if (toolCall?.name !== ASK_USER_QUESTION) {
          return true;
        }
        return (
          (toolCall.output?.length ?? 0) > 0 || getSubmittedAskAnswer(toolCall.id) !== undefined
        );
      }),
    [parts],
  );
  /** Past tense once the turn is settled — matches the Asking/Asked record
   *  card. While a multi-question turn streams, the still-open question's
   *  tool_call part has no output yet, so keep the present tense. */
  const groupDone = allCompleted || !isSubmitting;
  const askQuestionsDone = allAskQuestions && (groupDone || askQuestionsAnswered);

  /** One verdict for the header's tense, its glyph and its icon animation —
   *  they read as a single control, so a group whose label already says
   *  "Asked 1 question" must not keep pulsing beside it. */
  const isGroupLive = allAskQuestions ? !askQuestionsDone : !groupDone;

  /** For a single-tool group, lead with the tool's own (capitalized) label
   *  instead of the generic "Used 1 tool: name", which reads awkwardly. */
  const singleToolLabel = useMemo(() => {
    const raw = getToolDisplayLabel(toolMetadata[0]?.name ?? '', localize, mcpServerNames);
    return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : '';
  }, [toolMetadata, localize, mcpServerNames]);

  const autoExpand = useRecoilValue(store.autoExpandTools);
  /** A labeled activity block is summarized by its header, so it collapses
   *  even at a single tool call — agent runs are full of one-call batches,
   *  and leaving those expanded defeats the grouping. */
  /** Every group has >= 1 tool; collapse a completed one by default just like
   *  a multi-tool group, so a lone tool-with-thinking group (a skill, say)
   *  stays visually consistent with the larger groups around it. */
  /** A folded-in THINK part only renders inside this body, so auto-collapsing
   *  a completed reasoning-bearing group leaves "Open Thinking Dropdowns by
   *  Default" with no visible effect until the user opens the action group by
   *  hand (on reload the body is not even mounted). */
  const autoCollapse =
    !autoExpand &&
    !(showThinking && hasReasoning) &&
    allCompleted &&
    (count >= 1 || activityLabelText.length > 0);
  const suppressAutoExpand = withinActivityPhase && !hasPendingApproval;
  const initialState = initialExpansionState?.userOverride === true ? initialExpansionState : null;
  const [isExpanded, setIsExpanded] = useState(
    initialState?.isExpanded ?? (autoExpand || (!autoCollapse && !suppressAutoExpand)),
  );
  const [userOverride, setUserOverride] = useState(initialState != null);
  const [shouldRenderBody, setShouldRenderBody] = useState(isExpanded);
  const previousIsExpandedRef = useRef(isExpanded);
  const { style: expandStyle, ref: expandRef } = useExpandCollapse(isExpanded);
  const notifyLayoutChange = useCallback(() => {
    cancelLayoutReconcileRef.current?.();
    cancelLayoutReconcileRef.current = scheduleMessageContentLayoutReconcile(rootRef.current);
  }, []);

  useEffect(
    () => () => {
      cancelLayoutReconcileRef.current?.();
    },
    [],
  );

  useEffect(() => {
    const wasExpanded = previousIsExpandedRef.current;
    previousIsExpandedRef.current = isExpanded;
    if (wasExpanded && !isExpanded) {
      notifyLayoutChange();
    }
  }, [isExpanded, notifyLayoutChange]);

  useEffect(() => {
    if (autoCollapse && !userOverride) {
      setIsExpanded(false);
    }
  }, [autoCollapse, userOverride]);

  const handleToggle = useCallback(() => {
    const nextExpanded = !isExpanded;
    setUserOverride(true);
    if (nextExpanded) {
      setShouldRenderBody(true);
    }
    setIsExpanded(nextExpanded);
    onExpansionChange?.({ isExpanded: nextExpanded, userOverride: true });
  }, [isExpanded, onExpansionChange]);

  const handleToolExpand = useCallback(() => {
    setUserOverride(true);
    setShouldRenderBody(true);
    setIsExpanded(true);
    onExpansionChange?.({ isExpanded: true, userOverride: true });
  }, [onExpansionChange]);

  /** The group relays a request for its failures: from the pill beside its
   *  own header when it stands alone, or from a phase above. Either way it
   *  opens, then issues the request to its rows once they are mounted — a
   *  request passed straight through would reach rows that do not exist yet. */
  const { value: revealValue, requestReveal } = useFailedRevealTrigger(
    isExpanded && shouldRenderBody,
  );
  const handleRevealFailed = useCallback(() => {
    handleToolExpand();
    requestReveal();
  }, [handleToolExpand, requestReveal]);
  useFailedReveal(activitySummary.failedCount > 0, handleRevealFailed);

  const handleTransitionEnd = useCallback(
    (event: React.TransitionEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) {
        return;
      }
      if (isExpanded) {
        return;
      }
      if (hasPendingApproval) {
        // Approval controls own unsent local form state. Keep unresolved cards
        // mounted (the collapsed panel is inert/hidden) so collapsing a batch
        // cannot erase decisions the reviewer already made.
        retainedForPendingApprovalRef.current = true;
        return;
      }
      retainedForPendingApprovalRef.current = false;
      setShouldRenderBody(false);
      notifyLayoutChange();
    },
    [hasPendingApproval, isExpanded, notifyLayoutChange],
  );

  useEffect(() => {
    if (isExpanded) {
      retainedForPendingApprovalRef.current = false;
      return;
    }
    if (!hasPendingApproval && retainedForPendingApprovalRef.current) {
      // A completed collapse transition retained this body only to preserve
      // approval form state. Release it once the last approval resolves.
      retainedForPendingApprovalRef.current = false;
      setShouldRenderBody(false);
      notifyLayoutChange();
    }
  }, [hasPendingApproval, isExpanded, notifyLayoutChange]);

  const searchCount = activitySummary.webSearchCount + activitySummary.fileSearchCount;
  const searchesOnly = count > 0 && searchCount === count;

  /** Outcome-first header verb. Homogeneous searches, subagents, and questions
   *  read as the activity the assistant performed. Mixed implementation-level
   *  tool calls fall back to the user-facing concept of "actions". */
  const resolveGroupLabel = (): string => {
    if (allSubagents) {
      if (count === 1) {
        return localize(subagentsDone ? 'com_ui_subagent_complete' : 'com_ui_subagent_running');
      }
      return subagentsDone
        ? localize('com_ui_ran_n_agents', { 0: String(count) })
        : localize('com_ui_running_n_agents', { 0: String(count) });
    }
    if (allAskQuestions) {
      if (count === 1) {
        return localize(
          askQuestionsDone ? 'com_ui_asked_one_question' : 'com_ui_asking_one_question',
        );
      }
      return askQuestionsDone
        ? localize('com_ui_asked_n_questions', { 0: String(count) })
        : localize('com_ui_asking_n_questions', { 0: String(count) });
    }
    if (activitySummary.webSearchCount === count) {
      return localize(groupDone ? 'com_ui_web_searched' : 'com_ui_web_searching');
    }
    if (activitySummary.fileSearchCount === count) {
      return localize(groupDone ? 'com_ui_retrieved_files' : 'com_ui_searching_files');
    }
    if (searchesOnly) {
      return localize(
        groupDone ? 'com_ui_searched_web_and_files' : 'com_ui_searching_web_and_files',
      );
    }
    if (count === 1) {
      return singleToolLabel || localize('com_ui_used_one_tool');
    }
    return localize(groupDone ? 'com_ui_ran_n_actions' : 'com_ui_running_n_actions', {
      0: String(count),
    });
  };
  /** The generated line wins over the generic category verb — but only once
   *  it exists. An unfilled label part leaves the block rendering exactly as
   *  it would without the feature. */
  const groupLabel = activityLabelText.length > 0 ? activityLabelText : resolveGroupLabel();
  const groupDetailParts: string[] = [];
  if (searchesOnly && count > 1) {
    groupDetailParts.push(localize('com_ui_n_searches', { 0: String(count) }));
  } else if (!allSubagents && !allAskQuestions && count > 1) {
    groupDetailParts.push(activitySummary.toolNameSummary);
  }
  const failedNote =
    activitySummary.failedCount > 0
      ? localize(
          activitySummary.failedCount === 1
            ? 'com_ui_one_action_failed'
            : 'com_ui_n_actions_failed',
          { 0: String(activitySummary.failedCount) },
        )
      : '';
  if (failedNote !== '') {
    groupDetailParts.push(failedNote);
  }
  /** A stopped action is settled but not successful, and its only other notice
   *  lives inside the panel the group is about to collapse, so the header has
   *  to say so. */
  if (activitySummary.cancelledCount > 0) {
    groupDetailParts.push(
      localize(
        activitySummary.cancelledCount === 1
          ? 'com_ui_one_action_cancelled'
          : 'com_ui_n_actions_cancelled',
        { 0: String(activitySummary.cancelledCount) },
      ),
    );
  }
  const groupDetail = groupDetailParts.filter(Boolean).join(' · ');
  const groupAriaLabel = [groupLabel, groupDetail, hasReasoning ? localize('com_ui_thoughts') : '']
    .filter(Boolean)
    .join(', ');
  /** Standing alone, the group shows its failure count on the pill beside
   *  the header, which is also the way to the failed rows; the text keeps it
   *  only for the accessible name. Inside a phase the pill is the phase's,
   *  so the group's detail says it in text. */
  const showsFailurePill = !withinActivityPhase && activitySummary.failedCount > 0;
  const visibleGroupDetail = showsFailurePill
    ? groupDetailParts.filter((part) => part && part !== failedNote).join(' · ')
    : groupDetail;
  /** Single category glyph for homogeneous groups (else StackedToolIcons). */
  const CategoryIcon = allSubagents ? Users : MessageCircleQuestion;
  const iconStatus = getOutcomeStatus({
    failed: activityFailed ? 1 : activitySummary.failedCount,
    cancelled: activitySummary.cancelledCount,
  });

  const hasActiveToolCall = useMemo(
    () => isSubmitting && toolMetadata.some((m) => m && !m.hasOutput),
    [toolMetadata, isSubmitting],
  );
  const hasPendingAuthRequest = useMemo(
    () => parts.some(({ part }) => hasPendingAuthInPart(part)),
    [parts],
  );

  useEffect(() => {
    if (hasActiveToolCall && !userOverride && !suppressAutoExpand) {
      setShouldRenderBody(true);
      setIsExpanded(true);
    }
  }, [hasActiveToolCall, userOverride, suppressAutoExpand]);

  return (
    <div className="mb-2 mt-1" ref={rootRef}>
      <div className="flex w-full items-center gap-2">
        <Button
          variant="ghost"
          type="button"
          className={cn(
            'inline-flex h-auto min-w-0 flex-1 items-center justify-start gap-2 rounded-none bg-transparent p-0 py-1 text-text-secondary hover:bg-transparent hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy focus-visible:ring-offset-0',
            /** An open header is the title of the rows under it, so it is the
             *  one line in the fold set in the primary colour. */
            isExpanded && 'text-text-primary hover:text-text-primary',
          )}
          onClick={handleToggle}
          aria-expanded={isExpanded}
          aria-label={groupAriaLabel}
        >
          {iconStatus == null && (allSubagents || allAskQuestions) ? (
            /** Homogeneous category groups get a single category glyph instead
             *  of StackedToolIcons' generic wrenches: a Users glyph for
             *  subagents, a question glyph for ask_user_question — matching
             *  their individual card headers and reading as the category
             *  rather than "tools". */
            <div
              className={cn(
                ROW_GLYPH_SLOT,
                'text-text-secondary',
                isGroupLive && 'animate-pulse text-text-primary',
              )}
              aria-hidden="true"
            >
              <CategoryIcon size={14} />
            </div>
          ) : (
            <div className={ROW_GLYPH_SLOT} aria-hidden="true">
              <StackedToolIcons
                toolNames={iconToolNames}
                mcpIconMap={mcpIconMap}
                maxIcons={4}
                sourceDomains={sourceDomains}
                status={iconStatus}
                isAnimating={isGroupLive}
              />
            </div>
          )}
          <span
            className={cn(
              'tool-status-text min-w-0 truncate font-medium',
              activityFailed && 'text-text-warning',
            )}
            role="status"
            title={groupLabel}
          >
            {groupLabel}
          </span>
          {visibleGroupDetail && (
            <span
              className="min-w-0 max-w-[40%] truncate text-xs font-normal text-text-secondary"
              title={visibleGroupDetail}
            >
              · {visibleGroupDetail}
            </span>
          )}
          <ChevronDown
            className={cn(
              'size-4 shrink-0 text-text-secondary transition-transform duration-200 ease-out',
              isExpanded && 'rotate-180',
            )}
            aria-hidden="true"
          />
        </Button>
        {!withinActivityPhase && (
          <FailedRevealPill count={activitySummary.failedCount} onReveal={handleRevealFailed} />
        )}
      </div>
      <div
        style={expandStyle}
        onTransitionEnd={handleTransitionEnd}
        aria-hidden={!isExpanded}
        data-testid="tool-call-group-panel"
      >
        {shouldRenderBody && (
          <div className={cn('overflow-hidden', FOLD_RAIL_CLASSES)} ref={expandRef}>
            <ToolAuthWarningContext.Provider value>
              <FailedRevealContext.Provider value={revealValue}>
                <div className="flex flex-col py-0.5">
                  {parts.map(({ part, idx }, partIndex) => {
                    if (part.type === ContentTypes.THINK) {
                      const think = part.think;
                      const reasoning = typeof think === 'string' ? think : (think?.value ?? '');
                      /** A detached-subagent projection carries an empty THINK
                       *  part flagged `reasoning_unavailable`, which `Part`
                       *  renders as a `ReasoningMarker`. `ReasoningCompact` has
                       *  no text to show and returns null, so the marker has to
                       *  keep going through the standalone path or it vanishes
                       *  the moment its call joins a group. */
                      if (reasoning.trim() === '' && part.reasoning_unavailable === true) {
                        return renderPart(
                          part,
                          idx,
                          isLast && idx === lastContentIdx,
                          handleToolExpand,
                        );
                      }
                      const streaming = isSubmitting && idx === lastContentIdx;
                      const isAfterTool =
                        partIndex > 0 && parts[partIndex - 1]?.part.type === ContentTypes.TOOL_CALL;
                      /** Mirrors the standalone `Reasoning` path: the authored
                       *  label wins, generic text is only a fallback. */
                      const generatedLabel = part.reasoning_label?.trim();
                      const label =
                        generatedLabel ||
                        (streaming ? localize('com_ui_thinking') : localize('com_ui_thoughts'));
                      return (
                        <ReasoningCompact
                          key={`reasoning-${idx}`}
                          partKeyIndex={getPartKeyIndex(part, idx)}
                          reasoning={reasoning}
                          label={label}
                          showThinking={showThinking}
                          isAfterTool={isAfterTool}
                          isStreaming={streaming}
                        />
                      );
                    }
                    return renderPart(
                      part,
                      idx,
                      isLast && idx === lastContentIdx,
                      handleToolExpand,
                    );
                  })}
                </div>
              </FailedRevealContext.Provider>
            </ToolAuthWarningContext.Provider>
            {hasPendingAuthRequest && <ToolAuthWarning className="mb-1 mt-2.5" />}
          </div>
        )}
      </div>
      {groupAttachments && groupAttachments.length > 0 && (
        <>
          <SearchVerticals attachments={groupAttachments} />
          <AttachmentGroup attachments={groupAttachments} />
        </>
      )}
    </div>
  );
}
