import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { render, screen, fireEvent } from '@testing-library/react';
import type { AgentItem } from '../items/types';
import { makeSkill } from 'test/itemFactories';
import ToolsSection from '../ToolsSection';

let mockSelected: AgentItem[] = [];
let mockAgentTools: string[] = [];
let mockFileEntries: {
  contextFiles: unknown[];
  knowledgeFiles: unknown[];
  codeFiles: unknown[];
} = { contextFiles: [], knowledgeFiles: [], codeFiles: [] };
const mockSetValue = jest.fn();
let mockFormValues: Record<string, unknown> = {};

jest.mock('react-hook-form', () => ({
  useFormContext: () => ({
    control: {},
    getValues: (name: string) => mockFormValues[name],
    setValue: mockSetValue,
  }),
  useWatch: ({ name }: { name: string }) => mockFormValues[name],
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => true,
}));

jest.mock('~/Providers', () => ({
  useAgentPanelContext: () => ({
    agentsConfig: { capabilities: ['skills'] },
    regularTools: [],
    mcpServersMap: new Map(),
    actions: [],
  }),
}));

jest.mock('~/data-provider', () => ({
  useSkillsInfiniteQuery: () => ({ data: { pages: [{ skills: [] }] } }),
  useDeleteAgentAction: () => ({ mutate: jest.fn() }),
}));

jest.mock('~/hooks/MCP', () => ({
  useRemoveMCPTool: () => ({ removeTool: jest.fn() }),
  useVisibleTools: () => ({ toolIds: [], mcpServerNames: [] }),
}));

jest.mock('../hooks', () => ({
  useAgentItems: () => ({ catalog: [], selected: mockSelected, tools: mockAgentTools }),
  useResolvedSkills: (skills?: unknown[]) => skills,
  useAgentFileEntries: () => mockFileEntries,
  useUninstallToolCredentials: () => jest.fn(),
}));

jest.mock('../ToolRow', () => ({
  __esModule: true,
  default: ({ item, onRemove }: { item: AgentItem; onRemove: (item: AgentItem) => void }) => (
    <button type="button" aria-label={`remove-${item.id}`} onClick={() => onRemove(item)}>
      {item.id}
      {item.kind === 'mcp' ? <span>{item.toolCount}</span> : null}
    </button>
  ),
}));

jest.mock('../SkillsSection', () => ({
  __esModule: true,
  default: ({
    items,
    onAdd,
    onRemove,
  }: {
    items: AgentItem[];
    onAdd: () => void;
    onRemove: (item: AgentItem) => void;
  }) => (
    <div data-testid="skills-section">
      <button type="button" aria-label="skills-add" onClick={onAdd} />
      {items[0] && (
        <button
          type="button"
          aria-label={`skills-remove-${items[0].id}`}
          onClick={() => onRemove(items[0])}
        />
      )}
    </div>
  ),
}));

jest.mock('../SkillsDialog', () => ({
  __esModule: true,
  default: ({ open }: { open: boolean }) =>
    open ? <div data-testid="skills-dialog-open" /> : null,
}));

jest.mock('../ItemDialog/ItemDialog', () => ({
  __esModule: true,
  default: ({ item }: { item: AgentItem | null }) =>
    item ? <div data-testid="item-dialog">{item.id}</div> : null,
}));

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: jest.fn() }),
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...rest
  }: React.ComponentProps<'button'> & { variant?: string; size?: string }) => (
    <button type="button" {...rest}>
      {children}
    </button>
  ),
  Label: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  OGDialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  OGDialogTemplate: () => null,
  Switch: ({
    id,
    checked,
    disabled,
    'aria-labelledby': ariaLabelledBy,
    onCheckedChange,
  }: {
    id?: string;
    checked?: boolean;
    disabled?: boolean;
    'aria-labelledby'?: string;
    onCheckedChange?: (value: boolean) => void;
  }) => (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-labelledby={ariaLabelledBy}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
    />
  ),
  HoverCard: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  HoverCardPortal: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  HoverCardContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  HoverCardTrigger: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  CircleHelpIcon: () => <svg aria-hidden="true" />,
}));

jest.mock('../ToolsMarketplaceDialog', () => ({
  __esModule: true,
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="marketplace-open" /> : null),
}));

const fileSearchItem: AgentItem = {
  kind: 'builtin',
  id: 'file_search',
  name: 'com_assistants_file_search',
  description: '',
  iconKey: 'file_search',
};
const skillItem: AgentItem = {
  kind: 'skill',
  id: 's1',
  name: 'Skill',
  description: '',
  iconKey: 'skill',
  skill: makeSkill({ _id: 's1', name: 'Skill' }),
};

