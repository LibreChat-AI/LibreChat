import { memo, useCallback, useState } from 'react';
import { ListTodo } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useAtom, useAtomValue } from 'jotai';
import { TooltipAnchor } from '@librechat/client';
import { SESSION_RAIL_ID, SESSION_TOGGLE_ID, sessionRailOpen, sessionRailSlot } from './state';
import { ARTIFACTS_SHEET_MAX_WIDTH } from '~/utils/breakpoints';
import useBackgroundTasks from '../BackgroundTasks/useTasks';
import useScaledMaxWidth from '~/hooks/useScaledMaxWidth';
import { useTaskExpiry } from '../BackgroundTasks/clock';
import { useLocalize } from '~/hooks';
import SessionRail from './Rail';
import { cn } from '~/utils';

/**
 * The chat header's session control and the rail it opens. It is always offered, so a reader
 * learns one place to look, and it is the single reader of the conversation's tasks: the dot on
 * the control and the rows in the rail cannot disagree.
 */
function Session({
  conversationId,
  agentId,
  isSubmitting,
}: {
  conversationId: string;
  agentId?: string | null;
  isSubmitting: boolean;
}) {
  const localize = useLocalize();
  const slot = useAtomValue(sessionRailSlot);
  const sheet = useScaledMaxWidth(ARTIFACTS_SHEET_MAX_WIDTH);
  const [docked, setDocked] = useAtom(sessionRailOpen);
  /** A sheet covers the conversation, so it never reopens itself from a remembered choice. */
  const [sheetOpen, setSheetOpen] = useState(false);
  const open = sheet ? sheetOpen : docked;
  const [now, setNow] = useState(() => Date.now());
  const view = useBackgroundTasks({ conversationId, isSubmitting, now, details: open });
  const { activeCount, awaitingCount, failedCount, incomplete } = view;
  useTaskExpiry(view.rows, setNow);

  const setOpen = useCallback(
    (next: boolean) => (sheet ? setSheetOpen(next) : setDocked(next)),
    [sheet, setDocked],
  );
  const close = useCallback(
    (restoreFocus = true) => {
      setOpen(false);
      if (restoreFocus) {
        document.getElementById(SESSION_TOGGLE_ID)?.focus({ preventScroll: true });
      }
    },
    [setOpen],
  );

  const title = localize('com_ui_session');
  const label =
    [
      ...(activeCount > 0 ? [localize('com_ui_session_label_running', { 0: activeCount })] : []),
      ...(awaitingCount > 0
        ? [localize('com_ui_session_label_pending', { 0: awaitingCount })]
        : []),
      ...(failedCount > 0 ? [localize('com_ui_session_label_failed', { 0: failedCount })] : []),
      ...(incomplete ? [localize('com_ui_background_tasks_incomplete')] : []),
    ].join('; ') || title;

  return (
    <>
      <TooltipAnchor
        description={label}
        render={
          <button
            type="button"
            id={SESSION_TOGGLE_ID}
            aria-label={label}
            aria-expanded={open}
            aria-controls={open ? SESSION_RAIL_ID : undefined}
            data-testid="header-background-tasks-button"
            onClick={() => setOpen(!open)}
            className="border-border-light bg-presentation text-text-primary hover:bg-surface-active-alt aria-expanded:bg-surface-active-alt rounded-theme-control relative inline-flex size-9 flex-shrink-0 items-center justify-center border transition-all ease-in-out"
          >
            <ListTodo className="icon-md" aria-hidden="true" />
            {(activeCount > 0 || awaitingCount > 0 || failedCount > 0 || incomplete) && (
              <span
                aria-hidden="true"
                data-testid="background-tasks-indicator"
                className={cn(
                  'ring-presentation absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2',
                  failedCount > 0 || incomplete ? 'bg-status-warning' : 'bg-status-info',
                  activeCount > 0 && 'animate-pulse motion-reduce:animate-none',
                )}
              />
            )}
          </button>
        }
      />
      {open &&
        slot != null &&
        createPortal(
          <SessionRail
            view={view}
            conversationId={conversationId}
            agentId={agentId}
            sheet={sheet}
            onClose={close}
          />,
          slot,
        )}
    </>
  );
}

export default memo(Session);
