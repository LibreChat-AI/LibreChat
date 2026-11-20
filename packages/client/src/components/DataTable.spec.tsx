import React from 'react';
import { render } from '@testing-library/react';
import * as ReactVirtual from '@tanstack/react-virtual';
import type { ColumnDef } from '@tanstack/react-table';
import DataTable from './DataTable';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useMediaQuery: jest.fn(() => false),
}));

jest.mock('@tanstack/react-virtual', () => {
  const actual = jest.requireActual('@tanstack/react-virtual');
  return { ...actual, useVirtualizer: jest.fn(actual.useVirtualizer) };
});

interface Row {
  title: string;
  owner: string;
}

const data: Row[] = [{ title: 'First', owner: 'Ada' }];

/** The first guess the table gave the virtualizer for a row it has not rendered. */
const estimate = (columns: ColumnDef<Row>[]): number => {
  const useVirtualizer = jest.mocked(ReactVirtual.useVirtualizer);
  useVirtualizer.mockClear();
  render(<DataTable columns={columns} data={data} showCheckboxes={false} />);
  const options = useVirtualizer.mock.calls[0][0];
  return options.estimateSize(0);
};

describe('DataTable row estimate', () => {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    window.matchMedia = jest.fn().mockImplementation(() => ({
      matches: true,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    }));
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('uses the compact estimate when no column is the title', () => {
    expect(estimate([{ accessorKey: 'owner', header: 'Owner' }])).toBe(36);
  });

  it('uses the titled estimate for a title column', () => {
    expect(estimate([{ accessorKey: 'title', header: 'Title' }])).toBe(48);
  });

  it('estimates a compact row at 24px below sm, where the cells carry a quarter of the space', () => {
    window.matchMedia = jest.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    }));
    expect(estimate([{ accessorKey: 'owner', header: 'Owner' }])).toBe(24);
  });

  it('finds a title leaf inside a grouped column definition', () => {
    expect(
      estimate([{ header: 'Group', columns: [{ accessorKey: 'title', header: 'Title' }] }]),
    ).toBe(48);
  });
});
