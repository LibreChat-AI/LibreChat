import { useEffect } from 'react';
import type * as Ariakit from '@ariakit/react';
import type { RefObject } from 'react';

/**
 * Opens a hovercard when the pointer rests anywhere on the row that owns it, not only on the
 * mark inside it. The row becomes the card's anchor, so the card stays open while the pointer
 * moves across the row and closes once it leaves the row and the card.
 *
 * Like the anchor's own hover intent, only real pointer travel counts: a row that scrolls under
 * a still pointer, or a tap on touch, does not open it.
 */
export default function useRowHover(
  store: Ariakit.HovercardStore,
  rowRef: RefObject<HTMLElement | null> | undefined,
  /** Changes when the mark appears or disappears, so the listener follows the row's content. */
  active: boolean,
) {
  useEffect(() => {
    const row = rowRef?.current;
    if (!row || !active) {
      return;
    }
    let timer = 0;
    let lastX: number | null = null;
    let lastY: number | null = null;

    const clear = () => {
      window.clearTimeout(timer);
      timer = 0;
    };
    const onMove = (event: MouseEvent) => {
      const moved = lastX != null && (event.screenX !== lastX || event.screenY !== lastY);
      lastX = event.screenX;
      lastY = event.screenY;
      if (!moved || timer || store.getState().open) {
        return;
      }
      const { showTimeout, timeout } = store.getState();
      timer = window.setTimeout(() => {
        timer = 0;
        store.setAnchorElement(row);
        store.show();
      }, showTimeout ?? timeout);
    };
    const onLeave = () => {
      clear();
      lastX = null;
      lastY = null;
    };

    row.addEventListener('mousemove', onMove);
    row.addEventListener('mouseleave', onLeave);
    return () => {
      clear();
      row.removeEventListener('mousemove', onMove);
      row.removeEventListener('mouseleave', onLeave);
    };
  }, [store, rowRef, active]);
}
