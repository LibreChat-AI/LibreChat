import '@testing-library/jest-dom/extend-expect';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AgentItem } from '../items/types';
import MarketplaceCatalog from '../MarketplaceCatalog';
import { itemKey } from '../items/selectors';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAuthContext: () => ({ user: { id: 'u1' } }),
}));

const items: AgentItem[] = [
  {
    kind: 'builtin',
    id: 'execute_code',
    name: 'Code',
    description: 'Run',
    iconKey: 'execute_code',
  },
  {
    kind: 'tool',
    id: 'dalle',
    name: 'DALL-E',
    description: 'Images',
    iconKey: 'tool',
    plugin: { pluginKey: 'dalle' } as never,
  },
];

describe('MarketplaceCatalog', () => {
  test('renders one card per item', () => {
    render(<MarketplaceCatalog items={items} selectedIds={new Set()} onToggle={jest.fn()} />);
    expect(screen.getByText('Code')).toBeInTheDocument();
    expect(screen.getByText('DALL-E')).toBeInTheDocument();
  });

  test('clicking a card calls onToggle with the item', () => {
    const onToggle = jest.fn();
    render(<MarketplaceCatalog items={items} selectedIds={new Set()} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: /DALL-E/ }));
    expect(onToggle).toHaveBeenCalledWith(items[1]);
  });

  test('selected ids mark cards aria-pressed=true', () => {
    render(
      <MarketplaceCatalog
        items={items}
        selectedIds={new Set([itemKey(items[1])])}
        onToggle={jest.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /DALL-E/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^Code/ })).toHaveAttribute('aria-pressed', 'false');
  });

  test('empty catalog shows "no results" message', () => {
    render(<MarketplaceCatalog items={[]} selectedIds={new Set()} onToggle={jest.fn()} />);
    expect(screen.getByText('com_ui_tools_search_no_results')).toBeInTheDocument();
  });
});
