import { createContext, useEffect, useState, useSyncExternalStore } from 'react';
import { CircleMinus } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import { ROW_GLYPH_SLOT, FOLD_GLYPH_SELECTOR } from './rows';
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
      data-fold-rail=""
    >
      <span className="bg-border-medium group-hover/rail:bg-text-secondary absolute top-0.5 bottom-1.5 left-[11px] w-px transition-colors duration-150 motion-reduce:transition-none" />
      {/* The lit path (`useFoldPath`): from the header down to the hovered row, turning
          into that row when it is this fold's own. */}
      <span
        className="border-text-secondary pointer-events-none absolute top-0.5 left-[11px] h-(--fold-lit) border-l opacity-0 transition-opacity duration-150 group-data-fold-lit/rail:opacity-100 group-data-[fold-lit=end]/rail:w-2 group-data-[fold-lit=end]/rail:rounded-bl-md group-data-[fold-lit=end]/rail:border-b motion-reduce:transition-none"
        data-testid="fold-rail-path"
      />
    </button>
  );
}

const FOLD_PANEL = '[data-fold-panel]';
const FOLD_RAIL = '[data-fold-rail]';
const FOLD_ROOT = '[data-fold-root]';
const FOLD_COLUMN = '[data-fold-column]';
/** A row's glyph is 20px tall inside a 32px line, so the pointer is on that row from
 *  the margin above the glyph down to the next row's margin. */
const ROW_REACH = 6;

export type LitRail = { rail: HTMLElement; length: number; end: boolean };

/** The glyph at `y` in one panel or column, or the nearest above an open body.
 *  Within that scope, document order is vertical order. */