beforeEach(() => {
  mockSelected = [];
  mockAgentTools = [];
  mockFileEntries = { contextFiles: [], knowledgeFiles: [], codeFiles: [] };
  mockFormValues = {};
  mockSetValue.mockClear();
});

describe('ToolsSection', () => {
  test('renders Tools header', () => {
    render(<ToolsSection agentId="a" />);
    expect(screen.getByText('com_ui_tools_section_title')).toBeInTheDocument();
  });

  test('renders the SkillsSection component', () => {
    render(<ToolsSection agentId="a" />);
    expect(screen.getByTestId('skills-section')).toBeInTheDocument();
  });
  test('renders Add button that opens the marketplace dialog', () => {
    render(<ToolsSection agentId="a" />);
    const addButton = screen.getByRole('button', { name: 'com_ui_add_tools' });
    fireEvent.click(addButton);
    expect(screen.getByTestId('marketplace-open')).toBeInTheDocument();
  });

  test('wires SkillsSection add and remove callbacks', () => {
    mockSelected = [skillItem];
    mockFormValues = {
      skills: ['s1'],
      skills_enabled: true,
      skills_scope: 'selected',
      skill_authoring_enabled: true,
    };
    render(<ToolsSection agentId="a" />);
    fireEvent.click(screen.getByRole('button', { name: 'skills-add' }));
    expect(screen.getByTestId('skills-dialog-open')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'skills-remove-s1' }));

    expect(mockSetValue).toHaveBeenCalledWith('skills', [], { shouldDirty: true });
    expect(mockSetValue).not.toHaveBeenCalledWith(
      'skills_enabled',
      expect.anything(),
      expect.anything(),
    );
    expect(mockSetValue).not.toHaveBeenCalledWith(
      'skills_scope',
      expect.anything(),
      expect.anything(),
    );
    expect(mockSetValue).not.toHaveBeenCalledWith(
      'skill_authoring_enabled',
      expect.anything(),
      expect.anything(),
    );
  });

  test('renders the Tools empty state when nothing is selected', () => {
    render(<ToolsSection agentId="a" />);
    expect(screen.getByText('com_ui_tools_empty')).toBeInTheDocument();
  });

  test('counts every enumerable MCP tool when the server is attached by wildcard', () => {
    mockAgentTools = ['sys__all__sys_mcp_runtime'];
    mockSelected = [
      {
        kind: 'mcp',
        id: 'runtime',
        name: 'runtime',
        description: '',
        iconKey: 'mcp',
        toolCount: 0,
        server: {
          serverName: 'runtime',
          tools: [{ tool_id: 'search_mcp_runtime' }, { tool_id: 'read_mcp_runtime' }],
          isConfigured: true,
          isConnected: true,
          metadata: { name: 'runtime', pluginKey: 'runtime', description: '' },
        } as never,
      },
    ];

    render(<ToolsSection agentId="a" />);

    expect(screen.getByRole('button', { name: 'remove-runtime' })).toHaveTextContent('2');
  });

  test('opens the config dialog instead of toggling when a file-backed built-in holds files', () => {
    mockSelected = [fileSearchItem];
    mockFileEntries = { contextFiles: [], knowledgeFiles: [['f1', {}]], codeFiles: [] };
    render(<ToolsSection agentId="a" />);
    fireEvent.click(screen.getByRole('button', { name: 'remove-file_search' }));
    expect(screen.getByTestId('item-dialog')).toHaveTextContent('file_search');
    expect(mockSetValue).not.toHaveBeenCalledWith('file_search', false, expect.anything());
  });

  test('toggles the flag off when a file-backed built-in has no files', () => {
    mockSelected = [fileSearchItem];
    mockFileEntries = { contextFiles: [], knowledgeFiles: [], codeFiles: [] };
    render(<ToolsSection agentId="a" />);
    fireEvent.click(screen.getByRole('button', { name: 'remove-file_search' }));
    expect(screen.queryByTestId('item-dialog')).not.toBeInTheDocument();
    expect(mockSetValue).toHaveBeenCalledWith('file_search', false, { shouldDirty: true });
  });

  test('clears programmatic MCP callers when Code Interpreter is removed', () => {
    mockSelected = [
      {
        kind: 'builtin',
        id: 'execute_code',
        name: 'Run Code',
        description: '',
        iconKey: 'execute_code',
      },
    ];
    mockFormValues = {
      tool_options: {
        search: { allowed_callers: ['code_execution'], defer_loading: true },
        direct: { allowed_callers: ['direct'] },
      },
    };

    render(<ToolsSection agentId="a" />);
    fireEvent.click(screen.getByRole('button', { name: 'remove-execute_code' }));

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
});
