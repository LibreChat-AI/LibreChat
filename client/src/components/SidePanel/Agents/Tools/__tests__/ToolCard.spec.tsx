import '@testing-library/jest-dom/extend-expect';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AgentItem } from '../items/types';
import ToolCard from '../ToolCard';

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string, options?: Record<string, unknown>): string => {
      if (!options) return key;
      const parts = Object.entries(options).map(([name, value]) => `${name}=${String(value)}`);
      return `${key}[${parts.join(',')}]`;
    },
  useAuthContext: () => ({ user: { id: 'u1' } }),
}));

const skill: AgentItem = {
  kind: 'skill',
  id: 's1',
  name: 'Reviewer',
  description: 'Review PRs',
  iconKey: 'skill',
  skill: { _id: 's1', name: 'Reviewer' } as never,
};

describe('ToolCard', () => {
  test('renders item name and description', () => {
    render(<ToolCard item={skill} selected={false} onToggle={jest.fn()} />);
    expect(screen.getByText('Reviewer')).toBeInTheDocument();
    expect(screen.getByText('Review PRs')).toBeInTheDocument();
  });

  test('clicking the card invokes onToggle with the item', () => {
    const onToggle = jest.fn();
    render(<ToolCard item={skill} selected={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: /Reviewer/ }));
    expect(onToggle).toHaveBeenCalledWith(skill);
  });

  test('selected cards expose aria-pressed=true', () => {
    render(<ToolCard item={skill} selected onToggle={jest.fn()} />);
    expect(screen.getByRole('button', { name: /Reviewer/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('renders a verified badge for built-ins', () => {
    const builtin: AgentItem = {
      kind: 'builtin',
      id: 'execute_code',
      name: 'Code Interpreter',
      description: 'Run Python',
      iconKey: 'execute_code',
    };
    render(<ToolCard item={builtin} selected={false} onToggle={jest.fn()} />);
    expect(screen.getByLabelText('com_ui_tools_native')).toBeInTheDocument();
  });

  test('does not render the tool-count pill for MCP cards', () => {
    const mcp: AgentItem = {
      kind: 'mcp',
      id: 'everything',
      name: 'Everything',
      description: '',
      iconKey: 'mcp',
      server: { serverName: 'everything', isConfigured: true, tools: [] } as never,
      toolCount: 14,
    };
    render(<ToolCard item={mcp} selected={false} onToggle={jest.fn()} />);
    expect(screen.queryByText('com_ui_tools_count[count=14]')).not.toBeInTheDocument();
  });

  test('renders public and shared-author badges for another user public skill', () => {
    const shared: AgentItem = {
      kind: 'skill',
      id: 's2',
      name: 'Shared',
      description: '',
      iconKey: 'skill',
      skill: {
        _id: 's2',
        name: 'Shared',
        author: 'u2',
        authorName: 'Alice',
        isPublic: true,
      } as never,
    };
    render(<ToolCard item={shared} selected={false} onToggle={jest.fn()} />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByLabelText('com_ui_sr_public_skill')).toBeInTheDocument();
  });

  test('omits the author badge for the current user own skill', () => {
    const own: AgentItem = {
      kind: 'skill',
      id: 's3',
      name: 'Mine',
      description: '',
      iconKey: 'skill',
      skill: { _id: 's3', name: 'Mine', author: 'u1', authorName: 'Me', isPublic: false } as never,
    };
    render(<ToolCard item={own} selected={false} onToggle={jest.fn()} />);
    expect(screen.queryByText('Me')).not.toBeInTheDocument();
  });

  describe('favorite star', () => {
    test('renders with add label and aria-pressed=false when not favorited', () => {
      render(
        <ToolCard
          item={skill}
          selected={false}
          onToggle={jest.fn()}
          onToggleFavorite={jest.fn()}
        />,
      );
      const star = screen.getByRole('button', { name: 'com_ui_favorite' });
      expect(star).toHaveAttribute('aria-pressed', 'false');
    });

    test('clicking the star calls onToggleFavorite without toggling the card', () => {
      const onToggle = jest.fn();
      const onToggleFavorite = jest.fn();
      render(
        <ToolCard
          item={skill}
          selected={false}
          onToggle={onToggle}
          onToggleFavorite={onToggleFavorite}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'com_ui_favorite' }));
      expect(onToggleFavorite).toHaveBeenCalledWith(skill);
      expect(onToggle).not.toHaveBeenCalled();
    });

    test('a favorited card keeps the star visible with the remove label', () => {
      render(
        <ToolCard
          item={skill}
          selected={false}
          onToggle={jest.fn()}
          isFavorited
          onToggleFavorite={jest.fn()}
        />,
      );
      const star = screen.getByRole('button', { name: 'com_ui_unfavorite' });
      expect(star).toHaveAttribute('aria-pressed', 'true');
    });

    test('renders no star without an onToggleFavorite handler', () => {
      render(<ToolCard item={skill} selected={false} onToggle={jest.fn()} />);
      expect(screen.queryByRole('button', { name: 'com_ui_favorite' })).not.toBeInTheDocument();
    });

    test('renders no star for action items', () => {
      const action: AgentItem = {
        kind: 'action',
        id: 'a1',
        name: 'My Action',
        description: '',
        iconKey: 'action',
        endpointCount: 0,
      };
      render(
        <ToolCard
          item={action}
          selected={false}
          onToggle={jest.fn()}
          onToggleFavorite={jest.fn()}
        />,
      );
      expect(screen.queryByRole('button', { name: 'com_ui_favorite' })).not.toBeInTheDocument();
    });
  });
});
