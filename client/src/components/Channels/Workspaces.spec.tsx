import React from 'react';
import userEvent from '@testing-library/user-event';
import { dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import type { SlackWorkspaceStatus } from 'librechat-data-provider';
import Workspaces from './Workspaces';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getSlackWorkspaces: jest.fn(),
      connectSlackWorkspace: jest.fn(),
      disconnectSlackWorkspace: jest.fn(),
      cancelSlackWorkspaceInstall: jest.fn(),
    },
  };
});

let mockUser = { id: 'admin', tenantId: 'org-a' };
jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: mockUser }),
  useLocalize: () => (key: string) => key,
}));

const workspace = {
  workspaceId: 'workspace-1',
  appId: 'A123',
  teamId: 'T123',
  teamName: 'Engineering',
  botUserId: 'U123',
  revision: 'revision-1',
  status: 'active' as const,
  scopes: [],
};
let response: SlackWorkspaceStatus;
const channels: Array<{ onmessage: ((event: MessageEvent) => void) | null; close: jest.Mock }> = [];
const previousChannel = window.BroadcastChannel;
let list: jest.SpyInstance;
let disconnect: jest.SpyInstance;
let connect: jest.SpyInstance;
let cancel: jest.SpyInstance;
const popup = { opener: null, closed: false, location: { href: '' }, close: jest.fn() };

function page() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  return render(
    <QueryClientProvider client={client}>
      <Workspaces />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUser = { id: 'admin', tenantId: 'org-a' };
  response = { configured: true, canManage: true, workspaces: [workspace] };
  list = jest.spyOn(dataService, 'getSlackWorkspaces').mockImplementation(async () => response);
  disconnect = jest.spyOn(dataService, 'disconnectSlackWorkspace').mockImplementation(async () => {
    response = { ...response, workspaces: [{ ...workspace, status: 'disconnected' }] };
  });
  connect = jest.spyOn(dataService, 'connectSlackWorkspace').mockResolvedValue({
    url: 'https://slack.com/oauth/v2/authorize?state=test',
    flowId: 'this-flow',
    expiresInSeconds: 600,
  });
  cancel = jest.spyOn(dataService, 'cancelSlackWorkspaceInstall').mockResolvedValue(undefined);
  popup.closed = false;
  popup.location.href = '';
  popup.close.mockClear();
  jest.spyOn(window, 'open').mockImplementation(() => popup as unknown as Window);
  Object.defineProperty(window, 'BroadcastChannel', {
    configurable: true,
    value: class {
      onmessage = null;
      close = jest.fn();
      constructor() {
        channels.push(this);
      }
    },
  });
  channels.length = 0;
});
afterEach(() => {
  jest.restoreAllMocks();
  Object.defineProperty(window, 'BroadcastChannel', { configurable: true, value: previousChannel });
});

test('the optional integration stays hidden when no app or saved workspace exists', async () => {
  response = { configured: false, canManage: false, workspaces: [] };
  page();
  await waitFor(() => expect(list).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByRole('heading')).not.toBeInTheDocument());
});

test('members see org workspaces without installation credentials or admin controls', async () => {
  response.canManage = false;
  page();
  await screen.findByText('Engineering');
  expect(screen.getByText('com_ui_slack_workspaces_admin')).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'com_ui_slack_workspaces_connect' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'com_ui_slack_workspaces_disconnect' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText('T123')).not.toBeInTheDocument();
});

test('disconnect requires confirmation and refreshes the org workspace state', async () => {
  const user = userEvent.setup();
  page();
  await screen.findByText('Engineering');
  await user.click(screen.getByRole('button', { name: 'com_ui_slack_workspaces_disconnect' }));
  expect(disconnect).not.toHaveBeenCalled();
  const confirmation = screen.getByRole('group', { name: 'com_ui_slack_workspaces_confirm' });
  await user.click(
    within(confirmation).getByRole('button', { name: 'com_ui_slack_workspaces_disconnect' }),
  );
  await screen.findByText('com_ui_slack_workspaces_disconnected');
  expect(disconnect).toHaveBeenCalledWith('workspace-1');
  expect(screen.queryByRole('group')).not.toBeInTheDocument();
});

test('OAuth completion refreshes the list only for the flow this user started', async () => {
  const user = userEvent.setup();
  page();
  await screen.findByText('Engineering');
  await user.click(screen.getByRole('button', { name: 'com_ui_slack_workspaces_connect' }));
  await screen.findByText('com_ui_slack_workspaces_waiting');
  expect(connect).toHaveBeenCalledWith(undefined);
  expect(popup.location.href).toMatch(/^https:\/\/slack.com\/oauth\/v2\/authorize/);
  act(() =>
    channels[0].onmessage?.(
      new MessageEvent('message', { data: { flowId: 'another-flow', outcome: 'succeeded' } }),
    ),
  );
  expect(screen.getByText('com_ui_slack_workspaces_waiting')).toBeInTheDocument();
  response = {
    ...response,
    workspaces: [workspace, { ...workspace, workspaceId: 'workspace-2', teamName: 'Design' }],
  };
  act(() =>
    channels[0].onmessage?.(
      new MessageEvent('message', { data: { flowId: 'this-flow', outcome: 'succeeded' } }),
    ),
  );
  await screen.findByText('Design');
  expect(screen.queryByText('com_ui_slack_workspaces_waiting')).not.toBeInTheDocument();
});

test('a blocked popup is actionable and does not create an installation attempt', async () => {
  const user = userEvent.setup();
  jest.spyOn(window, 'open').mockReturnValue(null);
  page();
  await screen.findByText('Engineering');
  await user.click(screen.getByRole('button', { name: 'com_ui_slack_workspaces_connect' }));
  expect(screen.getByRole('alert')).toHaveTextContent('com_ui_slack_workspaces_error');
  expect(connect).not.toHaveBeenCalled();
});

test('cancelling a pending installation invalidates the attempt on the server', async () => {
  const user = userEvent.setup();
  page();
  await screen.findByText('Engineering');
  await user.click(screen.getByRole('button', { name: 'com_ui_slack_workspaces_connect' }));
  await screen.findByText('com_ui_slack_workspaces_waiting');
  await user.click(screen.getByRole('button', { name: 'com_ui_cancel' }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith('this-flow'));
  await waitFor(() =>
    expect(screen.queryByText('com_ui_slack_workspaces_waiting')).not.toBeInTheDocument(),
  );
});

test('saved workspaces remain disconnectable when the deployment turns off new installations', async () => {
  response.configured = false;
  page();
  await screen.findByText('Engineering');
  expect(
    screen.queryByRole('button', { name: 'com_ui_slack_workspaces_connect' }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'com_ui_slack_workspaces_disconnect' })).toBeEnabled();
});

test('pagination does not silently hide additional connected workspaces', async () => {
  const user = userEvent.setup();
  list.mockImplementation(async (cursor?: string) =>
    cursor
      ? {
          configured: true,
          canManage: true,
          workspaces: [{ ...workspace, workspaceId: 'workspace-2', teamName: 'Design' }],
        }
      : { ...response, next: 'workspace-1' },
  );
  page();
  await screen.findByText('Engineering');
  await user.click(screen.getByRole('button', { name: 'com_ui_slack_workspaces_more' }));
  await screen.findByText('Design');
  expect(list).toHaveBeenCalledWith('workspace-1');
});
