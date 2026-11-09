import { useSyncExternalStore } from 'react';

export type Direction = 'ltr' | 'rtl';
export type PhysicalSide = 'left' | 'right';

const readDirection = (): Direction =>
  typeof document !== 'undefined' && document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr';

const subscribe = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['dir'] });
  return () => observer.disconnect();
};

/** Whether an element lays out right to left. Reads the element, not the document, so an
 *  island forced to `dir="ltr"` keeps its own mapping. */
export const isRtlElement = (element: Element | null): boolean =>
  element != null && window.getComputedStyle(element).direction === 'rtl';

/** The physical side that a logical inline edge lands on. Floating UI and Radix sides are
 *  physical, so placements that mean "toward the content" must be resolved per direction. */
export const inlineSide = (direction: Direction, edge: 'start' | 'end'): PhysicalSide =>
  (edge === 'end') === (direction === 'rtl') ? 'left' : 'right';

/** The document's writing direction, kept in sync with the `dir` that i18n writes on `<html>`. */
export default function useDirection(): Direction {
  return useSyncExternalStore(subscribe, readDirection, () => 'ltr');
}
