import { useEffect } from 'react';
import type * as Ariakit from '@ariakit/react';
import type { RefObject } from 'react';

/** The pointer's position before the current move, wherever it was, so the first move into a
 *  row can tell travel from a row scrolling under a still pointer. One listener for every row. */
let previous: { x: number; y: number } | null = null;
let current: { x: number; y: number } | null = null;
let tracking = false;
const track = () => {
  if (tracking) {
    return;
  }
  tracking = true;
  document.addEventListener(
    'mousemove',
    (event) => {
      previous = current;
      current = { x: event.screenX, y: event.screenY };
    },
    { capture: true, passive: true },
  );
};
const hasTraveled = (event: MouseEvent) => {
  if (event.movementX || event.movementY) {
    return true;
  }
  return previous != null && (event.screenX !== previous.x || event.screenY !== previous.y);
};

/**
 * Opens a hovercard when the pointer rests anywhere on the row that owns it, not only on the
 * mark inside it. The row becomes the card's anchor, so the card stays open while the pointer
 * moves across the row and closes once it leaves the row and the card.
 *
 * Like the anchor's own hover intent, only real pointer travel counts: a row that scrolls under
 * a still pointer, or a tap on touch, does not open it. Pressing a button or a key on the row,
 * or moving with a button held (a drag), cancels a pending open, so selecting or dragging the
 * conversation does not pop the card over it. Scrolling the list that holds the row cancels it
 * too, and closes a card the row opened, since the row no longer sits under the pointer.
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
    track();
    let timer = 0;

    const clear = () => {
      window.clearTimeout(timer);
      timer = 0;
    };
    const onMove = (event: MouseEvent) => {
      if (event.buttons !== 0) {
        clear();
        return;
      }
      if (!hasTraveled(event) || timer || store.getState().open) {
        return;
      }
      const { showTimeout, timeout } = store.getState();
      timer = window.setTimeout(() => {
        timer = 0;
        store.setAnchorElement(row);
        store.show();
      }, showTimeout ?? timeout);
    };
    /* Only a scroller that holds the row moves it: the message list or the card's own content
       scrolling leaves the row where it was. */
    const onScroll = (event: Event) => {
      const { target } = event;
      if (!(target instanceof Node) || (target !== document && !target.contains(row))) {
        return;
      }
      const { anchorElement, open } = store.getState();
      clear();
      if (open && anchorElement === row) {
        store.hide();
      }
    };

    row.addEventListener('mousemove', onMove);
    row.addEventListener('mouseleave', clear);
    row.addEventListener('mousedown', clear);
    row.addEventListener('keydown', clear);
    row.addEventListener('dragstart', clear);
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      clear();
      row.removeEventListener('mousemove', onMove);
      row.removeEventListener('mouseleave', clear);
      row.removeEventListener('mousedown', clear);
      row.removeEventListener('keydown', clear);
      row.removeEventListener('dragstart', clear);
      document.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, [store, rowRef, active]);
}
