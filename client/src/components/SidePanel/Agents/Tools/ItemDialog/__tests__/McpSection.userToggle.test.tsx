import '@testing-library/jest-dom/extend-expect';
import { mcpServerToggleKey } from 'librechat-data-provider';
import { useForm, FormProvider, useWatch } from 'react-hook-form';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { McpItem } from '../../items/types';
import type { AgentForm } from '~/common';
import McpSection from '../sections/McpSection';

jest.mock('~/Providers', () => ({
  useAgentPanelContext: () => ({ mcpServersMap: new Map(), mcpToolsLoading: false }),
}));

jest.mock('~/components/ui', () => ({
  Collapse: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? children : null,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useCopyToClipboard: () => jest.fn(),
  useAgentCapabilities: () => ({}),
  useGetAgentsConfig: () => ({ agentsConfig: { capabilities: [] } }),
  useMCPServerManager: () => ({
    getServerStatusIconProps: () => null,
    getConfigDialogProps: () => null,
    initializeServer: jest.fn(),
    isConnectionDeferred: () => false,
    resetConnectionDeferred: jest.fn(),
    getOAuthUrl: () => undefined,
  }),
  useMCPToolOptions: () => ({
    isToolDeferred: () => false,
    isToolProgrammatic: () => false,
    isToolBackground: () => false,
    isToolIntent: () => false,
    isToolProgrammaticOnly: () => false,
    areAllToolsDeferred: () => false,
    areAllToolsProgrammatic: () => false,
    areAllToolsBackground: () => false,
    areAllToolsIntent: () => false,
  }),
}));

jest.mock('~/components/MCP/MCPConfigDialog', () => ({ __esModule: true, default: () => null }));
jest.mock('~/components/MCP/MCPServerStatusIcon', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('~/components/MCP/McpOAuthDialog', () => ({ __esModule: true, default: () => null }));
jest.mock('../../../MCPToolItem', () => ({ __esModule: true, default: () => null }));

const item: McpItem = {
  kind: 'mcp',
  id: 'alpha',
  name: 'alpha',
  description: '',
  iconKey: 'mcp',
  server: { serverName: 'alpha', isConfigured: true, tools: [], metadata: {} } as never,
  toolCount: 0,
};

const key = mcpServerToggleKey('alpha');

function OptionsProbe() {
  const value = useWatch<AgentForm>({ name: 'tool_options' });
  return <span data-testid="options">{JSON.stringify(value)}</span>;
}

function renderSection(toolOptions: AgentForm['tool_options'], section: McpItem = item) {
  function Wrapper({ children }: { children: ReactNode }) {
    const methods = useForm<AgentForm>({
      defaultValues: { tools: [], tool_options: toolOptions } as unknown as AgentForm,
    });
    return (
      <FormProvider {...methods}>
        {children}
        <OptionsProbe />
      </FormProvider>
    );
  }
  return render(<McpSection item={section} />, { wrapper: Wrapper });
}

const stored = () => JSON.parse(screen.getByTestId('options').textContent ?? 'null');
const option = (name: string) => screen.getByRole('radio', { name });

describe('McpSection user toggle', () => {
  it('reflects the server-wide toggle stored under the server key', () => {
    renderSection({ [key]: { user_toggle: 'on' } });
    expect(option('com_ui_tool_toggle_on')).toHaveAttribute('aria-checked', 'true');
  });

  it('is locked when nothing is stored', () => {
    renderSection(undefined);
    expect(option('com_ui_tool_toggle_locked')).toHaveAttribute('aria-checked', 'true');
  });

  it('writes user_toggle under the server key', () => {
    renderSection(undefined);
    fireEvent.click(option('com_ui_tool_toggle_off'));
    expect(stored()).toEqual({ [key]: { user_toggle: 'off' } });
  });

  it('labels the setting and keys it by the configured name for a server name with spaces', () => {
    const spaced: McpItem = {
      ...item,
      id: 'My Docs',
      name: 'My Docs',
      server: { serverName: 'My Docs', isConfigured: true, tools: [], metadata: {} } as never,
    };
    renderSection(undefined, spaced);
    expect(
      screen.getByRole('radiogroup', { name: 'com_ui_tool_toggle_label' }),
    ).toBeInTheDocument();
    fireEvent.click(option('com_ui_tool_toggle_on'));
    expect(stored()).toEqual({ [mcpServerToggleKey('My Docs')]: { user_toggle: 'on' } });
  });
});
