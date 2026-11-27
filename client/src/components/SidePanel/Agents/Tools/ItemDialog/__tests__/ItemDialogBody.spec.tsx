import '@testing-library/jest-dom/extend-expect';
import { render, screen } from '@testing-library/react';
import type { AgentItem } from '../../items/types';
import ItemDialogBody from '../ItemDialogBody';

jest.mock('react-hook-form', () => ({
  useFormContext: () => ({ control: {}, getValues: () => undefined, setValue: jest.fn() }),
  useWatch: () => undefined,
}));

jest.mock('../../hooks', () => ({
  useAgentFileEntries: () => ({ contextFiles: [], knowledgeFiles: [], codeFiles: [] }),
}));

jest.mock('../sections/BuiltinSection', () => ({
  __esModule: true,
  default: ({ builtinId }: { builtinId: string }) => (
    <div data-testid="builtin-section">{builtinId}</div>
  ),
}));
jest.mock('../sections/ToolSection', () => ({
  __esModule: true,
  default: () => <div data-testid="tool-section" />,
}));
jest.mock('../sections/SkillSection', () => ({
  __esModule: true,
  default: () => <div data-testid="skill-section" />,
}));
jest.mock('../sections/McpSection', () => ({
  __esModule: true,
  default: () => <div data-testid="mcp-section" />,
}));
jest.mock('../sections/ActionSection', () => ({
  __esModule: true,
  default: () => <div data-testid="action-section" />,
}));

const baseProps = {
  agentId: 'a1',
  onClose: jest.fn(),
};

const skill: AgentItem = {
  kind: 'skill',
  id: 's1',
  name: 'Reviewer',
  description: 'desc',
  iconKey: 'skill',
  skill: { _id: 's1', name: 'Reviewer' } as never,
};
const tool: AgentItem = {
  kind: 'tool',
  id: 't1',
  name: 'Tool',
  description: 'desc',
  iconKey: 'tool',
  plugin: { pluginKey: 't1', name: 'Tool' } as never,
};
const mcp: AgentItem = {
  kind: 'mcp',
  id: 'srv',
  name: 'srv',
  description: '',
  iconKey: 'mcp',
  server: { serverName: 'srv', isConfigured: true, tools: [] } as never,
  toolCount: 0,
};
const action: AgentItem = {
  kind: 'action',
  id: 'a1',
  name: 'action',
  description: '',
  iconKey: 'action',
  action: { action_id: 'a1', agent_id: 'a1' } as never,
  endpointCount: 1,
};
const builtin: AgentItem = {
  kind: 'builtin',
  id: 'execute_code',
  name: 'Code',
  description: '',
  iconKey: 'execute_code',
};

describe('ItemDialogBody', () => {
  test.each([
    ['builtin', builtin, 'builtin-section'],
    ['tool', tool, 'tool-section'],
    ['skill', skill, 'skill-section'],
    ['mcp', mcp, 'mcp-section'],
    ['action', action, 'action-section'],
  ])('renders the %s section', (_kind, item, testId) => {
    render(<ItemDialogBody item={item} {...baseProps} />);
    expect(screen.getByTestId(testId)).toBeInTheDocument();
  });
});
