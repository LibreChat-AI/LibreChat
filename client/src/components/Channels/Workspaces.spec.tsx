import React from 'react';
import userEvent from '@testing-library/user-event';
import { dataService, QueryKeys } from 'librechat-data-provider';
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
      removeSlackWorkspace: jest.fn(),
      cancelSlackWorkspaceInstall: jest.fn(),
    },
  };
});

let mockUser = { id: 'admin', tenantId: 'org-a' };
jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: mockUser }),
  useLocalize: () => (key: string) => key,
  useCopyToClipboard: () => jest.fn(),
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

async function page(open = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <Workspaces />
    </QueryClientProvider>,
  );
  if (open) {
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: /com_ui_manage|com_ui_slack_setup/ }));
    await userEvent.setup().click(await screen.findByRole('button', { name: /A123/ }));
  }
  return { ...view, client };
}

async function workspaceAction(name: string) {
  const labels: Record<string, string> = {
    com_ui_slack_workspaces_disconnect: 'com_ui_slack_disconnect_named',
    com_ui_slack_workspaces_remove: 'com_ui_slack_workspace_remove_named',
    com_ui_slack_workspaces_reconnect: 'com_ui_slack_reconnect_named',
  };
  return screen.findByRole('button', { name: labels[name] });
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
  jest.spyOn(dataService, 'removeSlackWorkspace').mockImplementation(async () => {
    response = { ...response, workspaces: [] };
  });
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

test('places connection settings between access and reconnect and returns focus to its icon', async () => {
  jest.mocked(dataService.getSlackApps).mockResolvedValue({
    configured: true,
    canManage: true,
    apps: [{ appId: 'A123', clientId: '123.456', revision: 'r1' }],
    setup: {
      redirectUri: 'https://chat.example/oauth',
      eventsBaseUrl: 'https://gateway.example/slack/events',
      interactionsBaseUrl: 'https://gateway.example/slack/interactions',
    },
  });
  const user = userEvent.setup();
  await page();
  const row = screen.getByRole('group', { name: 'Engineering' });
  expect(
    within(row)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label')),
  ).toEqual([
    'com_ui_slack_manage_access_named',
    'com_ui_slack_apps_connection_settings_named',
    'com_ui_slack_reconnect_named',
    'com_ui_slack_disconnect_named',
  ]);
  const trigger = within(row).getByRole('button', {
    name: 'com_ui_slack_apps_connection_settings_named',
  });
  await user.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'com_ui_slack_apps_connection_settings' });
  expect(within(dialog).getByLabelText('com_ui_slack_apps_events')).toHaveValue(
    'https://gateway.example/slack/events/org-a/A123',
  );
  await user.click(within(dialog).getByRole('button', { name: 'com_ui_close' }));
  await waitFor(() => expect(trigger).toHaveFocus());
});
afterEach(() => {
  jest.restoreAllMocks();
  Object.defineProperty(window, 'BroadcastChannel', { configurable: true, value: previousChannel });
});

test('the optional integration stays hidden when no app or saved workspace exists', async () => {
  response = { configured: false, canManage: false, workspaces: [] };
  await page(false);
  await waitFor(() => expect(list).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByRole('heading')).not.toBeInTheDocument());
});

test('members see org workspaces without installation credentials or admin controls', async () => {
  response.canManage = false;
  await page();
  await screen.findByText('Engineering');
  expect(screen.getByText('com_ui_slack_workspaces_admin')).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /com_ui_slack_workspaces_connect(?:_another)?/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'com_ui_slack_disconnect_named' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText('T123')).not.toBeInTheDocument();
});

