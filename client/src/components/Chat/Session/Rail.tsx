import { useCallback, useEffect, useId, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { Square, X } from 'lucide-react';
import { getToolDisplayLabel } from '@librechat/chat';
import { Button, IconButton, TooltipAnchor, useFocusTrap } from '@librechat/client';
import {
  resolveChildAgent,
  activeSubagentPanel,
  useParentSubagents,
  readableSubagentType,
  useOpenSubagentPanel,
  readableSubagentTitle,
  durableSubagentSelection,
} from '@librechat/chat/react';
import type { BackgroundTasksView } from '../BackgroundTasks/useTasks';
import type { TaskRow } from '../BackgroundTasks/rows';
import type { SessionFilesView } from './useFiles';
import { useAgentsMapContext } from '~/Providers/AgentsMapContext';
import { visitTaskTarget } from '../BackgroundTasks/jump';
import Section from '../BackgroundTasks/Section';
import { SESSION_RAIL_ID } from './state';
import { useLocalize } from '~/hooks';
import SessionRow from './Row';
import { cn } from '~/utils';
import Files from './Files';

const isActive = (row: TaskRow) => row.status === 'running' || row.status === 'stopping';

/**
 * What a conversation has going on beside its messages, grouped by kind: the subagents it
 * dispatched, then the tools it left running in the background. `sheet` is the small-screen
 * form, which covers the conversation instead of sitting next to it.
 */
export default function SessionRail({
  view,
  files,
  conversationId,
  agentId,
  sheet,
  onClose,
}: {
  view: BackgroundTasksView;
  /** The conversation's files and which of them it leaves out of later turns. */
  files: SessionFilesView;
  conversationId: string;
  /** The conversation's own agent, which a self-spawned subagent runs as. */
  agentId?: string | null;
  sheet: boolean;
  /** `restoreFocus` is false when the reader is leaving for something the rail pointed at. */
  onClose: (restoreFocus?: boolean) => void;
}) {
  const localize = useLocalize();
  const titleId = useId();
  const rootRef = useRef<HTMLElement | null>(null);
  const setRoot = useCallback((element: HTMLElement | null) => {
    rootRef.current = element;
  }, []);
  const closeRef = useRef<HTMLButtonElement>(null);
  const agentsMap = useAgentsMapContext();
  const parent = useParentSubagents();
  const openSubagentPanel = useOpenSubagentPanel();
  const selectedThreadId = useAtomValue(activeSubagentPanel)?.durable?.threadId;
  const { rows, canStop, stop, isStopping } = view;
  const subagents = rows.filter((row) => row.kind === 'subagent');
  const tools = rows.filter((row) => row.kind === 'tool');
  const running = rows.filter(isActive);
  const anyStoppable = running.some(canStop);
  const partiallyStoppable = running.some((row) => row.status === 'running' && !canStop(row));
  let stopAllLabel = localize('com_ui_background_tasks_stop_all');
  if (!anyStoppable) {
    stopAllLabel = localize('com_ui_background_tasks_cancel_disabled');
  } else if (partiallyStoppable) {
    stopAllLabel = localize('com_ui_background_tasks_stop_available');
  }

  /**
   * The sheet covers the page, so it holds focus and answers Escape the way the other sheets
   * do; the docked rail sits beside the page and leaves focus where it is. The trap starts on
   * the first control, which while something runs is the one that stops everything, so focus is
   * then moved to the close button.
   */
  useFocusTrap(rootRef, sheet, onClose);
  useEffect(() => {
    if (sheet) closeRef.current?.focus({ preventScroll: true });
  }, [sheet]);

  const openRow = useCallback(
    (row: TaskRow): boolean => {
      if (row.kind === 'tool') {
        return visitTaskTarget(row, sheet ? () => onClose(false) : undefined);
      }
      if (
        openSubagentPanel == null ||
        parent.conversationId !== conversationId ||
        row.threadId == null ||
        row.taskId == null
      ) {
        return false;
      }
      const child = parent.byThreadId.get(row.threadId);
      if (child == null) return false;
      const selection = durableSubagentSelection(conversationId, child, row.taskId);
      if (selection == null) return false;
      /** On a small screen the thread opens as a sheet of its own, where this one stands. */
      if (sheet) onClose(false);
      openSubagentPanel({ ...selection, isSubmitting: false });
      return true;
    },
    [conversationId, onClose, openSubagentPanel, parent.byThreadId, parent.conversationId, sheet],
  );

  const stopRow = useCallback((row: TaskRow) => void stop(row), [stop]);

  const summary = (group: TaskRow[]) => {
    const active = group.filter(isActive).length;
    const failed = group.filter((row) => row.status === 'error').length;
    if (active > 0) {
      return (
        <span className="text-text-secondary pe-1 text-xs tabular-nums">
          {localize(
            active === 1
              ? 'com_ui_subagent_count_running_one'
              : 'com_ui_subagent_count_running_other',
            { 0: String(active) },
          )}
        </span>
      );
    }
    if (failed === 0) return undefined;
    return (
      <span className="text-status-error pe-1 text-xs tabular-nums">
        {localize(
          failed === 1 ? 'com_ui_subagent_count_failed_one' : 'com_ui_subagent_count_failed_other',
          { 0: String(failed) },
        )}
      </span>
    );
  };

  const subagentRow = (row: TaskRow) => {
    const agent = resolveChildAgent(
      row.agentId,
      row.subagentType,
      agentId == null ? undefined : agentsMap?.[agentId],
      agentsMap,
      row.subagentKind,
    );
    const source =
      agent?.name ||
      readableSubagentType(row.subagentType, row.agentId, row.subagentKind) ||
      localize('com_ui_background_tasks_subagent');
    return (
      <SessionRow
        key={row.id}
        row={row}
        title={readableSubagentTitle(row.name, row.agentId, row.subagentKind) ?? source}
        source={source}
        agent={agent}
        selected={row.threadId != null && row.threadId === selectedThreadId}
        canStop={canStop(row)}
        isStopping={isStopping}
        onStop={stopRow}
        onOpen={openRow}
      />
    );
  };

  const toolRow = (row: TaskRow) => {
    const source = getToolDisplayLabel(row.name, localize);
    return (
      <SessionRow
        key={row.id}
        row={row}
        title={row.title ?? source}
        source={source}
        canStop={canStop(row)}
        isStopping={isStopping}
        onStop={stopRow}
        onOpen={openRow}
      />
    );
  };

  const Root = sheet ? 'div' : 'aside';

  return (
    <Root
      id={SESSION_RAIL_ID}
      ref={setRoot}
      role={sheet ? 'dialog' : undefined}
      aria-modal={sheet || undefined}
      aria-labelledby={titleId}
      data-testid="session-rail"
      className={cn(
        'bg-surface-sidebar text-text-primary flex h-full shrink-0 flex-col',
        sheet ? 'fixed inset-0 z-[100]' : 'w-full',
      )}
    >
      <div className="flex h-[3.25rem] shrink-0 items-center gap-1 ps-4 pe-2">
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-sm font-semibold">
          {localize('com_ui_session')}
        </h2>
        {running.length > 0 && (
          <TooltipAnchor
            description={stopAllLabel}
            render={
              <span
                role={!anyStoppable ? 'group' : undefined}
                aria-label={!anyStoppable ? stopAllLabel : undefined}
                tabIndex={!anyStoppable ? 0 : undefined}
                className="inline-flex"
              >
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  aria-label={stopAllLabel}
                  disabled={!anyStoppable || isStopping}
                  onClick={() => void view.stopAll()}
                  data-testid="session-stop-all"
                >
                  <Square className="me-1.5 size-2.5 fill-current" aria-hidden="true" />
                  {localize('com_ui_session_stop_all')}
                </Button>
              </span>
            }
          />
        )}
        <IconButton
          ref={closeRef}
          variant="ghost"
          size="sm"
          label={localize('com_ui_session_close')}
          onClick={() => onClose()}
        >
          <X className="size-[1.0625rem]" aria-hidden="true" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2 pb-3">
        {view.incomplete && (
          <p role="status" className="text-status-warning px-2 text-sm">
            {localize('com_ui_background_tasks_incomplete')}
          </p>
        )}
        {view.loadFailed && (
          <div role="alert" className="text-status-error px-2 text-sm">
            <p>{localize('com_ui_background_tasks_load_failed')}</p>
            <button
              type="button"
              className="text-text-primary focus-visible:ring-focus-control mt-1 rounded underline focus-visible:ring-2 focus-visible:outline-none"
              onClick={() => void view.retry()}
            >
              {localize('com_ui_retry')}
            </button>
          </div>
        )}
        {view.stopFailed && (
          <p role="alert" className="text-status-error px-2 text-sm">
            {localize('com_ui_background_tasks_stop_failed')}
          </p>
        )}
        {subagents.length > 0 && (
          <Section
            dense
            label={localize('com_ui_agent_subagents')}
            count={subagents.length}
            action={summary(subagents)}
          >
            {subagents.map(subagentRow)}
          </Section>
        )}
        {tools.length > 0 && (
          <Section
            dense
            label={localize('com_ui_background_tasks')}
            count={tools.length}
            action={summary(tools)}
          >
            {tools.map(toolRow)}
          </Section>
        )}
        <Files view={files} />
        {rows.length === 0 && files.rows.length === 0 && !view.loadFailed && !view.incomplete && (
          <p className="text-text-secondary px-2 pt-1 text-sm">
            {localize('com_ui_session_empty')}
          </p>
        )}
      </div>
    </Root>
  );
}
