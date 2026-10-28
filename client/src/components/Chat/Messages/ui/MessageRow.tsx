import { Zap } from 'lucide-react';
import { ContentTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import MessageTimestamp from './MessageTimestamp';
import { getMessageRowWidthClass } from './width';
import HeaderLabel from './HeaderLabel';
import Files from '../Content/Files';
import { cn } from '~/utils';

type MessageRowProps = {
  id?: string;
  message?: TMessage;
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
  /** Marks a host-authored turn with no author to name (background-tool
   *  wake-ups, external events): it uses the transcript side without a bubble,
   *  under this visible heading. */
  systemLabel?: string;
  /** A user-side turn written by someone other than the reader — a parent agent
   *  briefing its subagent, a subagent reporting back. It keeps the user's
   *  position and bubble, under the same avatar-and-name header an agent turn
   *  carries. */
  showAuthor?: boolean;
  /** Outline the user-side bubble instead of filling it: content the host
   *  delivered rather than words someone typed. */
  outlined?: boolean;
  className?: string;
};

/** `mb-1` keeps the name off its own first line of body text. Static per side:
 *  every agent row in a thread renders one, so it is never merged at runtime. */
const authorHeaderClasses = {
  start:
    'text-text-primary mb-1 flex min-h-7 w-full items-center gap-2 text-sm font-semibold select-none',
  end: 'text-text-primary mb-1 flex min-h-7 items-center justify-end gap-2 text-sm font-semibold select-none',
} as const;

/** The author line every visible-author turn shares, so an agent's turn and an
 *  agent-written user-side turn cannot drift apart. A render helper rather than
 *  a component, so a main chat row's tree stays exactly as deep as before. */
function renderAuthorHeader({
  icon,
  label,
  hoverLabel,
  headerPrefix,
  timestamp,
  align,
}: Pick<MessageRowProps, 'icon' | 'label' | 'hoverLabel' | 'headerPrefix' | 'timestamp'> & {
  align: 'start' | 'end';
}) {
  return (
    <h2 className={authorHeaderClasses[align]}>
      {align === 'end' && (
        <MessageTimestamp value={timestamp} className="me-auto shrink-0 font-normal" />
      )}
      <span
        aria-hidden="true"
        className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full"
      >
        {icon}
      </span>
      <span className="sr-only">{headerPrefix}</span>
      <HeaderLabel label={label} hoverLabel={hoverLabel} />
      {align === 'start' && (
        <MessageTimestamp value={timestamp} className="ms-auto shrink-0 font-normal" />
      )}
    </h2>
  );
}

export default function MessageRow({
  id,
  message,
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
  showAuthor = false,
  outlined = false,
}: MessageRowProps) {
  // Same column as ChatForm: max-width plus `sm:px-2`, so the body lines
  // up with the composer surface rather than the form's outer box.
  const widthClass = getMessageRowWidthClass({ fullWidth, hasParallelContent });
  const isSystem = systemLabel != null && systemLabel !== '';
  const isUserSide = isCreatedByUser && !isSystem;
  const hasFiles = isUserSide && !isEditing && (message?.files?.length ?? 0) > 0;
  const hasBody =
    !hasFiles ||
    Boolean(
      message?.text?.trim() ||
        message?.content?.some(
          (part) =>
            part != null &&
            (part.type !== ContentTypes.TEXT ||
              (typeof part.text === 'string' ? part.text : part.text?.value)?.trim()),
        ) ||
        message?.privacyRevision ||
        message?.error ||
        message?.unfinished ||
        message?.quotes?.length ||
        message?.alwaysAppliedSkills?.length ||
        message?.manualSkills?.length,
    );

  return (
    <div
      id={id}
      role="group"
      aria-label={ariaLabel}
      className={cn(
        'message-render group font-theme-ui duration-theme-normal mx-auto flex min-w-0 flex-1 transition-[max-width] motion-reduce:transition-none',
        'focus-visible:ring-text-primary focus-visible:ring-2 focus-visible:outline-hidden',
        isUserSide ? 'justify-end' : 'items-start',
        widthClass,
        className,
      )}
    >
      <div
        data-system-turn={isSystem || undefined}
        className={cn(
          'relative flex min-w-0 flex-col',
          isUserSide && 'user-turn',
          !isUserSide && !isSystem && 'agent-turn',
          (hasParallelContent || isEditing) && 'w-full',
          !hasParallelContent &&
            isUserSide &&
            cn('ms-auto items-end', !isEditing && 'w-fit max-w-[90%] sm:max-w-[85%]'),
          !hasParallelContent && !isUserSide && !isEditing && 'flex-1',
        )}
      >
        {isSystem && (
          <h2 className="text-text-secondary mb-1 flex items-center gap-1.5 pe-1.5 text-xs font-medium select-none">
            <Zap size={12} aria-hidden="true" />
            {systemLabel}
            <span className="sr-only">
              <MessageTimestamp value={timestamp} />
            </span>
          </h2>
        )}
        {!hasParallelContent && !isSystem && isCreatedByUser && !showAuthor && (
          <h2 className="sr-only">
            {headerPrefix}
            {label}
            <MessageTimestamp value={timestamp} />
          </h2>
        )}
        {!hasParallelContent &&
          !isSystem &&
          (!isCreatedByUser || showAuthor) &&
          renderAuthorHeader({
            icon,
            label,
            hoverLabel,
            headerPrefix,
            timestamp,
            align: isCreatedByUser ? 'end' : 'start',
          })}

        <div className={cn('flex w-full flex-col gap-1', isUserSide && 'items-end')}>
          {hasFiles && (
            <div
              data-testid="message-attachments"
              className="flex max-w-full flex-col items-end gap-3 pb-2"
            >
              <Files message={message} />
            </div>
          )}
          {hasBody && (
            <div
              className={cn(
                'flex min-h-[1.25rem] max-w-full grow flex-col gap-0',
                isUserSide && !isEditing
                  ? cn(
                      'rounded-theme-surface rounded-ee-theme-control px-theme-normal w-fit',
                      isSystem || outlined
                        ? 'border-border-medium border py-1.5'
                        : 'bg-surface-user-message py-2.5',
                    )
                  : 'w-full',
              )}
              data-testid="message-body"
            >
              {children}
            </div>
          )}
          <div className={cn('w-full', isUserSide && 'flex justify-end')}>{footer}</div>
        </div>
      </div>
    </div>
  );
}
