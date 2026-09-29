import React from 'react';
import { Check } from 'lucide';
import { MorphIcon, TooltipAnchor } from '@librechat/client';
import type { IconInput } from '@librechat/client';
import cn from '~/utils/cn';

interface ActionButtonProps {
  icon: IconInput;
  isActive: boolean;
  label: string;
  activeLabel: string;
  iconOnly?: boolean;
  onClick: () => void;
  tabIndex?: number;
  className?: string;
  portalElement?: HTMLElement | null;
}

const ActionButton = React.forwardRef<HTMLButtonElement, ActionButtonProps>(
  (
    {
      icon,
      isActive,
      label,
      activeLabel,
      iconOnly = false,
      onClick,
      tabIndex,
      className,
      portalElement,
    },
    ref,
  ) => {
    const currentLabel = isActive ? activeLabel : label;

    const button = (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        tabIndex={tabIndex}
        aria-label={currentLabel}
        className={cn(
          'inline-flex select-none items-center justify-center text-text-secondary transition-all duration-200 ease-out',
          'hover:bg-surface-hover hover:text-text-primary',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-heavy',
          iconOnly ? 'rounded-lg p-1.5' : 'ml-auto gap-2 rounded-md px-2 py-1',
          className,
        )}
      >
        <MorphIcon icon={isActive ? Check : icon} size={18} />
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