test('disconnect requires confirmation and refreshes the org workspace state', async () => {
  const user = userEvent.setup();
  await page();
  await screen.findByText('Engineering');
  expect(
    screen.queryByRole('button', { name: 'com_ui_slack_workspace_remove_named' }),
  ).not.toBeInTheDocument();
  const appReads = jest.mocked(dataService.getSlackApps).mock.calls.length;
  await user.click(await workspaceAction('com_ui_slack_workspaces_disconnect'));
  expect(disconnect).not.toHaveBeenCalled();
  const confirmation = screen.getByRole('dialog', { name: 'com_ui_slack_workspaces_disconnect' });
  await user.click(
    within(confirmation).getByRole('button', { name: 'com_ui_slack_workspaces_disconnect' }),
  );
  await screen.findByText('com_ui_slack_workspaces_disconnected');
  expect(disconnect).toHaveBeenCalledWith('workspace-1', 'revision-1');
  await waitFor(() =>
    expect(jest.mocked(dataService.getSlackApps).mock.calls.length).toBeGreaterThan(appReads),
  );
  expect(
    screen.queryByRole('button', { name: 'com_ui_slack_reconnect_named' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('dialog', {
      name: /com_ui_slack_workspaces_disconnect|com_ui_slack_workspaces_remove/,
    }),
  ).not.toBeInTheDocument();
});

test('only admins can confirm removal of a disconnected workspace', async () => {
  const user = userEvent.setup();
  response.workspaces = [{ ...workspace, status: 'disconnected' }];
  const { client } = await page();
  await user.click(await workspaceAction('com_ui_slack_workspaces_remove'));
  expect(dataService.removeSlackWorkspace).not.toHaveBeenCalled();
  expect(
    screen.getByRole('dialog', { name: 'com_ui_slack_workspaces_remove' }),
  ).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'com_ui_slack_workspaces_remove' })).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() =>
    expect(
      screen.queryByRole('dialog', {
        name: /com_ui_slack_workspaces_disconnect|com_ui_slack_workspaces_remove/,
      }),
    ).not.toBeInTheDocument(),
  );
  expect(await workspaceAction('com_ui_slack_workspaces_remove')).toHaveFocus();
  await user.click(await workspaceAction('com_ui_slack_workspaces_remove'));
  await user.click(
    within(
      screen.getByRole('dialog', {
        name: /com_ui_slack_workspaces_disconnect|com_ui_slack_workspaces_remove/,
      }),
    ).getByRole('button', {
      name: 'com_ui_slack_workspaces_remove',
    }),
  );
  await waitFor(() =>
    expect(dataService.removeSlackWorkspace).toHaveBeenCalledWith('workspace-1', 'revision-1'),
  );
  await waitFor(() => expect(screen.queryByText('Engineering')).not.toBeInTheDocument());
  await waitFor(() =>
    expect(screen.getByRole('dialog', { name: 'com_ui_slack_manage_title' })).toHaveFocus(),
  );
  response = {
    ...response,
    canManage: false,
    workspaces: [{ ...workspace, status: 'disconnected' }],
  };
  await act(async () => {
    await client.invalidateQueries([QueryKeys.slackWorkspaces]);
  });
  await screen.findByText('Engineering');
  expect(
    screen.queryByRole('button', { name: 'com_ui_slack_workspace_remove_named' }),
  ).not.toBeInTheDocument();
});

test('keeps the confirmed revision when workspace metadata changes before disconnect', async () => {
  const user = userEvent.setup();
  const { client } = await page();
  await user.click(await workspaceAction('com_ui_slack_workspaces_disconnect'));
  response = { ...response, workspaces: [{ ...workspace, revision: 'revision-2' }] };
  await act(async () => {
    await client.invalidateQueries([QueryKeys.slackWorkspaces]);
  });
  disconnect.mockRejectedValueOnce(new Error('Workspace changed'));
  await user.click(
    within(
      screen.getByRole('dialog', {
        name: /com_ui_slack_workspaces_disconnect|com_ui_slack_workspaces_remove/,
      }),
    ).getByRole('button', {
      name: 'com_ui_slack_workspaces_disconnect',
    }),
  );
  await waitFor(() => expect(disconnect).toHaveBeenLastCalledWith('workspace-1', 'revision-1'));
  await waitFor(() =>
    expect(
      screen.queryByRole('dialog', {
        name: /com_ui_slack_workspaces_disconnect|com_ui_slack_workspaces_remove/,
      }),
    ).not.toBeInTheDocument(),
  );
  await user.click(await workspaceAction('com_ui_slack_workspaces_disconnect'));
  await user.click(
    within(
      screen.getByRole('dialog', {
        name: /com_ui_slack_workspaces_disconnect|com_ui_slack_workspaces_remove/,
      }),
    ).getByRole('button', {
      name: 'com_ui_slack_workspaces_disconnect',
    }),
  );
  await waitFor(() => expect(disconnect).toHaveBeenLastCalledWith('workspace-1', 'revision-2'));
});

