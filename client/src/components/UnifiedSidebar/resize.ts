import { isRtlElement } from '~/hooks/Nav/useDirection';

/**
 * Returns how wide a drag at `clientX` asks the sidebar to be: the distance from
 * the sidebar's inline-start edge to the pointer. That edge is the sidebar's left
 * in LTR and its right in RTL, where the handle sits on the left and dragging
 * left grows it. Measured once at drag start, from the handle's container.
 */
export function createResizeMeasure(handle: HTMLElement): (clientX: number) => number {
  const rtl = isRtlElement(handle);
  const bounds = handle.parentElement?.getBoundingClientRect();
  if (rtl) {
    const origin = bounds?.right ?? window.innerWidth;
    return (clientX) => origin - clientX;
  }
  const origin = bounds?.left ?? 0;
  return (clientX) => clientX - origin;
}
