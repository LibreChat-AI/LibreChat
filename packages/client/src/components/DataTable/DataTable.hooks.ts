import { useState, useEffect, useSyncExternalStore, SetStateAction, Dispatch } from 'react';

export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);

  return debounced;
}

export const useOptimizedRowSelection = (
  initialSelection: Record<string, boolean> = {},
): readonly [Record<string, boolean>, Dispatch<SetStateAction<Record<string, boolean>>>] => {
  const [selection, setSelection] = useState(initialSelection);
  return [selection, setSelection] as const;
};

const DEFAULT_CELL_SPACE_PX = 16;

/**
 * A root custom property in px. The table roles only accept px or rem (zero allowed), so the value
 * is read exactly against the root size; an unset property reads its `fallbackRem`, as the preset
 * does.
 */
function readRootLength(property: string, fallbackRem: number): number {
  if (typeof document === 'undefined') {
    return fallbackRem * DEFAULT_CELL_SPACE_PX;
  }
  const style = getComputedStyle(document.documentElement);
  const rootSize = parseFloat(style.fontSize) || DEFAULT_CELL_SPACE_PX;
  const match = /^(\d*\.?\d+)(px|rem)?$/.exec(style.getPropertyValue(property).trim());
  if (!match) {
    return fallbackRem * rootSize;
  }
  return Number(match[1]) * (match[2] === 'rem' ? rootSize : 1);
}

type TableRowKind = 'dense' | 'compact' | 'titled';

const SM_BREAKPOINT_QUERY = '(min-width: 640px)';

function isBelowSm(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? !window.matchMedia(SM_BREAKPOINT_QUERY).matches
    : false;
}

/**
 * A row's height in px. A dense row holds 2rem of controls between a quarter of the cell space
 * above and below; a compact row a 1.25rem text line between half the space above and below from
 * `sm` up, and a 1rem line between a quarter of it below; a titled row is as tall as its title cell, a header-sized cell of twice the
 * space around a 1rem line. The dense and compact cells grow by the row rule under them; the title
 * cell's fixed height is a border box that already holds it.
 */
function readTableRowHeight(kind: TableRowKind): number {
  const rootSize =
    typeof document === 'undefined'
      ? DEFAULT_CELL_SPACE_PX
      : parseFloat(getComputedStyle(document.documentElement).fontSize) || DEFAULT_CELL_SPACE_PX;
  const space = readRootLength('--theme-table-cell-space-y', 1);
  const stroke = readRootLength('--theme-table-row-stroke', 0);
  const heights: Record<TableRowKind, number> = {
    dense: 2 * rootSize + space / 2 + stroke,
    compact: isBelowSm() ? rootSize + space / 2 + stroke : 1.25 * rootSize + space + stroke,
    titled: rootSize + 2 * space,
  };
  return heights[kind];
}

/** The theme paints its appearance onto the root's inline style and class, and the cell sizes
 *  change at `sm`, so those are the changes worth re-reading on. */
function subscribeToGeometry(onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') {
    return () => undefined;
  }
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class'],
  });
  const breakpoint =
    typeof window.matchMedia === 'function' ? window.matchMedia(SM_BREAKPOINT_QUERY) : null;
  breakpoint?.addEventListener('change', onChange);
  return () => {
    observer.disconnect();
    breakpoint?.removeEventListener('change', onChange);
  };
}

/**
 * A table row's height in px (dense 40px, compact 36px or 24px below `sm`, titled 48px by default), for geometry JavaScript has
 * to know, such as a virtualized row. Follows a theme switch.
 */
export function useTableRowHeight(kind: TableRowKind): number {
  return useSyncExternalStore(
    subscribeToGeometry,
    () => readTableRowHeight(kind),
    () => ({ dense: 40, compact: 36, titled: 48 })[kind],
  );
}
