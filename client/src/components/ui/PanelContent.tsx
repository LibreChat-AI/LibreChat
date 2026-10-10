import React from 'react';
import type { ReactNode } from 'react';
import { useLocalize, useScrollFade } from '~/hooks';
import { cn } from '~/utils';

/**
 * Scrolling content region of a side panel, and the single place that decides
 * which state to draw. Pass the query's `isLoading` rather than `isFetching`:
 * a refetch that already has rows on screen should leave them alone instead of
 * replacing them with a skeleton.
 *
 * Forwards a ref to the scroll container so panels that fetch on scroll can
 * attach their listener.
 */
const PanelContent = React.forwardRef<
  HTMLDivElement,
  {
    isLoading: boolean;
    isEmpty?: boolean;
    /** Shaped like the rows it stands in for */
    skeleton: ReactNode;
    empty?: ReactNode;
    children?: ReactNode;
    className?: string;
  }
>(({ isLoading, isEmpty, skeleton, empty, children, className }, ref) => {
  const localize = useLocalize();
  const { attach, hasMore } = useScrollFade<HTMLDivElement>();

  /** The caller's ref and the fade's both need the same node. */
  const setNode = React.useCallback(
    (node: HTMLDivElement | null) => {
      attach(node);
      if (typeof ref === 'function') {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    },
    [attach, ref],
  );

  const renderContent = () => {
    if (isLoading) {
      /** Skeleton rows are decorative, so a live region carries the announcement */
      return (
        <>
          <span className="sr-only" aria-live="polite" aria-atomic="true">
            {localize('com_ui_loading')}
          </span>
          {skeleton}
        </>
      );
    }
    if (isEmpty === true && empty != null) {
      return empty;
    }
    return children;
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={setNode}
        aria-busy={isLoading}
        className={cn('min-h-0 flex-1 overflow-y-auto', className)}
      >
        {renderContent()}
      </div>
      {/* The last row fades rather than being cut off, so a list that continues
          below the fold says so without a scrollbar having to appear. */}
      <div
        aria-hidden="true"
        className={cn(
          'from-surface-primary-alt pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t to-transparent transition-opacity duration-200 motion-reduce:transition-none',
          hasMore ? 'opacity-100' : 'opacity-0',
        )}
      />
    </div>
  );
});

PanelContent.displayName = 'PanelContent';

export default PanelContent;
