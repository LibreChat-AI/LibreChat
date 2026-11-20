import { useId } from 'react';
import type { ReactNode } from 'react';
import { cn } from '~/utils';

/**
 * The head of a side panel, and the reason every panel reads the same way: a title,
 * the one thing this panel creates, then the field that narrows what is below.
 *
 * The title and the create action share a row so the search keeps the full width, and
 * the whole header stays out of the scroll. A panel with nothing to create passes no
 * `action`; a list short enough to read at a glance passes no `search`.
 *
 * `titleId` is handed back so the panel's landmark can point `aria-labelledby` at this
 * heading instead of repeating the same words in an `aria-label`, which a screen reader
 * would otherwise announce twice on entering the region.
 */
export default function PanelHeader({
  title,
  titleId,
  action,
  search,
  children,
  className,
}: {
  title: string;
  /** Pass the id the surrounding region references, so the two cannot drift. */
  titleId?: string;
  action?: ReactNode;
  search?: ReactNode;
  /** Controls that belong to this panel alone, below the search. */
  children?: ReactNode;
  className?: string;
}) {
  const fallbackId = useId();

  return (
    <div className={cn('shrink-0 space-y-2 px-3 pb-2', className)}>
      <div className="flex h-9 items-center justify-between gap-2">
        <h2 id={titleId ?? fallbackId} className="text-text-primary truncate text-sm font-medium">
          {title}
        </h2>
        {action}
      </div>
      {search}
      {children}
    </div>
  );
}
