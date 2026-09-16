import { memo } from 'react';
import { Chip as SharedChip } from '@librechat/client';
import type { ReactNode } from 'react';
import { cn } from '~/utils';

export interface ChipProps {
  label: string;
  /** Full text for the native tooltip when `label` is truncated. */
  title?: string;
  icon?: ReactNode;
  /** Rendered between the label and the remove button. */
  trailing?: ReactNode;
  onRemove?: () => void;
  removeLabel?: string;
  className?: string;
  'data-testid'?: string;
}

function Chip({
  label,
  title,
  icon,
  trailing,
  onRemove,
  removeLabel,
  className,
  'data-testid': testId,
}: ChipProps) {
  return (
    <SharedChip
      role="listitem"
      data-testid={testId}
      tone="surface"
      size="md"
      title={title ?? label}
      leading={
        icon != null ? (
          <span className="flex shrink-0 items-center" aria-hidden="true">
            {icon}
          </span>
        ) : undefined
      }
      trailing={trailing}
      onRemove={onRemove}
      removeLabel={removeLabel}
      className={cn('gap-1.5 rounded-xl text-sm font-normal', className)}
    >
      {label}
    </SharedChip>
  );
}

export default memo(Chip);
