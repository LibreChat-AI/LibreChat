import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ListRowProps } from 'react-virtualized';
import type { ForwardedRef, ReactNode } from 'react';
import type { Endpoint } from '~/common';
import VirtualizedModelList from '../VirtualizedModelList';

type MockListProps = {
  width: number;
  rowCount: number;
  rowRenderer: (props: ListRowProps) => ReactNode;
};

let mockActiveIdForTest: string | null = null;
const mockMoveForTest = jest.fn();
const mockScrollToRowForTest = jest.fn();
jest.mock('react-virtualized', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    AutoSizer: ({ children }: { children: (size: { width: number }) => ReactNode }) =>
      children({ width: 280 }),
    List: React.forwardRef(function MockList(
      { width, rowCount, rowRenderer }: MockListProps,
      ref: ForwardedRef<unknown>,
    ) {
      React.useImperativeHandle(ref, () => ({ scrollToRow: mockScrollToRowForTest }));
      return React.createElement(
        'div',
        { 'data-testid': 'virtual-list', 'data-width': width, 'data-row-count': rowCount },
        [0, 1].map((index) =>
          rowRenderer({
            index,
            key: `row-${index}`,
            style: { height: 36, top: index * 36 },
            isScrolling: false,
            isVisible: true,
            columnIndex: 0,
            parent: {} as ListRowProps['parent'],
          }),
        ),
      );
    }),
  };
});
jest.mock('@ariakit/react', () => ({
  useComboboxContext: () => ({
    getState: () => ({ activeId: mockActiveIdForTest }),
    move: mockMoveForTest,
  }),
}));

jest.mock('../EndpointModelItem', () => ({
  EndpointModelItem: ({ modelId }: { modelId: string }) => (
    <div role="option" aria-selected="false" data-testid={`model-${modelId}`}>
      {modelId}
    </div>
  ),
}));

const endpoint: Endpoint = {
  value: 'agents',
  label: 'My Agents',
  hasModels: true,
  models: [],
  icon: null,
};

describe('VirtualizedModelList', () => {
  beforeEach(() => {
    mockActiveIdForTest = null;
    mockMoveForTest.mockClear();
    mockScrollToRowForTest.mockClear();
  });
  it('uses measured container width and mounts only the rendered window', () => {
    const modelIds = Array.from({ length: 101 }, (_, index) => `agent-${index}`);
    render(
      <VirtualizedModelList
        endpoint={endpoint}
        modelIds={modelIds}
        globalByName={new Map()}
        isFavorite={() => false}
        onToggleFavorite={() => undefined}
        precedingOptionCount={0}
      />,
    );

    const list = screen.getByTestId('virtual-list');
    expect(list).toHaveAttribute('data-width', '280');
    expect(list).toHaveAttribute('data-row-count', '101');
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.getByTestId('model-agent-0')).toBeInTheDocument();
    expect(screen.getByTestId('model-agent-1')).toBeInTheDocument();
    expect(screen.queryByTestId('model-agent-100')).not.toBeInTheDocument();
  });
  it('uses logical positions when two virtualized groups share a listbox', async () => {
    const modelIds = Array.from({ length: 101 }, (_, index) => `agent-${index}`);
    render(
      <div role="listbox">
        <div
          id="before"
          role="option"
          aria-selected={false}
          aria-posinset={2}
          data-testid="before"
        />
        <VirtualizedModelList
          endpoint={endpoint}
          modelIds={modelIds}
          globalByName={new Map()}
          isFavorite={() => false}
          onToggleFavorite={() => undefined}
          precedingOptionCount={2}
        />
        <div
          id="after-first"
          role="option"
          aria-selected={false}
          aria-posinset={104}
          data-testid="after-first"
        />
        <VirtualizedModelList
          endpoint={{ ...endpoint, value: 'agents-b' }}
          modelIds={modelIds}
          globalByName={new Map()}
          isFavorite={() => false}
          onToggleFavorite={() => undefined}
          precedingOptionCount={103}
        />
      </div>,
    );

    mockActiveIdForTest = 'before';
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    await waitFor(() => expect(mockScrollToRowForTest).toHaveBeenCalledTimes(1));
    expect(mockScrollToRowForTest).toHaveBeenLastCalledWith(0);

    mockScrollToRowForTest.mockClear();
    mockActiveIdForTest = 'after-first';
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    await waitFor(() => expect(mockScrollToRowForTest).toHaveBeenCalledTimes(1));
    expect(mockScrollToRowForTest).toHaveBeenLastCalledWith(100);
  });
});
