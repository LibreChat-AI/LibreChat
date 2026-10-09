import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Row } from '@tanstack/react-table';
import type { TableColumn } from './DataTable.types';
import { MemoizedTableRow, SelectionCheckbox, SkeletonRows } from './DataTableComponents';

// Mock the cn utility
jest.mock('~/utils', () => ({
  cn: (...classes: (string | undefined | boolean)[]) => classes.filter(Boolean).join(' '),
  logger: {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock the Checkbox component
jest.mock('../Checkbox', () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    'aria-label': ariaLabel,
  }: {
    checked: boolean;
    onCheckedChange: (value: boolean) => void;
    'aria-label': string;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
      aria-label={ariaLabel}
      data-testid="checkbox-input"
    />
  ),
}));

// Mock the Skeleton component
jest.mock('../Skeleton', () => ({
  Skeleton: ({ className }: { className?: string }) => (
    <div data-testid="skeleton" className={className} />
  ),
}));

// Mock the Table components
jest.mock('../Table', () => ({
  TableCell: ({
    children,
    className,
    style,
  }: {
    children?: React.ReactNode;
    className?: string;
    style?: React.CSSProperties;
  }) => (
    <td data-testid="table-cell" className={className} style={style}>
      {children}
    </td>
  ),
  TableRow: ({
    children,
    className,
    'data-state': dataState,
    'data-index': dataIndex,
    style,
  }: {
    children?: React.ReactNode;
    className?: string;
    'data-state'?: string;
    'data-index'?: number;
    style?: React.CSSProperties;
  }) => (
    <tr
      data-testid="table-row"
      className={className}
      data-state={dataState}
      data-index={dataIndex}
      style={style}
    >
      {children}
    </tr>
  ),
  TableRowHeader: ({
    children,
    className,
    style,
  }: {
    children?: React.ReactNode;
    className?: string;
    style?: React.CSSProperties;
  }) => (
    <th data-testid="table-row-header" className={className} style={style}>
      {children}
    </th>
  ),
}));

describe('DataTableComponents', () => {
  describe('SelectionCheckbox', () => {
    it('should render checkbox with correct aria-label', () => {
      render(<SelectionCheckbox checked={false} onChange={jest.fn()} ariaLabel="Select row 1" />);

      const checkbox = screen.getByRole('checkbox');
      expect(checkbox).toHaveAttribute('aria-label', 'Select row 1');
    });

    it('should render in checked state', () => {
      render(<SelectionCheckbox checked={true} onChange={jest.fn()} ariaLabel="Select row" />);

      const checkbox = screen.getByRole('checkbox');
      expect(checkbox).toBeChecked();
    });

    it('should render in unchecked state', () => {
      render(<SelectionCheckbox checked={false} onChange={jest.fn()} ariaLabel="Select row" />);

      const checkbox = screen.getByRole('checkbox');
      expect(checkbox).not.toBeChecked();
    });

    it('should call onChange when clicked', () => {
      const mockOnChange = jest.fn();
      render(<SelectionCheckbox checked={false} onChange={mockOnChange} ariaLabel="Select row" />);

      const checkbox = screen.getByRole('checkbox');
      fireEvent.click(checkbox);

      expect(mockOnChange).toHaveBeenCalledWith(true);
    });

    it('should call onChange with false when unchecking', () => {
      const mockOnChange = jest.fn();
      render(<SelectionCheckbox checked={true} onChange={mockOnChange} ariaLabel="Select row" />);

      const checkbox = screen.getByRole('checkbox');
      fireEvent.click(checkbox);

      expect(mockOnChange).toHaveBeenCalledWith(false);
    });

    it('should expose one native checkbox control', () => {
      render(<SelectionCheckbox checked={false} onChange={jest.fn()} ariaLabel="Select row" />);

      expect(screen.getByRole('checkbox')).toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('should stop event propagation on click', () => {
      const mockOnChange = jest.fn();
      const mockParentClick = jest.fn();

      render(
        <div onClick={mockParentClick}>
          <SelectionCheckbox checked={false} onChange={mockOnChange} ariaLabel="Select row" />
        </div>,
      );

      const checkbox = screen.getByRole('checkbox');
      fireEvent.click(checkbox);

      expect(mockOnChange).toHaveBeenCalled();
      expect(mockParentClick).not.toHaveBeenCalled();
    });

    it('should stop event propagation on keydown', () => {
      const mockOnChange = jest.fn();
      const mockParentKeyDown = jest.fn();

      render(
        <div onKeyDown={mockParentKeyDown}>
          <SelectionCheckbox checked={false} onChange={mockOnChange} ariaLabel="Select row" />
        </div>,
      );

      const checkbox = screen.getByRole('checkbox');
      fireEvent.keyDown(checkbox, { key: 'Enter' });

      expect(mockOnChange).not.toHaveBeenCalled();
      expect(mockParentKeyDown).not.toHaveBeenCalled();
    });

    it('should remain keyboard focusable', () => {
      render(<SelectionCheckbox checked={false} onChange={jest.fn()} ariaLabel="Select row" />);

      const checkbox = screen.getByRole('checkbox');
      expect(checkbox).not.toHaveAttribute('tabindex', '-1');
    });
  });

  describe('SkeletonRows', () => {
    const createTestColumns = () =>
      [
        { accessorKey: 'name', header: 'Name' },
        { accessorKey: 'status', header: 'Status' },
      ] as TableColumn<Record<string, unknown>, unknown>[];

    it('should render correct number of skeleton rows', () => {
      const columns = createTestColumns();
      render(
        <table>
          <tbody>
            <SkeletonRows count={5} columns={columns} />
          </tbody>
        </table>,
      );

      const rows = screen.getAllByTestId('table-row');
      expect(rows).toHaveLength(5);
    });

    it('should use default count of 10 when not provided', () => {
      const columns = createTestColumns();
      render(
        <table>
          <tbody>
            <SkeletonRows columns={columns} />
          </tbody>
        </table>,
      );

      const rows = screen.getAllByTestId('table-row');
      expect(rows).toHaveLength(10);
    });

    it('should render skeleton for each column', () => {
      const columns = createTestColumns();
      render(
        <table>
          <tbody>
            <SkeletonRows count={1} columns={columns} />
          </tbody>
        </table>,
      );

      const skeletons = screen.getAllByTestId('skeleton');
      expect(skeletons).toHaveLength(2); // One per column
    });

    it('should apply custom className from column meta', () => {
      const columns = [
        { accessorKey: 'name', header: 'Name', meta: { className: 'custom-class' } },
      ] as TableColumn<Record<string, unknown>, unknown>[];

      render(
        <table>
          <tbody>
            <SkeletonRows count={1} columns={columns} />
          </tbody>
        </table>,
      );

      const cell = screen.getByTestId('table-cell');
      expect(cell).toHaveClass('custom-class');
    });

    it('should generate unique keys for each row', () => {
      const columns = createTestColumns();
      const { container } = render(
        <table>
          <tbody>
            <SkeletonRows count={3} columns={columns} />
          </tbody>
        </table>,
      );

      // Verify no duplicate keys warning (React would warn in console)
      const rows = container.querySelectorAll('tr');
      expect(rows).toHaveLength(3);
    });

    it('should handle columns with id instead of accessorKey', () => {
      const columns: TableColumn<Record<string, unknown>, unknown>[] = [
        { id: 'custom-id', header: 'Custom Column' },
      ];

      render(
        <table>
          <tbody>
            <SkeletonRows count={1} columns={columns} />
          </tbody>
        </table>,
      );

      const cells = screen.getAllByTestId('table-cell');
      expect(cells).toHaveLength(1);
    });

    it('should handle zero count', () => {
      const columns = createTestColumns();
      render(
        <table>
          <tbody>
            <SkeletonRows count={0} columns={columns} />
          </tbody>
        </table>,
      );

      const rows = screen.queryAllByTestId('table-row');
      expect(rows).toHaveLength(0);
    });

    it('should handle empty columns array', () => {
      render(
        <table>
          <tbody>
            <SkeletonRows count={3} columns={[]} />
          </tbody>
        </table>,
      );

      const rows = screen.getAllByTestId('table-row');
      expect(rows).toHaveLength(3);
      // Rows should have no cells
      const cells = screen.queryAllByTestId('table-cell');
      expect(cells).toHaveLength(0);
    });
  });
});

describe('MemoizedTableRow', () => {
  it('takes a new height when the theme changes the row height of a mounted row', () => {
    const row = { original: {}, getVisibleCells: () => [] } as unknown as Row<
      Record<string, unknown>
    >;
    const renderRow = (height: number) => (
      <table>
        <tbody>
          <MemoizedTableRow row={row} selected={false} style={{ height }} />
        </tbody>
      </table>
    );
    const { container, rerender } = render(renderRow(40));

    rerender(renderRow(37));

    expect((container.querySelector('tr') as HTMLElement).style.height).toBe('37px');
  });
});
