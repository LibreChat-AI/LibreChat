import { useRef } from 'react';
import * as Ariakit from '@ariakit/react';
import type { RefObject } from 'react';

/**
 * Reports whether this row is the composite's active item, read from the Ariakit
 * store rather than from a per-row `MutationObserver`.
 *
 * `useIsActiveItem` allocates one observer per mounted row, which is fine for a
 * handful of rows and ruinous for a large model list — and under virtualization
 * rows mount and unmount on every scroll frame, so the observers churn as well.
 * The store already tracks `activeId`; the selector returns a boolean so a row
 * only re-renders when its own active state flips, not on every arrow key.
 */
export default function useActiveItem<T extends HTMLElement = HTMLElement>(): {
  ref: RefObject<T>;
  isActive: boolean;
} {
  const ref = useRef<T>(null);
  const combobox = Ariakit.useComboboxContext();
  const menu = Ariakit.useMenuContext();
  /** Endpoint submenus render as a combobox list; plain menus fall back to the menu store. */
  const store = combobox ?? menu;

  const isActive =
    Ariakit.useStoreState(
      store,
      (state) =>
        state?.activeId != null && ref.current != null && state.activeId === ref.current.id,
    ) ?? false;

  return { ref, isActive };
}
