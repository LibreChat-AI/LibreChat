import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import Header from '../Header';

const mockEndpoint = { current: 'agents' };
const mockSmallScreen = { current: false };
const mockRoute: { current: string | undefined } = { current: 'convo-1' };
const mockStartupConfig: { current: { interface: Record<string, unknown> } | undefined } = {
  current: { interface: {} },
};
const codeConversation = {
  conversationId: 'convo-1',
  codeEnvironmentMode: 'attached',
  codeWorkspaces: [{ environmentId: 'env', workspaceId: 'ws' }],
};
const mockConversation: { current: Record<string, unknown> | null } = {
  current: codeConversation,
};

jest.mock('react-router-dom', () => ({
  useParams: () => ({ conversationId: mockRoute.current }),
}));
jest.mock('recoil', () => ({
  useRecoilValue: (selector: string) =>
    selector === 'effectiveEndpoint' ? mockEndpoint.current : false,
}));
jest.mock('librechat-data-provider', () => ({
  getConfigDefaults: () => ({ interface: {} }),
  Constants: { NEW_CONVO: 'new' },
  EModelEndpoint: { agents: 'agents' },
  PermissionTypes: { BOOKMARKS: 'bookmarks', MULTI_CONVO: 'multi_convo', TEMPORARY_CHAT: 'temp' },
  Permissions: { USE: 'use' },
  isForcedTemporaryRetention:
    jest.requireActual('librechat-data-provider').isForcedTemporaryRetention,
}));
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockStartupConfig.current }),
}));
jest.mock('~/hooks', () => ({ useHasAccess: () => false }));
jest.mock('~/Providers', () => ({
  useChatContext: () => ({ conversation: mockConversation.current }),
}));
jest.mock('~/hooks/Nav/useDrawerViewport', () => () => mockSmallScreen.current);
jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    sidebarExpanded: {},
    effectiveEndpointByIndex: () => 'effectiveEndpoint',
  },
}));
jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | undefined>) => classes.filter(Boolean).join(' '),
}));
jest.mock('../Menus', () => ({
  OpenSidebar: () => null,
  PresetsMenu: () => null,
  NewChat: () => null,
  HeaderMenu: jest.fn(() => null),
}));
jest.mock('../TemporaryChat', () => ({
  TemporaryChat: () => null,
  TemporaryChatIndicator: () => null,
}));
jest.mock('../Trace', () => ({ useTraceControl: () => ({ show: false }) }));
jest.mock('../BackgroundTasks', () => ({
  BackgroundTasksButton: jest.fn(() => <div data-testid="conversation-tasks-popover" />),
}));
jest.mock('../Session', () => ({
  Session: jest.fn(() => <div data-testid="conversation-tasks" />),
}));
jest.mock('../PullRequest', () => ({
  PullRequestChip: jest.fn(() => <div data-testid="conversation-pull-request" />),
}));
jest.mock('../Menus/Endpoints/ModelSelector', () => () => null);
jest.mock('../ExportAndShareMenu', () => () => null);
jest.mock('../SubagentThreadLink', () => () => null);
jest.mock('../Menus/BookmarkMenu', () => () => null);
jest.mock('../AddMultiConvo', () => () => null);

