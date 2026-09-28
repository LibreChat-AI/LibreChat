import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@testing-library/react';
import MCPSelect from '../MCPSelect';

const mockToggleServerSelection = jest.fn();

const defaultMcpServerManager = {
  localize: (key: string) => key,
  isPinned: true,
  mcpValues: [] as string[],
  placeholderText: 'MCP Servers',
  selectableServers: [
    { serverName: 'server-a', config: { title: 'Server A' } },
    { serverName: 'server-b', config: { title: 'Server B' } },
  ],
  availableMCPServers: [{ serverName: 'server-a' }, { serverName: 'server-b' }],
  connectionStatus: {},
  isInitializing: () => false,
  getConfigDialogProps: () => null,
  toggleServerSelection: mockToggleServerSelection,
  getServerStatusIconProps: () => null,
};

let mockCanUseMcp = true;
let mockMcpServerManager = { ...defaultMcpServerManager };

const mockMCPRefresh = jest.fn();

jest.mock('~/hooks/MCP/useMCPRefresh', () => ({
  useMCPRefresh: (options: { enabled: boolean; tools?: boolean }) => mockMCPRefresh(options),
}));

jest.mock('~/Providers', () => ({
  useBadgeRowContext: () => ({
    conversationId: 'test-conv',
    storageContextKey: undefined,
    mcpServerManager: mockMcpServerManager,
  }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => mockCanUseMcp,
}));

jest.mock('@librechat/client', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  return {
    /** The real recipe, so the geometry assertions below cover shipped classes. */
    composerControlClasses: jest.requireActual('@librechat/client').composerControlClasses,
    TooltipAnchor: ({
      children,
      render,
    }: {
      children: React.ReactNode;
      render: React.ReactElement;
    }) => R.cloneElement(render, {}, ...(Array.isArray(children) ? children : [children])),
    MCPIcon: ({ className }: { className?: string }) => R.createElement('span', { className }),
    Spinner: ({ className }: { className?: string }) => R.createElement('span', { className }),
  };
});

jest.mock('~/components/MCP/MCPConfigDialog', () => ({
  __esModule: true,
  default: () => null,
}));

describe('MCPSelect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCanUseMcp = true;
    mockMcpServerManager = { ...defaultMcpServerManager };
  });

  it('renders the menu button', () => {
    render(<MCPSelect />);
    expect(mockMCPRefresh).toHaveBeenLastCalledWith({ enabled: false });
    expect(screen.getByRole('button', { name: /MCP Servers/i })).toHaveClass(
      'h-theme-control',
      'min-w-theme-control',
      'rounded-theme-control-round',
      'gap-theme-compact',
    );
  });

  it('opens menu on button click and shows server items', async () => {
    const user = userEvent.setup();
    render(<MCPSelect />);

    await user.click(screen.getByRole('button', { name: /MCP Servers/i }));

    expect(mockMCPRefresh).toHaveBeenLastCalledWith({ enabled: true });
    const menu = screen.getByRole('menu', { name: /com_ui_mcp_servers/i });
    expect(menu).toBeVisible();
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Server A/i })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Server B/i })).toBeInTheDocument();
  });

  it('closes menu on Escape', async () => {
    const user = userEvent.setup();
    render(<MCPSelect />);

    await user.click(screen.getByRole('button', { name: /MCP Servers/i }));
    expect(screen.getByRole('menu', { name: /com_ui_mcp_servers/i })).toBeVisible();

    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: /MCP Servers/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('keeps menu open after toggling a server item', async () => {
    const user = userEvent.setup();
    render(<MCPSelect />);

    await user.click(screen.getByRole('button', { name: /MCP Servers/i }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: /Server A/i }));

    expect(mockToggleServerSelection).toHaveBeenCalledWith('server-a');
    expect(screen.getByRole('menu', { name: /com_ui_mcp_servers/i })).toBeVisible();
  });

  it('arrow-key navigation wraps from last item to first', async () => {
    const user = userEvent.setup();
    render(<MCPSelect />);

    await user.click(screen.getByRole('button', { name: /MCP Servers/i }));
    const items = screen.getAllByRole('menuitemcheckbox');
    expect(items).toHaveLength(2);

    await user.keyboard('{ArrowDown}');
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{ArrowDown}');
    expect(items[0]).toHaveFocus();
  });

  it('labels the badge from the servers the menu offers, not the raw selection', () => {
    mockMcpServerManager = {
      ...defaultMcpServerManager,
      mcpValues: ['server-a', 'hidden-server'],
    };
    render(<MCPSelect />);

    expect(screen.getByRole('button', { name: /Server A/i })).toBeInTheDocument();
    expect(screen.queryByText('com_ui_x_selected')).not.toBeInTheDocument();
  });

  it('shows no label when every selected server is hidden from the menu', () => {
    mockMcpServerManager = {
      ...defaultMcpServerManager,
      mcpValues: ['hidden-server'],
    };
    render(<MCPSelect />);

    expect(screen.getByRole('button', { name: /MCP Servers/i })).toBeInTheDocument();
    expect(screen.queryByText('hidden-server')).not.toBeInTheDocument();
  });

  it('renders nothing when user lacks MCP access', () => {
    mockCanUseMcp = false;
    const { container } = render(<MCPSelect />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders nothing when selectableServers is empty', () => {
    mockMcpServerManager = { ...defaultMcpServerManager, selectableServers: [] };
    const { container } = render(<MCPSelect />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when not pinned and no servers selected', () => {
    mockMcpServerManager = { ...defaultMcpServerManager, isPinned: false, mcpValues: [] };
    const { container } = render(<MCPSelect />);
    expect(container.firstChild).toBeNull();
  });
});
