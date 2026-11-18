import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { fireEvent, render, screen } from '@testing-library/react';
import type { MCPConnectionState } from '~/hooks/MCP/connection';
import MCPCardActions from './MCPCardActions';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/utils', () => ({
  cn: () => '',
  rowActionClasses: () => '',
  rowActionSlotClasses: () => '',
}));
jest.mock('@librechat/client', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  TooltipAnchor: ({ render: button }: { render: React.ReactNode }) => button,
  Spinner: () => <span />,
}));

it.each<[MCPConnectionState, string]>([
  ['succeeded', 'com_nav_mcp_reconnect'],
  ['failed', 'com_nav_mcp_connect'],
  ['unknown', 'com_nav_mcp_connect'],
  ['authorized', 'com_nav_mcp_reconnect'],
])('offers the truthful %s connection action', (state, label) => {
  const initialize = jest.fn();
  const raw = {
    requiresOAuth: false,
    connectionState: 'disconnected' as const,
    connectionStateSource: 'unobserved' as const,
  };
  render(
    <MCPCardActions
      serverName="example"
      serverStatus={raw}
      view={{ state, canUse: state === 'succeeded' || state === 'authorized', observation: raw }}
      isInitializing={false}
      canCancel={false}
      hasCustomUserVars={false}
      canEdit={false}
      onEditClick={jest.fn()}
      onConfigClick={jest.fn()}
      onInitialize={initialize}
      onCancel={jest.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: label }));
  expect(initialize).toHaveBeenCalledTimes(1);
  expect(raw.connectionState).toBe('disconnected');
});
