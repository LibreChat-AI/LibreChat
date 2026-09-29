import { useCallback, useId, useMemo, useState } from 'react';
import { useSetAtom } from 'jotai';
import { Button, cn } from '@librechat/client';
import { Bot, ChevronDown } from 'lucide-react';
import type { ParentSubagentSummary } from 'librechat-data-provider';
import { isLiveSubagentStatus, subagentStatusDotClass, subagentStatusLabelKey } from './status';
import { getMessageRowWidthClass } from '~/components/Chat/Messages/ui/MessageRow';
import { useChatSurface, useOpenSubagentPanel } from './surface';
import { useParentSubagents } from './ParentSubagentsProvider';
import { eventSubagentSelection } from './eventSelection';
import { useAgentsMapContext } from '~/Providers';
import { activeSubagentPanel } from './state';
import { renderAgentAvatar } from '~/utils';
import { useLocalize } from '~/hooks';

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

export default function EventSubagentActivityGroup({
  conversationId,
  parentMessageIds,
  hasParallelContent = false,
}: {
  conversationId: string;
  parentMessageIds: string[];
  hasParallelContent?: boolean;
}) {
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
        'mx-auto min-w-0 flex-1 px-4 transition-[max-width] duration-theme-normal motion-reduce:transition-none sm:px-0',
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
  const agentsMap = useAgentsMapContext();
  const { refresh } = useParentSubagents();
  const setSelected = useSetAtom(activeSubagentPanel);
  const openPanel = useOpenSubagentPanel();
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
      if (selection == null || openPanel == null) return;
      openPanel(selection);
      void refresh().then((index) => {
        const fresh = index?.children.find((candidate) => candidate.threadId === child.threadId);
        if (fresh == null || fresh.latestTaskId === child.latestTaskId) return;
        const freshSelection = eventSubagentSelection(
          conversationId,
          fresh,
          siblingParentMessageIds,
        );
        if (freshSelection != null) {
          setSelected((current) => {
            if (
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
    [conversationId, openPanel, refresh, setSelected, siblingParentMessageIds],
  );
  return (
    <section
      aria-label={localize('com_ui_subagent_activity')}
      /** `text-text-primary` on the root, like `SubagentActivity` and
       *  `SubagentThreadPanel`: the child rows are raw buttons that inherit
       *  their label color, and without a themed ancestor they bottom out at
       *  the unthemed black body color — invisible on the dark surface. */
      className="my-2 overflow-hidden rounded-lg border border-border-light bg-surface-secondary/40 text-text-primary"
      data-event-subagent-group={eventChildren[0]?.parentMessageId}
    >
      <Button
        variant="ghost"
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={panelId}
        aria-label={`${localize('com_ui_subagent_activity')}: ${summary}`}
        className="flex h-auto min-h-10 w-full items-center justify-start gap-2 rounded-lg px-3 py-2 text-left text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring-primary focus-visible:ring-offset-0"
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
        className="divide-y divide-border-light border-t border-border-light"
      >
        {eventChildren.map((child) => {
          const agent = child.agentId == null ? undefined : agentsMap?.[child.agentId];
          const label = agent?.name || child.actorId || child.title;
          const canOpen = child.latestTaskId != null;
          return (
            <button
              key={child.threadId}
              type="button"
              disabled={!canOpen}
              onClick={() => openChild(child)}
              data-subagent-tool-call={`event-thread:${child.threadId}`}
              data-subagent-parent-message={child.parentMessageId}
              data-subagent-part-index="0"
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring-primary',
                canOpen ? 'hover:bg-surface-hover' : 'cursor-default opacity-70',
              )}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full">
                {agent ? (
                  renderAgentAvatar(agent, { size: 'icon', showBorder: false })
                ) : (
                  <Bot size={14} />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{label}</span>
                {child.actorId && child.actorId !== label ? (
                  <span className="block truncate text-xs text-text-secondary">
                    {child.actorId}
                  </span>
                ) : null}
              </span>
              {/* Fixed-width slot, dot last: the label absorbs every length
                  change inboard of it, so the color lands on the same pixel
                  column in every row and cannot drift as statuses change. */}
              <span className="flex w-24 shrink-0 items-center justify-end gap-1.5 text-xs text-text-secondary">
                <span
                  className={cn(
                    'min-w-0 truncate',
                    isLiveSubagentStatus(child.status) && 'shimmer',
                  )}
                >
                  {localize(subagentStatusLabelKey(child.status))}
                </span>
                <span
                  className={cn(
                    'h-2 w-2 shrink-0 rounded-full border border-border-heavy/40',
                    subagentStatusDotClass(child.status),
                  )}
                  aria-hidden="true"
                />
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
