import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { render, screen } from '@testing-library/react';
import type { McpItem } from '../items/types';
import ToolRow from '../ToolRow';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('@librechat/client', () => ({
  Button: ({
    children,
    variant: _variant,
    ...props
  }: React.ComponentProps<'button'> & { variant?: string }) => (
    <button {...props}>{children}</button>
  ),
}));

const item: McpItem = {
  kind: 'mcp',
  id: 'mcp-server',
  name: 'MCP server',
  description: '',
  iconKey: 'mcp',
  server: {
    serverName: 'mcp-server',
    tools: [],
    isConfigured: true,
    isConnected: true,
    metadata: {},
  } as never,
  toolCount: 0,
};

describe('ToolRow', () => {
  test('MCP action icons keep their color while hovered', () => {
    render(<ToolRow item={item} onInfo={jest.fn()} onRemove={jest.fn()} />);

    expect(screen.getByRole('button', { name: 'com_ui_tools_configure' })).toHaveClass(
      'hover:text-text-secondary',
    );
    expect(screen.getByRole('button', { name: 'com_ui_tools_remove' })).toHaveClass(
      'hover:text-text-secondary',
    );
  });
});
