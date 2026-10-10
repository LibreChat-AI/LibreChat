import { useRef, useMemo, useState, useLayoutEffect } from 'react';

interface Keyed {
  key: string;
}

/**
 * Reorders wrapping chips so they fill each row instead of leaving ragged gaps.
 *
 * Chips arrive in catalog order, which for skills and MCP servers is close to
 * alphabetical: a very long name landing mid-row pushes everything after it down
 * and strands the remainder of that row. Ordering widest-first is the
 * first-fit-decreasing heuristic, so the wide chips claim their rows early and
 * the narrow ones backfill whatever is left.
 *
 * Widths are measured rather than estimated from label length, which is a poor
 * proxy in a proportional font and worse across languages. They are keyed by
 * chip id so a reorder reuses the previous measurements instead of triggering
 * another pass, which is what keeps this from oscillating.
 */
export default function useChipPacking<T extends Keyed>(
  items: T[],
): {
  ordered: T[];
  /** Put this on whatever encloses the chips; they are found by role, so they
   *  may be split across several containers. */
  rootRef: React.RefObject<HTMLDivElement>;
  /** Measured chip widths by key, empty until every chip has been seen. */
  widths: Record<string, number>;
} {
  const rootRef = useRef<HTMLDivElement>(null);
  /* State, not a ref: the order below is render output, and deriving it from a
     value React does not track let two passes of the same render disagree. */
  const [widths, setWidths] = useState<Record<string, number>>({});

  const ordered = useMemo(() => {
    /* Until every chip has been measured, leave the order alone: a partial sort
       would shuffle on each pass and never settle. */
    if (items.some((item) => widths[item.key] == null)) {
      return items;
    }
    return [...items].sort((a, b) => widths[b.key] - widths[a.key]);
  }, [items, widths]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const measured: Record<string, number> = {};
    /* Queried by role rather than walked as children: the caller may split the
       chips across rows. Document order still matches `ordered`. */
    root.querySelectorAll<HTMLElement>('[role="listitem"]').forEach((node, index) => {
      const key = ordered[index]?.key;
      const width = node.offsetWidth;
      if (key != null && width > 0) {
        measured[key] = width;
      }
    });

    setWidths((prev) => {
      const next: Record<string, number> = {};
      let changed = false;
      /* Only live chips are carried over, so a width cannot outlive the chip it
         belongs to and place it wrongly when it comes back. */
      for (const item of items) {
        const width = measured[item.key] ?? prev[item.key];
        if (width != null) {
          next[item.key] = width;
        }
        if (next[item.key] !== prev[item.key]) {
          changed = true;
        }
      }
      if (!changed && Object.keys(next).length === Object.keys(prev).length) {
        return prev;
      }
      return next;
    });
  }, [items, ordered]);

  return { ordered, rootRef, widths };
}
