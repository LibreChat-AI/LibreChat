import {
  useRef,
  useState,
  useEffect,
  createContext,
  useLayoutEffect,
  useSyncExternalStore,
} from 'react';
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
          className={cn(ROW_GLYPH_SLOT, 'text-text-primary absolute inset-y-0 inset-s-0')}
          data-testid="fold-rail-knob"
        >
          <CircleMinus size={16} />
        </span>
      )}
    </span>
  );
}

const FOLD_PANEL = '[data-fold-panel]';
const FOLD_RAIL = '[data-fold-rail]';
const FOLD_ROOT = '[data-fold-root]';
const FOLD_COLUMN = '[data-fold-column]';
/** A row's glyph is 20px tall inside a 32px line, so the pointer is on that row from
 *  the margin above the glyph down to the next row's margin. */
const ROW_REACH = 6;

/** The row glyphs of one panel or column, in document order, which within that scope
 *  is vertical order. Rows of nested folds belong to those folds. */
function glyphsIn(panel: Element, scope: Element): Element[] {
  const glyphs: Element[] = [];
  for (const glyph of scope.querySelectorAll(FOLD_GLYPH_SELECTOR)) {
    if (glyph.closest(FOLD_PANEL) === panel && scopeOf(panel, glyph) === scope) {
      glyphs.push(glyph);
    }
  }
  return glyphs;
}

/** The column of `panel` that holds `node`, or the panel itself. */
function scopeOf(panel: Element, node: Element): Element {
  const column = node.closest(FOLD_COLUMN);
  return column != null && panel.contains(column) ? column : panel;
}

/** Branch geometry in the rail's 24px inset: the trunk under the header glyph's
 *  center, an elbow of `BRANCH_RADIUS` and a stub that stops short of the row's glyph. */
const TRUNK_X = 11.5;
const TRUNK_TOP = 2;
const BRANCH_RADIUS = 8;
const BRANCH_END = 22;

/** Where a row's branch leaves the trunk: one radius above the row's center. */
function branchStart(center: number) {
  return center - Math.max(Math.min(BRANCH_RADIUS, center - TRUNK_TOP), 0);
}

/** The curve from the trunk into the row, continuing a path already at `branchStart`. */
function elbow(center: number) {
  const r = center - branchStart(center);
  return `A ${r} ${r} 0 0 0 ${TRUNK_X + r} ${center} H ${BRANCH_END}`;
}

function sameCenters(a: number[], b: number[]) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** Vertical centers of the panel's own row glyphs, relative to the rail's top. */
function useBranchCenters(railRef: RefObject<HTMLButtonElement>) {
  const [centers, setCenters] = useState<number[]>([]);
  useLayoutEffect(() => {
    const rail = railRef.current;
    const panel = rail?.parentElement;
    if (rail == null || panel == null || !panel.matches(FOLD_PANEL)) {
      return;
    }
    const measure = () => {
      const top = rail.getBoundingClientRect().top;
      const next = glyphsIn(panel, panel).map((glyph) => {
        const rect = glyph.getBoundingClientRect();
        return Math.round(rect.top + rect.height / 2 - top);
      });
      setCenters((previous) => (sameCenters(previous, next) ? previous : next));
    };
    measure();
    /** Rows arriving or a nested fold opening resize the panel or the wrapper that holds
     *  the rows; that is when branches move. A panel's own height can be pinned while it
     *  animates, so its children are watched too, including ones mounted later. */
    const resize = new ResizeObserver(measure);
    const observeChildren = () => {
      for (const child of panel.children) {
        resize.observe(child);
      }
    };
    resize.observe(panel);
    observeChildren();
    const children = new MutationObserver(() => {
      observeChildren();
      measure();
    });
    children.observe(panel, { childList: true });
    return () => {
      resize.disconnect();
      children.disconnect();
    };
  }, [railRef]);
  return centers;
}

