import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { fireEvent, render, screen } from '@testing-library/react';
import type { MCPServerStatus } from 'librechat-data-provider';
import ServerInitializationSection from './ServerInitializationSection';

const mockInitializeServer = jest.fn();
const mockConnectionStatus = jest.fn((): MCPServerStatus | undefined => undefined);

const mockMCPRefresh = jest.fn();
const mockGetOAuthUrl = jest.fn((): string | undefined => undefined);

jest.mock('~/hooks/MCP/useMCPRefresh', () => ({
  useMCPRefresh: (options: { enabled: boolean; tools?: boolean }) => mockMCPRefresh(options),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useMCPServerManager: () => ({
    getOAuthUrl: mockGetOAuthUrl,
    isCancellable: () => false,
    isInitializing: () => false,
    cancelOAuthFlow: jest.fn(),
    initializeServer: mockInitializeServer,
    availableMCPServers: [{ serverName: 'server' }],
    availableMCPServersMap: { server: { requestScoped: true } },
    connectionStatus: { server: mockConnectionStatus() },
    revokeOAuthForServer: jest.fn(),
  }),
}));

jest.mock('@librechat/client', () => ({
  Spinner: (props: React.ComponentProps<'span'>) => <span {...props} />,
  Button: ({
    children,
    asChild,
    variant: _variant,
    size: _size,
    ...props
  }: React.ComponentProps<'button'> & { variant?: string; size?: string; asChild?: boolean }) =>
    asChild ? (
      <span {...props}>{children}</span>
    ) : (
      <button {...props}>{children}</button>
    ),
}));

describe('ServerInitializationSection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('offers deferred initialization after request-scoped custom variables are configured', () => {
    mockConnectionStatus.mockReturnValue({
      connectionState: 'disconnected',
      requiresOAuth: false,
      requestScoped: true,
      configurationState: 'needs_configuration',
    });
    const { rerender } = render(
      <ServerInitializationSection
        serverName="server"
        requiresOAuth={false}
        hasCustomUserVars={true}
      />,
    );

    expect(screen.queryByRole('button', { name: 'com_ui_mcp_initialize' })).not.toBeInTheDocument();

    mockConnectionStatus.mockReturnValue({
      connectionState: 'disconnected',
      requiresOAuth: false,
      requestScoped: true,
      configurationState: 'configured',
    });
    rerender(
      <ServerInitializationSection
        serverName="server"
        requiresOAuth={false}
        hasCustomUserVars={true}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_mcp_initialize' }));
    expect(mockInitializeServer).toHaveBeenCalledWith('server', false);
  });
});

  it('renders the OAuth continue action as a real link, not a scripted click', () => {
    mockConnectionStatus.mockReturnValue({
      connectionState: 'connecting',
      requiresOAuth: true,
    } as unknown as MCPServerStatus);
    mockGetOAuthUrl.mockReturnValue('https://auth.example/authorize?x=1');
    render(<ServerInitializationSection serverName="server" requiresOAuth={true} />);
    const anchor = screen.getByText('com_ui_continue_oauth').closest('a');
    expect(anchor).not.toBeNull();
    expect(anchor).toHaveAttribute('href', 'https://auth.example/authorize?x=1');
    expect(anchor).toHaveAttribute('target', '_blank');
    expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
  });
