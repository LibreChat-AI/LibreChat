import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * A sole call drops its own row once it settles, because the group header is
 * the row. If that row held keyboard focus, the browser would drop focus to the
 * document, so focus moves to the header the row is replaced by.
 *
 * The row is watched through its ref callback: React detaches it before the
 * node leaves the DOM, which is the last moment `document.activeElement` still
 * says whether the row had focus, and the node can still name its group.
 */
export default function useRowHandoff(bare: boolean) {
  const rowNode = useRef<HTMLElement | null>(null);
  const handoff = useRef<HTMLElement | null>(null);

  const rowRef = useCallback((node: HTMLElement | null) => {
    if (node == null) {
      const held = rowNode.current?.contains(document.activeElement) === true;
      const root = rowNode.current?.closest('[data-fold-root]');
      /** The header precedes every row in document order, whatever else the
       *  root leads with (a phase puts its announcer first). */
      const header = held ? (root?.querySelector<HTMLElement>('button') ?? null) : null;
      handoff.current = header != null && !rowNode.current?.contains(header) ? header : null;
    } else {
      handoff.current = null;
    }
    rowNode.current = node;
  }, []);

  useLayoutEffect(() => {
    if (!bare || handoff.current == null) {
      return;
    }
    const target = handoff.current;
    handoff.current = null;
    target.focus();
  }, [bare]);

  return rowRef;
}
