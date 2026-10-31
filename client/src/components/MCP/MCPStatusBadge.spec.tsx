import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { render, screen } from '@testing-library/react';
import type { MCPServerStatus } from 'librechat-data-provider';
import MCPStatusBadge, { getStatusDotColor } from './MCPStatusBadge';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('@librechat/client', () => ({
  Spinner: (props: React.ComponentProps<'span'>) => <span {...props} />,
}));

describe('MCPStatusBadge', () => {
  test.each(['disconnected', 'connected'] as const)(
    'renders the %s request-scoped state as on-demand',
    (connectionState) => {
      const serverStatus: MCPServerStatus = {
        connectionState,
        requiresOAuth: true,
        requestScoped: true,
      };

      render(<MCPStatusBadge serverStatus={serverStatus} />);

      expect(screen.getByRole('status')).toHaveTextContent('com_nav_mcp_status_on_demand');
      expect(getStatusDotColor(serverStatus)).toBe('bg-status-info');
    },
  );

  it('keeps explicit request-scoped errors visible', () => {
    const serverStatus: MCPServerStatus = {
      connectionState: 'error',
      requiresOAuth: false,
      requestScoped: true,
    };
    render(<MCPStatusBadge serverStatus={serverStatus} />);
    expect(screen.getByRole('status')).toHaveTextContent('com_nav_mcp_status_error');
    expect(getStatusDotColor(serverStatus)).toBe('bg-status-error');
  });

  it('preserves the active connecting state for a request-scoped OAuth flow', () => {
    const serverStatus: MCPServerStatus = {
      connectionState: 'connecting',
      requiresOAuth: true,
      requestScoped: true,
    };

    render(<MCPStatusBadge serverStatus={serverStatus} />);

    expect(screen.getByRole('status')).toHaveTextContent('com_nav_mcp_status_connecting');
  });
});