test('OAuth completion refreshes the list only for the flow this user started', async () => {
  const user = userEvent.setup();
  response.workspaces = [];
  await page();
  await user.click(
    await screen.findByRole('button', { name: /com_ui_slack_workspaces_connect(?:_another)?/ }),
  );
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
    workspaces: [{ ...workspace, teamName: 'Design' }],
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
  response.workspaces = [];
  const view = await page();
  await user.click(
    await screen.findByRole('button', { name: /com_ui_slack_workspaces_connect(?:_another)?/ }),
  );
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
    workspaces: [{ ...workspace, teamName: 'Design' }],
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
  await user.click(await workspaceAction('com_ui_slack_workspaces_reconnect'));
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
  response.workspaces = [];
  await page();
  await user.click(
    await screen.findByRole('button', { name: /com_ui_slack_workspaces_connect(?:_another)?/ }),
  );
  expect(screen.getByRole('alert')).toHaveTextContent('com_ui_slack_workspaces_error');
  expect(connect).not.toHaveBeenCalled();
});

test('cancelling a pending installation invalidates the attempt on the server', async () => {
  const user = userEvent.setup();
  response.workspaces = [];
  await page();
  await user.click(
    await screen.findByRole('button', { name: /com_ui_slack_workspaces_connect(?:_another)?/ }),
  );
  await screen.findByText('com_ui_slack_workspaces_waiting');
  await user.click(screen.getByRole('button', { name: 'com_ui_cancel' }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith('this-flow'));
  await waitFor(() =>
    expect(screen.queryByText('com_ui_slack_workspaces_waiting')).not.toBeInTheDocument(),
  );
});

test('saved workspaces remain disconnectable when the deployment turns off new installations', async () => {
  response.configured = false;
  await page();
  await screen.findByText('Engineering');
  expect(
    screen.queryByRole('button', { name: /com_ui_slack_workspaces_connect(?:_another)?/ }),
  ).not.toBeInTheDocument();
  expect(await workspaceAction('com_ui_slack_workspaces_disconnect')).toBeEnabled();
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
  await page();
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
  response.workspaces = [];
  const view = await page();
  await user.click(
    await screen.findByRole('button', { name: /com_ui_slack_workspaces_connect(?:_another)?/ }),
  );
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
  response.workspaces = [];
  const view = await page();
  await user.click(
    await screen.findByRole('button', { name: /com_ui_slack_workspaces_connect(?:_another)?/ }),
  );
  await screen.findByText('com_ui_slack_workspaces_waiting');
  view.unmount();
  expect(cancel).toHaveBeenCalledWith('this-flow');
});

test('a grant for an app no longer configured remains removable and is not presented as usable', async () => {
  response.configured = false;
  await page();
  await screen.findByText('com_ui_slack_workspaces_unavailable');
  expect(
    screen.queryByRole('button', { name: 'com_ui_slack_reconnect_named' }),
  ).not.toBeInTheDocument();
  expect(await workspaceAction('com_ui_slack_workspaces_disconnect')).toBeEnabled();
});

test('explains the storage requirement without displaying a remote error body', async () => {
  connect.mockRejectedValueOnce({
    isAxiosError: true,
    response: { data: { error: { code: 'transactions_unavailable' }, private: 'not-for-display' } },
  });
  const user = userEvent.setup();
  response.workspaces = [];
  await page();
  await user.click(
    await screen.findByRole('button', { name: /com_ui_slack_workspaces_connect(?:_another)?/ }),
  );
  await screen.findByText('com_ui_channels_transaction_required');
  expect(screen.queryByText('not-for-display')).not.toBeInTheDocument();
});

test('closing management restores focus to the settings row action', async () => {
  const user = userEvent.setup();
  await page();
  await user.click(screen.getByRole('button', { name: 'com_ui_close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'com_ui_manage' })).toHaveFocus();
});

test('groups each workspace status with its name and offers direct scoped actions', async () => {
  const user = userEvent.setup();
  await page();
  const row = await screen.findByRole('group', { name: 'Engineering' });
  expect(within(row).getByText('com_ui_slack_workspaces_active')).toBeInTheDocument();
  expect(
    within(row).getByRole('button', { name: 'com_ui_slack_manage_access_named' }),
  ).toBeEnabled();
  expect(within(row).getByRole('button', { name: 'com_ui_slack_disconnect_named' })).toBeEnabled();
  expect(within(row).queryByRole('menuitem')).not.toBeInTheDocument();
  expect(
    within(row).queryByRole('button', { name: 'com_ui_more_options' }),
  ).not.toBeInTheDocument();
  await user.click(within(row).getByRole('button', { name: 'com_ui_slack_reconnect_named' }));
  await waitFor(() => expect(connect).toHaveBeenCalledWith('workspace-1', undefined));
});

test('opens a focused status dialog before start completes and cancels its late flow safely', async () => {
  let complete!: (value: SlackWorkspaceConnect) => void;
  connect.mockImplementationOnce(
    () => new Promise<SlackWorkspaceConnect>((resolve) => (complete = resolve)),
  );
  const user = userEvent.setup();
  response.workspaces = [];
  await page();
  const trigger = await screen.findByRole('button', {
    name: /com_ui_slack_workspaces_connect(?:_another)?/,
  });
  await user.click(trigger);
  const dialog = screen.getByRole('dialog', {
    name: /com_ui_slack_connecting|com_ui_slack_connection_failed/,
  });
  expect(within(dialog).getByRole('status')).toHaveTextContent('com_ui_slack_workspaces_waiting');
  expect(within(dialog).getByRole('status').querySelector('svg')).toBeInTheDocument();
  expect(dialog).toContainElement(document.activeElement as HTMLElement);
  await user.keyboard('{Escape}');
  expect(dialog).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'com_ui_cancel' }));
  expect(popup.close).toHaveBeenCalled();
  expect(within(dialog).getByRole('button', { name: 'com_ui_cancel' })).toBeDisabled();
  expect(cancel).not.toHaveBeenCalled();
  await act(async () =>
    complete({
      url: 'https://slack.com/oauth/v2/authorize?state=late',
      flowId: 'late-cancelled-flow',
      expiresInSeconds: 600,
    }),
  );
  await waitFor(() => expect(cancel).toHaveBeenCalledWith('late-cancelled-flow'));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(popup.location.href).toBe('');
  expect(trigger).toHaveFocus();
});

test('keeps failed cancellation focused and retries retirement before closing', async () => {
  cancel.mockRejectedValueOnce(new Error('private-provider-error'));
  const user = userEvent.setup();
  await page();
  const trigger = await workspaceAction('com_ui_slack_workspaces_reconnect');
  await user.click(trigger);
  await waitFor(() => expect(popup.location.href).not.toBe(''));
  const dialog = screen.getByRole('dialog', {
    name: /com_ui_slack_connecting|com_ui_slack_connection_failed/,
  });
  await user.click(within(dialog).getByRole('button', { name: 'com_ui_cancel' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'com_ui_slack_workspaces_error',
  );
  expect(screen.queryByText('private-provider-error')).not.toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(dialog).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'com_ui_cancel' }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(cancel.mock.calls).toEqual([['this-flow'], ['this-flow']]);
  expect(trigger).toHaveFocus();
});

test('retries a failed connection with the original workspace and restores its action focus', async () => {
  const user = userEvent.setup();
  await page();
  const trigger = await workspaceAction('com_ui_slack_workspaces_reconnect');
  await user.click(trigger);
  await waitFor(() => expect(popup.location.href).not.toBe(''));
  act(() =>
    channels[0].onmessage?.(
      new MessageEvent('message', { data: { flowId: 'this-flow', outcome: 'failed' } }),
    ),
  );
  const dialog = screen.getByRole('dialog', {
    name: /com_ui_slack_connecting|com_ui_slack_connection_failed/,
  });
  await within(dialog).findByRole('alert');
  connect.mockResolvedValueOnce({
    url: 'https://slack.com/oauth/v2/authorize?state=retry',
    flowId: 'retry-flow',
    expiresInSeconds: 600,
  });
  await user.click(within(dialog).getByRole('button', { name: 'com_ui_retry' }));
  await waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
  expect(connect).toHaveBeenLastCalledWith('workspace-1', undefined);
  await waitFor(() => expect(popup.location.href).toContain('state=retry'));
  act(() =>
    channels[0].onmessage?.(
      new MessageEvent('message', { data: { flowId: 'retry-flow', outcome: 'succeeded' } }),
    ),
  );
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
});

test('retires a timed out attempt and retries the originally selected app', async () => {
  connect.mockResolvedValueOnce({
    url: 'https://slack.com/oauth/v2/authorize?state=expired',
    flowId: 'expired-flow',
    expiresInSeconds: 0,
  });
  const user = userEvent.setup();
  response.workspaces = [];
  await page();
  await user.click(
    await screen.findByRole('button', { name: /com_ui_slack_workspaces_connect(?:_another)?/ }),
  );
  const dialog = screen.getByRole('dialog', {
    name: /com_ui_slack_connecting|com_ui_slack_connection_failed/,
  });
  await within(dialog).findByRole('alert');
  expect(cancel).toHaveBeenCalledWith('expired-flow');
  await user.click(within(dialog).getByRole('button', { name: 'com_ui_retry' }));
  await waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
  expect(connect).toHaveBeenLastCalledWith(undefined, 'A123');
  expect(within(dialog).getByRole('status')).toBeInTheDocument();
});

test('a blocked popup can be retried without losing the selected app', async () => {
  jest.spyOn(window, 'open').mockReturnValueOnce(null);
  const user = userEvent.setup();
  response.workspaces = [];
  await page();
  await user.click(
    await screen.findByRole('button', { name: /com_ui_slack_workspaces_connect(?:_another)?/ }),
  );
  const dialog = screen.getByRole('dialog', {
    name: /com_ui_slack_connecting|com_ui_slack_connection_failed/,
  });
  expect(within(dialog).getByRole('alert')).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'com_ui_retry' }));
  await waitFor(() => expect(connect).toHaveBeenCalledWith(undefined, 'A123'));
  expect(within(dialog).getByRole('status')).toBeInTheDocument();
});

