import * as React from 'react';
import { X } from 'lucide-react';
import { IconButton } from './IconButton';
import { cn } from '~/utils';

type TagVariant = 'neutral' | 'info' | 'success' | 'warning' | 'error';

type TagProps = React.ComponentPropsWithoutRef<'div'> & {
  label: string;
  labelClassName?: string;
  CancelButton?: React.ReactNode;
  LabelNode?: React.ReactNode;
  variant?: TagVariant;
  onRemove?: (e: React.MouseEvent<HTMLButtonElement>) => void;
};

const TagPrimitiveRoot = React.forwardRef<HTMLDivElement, TagProps>(
  (
    {
      CancelButton,
      LabelNode,
      label,
      onRemove,
      className = '',
      labelClassName = '',
      variant = 'success',
      ...props
    },
    ref,
  ) => {
    const variantClassName = {
      neutral: 'border-status-neutral-border bg-status-neutral-subtle text-status-neutral',
      info: 'border-status-info-border bg-status-info-subtle text-status-info',
      success: 'border-status-success-border bg-status-success-subtle text-status-success',
      warning: 'border-status-warning-border bg-status-warning-subtle text-status-warning',
      error: 'border-status-error-border bg-status-error-subtle text-status-error',
    }[variant];

    return (
      <div
        ref={ref}
        {...props}
        className={cn(
          'flex max-h-8 items-center overflow-y-hidden rounded-3xl border-2 text-xs',
          variantClassName,
          className,
        )}
      >
        <div className={cn('ml-1 whitespace-pre-wrap px-2 py-1', labelClassName)}>
          {LabelNode ? <>{LabelNode} </> : null}
          {label}
        </div>
        {CancelButton
          ? CancelButton
          : onRemove && (
              <IconButton
                label={`Remove ${label}`}
                size="xs"
                className="mr-0.5 text-current hover:bg-surface-hover/50"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(e);
                }}
              >
                <X className="size-3" aria-hidden="true" />
              </IconButton>
            )}
      </div>
    );
  },
);

TagPrimitiveRoot.displayName = 'Tag';

export const Tag: React.MemoExoticComponent<
  React.ForwardRefExoticComponent<
    Omit<React.DetailedHTMLProps<React.HTMLAttributes<HTMLDivElement>, HTMLDivElement>, 'ref'> & {
      label: string;
      labelClassName?: string;
      CancelButton?: React.ReactNode;
      LabelNode?: React.ReactNode;
      variant?: TagVariant;
      onRemove?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    } & React.RefAttributes<HTMLDivElement>
  >
> = React.memo(TagPrimitiveRoot);
