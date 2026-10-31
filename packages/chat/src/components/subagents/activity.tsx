import { useCallback, useId, useMemo, useState } from 'react';
import { Bot, ChevronDown } from 'lucide-react';
import { Button, cn, useLocalize } from '@librechat/client';
import type { ParentSubagentSummary } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import {
  isLiveSubagentStatus,
  subagentStatusDotClass,
  subagentStatusLabelKey,
} from '../../react/subagents/status';
import { useChatSurface, useSubagentPanelActions } from '../../react/subagents/surface';
import { eventSubagentSelection } from '../../react/subagents/eventSelection';
import { useParentSubagents } from '../../react/subagents/parents';
import { getMessageRowWidthClass } from '../messages/width';
import { useMessagePartsHost } from '../../react/host';

const STATUS_COUNT_LABEL_KEYS = {
  dispatched: {
    one: 'com_ui_subagent_count_dispatched_one',
    other: 'com_ui_subagent_count_dispatched_other',
  },
  running: {
    one: 'com_ui_subagent_count_running_one',
    other: 'com_ui_subagent_count_running_other',
  },
  completed: {
    one: 'com_ui_subagent_count_completed_one',
    other: 'com_ui_subagent_count_completed_other',
  },
  failed: {
    one: 'com_ui_subagent_count_failed_one',
    other: 'com_ui_subagent_count_failed_other',
  },
  interrupted: {
    one: 'com_ui_subagent_count_interrupted_one',
    other: 'com_ui_subagent_count_interrupted_other',
  },
  cancelled: {
    one: 'com_ui_subagent_count_cancelled_one',
    other: 'com_ui_subagent_count_cancelled_other',
  },
} as const;

/** The parent-owned group of event-spawned children under the reply that launched them. */
export function EventSubagentActivityGroup({
  conversationId,
  parentMessageIds,
  hasParallelContent = false,
}: {
  conversationId: string;
  parentMessageIds: string[];
  hasParallelContent?: boolean;
}): ReactNode {
  const { byMessageId } = useParentSubagents();
  const children = useMemo(() => {
    const seen = new Set<string>();
    return parentMessageIds
      .flatMap((messageId) => byMessageId.get(messageId) ?? [])
      .filter((child) => {
        if (seen.has(child.threadId)) return false;
        seen.add(child.threadId);
        return true;
      });
  }, [byMessageId, parentMessageIds]);
  const { maximizeChatSpace: fullWidth } = useChatSurface();
  const siblingParentMessageIds = useMemo(
    () => Array.from(new Set(parentMessageIds)),
    [parentMessageIds],
  );
  if (children.length === 0) return null;
  return (
    <div
      className={cn(
        'duration-theme-normal mx-auto min-w-0 flex-1 px-4 transition-[max-width] motion-reduce:transition-none sm:px-0',
        getMessageRowWidthClass({ fullWidth, hasParallelContent }),
      )}
    >
      <EventSubagentRows
        conversationId={conversationId}
        eventChildren={children}
        siblingParentMessageIds={siblingParentMessageIds}
      />
    </div>
  );
}

