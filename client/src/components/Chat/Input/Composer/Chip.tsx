import { memo } from 'react';
import { Chip as SharedChip } from '@librechat/client';
import type { ReactNode } from 'react';

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
      shape="theme"
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
      className={className}
    >
      <span className="text-sm font-normal">{label}</span>
    </SharedChip>
  );
}

export default memo(Chip);