test('owns the retry popup before awaiting retirement and closes it on unmount', async () => {
  let retire!: () => void;
  cancel.mockRejectedValueOnce(new Error('cancellation failed')).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        retire = resolve;
      }),
  );
  const retryPopup = { ...popup, location: { href: '' }, close: jest.fn() };
  jest
    .spyOn(window, 'open')
    .mockReturnValueOnce(popup as unknown as Window)
    .mockReturnValueOnce(retryPopup as unknown as Window);
  const user = userEvent.setup();
  const view = await page();
  await user.click(await workspaceAction('com_ui_slack_workspaces_reconnect'));
  await waitFor(() => expect(popup.location.href).not.toBe(''));
  const dialog = screen.getByRole('dialog', { name: 'com_ui_slack_connecting' });
  await user.click(within(dialog).getByRole('button', { name: 'com_ui_cancel' }));
  await within(dialog).findByRole('alert');
  await user.click(within(dialog).getByRole('button', { name: 'com_ui_retry' }));
  expect(window.open).toHaveBeenCalledTimes(2);
  expect(cancel).toHaveBeenCalledTimes(2);
  expect(connect).toHaveBeenCalledTimes(1);
  expect(retryPopup.close).not.toHaveBeenCalled();
  view.unmount();
  expect(retryPopup.close).toHaveBeenCalled();
  await act(async () => retire());
  expect(connect).toHaveBeenCalledTimes(1);
});
