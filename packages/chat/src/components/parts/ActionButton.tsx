import React from 'react';
import { Check } from 'lucide';
import { MorphIcon, TooltipAnchor, cn, disabledInkClasses } from '@librechat/client';
import type { IconInput } from '@librechat/client';

interface ActionButtonProps {
  icon: IconInput;
  isActive: boolean;
  label: string;
  activeLabel: string;
  iconOnly?: boolean;
  /** A smaller icon-only button for controls laid inside a tool panel. */
  compact?: boolean;
  onClick: () => void;
  tabIndex?: number;
  className?: string;
  portalElement?: HTMLElement | null;
  disabled?: boolean;
}

const ActionButton: React.ForwardRefExoticComponent<
  ActionButtonProps & React.RefAttributes<HTMLButtonElement>
> = React.forwardRef<HTMLButtonElement, ActionButtonProps>(
  (
    {
      icon,
      isActive,
      label,
      activeLabel,
      iconOnly = false,
      compact = false,
      onClick,
      tabIndex,
      className,
      portalElement,
      disabled = false,
    },
    ref,
  ) => {
    const currentLabel = isActive ? activeLabel : label;

    const button = (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        disabled={disabled}
        tabIndex={tabIndex}
        aria-label={currentLabel}
        className={cn(
          'text-text-secondary inline-flex items-center justify-center transition-all duration-200 ease-out select-none',
          'hover:bg-surface-hover hover:text-text-primary',
          'disabled:pointer-events-none',
          disabledInkClasses,
          'focus-visible:outline-focus-subtle focus-visible:outline focus-visible:outline-2',
          iconOnly && (compact ? 'rounded-md p-1' : 'rounded-lg p-1.5'),
          !iconOnly && 'ms-auto gap-2 rounded-md px-2 py-1',
          className,
        )}
      >
        <span
          className={cn(
            'relative flex items-center justify-center',
            compact ? 'size-3.5' : 'size-[1.125rem]',
          )}
          aria-hidden="true"
        >
          <MorphIcon icon={isActive ? Check : icon} size={compact ? '0.875rem' : '1.125rem'} />
        </span>
        {!iconOnly && (
          <span className="relative overflow-hidden">
            <span
              className={cn(
                'block transition-all duration-300 ease-out',
                isActive ? '-translate-y-full opacity-0' : 'translate-y-0 opacity-100',
              )}
            >
              {label}
            </span>
            <span
              className={cn(
                'absolute inset-0 transition-all duration-300 ease-out',
                isActive ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0',
              )}
            >
              {activeLabel}
            </span>
          </span>
        )}
      </button>
    );

    if (iconOnly) {
      return (
        <TooltipAnchor description={currentLabel} portalElement={portalElement} render={button} />
      );
    }

    return button;
  },
);

ActionButton.displayName = 'ActionButton';

export default ActionButton;