function glyphAt(
  panel: Element,
  scope: Element,
  y: number,
  glyphsByPanel: WeakMap<Element, Element[]>,
): Element | null {
  let glyphs = glyphsByPanel.get(scope);
  if (glyphs == null) {
    glyphs = [];
    for (const glyph of scope.querySelectorAll(FOLD_GLYPH_SELECTOR)) {
      const column = glyph.closest(FOLD_COLUMN);
      const glyphScope = column != null && panel.contains(column) ? column : panel;
      if (glyph.closest(FOLD_PANEL) === panel && glyphScope === scope) {
        glyphs.push(glyph);
      }
    }
    glyphsByPanel.set(scope, glyphs);
  }
  let found: Element | null = null;
  let low = 0;
  let high = glyphs.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (glyphs[mid].getBoundingClientRect().top - ROW_REACH <= y) {
      found = glyphs[mid];
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * The rails to light for a pointer at `y` over `target`: one per fold that holds the
 * row under it, innermost first, each `length` px from its top to that row's center.
 * Empty over a rail itself, whose own hover shows what it collapses, and over any
 * header that no fold of `root` holds.
 */
export function litFoldPath(
  root: Element,
  target: Element,
  y: number,
  glyphsByPanel = new WeakMap<Element, Element[]>(),
): LitRail[] {
  if (target.closest(FOLD_RAIL) != null) {
    return [];
  }
  const innermost = target.closest(FOLD_PANEL);
  if (innermost == null || !root.contains(innermost)) {
    return [];
  }
  const column = target.closest(FOLD_COLUMN);
  const scope = column != null && innermost.contains(column) ? column : innermost;
  const glyph = glyphAt(innermost, scope, y, glyphsByPanel);
  if (glyph == null) {
    return [];
  }
  const { top, height } = glyph.getBoundingClientRect();
  const center = top + height / 2;
  const path: LitRail[] = [];
  let panel: Element | null = innermost;
  while (panel != null && root.contains(panel)) {
    const rail = panel.querySelector<HTMLElement>(`:scope > ${FOLD_RAIL}`);
    if (rail != null) {
      /** The path starts where the rail's own line does, 2px below the panel. */
      const length = Math.round(center - rail.getBoundingClientRect().top) - 2;
      path.push({ rail, length: Math.max(length, 0), end: path.length === 0 });
    }
    panel = panel.parentElement?.closest(FOLD_PANEL) ?? null;
  }
  return path;
}

function paintFoldPath(previous: LitRail[], next: LitRail[]) {
  for (const { rail } of previous) {
    if (!next.some((lit) => lit.rail === rail)) {
      delete rail.dataset.foldLit;
      rail.style.removeProperty('--fold-lit');
    }
  }
  for (const { rail, length, end } of next) {
    const kind = end ? 'end' : 'through';
    if (rail.dataset.foldLit !== kind) {
      rail.dataset.foldLit = kind;
    }
    const value = `${length}px`;
    if (rail.style.getPropertyValue('--fold-lit') !== value) {
      rail.style.setProperty('--fold-lit', value);
    }
  }
}

/**
 * Lights the path from every fold that holds the hovered row down to that row, so its
 * depth reads as the number of lit rails. One listener on the outermost fold, and the
 * rails are written to directly: moving the pointer repaints rails, never rows. A fold
 * nested in another leaves the work to that one. `hasBody` re-arms it once the fold's
 * panel, and with it the root, has rendered.
 */
export function useFoldPath(rootRef: RefObject<HTMLElement>, hasBody: boolean) {
  useEffect(() => {
    const root = rootRef.current;
    if (!hasBody || root == null || root.parentElement?.closest(FOLD_ROOT) != null) {
      return;
    }
    let glyphsByPanel = new WeakMap<Element, Element[]>();
    let lit: LitRail[] = [];
    let frame = 0;
    let rehit = false;
    let pointer: { target: Element; x: number; y: number } | null = null;
    const paint = () => {
      frame = 0;
      if (pointer == null) {
        return;
      }
      const target = rehit ? document.elementFromPoint(pointer.x, pointer.y) : pointer.target;
      rehit = false;
      if (target == null || !root.contains(target)) {
        clear();
        return;
      }
      const next = litFoldPath(root, target, pointer.y, glyphsByPanel);
      paintFoldPath(lit, next);
      lit = next;
    };
    const clear = () => {
      pointer = null;
      rehit = false;
      cancelAnimationFrame(frame);
      frame = 0;
      paintFoldPath(lit, []);
      lit = [];
    };
    const onMove = (event: PointerEvent) => {
      /** A tap has no hover to follow, and would leave the path lit under the finger. */
      if (event.pointerType === 'touch' || !(event.target instanceof Element)) {
        return;
      }
      pointer = { target: event.target, x: event.clientX, y: event.clientY };
      if (frame === 0) {
        frame = requestAnimationFrame(paint);
      }
    };
    const onScroll = () => {
      /** Scroll events can arrive after a fresh move but before its queued paint. */
      if (frame !== 0) {
        rehit = true;
        return;
      }
      clear();
    };
    const mutations = new MutationObserver((records) => {
      let changed = false;
      let structureChanged = false;
      for (const record of records) {
        /** Painting the rail's own style does not change row geometry. */
        if (
          record.type === 'attributes' &&
          record.attributeName === 'style' &&
          record.target instanceof Element &&
          record.target.matches(FOLD_RAIL)
        ) {
          continue;
        }
        changed = true;
        structureChanged ||= record.type === 'childList' || record.type === 'attributes';
      }
      if (structureChanged) {
        glyphsByPanel = new WeakMap();
      }
      if (changed) {
        clear();
      }
    });
    mutations.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'open', 'data-fold-panel', 'data-fold-column'],
    });
    const resize = new ResizeObserver(clear);
    /** Earlier messages can move this fold without resizing it. */
    for (
      let ancestor: HTMLElement | null = root;
      ancestor != null;
      ancestor = ancestor.parentElement
    ) {
      resize.observe(ancestor);
    }
    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerleave', clear);
    root.addEventListener('pointerdown', clear);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', clear);
    return () => {
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerleave', clear);
      root.removeEventListener('pointerdown', clear);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', clear);
      mutations.disconnect();
      resize.disconnect();
      clear();
    };
  }, [rootRef, hasBody]);
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
