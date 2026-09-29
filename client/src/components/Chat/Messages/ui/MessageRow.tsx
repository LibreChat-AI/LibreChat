import { Zap } from 'lucide-react';
import type { ReactNode } from 'react';
import MessageTimestamp from './MessageTimestamp';
import HeaderLabel from './HeaderLabel';
import { cn } from '~/utils';

type MessageRowProps = {
  id?: string;
  label: string;
  hoverLabel?: string | null;
  icon: ReactNode;
  children: ReactNode;
  footer: ReactNode;
  timestamp?: string | null;
  ariaLabel?: string;
  headerPrefix?: string;
  isCreatedByUser: boolean;
  hasParallelContent?: boolean;
  fullWidth?: boolean;
  isEditing?: boolean;
  /** Marks a host-authored turn (wake-up results, subagent triggers): it keeps
   *  the user's position and bubble shape, outlined instead of filled, under
   *  this visible heading in place of the author's name. */
  systemLabel?: string;
  className?: string;
};

export function getMessageRowWidthClass({
  fullWidth = false,
  hasParallelContent = false,
}: {
  fullWidth?: boolean;
  hasParallelContent?: boolean;
} = {}) {
  if (fullWidth) return 'w-full max-w-full sm:px-2';
  if (hasParallelContent) return 'w-full sm:px-2 md:max-w-[58rem] xl:max-w-[70rem]';
  return 'w-full sm:px-2 md:max-w-3xl xl:max-w-4xl';
}

export default function MessageRow({
  id,
  icon,
  label,
  hoverLabel,
  footer,
  children,
  timestamp,
  ariaLabel,
  className,
  headerPrefix,
  isCreatedByUser,
  hasParallelContent = false,
  fullWidth = false,
  isEditing = false,
  systemLabel,
}: MessageRowProps) {
  // Same column as ChatForm: max-width plus `sm:px-2`, so the body lines
  // up with the composer surface rather than the form's outer box.
  const widthClass = getMessageRowWidthClass({ fullWidth, hasParallelContent });
  const isSystem = systemLabel != null && systemLabel !== '';
  const isUserSide = isCreatedByUser || isSystem;

  return (
    <div
      id={id}
      role="group"
      aria-label={ariaLabel}
      className={cn(
        'message-render group mx-auto flex min-w-0 flex-1 font-theme-ui transition-[max-width] duration-theme-normal motion-reduce:transition-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-primary',
        isUserSide ? 'justify-end' : 'items-start',
        widthClass,
        className,
      )}
    >
      <div
        className={cn(
          'relative flex min-w-0 flex-col',
          isUserSide ? 'user-turn' : 'agent-turn',
          (hasParallelContent || isEditing) && 'w-full',
          !hasParallelContent &&
            isUserSide &&
            cn('ml-auto items-end', !isEditing && 'w-fit max-w-[90%] sm:max-w-[85%]'),
          !hasParallelContent && !isUserSide && !isEditing && 'flex-1',
        )}
      >
        {isSystem && (
          <h2 className="mb-1 flex select-none items-center gap-1.5 pr-1.5 text-xs font-medium uppercase tracking-wide text-text-secondary">
            <Zap size={12} aria-hidden="true" />
            {systemLabel}
            <span className="sr-only">
              <MessageTimestamp value={timestamp} />
            </span>
          </h2>
        )}
        {!hasParallelContent &&
          !isSystem &&
          (isCreatedByUser ? (
            <h2 className="sr-only">
              {headerPrefix}
              {label}
              <MessageTimestamp value={timestamp} />
            </h2>
          ) : (
            /** `mb-1` keeps the name off its own first line of body text. */
            <h2 className="mb-1 flex min-h-7 w-full select-none items-center gap-2 text-sm font-semibold text-text-primary">
              <span
                aria-hidden="true"
                className="flex size-6 flex-shrink-0 items-center justify-center overflow-hidden rounded-full"
              >
                {icon}
              </span>
              <span className="sr-only">{headerPrefix}</span>
              <HeaderLabel label={label} hoverLabel={hoverLabel} />
              <MessageTimestamp value={timestamp} className="ml-auto shrink-0 font-normal" />
            </h2>
          ))}

        <div className={cn('flex w-full flex-col gap-1', isUserSide && 'items-end')}>
          <div
            className={cn(
              'flex min-h-[20px] max-w-full flex-grow flex-col gap-0',
              isUserSide && !isEditing
                ? cn(
                    'w-fit rounded-theme-surface rounded-br-theme-control px-theme-normal',
                    isSystem ? 'border border-border-medium py-1.5' : 'bg-surface-tertiary py-2.5',
                  )
                : 'w-full',
            )}
            data-testid="message-body"
          >
            {children}
          </div>
          <div className={cn('w-full', isUserSide && 'flex justify-end')}>{footer}</div>
        </div>
      </div>
    </div>
  );
}
