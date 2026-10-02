import { createContext, useEffect, useState, useSyncExternalStore } from 'react';
import { CircleMinus } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import { ROW_GLYPH_SLOT } from './rows';
import { cn } from '~/utils';

/**
 * Whether a fold's rail is under the pointer. The rail lives in the panel and
 * the knob in the header, so the two share this tiny store instead of state on
 * the fold: hovering repaints the header's glyph, not every row under it.
 */
export type RailHover = {
  get: () => boolean;
  set: (hovered: boolean) => void;
  subscribe: (listener: () => void) => () => void;
};

export const FoldHeaderContext = createContext<{
  header: RefObject<HTMLDivElement>;
  expanded: boolean;
} | null>(null);

function createRailHover(): RailHover {
  let hovered = false;
  const listeners = new Set<() => void>();
  return {
    get: () => hovered,
    set: (next) => {
      if (next === hovered) {
        return;
      }
      hovered = next;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useRailHover(): RailHover {
  const [hover] = useState(createRailHover);
  return hover;
}

/** The header's glyph, swapped for a collapse knob while the fold's rail is
 *  hovered, so the reader sees which fold the rail closes before clicking. */
export function RailGlyph({ hover, children }: { hover: RailHover; children: ReactNode }) {
  const hovered = useSyncExternalStore(hover.subscribe, hover.get, hover.get);
  return (
    <span className={cn(ROW_GLYPH_SLOT, 'relative')} aria-hidden="true">
      <span className={cn('flex', hovered && 'invisible')}>{children}</span>
      {hovered && (
        <span
          className={cn(ROW_GLYPH_SLOT, 'text-text-primary absolute inset-y-0 left-0')}
          data-testid="fold-rail-knob"
        >
          <CircleMinus size={16} />
        </span>
      )}
    </span>
  );
}

/**
 * The hairline that hangs from an open header's glyph, drawn inside a hit area
 * the width of the panel's inset so the pointer only has to come near it. A
 * pointer shortcut only: the header button stays the one control keyboard and
 * screen-reader users reach, so the rail is hidden from both and never takes
 * focus. Must sit in a `FOLD_RAIL_CLASSES` wrapper, whose inset it fills.
 */
export function FoldRail({
  hover,
  expanded,
  onCollapse,
}: {
  hover: RailHover;
  expanded: boolean;
  onCollapse: () => void;
}) {
  /** Collapsed approval bodies stay mounted without a pointer leave. */
  useEffect(() => {
    if (!expanded) {
      hover.set(false);
    }
    return () => hover.set(false);
  }, [hover, expanded]);
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      disabled={!expanded}
      className="group/rail absolute inset-y-0 left-0 w-6 cursor-pointer disabled:pointer-events-none"
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={() => expanded && hover.set(true)}
      onMouseLeave={() => hover.set(false)}
      onClick={() => {
        hover.set(false);
        onCollapse();
      }}
      data-testid="fold-rail"
    >
      <span className="bg-border-medium group-hover/rail:bg-text-secondary absolute top-0.5 bottom-1.5 left-[11px] w-px transition-colors duration-150 motion-reduce:transition-none" />
    </button>
  );
}

/**
 * Collapsing from a rail far down a long fold would leave the reader below the
 * point where the fold now ends, so its header comes back into view first. A
 * pinned (sticky) header sits below its card's top; scrolling the card to the
 * start puts the header where it will rest once the rows are gone.
 */
export function revealFoldHeader(
  root: HTMLElement | null,
  header: HTMLElement | null,
  stickyHeader?: HTMLElement | null,
) {
  if (root == null || header == null || typeof root.scrollIntoView !== 'function') {
    return;
  }
  const pinned = root.getBoundingClientRect().top < header.getBoundingClientRect().top;
  const target = pinned ? root : header;
  const previousMargin = target.style.scrollMarginTop;
  /** The host message's scroll margin reserves its overlaid chat toolbar. */
  const message = root.closest('.message-render');
  const hostMargin =
    message == null ? 0 : parseFloat(getComputedStyle(message).scrollMarginTop) || 0;
  const targetMargin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
  target.style.scrollMarginTop = `${Math.max(
    targetMargin,
    hostMargin + (stickyHeader?.getBoundingClientRect().height ?? 0),
  )}px`;
  try {
    target.scrollIntoView({ block: pinned ? 'start' : 'nearest', behavior: 'instant' });
  } finally {
    target.style.scrollMarginTop = previousMargin;
  }
}
