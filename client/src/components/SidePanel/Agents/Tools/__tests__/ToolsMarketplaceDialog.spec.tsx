import '@testing-library/jest-dom/extend-expect';
import { fireEvent, render, screen } from '@testing-library/react';
import type { SVGProps } from 'react';
import ToolsMarketplaceDialog from '../ToolsMarketplaceDialog';

const mockSetValue = jest.fn();
const mockGetValues = jest.fn((_: string): unknown => []);
let mockWatchedTools: string[] = [];
let mockExecuteCode = false;
let mockMcpServersMap = new Map<string, object>();
let mockIsDesktop = true;

jest.mock('react-hook-form', () => ({
  useFormContext: () => ({
    control: {},
    getValues: mockGetValues,
    setValue: mockSetValue,
  }),
  useWatch: ({ name }: { name: string }) => {
    const map: Record<string, unknown> = {
      tools: mockWatchedTools,
      skills: [],
      execute_code: mockExecuteCode,
      web_search: false,
      file_search: false,
      artifacts: '',
      context_files: [],
      knowledge_files: [],
      code_files: [],
    };
    return map[name];
  },
}));

jest.mock('~/Providers', () => ({
  useAgentPanelContext: () => ({
    agentsConfig: { capabilities: ['execute_code', 'tools'] },
    regularTools: [{ pluginKey: 'dalle', name: 'DALL-E', description: 'Images' }],
    mcpServersMap: mockMcpServersMap,
    actions: [],
  }),
}));

const mockToggleFavorite = jest.fn();
let mockFavoriteKeys = new Set<string>();

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => true,
  useCategories: () => ({ categories: [] }),
  useAuthContext: () => ({ user: { id: 'u1' } }),
  useToolFavorites: () => ({
    favoriteKeys: mockFavoriteKeys,
    toggle: mockToggleFavorite,
    isFavorite: (item: { kind: string; id: string }) =>
      mockFavoriteKeys.has(`${item.kind}:${item.id}`),
    isLoading: false,
  }),
}));

jest.mock('@ariakit/react/menu', () => ({
  MenuButton: ({ render }: { render: React.ReactNode }) => render,
}));

jest.mock('~/data-provider', () => ({
  useListSkillsQuery: () => ({ data: { skills: [] }, isLoading: false }),
  useGetToolFavoritesQuery: () => ({ data: [] }),
}));

jest.mock('react-router-dom', () => ({
  useNavigate: () => jest.fn(),
}));

let mockFileEntries: {
  contextFiles: Array<[string, unknown]>;
  knowledgeFiles: Array<[string, unknown]>;
  codeFiles: Array<[string, unknown]>;
} = { contextFiles: [], knowledgeFiles: [], codeFiles: [] };

jest.mock('../hooks', () => {
  const { buildCatalog } = jest.requireActual('../items/catalog');
  const { deriveSelectedItems } = jest.requireActual('../items/selectors');
  return {
    useUninstallToolCredentials: () => jest.fn(),
    useAgentFileEntries: () => mockFileEntries,
    /** Mirrors the real pipeline over the mocked panel context + form watches. */
    useAgentItems: ({ agentId }: { agentId: string }) => {
      const { useAgentPanelContext } = jest.requireMock('~/Providers');
      const { useWatch } = jest.requireMock('react-hook-form');
      const { agentsConfig, regularTools, mcpServersMap, actions } = useAgentPanelContext();
      const agentActions = (actions ?? []).filter(
        (a: { agent_id: string }) => a.agent_id === agentId,
      );
      const tools = (useWatch({ name: 'tools' }) ?? []) as string[];
      const catalog = buildCatalog({
        agentsConfig: { capabilities: agentsConfig?.capabilities ?? [] },
        regularTools: regularTools ?? [],
        mcpServersMap: mcpServersMap ?? new Map(),
        skills: [],
        actions: agentActions,
        permissions: { mcp: true, skills: false, webSearch: true, runCode: true, fileSearch: true },
      });
      const selected = deriveSelectedItems(
        {
          execute_code: (useWatch({ name: 'execute_code' }) ?? false) as boolean,
          web_search: (useWatch({ name: 'web_search' }) ?? false) as boolean,
          file_search: (useWatch({ name: 'file_search' }) ?? false) as boolean,
          memory: false,
          artifacts: (useWatch({ name: 'artifacts' }) ?? '') as string,
          tools,
          skills: [],
          context_files: [],
          knowledge_files: [],
          code_files: [],
        },
        catalog,
        agentActions,
      );
      return { catalog, selected, tools };
    },
  };
});

