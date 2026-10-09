import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { render, screen } from '@testing-library/react';
import type { MCPServerStatus } from 'librechat-data-provider';
import MCPServerStatusIcon from './MCPServerStatusIcon';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('@librechat/client', () => ({
  Spinner: (props: React.ComponentProps<'span'>) => <span {...props} />,
  TooltipAnchor: ({ render }: { render: React.ReactNode }) => render,
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ComponentProps<'button'> & { variant?: string; size?: string }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

const requestScopedStatus: MCPServerStatus = {
  connectionState: 'disconnected',
  authorizationState: 'not_required',
  requiresOAuth: false,
  requestScoped: true,
  configurationState: 'needs_configuration',
};

describe('MCPServerStatusIcon', () => {
  it('shows Configure instead of Connect for idle request-scoped custom variables', () => {
    render(
      <MCPServerStatusIcon
        serverName="server"
        serverStatus={requestScopedStatus}
        isInitializing={false}
        canCancel={false}
        hasCustomUserVars={true}
        onConfigClick={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'com_nav_mcp_configure_server' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'com_nav_mcp_connect_server' }),
    ).not.toBeInTheDocument();
  });

  it('keeps idle request-scoped servers without custom variables actionless', () => {
    const { container } = render(
      <MCPServerStatusIcon
        serverName="server"
        serverStatus={requestScopedStatus}
        isInitializing={false}
        canCancel={false}
        hasCustomUserVars={false}
        onConfigClick={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
