import { renderHook, act, waitFor } from '@testing-library/react';
import type { TableColumn } from './DataTable.types';
import {
  useDebounced,
  useOptimizedRowSelection,
  useColumnStyles,
  useKeyboardNavigation,
  useTableRowHeight,
} from './DataTable.hooks';

describe('DataTable Hooks', () => {
  describe('useDebounced', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should return the initial value immediately', () => {
      const { result } = renderHook(() => useDebounced('initial', 300));
      expect(result.current).toBe('initial');
    });

    it('should update value after the delay', () => {
      const { result, rerender } = renderHook(({ value, delay }) => useDebounced(value, delay), {
        initialProps: { value: 'initial', delay: 300 },
      });

      expect(result.current).toBe('initial');

      rerender({ value: 'updated', delay: 300 });

      // Value should still be initial before delay
      expect(result.current).toBe('initial');

      // Advance timer past the delay
      act(() => {
        jest.advanceTimersByTime(300);
      });

      expect(result.current).toBe('updated');
    });

    it('should reset timer on rapid changes', () => {
      const { result, rerender } = renderHook(({ value, delay }) => useDebounced(value, delay), {
        initialProps: { value: 'initial', delay: 300 },
      });

      rerender({ value: 'change1', delay: 300 });
      act(() => {
        jest.advanceTimersByTime(100);
      });

      rerender({ value: 'change2', delay: 300 });
      act(() => {
        jest.advanceTimersByTime(100);
      });

      rerender({ value: 'change3', delay: 300 });
      act(() => {
        jest.advanceTimersByTime(100);
      });

      // Should still be initial because timer keeps resetting
      expect(result.current).toBe('initial');

      // Advance past the full delay
      act(() => {
        jest.advanceTimersByTime(300);
      });

      // Should now be the last value
      expect(result.current).toBe('change3');
    });

    it('should handle different data types', () => {
      // Test with number
      const { result: numberResult } = renderHook(() => useDebounced(42, 100));
      expect(numberResult.current).toBe(42);

      // Test with object
      const obj = { foo: 'bar' };
      const { result: objectResult } = renderHook(() => useDebounced(obj, 100));
      expect(objectResult.current).toEqual({ foo: 'bar' });

      // Test with array
      const arr = [1, 2, 3];
      const { result: arrayResult } = renderHook(() => useDebounced(arr, 100));
      expect(arrayResult.current).toEqual([1, 2, 3]);
    });

    it('should handle zero delay', () => {
      const { result, rerender } = renderHook(({ value, delay }) => useDebounced(value, delay), {
        initialProps: { value: 'initial', delay: 0 },
      });

      rerender({ value: 'updated', delay: 0 });

      act(() => {
        jest.advanceTimersByTime(0);
      });

      expect(result.current).toBe('updated');
    });
  });

  describe('useOptimizedRowSelection', () => {
    it('should initialize with empty object by default', () => {
      const { result } = renderHook(() => useOptimizedRowSelection());
      const [selection] = result.current;
      expect(selection).toEqual({});
    });

    it('should initialize with provided selection', () => {
      const initialSelection = { row1: true, row2: true };
      const { result } = renderHook(() => useOptimizedRowSelection(initialSelection));
      const [selection] = result.current;
      expect(selection).toEqual({ row1: true, row2: true });
    });

    it('should update selection state', () => {
      const { result } = renderHook(() => useOptimizedRowSelection());

      act(() => {
        const [, setSelection] = result.current;
        setSelection({ row1: true });
      });

      const [selection] = result.current;
      expect(selection).toEqual({ row1: true });
    });

    it('should return tuple with selection and setter', () => {
      const { result } = renderHook(() => useOptimizedRowSelection());
      const [selection, setSelection] = result.current;

      expect(typeof selection).toBe('object');
      expect(typeof setSelection).toBe('function');
    });

    it('should support functional updates', () => {
      const { result } = renderHook(() => useOptimizedRowSelection({ existing: true }));

      act(() => {
        const [, setSelection] = result.current;
        setSelection((prev) => ({ ...prev, new: true }));
      });

      const [selection] = result.current;
      expect(selection).toEqual({ existing: true, new: true });
    });
  });

  describe('useColumnStyles', () => {
    let mockContainerRef: React.RefObject<HTMLDivElement>;
    let mockContainer: HTMLDivElement;

    beforeEach(() => {
      mockContainer = document.createElement('div');
      Object.defineProperty(mockContainer, 'clientWidth', {
        configurable: true,
        value: 1000,
      });
      mockContainerRef = { current: mockContainer };
    });

    it('should return empty object when container width is 0', () => {
      Object.defineProperty(mockContainer, 'clientWidth', { value: 0 });

      const columns: TableColumn<{ name: string }, string>[] = [
        { accessorKey: 'name', header: 'Name' },
      ];

      const { result } = renderHook(() => useColumnStyles(columns, false, mockContainerRef));

      expect(result.current).toEqual({});
    });

    it('should calculate fixed width columns', () => {
      const columns: TableColumn<{ name: string; status: string }, string>[] = [
        { accessorKey: 'name', header: 'Name', meta: { size: 200 } },
        { accessorKey: 'status', header: 'Status', meta: { size: 100 } },
      ];

      const { result } = renderHook(() => useColumnStyles(columns, false, mockContainerRef));

      expect(result.current.name).toBeDefined();
      expect(result.current.status).toBeDefined();
    });

    it('should distribute available width to flexible columns by priority', () => {
      const columns: TableColumn<{ col1: string; col2: string; col3: string }, string>[] = [
        { accessorKey: 'col1', header: 'Col 1', meta: { size: 200 } }, // fixed
        { accessorKey: 'col2', header: 'Col 2', meta: { priority: 2 } }, // flexible, priority 2
        { accessorKey: 'col3', header: 'Col 3', meta: { priority: 1 } }, // flexible, priority 1
      ];

      const { result } = renderHook(() => useColumnStyles(columns, false, mockContainerRef));

      // Available width = 1000 - 200 = 800
      // Total priority = 3
      // col2 should get 2/3 = ~533px
      // col3 should get 1/3 = ~266px
      expect(result.current.col2).toBeDefined();
      expect(result.current.col3).toBeDefined();
    });

    it('should handle mobile vs desktop sizes', () => {
      const columns: TableColumn<{ name: string }, string>[] = [
        { accessorKey: 'name', header: 'Name', meta: { size: 200, mobileSize: 150 } },
      ];

      // Desktop
      const { result: desktopResult } = renderHook(() =>
        useColumnStyles(columns, false, mockContainerRef),
      );

      // Mobile
      const { result: mobileResult } = renderHook(() =>
        useColumnStyles(columns, true, mockContainerRef),
      );

      // Mobile should use mobileSize if defined
      expect(mobileResult.current.name).toBeDefined();
      expect(desktopResult.current.name).toBeDefined();
    });

    it('should handle columns with id instead of accessorKey', () => {
      const columns: TableColumn<Record<string, unknown>, unknown>[] = [
        { id: 'custom-column', header: 'Custom', meta: { size: 150 } },
      ];

      const { result } = renderHook(() => useColumnStyles(columns, false, mockContainerRef));

      expect(result.current['custom-column']).toBeDefined();
    });

    it('should return empty object when container ref is null', () => {
      const nullRef = { current: null };
      const columns: TableColumn<{ name: string }, string>[] = [
        { accessorKey: 'name', header: 'Name' },
      ];

      const { result } = renderHook(() =>
        useColumnStyles(columns, false, nullRef as React.RefObject<HTMLDivElement>),
      );

      expect(result.current).toEqual({});
    });
  });

  describe('useKeyboardNavigation', () => {
    let mockTableRef: React.RefObject<HTMLDivElement>;
    let mockTable: HTMLDivElement;
    let mockOnRowSelect: jest.Mock;

    beforeEach(() => {
      mockTable = document.createElement('div');
      document.body.appendChild(mockTable);
      mockTableRef = { current: mockTable };
      mockOnRowSelect = jest.fn();
    });

    afterEach(() => {
      document.body.removeChild(mockTable);
    });

    const dispatchKeyEvent = (key: string, target?: HTMLElement) => {
      const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
      });
      (target || mockTable).dispatchEvent(event);
    };

    it('should initialize with focused index of -1', () => {
      const { result } = renderHook(() => useKeyboardNavigation(mockTableRef, 10, mockOnRowSelect));

      expect(result.current.focusedRowIndex).toBe(-1);
    });

    it('should navigate down with ArrowDown key', async () => {
      const { result } = renderHook(() => useKeyboardNavigation(mockTableRef, 10, mockOnRowSelect));

      act(() => {
        result.current.setFocusedRowIndex(0);
      });

      act(() => {
        dispatchKeyEvent('ArrowDown');
      });

      await waitFor(() => {
        expect(result.current.focusedRowIndex).toBe(1);
      });
    });

    it('should navigate up with ArrowUp key', async () => {
      const { result } = renderHook(() => useKeyboardNavigation(mockTableRef, 10, mockOnRowSelect));

      act(() => {
        result.current.setFocusedRowIndex(5);
      });

      act(() => {
        dispatchKeyEvent('ArrowUp');
      });

      await waitFor(() => {
        expect(result.current.focusedRowIndex).toBe(4);
      });
    });

    it('should not go below 0 with ArrowUp', async () => {
      const { result } = renderHook(() => useKeyboardNavigation(mockTableRef, 10, mockOnRowSelect));

      act(() => {
        result.current.setFocusedRowIndex(0);
      });

      act(() => {
        dispatchKeyEvent('ArrowUp');
      });

      await waitFor(() => {
        expect(result.current.focusedRowIndex).toBe(0);
      });
    });

    it('should not exceed row count with ArrowDown', async () => {
      const { result } = renderHook(() => useKeyboardNavigation(mockTableRef, 5, mockOnRowSelect));

      act(() => {
        result.current.setFocusedRowIndex(4);
      });

      act(() => {
        dispatchKeyEvent('ArrowDown');
      });

      await waitFor(() => {
        expect(result.current.focusedRowIndex).toBe(4);
      });
    });

    it('should jump to first row with Home key', async () => {
      const { result } = renderHook(() => useKeyboardNavigation(mockTableRef, 10, mockOnRowSelect));

      act(() => {
        result.current.setFocusedRowIndex(5);
      });

      act(() => {
        dispatchKeyEvent('Home');
      });

      await waitFor(() => {
        expect(result.current.focusedRowIndex).toBe(0);
      });
    });

    it('should jump to last row with End key', async () => {
      const { result } = renderHook(() => useKeyboardNavigation(mockTableRef, 10, mockOnRowSelect));

      act(() => {
        result.current.setFocusedRowIndex(0);
      });

      act(() => {
        dispatchKeyEvent('End');
      });

      await waitFor(() => {
        expect(result.current.focusedRowIndex).toBe(9);
      });
    });

    it('should trigger onRowSelect with Enter key', async () => {
      const { result } = renderHook(() => useKeyboardNavigation(mockTableRef, 10, mockOnRowSelect));

      act(() => {
        result.current.setFocusedRowIndex(3);
      });

      act(() => {
        dispatchKeyEvent('Enter');
      });

      await waitFor(() => {
        expect(mockOnRowSelect).toHaveBeenCalledWith(3);
      });
    });

    it('should trigger onRowSelect with Space key', async () => {
      const { result } = renderHook(() => useKeyboardNavigation(mockTableRef, 10, mockOnRowSelect));

      act(() => {
        result.current.setFocusedRowIndex(2);
      });

      act(() => {
        dispatchKeyEvent(' ');
      });

      await waitFor(() => {
        expect(mockOnRowSelect).toHaveBeenCalledWith(2);
      });
    });

    it('should reset focused index with Escape key', async () => {
      const { result } = renderHook(() => useKeyboardNavigation(mockTableRef, 10, mockOnRowSelect));

      act(() => {
        result.current.setFocusedRowIndex(5);
      });

      act(() => {
        dispatchKeyEvent('Escape');
      });

      await waitFor(() => {
        expect(result.current.focusedRowIndex).toBe(-1);
      });
    });

    it('should ignore events outside table', () => {
      const { result } = renderHook(() => useKeyboardNavigation(mockTableRef, 10, mockOnRowSelect));

      const outsideElement = document.createElement('div');
      document.body.appendChild(outsideElement);

      act(() => {
        result.current.setFocusedRowIndex(0);
      });

      const event = new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
      });
      outsideElement.dispatchEvent(event);

      // Should not change because event target is outside table
      expect(result.current.focusedRowIndex).toBe(0);

      document.body.removeChild(outsideElement);
    });

    it('should not call onRowSelect if focused index is -1', () => {
      renderHook(() => useKeyboardNavigation(mockTableRef, 10, mockOnRowSelect));

      act(() => {
        dispatchKeyEvent('Enter');
      });

      expect(mockOnRowSelect).not.toHaveBeenCalled();
    });

    it('should allow manual focus index setting', () => {
      const { result } = renderHook(() => useKeyboardNavigation(mockTableRef, 10, mockOnRowSelect));

      act(() => {
        result.current.setFocusedRowIndex(7);
      });

      expect(result.current.focusedRowIndex).toBe(7);
    });
  });
});

describe('useTableRowHeight', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--theme-table-cell-space-y');
    document.documentElement.style.removeProperty('--theme-table-row-stroke');
  });

  it('is 40px dense, 36px compact and 48px titled without a theme, the heights the tables drew', () => {
    expect(renderHook(() => useTableRowHeight('dense')).result.current).toBe(40);
    expect(renderHook(() => useTableRowHeight('compact')).result.current).toBe(36);
    expect(renderHook(() => useTableRowHeight('titled')).result.current).toBe(48);
  });

  it('follows a theme that repaints the cell space and rules its rows', async () => {
    const { result } = renderHook(() => useTableRowHeight('dense'));
    const titled = renderHook(() => useTableRowHeight('titled'));

    act(() => {
      document.documentElement.style.setProperty('--theme-table-cell-space-y', '8px');
      document.documentElement.style.setProperty('--theme-table-row-stroke', '1px');
    });

    await waitFor(() => expect(result.current).toBe(37));
    /** The title cell's fixed height is a border box, so the rule sits inside it. */
    expect(titled.result.current).toBe(32);
  });
});
