import React from 'react';
import * as Ariakit from '@ariakit/react';
import userEvent from '@testing-library/user-event';
import { render, screen, within, waitFor } from '@testing-library/react';
import MCPSubMenu from '../MCPSubMenu';

const mockToggleServerSelection = jest.fn();
const mockSetIsPinned = jest.fn();
const mockMCPRefresh = jest.fn();

jest.mock('~/hooks/MCP/useMCPRefresh', () => ({
  useMCPRefresh: (options: { enabled: boolean }) => mockMCPRefresh(options),
}));

const defaultMcpServerManager = {
  isPinned: true,
  mcpValues: [] as string[],
  setIsPinned: mockSetIsPinned,
  placeholderText: 'MCP Servers',
  selectableServers: [
    { serverName: 'server-a', config: { title: 'Server A' } },
    { serverName: 'server-b', config: { title: 'Server B', description: 'Second server' } },
  ],
  connectionStatus: {},
  isInitializing: () => false,
  getConfigDialogProps: () => null,
  toggleServerSelection: mockToggleServerSelection,
  getServerStatusIconProps: () => null,
};

let mockMcpServerManager = { ...defaultMcpServerManager };

jest.mock('~/Providers', () => ({
  useBadgeRowContext: () => ({
    storageContextKey: undefined,
    mcpServerManager: mockMcpServerManager,
  }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => true,
}));

jest.mock('@librechat/client', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  return {
    MCPIcon: ({ className }: { className?: string }) => R.createElement('span', { className }),
    PinIcon: ({ unpin }: { unpin?: boolean }) =>
      R.createElement('span', { 'data-testid': unpin ? 'unpin-icon' : 'pin-icon' }),
    Spinner: ({ className }: { className?: string }) => R.createElement('span', { className }),
  };
});

jest.mock('~/components/MCP/MCPConfigDialog', () => ({
  __esModule: true,
  default: () => null,
}));

function ParentMenu({ children }: { children: React.ReactNode }) {
  return (
    <Ariakit.MenuProvider>
      {/* eslint-disable-next-line i18next/no-literal-string */}
      <Ariakit.MenuButton>Parent</Ariakit.MenuButton>
      <Ariakit.Menu open={true}>{children}</Ariakit.Menu>
    </Ariakit.MenuProvider>
  );
}

function renderSubMenu(props: React.ComponentProps<typeof MCPSubMenu> = {}) {
  return render(
    <ParentMenu>
      <MCPSubMenu {...props} />
    </ParentMenu>,
  );
}

describe('MCPSubMenu', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMcpServerManager = { ...defaultMcpServerManager };
  });

  it('renders nothing when selectableServers is empty', () => {
    mockMcpServerManager = { ...defaultMcpServerManager, selectableServers: [] };
    renderSubMenu();
    expect(screen.queryByText('MCP Servers')).not.toBeInTheDocument();
  });

  it('renders the submenu trigger with default placeholder', () => {
    renderSubMenu();
    expect(mockMCPRefresh).toHaveBeenLastCalledWith({ enabled: false });
    expect(screen.getByText('MCP Servers')).toBeInTheDocument();
  });

  it('renders custom placeholder when provided', () => {
    renderSubMenu({ placeholder: 'Custom Label' });
    expect(screen.getByText('Custom Label')).toBeInTheDocument();
    expect(screen.queryByText('MCP Servers')).not.toBeInTheDocument();
  });

  it('refreshes the unpinned submenu while open and stops on close', async () => {
    const user = userEvent.setup();
    mockMcpServerManager = { ...defaultMcpServerManager, isPinned: false };
    renderSubMenu();

    await user.click(screen.getByText('MCP Servers'));

    expect(mockMCPRefresh).toHaveBeenLastCalledWith({ enabled: true });
    const menu = screen.getByRole('menu', { name: /com_ui_mcp_servers/i });
    expect(menu).toBeVisible();
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Server A/i })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Server B/i })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(mockMCPRefresh).toHaveBeenLastCalledWith({ enabled: false }));
  });

  it('keeps menu open after toggling a server item', async () => {
    const user = userEvent.setup();
    renderSubMenu();

    await user.click(screen.getByText('MCP Servers'));
    await user.click(screen.getByRole('menuitemcheckbox', { name: /Server A/i }));

    expect(mockToggleServerSelection).toHaveBeenCalledWith('server-a');
    expect(screen.getByRole('menu', { name: /com_ui_mcp_servers/i })).toBeVisible();
  });

  it('calls setIsPinned with toggled value when pin button is clicked', async () => {
    const user = userEvent.setup();
    mockMcpServerManager = { ...defaultMcpServerManager, isPinned: false };
    renderSubMenu();

    await user.click(screen.getByRole('button', { name: /com_ui_pin/i }));

    expect(mockSetIsPinned).toHaveBeenCalledWith(true);
  });

  it('arrow-key navigation wraps from last item to first', async () => {
    const user = userEvent.setup();
    renderSubMenu();

    await user.click(screen.getByText('MCP Servers'));
    const items = screen.getAllByRole('menuitemcheckbox');
    expect(items).toHaveLength(2);

    await user.click(items[1]);
    expect(items[1]).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(items[0]).toHaveFocus();
  });

  it('pin button shows unpin label when pinned', () => {
    mockMcpServerManager = { ...defaultMcpServerManager, isPinned: true };
    renderSubMenu();
    expect(screen.getByRole('button', { name: /com_ui_unpin/i })).toBeInTheDocument();
  });

  it('pin button shows pin label when not pinned', () => {
    mockMcpServerManager = { ...defaultMcpServerManager, isPinned: false };
    renderSubMenu();
    expect(screen.getByRole('button', { name: /com_ui_pin/i })).toBeInTheDocument();
  });
});
