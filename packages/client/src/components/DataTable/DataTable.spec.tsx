import React from 'react';
import { Provider as JotaiProvider } from 'jotai';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { SortingState } from '@tanstack/react-table';
import type { TableColumn } from './DataTable.types';
import DataTable from './DataTable';

// Mock utilities
jest.mock('~/utils', () => ({
  cn: (...classes: (string | undefined | boolean)[]) => classes.filter(Boolean).join(' '),
  logger: {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock hooks
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, options?: Record<string, unknown>) => {
    if (options && typeof options === 'object') {
      let result = key;
      Object.entries(options).forEach(([k, v]) => {
        result = result.replace(`{${k}}`, String(v));
      });
      return result;
    }
    return key;
  },
  useMediaQuery: jest.fn(() => false),
}));

// jsdom reports a zero-height scroll container, so the real virtualizer resolves an empty
// range and no row assertion below would find its row. Stub it to render every row
// deterministically; DataTable.virtualization.spec.tsx covers the real virtualizer.
jest.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({
    count,
    estimateSize,
  }: {
    count: number;
    estimateSize?: (index: number) => number;
  }) => {
    const size = estimateSize ? estimateSize(0) : 56;
    return {
      getVirtualItems: () =>
        Array.from({ length: count }, (_, index) => ({
          index,
          key: index,
          start: index * size,
          end: (index + 1) * size,
          size,
          lane: 0,
        })),
      getTotalSize: () => count * size,
      calculateRange: () => {},
      measureElement: () => {},
      scrollToIndex: () => {},
    };
  },
}));

// Mock svgs
jest.mock('~/svgs', () => ({
  Spinner: ({ className }: { className?: string }) => (
    <div data-testid="spinner" className={className} />
  ),
}));

// Mock MorphIcon, mapping lucide icon data back to per-icon test ids
jest.mock('../MorphIcon', () => {
  const { createMorphIconMock } = jest.requireActual('../../test/mockMorphIcon');
  const { ArrowUp, ArrowDown, ArrowDownUp } = jest.requireActual('lucide');
  return {
    MorphIcon: createMorphIconMock([
      [ArrowUp, 'arrow-up'],
      [ArrowDown, 'arrow-down'],
      [ArrowDownUp, 'arrow-down-up'],
    ]),
  };
});

// Mock Table components
jest.mock('../Table', () => ({
  Table: ({
    children,
    className,
    role,
    'aria-label': ariaLabel,
    'aria-rowcount': ariaRowCount,
  }: {
    children: React.ReactNode;
    className?: string;
    role?: string;
    'aria-label'?: string;
    'aria-rowcount'?: number;
    unwrapped?: boolean;
  }) => (
    <table
      data-testid="data-table"
      className={className}
      role={role}
      aria-label={ariaLabel}
      aria-rowcount={ariaRowCount}
    >
      {children}
    </table>
  ),
  TableHeader: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <thead data-testid="table-header" className={className}>
      {children}
    </thead>
  ),
  TableBody: ({ children }: { children: React.ReactNode }) => (
    <tbody data-testid="table-body">{children}</tbody>
  ),
  TableHead: ({
    children,
    className,
    onClick,
    onKeyDown,
    role,
    tabIndex,
    'aria-label': ariaLabel,
    'aria-sort': ariaSort,
    scope,
    style,
  }: {
    children: React.ReactNode;
    className?: string;
    onClick?: () => void;
    onKeyDown?: (e: React.KeyboardEvent) => void;
    role?: string;
    tabIndex?: number;
    'aria-label'?: string;
    'aria-sort'?: 'ascending' | 'descending' | 'none';
    scope?: string;
    style?: React.CSSProperties;
  }) => (
    <th
      data-testid="table-head"
      className={className}
      onClick={onClick}
      onKeyDown={onKeyDown}
      role={role}
      tabIndex={tabIndex}
      aria-label={ariaLabel}
      aria-sort={ariaSort}
      scope={scope}
      style={style}
    >
      {children}
    </th>
  ),
  TableRow: ({
    children,
    className,
    'data-state': dataState,
    'data-index': dataIndex,
    style,
    'aria-hidden': ariaHidden,
  }: {
    children: React.ReactNode;
    className?: string;
    'data-state'?: string;
    'data-index'?: number;
    style?: React.CSSProperties;
    'aria-hidden'?: boolean;
  }) => (
    <tr
      data-testid="table-row"
      className={className}
      data-state={dataState}
      data-index={dataIndex}
      style={style}
      aria-hidden={ariaHidden}
    >
      {children}
    </tr>
  ),
  TableCell: ({
    children,
    className,
    colSpan,
    style,
    id,
    role,
    'aria-live': ariaLive,
  }: {
    children?: React.ReactNode;
    className?: string;
    colSpan?: number;
    style?: React.CSSProperties;
    id?: string;
    role?: string;
    'aria-live'?: 'polite' | 'assertive' | 'off';
  }) => (
    <td
      data-testid="table-cell"
      className={className}
      colSpan={colSpan}
      style={style}
      id={id}
      role={role}
      aria-live={ariaLive}
    >
      {children}
    </td>
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
    <th data-testid="table-row-header" className={className} style={style} scope="row">
      {children}
    </th>
  ),
}));

