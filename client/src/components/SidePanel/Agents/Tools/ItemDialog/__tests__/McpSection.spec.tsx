import '@testing-library/jest-dom/extend-expect';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { McpItem } from '../../items/types';
import McpSection from '../sections/McpSection';

const mockSetValue = jest.fn();
const mockGetValues = jest.fn((): string[] => []);
const mockGetToolOptions = jest.fn((): Record<string, object> | undefined => undefined);
const mockMcpServersMap = jest.fn((): Map<string, object> => new Map());
let mockMcpToolsLoading = false;
const mockGetServerStatusIconProps = jest.fn((): object | null => null);
const mockInitializeServer = jest.fn();
const mockIsConnectionDeferred = jest.fn((): boolean => false);
const mockToggleIntentAll = jest.fn();
const mockIsToolProgrammaticOnly = jest.fn((_toolId: string): boolean => false);
const mockAreAllToolsProgrammatic = jest.fn((): boolean => false);
const mockAreAllToolsBackground = jest.fn((): boolean => false);
const mockCapabilities = {
  codeEnabled: false,
  deferredToolsEnabled: false,
  programmaticToolsEnabled: false,
  backgroundToolsEnabled: false,
  toolIntentsEnabled: false,
};
const mockLocalize = jest.fn((key: string, values?: Record<number, string>) =>
  key === 'com_nav_mcp_status_connecting' ? `${values?.[0]} - Connecting` : key,
);

const mockMCPRefresh = jest.fn();

jest.mock('~/hooks/MCP/useMCPRefresh', () => ({
  useMCPRefresh: (options: { enabled: boolean; tools?: boolean }) => mockMCPRefresh(options),
}));

jest.mock('react-hook-form', () => ({
  useFormContext: () => ({ control: {}, setValue: mockSetValue, getValues: mockGetValues }),
  useWatch: ({ name }: { name: string }) => {
    if (name === 'tool_options') {
      return mockGetToolOptions();
    }
    if (name === 'execute_code') {
      return mockCodeInterpreterSelected();
    }
    return mockGetValues();
  },
}));

const mockCodeInterpreterSelected = jest.fn((): boolean => false);

jest.mock('~/Providers', () => ({
  useAgentPanelContext: () => ({
    mcpServersMap: mockMcpServersMap(),
    mcpToolsLoading: mockMcpToolsLoading,
  }),
}));

jest.mock('~/components/ui', () => ({
  Collapse: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? children : null,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => mockLocalize,
  useCopyToClipboard: () => jest.fn(),
  useAgentCapabilities: () => mockCapabilities,
  useGetAgentsConfig: () => ({ agentsConfig: { capabilities: [] } }),
  useMCPServerManager: () => ({
    getServerStatusIconProps: mockGetServerStatusIconProps,
    getConfigDialogProps: () => null,
    initializeServer: mockInitializeServer,
    isConnectionDeferred: mockIsConnectionDeferred,
    resetConnectionDeferred: jest.fn(),
    getOAuthUrl: () => undefined,
    isCancellable: () => false,
    cancelOAuthFlow: jest.fn(),
  }),
  useMCPToolOptions: () => ({
    isToolDeferred: () => false,
    isToolProgrammatic: () => false,
    isToolBackground: () => false,
    isToolIntent: () => false,
    isToolProgrammaticOnly: mockIsToolProgrammaticOnly,
    toggleToolDefer: jest.fn(),
    toggleToolProgrammatic: jest.fn(),
    toggleToolBackground: jest.fn(),
    toggleToolIntent: jest.fn(),
    areAllToolsDeferred: () => false,
    areAllToolsProgrammatic: mockAreAllToolsProgrammatic,
    areAllToolsBackground: mockAreAllToolsBackground,
    areAllToolsIntent: () => false,
    toggleDeferAll: jest.fn(),
    toggleProgrammaticAll: jest.fn(),
    toggleBackgroundAll: jest.fn(),
    toggleIntentAll: mockToggleIntentAll,
  }),
}));

