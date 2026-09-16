import * as React from 'react';
import { X } from 'lucide-react';
import { cva } from 'class-variance-authority';
import type { ClassProp } from 'class-variance-authority/types';
import { IconButton } from './IconButton';
import { cn } from '~/utils';

type ChipVariantProps = {
  tone?: 'surface' | 'neutral' | 'info' | 'success' | 'warning' | 'error' | null;
  size?: 'sm' | 'md' | 'theme' | null;
  shape?: 'round' | 'theme' | null;
};

const chipVariants: (props?: ChipVariantProps & ClassProp) => string = cva(
  'inline-flex max-w-full items-center gap-1 border border-border-light text-xs font-medium transition-colors duration-theme-fast',
  {
    variants: {
      tone: {
        surface: 'border-border-light bg-surface-secondary text-text-secondary',
        neutral: 'border-status-neutral-border bg-status-neutral-subtle text-status-neutral',
        info: 'border-status-info-border bg-status-info-subtle text-status-info',
        success: 'border-status-success-border bg-status-success-subtle text-status-success',
        warning: 'border-status-warning-border bg-status-warning-subtle text-status-warning',
        error: 'border-status-error-border bg-status-error-subtle text-status-error',
      },
      size: {
        sm: 'min-h-6 px-2 py-0.5',
        md: 'min-h-8 px-2.5 py-1',
        theme: 'h-theme-control gap-theme-compact px-theme-normal',
      },
      shape: {
        round: 'rounded-full',
        theme: 'rounded-theme-control',
      },
    },
    defaultVariants: {
      tone: 'neutral',
      size: 'sm',
      shape: 'round',
    },
  },
);

export interface ChipProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'>,
    ChipVariantProps {
  children: React.ReactNode;
  onRemove?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  removeLabel?: string;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
}

const Chip: React.ForwardRefExoticComponent<ChipProps & React.RefAttributes<HTMLSpanElement>> =
  React.forwardRef<HTMLSpanElement, ChipProps>(
    (
      {
        children,
        className,
        leading,
        onRemove,
        removeLabel = 'Remove',
        shape,
        size,
        tone,
        trailing,
        ...props
      },
      ref,
    ) => (
      <span ref={ref} className={cn(chipVariants({ tone, size, shape, className }))} {...props}>
        {leading}
        <span className="min-w-0 truncate">{children}</span>
        {trailing}
        {onRemove && (
          <IconButton
            label={removeLabel}
            size="xs"
            shape={shape === 'theme' ? 'theme' : 'round'}
            className="hover:bg-surface-hover/50 -mr-1 text-current"
            onClick={(event) => {
              event.stopPropagation();
              onRemove(event);
            }}
          >
            <X className="size-3" aria-hidden="true" />
          </IconButton>
        )}
      </span>
    ),
  );

Chip.displayName = 'Chip';

export { Chip, chipVariants };