// Mock Label component
jest.mock('../Label', () => ({
  Label: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <label data-testid="label" className={className}>
      {children}
    </label>
  ),
}));

// Mock DataTableSearch component
jest.mock('./DataTableSearch', () => ({
  DataTableSearch: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  }) => (
    <input
      data-testid="search-input"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Search..."
    />
  ),
}));

// Mock Checkbox component
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
      data-testid="checkbox"
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
      aria-label={ariaLabel}
    />
  ),
}));

// Mock Skeleton component
jest.mock('../Skeleton', () => ({
  Skeleton: ({ className }: { className?: string }) => (
    <div data-testid="skeleton" className={className} />
  ),
}));

// Test data types - extends Record<string, unknown> for DataTable compatibility
interface TestData extends Record<string, unknown> {
  id: string;
  name: string;
  status: string;
  createdAt: string;
}

// Helper to create test data
const createTestData = (count: number): TestData[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `row-${i}`,
    name: `Item ${i}`,
    status: i % 2 === 0 ? 'active' : 'inactive',
    createdAt: `2024-01-${String(i + 1).padStart(2, '0')}`,
  }));

// Helper to create test columns
const createTestColumns = (): TableColumn<TestData, string>[] => [
  {
    accessorKey: 'name',
    header: 'Name',
    cell: ({ row }) => row.original.name,
    meta: { isRowHeader: true },
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => row.original.status,
  },
  {
    accessorKey: 'createdAt',
    header: 'Created At',
    cell: ({ row }) => row.original.createdAt,
    meta: { desktopOnly: true },
  },
];

// Wrapper component with providers
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <JotaiProvider>{children}</JotaiProvider>
);