jest.mock('../../../MCPToolItem', () => ({
  __esModule: true,
  default: ({
    tool,
    isSelected,
    onToggleSelect,
  }: {
    tool: { tool_id: string; name?: string };
    isSelected: boolean;
    onToggleSelect: () => void;
  }) => (
    <button
      type="button"
      data-testid={`tool-${tool.tool_id}`}
      aria-pressed={isSelected}
      onClick={onToggleSelect}
    >
      {tool.name || tool.tool_id}
    </button>
  ),
}));

jest.mock('~/components/MCP/MCPConfigDialog', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('~/components/MCP/MCPServerStatusIcon', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('~/components/MCP/McpOAuthDialog', () => ({
  __esModule: true,
  default: ({ open, oauthUrl }: { open: boolean; oauthUrl: string }) =>
    open ? <div data-testid="oauth-dialog">{oauthUrl}</div> : null,
}));

jest.mock('@librechat/client', () => {
  const React = jest.requireActual('react');
  return {
    TooltipAnchor: ({ render }: { render: React.ReactElement }) => render,
    Spinner: ({ className }: { className?: string }) => React.createElement('span', { className }),
    Button: ({
      children,
      variant: _variant,
      size: _size,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) =>
      React.createElement('button', { type: 'button', ...props }, children),
    Checkbox: ({
      checked,
      onCheckedChange,
      'aria-label': ariaLabel,
    }: {
      checked: boolean;
      onCheckedChange: (next: boolean) => void;
      'aria-label': string;
    }) =>
      React.createElement('input', {
        type: 'checkbox',
        checked,
        'aria-label': ariaLabel,
        onChange: (e: { target: { checked: boolean } }) => onCheckedChange(e.target.checked),
      }),
    Skeleton: ({ className }: { className?: string }) => React.createElement('div', { className }),
  };
});

const item: McpItem = {
  kind: 'mcp',
  id: 'srv',
  name: 'srv',
  description: 'desc',
  iconKey: 'mcp',
  server: {
    serverName: 'srv',
    isConfigured: true,
    tools: [
      { tool_id: 'mcp:srv:a', name: 'A' },
      { tool_id: 'mcp:srv:b', name: 'B' },
    ],
    metadata: { description: 'desc' },
  } as never,
  toolCount: 2,
};

describe('McpSection', () => {
  beforeEach(() => {
    mockSetValue.mockClear();
    mockGetValues.mockReturnValue([]);
    mockInitializeServer.mockReset();
    mockIsConnectionDeferred.mockReset();
    mockIsConnectionDeferred.mockReturnValue(false);
    mockToggleIntentAll.mockClear();
    mockIsToolProgrammaticOnly.mockReset();
    mockIsToolProgrammaticOnly.mockReturnValue(false);
    mockAreAllToolsProgrammatic.mockReset();
    mockAreAllToolsProgrammatic.mockReturnValue(false);
    mockAreAllToolsBackground.mockReset();
    mockAreAllToolsBackground.mockReturnValue(false);
    mockGetToolOptions.mockReset();
    mockGetToolOptions.mockReturnValue(undefined);
    mockMcpServersMap.mockReset();
    mockMcpServersMap.mockReturnValue(new Map());
    mockMcpToolsLoading = false;
    mockGetServerStatusIconProps.mockReset();
    mockGetServerStatusIconProps.mockReturnValue(null);
    mockLocalize.mockClear();
    mockCodeInterpreterSelected.mockReset();
    mockCodeInterpreterSelected.mockReturnValue(false);
    mockCapabilities.codeEnabled = false;
    mockCapabilities.deferredToolsEnabled = false;
    mockCapabilities.programmaticToolsEnabled = false;
    mockCapabilities.backgroundToolsEnabled = false;
    mockCapabilities.toolIntentsEnabled = false;
  });

  test('renders one row per tool', () => {
    render(<McpSection item={item} />);
    expect(screen.getByTestId('tool-mcp:srv:a')).toBeInTheDocument();
    expect(screen.getByTestId('tool-mcp:srv:b')).toBeInTheDocument();
  });

  test('interpolates the server name when another manager reports a connecting state', () => {
    mockGetServerStatusIconProps.mockReturnValue({
      serverStatus: {
        connectionState: 'connecting',
        requiresOAuth: true,
      },
      isInitializing: false,
    });

    render(<McpSection item={item} />);

    expect(screen.getByText('srv - Connecting')).toBeInTheDocument();
    expect(mockLocalize).toHaveBeenCalledWith('com_nav_mcp_status_connecting', { 0: 'srv' });
  });

  test('toggling a tool writes its id plus the server token into agent.tools', () => {
    render(<McpSection item={item} />);
    fireEvent.click(screen.getByTestId('tool-mcp:srv:a'));
    expect(mockSetValue).toHaveBeenCalledWith(
      'tools',
      ['sys__server__sys_mcp_srv', 'mcp:srv:a'],
      expect.objectContaining({ shouldDirty: true }),
    );
  });

  test('selecting a current tool replaces stale catalog ids for the same server', () => {
    mockGetValues.mockReturnValue(['removed_mcp_srv', 'dalle']);

    render(<McpSection item={item} />);
    fireEvent.click(screen.getByTestId('tool-mcp:srv:a'));

    expect(mockSetValue).toHaveBeenCalledWith(
      'tools',
      ['dalle', 'sys__server__sys_mcp_srv', 'mcp:srv:a'],
      { shouldDirty: true },
    );
  });

  test('select-all writes every tool id', () => {
    render(<McpSection item={item} />);
    fireEvent.click(screen.getByLabelText('com_ui_tools_mcp_select_all'));
    expect(mockSetValue).toHaveBeenCalledWith(
      'tools',
      expect.arrayContaining(['mcp:srv:a', 'mcp:srv:b']),
      expect.objectContaining({ shouldDirty: true }),
    );
  });

  test('deselect-all strips every tool id but keeps the server attached via its token', () => {
    mockGetValues.mockReturnValue(['mcp:srv:a', 'mcp:srv:b', 'sys__server__sys_mcp_srv']);
    render(<McpSection item={item} />);
    fireEvent.click(screen.getByLabelText('com_ui_tools_mcp_deselect_all'));
    expect(mockSetValue).toHaveBeenCalledWith(
      'tools',
      ['sys__server__sys_mcp_srv'],
      expect.objectContaining({ shouldDirty: true }),
    );
  });

  test('selection state tracks the watched tools field (re-render on toggle)', () => {
    mockGetValues.mockReturnValue(['mcp:srv:a']);
    render(<McpSection item={item} />);
    expect(screen.getByTestId('tool-mcp:srv:a')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('tool-mcp:srv:b')).toHaveAttribute('aria-pressed', 'false');
  });

  test('renders an inline Connect button when the server is not connected', () => {
    render(<McpSection item={item} />);
    expect(screen.getByText('com_nav_mcp_connect_server')).toBeInTheDocument();
  });

  test('clicking Connect initializes the server without auto-opening OAuth', () => {
    mockInitializeServer.mockResolvedValue({ success: true });
    render(<McpSection item={item} />);
    fireEvent.click(screen.getByText('com_nav_mcp_connect_server'));
    expect(mockInitializeServer).toHaveBeenCalledWith('srv', false);
  });

  test('opens the OAuth dialog only when initialize reports oauthRequired', async () => {
    mockInitializeServer.mockResolvedValue({
      success: true,
      oauthRequired: true,
      oauthUrl: 'https://oauth.example/authorize?x=1',
    });
    render(<McpSection item={item} />);
    fireEvent.click(screen.getByText('com_nav_mcp_connect_server'));
    expect(await screen.findByTestId('oauth-dialog')).toHaveTextContent(
      'https://oauth.example/authorize?x=1',
    );
  });

  test('shows empty hint when the server exposes no tools', () => {
    const empty: McpItem = {
      ...item,
      server: { ...item.server, tools: [] } as never,
      toolCount: 0,
    };
    render(<McpSection item={empty} />);
    expect(screen.getByText('com_ui_tools_mcp_no_tools')).toBeInTheDocument();
  });

  test.each([true, false])(
    'lets a ready server attach runtime tools (requestScoped=%s)',
    (requestScoped) => {
      const runtimeItem: McpItem = {
        ...item,
        server: {
          ...item.server,
          tools: [],
          isConnected: !requestScoped,
          isReadyForAgent: true,
          requestScoped,
        } as never,
        toolCount: 0,
      };

      render(<McpSection item={runtimeItem} />);

      expect(screen.getByText('com_ui_tools_mcp_runtime_tools_available')).toBeInTheDocument();
      expect(mockSetValue).not.toHaveBeenCalled();

      fireEvent.click(screen.getByLabelText('com_ui_tools_mcp_select_all'));
      expect(mockSetValue).toHaveBeenCalledWith(
        'tools',
        ['sys__server__sys_mcp_srv', 'sys__all__sys_mcp_srv'],
        { shouldDirty: true },
      );
    },
  );

  test.each([true, false])(
    'detaches runtime tools without affecting unrelated tools (requestScoped=%s)',
    (requestScoped) => {
      mockGetValues.mockReturnValue([
        'sys__server__sys_mcp_srv',
        'sys__all__sys_mcp_srv',
        'search_mcp_srv',
        'dalle',
      ]);
      const runtimeItem: McpItem = {
        ...item,
        server: {
          ...item.server,
          tools: [],
          isConnected: true,
          isReadyForAgent: true,
          requestScoped,
        } as never,
        toolCount: 0,
      };

      render(<McpSection item={runtimeItem} />);

      expect(screen.getByText('com_ui_tools_mcp_runtime_tools')).toBeInTheDocument();
      fireEvent.click(screen.getByLabelText('com_ui_tools_mcp_deselect_all'));
      expect(mockSetValue).toHaveBeenCalledWith('tools', ['dalle'], { shouldDirty: true });
    },
  );

  test.each([true, false])(
    'does not offer runtime attachment before readiness (requestScoped=%s)',
    (requestScoped) => {
      const disconnectedRuntimeItem: McpItem = {
        ...item,
        server: {
          ...item.server,
          tools: [],
          isConnected: false,
          requestScoped,
        } as never,
        toolCount: 0,
      };

      render(<McpSection item={disconnectedRuntimeItem} />);

      expect(screen.queryByLabelText('com_ui_tools_mcp_select_all')).not.toBeInTheDocument();
      expect(
        screen.queryByText('com_ui_tools_mcp_runtime_tools_available'),
      ).not.toBeInTheDocument();
      expect(screen.getByText('com_ui_tools_mcp_no_tools')).toBeInTheDocument();
      expect(mockSetValue).not.toHaveBeenCalled();
    },
  );

  test('attaches after OAuth succeeds with an empty catalog, but waits for catalog loading', async () => {
    const empty: McpItem = {
      ...item,
      server: { ...item.server, tools: [], isReadyForAgent: false, requestScoped: false },
      toolCount: 0,
    };
    mockInitializeServer.mockResolvedValue({
      success: true,
      oauthRequired: true,
      oauthUrl: 'https://oauth.example/authorize',
    });
    const { rerender } = render(<McpSection item={empty} />);
    fireEvent.click(screen.getByText('com_nav_mcp_connect_server'));
    expect(await screen.findByTestId('oauth-dialog')).toBeInTheDocument();
    expect(mockSetValue).not.toHaveBeenCalled();

    mockMcpServersMap.mockReturnValue(
      new Map([
        [
          'srv',
          {
            ...empty.server,
            isConnected: true,
            isReadyForAgent: true,
          },
        ],
      ]),
    );
    mockMcpToolsLoading = true;
    rerender(<McpSection item={empty} />);
    expect(screen.queryByTestId('oauth-dialog')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('com_ui_tools_mcp_select_all')).not.toBeInTheDocument();
    expect(mockSetValue).not.toHaveBeenCalled();

    mockMcpToolsLoading = false;
    rerender(<McpSection item={empty} />);
    await waitFor(() =>
      expect(mockSetValue).toHaveBeenCalledWith(
        'tools',
        ['sys__server__sys_mcp_srv', 'sys__all__sys_mcp_srv'],
        { shouldDirty: true },
      ),
    );
    rerender(<McpSection item={empty} />);
    expect(mockSetValue).toHaveBeenCalledTimes(1);
  });

  test('an explicitly unready server cannot attach despite a stale connected flag', () => {
    render(
      <McpSection
        item={{
          ...item,
          toolCount: 0,
          server: {
            ...item.server,
            tools: [],
            isConnected: true,
            isReadyForAgent: false,
          },
        }}
      />,
    );
    expect(screen.queryByLabelText('com_ui_tools_mcp_select_all')).not.toBeInTheDocument();
    expect(mockSetValue).not.toHaveBeenCalled();
  });

  test('deferred connect attaches the whole server via the mcp_all wildcard', async () => {
    // Request-scoped servers (runtime {{LIBRECHAT_BODY_*}} placeholders) defer
    // their connection to the next chat turn, so no tool list arrives here —
    // Connect should attach the server-wide wildcard instead of waiting.
    mockInitializeServer.mockResolvedValue({ success: true, connectionDeferred: true });
    mockIsConnectionDeferred.mockReturnValue(true);
    const empty: McpItem = {
      ...item,
      server: { ...item.server, tools: [] } as never,
      toolCount: 0,
    };
    render(<McpSection item={empty} />);
    fireEvent.click(screen.getByText('com_nav_mcp_connect_server'));
    await waitFor(() =>
      expect(mockSetValue).toHaveBeenCalledWith(
        'tools',
        ['sys__server__sys_mcp_srv', 'sys__all__sys_mcp_srv'],
        expect.objectContaining({ shouldDirty: true }),
      ),
    );
  });

  test('deferred connect does not duplicate an already-attached wildcard', async () => {
    mockInitializeServer.mockResolvedValue({ success: true, connectionDeferred: true });
    mockIsConnectionDeferred.mockReturnValue(true);
    mockGetValues.mockReturnValue(['sys__server__sys_mcp_srv', 'sys__all__sys_mcp_srv']);
    const empty: McpItem = {
      ...item,
      server: { ...item.server, tools: [] } as never,
      toolCount: 0,
    };
    render(<McpSection item={empty} />);
    fireEvent.click(screen.getByText('com_nav_mcp_connect_server'));
    await waitFor(() => expect(mockInitializeServer).toHaveBeenCalled());
    expect(mockSetValue).not.toHaveBeenCalled();
  });

  test('wildcard attachment shows every enumerable tool as selected', () => {
    // The mcp_all wildcard grants every tool at runtime; if the server's tools
    // become enumerable, the display must reflect that instead of showing
    // unchecked boxes while runtime grants everything.
    mockGetValues.mockReturnValue(['sys__all__sys_mcp_srv']);
    render(<McpSection item={item} />);
    expect(screen.getByTestId('tool-mcp:srv:a')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('tool-mcp:srv:b')).toHaveAttribute('aria-pressed', 'true');
  });

  test('touching a selection converts the wildcard to concrete tool ids', () => {
    // With a wildcard attached and tools enumerable, deselecting one tool must
    // rewrite the form with the remaining concrete ids and drop the wildcard —
    // otherwise runtime would still grant every tool while the UI shows a subset.
    mockGetValues.mockReturnValue(['sys__all__sys_mcp_srv']);
    render(<McpSection item={item} />);
    fireEvent.click(screen.getByTestId('tool-mcp:srv:a'));
    expect(mockSetValue).toHaveBeenCalledWith(
      'tools',
      ['sys__server__sys_mcp_srv', 'mcp:srv:b'],
      expect.objectContaining({ shouldDirty: true }),
    );
  });

  test('bulk intent toggle renders only when the tool_intents capability is enabled', () => {
    const { unmount } = render(<McpSection item={item} />);
    expect(screen.queryByRole('button', { name: 'com_ui_mcp_intent_all' })).not.toBeInTheDocument();
    unmount();

    mockCapabilities.toolIntentsEnabled = true;
    render(<McpSection item={item} />);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_mcp_intent_all' }));
    expect(mockToggleIntentAll).toHaveBeenCalledWith(item.server.tools);
  });

  test('bulk programmatic toggle requires Code Interpreter to be available and selected', () => {
    mockCapabilities.programmaticToolsEnabled = true;
    const { unmount } = render(<McpSection item={item} />);
    expect(screen.getByRole('button', { name: 'com_ui_mcp_programmatic_all' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    unmount();

    mockCapabilities.codeEnabled = true;
    mockCodeInterpreterSelected.mockReturnValue(true);
    render(<McpSection item={item} />);
    expect(screen.getByRole('button', { name: 'com_ui_mcp_programmatic_all' })).not.toHaveAttribute(
      'aria-disabled',
    );
  });

  test('bulk programmatic toggle can clear a legacy programmatic configuration', () => {
    mockCapabilities.programmaticToolsEnabled = true;
    mockAreAllToolsProgrammatic.mockReturnValue(true);

    render(<McpSection item={item} />);

    expect(
      screen.getByRole('button', { name: 'com_ui_mcp_unprogrammatic_all' }),
    ).not.toHaveAttribute('aria-disabled');
  });

  test('bulk background toggle uses the shared semantic pressed state', () => {
    mockCapabilities.backgroundToolsEnabled = true;
    mockAreAllToolsBackground.mockReturnValue(true);

    render(<McpSection item={item} />);

    expect(screen.getByRole('button', { name: 'com_ui_mcp_unbackground_all' })).toHaveClass(
      'border-series-1',
      'bg-surface-active',
      'text-text-primary',
    );
  });

  test('bulk intent skips programmatic-only tools (label can never reach them)', () => {
    mockCapabilities.toolIntentsEnabled = true;
    mockIsToolProgrammaticOnly.mockImplementation((toolId: string) => toolId === 'mcp:srv:a');
    render(<McpSection item={item} />);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_mcp_intent_all' }));
    expect(mockToggleIntentAll).toHaveBeenCalledWith([
      expect.objectContaining({ tool_id: 'mcp:srv:b' }),
    ]);
  });

  test('legacy raw-keyed form ids show as selected for a special-character server', () => {
    /** Tool ids in the catalog now embed the normalized server name; an agent
     *  saved before that convention must still show its tools checked. */
    const specialItem: McpItem = {
      ...item,
      id: 'Connector: Company',
      name: 'Connector: Company',
      server: {
        serverName: 'Connector: Company',
        isConfigured: true,
        tools: [{ tool_id: 'search_mcp_Connector__Company', name: 'Search' }],
        metadata: { description: 'desc' },
      } as never,
      toolCount: 1,
    };
    mockGetValues.mockReturnValue(['search_mcp_Connector: Company']);
    render(<McpSection item={specialItem} />);
    expect(screen.getByTestId('tool-search_mcp_Connector__Company')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('selection updates REPLACE legacy raw-keyed ids instead of letting them survive', () => {
    const specialItem: McpItem = {
      ...item,
      id: 'Connector: Company',
      name: 'Connector: Company',
      server: {
        serverName: 'Connector: Company',
        isConfigured: true,
        tools: [{ tool_id: 'search_mcp_Connector__Company', name: 'Search' }],
        metadata: { description: 'desc' },
      } as never,
      toolCount: 1,
    };
    mockGetValues.mockReturnValue(['search_mcp_Connector: Company']);
    render(<McpSection item={specialItem} />);
    /** Deselecting the (legacy-selected) tool must drop the raw id rather
     *  than leave it behind for the runtime heal to keep active. */
    fireEvent.click(screen.getByTestId('tool-search_mcp_Connector__Company'));
    expect(mockSetValue).toHaveBeenCalledWith(
      'tools',
      ['sys__server__sys_mcp_Connector: Company'],
      expect.objectContaining({ shouldDirty: true }),
    );
  });

  test('migrates legacy raw-keyed tool_options to the current normalized ids', () => {
    /** Persisted options must be readable and clearable through the toggles,
     *  which index by the normalized catalog id; an existing normalized entry
     *  wins over the legacy one on collision. */
    const specialItem: McpItem = {
      ...item,
      id: 'Connector: Company',
      name: 'Connector: Company',
      server: {
        serverName: 'Connector: Company',
        isConfigured: true,
        tools: [{ tool_id: 'search_mcp_Connector__Company', name: 'Search' }],
        metadata: { description: 'desc' },
      } as never,
      toolCount: 1,
    };
    mockGetToolOptions.mockReturnValue({
      'search_mcp_Connector: Company': { run_in_background: true, defer_loading: true },
      search_mcp_Connector__Company: { run_in_background: false },
      other_tool: { describe_intent: true },
    });
    render(<McpSection item={specialItem} />);
    expect(mockSetValue).toHaveBeenCalledWith('tool_options', {
      other_tool: { describe_intent: true },
      search_mcp_Connector__Company: { run_in_background: false, defer_loading: true },
    });
  });

  test('never migrates keys of a SHADOWED server (normalized slot claimed by another)', () => {
    /** With servers `foo` and `foo!`, rewriting `search_mcp_foo!` would land
     *  on `search_mcp_foo` — the WINNER server's key — so saving would apply
     *  the shadowed server's defer/background/intent settings to the other
     *  server's tool. The runtime heal leaves shadowed keys raw; the form
     *  migration must fail closed the same way. */
    mockMcpServersMap.mockReturnValue(
      new Map<string, object>([
        ['foo', {}],
        ['foo!', {}],
      ]),
    );
    const shadowedServer: McpItem = {
      ...item,
      id: 'foo!',
      name: 'foo!',
      server: {
        serverName: 'foo!',
        isConfigured: true,
        tools: [{ tool_id: 'search_mcp_foo', name: 'Search' }],
        metadata: { description: 'desc' },
      } as never,
      toolCount: 1,
    };
    mockGetToolOptions.mockReturnValue({
      'search_mcp_foo!': { run_in_background: true },
    });
    render(<McpSection item={shadowedServer} />);
    expect(mockSetValue).not.toHaveBeenCalledWith('tool_options', expect.anything());
  });

  test('never migrates entries that belong to a LONGER server sharing this suffix', () => {
    /** With servers `!bar` and `foo_mcp_!bar`, the longer server's legacy key
     *  also suffix-ends with `_mcp_!bar` — opening the shorter server's dialog
     *  must not reassign or corrupt the longer server's persisted settings. */
    mockMcpServersMap.mockReturnValue(
      new Map<string, object>([
        ['!bar', {}],
        ['foo_mcp_!bar', {}],
      ]),
    );
    const shortServer: McpItem = {
      ...item,
      id: '!bar',
      name: '!bar',
      server: {
        serverName: '!bar',
        isConfigured: true,
        tools: [{ tool_id: 'search_mcp_bar', name: 'Search' }],
        metadata: { description: 'desc' },
      } as never,
      toolCount: 1,
    };
    mockGetToolOptions.mockReturnValue({
      'search_mcp_foo_mcp_!bar': { run_in_background: true },
    });
    render(<McpSection item={shortServer} />);
    expect(mockSetValue).not.toHaveBeenCalledWith('tool_options', expect.anything());
  });

  test('shows the runtime-tools hint when attached via the wildcard', () => {
    mockGetValues.mockReturnValue(['sys__all__sys_mcp_srv']);
    const empty: McpItem = {
      ...item,
      server: { ...item.server, tools: [] } as never,
      toolCount: 0,
    };
    render(<McpSection item={empty} />);
    expect(screen.getByText('com_ui_tools_mcp_runtime_tools')).toBeInTheDocument();
  });
});
