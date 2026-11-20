import { useSyncExternalStore } from 'react';
import { getRemScale, invalidateRemScale } from '~/utils/remScale';

/**
 * Watches the root element rather than the stored preference, so the value is
 * already correct on the render that follows a scale change, including one that
 * arrives from another tab through a storage event.
 */
const subscribe = (onStoreChange: () => void): (() => void) => {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') {
    return () => undefined;
  }
  const observer = new MutationObserver(() => {
    invalidateRemScale();
    onStoreChange();
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  return () => observer.disconnect();
};

/**
 * Ratio between a rendered rem and the 16px baseline, for layout that cannot be
 * expressed in CSS: virtualized row heights and drag-resized panels.
 */
export default function useRemScale(): number {
  return useSyncExternalStore(subscribe, getRemScale, () => 1);
}