/**
 * The trunk that hangs from an open header's glyph and branches into each of its
 * rows, drawn inside a hit area the width of the panel's inset so the pointer only
 * has to come near it. A panel without rows of its own (parallel columns) keeps a
 * plain hairline. A pointer shortcut only: the header button stays the one control
 * keyboard and screen-reader users reach, so the rail is hidden from both and never
 * takes focus. Must sit in a `FOLD_RAIL_CLASSES` wrapper, whose inset it fills.
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
  const railRef = useRef<HTMLButtonElement>(null);
  const centers = useBranchCenters(railRef);
  /** Collapsed approval bodies stay mounted without a pointer leave. */
  useEffect(() => {
    if (!expanded) {
      hover.set(false);
    }
    return () => hover.set(false);
  }, [hover, expanded]);
  const last = centers[centers.length - 1];
  return (
    <button
      ref={railRef}
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      disabled={!expanded}
      className="group/rail absolute inset-y-0 inset-s-0 w-6 cursor-pointer disabled:pointer-events-none"
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={() => expanded && hover.set(true)}
      onMouseLeave={() => hover.set(false)}
      onClick={() => {
        hover.set(false);
        onCollapse();
      }}
      data-testid="fold-rail"
      data-fold-rail=""
      data-centers={centers.join(',')}
    >
      {last == null ? (
        <span className="bg-border-medium group-hover/rail:bg-text-secondary absolute inset-s-[11px] top-0.5 bottom-1.5 w-px transition-colors duration-150 motion-reduce:transition-none" />
      ) : (
        <svg
          className={cn(
            'pointer-events-none absolute inset-0 size-full overflow-visible rtl:-scale-x-100',
            'transition-opacity motion-reduce:transition-none',
            expanded ? 'opacity-100 delay-100 duration-250' : 'opacity-0 duration-200',
          )}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          data-testid="fold-rail-tree"
        >
          <g className="stroke-border-medium group-hover/rail:stroke-text-secondary transition-colors duration-150 motion-reduce:transition-none">
            <path d={`M ${TRUNK_X} ${TRUNK_TOP} V ${branchStart(last)}`} />
            {centers.map((center, i) => (
              <path key={i} d={`M ${TRUNK_X} ${branchStart(center)} ${elbow(center)}`} />
            ))}
          </g>
          {/* The lit path (`useFoldPath`): one trunk-and-elbow whose foot slides to the
              hovered row (`traceTo`), so it always travels the route between rows. */}
          <path
            className="stroke-text-secondary opacity-0 transition-opacity duration-150 data-lit:opacity-100 motion-reduce:transition-none"
            data-fold-trace=""
            data-testid="fold-rail-path"
          />
        </svg>
      )}
    </button>
  );
}

/** A fold to light: the rail and the index of its own row the path ends in. */
export type LitRail = { rail: HTMLElement; branch: number };

/** The glyph at `y` in one panel or column, or the nearest above an open body. */
function glyphAt(
  panel: Element,
  scope: Element,
  y: number,
  glyphsByPanel: WeakMap<Element, Element[]>,
): { glyph: Element; index: number } | null {
  let glyphs = glyphsByPanel.get(scope);
  if (glyphs == null) {
    glyphs = glyphsIn(panel, scope);
    glyphsByPanel.set(scope, glyphs);
  }
  let found = -1;
  let low = 0;
  let high = glyphs.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (glyphs[mid].getBoundingClientRect().top - ROW_REACH <= y) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found < 0 ? null : { glyph: glyphs[found], index: found };
}

/**
 * The rails to light for a pointer at `y` over `target`: one per fold that holds the
 * row under it, innermost first, each ending in the branch of its own row that leads
 * there (for an outer fold, the header of the nested one). Rows inside a parallel
 * column have no branch, so their fold stays dark. Empty over a rail itself, whose own
 * hover shows what it collapses, and over any header that no fold of `root` holds.
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
  const path: LitRail[] = [];
  let node: Element = target;
  let panel: Element | null = innermost;
  while (panel != null && root.contains(panel)) {
    const scope = scopeOf(panel, node);
    const rail = panel.querySelector<HTMLElement>(`:scope > ${FOLD_RAIL}`);
    const hit = glyphAt(panel, scope, y, glyphsByPanel);
    if (rail != null && hit != null && scope === panel) {
      path.push({ rail, branch: hit.index });
    }
    node = panel;
    panel = panel.parentElement?.closest(FOLD_PANEL) ?? null;
  }
  return path;
}

/**
 * A rail's lit path while it is shown. It only ever lies on the drawn tree: the trunk
 * from the top down to `tip`, then, once the tip rests on a branch point, `elbow` px
 * of that row's branch (centered at `center`).
 */
