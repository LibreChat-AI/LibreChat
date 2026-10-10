import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '~/utils';

/**
 * Swaps its content instantly and eases only its own height to the new
 * content's size. The single element that animates: wrap content that does not
 * animate its own height (for that, stack `Collapse`s instead), or the two
 * motions stack. Measures the fractional border-box height, so nothing is
 * clipped by rounding, and stays `auto` until the first measurement so mounting
 * does not animate. The clip box bleeds 4px past the content on every side, so
 * focus rings on the controls inside are not cut off.
 */
export default function AutoHeight({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const node = contentRef.current;
    if (node == null) {
      return;
    }
    const measure = () => {
      const next = node.getBoundingClientRect().height;
      setHeight((previous) => (previous === next ? previous : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className={cn(
        '-m-1 overflow-hidden transition-all duration-300 ease-out motion-reduce:transition-none',
        className,
      )}
      style={height == null ? undefined : { height }}
    >
      <div ref={contentRef} className="p-1">
        {children}
      </div>
    </div>
  );
}
