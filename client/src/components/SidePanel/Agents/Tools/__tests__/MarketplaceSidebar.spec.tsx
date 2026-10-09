import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { fireEvent, render, screen } from '@testing-library/react';
import MarketplaceSidebar from '../MarketplaceSidebar';

let mockHasMcpCreateAccess = true;
let mockCapabilities: string[] = ['actions'];

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => mockHasMcpCreateAccess,
}));

jest.mock('~/Providers', () => ({
  useAgentPanelContext: () => ({ agentsConfig: { capabilities: mockCapabilities } }),
}));

jest.mock('@ariakit/react/menu', () => ({
  MenuButton: ({ render: rendered }: { render: React.ReactNode }) => rendered,
}));

jest.mock('@librechat/client', () => {
  const ReactActual = jest.requireActual('react');
  return {
    Button: ({ children, ...rest }: React.ComponentProps<'button'>) =>
      ReactActual.createElement('button', { type: 'button', ...rest }, children),
    DropdownPopup: ({
      trigger,
      items,
    }: {
      trigger: React.ReactNode;
      items: Array<{ label: string; onClick: () => void }>;
    }) =>
      ReactActual.createElement(
        'div',
        null,
        trigger,
        items.map((item) =>
          ReactActual.createElement(
            'button',
            {
              key: item.label,
              type: 'button',
              'data-testid': 'create-item',
              onClick: item.onClick,
            },
            item.label,
          ),
        ),
      ),
  };
});

describe('MarketplaceSidebar', () => {
  const defaultProps = {
    activeView: 'marketplace' as const,
    activeKind: 'all' as const,
    onSelectView: jest.fn(),
    onSelectKind: jest.fn(),
    counts: { tool: 2, skill: 3, mcp: 1, action: 0, builtin: 5 },
    totalCount: 11,
  };

  beforeEach(() => {
    mockHasMcpCreateAccess = true;
    mockCapabilities = ['actions'];
  });

  test('shows the All entry with total count', () => {
    render(<MarketplaceSidebar {...defaultProps} />);
    expect(screen.getByText('com_ui_all_proper')).toBeInTheDocument();
    expect(screen.getByText('11')).toBeInTheDocument();
  });

  test('clicking a kind filter calls onSelectKind', () => {
    const onSelectKind = jest.fn();
    render(<MarketplaceSidebar {...defaultProps} onSelectKind={onSelectKind} />);
    fireEvent.click(screen.getByText('com_ui_tools_kind_tools'));
    expect(onSelectKind).toHaveBeenCalledWith('tool');
  });

  test('does not render a Skills kind filter', () => {
    render(<MarketplaceSidebar {...defaultProps} />);
    expect(screen.queryByText('com_ui_tools_kind_skills')).not.toBeInTheDocument();
  });

  test('clicking favorites switches the view filter', () => {
    const onSelectView = jest.fn();
    render(<MarketplaceSidebar {...defaultProps} onSelectView={onSelectView} />);
    fireEvent.click(screen.getByText('com_ui_tools_view_favorites'));
    expect(onSelectView).toHaveBeenCalledWith('favorites');
  });

  test('clicking All resets both kind and view', () => {
    const onSelectKind = jest.fn();
    const onSelectView = jest.fn();
    render(
      <MarketplaceSidebar
        {...defaultProps}
        activeKind="builtin"
        onSelectKind={onSelectKind}
        onSelectView={onSelectView}
      />,
    );
    fireEvent.click(screen.getByText('com_ui_all_proper'));
    expect(onSelectKind).toHaveBeenCalledWith('all');
    expect(onSelectView).toHaveBeenCalledWith('marketplace');
  });

  describe('create menu gating', () => {
    test('offers MCP and Actions entries when both are permitted', () => {
      render(<MarketplaceSidebar {...defaultProps} onCreateNew={jest.fn()} />);
      expect(screen.getAllByTestId('create-item').map((el) => el.textContent)).toEqual([
        'com_ui_tools_kind_mcp',
        'com_ui_tools_kind_actions',
      ]);
    });

    test('clicking a create entry forwards its kind', () => {
      const onCreateNew = jest.fn();
      render(<MarketplaceSidebar {...defaultProps} onCreateNew={onCreateNew} />);
      const [mcpEntry] = screen.getAllByTestId('create-item');
      fireEvent.click(mcpEntry);
      expect(onCreateNew).toHaveBeenCalledWith('mcp');
    });

    test('hides the MCP entry without the MCP create permission', () => {
      mockHasMcpCreateAccess = false;
      render(<MarketplaceSidebar {...defaultProps} onCreateNew={jest.fn()} />);
      expect(screen.getAllByTestId('create-item').map((el) => el.textContent)).toEqual([
        'com_ui_tools_kind_actions',
      ]);
    });

    test('hides the Actions entry when the actions capability is disabled', () => {
      mockCapabilities = [];
      render(<MarketplaceSidebar {...defaultProps} onCreateNew={jest.fn()} />);
      expect(screen.getAllByTestId('create-item').map((el) => el.textContent)).toEqual([
        'com_ui_tools_kind_mcp',
      ]);
    });

    test('hides the Create New button entirely when nothing can be created', () => {
      mockHasMcpCreateAccess = false;
      mockCapabilities = [];
      render(<MarketplaceSidebar {...defaultProps} onCreateNew={jest.fn()} />);
      expect(screen.queryByText('com_ui_tools_create_new')).not.toBeInTheDocument();
      expect(screen.queryAllByTestId('create-item')).toHaveLength(0);
    });
  });
});