type Trace = {
  path: SVGPathElement;
  branch: number;
  center: number;
  tip: number;
  elbow: number;
  move: TraceMove | null;
  frame: number;
  fade: number;
};

/** One trip along the tree: back out of the current branch, along the trunk, into the next. */
type TraceMove = {
  from: { center: number; tip: number; elbow: number };
  branch: number;
  center: number;
  retract: number;
  travel: number;
  /** How much of the new row's branch is already drawn when the trip starts. */
  extendFrom: number;
  total: number;
  duration: number;
  start: number | null;
};

const traces = new WeakMap<HTMLElement, Trace>();
/** The pace along the tree, bounded so a hop to the next row and a long run both read. */
const TRACE_MS_PER_PX = 2.2;
const TRACE_MIN_MS = 140;
const TRACE_MAX_MS = 320;
/** Long enough for the path's fade-out, after which it next enters from the top. */
const TRACE_FADE_MS = 160;
const FOLD_TRACE = '[data-fold-trace]';

const easeOut = (t: number) => 1 - (1 - t) ** 3;

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** Length of a row's branch: the quarter turn off the trunk, then the stub to the row. */
function branchLength(center: number) {
  const r = center - branchStart(center);
  return (Math.PI * r) / 2 + (BRANCH_END - TRUNK_X - r);
}

/** The first `length` px of a row's branch, continuing a path that is at its start. */
function partialBranch(center: number, length: number) {
  const r = center - branchStart(center);
  const arc = (Math.PI * r) / 2;
  if (length >= arc) {
    const end = Math.min(BRANCH_END, Math.round((TRUNK_X + r + length - arc) * 100) / 100);
    return `A ${r} ${r} 0 0 0 ${TRUNK_X + r} ${center} H ${end}`;
  }
  const angle = r === 0 ? 0 : length / r;
  const x = TRUNK_X + r - r * Math.cos(angle);
  const y = center - r + r * Math.sin(angle);
  return `A ${r} ${r} 0 0 0 ${x} ${y}`;
}

function drawTrace(trace: Trace) {
  const branch = trace.elbow > 0 ? ` ${partialBranch(trace.center, trace.elbow)}` : '';
  trace.path.setAttribute('d', `M ${TRUNK_X} ${TRUNK_TOP} V ${trace.tip}${branch}`);
}

/** Where a move has the path after `distance` px of it. */
function stepMove(trace: Trace, move: TraceMove, distance: number) {
  const { from } = move;
  if (distance < move.retract) {
    trace.center = from.center;
    trace.tip = from.tip;
    trace.elbow = from.elbow - distance;
    return;
  }
  const along = distance - move.retract;
  const target = branchStart(move.center);
  if (along < move.travel) {
    trace.elbow = 0;
    trace.tip = from.tip + Math.sign(target - from.tip) * along;
    return;
  }
  trace.center = move.center;
  trace.tip = target;
  trace.elbow = Math.min(move.extendFrom + along - move.travel, branchLength(move.center));
}

/**
 * Lights a rail's path into the row `to` names, or fades it out for `null`. The path
 * travels the tree's own route: it backs out of the branch it is in, runs along the
 * trunk to the new row's branch point and draws into that branch, as one motion at a
 * steady pace. Retargeting mid-trip starts the new trip from wherever it is. When the
 * same row moves (a fold above it opened), the path follows it at once.
 */