function EventSubagentRows({
  conversationId,
  eventChildren,
  siblingParentMessageIds,
}: {
  conversationId: string;
  eventChildren: ParentSubagentSummary[];
  siblingParentMessageIds: string[];
}) {
  const localize = useLocalize();
  const { refresh } = useParentSubagents();
  const panel = useSubagentPanelActions();
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const counts = useMemo(() => {
    const result = new Map<ParentSubagentSummary['status'], number>();
    eventChildren.forEach((child) => result.set(child.status, (result.get(child.status) ?? 0) + 1));
    return result;
  }, [eventChildren]);
  const summary = [
    localize(
      eventChildren.length === 1 ? 'com_ui_subagent_agent_count' : 'com_ui_subagent_agents_count',
      { 0: String(eventChildren.length) },
    ),
    ...Array.from(counts.entries()).map(([status, count]) =>
      localize(STATUS_COUNT_LABEL_KEYS[status][count === 1 ? 'one' : 'other'], {
        0: String(count),
      }),
    ),
  ].join(' · ');
  const openChild = useCallback(
    (child: ParentSubagentSummary) => {
      const selection = eventSubagentSelection(conversationId, child, siblingParentMessageIds);
      if (selection == null || panel == null) return;
      panel.open(selection);
      void refresh().then((index) => {
        const fresh = index?.children.find((candidate) => candidate.threadId === child.threadId);
        if (fresh == null || fresh.latestTaskId === child.latestTaskId) return;
        const freshSelection = eventSubagentSelection(
          conversationId,
          fresh,
          siblingParentMessageIds,
        );
        if (freshSelection != null) {
          panel.update((current) => {
            if (
              current?.event?.pinnedTask === true ||
              current?.durable?.threadId !== selection.durable?.threadId ||
              current?.durable?.taskId !== selection.durable?.taskId
            ) {
              return current;
            }
            return freshSelection;
          });
        }
      });
    },
    [conversationId, panel, refresh, siblingParentMessageIds],
  );
  return (
    <section
      aria-label={localize('com_ui_subagent_activity')}
      /** `text-text-primary` on the root, like `SubagentActivity` and
       *  `SubagentThreadPanel`: the child rows are raw buttons that inherit
       *  their label color, and without a themed ancestor they bottom out at
       *  the unthemed black body color, invisible on the dark surface. */
      className="border-border-light bg-surface-secondary/40 text-text-primary my-2 overflow-hidden rounded-lg border"
      data-event-subagent-group={eventChildren[0]?.parentMessageId}
      data-event-subagent-conversation={conversationId}
    >
      <Button
        variant="quiet"
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={panelId}
        aria-label={`${localize('com_ui_subagent_activity')}: ${summary}`}
        className="focus-visible:ring-ring-primary flex h-auto min-h-10 w-full items-center justify-start px-3 text-start focus-visible:ring-offset-0 focus-visible:ring-inset"
      >
        <Bot size={15} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{summary}</span>
        <ChevronDown
          size={16}
          className={cn('shrink-0 transition-transform', expanded && 'rotate-180')}
          aria-hidden="true"
        />
      </Button>
      <div
        id={panelId}
        hidden={!expanded}
        className="divide-border-inset border-border-inset divide-y border-t"
      >
        {eventChildren.map((child) => (
          <EventSubagentRow key={child.threadId} child={child} onOpen={openChild} />
        ))}
      </div>
    </section>
  );
}

function EventSubagentRow({
  child,
  onOpen,
}: {
  child: ParentSubagentSummary;
  onOpen: (child: ParentSubagentSummary) => void;
}) {
  const localize = useLocalize();
  const { useAgent, renderAgentAvatar } = useMessagePartsHost();
  const agent = useAgent(child.agentId ?? '');
  const label = agent?.name || child.actorId || child.title;
  const canOpen = child.latestTaskId != null;
  return (
    <button
      type="button"
      disabled={!canOpen}
      onClick={() => onOpen(child)}
      data-subagent-thread={child.threadId}
      data-subagent-tool-call={`event-thread:${child.threadId}`}
      data-subagent-parent-message={child.parentMessageId}
      data-subagent-part-index="0"
      className={cn(
        'focus-visible:ring-ring-primary flex w-full items-center gap-2 px-3 py-2 text-start text-sm focus-visible:ring-2 focus-visible:outline-hidden focus-visible:ring-inset',
        canOpen ? 'hover:bg-surface-hover' : 'cursor-default opacity-70',
      )}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full">
        {agent ? renderAgentAvatar(agent) : <Bot size={14} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {child.actorId && child.actorId !== label ? (
          <span className="text-text-secondary block truncate text-xs">{child.actorId}</span>
        ) : null}
      </span>
      {/* Fixed-width slot, dot last: the label absorbs every length
            change inboard of it, so the color lands on the same pixel
            column in every row and cannot drift as statuses change. */}
      <span className="text-text-secondary flex w-24 shrink-0 items-center justify-end gap-1.5 text-xs">
        <span className={cn('min-w-0 truncate', isLiveSubagentStatus(child.status) && 'shimmer')}>
          {localize(subagentStatusLabelKey(child.status))}
        </span>
        <span
          className={cn(
            'border-border-heavy/40 h-2 w-2 shrink-0 rounded-full border',
            subagentStatusDotClass(child.status),
          )}
          aria-hidden="true"
        />
      </span>
    </button>
  );
}
