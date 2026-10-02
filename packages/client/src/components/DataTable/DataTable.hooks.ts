import {
  useMemo,
  useState,
  useEffect,
  useSyncExternalStore,
  SetStateAction,
  Dispatch,
  CSSProperties,
} from 'react';
import type { TableColumn } from './DataTable.types';

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

export const useColumnStyles = <TData, TValue>(
  columns: TableColumn<TData, TValue>[],
  isSmallScreen: boolean,
  containerRef: React.RefObject<HTMLDivElement>,
): Record<string, CSSProperties> => {
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateWidth = () => {
      setContainerWidth(container.clientWidth);
    };

    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(container);
    updateWidth();

    return () => resizeObserver.disconnect();
  }, [containerRef]);

  return useMemo(() => {
    if (containerWidth === 0) {
      return {};
    }

    const styles: Record<string, React.CSSProperties> = {};
    let totalFixedWidth = 0;
    const flexibleColumns: (TableColumn<TData, TValue> & { priority: number })[] = [];

    columns.forEach((column) => {
      const key = String(column.id ?? column.accessorKey ?? '');
      const size = isSmallScreen ? column.meta?.mobileSize : column.meta?.size;

      if (size) {
        const width = parseInt(String(size), 10);
        totalFixedWidth += width;
        styles[key] = {
          width: size,
          minWidth: column.meta?.minWidth || size,
        };
      } else {
        flexibleColumns.push({ ...column, priority: column.meta?.priority ?? 1 });
      }
    });

    const availableWidth = containerWidth - totalFixedWidth;
    const totalPriority = flexibleColumns.reduce((sum, col) => sum + col.priority, 0);

    if (availableWidth > 0 && totalPriority > 0) {
      flexibleColumns.forEach((column) => {
        const key = String(column.id ?? column.accessorKey ?? '');
        const proportion = column.priority / totalPriority;
        const width = Math.max(Math.floor(availableWidth * proportion), 80); // min width of 80px
        styles[key] = {
          width: `${width}px`,
          minWidth: column.meta?.minWidth ?? `${isSmallScreen ? 60 : 80}px`,
        };
      });
    }

    return styles;
  }, [columns, containerWidth, isSmallScreen]);
};

export const useDynamicColumnWidths: <TData, TValue>(
  columns: TableColumn<TData, TValue>[],
  isSmallScreen: boolean,
  containerRef: React.RefObject<HTMLDivElement>,
) => Record<string, CSSProperties> = useColumnStyles;

export const useKeyboardNavigation = (
  tableRef: React.RefObject<HTMLDivElement>,
  rowCount: number,
  onRowSelect?: (index: number) => void,
): {
  focusedRowIndex: number;
  setFocusedRowIndex: Dispatch<SetStateAction<number>>;
} => {
  const [focusedRowIndex, setFocusedRowIndex] = useState<number>(-1);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!tableRef.current?.contains(event.target as Node)) return;

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setFocusedRowIndex((prev) => Math.min(prev + 1, rowCount - 1));
          break;
        case 'ArrowUp':
          event.preventDefault();
          setFocusedRowIndex((prev) => Math.max(prev - 1, 0));
          break;
        case 'Home':
          event.preventDefault();
          setFocusedRowIndex(0);
          break;
        case 'End':
          event.preventDefault();
          setFocusedRowIndex(rowCount - 1);
          break;
        case 'Enter':
        case ' ':
          if (focusedRowIndex >= 0 && onRowSelect) {
            event.preventDefault();
            onRowSelect(focusedRowIndex);
          }
          break;
        case 'Escape':
          setFocusedRowIndex(-1);
          (event.target as HTMLElement).blur();
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [tableRef, rowCount, focusedRowIndex, onRowSelect]);

  return { focusedRowIndex, setFocusedRowIndex };
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

/**
 * A row's height in px. A dense row holds 2rem of controls between a quarter of the cell space
 * above and below; a compact row a 1.25rem text line between half the space above and below (its
 * size from `sm` up); a titled row is as tall as its title cell, a header-sized cell of twice the
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
    compact: 1.25 * rootSize + space + stroke,
    titled: rootSize + 2 * space,
  };
  return heights[kind];
}

/** The theme paints its appearance onto the root's inline style and class, so those are the
 *  changes worth re-reading on. */
function subscribeToGeometry(onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') {
    return () => undefined;
  }
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class'],
  });
  return () => observer.disconnect();
}

/**
 * A table row's height in px (dense 40px, compact 36px, titled 48px by default), for geometry JavaScript has
 * to know, such as a virtualized row. Follows a theme switch.
 */
export function useTableRowHeight(kind: TableRowKind): number {
  return useSyncExternalStore(
    subscribeToGeometry,
    () => readTableRowHeight(kind),
    () => ({ dense: 40, compact: 36, titled: 48 })[kind],
  );
}
