import { Fragment, useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { useRecoilState } from 'recoil';
import * as Ariakit from '@ariakit/react';
import { Zap, ZapOff, Clock } from 'lucide';
import { MorphIcon } from '@librechat/client';
import { ArrowUp, CircleHelp, MoreHorizontal } from 'lucide-react';
import type { Ref } from 'react';
import type { SteeringControls } from '~/hooks/Chat/useSteering';
import { useShortcutAriaKey, useShortcutDisplay } from '~/hooks/useKeyboardShortcuts';
import { QUEUE_ICON, STEER_ICON } from '~/components/Chat/Steering/identity';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';

/** Shared row/bubble affordances for the during-run surfaces: the in-flight
 *  steer bubbles (`InFlightSteers`) and the queued/failed rows
 *  (`PendingSteerChips`) offer the same actions, so they share one menu. */
export const ICON_BTN_CLASS =
  'shrink-0 rounded-full p-1 text-text-secondary hover:bg-surface-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-xheavy';
export const PRIMARY_BTN_CLASS =
  'flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-text-secondary hover:bg-surface-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-xheavy';
const MENU_CLASS =
  'z-50 min-w-[13rem] rounded-xl border border-border-light bg-surface-secondary p-1.5 text-text-primary shadow-lg outline-none';
const MENU_ITEM_CLASS =
  'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-text-primary data-[active-item]:bg-surface-tertiary aria-disabled:cursor-not-allowed aria-disabled:opacity-50';
const ESCALATION_MESSAGE_LABEL_MAX_LENGTH = 80;

const activeEscalateListeners = new Set<() => void>();
let hoveredEscalateTarget: string | null = null;
let focusedEscalateTarget: string | null = null;

function getActiveEscalateTarget() {
  return focusedEscalateTarget ?? hoveredEscalateTarget;
}

function subscribeToActiveEscalateTarget(listener: () => void) {
  activeEscalateListeners.add(listener);
  return () => activeEscalateListeners.delete(listener);
}

function updateActiveEscalateTarget(kind: 'hover' | 'focus', targetId: string, active: boolean) {
  const previous = getActiveEscalateTarget();
  if (kind === 'hover') {
    if (active) {
      hoveredEscalateTarget = targetId;
    } else if (hoveredEscalateTarget === targetId) {
      hoveredEscalateTarget = null;
    }
  } else {
    if (active) {
      focusedEscalateTarget = targetId;
    } else if (focusedEscalateTarget === targetId) {
      focusedEscalateTarget = null;
    }
  }
  if (previous !== getActiveEscalateTarget()) {
    activeEscalateListeners.forEach((listener) => listener());
  }
}

function clearActiveEscalateTarget(targetId: string) {
  const previous = getActiveEscalateTarget();
  if (hoveredEscalateTarget === targetId) {
    hoveredEscalateTarget = null;
  }
  if (focusedEscalateTarget === targetId) {
    focusedEscalateTarget = null;
  }
  if (previous !== getActiveEscalateTarget()) {
    activeEscalateListeners.forEach((listener) => listener());
  }
}

export type MenuEntry = {
  key: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** Localized description announced on the action and exposed by a help disclosure. */
  info?: string;
};

/**
 * Per-row "…" overflow menu: message actions first, then a visually separated
 * "Preferences" section for the sticky mode toggles, so one-off actions and
 * persistent behavior changes never read as the same kind of choice.
 */
export function RowMenu({
  label,
  entries,
  preferences,
  buttonRef,
}: {
  label: string;
  entries: MenuEntry[];
  preferences?: MenuEntry[];
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const localize = useLocalize();
  const menu = Ariakit.useMenuStore({ placement: 'top-end' });
  const descriptionPrefix = useId();
  const preferencesLabelId = `${descriptionPrefix}-preferences`;
  const [expandedInfoKey, setExpandedInfoKey] = useState<string | null>(null);
  const renderEntry = (entry: MenuEntry) => {
    const descriptionId = entry.info == null ? undefined : `${descriptionPrefix}-${entry.key}`;
    const infoExpanded = entry.info != null && expandedInfoKey === entry.key;
    const action = (
      <Ariakit.MenuItem
        className={MENU_ITEM_CLASS}
        disabled={entry.disabled === true}
        accessibleWhenDisabled
        aria-describedby={descriptionId}
        onClick={() => {
          entry.onClick();
          setExpandedInfoKey(null);
          menu.hide();
        }}
      >
        {entry.icon}
        {entry.label}
      </Ariakit.MenuItem>
    );

    if (entry.info == null || descriptionId == null) {
      return <Fragment key={entry.key}>{action}</Fragment>;
    }

    return (
      <div key={entry.key} role="none">
        <div role="none" className="flex items-center gap-0.5">
          <div role="none" className="min-w-0 flex-1">
            {action}
          </div>
          <Ariakit.MenuItem
            aria-label={`${localize('com_ui_more_info')}: ${entry.label}`}
            aria-expanded={infoExpanded}
            aria-controls={descriptionId}
            hideOnClick={false}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-surface-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-xheavy data-[active-item]:bg-surface-tertiary"
            onClick={() =>
              setExpandedInfoKey((current) => (current === entry.key ? null : entry.key))
            }
          >
            <CircleHelp className="h-3.5 w-3.5" aria-hidden="true" />
          </Ariakit.MenuItem>
        </div>
        <div
          id={descriptionId}
          className={cn(
            infoExpanded
              ? 'mx-2 mb-1 rounded-lg bg-surface-tertiary px-2 py-1.5 text-xs leading-relaxed text-text-secondary'
              : 'sr-only',
          )}
        >
          {entry.info}
        </div>
      </div>
    );
  };
  return (
    <>
      <Ariakit.MenuButton
        ref={buttonRef}
        store={menu}
        aria-label={label}
        className={ICON_BTN_CLASS}
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </Ariakit.MenuButton>
      <Ariakit.Menu store={menu} portal gutter={6} className={MENU_CLASS}>
        {entries.map(renderEntry)}
        {preferences != null && preferences.length > 0 && (
          <>
            <div role="separator" className="mx-2 my-1 border-t border-border-light" />
            <div role="group" aria-labelledby={preferencesLabelId}>
              <div
                id={preferencesLabelId}
                className="px-2 pb-0.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-text-secondary"
              >
                {localize('com_ui_preferences')}
              </div>
              {preferences.map(renderEntry)}
            </div>
          </>
        )}
      </Ariakit.Menu>
    </>
  );
}

/**
 * The always-visible escalation control on a waiting message: interrupt &
 * steer it now, at the next safe token boundary. The tooltip teaches this
 * action's OWN shortcut (registry-aware, so a rebinding shows correctly).
 * Hover/focus marks this exact button as the active shortcut target; without
 * an active row the shortcut retains its newest-waiting-message fallback.
 */
export function EscalateNowButton({
  surface,
  disabled,
  messageText,
  onClick,
}: {
  surface: 'bubble' | 'queued';
  disabled: boolean;
  messageText: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const localize = useLocalize();
  const chord = useShortcutDisplay('escalateSteer');
  const ariaKey = useShortcutAriaKey('escalateSteer');
  const targetId = useId();
  const activeTarget = useSyncExternalStore(
    subscribeToActiveEscalateTarget,
    getActiveEscalateTarget,
    () => null,
  );
  const isActive = !disabled && activeTarget === targetId;
  const label = localize('com_ui_interrupt_steer_now');
  const normalizedMessageLabel = messageText.trim().replace(/\s+/g, ' ');
  const messageCharacters = Array.from(normalizedMessageLabel);
  const messageLabel =
    messageCharacters.length > ESCALATION_MESSAGE_LABEL_MAX_LENGTH
      ? `${messageCharacters
          .slice(0, ESCALATION_MESSAGE_LABEL_MAX_LENGTH - 1)
          .join('')
          .trimEnd()}…`
      : normalizedMessageLabel;
  const accessibleLabel = messageLabel.length > 0 ? `${label}: ${messageLabel}` : label;

  useEffect(() => {
    if (disabled) {
      clearActiveEscalateTarget(targetId);
    }
    return () => clearActiveEscalateTarget(targetId);
  }, [disabled, targetId]);

  return (
    <Ariakit.TooltipProvider placement="top" timeout={300}>
      <Ariakit.TooltipAnchor
        render={
          <button
            type="button"
            aria-label={accessibleLabel}
            aria-keyshortcuts={isActive ? ariaKey : undefined}
            data-escalate-steer={surface}
            data-escalate-steer-active={isActive ? 'true' : undefined}
            data-testid={surface === 'queued' ? 'queued-interrupt-now' : 'steer-escalate-now'}
            disabled={disabled}
            onPointerEnter={() => !disabled && updateActiveEscalateTarget('hover', targetId, true)}
            onPointerLeave={() => updateActiveEscalateTarget('hover', targetId, false)}
            onFocus={() => !disabled && updateActiveEscalateTarget('focus', targetId, true)}
            onBlur={() => updateActiveEscalateTarget('focus', targetId, false)}
            onClick={onClick}
            className={cn(
              'flex size-6 shrink-0 items-center justify-center rounded-full',
              'bg-text-primary text-surface-primary transition-opacity hover:opacity-85',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-xheavy',
              'disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:opacity-35',
            )}
          >
            <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.4} aria-hidden="true" />
          </button>
        }
      />
      <Ariakit.Tooltip className="z-50 rounded-lg bg-surface-tertiary px-2 py-1 text-xs text-text-primary shadow-lg">
        {chord && isActive ? `${label} · ${chord}` : label}
      </Ariakit.Tooltip>
    </Ariakit.TooltipProvider>
  );
}

/**
 * The overflow item that flips the Enter-during-run default. Shown as the
 * OPPOSITE of the current default (the action you would switch to), matching
 * the reference UX ("Turn on queueing" while steer is the default).
 */
export function useDefaultToggleEntry(steering: SteeringControls): MenuEntry {
  const localize = useLocalize();
  return useMemo(() => {
    const next = steering.defaultAction === 'steer' ? 'queue' : 'steer';
    return {
      key: 'toggle-default',
      label:
        next === 'queue'
          ? localize('com_ui_turn_on_queueing')
          : localize('com_ui_turn_on_steering'),
      icon: (
        <MorphIcon
          icon={next === 'queue' ? Clock : Zap}
          className={cn('h-4 w-4', next === 'queue' ? QUEUE_ICON : STEER_ICON)}
        />
      ),
      info: localize('com_nav_info_during_run_action'),
      onClick: () => steering.setDefaultAction(next),
    };
  }, [steering, localize]);
}

/**
 * The overflow item that flips whether a default steer interrupts generation
 * (`steerInterruptsByDefault`). Worded as the mode you would switch to, like
 * the queue/steer toggle above.
 */
export function useInterruptToggleEntry(): MenuEntry {
  const localize = useLocalize();
  const [interrupts, setInterrupts] = useRecoilState(store.steerInterruptsByDefault);
  const [defaultAction, setDefaultAction] = useRecoilState(store.duringRunDefaultAction);
  const interruptsByDefault = defaultAction === 'steer' && interrupts;
  return useMemo(
    () => ({
      key: 'toggle-interrupt',
      label: interruptsByDefault
        ? localize('com_ui_wait_for_tool_steps')
        : localize('com_ui_always_interrupt'),
      icon: (
        <MorphIcon
          icon={interruptsByDefault ? Zap : ZapOff}
          className={cn('h-4 w-4', STEER_ICON)}
        />
      ),
      info: localize(
        !interruptsByDefault && defaultAction === 'queue'
          ? 'com_ui_steer_interrupts_enable_info'
          : 'com_ui_steer_interrupts_default_info',
      ),
      onClick: () => {
        if (interruptsByDefault) {
          setInterrupts(false);
          return;
        }
        if (defaultAction === 'queue') {
          setDefaultAction('steer');
        }
        setInterrupts(true);
      },
    }),
    [defaultAction, interruptsByDefault, localize, setDefaultAction, setInterrupts],
  );
}
