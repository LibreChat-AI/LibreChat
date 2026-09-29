import { Button, TooltipAnchor } from '@librechat/client';
import type { LucideIcon } from 'lucide-react';
import { cn } from '~/utils';

interface OptionToggleProps {
  icon: LucideIcon;
  pressed: boolean;
  label: string;
  /** Defaults to `label` (bulk toggles use the same text for both). */
  tooltip?: string;
  /** Semantic series border applied to the pressed button. */
  activeBorderClass: string;
  onToggle: () => void;
  size?: 'sm' | 'md';
  /**
   * Renders the toggle inert (dimmed, non-interactive) while keeping it
   * visible with its tooltip, so the user can learn WHY the option is
   * unavailable instead of it silently disappearing.
   */
  disabled?: boolean;
}

/**
 * Icon toggle for a per-tool option (defer / programmatic / background /
 * intent), shared between the per-tool row (`sm`) and the section-header bulk
 * action (`md`).
 */
export default function OptionToggle({
  icon: Icon,
  pressed,
  label,
  tooltip,
  activeBorderClass,
  onToggle,
  size = 'sm',
  disabled = false,
}: OptionToggleProps) {
  /**
   * Pressed and disabled compose rather than override each other: a tool the
   * user switched to programmatic-only keeps its stored Intent state, and
   * `aria-pressed` keeps reporting it, so the control has to keep looking
   * pressed. Collapsing to the unpressed treatment would hide a setting that
   * becomes active again the moment programmatic mode is lifted.
   */
  let stateClass: string;
  if (pressed) {
    stateClass = cn(
      activeBorderClass,
      'bg-surface-active text-text-primary',
      disabled
        ? 'cursor-not-allowed opacity-60 hover:bg-surface-active hover:text-text-primary'
        : 'hover:bg-surface-active-alt hover:text-text-primary',
    );
  } else if (disabled) {
    stateClass =
      'cursor-not-allowed border-transparent text-text-tertiary opacity-60 hover:bg-transparent hover:text-text-tertiary';
  } else {
    stateClass =
      'border-transparent text-text-secondary hover:bg-surface-hover hover:text-text-secondary';
  }

  return (
    <TooltipAnchor
      description={tooltip ?? label}
      side="top"
      render={
        <Button
          variant="ghost"
          size="icon"
          onClick={disabled ? undefined : onToggle}
          aria-pressed={pressed}
          aria-label={label}
          aria-disabled={disabled || undefined}
          className={cn('rounded-md border', size === 'sm' ? 'size-6' : 'size-7', stateClass)}
        >
          <Icon className="size-4" aria-hidden="true" />
        </Button>
      }
    />
  );
}