jest.mock('@librechat/client', () => {
  const React = jest.requireActual('react');
  const passthrough =
    (tag: string) =>
    ({ children, asChild, ...rest }: any) =>
      React.createElement(asChild ? React.Fragment : tag, asChild ? null : rest, children);
  return {
    Button: ({ children, onClick, asChild, ...rest }: any) =>
      asChild
        ? React.createElement(React.Fragment, null, children)
        : React.createElement('button', { onClick, type: 'button', ...rest }, children),
    Input: React.forwardRef((props: any, ref: any) =>
      React.createElement('input', { ...props, ref }),
    ),
    DropdownPopup: ({ trigger }: { trigger: React.ReactNode }) =>
      React.createElement('div', null, trigger),
    OGDialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
      open ? React.createElement('div', null, children) : null,
    OGDialogContent: passthrough('div'),
    OGDialogHeader: passthrough('div'),
    OGDialogTitle: passthrough('h2'),
    OGDialogDescription: passthrough('p'),
    OGDialogClose: ({ children, asChild }: any) =>
      asChild
        ? React.createElement(React.Fragment, null, children)
        : React.createElement('button', { type: 'button' }, children),
    VerifiedIcon: (props: SVGProps<SVGSVGElement>) => React.createElement('svg', props),
    useMediaQuery: () => mockIsDesktop,
    useToastContext: () => ({ showToast: jest.fn() }),
  };
});

jest.mock('../ItemDialog/ItemDialog', () => ({
  __esModule: true,
  default: ({ item }: { item: unknown }) => (item ? <div data-testid="item-dialog" /> : null),
}));
jest.mock('../ItemDialog/AddMcpServerDialog', () => ({
  __esModule: true,
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="add-mcp-dialog" /> : null),
}));