function traceTo(rail: HTMLElement, to: { branch: number; center: number } | null) {
  const path = rail.querySelector<SVGPathElement>(FOLD_TRACE);
  let trace = traces.get(rail);
  if (to == null || path == null) {
    if (trace != null) {
      cancelAnimationFrame(trace.frame);
      trace.frame = 0;
      trace.move = null;
      /** A path left mid-trip finishes its trip if the pointer comes straight back. */
      trace.branch = -1;
      trace.path.removeAttribute('data-lit');
      window.clearTimeout(trace.fade);
      trace.fade = window.setTimeout(() => traces.delete(rail), TRACE_FADE_MS);
    }
    return;
  }
  if (trace == null || trace.path !== path) {
    /** Enters from the top, never from where a faded-out path last ended. */
    trace = {
      path,
      branch: -1,
      center: TRUNK_TOP,
      tip: TRUNK_TOP,
      elbow: 0,
      move: null,
      frame: 0,
      fade: 0,
    };
    traces.set(rail, trace);
    drawTrace(trace);
  }
  window.clearTimeout(trace.fade);
  path.setAttribute('data-lit', '');

  const settled = trace.move == null && trace.branch === to.branch;
  if (settled && trace.center === to.center) {
    return;
  }
  if (settled || prefersReducedMotion()) {
    cancelAnimationFrame(trace.frame);
    trace.frame = 0;
    trace.move = null;
    trace.branch = to.branch;
    trace.center = to.center;
    trace.tip = branchStart(to.center);
    trace.elbow = branchLength(to.center);
    drawTrace(trace);
    return;
  }
  /** A row that moved mid-trip gets a fresh trip from where the path is now, so the
   *  remaining distance is measured to where the row actually is. */
  if (trace.move != null && trace.move.branch === to.branch && trace.move.center === to.center) {
    return;
  }

  cancelAnimationFrame(trace.frame);
  const target = branchStart(to.center);
  /** Turning back into the branch it is still partly in: keep what is drawn. */
  const resume = trace.elbow > 0 && trace.center === to.center && trace.tip === target;
  const retract = resume ? 0 : trace.elbow;
  const extendFrom = resume ? trace.elbow : 0;
  const travel = Math.abs(target - trace.tip);
  const total = retract + travel + branchLength(to.center) - extendFrom;
  const move: TraceMove = {
    from: { center: trace.center, tip: trace.tip, elbow: trace.elbow },
    branch: to.branch,
    center: to.center,
    retract,
    travel,
    extendFrom,
    total,
    duration: Math.min(TRACE_MAX_MS, Math.max(TRACE_MIN_MS, total * TRACE_MS_PER_PX)),
    start: null,
  };
  trace.move = move;
  trace.branch = to.branch;
  const current = trace;
  const step = (now: number) => {
    move.start ??= now;
    const t = Math.min(1, (now - move.start) / move.duration);
    stepMove(current, move, move.total * easeOut(t));
    drawTrace(current);
    if (t < 1) {
      current.frame = requestAnimationFrame(step);
      return;
    }
    current.frame = 0;
    current.move = null;
  };
  current.frame = requestAnimationFrame(step);
}

function paintFoldPath(previous: LitRail[], next: LitRail[]) {
  for (const { rail } of previous) {
    if (!next.some((lit) => lit.rail === rail)) {
      delete rail.dataset.foldLit;
      traceTo(rail, null);
    }
  }
  for (const { rail, branch } of next) {
    rail.dataset.foldLit = String(branch);
    /** Re-read on every paint: a re-hit after a layout change can move the branch. */
    const center = Number(rail.dataset.centers?.split(',')[branch]);
    traceTo(rail, rail.dataset.centers && Number.isFinite(center) ? { branch, center } : null);
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
      /** The move's own target is current; a layout change after it sets this again. */
      rehit = false;
      if (frame === 0) {
        frame = requestAnimationFrame(paint);
      }
    };
    /** The rows moved under a pointer that did not: hit-test its last position again
     *  on the next frame rather than going dark until the pointer next moves. Clicking
     *  a header to fold or unfold it, streaming, scrolling and resizing all land here. */
    const relight = () => {
      if (pointer == null) {
        return;
      }
      rehit = true;
      if (frame === 0) {
        frame = requestAnimationFrame(paint);
      }
    };
    const onDown = (event: PointerEvent) => {
      if (event.pointerType === 'touch') {
        clear();
        return;
      }
      relight();
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
        relight();
      }
    });
    mutations.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'class',
        'style',
        'hidden',
        'open',
        'data-centers',
        'data-fold-panel',
        'data-fold-column',
      ],
    });
    const resize = new ResizeObserver(relight);
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
    root.addEventListener('pointerdown', onDown);
    window.addEventListener('scroll', relight, true);
    window.addEventListener('resize', relight);
    return () => {
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerleave', clear);
      root.removeEventListener('pointerdown', onDown);
      window.removeEventListener('scroll', relight, true);
      window.removeEventListener('resize', relight);
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
