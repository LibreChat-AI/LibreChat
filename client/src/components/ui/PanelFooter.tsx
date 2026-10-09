import type { ReactNode } from 'react';
import { cn } from '~/utils';

/**
 * Footer pinned to the bottom of a side panel. Sits outside the panel's scroll
 * area as a non-shrinking flex child, so it stays put while the list scrolls.
 */
export default function PanelFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-end gap-2 border-t border-border-light bg-surface-primary-alt px-3 py-2',
        className,
      )}
    >
      {children}
    </div>
  );
}
