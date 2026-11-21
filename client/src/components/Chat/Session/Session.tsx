import { memo, useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { ListTodo } from 'lucide-react';
import { createPortal } from 'react-dom';
import { TooltipAnchor } from '@librechat/client';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  SESSION_RAIL_ID,
  sessionRailOpen,
  sessionRailSlot,
  sessionRailDocked,
  sessionRailSheetSlot,
  SESSION_TOGGLE_ID,
  sessionRailAutoOpen,
  sessionRailDismissed,
  SESSION_RAIL_DISMISSED_LIMIT,
} from './state';
import { ARTIFACTS_SHEET_MAX_WIDTH } from '~/utils/breakpoints';
import useBackgroundTasks from '../BackgroundTasks/useTasks';
import useScaledMaxWidth from '~/hooks/useScaledMaxWidth';
import { useTaskExpiry } from '../BackgroundTasks/clock';
import useSessionFiles from './useFiles';
import { useLocalize } from '~/hooks';
import SessionRail from './Rail';
import { cn } from '~/utils';

/**
 * The chat header's session control and the rail it opens. A saved conversation always offers
 * it, so a reader learns one place to look; a chat with no messages yet has nothing a session
 * could hold, so the header leaves it out there. It is the single reader of the conversation's
 * tasks: the dot on the control and the rows in the rail cannot disagree.
 *
 * With `autoOpen`, work that starts running shows the rail without being asked. That costs the
 * thread one re-wrap and no render: the rail's column narrows it, and nothing outside this
 * component and the rail reads whether the rail is open.
 */
function Session({
  conversationId,
  agentId,
  isSubmitting,
  autoOpen = true,
  files: listFiles = true,
}: {
  conversationId: string;
  agentId?: string | null;
  isSubmitting: boolean;
  autoOpen?: boolean;
  /**
   * Whether the conversation's files are listed. Off where leaving one out would change nothing:
   * an assistants thread keeps its own copy of every attachment upstream.
   */
  files?: boolean;
}) {
  const localize = useLocalize();
  const slot = useAtomValue(sessionRailSlot);
  const sheet = useScaledMaxWidth(ARTIFACTS_SHEET_MAX_WIDTH);
  const [docked, setDocked] = useAtom(sessionRailOpen);
  /** A sheet covers the conversation, so it never reopens itself from a remembered choice. */
  const [sheetOpen, setSheetOpen] = useState(false);
  /**
   * Shown for this conversation because work started in it. That is not the reader's standing
   * choice, so it is not remembered as one and it ends with the conversation. Closing the rail
   * is an answer: it is not shown again for the same conversation, whatever starts later and
   * however often the reader comes back to it.
   */
  const [summoned, setSummoned] = useState(false);
  const wanted = useAtomValue(sessionRailAutoOpen);
  const [dismissedIds, setDismissedIds] = useAtom(sessionRailDismissed);
  const dismissed = dismissedIds.includes(conversationId);
  const open = sheet ? sheetOpen : docked || summoned;
  /**
   * The layout makes the rail's column while a docked rail is open, and the rail is drawn once
   * the column is there. Told before paint, so the column and the rail arrive together, and
   * taken back when this control goes, as it does on a chat with no messages.
   */
  const sheetSlot = useAtomValue(sessionRailSheetSlot);
  const setColumn = useSetAtom(sessionRailDocked);
  const column = open && !sheet;
  useLayoutEffect(() => {
    setColumn(column);
  }, [column, setColumn]);
  useLayoutEffect(() => () => setColumn(false), [setColumn]);
  const target = sheet ? sheetSlot : slot;
  const [now, setNow] = useState(() => Date.now());
  const view = useBackgroundTasks({ conversationId, isSubmitting, now, details: open });
  const { activeCount, awaitingCount, failedCount, incomplete } = view;
  useTaskExpiry(view.rows, setNow);
  /** Read only while the rail shows them: a closed rail asks nothing about files. */
  const files = useSessionFiles({ conversationId, enabled: open && listFiles });

  /** Never as a sheet: that would cover the conversation the reader is in the middle of. */
  const working = activeCount > 0;
  useEffect(() => {
    if (autoOpen && wanted && working && !sheet && !dismissed) setSummoned(true);
  }, [autoOpen, wanted, working, sheet, dismissed]);

  const setOpen = useCallback(
    (next: boolean) => {
      if (sheet) {
        setSheetOpen(next);
        return;
      }
      setSummoned(false);
      setDocked(next);
      /** Closing is remembered for this conversation; opening it by hand takes that back. */
      setDismissedIds((ids) => {
        const others = ids.filter((id) => id !== conversationId);
        if (next) {
          return others.length === ids.length ? ids : others;
        }
        return [...others, conversationId].slice(-SESSION_RAIL_DISMISSED_LIMIT);
      });
    },
    [conversationId, sheet, setDismissedIds, setDocked],
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
        target != null &&
        createPortal(
          <SessionRail
            view={view}
            files={files}
            conversationId={conversationId}
            agentId={agentId}
            sheet={sheet}
            onClose={close}
          />,
          target,
        )}
    </>
  );
}

export default memo(Session);