describe('ToolsMarketplaceDialog', () => {
  beforeEach(() => {
    mockSetValue.mockClear();
    mockGetValues.mockClear();
    mockGetValues.mockReturnValue([]);
    mockWatchedTools = [];
    mockExecuteCode = false;
    mockMcpServersMap = new Map();
    mockToggleFavorite.mockClear();
    mockFavoriteKeys = new Set<string>();
    mockIsDesktop = true;
    mockFileEntries = { contextFiles: [], knowledgeFiles: [], codeFiles: [] };
  });

  test('renders cards from catalog when open', () => {
    render(<ToolsMarketplaceDialog open onOpenChange={jest.fn()} agentId="a1" />);
    expect(screen.getByText('DALL-E')).toBeInTheDocument();
  });

  test('does not render anything when closed', () => {
    const { container } = render(
      <ToolsMarketplaceDialog open={false} onOpenChange={jest.fn()} agentId="a1" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  test('clicking a tool card calls setValue on tools array with the id appended', () => {
    render(<ToolsMarketplaceDialog open onOpenChange={jest.fn()} agentId="a1" />);
    fireEvent.click(screen.getByRole('button', { name: /DALL-E/ }));
    expect(mockSetValue).toHaveBeenCalledWith(
      'tools',
      expect.arrayContaining(['dalle']),
      expect.objectContaining({ shouldDirty: true }),
    );
  });

  test('routes a file-holding built-in to its file dialog instead of clearing the flag', () => {
    /** Clearing the flag here left the row still selected (it reads the file count) while
     *  the save wrote the tool off the flag alone, silently dropping it from the agent. */
    mockExecuteCode = true;
    mockFileEntries = { contextFiles: [], knowledgeFiles: [], codeFiles: [['c1', {}]] };

    render(<ToolsMarketplaceDialog open onOpenChange={jest.fn()} agentId="a1" />);
    fireEvent.click(screen.getByRole('button', { name: /com_ui_run_code/ }));

    expect(mockSetValue).not.toHaveBeenCalledWith('execute_code', false, expect.anything());
  });

  test('disabling Code Interpreter clears programmatic MCP callers immediately', () => {
    mockExecuteCode = true;
    mockGetValues.mockImplementation((name: string) =>
      name === 'tool_options'
        ? {
            search: { allowed_callers: ['code_execution'], defer_loading: true },
            direct: { allowed_callers: ['direct'] },
          }
        : [],
    );

    render(<ToolsMarketplaceDialog open onOpenChange={jest.fn()} agentId="a1" />);
    fireEvent.click(screen.getByRole('button', { name: /com_ui_run_code/ }));

    expect(mockSetValue).toHaveBeenCalledWith('execute_code', false, { shouldDirty: true });
    expect(mockSetValue).toHaveBeenCalledWith(
      'tool_options',
      {
        search: { defer_loading: true },
        direct: { allowed_callers: ['direct'] },
      },
      { shouldDirty: true },
    );
  });

  test('typing in search input filters the catalog', () => {
    render(<ToolsMarketplaceDialog open onOpenChange={jest.fn()} agentId="a1" />);
    const input = screen.getByPlaceholderText('com_ui_tools_marketplace_search');
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(screen.getByText('com_ui_tools_search_no_results')).toBeInTheDocument();
  });

  test('clicking an unselected tool card toggles it without opening the detail pane', () => {
    mockSetValue.mockClear();
    render(<ToolsMarketplaceDialog open onOpenChange={jest.fn()} agentId="a1" />);
    fireEvent.click(screen.getByRole('button', { name: /DALL-E/ }));
    expect(screen.queryByTestId('item-dialog')).not.toBeInTheDocument();
    expect(mockSetValue).toHaveBeenCalledWith(
      'tools',
      expect.arrayContaining(['dalle']),
      expect.objectContaining({ shouldDirty: true }),
    );
  });

  test.each([
    [true, false, true],
    [false, true, true],
    [false, true, undefined],
  ])(
    'attaches a ready empty catalog (requestScoped=%s, connected=%s, ready=%s)',
    (requestScoped, isConnected, isReadyForAgent) => {
      mockMcpServersMap = new Map([
        [
          'runtime',
          {
            serverName: 'runtime',
            tools: [],
            isConfigured: true,
            isConnected,
            isReadyForAgent,
            requestScoped,
            metadata: { name: 'runtime', pluginKey: 'runtime', description: '' },
          },
        ],
      ]);

      render(<ToolsMarketplaceDialog open onOpenChange={jest.fn()} agentId="a1" />);
      fireEvent.click(screen.getByRole('button', { name: /runtime/ }));

      expect(screen.queryByTestId('item-dialog')).not.toBeInTheDocument();
      expect(mockSetValue).toHaveBeenCalledWith(
        'tools',
        ['sys__server__sys_mcp_runtime', 'sys__all__sys_mcp_runtime'],
        { shouldDirty: true },
      );
    },
  );

  test('keeps concrete tool selection for an ordinary server with a populated catalog', () => {
    mockMcpServersMap = new Map([
      [
        'enumerated',
        {
          serverName: 'enumerated',
          tools: [{ tool_id: 'search_mcp_enumerated' }, { tool_id: 'read_mcp_enumerated' }],
          isConfigured: true,
          isConnected: true,
          isReadyForAgent: true,
          requestScoped: false,
          metadata: { name: 'enumerated', description: '' },
        },
      ],
    ]);
    render(<ToolsMarketplaceDialog open onOpenChange={jest.fn()} agentId="a1" />);
    fireEvent.click(screen.getByRole('button', { name: /enumerated/ }));
    expect(mockSetValue).toHaveBeenCalledWith(
      'tools',
      ['sys__server__sys_mcp_enumerated', 'search_mcp_enumerated', 'read_mcp_enumerated'],
      { shouldDirty: true },
    );
  });

  test.each([true, false])(
    'removes a selected zero-tool server (requestScoped=%s)',
    (requestScoped) => {
      const selectedTools = [
        'sys__server__sys_mcp_runtime',
        'sys__all__sys_mcp_runtime',
        'search_mcp_runtime',
        'dalle',
      ];
      mockWatchedTools = selectedTools;
      mockGetValues.mockReturnValue(selectedTools);
      mockMcpServersMap = new Map([
        [
          'runtime',
          {
            serverName: 'runtime',
            tools: [],
            isConfigured: true,
            isConnected: true,
            isReadyForAgent: true,
            requestScoped,
            metadata: { name: 'runtime', pluginKey: 'runtime', description: '' },
          },
        ],
      ]);

      render(<ToolsMarketplaceDialog open onOpenChange={jest.fn()} agentId="a1" />);
      fireEvent.click(screen.getByRole('button', { name: /runtime/ }));

      expect(screen.queryByTestId('item-dialog')).not.toBeInTheDocument();
      expect(mockSetValue).toHaveBeenCalledWith('tools', ['dalle'], { shouldDirty: true });
    },
  );

  test.each([
    ['an ordinary disconnected', false, false, undefined],
    ['a disconnected request-scoped', true, false, undefined],
    ['an explicitly unready connected', false, true, false],
  ])(
    'clicking %s zero-tool server opens setup without changing the form',
    (_description, requestScoped, isConnected, isReadyForAgent) => {
      mockMcpServersMap = new Map([
        [
          'setup-required',
          {
            serverName: 'setup-required',
            tools: [],
            isConfigured: true,
            isConnected,
            requestScoped,
            isReadyForAgent,
            metadata: {
              name: 'setup-required',
              pluginKey: 'setup-required',
              description: '',
            },
          },
        ],
      ]);

      render(<ToolsMarketplaceDialog open onOpenChange={jest.fn()} agentId="a1" />);
      fireEvent.click(screen.getByRole('button', { name: /setup-required/ }));

      expect(screen.getByTestId('item-dialog')).toBeInTheDocument();
      expect(mockSetValue).not.toHaveBeenCalled();
    },
  );

  test('clicking a card star toggles the favorite without selecting the tool', () => {
    render(<ToolsMarketplaceDialog open onOpenChange={jest.fn()} agentId="a1" />);
    fireEvent.click(screen.getAllByRole('button', { name: 'com_ui_favorite' })[0]);
    expect(mockToggleFavorite).toHaveBeenCalledTimes(1);
    expect(mockSetValue).not.toHaveBeenCalled();
  });

  test('the Favorites view shows only favorited items', () => {
    mockFavoriteKeys = new Set(['tool:dalle']);
    render(<ToolsMarketplaceDialog open onOpenChange={jest.fn()} agentId="a1" />);
    fireEvent.click(screen.getByRole('button', { name: /com_ui_tools_view_favorites/ }));
    expect(screen.getByText('DALL-E')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_run_code')).not.toBeInTheDocument();
  });

  test('the Favorites view is empty without favorites', () => {
    render(<ToolsMarketplaceDialog open onOpenChange={jest.fn()} agentId="a1" />);
    fireEvent.click(screen.getByRole('button', { name: /com_ui_tools_view_favorites/ }));
    expect(screen.getByText('com_ui_tools_view_favorites_empty')).toBeInTheDocument();
  });

  test('below md the rail is replaced by a functional filter chip row', () => {
    mockIsDesktop = false;
    render(<ToolsMarketplaceDialog open onOpenChange={jest.fn()} agentId="a1" />);
    expect(screen.getByRole('group', { name: 'com_ui_tools_marketplace' })).toBeInTheDocument();
    expect(screen.queryByText('com_ui_tools_create_new')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /com_ui_tools_view_favorites/ }));
    expect(screen.getByText('com_ui_tools_view_favorites_empty')).toBeInTheDocument();
  });
});