describe('DataTable', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('Rendering', () => {
    it('should render table with columns and data', () => {
      const columns = createTestColumns();
      const data = createTestData(5);

      render(
        <TestWrapper>
          <DataTable columns={columns} data={data} />
        </TestWrapper>,
      );

      expect(screen.getByTestId('data-table')).toBeInTheDocument();
      expect(screen.getByTestId('table-header')).toBeInTheDocument();
      expect(screen.getByTestId('table-body')).toBeInTheDocument();
    });

    it('should render column headers', () => {
      const columns = createTestColumns();
      const data = createTestData(5);

      render(
        <TestWrapper>
          <DataTable columns={columns} data={data} />
        </TestWrapper>,
      );

      const headers = screen.getAllByTestId('table-head');
      // Should have select column + 3 data columns = 4
      expect(headers.length).toBeGreaterThanOrEqual(3);
    });

    it('should show skeleton rows when isLoading is true', () => {
      const columns = createTestColumns();

      render(
        <TestWrapper>
          <DataTable columns={columns} data={[]} isLoading={true} />
        </TestWrapper>,
      );

      const skeletons = screen.getAllByTestId('skeleton');
      expect(skeletons.length).toBeGreaterThan(0);
    });

    it('should show "No data" message when empty', () => {
      const columns = createTestColumns();

      render(
        <TestWrapper>
          <DataTable columns={columns} data={[]} isLoading={false} />
        </TestWrapper>,
      );

      expect(screen.getByText('com_ui_no_data')).toBeInTheDocument();
    });

    it('should show "No search results" when filtered to empty', () => {
      const columns = createTestColumns();

      render(
        <TestWrapper>
          <DataTable
            columns={columns}
            data={[]}
            isLoading={false}
            filterValue="nonexistent"
            onFilterChange={jest.fn()}
          />
        </TestWrapper>,
      );

      // Trigger the search term state update
      const searchInput = screen.getByTestId('search-input');
      fireEvent.change(searchInput, { target: { value: 'nonexistent' } });

      expect(screen.getByText('com_ui_no_search_results')).toBeInTheDocument();
    });

    it('should apply custom className', () => {
      const columns = createTestColumns();
      const data = createTestData(5);

      render(
        <TestWrapper>
          <DataTable columns={columns} data={data} className="custom-table-class" />
        </TestWrapper>,
      );

      const container = screen.getByRole('region', { name: 'com_ui_data_table' });
      expect(container.className).toContain('custom-table-class');
    });

    it('should set aria-rowcount based on data length', () => {
      const columns = createTestColumns();
      const data = createTestData(25);

      render(
        <TestWrapper>
          <DataTable columns={columns} data={data} />
        </TestWrapper>,
      );

      const table = screen.getByTestId('data-table');
      expect(table).toHaveAttribute('aria-rowcount', '25');
    });
  });

  describe('Search', () => {
    it('should render search input when enableSearch is true', () => {
      const columns = createTestColumns();
      const data = createTestData(5);

      render(
        <TestWrapper>
          <DataTable
            columns={columns}
            data={data}
            config={{ search: { enableSearch: true } }}
            onFilterChange={jest.fn()}
          />
        </TestWrapper>,
      );

      expect(screen.getByTestId('search-input')).toBeInTheDocument();
    });

    it('should not render search input when enableSearch is false', () => {
      const columns = createTestColumns();
      const data = createTestData(5);

      render(
        <TestWrapper>
          <DataTable columns={columns} data={data} config={{ search: { enableSearch: false } }} />
        </TestWrapper>,
      );

      expect(screen.queryByTestId('search-input')).not.toBeInTheDocument();
    });

    it('should not render search when onFilterChange is not provided', () => {
      const columns = createTestColumns();
      const data = createTestData(5);

      render(
        <TestWrapper>
          <DataTable columns={columns} data={data} config={{ search: { enableSearch: true } }} />
        </TestWrapper>,
      );

      expect(screen.queryByTestId('search-input')).not.toBeInTheDocument();
    });

    it('should debounce search input', async () => {
      const mockOnFilterChange = jest.fn();
      const columns = createTestColumns();
      const data = createTestData(5);

      render(
        <TestWrapper>
          <DataTable
            columns={columns}
            data={data}
            config={{ search: { enableSearch: true, debounce: 300 } }}
            onFilterChange={mockOnFilterChange}
            filterValue=""
          />
        </TestWrapper>,
      );

      const searchInput = screen.getByTestId('search-input');
      fireEvent.change(searchInput, { target: { value: 'test' } });

      // Should not call immediately
      expect(mockOnFilterChange).not.toHaveBeenCalled();

      // Advance past debounce delay
      jest.advanceTimersByTime(350);

      await waitFor(() => {
        expect(mockOnFilterChange).toHaveBeenCalledWith('test');
      });
    });

    it('should display filterValue in search input', () => {
      const columns = createTestColumns();
      const data = createTestData(5);

      render(
        <TestWrapper>
          <DataTable
            columns={columns}
            data={data}
            filterValue="existing search"
            onFilterChange={jest.fn()}
          />
        </TestWrapper>,
      );

      const searchInput = screen.getByTestId('search-input');
      expect(searchInput).toHaveValue('existing search');
    });
  });

  describe('Sorting', () => {
    it('should render sort icons in sortable headers', () => {
      const columns: TableColumn<TestData, string>[] = [
        {
          accessorKey: 'name',
          header: 'Name',
          enableSorting: true,
        },
      ];
      const data = createTestData(5);

      render(
        <TestWrapper>
          <DataTable columns={columns} data={data} />
        </TestWrapper>,
      );

      // Should show default sort icon
      expect(screen.getByTestId('arrow-down-up')).toBeInTheDocument();
    });

    it('should call onSortingChange when header is clicked', () => {
      const mockOnSortingChange = jest.fn();
      const columns: TableColumn<TestData, string>[] = [
        {
          accessorKey: 'name',
          header: 'Name',
          enableSorting: true,
        },
      ];
      const data = createTestData(5);

      render(
        <TestWrapper>
          <DataTable
            columns={columns}
            data={data}
            sorting={[]}
            onSortingChange={mockOnSortingChange}
          />
        </TestWrapper>,
      );

      const sortButton = screen.getByRole('button', { name: 'Name' });
      fireEvent.click(sortButton);

      expect(mockOnSortingChange).toHaveBeenCalled();
    });

    it('should toggle direction rather than clearing the sort', () => {
      const mockOnSortingChange = jest.fn();
      const columns: TableColumn<TestData, string>[] = [
        {
          accessorKey: 'name',
          header: 'Name',
          enableSorting: true,
        },
      ];

      render(
        <TestWrapper>
          <DataTable
            columns={columns}
            data={createTestData(5)}
            sorting={[{ id: 'name', desc: true }]}
            onSortingChange={mockOnSortingChange}
          />
        </TestWrapper>,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Name' }));

      const updater = mockOnSortingChange.mock.calls[0][0];
      const next =
        typeof updater === 'function'
          ? updater([{ id: 'name', desc: true }] as SortingState)
          : updater;
      expect(next).toEqual([{ id: 'name', desc: false }]);
    });

    it('should expose sorting through a native button', () => {
      const columns: TableColumn<TestData, string>[] = [
        {
          accessorKey: 'name',
          header: 'Name',
          enableSorting: true,
        },
      ];
      const data = createTestData(5);

      render(
        <TestWrapper>
          <DataTable columns={columns} data={data} sorting={[]} onSortingChange={jest.fn()} />
        </TestWrapper>,
      );

      const sortButton = screen.getByRole('button', { name: 'Name' });
      expect(sortButton.tagName).toBe('BUTTON');
      expect(sortButton).toHaveAttribute('type', 'button');
    });

    it('should show ascending icon when sorted ascending', () => {
      const columns: TableColumn<TestData, string>[] = [
        {
          accessorKey: 'name',
          header: 'Name',
          enableSorting: true,
        },
      ];
      const data = createTestData(5);
      const sorting: SortingState = [{ id: 'name', desc: false }];

      render(
        <TestWrapper>
          <DataTable columns={columns} data={data} sorting={sorting} onSortingChange={jest.fn()} />
        </TestWrapper>,
      );

      expect(screen.getByTestId('arrow-up')).toBeInTheDocument();
    });

    it('should show descending icon when sorted descending', () => {
      const columns: TableColumn<TestData, string>[] = [
        {
          accessorKey: 'name',
          header: 'Name',
          enableSorting: true,
        },
      ];
      const data = createTestData(5);
      const sorting: SortingState = [{ id: 'name', desc: true }];

      render(
        <TestWrapper>
          <DataTable columns={columns} data={data} sorting={sorting} onSortingChange={jest.fn()} />
        </TestWrapper>,
      );

      expect(screen.getByTestId('arrow-down')).toBeInTheDocument();
    });

    it('should use internal sorting state when onSortingChange not provided', () => {
      const columns: TableColumn<TestData, string>[] = [
        {
          accessorKey: 'name',
          header: 'Name',
          enableSorting: true,
        },
      ];
      const data = createTestData(5);

      render(
        <TestWrapper>
          <DataTable columns={columns} data={data} />
        </TestWrapper>,
      );

      const sortButton = screen.getByRole('button', { name: 'Name' });
      fireEvent.click(sortButton);

      // Should show ascending icon after click
      expect(screen.getByTestId('arrow-up')).toBeInTheDocument();
    });
  });

  describe('Row Selection', () => {
    it('should show checkboxes when showCheckboxes is true', () => {
      const columns = createTestColumns();
      const data = createTestData(5);

      render(
        <TestWrapper>
          <DataTable
            columns={columns}
            data={data}
            config={{ selection: { enableRowSelection: true, showCheckboxes: true } }}
          />
        </TestWrapper>,
      );

      const checkboxes = screen.getAllByTestId('checkbox');
      // Should have header checkbox + one per row
      expect(checkboxes.length).toBeGreaterThanOrEqual(1);
    });

    it('should not show checkboxes when showCheckboxes is false', () => {
      const columns = createTestColumns();
      const data = createTestData(5);

      render(
        <TestWrapper>
          <DataTable
            columns={columns}
            data={data}
            config={{ selection: { enableRowSelection: true, showCheckboxes: false } }}
          />
        </TestWrapper>,
      );

      const checkboxes = screen.queryAllByTestId('checkbox');
      expect(checkboxes).toHaveLength(0);
    });

    it('should not show checkboxes when enableRowSelection is false', () => {
      const columns = createTestColumns();
      const data = createTestData(5);

      render(
        <TestWrapper>
          <DataTable
            columns={columns}
            data={data}
            config={{ selection: { enableRowSelection: false } }}
          />
        </TestWrapper>,
      );

      const checkboxes = screen.queryAllByTestId('checkbox');
      expect(checkboxes).toHaveLength(0);
    });
  });

  describe('Virtualization', () => {
    it('should activate virtualization when data length >= minRows', () => {
      const columns = createTestColumns();
      const data = createTestData(100); // More than default minRows of 50

      render(
        <TestWrapper>
          <DataTable columns={columns} data={data} />
        </TestWrapper>,
      );

      // Table should still render
      expect(screen.getByTestId('data-table')).toBeInTheDocument();
    });

    it('should not use virtualization for small datasets', () => {
      const columns = createTestColumns();
      const data = createTestData(10); // Less than minRows

      render(
        <TestWrapper>
          <DataTable columns={columns} data={data} />
        </TestWrapper>,
      );

      // All rows should be rendered
      const rows = screen.getAllByTestId('table-row');
      expect(rows.length).toBeGreaterThanOrEqual(10);
    });

    it('should respect custom minRows config', () => {
      const columns = createTestColumns();
      const data = createTestData(20);

      render(
        <TestWrapper>
          <DataTable
            columns={columns}
            data={data}
            config={{ virtualization: { minRows: 10 } }} // Lower threshold
          />
        </TestWrapper>,
      );

      // Virtualization should be active
      expect(screen.getByTestId('data-table')).toBeInTheDocument();
    });
  });

  describe('Infinite Scroll', () => {
    it('should show loading spinner when isFetchingNextPage is true', () => {
      const columns = createTestColumns();
      const data = createTestData(5);

      render(
        <TestWrapper>
          <DataTable
            columns={columns}
            data={data}
            isFetchingNextPage={true}
            hasNextPage={true}
            fetchNextPage={jest.fn()}
          />
        </TestWrapper>,
      );

      expect(screen.getByTestId('spinner')).toBeInTheDocument();
    });

    it('should not show loading spinner when not fetching', () => {
      const columns = createTestColumns();
      const data = createTestData(5);

      render(
        <TestWrapper>
          <DataTable
            columns={columns}
            data={data}
            isFetchingNextPage={false}
            hasNextPage={true}
            fetchNextPage={jest.fn()}
          />
        </TestWrapper>,
      );

      expect(screen.queryByTestId('spinner')).not.toBeInTheDocument();
    });

    it('does not paginate on scroll while the replacement page is loading', () => {
      const fetchNextPage = jest.fn().mockResolvedValue(undefined);
      const clientHeight = jest
        .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
        .mockReturnValue(600);
      const scrollHeight = jest
        .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
        .mockReturnValue(700);

      const { container } = render(
        <TestWrapper>
          <DataTable
            columns={createTestColumns()}
            data={createTestData(30)}
            hasNextPage={true}
            isFetching={true}
            isFetchingNextPage={false}
            fetchNextPage={fetchNextPage}
          />
        </TestWrapper>,
      );

      const scrollArea = container.querySelector(
        '[aria-label="com_ui_data_table_scroll_area"]',
      ) as HTMLElement;
      fireEvent.scroll(scrollArea);
      jest.advanceTimersByTime(200);

      expect(fetchNextPage).not.toHaveBeenCalled();
      clientHeight.mockRestore();
      scrollHeight.mockRestore();
    });

    describe('auto-fill when the first page cannot scroll', () => {
      const stubLayout = ({
        clientHeight,
        scrollHeight,
      }: {
        clientHeight: number;
        scrollHeight: number;
      }) => {
        jest.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(clientHeight);
        jest.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(scrollHeight);
      };

      afterEach(() => {
        jest.restoreAllMocks();
      });

      it('fetches the next page when the rows do not overflow the container', () => {
        stubLayout({ clientHeight: 600, scrollHeight: 300 });
        const fetchNextPage = jest.fn().mockResolvedValue(undefined);

        render(
          <TestWrapper>
            <DataTable
              columns={createTestColumns()}
              data={createTestData(3)}
              hasNextPage={true}
              isFetchingNextPage={false}
              fetchNextPage={fetchNextPage}
            />
          </TestWrapper>,
        );

        expect(fetchNextPage).toHaveBeenCalledTimes(1);
      });

      it('leaves pagination to the scroll handler once the rows overflow', () => {
        stubLayout({ clientHeight: 600, scrollHeight: 1200 });
        const fetchNextPage = jest.fn().mockResolvedValue(undefined);

        render(
          <TestWrapper>
            <DataTable
              columns={createTestColumns()}
              data={createTestData(30)}
              hasNextPage={true}
              isFetchingNextPage={false}
              fetchNextPage={fetchNextPage}
            />
          </TestWrapper>,
        );

        expect(fetchNextPage).not.toHaveBeenCalled();
      });

      it('does not fetch while the container is unmeasured', () => {
        stubLayout({ clientHeight: 0, scrollHeight: 0 });
        const fetchNextPage = jest.fn().mockResolvedValue(undefined);

        render(
          <TestWrapper>
            <DataTable
              columns={createTestColumns()}
              data={createTestData(3)}
              hasNextPage={true}
              isFetchingNextPage={false}
              fetchNextPage={fetchNextPage}
            />
          </TestWrapper>,
        );

        expect(fetchNextPage).not.toHaveBeenCalled();
      });

      it('retries a rejected fetch, then gives up instead of hammering', async () => {
        stubLayout({ clientHeight: 600, scrollHeight: 300 });
        const fetchNextPage = jest.fn().mockRejectedValue(new Error('offline'));

        render(
          <TestWrapper>
            <DataTable
              columns={createTestColumns()}
              data={createTestData(3)}
              hasNextPage={true}
              isFetchingNextPage={false}
              fetchNextPage={fetchNextPage}
            />
          </TestWrapper>,
        );

        await waitFor(() => expect(fetchNextPage).toHaveBeenCalledTimes(3));
        await Promise.resolve();
        expect(fetchNextPage).toHaveBeenCalledTimes(3);
      });

      it('re-arms when the sort changes under a same-sized page', () => {
        stubLayout({ clientHeight: 600, scrollHeight: 300 });
        const fetchNextPage = jest.fn().mockResolvedValue(undefined);
        const props = {
          columns: createTestColumns(),
          data: createTestData(3),
          hasNextPage: true,
          isFetchingNextPage: false,
          fetchNextPage,
          onSortingChange: jest.fn(),
        };

        const { rerender } = render(
          <TestWrapper>
            <DataTable {...props} sorting={[{ id: 'name', desc: false }]} />
          </TestWrapper>,
        );

        expect(fetchNextPage).toHaveBeenCalledTimes(1);

        rerender(
          <TestWrapper>
            <DataTable {...props} sorting={[{ id: 'name', desc: true }]} />
          </TestWrapper>,
        );

        expect(fetchNextPage).toHaveBeenCalledTimes(2);
      });

      it('sends the viewport back to the top when the sort changes', () => {
        stubLayout({ clientHeight: 600, scrollHeight: 1200 });
        const props = {
          columns: createTestColumns(),
          data: createTestData(30),
          onSortingChange: jest.fn(),
        };

        const { rerender, container } = render(
          <TestWrapper>
            <DataTable {...props} sorting={[{ id: 'name', desc: false }]} />
          </TestWrapper>,
        );

        const scrollArea = container.querySelector('[aria-label="com_ui_data_table_scroll_area"]');
        expect(scrollArea).not.toBeNull();
        (scrollArea as HTMLElement).scrollTop = 400;

        rerender(
          <TestWrapper>
            <DataTable {...props} sorting={[{ id: 'name', desc: true }]} />
          </TestWrapper>,
        );

        expect((scrollArea as HTMLElement).scrollTop).toBe(0);
      });

      it('retries when the fetch resolves with a failed result', async () => {
        stubLayout({ clientHeight: 600, scrollHeight: 300 });
        // React Query hands back a failed result instead of rejecting.
        const fetchNextPage = jest
          .fn()
          .mockResolvedValue({ isError: true, error: new Error('offline') });

        render(
          <TestWrapper>
            <DataTable
              columns={createTestColumns()}
              data={createTestData(3)}
              hasNextPage={true}
              isFetchingNextPage={false}
              fetchNextPage={fetchNextPage}
            />
          </TestWrapper>,
        );

        await waitFor(() => expect(fetchNextPage).toHaveBeenCalledTimes(3));
        await Promise.resolve();
        expect(fetchNextPage).toHaveBeenCalledTimes(3);
      });

      it('waits for the replacement query instead of racing it', () => {
        stubLayout({ clientHeight: 600, scrollHeight: 300 });
        const fetchNextPage = jest.fn().mockResolvedValue(undefined);

        render(
          <TestWrapper>
            <DataTable
              columns={createTestColumns()}
              data={createTestData(3)}
              hasNextPage={true}
              isFetching={true}
              isFetchingNextPage={false}
              fetchNextPage={fetchNextPage}
            />
          </TestWrapper>,
        );

        expect(fetchNextPage).not.toHaveBeenCalled();
      });

      it('stops after a page that adds no rows', () => {
        stubLayout({ clientHeight: 600, scrollHeight: 300 });
        const fetchNextPage = jest.fn().mockResolvedValue(undefined);
        const props = {
          columns: createTestColumns(),
          data: createTestData(3),
          hasNextPage: true,
          fetchNextPage,
        };

        const { rerender } = render(
          <TestWrapper>
            <DataTable {...props} isFetchingNextPage={false} />
          </TestWrapper>,
        );

        rerender(
          <TestWrapper>
            <DataTable {...props} isFetchingNextPage={true} />
          </TestWrapper>,
        );
        rerender(
          <TestWrapper>
            <DataTable {...props} isFetchingNextPage={false} />
          </TestWrapper>,
        );

        expect(fetchNextPage).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Row memoization', () => {
    it('re-renders rows when the column definitions change', () => {
      const makeColumns = (label: string): TableColumn<TestData, string>[] => [
        {
          accessorKey: 'name',
          header: 'Name',
          cell: () => <span data-testid="action-cell">{label}</span>,
        },
      ];
      // The same rows: only the cells change, which is what a pending row action
      // looks like to the memo comparator.
      const data = createTestData(3);

      const { rerender } = render(
        <TestWrapper>
          <DataTable columns={makeColumns('Restore')} data={data} />
        </TestWrapper>,
      );

      expect(screen.getAllByTestId('action-cell')[0]).toHaveTextContent('Restore');

      rerender(
        <TestWrapper>
          <DataTable columns={makeColumns('Restoring')} data={data} />
        </TestWrapper>,
      );

      expect(screen.getAllByTestId('action-cell')[0]).toHaveTextContent('Restoring');
    });
  });

  describe('Custom Actions', () => {
    it('should render customActionsRenderer with selected info', () => {
      const columns = createTestColumns();
      const data = createTestData(5);
      const mockRenderer = jest.fn().mockReturnValue(<div data-testid="custom-actions" />);

      render(
        <TestWrapper>
          <DataTable columns={columns} data={data} customActionsRenderer={mockRenderer} />
        </TestWrapper>,
      );

      expect(screen.getByTestId('custom-actions')).toBeInTheDocument();
      expect(mockRenderer).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedCount: 0,
          selectedRows: [],
          table: expect.any(Object),
        }),
      );
    });

    it('should pass updated selection to customActionsRenderer', () => {
      const columns = createTestColumns();
      const data = createTestData(5);
      const mockRenderer = jest.fn().mockReturnValue(<div data-testid="custom-actions" />);

      render(
        <TestWrapper>
          <DataTable columns={columns} data={data} customActionsRenderer={mockRenderer} />
        </TestWrapper>,
      );

      // Initial call should have 0 selected
      expect(mockRenderer).toHaveBeenLastCalledWith(
        expect.objectContaining({
          selectedCount: 0,
          selectedRows: [],
        }),
      );
    });
  });

  describe('Skeleton Loading', () => {
    it('should show skeleton rows based on skeleton count config', () => {
      const columns = createTestColumns();

      render(
        <TestWrapper>
          <DataTable
            columns={columns}
            data={[]}
            isLoading={true}
            config={{ skeleton: { count: 5 } }}
          />
        </TestWrapper>,
      );

      const skeletons = screen.getAllByTestId('skeleton');
      // 5 rows * number of columns
      expect(skeletons.length).toBeGreaterThan(0);
    });

    it('should show skeletons when isFetching but not isFetchingNextPage', () => {
      const columns = createTestColumns();

      render(
        <TestWrapper>
          <DataTable
            columns={columns}
            data={[]}
            isFetching={true}
            isFetchingNextPage={false}
            hasNextPage={true}
            fetchNextPage={jest.fn()}
          />
        </TestWrapper>,
      );

      const skeletons = screen.getAllByTestId('skeleton');
      expect(skeletons.length).toBeGreaterThan(0);
    });
  });

  describe('Data without IDs', () => {
    it('should handle data without id property using index fallback', () => {
      const columns: TableColumn<{ name: string }, string>[] = [
        { accessorKey: 'name', header: 'Name' },
      ];
      const dataWithoutIds = [{ name: 'Item 1' }, { name: 'Item 2' }];

      // Should render without errors
      render(
        <TestWrapper>
          <DataTable columns={columns} data={dataWithoutIds as TestData[]} />
        </TestWrapper>,
      );

      expect(screen.getByTestId('data-table')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have role="region" on container', () => {
      const columns = createTestColumns();
      const data = createTestData(5);

      render(
        <TestWrapper>
          <DataTable columns={columns} data={data} />
        </TestWrapper>,
      );

      expect(screen.getByRole('region', { name: 'com_ui_data_table' })).toBeInTheDocument();
    });

    it('should have aria-label on table', () => {
      const columns = createTestColumns();
      const data = createTestData(5);

      render(
        <TestWrapper>
          <DataTable columns={columns} data={data} />
        </TestWrapper>,
      );

      const table = screen.getByTestId('data-table');
      expect(table).toHaveAttribute('aria-label', 'com_ui_data_table');
    });

    it('should preserve column-header semantics and use a nested sort button', () => {
      const columns: TableColumn<TestData, string>[] = [
        {
          accessorKey: 'name',
          header: 'Name',
          enableSorting: true,
        },
      ];
      const data = createTestData(5);

      render(
        <TestWrapper>
          <DataTable columns={columns} data={data} />
        </TestWrapper>,
      );

      const sortableHeader = screen.getAllByTestId('table-head')[1];
      expect(sortableHeader).toHaveAttribute('scope', 'col');
      expect(sortableHeader).not.toHaveAttribute('role', 'button');
      expect(screen.getByRole('button', { name: 'Name' })).toBeInTheDocument();
    });
  });
});
