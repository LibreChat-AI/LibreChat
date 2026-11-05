import React from 'react';
import userEvent from '@testing-library/user-event';
import { dataService, request } from 'librechat-data-provider';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Apps from './Apps';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getSlackApps: jest.fn(),
      configureSlackApp: jest.fn(),
      removeSlackApp: jest.fn(),
    },
  };
});

jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: { id: 'admin', tenantId: 'org.a' } }),
  useLocalize: () => (key: string) => key,
}));
const registration = { appId: 'A123', clientId: '123.456', revision: 'r1' };
const install = jest.fn();
function page() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <Apps principalKey="org.a:admin" busy={false} onInstall={install} />
    </QueryClientProvider>,
  );
  return { ...view, client };
}
beforeEach(() => {
  jest.spyOn(dataService, 'getSlackApps').mockResolvedValue({
    configured: true,
    canManage: true,
    apps: [registration],
    setup: {
      redirectUri: 'https://chat.example/api/channels/workspaces/oauth/callback',
      eventsBaseUrl: 'https://gateway.example/slack/events',
      interactionsBaseUrl: 'https://gateway.example/slack/interactions',
    },
  });
  jest
    .spyOn(dataService, 'configureSlackApp')
    .mockResolvedValue({ ...registration, revision: 'r2' });
  jest.spyOn(dataService, 'removeSlackApp').mockResolvedValue(undefined);
  install.mockReset();
});
afterEach(() => jest.restoreAllMocks());

test('shows organization-specific callback URLs and installs the selected app', async () => {
  const user = userEvent.setup();
  page();
  await user.click(await screen.findByText('com_ui_slack_apps_callbacks'));
  expect(screen.getByLabelText('com_ui_slack_apps_events')).toHaveValue(
    'https://gateway.example/slack/events/org.a/A123',
  );
  expect(screen.getByLabelText('com_ui_slack_apps_interactions')).toHaveValue(
    'https://gateway.example/slack/interactions/org.a/A123',
  );
  const manifest = screen.getByLabelText('com_ui_channels_manifest') as HTMLTextAreaElement;
  expect(JSON.parse(manifest.value).settings.event_subscriptions.bot_events).toEqual(
    expect.arrayContaining(['app_uninstalled', 'tokens_revoked']),
  );
  await user.click(screen.getByRole('button', { name: 'com_ui_slack_workspaces_connect' }));
  expect(install).toHaveBeenCalledWith('A123');
});
test('replaces credentials with a revision fence and clears secrets after saving', async () => {
  const user = userEvent.setup();
  const { client } = page();
  await user.click(await screen.findByRole('button', { name: 'com_ui_slack_apps_update' }));
  expect(screen.getByLabelText('com_ui_slack_apps_app_id')).toBeDisabled();
  const secret = screen.getByLabelText('com_ui_slack_apps_client_secret');
  expect(secret).toHaveAttribute('type', 'password');
  await user.type(secret, 'private-client');
  await user.type(screen.getByLabelText('com_ui_slack_apps_signing_secret'), 'private-signing');
  await user.click(screen.getByRole('button', { name: 'com_ui_save' }));
  await screen.findByRole('status');
  expect(dataService.configureSlackApp).toHaveBeenCalledWith({
    appId: 'A123',
    clientId: '123.456',
    expectedRevision: 'r1',
    clientSecret: 'private-client',
    signingSecret: 'private-signing',
  });
  expect(screen.queryByLabelText('com_ui_slack_apps_client_secret')).not.toBeInTheDocument();
  expect(
    JSON.stringify(
      client
        .getMutationCache()
        .getAll()
        .map((m) => m.state.variables),
    ),
  ).not.toContain('private-');
});
test('requires confirmation and handles an in-use app without exposing remote details', async () => {
  jest.spyOn(dataService, 'removeSlackApp').mockRejectedValue({
    response: { data: { error: { code: 'workspace_in_use' }, private: 'secret-detail' } },
  });
  const user = userEvent.setup();
  page();
  await user.click(await screen.findByRole('button', { name: 'com_ui_slack_apps_remove' }));
  expect(dataService.removeSlackApp).not.toHaveBeenCalled();
  await user.click(screen.getAllByRole('button', { name: 'com_ui_slack_apps_remove' })[1]);
  await screen.findByRole('alert');
  await waitFor(() => expect(dataService.removeSlackApp).toHaveBeenCalledWith('A123', 'r1'));
  expect(screen.queryByText('secret-detail')).not.toBeInTheDocument();
});

test('failed registration retains no submitted secrets in mutation variables or errors', async () => {
  jest
    .spyOn(dataService, 'configureSlackApp')
    .mockImplementation(
      jest.requireActual('librechat-data-provider').dataService.configureSlackApp,
    );
  jest.spyOn(request, 'put').mockRejectedValue(
    Object.assign(new Error('private-provider-error'), {
      isAxiosError: true,
      config: {
        data: JSON.stringify({ clientSecret: 'private-client', signingSecret: 'private-signing' }),
      },
      response: { data: { error: { code: 'transactions_unavailable' } } },
    }),
  );
  const user = userEvent.setup();
  const { client } = page();
  await user.click(await screen.findByRole('button', { name: 'com_ui_slack_apps_update' }));
  await user.type(screen.getByLabelText('com_ui_slack_apps_client_secret'), 'private-client');
  await user.type(screen.getByLabelText('com_ui_slack_apps_signing_secret'), 'private-signing');
  await user.click(screen.getByRole('button', { name: 'com_ui_save' }));
  await screen.findByRole('alert');
  const mutations = client.getMutationCache().getAll();
  expect(mutations).toHaveLength(1);
  const error = mutations[0].state.error as Error;
  expect(error).toMatchObject({ code: 'transactions_unavailable' });
  expect(
    JSON.stringify({
      state: mutations[0].state,
      error: Object.fromEntries(
        Object.getOwnPropertyNames(error).map((key) => [key, error[key as keyof Error]]),
      ),
    }),
  ).not.toContain('private-');
});
