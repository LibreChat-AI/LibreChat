import React from 'react';
import userEvent from '@testing-library/user-event';
import { dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import type { SlackWorkspaceStatus, SlackWorkspaceConnect } from 'librechat-data-provider';
import Workspaces from './Workspaces';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getSlackWorkspaces: jest.fn(),
      getSlackApps: jest.fn(),
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
  jest.spyOn(dataService, 'getSlackApps').mockResolvedValue({
    configured: true,
    canManage: true,
    apps: [{ appId: 'A123', clientId: '123.456', revision: 'r1' }],
  });
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
      onmessage: ((event: MessageEvent) => void) | null = null;
      close = jest.fn();
      addEventListener(_type: string, callback: (event: MessageEvent) => void) {
        this.onmessage = callback;
      }

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
  const appReads = jest.mocked(dataService.getSlackApps).mock.calls.length;
  await user.click(screen.getByRole('button', { name: 'com_ui_slack_workspaces_disconnect' }));
  expect(disconnect).not.toHaveBeenCalled();
  const confirmation = screen.getByRole('group', { name: 'com_ui_slack_workspaces_confirm' });
  await user.click(
    within(confirmation).getByRole('button', { name: 'com_ui_slack_workspaces_disconnect' }),
  );
  await screen.findByText('com_ui_slack_workspaces_disconnected');
  expect(disconnect).toHaveBeenCalledWith('workspace-1');
  await waitFor(() =>
    expect(jest.mocked(dataService.getSlackApps).mock.calls.length).toBeGreaterThan(appReads),
  );
  expect(
    screen.queryByRole('button', { name: 'com_ui_slack_workspaces_reconnect' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole('group')).not.toBeInTheDocument();
});

test('OAuth completion refreshes the list only for the flow this user started', async () => {
  const user = userEvent.setup();
  page();
  await screen.findByText('Engineering');
  await user.click(await screen.findByRole('button', { name: 'com_ui_slack_workspaces_connect' }));
  await screen.findByText('com_ui_slack_workspaces_waiting');
  expect(connect).toHaveBeenCalledWith(undefined, 'A123');
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

test('observes only its callback storage notice when BroadcastChannel is unavailable', async () => {
  Object.defineProperty(window, 'BroadcastChannel', { configurable: true, value: undefined });
  const user = userEvent.setup();
  const view = page();
  await screen.findByText('Engineering');
  await user.click(await screen.findByRole('button', { name: 'com_ui_slack_workspaces_connect' }));
  await screen.findByText('com_ui_slack_workspaces_waiting');
  const settled = (flowId: string, outcome = 'succeeded') =>
    act(() =>
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'librechat:oauth-settled',
          newValue: JSON.stringify({ flowId, outcome }),
        }),
      ),
    );
  settled('foreign-flow');
  expect(screen.getByText('com_ui_slack_workspaces_waiting')).toBeInTheDocument();
  response = {
    ...response,
    workspaces: [workspace, { ...workspace, workspaceId: 'design', teamName: 'Design' }],
  };
  settled('this-flow');
  await screen.findByText('Design');
  expect(screen.queryByText('com_ui_slack_workspaces_waiting')).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  connect.mockResolvedValue({
    url: 'https://slack.com/oauth/v2/authorize?state=next',
    flowId: 'next-flow',
    expiresInSeconds: 600,
  });
  await user.click(await screen.findByRole('button', { name: 'com_ui_slack_workspaces_connect' }));
  await screen.findByText('com_ui_slack_workspaces_waiting');
  settled('this-flow', 'failed');
  expect(screen.getByText('com_ui_slack_workspaces_waiting')).toBeInTheDocument();
  settled('next-flow', 'failed');
  await screen.findByRole('alert');
  expect(screen.queryByText('com_ui_slack_workspaces_waiting')).not.toBeInTheDocument();
  view.unmount();
  const reads = list.mock.calls.length;
  settled('next-flow');
  expect(list).toHaveBeenCalledTimes(reads);
});

test('a blocked popup is actionable and does not create an installation attempt', async () => {
  const user = userEvent.setup();
  jest.spyOn(window, 'open').mockReturnValue(null);
  page();
  await screen.findByText('Engineering');
  await user.click(await screen.findByRole('button', { name: 'com_ui_slack_workspaces_connect' }));
  expect(screen.getByRole('alert')).toHaveTextContent('com_ui_slack_workspaces_error');
  expect(connect).not.toHaveBeenCalled();
});

test('cancelling a pending installation invalidates the attempt on the server', async () => {
  const user = userEvent.setup();
  page();
  await screen.findByText('Engineering');
  await user.click(await screen.findByRole('button', { name: 'com_ui_slack_workspaces_connect' }));
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
          appId: 'A123',
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

test('closing settings retires a pending attempt, including a start response that arrives later', async () => {
  let complete!: (value: SlackWorkspaceConnect) => void;
  connect.mockImplementationOnce(
    () =>
      new Promise<SlackWorkspaceConnect>((resolve) => {
        complete = resolve;
      }),
  );
  const user = userEvent.setup();
  const view = page();
  await user.click(await screen.findByRole('button', { name: 'com_ui_slack_workspaces_connect' }));
  view.unmount();
  await act(async () =>
    complete({
      url: 'https://slack.com/oauth/v2/authorize?state=test',
      flowId: 'late-flow',
      expiresInSeconds: 600,
    }),
  );
  await waitFor(() => expect(cancel).toHaveBeenCalledWith('late-flow'));
  expect(popup.close).toHaveBeenCalled();
});

test('closing settings cancels the active attempt instead of leaving a hidden authorization', async () => {
  const user = userEvent.setup();
  const view = page();
  await user.click(await screen.findByRole('button', { name: 'com_ui_slack_workspaces_connect' }));
  await screen.findByText('com_ui_slack_workspaces_waiting');
  view.unmount();
  expect(cancel).toHaveBeenCalledWith('this-flow');
});

test('a grant for an app no longer configured remains removable and is not presented as usable', async () => {
  response.configured = false;
  page();
  await screen.findByText('com_ui_slack_workspaces_unavailable');
  expect(
    screen.queryByRole('button', { name: 'com_ui_slack_workspaces_reconnect' }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'com_ui_slack_workspaces_disconnect' })).toBeEnabled();
});

test('explains the storage requirement without displaying a remote error body', async () => {
  connect.mockRejectedValueOnce({
    isAxiosError: true,
    response: { data: { error: { code: 'transactions_unavailable' }, private: 'not-for-display' } },
  });
  const user = userEvent.setup();
  page();
  await user.click(await screen.findByRole('button', { name: 'com_ui_slack_workspaces_connect' }));
  await screen.findByText('com_ui_channels_transaction_required');
  expect(screen.queryByText('not-for-display')).not.toBeInTheDocument();
});