describe('Header stacking', () => {
  const backgroundTasks = jest.requireMock('../BackgroundTasks').BackgroundTasksButton as jest.Mock;
  const session = jest.requireMock('../Session').Session as jest.Mock;
  const pullRequestChip = jest.requireMock('../PullRequest').PullRequestChip as jest.Mock;

  const headerMenu = jest.requireMock('../Menus').HeaderMenu as jest.Mock;

  beforeEach(() => {
    backgroundTasks.mockClear();
    session.mockClear();
    mockRoute.current = 'convo-1';
    mockStartupConfig.current = { interface: {} };
    pullRequestChip.mockClear();
    headerMenu.mockClear();
    headerMenu.mockImplementation(() => null);
    mockEndpoint.current = 'agents';
    mockSmallScreen.current = false;
    mockConversation.current = codeConversation;
  });

  test('does not mount the mobile action tree on desktop startup', () => {
    render(<Header />);
    expect(headerMenu).not.toHaveBeenCalled();
  });

  test('retains mobile action state when the viewport returns to desktop', () => {
    headerMenu.mockImplementation(() => <input aria-label="Menu draft" defaultValue="" />);
    const { rerender } = render(<Header />);
    expect(screen.queryByRole('textbox', { name: 'Menu draft' })).not.toBeInTheDocument();
    mockSmallScreen.current = true;
    rerender(<Header readOnly />);
    const input = screen.getByRole('textbox', { name: 'Menu draft' });
    fireEvent.change(input, { target: { value: 'unsaved dialog state' } });
    mockSmallScreen.current = false;
    rerender(<Header />);
    expect(screen.getByRole('textbox', { name: 'Menu draft' })).toBe(input);
    expect(input).toHaveValue('unsaved dialog state');
    expect(headerMenu.mock.calls.at(-1)[0]).toMatchObject({ className: 'hidden' });
    mockSmallScreen.current = true;
    rerender(<Header readOnly />);
    expect(screen.getByRole('textbox', { name: 'Menu draft' })).toBe(input);
    expect(input).toHaveValue('unsaved dialog state');
  });

  test('keeps header controls above the z-10 composer approval review', () => {
    const { container } = render(<Header />);

    expect(container.firstElementChild).toHaveClass('absolute', 'top-0', 'z-20');
    expect(session).toHaveBeenCalled();
  });

  test('hands the session control the routed conversation and its agent', () => {
    mockConversation.current = { ...codeConversation, agent_id: 'agent-1' };
    render(<Header />);
    expect(session.mock.calls[0][0]).toMatchObject({
      conversationId: 'convo-1',
      agentId: 'agent-1',
    });
    expect(backgroundTasks).not.toHaveBeenCalled();
  });

  test('lets the rail show itself unless the deployment says otherwise', () => {
    render(<Header />);
    expect(session.mock.calls[0][0]).toMatchObject({ autoOpen: true });
    session.mockClear();
    mockStartupConfig.current = { interface: { sessionRailAutoOpen: false } };
    render(<Header />);
    expect(session.mock.calls[0][0]).toMatchObject({ autoOpen: false });
  });

  test('offers the session control on a chat that has not been saved yet', () => {
    mockRoute.current = undefined;
    render(<Header />);
    expect(session.mock.calls[0][0]).toMatchObject({ conversationId: 'new' });
  });

  test('keeps the popover when the deployment turns the session rail off', () => {
    mockStartupConfig.current = { interface: { sessionRail: false } };
    render(<Header />);
    expect(session).not.toHaveBeenCalled();
    expect(backgroundTasks.mock.calls[0][0]).toMatchObject({ conversationId: 'convo-1' });
  });

  test('offers the popover no new chat to list', () => {
    mockStartupConfig.current = { interface: { sessionRail: false } };
    mockRoute.current = 'new';
    render(<Header />);
    expect(backgroundTasks).not.toHaveBeenCalled();
  });

  test('draws neither task control until the config has answered', () => {
    mockStartupConfig.current = undefined;
    render(<Header />);
    expect(session).not.toHaveBeenCalled();
    expect(backgroundTasks).not.toHaveBeenCalled();
  });

  test('keeps conversation task controls mounted across endpoint switches', () => {
    const { rerender } = render(<Header />);
    mockEndpoint.current = 'openAI';
    rerender(<Header />);
    expect(screen.getByTestId('conversation-tasks')).toBeInTheDocument();
  });

  test('does not mount parent task controls on child threads', () => {
    render(<Header parentConversationId="parent" />);
    expect(session).not.toHaveBeenCalled();
    expect(backgroundTasks).not.toHaveBeenCalled();
  });

  test('mounts the pull request chip for the routed conversation', () => {
    render(<Header />);
    expect(pullRequestChip.mock.calls[0][0]).toEqual({ conversationId: 'convo-1' });
  });

  test('does not mount the pull request chip on child threads', () => {
    render(<Header parentConversationId="parent" />);
    expect(pullRequestChip).not.toHaveBeenCalled();
  });

  test('places the pull request chip with the left controls, not beside the right ones', () => {
    render(<Header />);
    const chip = screen.getByTestId('conversation-pull-request');
    const tasks = screen.getByTestId('conversation-tasks');
    expect(chip.parentElement).not.toBe(tasks.parentElement);
  });

  test('leaves the chip to the overflow menu on small screens', () => {
    mockSmallScreen.current = true;
    render(<Header />);
    expect(pullRequestChip).not.toHaveBeenCalled();
    expect(headerMenu.mock.calls[0][0]).toMatchObject({ pullRequestConversationId: 'convo-1' });
  });

  test('offers the overflow menu no pull request for a child thread', () => {
    mockSmallScreen.current = true;
    render(<Header parentConversationId="parent" />);
    expect(headerMenu.mock.calls[0][0].pullRequestConversationId).toBeUndefined();
  });

  test('does not mount the pull request chip for an ordinary conversation', () => {
    mockConversation.current = { conversationId: 'convo-1' };
    render(<Header />);
    expect(pullRequestChip).not.toHaveBeenCalled();
  });

  test('does not mount the chip while the context still holds the previous chat', () => {
    mockConversation.current = { ...codeConversation, conversationId: 'other' };
    render(<Header />);
    expect(pullRequestChip).not.toHaveBeenCalled();
  });

  test('offers the overflow menu no pull request for an ordinary conversation', () => {
    mockSmallScreen.current = true;
    mockConversation.current = {
      conversationId: 'convo-1',
      codeEnvironmentMode: 'without_attached',
    };
    render(<Header />);
    expect(headerMenu.mock.calls[0][0].pullRequestConversationId).toBeUndefined();
  });
});
