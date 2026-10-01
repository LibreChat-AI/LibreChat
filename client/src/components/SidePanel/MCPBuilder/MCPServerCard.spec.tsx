import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { MCPServerStatusIconProps } from '~/components/MCP/MCPServerStatusIcon';
import type { MCPServerDefinition } from '~/hooks';
import MCPServerCard from './MCPServerCard';

const mockInitializeServer = jest.fn();
const mockGetOAuthUrl = jest.fn();

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useMCPServerManager: () => ({
    initializeServer: mockInitializeServer,
    revokeOAuthForServer: jest.fn(),
    getOAuthUrl: mockGetOAuthUrl,
  }),
}));

jest.mock('@librechat/client', () => ({
  MCPIcon: () => <span />,
}));

jest.mock('./MCPCardActions', () => ({
  __esModule: true,
  default: ({ onInitialize }: { onInitialize: () => void }) => (
    <button type="button" onClick={onInitialize}>
      {'com_nav_mcp_connect'}
    </button>
  ),
}));

jest.mock('./MCPServerDialog', () => ({ __esModule: true, default: () => null }));
jest.mock('./MCPStatusBadge', () => ({ getStatusDotColor: () => '' }));
jest.mock('~/components/ui/CustomIcon', () => ({ __esModule: true, default: () => null }));
jest.mock('~/components/MCP/McpOAuthDialog', () => ({
  __esModule: true,
  default: ({ open, oauthUrl }: { open: boolean; oauthUrl: string }) =>
    open ? <div role="dialog">{oauthUrl}</div> : null,
}));

const server = {
  serverName: 'clickhouse',
  config: {},
  effectivePermissions: 0,
} as unknown as MCPServerDefinition;

/** Mirrors the manager's shared state: the flow URL exists only while initializing. */
const renderCard = (isInitializing: boolean, sharedOAuthUrl: string | null = null) => {
  mockGetOAuthUrl.mockReturnValue(sharedOAuthUrl);
  const statusProps = {
    serverName: 'clickhouse',
    serverStatus: { connectionState: 'disconnected', requiresOAuth: true },
    onConfigClick: jest.fn(),
    isInitializing,
    canCancel: true,
    onCancel: jest.fn(),
    hasCustomUserVars: false,
  } as unknown as MCPServerStatusIconProps;
  return (
    <MCPServerCard
      server={server}
      getServerStatusIconProps={() => statusProps}
      canCreateEditMCPs={false}
    />
  );
};

const firstUrl = 'https://auth.example/authorize?flow=1';

describe('MCPServerCard', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('surfaces the authorization URL in the OAuth dialog instead of opening a tab', async () => {
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    mockInitializeServer.mockResolvedValue({
      success: true,
      oauthRequired: true,
      oauthUrl: firstUrl,
    });
    const { rerender } = render(renderCard(false));

    fireEvent.click(screen.getByText('com_nav_mcp_connect'));
    await waitFor(() => expect(mockInitializeServer).toHaveBeenCalledWith('clickhouse', false));
    rerender(renderCard(true, firstUrl));

    expect(await screen.findByRole('dialog')).toHaveTextContent(firstUrl);
    expect(open).not.toHaveBeenCalled();

    rerender(renderCard(false));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    open.mockRestore();
  });

  test('keeps the OAuth dialog closed when connecting needs no authorization', async () => {
    mockInitializeServer.mockResolvedValue({ success: true, oauthRequired: false });
    const { rerender } = render(renderCard(false));

    fireEvent.click(screen.getByText('com_nav_mcp_connect'));
    await waitFor(() => expect(mockInitializeServer).toHaveBeenCalled());
    rerender(renderCard(true));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('stays closed for flows it did not start once its own flow ended', async () => {
    mockInitializeServer.mockResolvedValueOnce({
      success: true,
      oauthRequired: true,
      oauthUrl: firstUrl,
    });
    const { rerender } = render(renderCard(false));
    fireEvent.click(screen.getByText('com_nav_mcp_connect'));
    rerender(renderCard(true, firstUrl));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    rerender(renderCard(false));

    /** Another surface, such as the chat's MCP menu, initializes the same server. */
    rerender(renderCard(true, 'https://auth.example/authorize?flow=2'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('does not reopen a previous flow while the next connect is pending', async () => {
    mockInitializeServer.mockResolvedValueOnce({
      success: true,
      oauthRequired: true,
      oauthUrl: firstUrl,
    });
    const { rerender } = render(renderCard(false));
    fireEvent.click(screen.getByText('com_nav_mcp_connect'));
    rerender(renderCard(true, firstUrl));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    rerender(renderCard(false));

    let finishSecond: ((value: { success: boolean; oauthRequired: boolean }) => void) | undefined;
    mockInitializeServer.mockReturnValueOnce(
      new Promise((resolve) => {
        finishSecond = resolve;
      }),
    );
    fireEvent.click(screen.getByText('com_nav_mcp_connect'));
    rerender(renderCard(true));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    finishSecond!({ success: true, oauthRequired: false });
    await waitFor(() => expect(mockInitializeServer).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
