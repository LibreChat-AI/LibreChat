import '@testing-library/jest-dom/extend-expect';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AgentItem } from '../../items/types';
import ItemDialog from '../ItemDialog';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('react-hook-form', () => ({
  useFormContext: () => ({ control: {}, getValues: () => undefined, setValue: jest.fn() }),
  useWatch: () => undefined,
}));

jest.mock('@librechat/client', () => {
  const React = jest.requireActual('react');
  return {
    OGDialog: ({
      children,
      open,
      onOpenChange,
    }: {
      children: React.ReactNode;
      open: boolean;
      onOpenChange?: (next: boolean) => void;
    }) =>
      open
        ? React.createElement(
            'div',
            { role: 'dialog' },
            children,
            React.createElement(
              'button',
              {
                type: 'button',
                onClick: () => onOpenChange?.(false),
                'data-testid': 'mock-close',
              },
              'close',
            ),
          )
        : null,
    OGDialogContent: React.forwardRef(
      ({ children, ...rest }: { children: React.ReactNode }, ref: React.Ref<HTMLDivElement>) =>
        React.createElement('div', { ...rest, ref }, children),
    ),
    OGDialogHeader: ({ children, ...rest }: { children: React.ReactNode }) =>
      React.createElement('div', rest, children),
    OGDialogTitle: ({ children, ...rest }: { children: React.ReactNode }) =>
      React.createElement('h2', rest, children),
    OGDialogDescription: ({ children, ...rest }: { children: React.ReactNode }) =>
      React.createElement('p', rest, children),
  };
});

jest.mock('../ItemDialogBody', () => ({
  __esModule: true,
  default: ({ item }: { item: AgentItem }) => <div data-testid="item-dialog-body">{item.id}</div>,
}));

const skill: AgentItem = {
  kind: 'skill',
  id: 's1',
  name: 'Reviewer',
  description: 'Review PRs',
  iconKey: 'skill',
  skill: { _id: 's1', name: 'Reviewer' } as never,
};

describe('ItemDialog', () => {
  test('renders nothing when item is null', () => {
    render(<ItemDialog item={null} agentId="a1" onClose={jest.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('renders header and body when an item is provided', () => {
    render(<ItemDialog item={skill} agentId="a1" onClose={jest.fn()} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('item-dialog-body')).toHaveTextContent('s1');
    expect(screen.getByText('Reviewer')).toBeInTheDocument();
  });

  test('calls onClose when the dialog requests to close', () => {
    const onClose = jest.fn();
    render(<ItemDialog item={skill} agentId="a1" onClose={onClose} />);
    fireEvent.click(screen.getByTestId('mock-close'));
    expect(onClose).toHaveBeenCalled();
  });
});
