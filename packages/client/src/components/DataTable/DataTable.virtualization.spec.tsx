import React from 'react';
import { Provider as JotaiProvider } from 'jotai';
import { render, screen } from '@testing-library/react';
import type { TableColumn } from './DataTable.types';
import DataTable from './DataTable';

jest.mock('~/utils', () => ({
  cn: (...classes: (string | undefined | boolean)[]) => classes.filter(Boolean).join(' '),
  logger: {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useMediaQuery: jest.fn(() => false),
}));

interface TestRow extends Record<string, unknown> {
  id: string;
  name: string;
}

const columns: TableColumn<TestRow, unknown>[] = [
  {
    accessorKey: 'name',
    header: 'Name',
    cell: ({ row }) => <span>{row.original.name}</span>,
    meta: { width: 100, isRowHeader: true },
  },
];

/** `minRows` defaults to 50, so this is the smallest set that turns virtualization on. */
const makeRows = (count: number): TestRow[] =>
  Array.from({ length: count }, (_, index) => ({ id: `row-${index}`, name: `Row ${index}` }));

const renderTable = (data: TestRow[]) =>
  render(
    <JotaiProvider>
      <DataTable
        columns={columns}
        data={data}
        getRowId={(row) => row.id}
        config={{ selection: { enableRowSelection: false, showCheckboxes: false } }}
      />
    </JotaiProvider>,
  );

/**
 * Exercises the real @tanstack/react-virtual rather than a stub: the virtualizer
 * notifies (and therefore re-renders) whenever its measurement options change
 * identity, so an option rebuilt on every render loops until React gives up.
 */
describe('DataTable virtualization', () => {
  it('renders a virtualized table without looping on re-renders', () => {
    expect(() => renderTable(makeRows(60))).not.toThrow();
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('survives a re-render with the same data', () => {
    const data = makeRows(60);
    const { rerender } = renderTable(data);

    expect(() =>
      rerender(
        <JotaiProvider>
          <DataTable
            columns={columns}
            data={data}
            getRowId={(row) => row.id}
            config={{ selection: { enableRowSelection: false, showCheckboxes: false } }}
          />
        </JotaiProvider>,
      ),
    ).not.toThrow();
  });

  it('stays below the virtualization threshold without looping', () => {
    expect(() => renderTable(makeRows(10))).not.toThrow();
  });
});
