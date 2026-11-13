import { render, screen } from '@testing-library/react';
import type { MCPServerDefinition } from '~/hooks';
import MCPServerCard from '../MCPServerCard';

let mockMcpServerContactEnabled = true;

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({
    data: { interface: { mcpServerContact: mockMcpServerContactEnabled } },
  }),
}));

jest.mock('../MCPCardActions', () => () => <div data-testid="actions" />);
jest.mock('../MCPServerDialog', () => () => null);
jest.mock('~/components/MCP/McpOAuthDialog', () => () => null);

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => {
    const translations: Record<string, string> = {
      com_ui_mcp_contact: 'Contact',
      com_ui_mcp_no_contact_available: 'No contact available',
      com_nav_mcp_status_unknown: 'Unknown',
    };
    return translations[key] ?? key;
  },
  useMCPServerManager: () => ({
    initializeServer: jest.fn(),
    revokeOAuthForServer: jest.fn(),
    getOAuthUrl: jest.fn(() => undefined),
  }),
}));

const statusProps = {
  serverStatus: undefined,
  onConfigClick: jest.fn(),
  isInitializing: false,
  canCancel: false,
  onCancel: jest.fn(),
  hasCustomUserVars: false,
};

function renderCard(
  config: MCPServerDefinition['config'],
  metadata: Pick<MCPServerDefinition, 'dbId' | 'support_contact' | 'owner_contact'> = {},
) {
  const server: MCPServerDefinition = {
    serverName: 'example',
    config,
    effectivePermissions: 1,
    ...metadata,
  };
  return render(
    <MCPServerCard
      server={server}
      getServerStatusIconProps={() => statusProps as never}
      canCreateEditMCPs={false}
    />,
  );
}

describe('MCPServerCard contact', () => {
  it('renders configured support contact below the description', () => {
    renderCard(
      {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'Example',
        description: 'Description',
        support_contact: { name: 'Platform Support', email: 'support@example.com' },
      },
      { support_contact: { name: 'Platform Support', email: 'support@example.com' } },
    );

    expect(screen.getByText('Description')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Platform Support' })).toHaveAttribute(
      'href',
      'mailto:support@example.com',
    );
  });

  it('renders owner fallback as plain text', () => {
    renderCard(
      { type: 'sse', url: 'https://example.com/mcp' },
      { owner_contact: { name: 'Server Owner' } },
    );

    expect(screen.getByText('Server Owner')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders nothing for a YAML server without a configured contact', () => {
    renderCard({ type: 'sse', url: 'https://example.com/mcp' });

    expect(screen.queryByText('Contact:')).not.toBeInTheDocument();
    expect(screen.queryByText('No contact available')).not.toBeInTheDocument();
  });

  it('renders the unavailable state for a DB server without a resolvable contact', () => {
    renderCard({ type: 'sse', url: 'https://example.com/mcp' }, { dbId: 'server-id' });

    expect(screen.getByText('Contact:')).toBeInTheDocument();
    expect(screen.getByText('No contact available')).toBeInTheDocument();
  });

  it('hides MCP contacts when the interface option is disabled', () => {
    mockMcpServerContactEnabled = false;
    renderCard(
      { type: 'sse', url: 'https://example.com/mcp' },
      { support_contact: { name: 'Platform Support', email: 'support@example.com' } },
    );

    expect(screen.queryByText('Contact:')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Platform Support' })).not.toBeInTheDocument();
    mockMcpServerContactEnabled = true;
  });
});
