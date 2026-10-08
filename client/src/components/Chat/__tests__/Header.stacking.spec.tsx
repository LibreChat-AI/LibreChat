import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import Header from '../Header';

const mockEndpoint = { current: 'agents' };
const mockSmallScreen = { current: false };

jest.mock('react-router-dom', () => ({
  useParams: () => ({ conversationId: 'convo-1' }),
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
jest.mock('~/data-provider', () => ({ useGetStartupConfig: () => ({ data: undefined }) }));
jest.mock('~/hooks', () => ({ useHasAccess: () => false }));
jest.mock('~/hooks/Nav/useDrawerViewport', () => () => mockSmallScreen.current);
jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    sidebarExpanded: {},
    isSubmittingFamily: () => ({}),
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
  BackgroundTasksButton: jest.fn(() => <div data-testid="conversation-tasks" />),
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
  const pullRequestChip = jest.requireMock('../PullRequest').PullRequestChip as jest.Mock;

  const headerMenu = jest.requireMock('../Menus').HeaderMenu as jest.Mock;

  beforeEach(() => {
    backgroundTasks.mockClear();
    pullRequestChip.mockClear();
    headerMenu.mockClear();
    mockEndpoint.current = 'agents';
    mockSmallScreen.current = false;
  });

  test('keeps header controls above the z-10 composer approval review', () => {
    const { container } = render(<Header />);

    expect(container.firstElementChild).toHaveClass('absolute', 'top-0', 'z-20');
    expect(backgroundTasks).toHaveBeenCalled();
  });

  test('keeps conversation task controls mounted across endpoint switches', () => {
    const { rerender } = render(<Header />);
    mockEndpoint.current = 'openAI';
    rerender(<Header />);
    expect(screen.getByTestId('conversation-tasks')).toBeInTheDocument();
  });

  test('does not mount parent task controls on child threads', () => {
    render(<Header parentConversationId="parent" />);
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
});
