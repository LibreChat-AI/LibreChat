import { useLayoutEffect, memo, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button, useRemScale } from '@librechat/client';
import type { ReactNode } from 'react';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/** Collapsed preview height (baseline px) for a long message before "Show more". The
 *  tolerance below only decides whether the toggle appears: it absorbs the
 *  trailing markdown margin so content that fits but for its own bottom margin
 *  does not trip a pointless toggle. The clamp itself is applied only once the
 *  content actually overflows, so nothing is ever hidden without a toggle. */
const COLLAPSED_MAX_HEIGHT = 256;
const OVERFLOW_TOLERANCE = 8;

/**
 * Clamps a long user message to a preview height with a fade and a
 * "Show more" toggle, so a pasted wall of text or code cannot dominate the
 * thread. The clamp is visual only: `overflow-hidden` keeps the full text in
 * the DOM, so it stays readable by assistive tech, copyable, and findable by
 * in-page search. Renders children untouched while `enabled` is false, keeping
 * the DOM identical when the preference is off.
 */
const CollapsibleText = memo(function CollapsibleText({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  const localize = useLocalize();
  const remScale = useRemScale();
  const collapsedMaxHeight = COLLAPSED_MAX_HEIGHT * remScale;
  const overflowTolerance = OVERFLOW_TOLERANCE * remScale;
  const contentRef = useRef<HTMLDivElement>(null);
  const contentId = useId();
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [wasEnabled, setWasEnabled] = useState(enabled);

  // Turning the preference off resets the reveal, so re-enabling always
  // starts from the collapsed preview instead of a stale expanded state.
  if (wasEnabled !== enabled) {
    setWasEnabled(enabled);
    if (!enabled) {
      setExpanded(false);
    }
  }

  /** Measures the inner wrapper, which is never clamped: `scrollHeight` there
   *  is the natural content height, and its ResizeObserver fires when content
   *  grows or shrinks (font size change, a late image or diagram finishing
   *  layout) even while the outer region is clipped. A layout effect, so the
   *  first paint already carries the clamp instead of flashing the full wall
   *  of text on mount. */
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (el == null) {
      return;
    }
    const measure = () => setOverflowing(el.scrollHeight - collapsedMaxHeight > overflowTolerance);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [enabled, collapsedMaxHeight, overflowTolerance]);

  if (!enabled) {
    return <>{children}</>;
  }

  const clamped = !expanded && overflowing;

  /** Focus stays in the tab order across the whole message (the text is in the
   *  DOM and must remain reachable), but landing on a control that is actually
   *  clipped reveals it rather than leaving focus inside hidden content. A
   *  control that is already visible within the preview does not expand; any
   *  overhang past the boundary counts, since the overflow tolerance exists
   *  only to absorb trailing margins when deciding if the message overflows. */
  const revealIfClipped = (event: React.FocusEvent<HTMLDivElement>) => {
    if (!clamped) {
      return;
    }
    const target = event.target as HTMLElement;
    const boundary = event.currentTarget.getBoundingClientRect().top + collapsedMaxHeight;
    if (target.getBoundingClientRect().bottom > boundary) {
      setExpanded(true);
    }
  };

  return (
    <div className="w-full min-w-0">
      <div
        id={contentId}
        className={cn('relative w-full', clamped && 'overflow-hidden')}
        style={clamped ? { maxHeight: collapsedMaxHeight } : undefined}
        onFocus={revealIfClipped}
      >
        <div ref={contentRef} className="w-full">
          {children}
        </div>
        {clamped && (
          <div
            className="from-surface-tertiary pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t to-transparent"
            aria-hidden="true"
          />
        )}
      </div>
      {overflowing && (
        <Button
          type="button"
          variant="link"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          aria-controls={contentId}
          className="mt-1 h-auto gap-1 p-0 text-xs"
        >
          {expanded ? (
            <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {localize(expanded ? 'com_ui_show_less' : 'com_ui_show_more')}
        </Button>
      )}
    </div>
  );
});

export default CollapsibleText;
