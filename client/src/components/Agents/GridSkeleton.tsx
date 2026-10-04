import React, { useLayoutEffect, useRef, useState } from 'react';
import { Skeleton } from '@librechat/client';

/** Card height (`min-h-[17.5rem]` on AgentCard), resolved against the root font size. */
const CARD_REM = 17.5;
/** One request's worth of cards; a placeholder past the first page is never informative. */
const MAX_CARDS = 32;
/**
 * Share of a card that must clear the fold before its row is worth drawing. Below this
 * the row reads as a stray edge, so the viewport keeps the leftover space instead.
 */
const MIN_VISIBLE_CARD = 0.3;

interface GridSkeletonProps {
  scrollElementRef: React.RefObject<HTMLElement>;
  label: string;
}

const card = (
  <>
    <div className="flex items-start justify-between gap-3">
      <Skeleton className="size-12 rounded-full sm:size-14" />
      <Skeleton className="h-6 w-16 rounded-full" />
    </div>
    <Skeleton className="mt-4 h-6 w-3/4" />
    <div className="mt-3 mb-5 space-y-2">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
    </div>
    <div className="border-border-light mt-auto flex justify-between gap-3 border-t pt-4">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-4 w-20" />
    </div>
  </>
);

/**
 * Fills exactly the cards the scroll viewport can show: the grid's own resolved
 * column tracks times the rows that fit, so a phone renders a couple and a wide
 * desktop a full screen. Measured from layout rather than breakpoints, since the
 * marketplace shares its viewport with the resizable side panel.
 */
export default function GridSkeleton({ scrollElementRef, label }: GridSkeletonProps) {
  const [gridElement, setGridElement] = useState<HTMLDivElement | null>(null);
  const [count, setCount] = useState(0);
  const countRef = useRef(0);

  useLayoutEffect(() => {
    const frame = scrollElementRef.current;
    if (!gridElement || !frame) {
      return;
    }
    const measure = () => {
      const rect = gridElement.getBoundingClientRect();
      if (rect.width === 0) {
        return;
      }
      const style = getComputedStyle(gridElement);
      const gap = parseFloat(style.rowGap) || 0;
      const columns = Math.max(1, style.gridTemplateColumns.split(' ').length);
      const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const rowHeight = CARD_REM * rootFontSize + gap;
      const offset = Math.max(0, rect.top - frame.getBoundingClientRect().top);
      const visible = frame.clientHeight - offset;
      const cardHeight = CARD_REM * rootFontSize;
      const fullRows = Math.floor(visible / rowHeight);
      /** Row n's card spans [(n - 1) * rowHeight, + cardHeight]; keep a trailing one only
       *  when enough of it clears the fold to look like a card. */
      const trailing = Math.min(cardHeight, visible - fullRows * rowHeight);
      const rows = Math.max(1, fullRows + (trailing >= cardHeight * MIN_VISIBLE_CARD ? 1 : 0));
      const next = Math.min(MAX_CARDS, columns * rows);
      if (next !== countRef.current) {
        countRef.current = next;
        setCount(next);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(gridElement);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [gridElement, scrollElementRef]);

  return (
    <div role="status" aria-label={label}>
      <span className="sr-only">{label}</span>
      <div
        ref={setGridElement}
        aria-hidden="true"
        className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,max(20rem,calc((100%_-_3.75rem)/4))),1fr))] gap-5"
      >
        {Array.from({ length: count }, (_, index) => (
          <div
            key={index}
            className="border-border-light bg-surface-card rounded-theme-surface flex min-h-[17.5rem] min-w-0 flex-col border p-5"
          >
            {card}
          </div>
        ))}
      </div>
    </div>
  );
}
