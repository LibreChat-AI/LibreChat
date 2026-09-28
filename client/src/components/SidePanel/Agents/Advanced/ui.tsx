import {
  Button,
  Switch,
  HoverCard,
  CircleHelpIcon,
  HoverCardPortal,
  HoverCardContent,
  HoverCardTrigger,
} from '@librechat/client';
import type { ReactNode } from 'react';
import { useLocalize } from '~/hooks';
import { ESide } from '~/common';

/** Prominent heading for a top-level settings group (Essentials, Orchestration). */
export const groupHeadingClass = 'text-sm font-semibold text-text-primary';

/** Small count chip, e.g. "2 / 10". */
export function CountPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-4 items-center justify-center whitespace-nowrap rounded-full bg-surface-tertiary px-1.5 text-[10px] font-medium tabular-nums text-text-secondary">
      {children}
    </span>
  );
}

/**
 * "Beta" accent pill.
 *
 * Semantic `brand-purple` rather than the raw purple ramp: the label renders at
 * 10px on a tinted fill, so it has to keep clearing the text floor on every
 * canvas, and `purple-600/40` edges sit at 1.89:1 on the high contrast light
 * page. A palette utility does not move when the theme does.
 */
export function BetaPill() {
  const localize = useLocalize();
  return (
    <span className="rounded-full border border-brand-purple/40 bg-brand-purple/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-brand-purple">
      {localize('com_ui_beta')}
    </span>
  );
}

/**
 * Focusable help trigger for an info HoverCard. Must be rendered inside a
 * `HoverCard` so the popover opens on hover or keyboard focus.
 */
export function InfoTrigger() {
  const localize = useLocalize();
  return (
    <HoverCardTrigger asChild>
      <Button
        variant="ghost"
        aria-label={localize('com_ui_more_info')}
        className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded p-0 text-text-tertiary transition-colors hover:bg-transparent hover:text-text-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-text-primary"
      >
        <CircleHelpIcon className="h-3.5 w-3.5" aria-hidden={true} />
      </Button>
    </HoverCardTrigger>
  );
}

interface ToggleSettingProps {
  id: string;
  label: string;
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  /** Optional explanation shown in a `?` popover next to the label. */
  info?: ReactNode;
}

/**
 * A subordinate on/off setting: a small secondary label, an optional info
 * popover, and a switch on the right. Sits below a pattern title without
 * competing with it for visual weight.
 */
export function ToggleSetting({ id, label, checked, onCheckedChange, info }: ToggleSettingProps) {
  const row = (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-1.5">
        <label htmlFor={id} className="truncate text-[13px] font-medium text-text-primary">
          {label}
        </label>
        {info != null && <InfoTrigger />}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} aria-label={label} />
    </div>
  );

  if (info == null) {
    return row;
  }

  return (
    <HoverCard openDelay={50}>
      {row}
      <HoverCardPortal>
        <HoverCardContent side={ESide.Top} className="w-80">
          <div className="space-y-2 text-sm text-text-secondary">{info}</div>
        </HoverCardContent>
      </HoverCardPortal>
    </HoverCard>
  );
}
