import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ListTodo } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useAtom, useAtomValue } from 'jotai';
import { TooltipAnchor } from '@librechat/client';
import { Constants } from 'librechat-data-provider';
import {
  SESSION_RAIL_ID,
  sessionRailOpen,
  sessionRailSlot,
  SESSION_TOGGLE_ID,
  sessionRailAutoOpen,
  sessionRailDismissed,
  SESSION_RAIL_DISMISSED_LIMIT,
} from './state';
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
}: {
  conversationId: string;
  agentId?: string | null;
  isSubmitting: boolean;
  autoOpen?: boolean;
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
   * however often the reader comes back to it. An unsaved chat has no identity to remember
   * that under, so its answer lasts as long as this control does.
   */
  const [summoned, setSummoned] = useState(false);
  const wanted = useAtomValue(sessionRailAutoOpen);
  const [dismissedIds, setDismissedIds] = useAtom(sessionRailDismissed);
  const dismissedUnsaved = useRef(false);
  const saved = conversationId !== '' && conversationId !== Constants.NEW_CONVO;
  const dismissed = saved && dismissedIds.includes(conversationId);
  const open = sheet ? sheetOpen : docked || summoned;
  const [now, setNow] = useState(() => Date.now());
  const view = useBackgroundTasks({ conversationId, isSubmitting, now, details: open });
  const { activeCount, awaitingCount, failedCount, incomplete } = view;
  useTaskExpiry(view.rows, setNow);

  /** Never as a sheet: that would cover the conversation the reader is in the middle of. */
  const working = activeCount > 0;
  useEffect(() => {
    if (autoOpen && wanted && working && !sheet && !dismissed && !dismissedUnsaved.current) {
      setSummoned(true);
    }
  }, [autoOpen, wanted, working, sheet, dismissed]);

  const setOpen = useCallback(
    (next: boolean) => {
      if (sheet) {
        setSheetOpen(next);
        return;
      }
      setSummoned(false);
      setDocked(next);
      if (!saved) {
        dismissedUnsaved.current = !next;
        return;
      }
      /** Closing is remembered for this conversation; opening it by hand takes that back. */
      setDismissedIds((ids) => {
        const others = ids.filter((id) => id !== conversationId);
        if (next) {
          return others.length === ids.length ? ids : others;
        }
        return [...others, conversationId].slice(-SESSION_RAIL_DISMISSED_LIMIT);
      });
    },
    [conversationId, saved, sheet, setDismissedIds, setDocked],
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
