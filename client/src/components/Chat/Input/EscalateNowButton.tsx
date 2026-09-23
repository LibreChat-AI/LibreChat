import { useEffect, useId, useSyncExternalStore } from 'react';
import { ArrowUp } from 'lucide-react';
import * as Ariakit from '@ariakit/react';
import { IconButton } from '@librechat/client';
import { useShortcutAriaKey, useShortcutDisplay } from '~/hooks/useKeyboardShortcuts';
import { getChatPane, getFocusedChatPane } from '~/utils/pane';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/** Longest message excerpt spoken as part of the button's accessible name;
 *  past this the row is identified by its opening words rather than read out. */
const MESSAGE_LABEL_MAX_LENGTH = 80;

/* Which escalation control the keyboard shortcut acts on. Module state rather
   than context: the shortcut handler lives at the document level and only ever
   needs the single hovered/focused target, so every button subscribing to one
   store is cheaper than a provider spanning both surfaces. Focus wins over
   hover, matching what a keyboard user is actually pointed at. A hovered button
   in a pane that does not hold focus is not the target, since the shortcut acts
   in the focused pane; focus moves re-evaluate that. */
const listeners = new Set<() => void>();
let hovered: { id: string; element: Element } | null = null;
let focusedTarget: string | null = null;

function isInFocusedPane(element: Element) {
  const focusedPane = getFocusedChatPane();
  return focusedPane == null || getChatPane(element) === focusedPane;
}

function getActiveTarget() {
  if (focusedTarget != null) {
    return focusedTarget;
  }
  return hovered != null && isInFocusedPane(hovered.element) ? hovered.id : null;
}

function notify() {
  listeners.forEach((listener) => listener());
}

function subscribeToActiveTarget(listener: () => void) {
  if (listeners.size === 0) {
    document.addEventListener('focusin', notify);
    document.addEventListener('focusout', notify);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      document.removeEventListener('focusin', notify);
      document.removeEventListener('focusout', notify);
    }
  };
}

function updateActiveTarget(
  kind: 'hover' | 'focus',
  targetId: string,
  active: boolean,
  element?: Element,
) {
  const previous = getActiveTarget();
  if (kind === 'hover') {
    if (active && element != null) {
      hovered = { id: targetId, element };
    } else if (hovered?.id === targetId) {
      hovered = null;
    }
  } else if (active) {
    focusedTarget = targetId;
  } else if (focusedTarget === targetId) {
    focusedTarget = null;
  }
  if (previous !== getActiveTarget()) {
    notify();
  }
}

function clearActiveTarget(targetId: string) {
  const previous = getActiveTarget();
  if (hovered?.id === targetId) {
    hovered = null;
  }
  if (focusedTarget === targetId) {
    focusedTarget = null;
  }
  if (previous !== getActiveTarget()) {
    notify();
  }
}

interface EscalateNowButtonProps {
  /** Which waiting surface this row belongs to; the `escalateSteer` shortcut
   *  prefers a bubble over a queued row when nothing is hovered or focused. */
  surface: 'bubble' | 'queued';
  disabled: boolean;
  messageText: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

/**
 * The escalation control on a waiting message: interrupt & steer it now, at
 * the next safe token boundary. The tooltip teaches this action's OWN shortcut
 * (registry-aware, so a rebinding shows correctly). Hover/focus marks this
 * exact button as the shortcut's target; with no active row the shortcut keeps
 * its newest-waiting-message fallback.
 */
export default function EscalateNowButton({
  surface,
  disabled,
  messageText,
  onClick,
}: EscalateNowButtonProps) {
  const localize = useLocalize();
  const chord = useShortcutDisplay('escalateSteer');
  const ariaKey = useShortcutAriaKey('escalateSteer');
  const targetId = useId();
  const activeTarget = useSyncExternalStore(subscribeToActiveTarget, getActiveTarget, () => null);
  const isActive = !disabled && activeTarget === targetId;
  const label = localize('com_ui_interrupt_steer_now');
  const normalized = messageText.trim().replace(/\s+/g, ' ');
  const characters = Array.from(normalized);
  const excerpt =
    characters.length > MESSAGE_LABEL_MAX_LENGTH
      ? `${characters
          .slice(0, MESSAGE_LABEL_MAX_LENGTH - 1)
          .join('')
          .trimEnd()}…`
      : normalized;
  const accessibleLabel = excerpt.length > 0 ? `${label}: ${excerpt}` : label;

  /* A disabled button keeps neither hover nor focus, so a row that locks while
     the pointer rests on it would otherwise leave the shortcut aimed at a
     control that can no longer run. */
  useEffect(() => {
    if (disabled) {
      clearActiveTarget(targetId);
    }
    return () => clearActiveTarget(targetId);
  }, [disabled, targetId]);

  return (
    <Ariakit.TooltipProvider placement="top" timeout={300}>
      {/* The disabled IconButton already renders at half opacity; 70% of that
          is the 35% this control has always dimmed to. */}
      <span className={cn('transition-opacity', disabled && 'opacity-70')}>
        <Ariakit.TooltipAnchor
          render={
            <IconButton
              label={accessibleLabel}
              size="xs"
              variant="primary"
              aria-keyshortcuts={isActive ? ariaKey : undefined}
              data-escalate-steer={surface}
              data-escalate-steer-active={isActive ? 'true' : undefined}
              data-testid={surface === 'queued' ? 'queued-interrupt-now' : 'steer-escalate-now'}
              disabled={disabled}
              onPointerEnter={(event) =>
                !disabled && updateActiveTarget('hover', targetId, true, event.currentTarget)
              }
              onPointerLeave={() => updateActiveTarget('hover', targetId, false)}
              onFocus={() => !disabled && updateActiveTarget('focus', targetId, true)}
              onBlur={() => updateActiveTarget('focus', targetId, false)}
              onClick={onClick}
            >
              <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.4} aria-hidden="true" />
            </IconButton>
          }
        />
      </span>
      <Ariakit.Tooltip className="bg-surface-tertiary text-text-primary z-50 rounded-lg px-2 py-1 text-xs shadow-lg">
        {chord && isActive ? `${label} · ${chord}` : label}
      </Ariakit.Tooltip>
    </Ariakit.TooltipProvider>
  );
}
