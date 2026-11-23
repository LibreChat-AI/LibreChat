import React from 'react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dataService, QueryKeys, request } from 'librechat-data-provider';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
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

const mockCopy = jest.fn();

jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: { id: 'admin', tenantId: 'org.a' } }),
  useLocalize: () => (key: string, values?: { 0?: string }) =>
    (key.endsWith('_named') || key === 'com_ui_slack_apps_copy_setting') && values?.[0]
      ? `${key}: ${values[0]}`
      : key,
  useCopyToClipboard:
    ({ text }: { text: string }) =>
    () =>
      mockCopy(text),
}));
const registration = { appId: 'A123', clientId: '123.456', revision: 'r1' };
const install = jest.fn();
function page(props: Partial<ComponentProps<typeof Apps>> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <Apps principalKey="org.a:admin" busy={false} onInstall={install} {...props} />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

async function action(name: string) {
  await screen.findByText('A123');
  const key =
    name === 'com_ui_slack_apps_update'
      ? 'com_ui_slack_apps_edit_named'
      : 'com_ui_slack_apps_remove_named';
  return screen.findByRole('button', { name: new RegExp(`^${key}:`) });
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
  mockCopy.mockReset();
});
afterEach(() => jest.restoreAllMocks());

test('shows only scoped connection URLs without a generated Slack manifest', async () => {
  const user = userEvent.setup();
  page();
  await user.click(await screen.findByRole('button', { name: /A123/, expanded: false }));
  expect(screen.queryByText('com_ui_slack_apps_settings')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('com_ui_slack_apps_events')).not.toBeInTheDocument();
  const settings = await screen.findByRole('button', {
    name: 'com_ui_slack_apps_connection_settings_named: A123',
  });
  await user.click(settings);
  const dialog = screen.getByRole('dialog', { name: 'com_ui_slack_apps_connection_settings' });
  expect(within(dialog).getByLabelText('com_ui_slack_apps_redirect')).toHaveValue(
    'https://chat.example/api/channels/workspaces/oauth/callback',
  );
  const events = within(dialog).getByLabelText('com_ui_slack_apps_events');
  expect(events).toHaveValue('https://gateway.example/slack/events/org.a/A123');
  expect(events).toHaveAttribute('readOnly');
  expect(within(dialog).getByLabelText('com_ui_slack_apps_interactions')).toHaveValue(
    'https://gateway.example/slack/interactions/org.a/A123',
  );
  expect(
    within(dialog).queryByLabelText('com_ui_slack_apps_manifest_json'),
  ).not.toBeInTheDocument();
  await user.click(
    within(dialog).getByRole('button', {
      name: 'com_ui_slack_apps_copy_setting: com_ui_slack_apps_events',
    }),
  );
  expect(mockCopy).toHaveBeenCalledWith('https://gateway.example/slack/events/org.a/A123');
  expect(
    within(dialog).queryByRole('button', { name: 'com_ui_channels_manifest' }),
  ).not.toBeInTheDocument();
  expect(within(dialog).getByRole('link', { name: 'com_ui_slack_apps_dashboard' })).toHaveAttribute(
    'href',
    'https://api.slack.com/apps',
  );
  await user.click(within(dialog).getByRole('button', { name: 'com_ui_close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(settings).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'com_ui_slack_workspaces_connect' }));
  expect(install).toHaveBeenCalledWith('A123');
});
test('edits credentials with a revision fence and clears secrets after saving', async () => {
  const user = userEvent.setup();
  const { client } = page();
  const edit = await action('com_ui_slack_apps_update');
  expect(screen.getByRole('button', { name: /^com_ui_slack_apps_remove_named:/ })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'com_ui_more_options' })).not.toBeInTheDocument();
  await user.click(edit);
  expect(screen.getByLabelText('com_ui_slack_apps_app_id')).toBeDisabled();
  const secret = screen.getByLabelText(/com_ui_slack_apps_client_secret/);
  expect(secret).toHaveAttribute('type', 'password');
  await user.type(secret, 'private-client');
  await user.type(screen.getByLabelText(/com_ui_slack_apps_signing_secret/), 'private-signing');
  await user.click(screen.getByRole('button', { name: 'com_ui_save' }));
  await screen.findByRole('status');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(dataService.configureSlackApp).toHaveBeenCalledWith({
    appId: 'A123',
    clientId: '123.456',
    expectedRevision: 'r1',
    name: '',
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
  await user.click(await action('com_ui_slack_apps_remove'));
  expect(dataService.removeSlackApp).not.toHaveBeenCalled();
  const dialog = screen.getByRole('dialog', { name: 'com_ui_slack_apps_remove_title' });
  expect(within(dialog).getByText('A123')).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'com_ui_slack_apps_remove' }));
  await screen.findByRole('alert');
  await waitFor(() => expect(dataService.removeSlackApp).toHaveBeenCalledWith('A123', 'r1'));
  expect(screen.queryByText('secret-detail')).not.toBeInTheDocument();
  expect(within(dialog).getByRole('alert')).toBeInTheDocument();
  expect(dialog).toBeInTheDocument();
  jest.spyOn(dataService, 'removeSlackApp').mockResolvedValue(undefined);
  await user.click(within(dialog).getByRole('button', { name: 'com_ui_slack_apps_remove' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(dataService.removeSlackApp).toHaveBeenCalledTimes(2);
});

test('cancels removal and returns focus to its trigger', async () => {
  const user = userEvent.setup();
  page();
  const trigger = await action('com_ui_slack_apps_remove');
  await user.click(trigger);
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /cancel/i }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(dataService.removeSlackApp).not.toHaveBeenCalled();
  expect(trigger).toHaveFocus();
});

test('prevents dismissal and repeated submission while removing, then updates the list', async () => {
  let finish!: () => void;
  jest.spyOn(dataService, 'removeSlackApp').mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const user = userEvent.setup();
  page();
  await user.click(await action('com_ui_slack_apps_remove'));
  const dialog = screen.getByRole('dialog');
  const remove = within(dialog).getByRole('button', { name: 'com_ui_slack_apps_remove' });
  await user.click(remove);
  expect(remove).toBeDisabled();
  expect(remove).toHaveAttribute('aria-busy', 'true');
  expect(within(dialog).getByRole('button', { name: /cancel/i })).toBeDisabled();
  await user.keyboard('{Escape}');
  expect(dialog).toBeInTheDocument();
  await user.click(remove);
  expect(dataService.removeSlackApp).toHaveBeenCalledTimes(1);
  jest
    .spyOn(dataService, 'getSlackApps')
    .mockResolvedValue({ configured: true, canManage: true, apps: [] });
  await act(async () => finish());
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.queryByText('A123')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'com_ui_slack_apps_title' })).toHaveFocus();
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
  await user.click(await action('com_ui_slack_apps_update'));
  await user.type(screen.getByLabelText(/com_ui_slack_apps_client_secret/), 'private-client');
  await user.type(screen.getByLabelText(/com_ui_slack_apps_signing_secret/), 'private-signing');
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

const workspace = {
  workspaceId: 'workspace-1',
  appId: 'A123',
  teamId: 'T123',
  teamName: 'Engineering',
  botUserId: 'U123',
  revision: 'r1',
  status: 'active' as const,
  scopes: [],
};

test('groups workspaces by app and expands only search matches', async () => {
  const user = userEvent.setup();
  jest.spyOn(dataService, 'getSlackApps').mockResolvedValue({
    configured: true,
    canManage: true,
    apps: [registration, { ...registration, appId: 'A456' }],
  });
  page({
    workspaces: [
      workspace,
      { ...workspace, workspaceId: 'design', teamName: 'Design' },
      { ...workspace, appId: 'A456', workspaceId: 'support', teamName: 'Support' },
    ],
    renderWorkspace: (value) => <p key={value.workspaceId}>{value.teamName}</p>,
  });
  const first = await screen.findByRole('button', { name: /A123/, expanded: false });
  expect(first).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText('Engineering')).not.toBeInTheDocument();
  await user.click(first);
  expect(screen.getByText('Engineering')).toBeInTheDocument();
  expect(screen.getByText('Design')).toBeInTheDocument();
  expect(screen.queryByText('Support')).not.toBeInTheDocument();
  await user.type(screen.getByRole('textbox', { name: 'com_ui_slack_search' }), 'Engineering');
  expect(screen.getByText('Engineering')).toBeInTheDocument();
  expect(screen.queryByText('Design')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /A456/ })).not.toBeInTheDocument();
});

test('retains workspace-only groups without requesting admin app metadata', async () => {
  const user = userEvent.setup();
  page({
    canManage: false,
    workspaces: [workspace],
    renderWorkspace: (value) => <p key={value.workspaceId}>{value.teamName}</p>,
  });
  await user.click(await screen.findByRole('button', { name: /A123/, expanded: false }));
  expect(screen.getByText('Engineering')).toBeInTheDocument();
  expect(dataService.getSlackApps).not.toHaveBeenCalled();
  expect(
    screen.queryByRole('button', { name: /^com_ui_slack_apps_connection_settings_named:/ }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'com_ui_slack_apps_add' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'com_ui_more_options' })).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /^com_ui_slack_apps_edit_named:/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /^com_ui_slack_apps_remove_named:/ }),
  ).not.toBeInTheDocument();
});

test('uses authorized workspace app names for manager display and search without admin metadata', async () => {
  const user = userEvent.setup();
  page({
    canManage: false,
    workspaces: [
      { ...workspace, appName: 'Support Bot' },
      { ...workspace, appId: 'A456', workspaceId: 'other', appName: 'Other Bot' },
    ],
    renderWorkspace: (value) => <p key={value.workspaceId}>{value.teamName}</p>,
  });
  const group = await screen.findByRole('button', { name: /Support Bot.*A123/, expanded: false });
  const search = screen.getByRole('textbox', { name: 'com_ui_slack_search' });
  await user.type(search, 'support');
  expect(group).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('Engineering')).toBeVisible();
  expect(screen.queryByRole('button', { name: /A456/ })).not.toBeInTheDocument();
  expect(dataService.getSlackApps).not.toHaveBeenCalled();
  expect(
    screen.queryByRole('button', { name: /^com_ui_slack_apps_edit_named:/ }),
  ).not.toBeInTheDocument();
  await user.clear(search);
  await user.type(search, 'unknown');
  expect(screen.getByText('com_ui_slack_search_empty')).toBeVisible();
  expect(screen.queryByRole('button', { name: /A123/ })).not.toBeInTheDocument();
});

test('displays and searches friendly app names while retaining their IDs', async () => {
  const user = userEvent.setup();
  jest.spyOn(dataService, 'getSlackApps').mockResolvedValue({
    configured: true,
    canManage: true,
    apps: [
      { ...registration, name: 'Support Bot' },
      { ...registration, appId: 'A456', name: 'Engineering Bot' },
    ],
  });
  page({
    workspaces: [workspace],
    renderWorkspace: (value) => <p key={value.workspaceId}>{value.teamName}</p>,
  });
  const group = await screen.findByRole('button', { name: /Support Bot.*A123/, expanded: false });
  expect(
    screen.getByRole('button', { name: 'com_ui_slack_apps_edit_named: Support Bot (A123)' }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'com_ui_slack_apps_remove_named: Engineering Bot (A456)' }),
  ).toBeInTheDocument();
  expect(group).toHaveAccessibleName(/A123/);
  await user.type(screen.getByRole('textbox', { name: 'com_ui_slack_search' }), 'support');
  expect(group).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('Engineering')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /A456/ })).not.toBeInTheDocument();
});

test('saves a trimmed friendly name without resubmitting unchanged secrets', async () => {
  const user = userEvent.setup();
  const saved = { ...registration, name: 'Support Bot', revision: 'r2' };
  const list = jest.spyOn(dataService, 'getSlackApps');
  jest.spyOn(dataService, 'configureSlackApp').mockImplementation(async () => {
    list.mockResolvedValue({ configured: true, canManage: true, apps: [saved] });
    return saved;
  });
  page();
  await user.click(await action('com_ui_slack_apps_update'));
  const name = screen.getByRole('textbox', { name: /com_ui_name/ });
  await user.type(name, '  Support Bot  ');
  expect(name).toHaveValue('  Support Bot  ');
  expect(name).toHaveAttribute('maxLength', '100');
  expect(screen.getByLabelText(/com_ui_slack_apps_client_secret/)).not.toBeRequired();
  expect(screen.getByLabelText(/com_ui_slack_apps_signing_secret/)).not.toBeRequired();
  await user.click(screen.getByRole('button', { name: 'com_ui_save' }));
  await screen.findByRole('button', { name: /Support Bot.*A123/, expanded: true });
  expect(dataService.configureSlackApp).toHaveBeenCalledWith({
    appId: 'A123',
    clientId: '123.456',
    expectedRevision: 'r1',
    name: 'Support Bot',
  });
});

test('clears the optional name and falls back to the app ID', async () => {
  const user = userEvent.setup();
  const named = { ...registration, name: 'Support Bot' };
  const list = jest.spyOn(dataService, 'getSlackApps').mockResolvedValue({
    configured: true,
    canManage: true,
    apps: [named],
  });
  jest.spyOn(dataService, 'configureSlackApp').mockImplementation(async () => {
    list.mockResolvedValue({ configured: true, canManage: true, apps: [registration] });
    return registration;
  });
  page();
  await user.click(await action('com_ui_slack_apps_update'));
  await user.clear(screen.getByRole('textbox', { name: /com_ui_name/ }));
  await user.click(screen.getByRole('button', { name: 'com_ui_save' }));
  await waitFor(() => expect(screen.queryByText('Support Bot')).not.toBeInTheDocument());
  expect(
    screen.getByRole('button', { name: /com_ui_slack_app.*A123/, expanded: true }),
  ).toBeInTheDocument();
  expect(dataService.configureSlackApp).toHaveBeenCalledWith({
    appId: 'A123',
    clientId: '123.456',
    expectedRevision: 'r1',
    name: '',
  });
});

test('requires secrets for new apps and a new client secret when changing the client ID', async () => {
  const user = userEvent.setup();
  page();
  await user.click(await screen.findByRole('button', { name: 'com_ui_slack_apps_add' }));
  expect(screen.getByRole('textbox', { name: /com_ui_name/ })).not.toBeRequired();
  expect(screen.getByLabelText(/com_ui_slack_apps_client_secret/)).toBeRequired();
  expect(screen.getByLabelText(/com_ui_slack_apps_signing_secret/)).toBeRequired();
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /cancel/i }));
  await user.click(await action('com_ui_slack_apps_update'));
  await user.clear(screen.getByLabelText('com_ui_slack_apps_client_id'));
  await user.type(screen.getByLabelText('com_ui_slack_apps_client_id'), '123.789');
  expect(screen.getByLabelText(/com_ui_slack_apps_client_secret/)).toBeRequired();
  expect(screen.getByLabelText(/com_ui_slack_apps_signing_secret/)).not.toBeRequired();
});

test('marks stored secrets as set without revealing them and only toggles new input', async () => {
  const user = userEvent.setup();
  page();
  await user.click(await action('com_ui_slack_apps_update'));
  const dialog = screen.getByRole('dialog');
  const clientSecret = within(dialog).getByLabelText(/com_ui_slack_apps_client_secret/);
  const signingSecret = within(dialog).getByLabelText(/com_ui_slack_apps_signing_secret/);
  expect(clientSecret).toHaveAccessibleName('com_ui_slack_apps_client_secret (com_ui_set)');
  expect(signingSecret).toHaveAccessibleName('com_ui_slack_apps_signing_secret (com_ui_set)');
  expect(within(dialog).getAllByText('com_ui_set')).toHaveLength(2);
  expect(clientSecret).toHaveAttribute('placeholder', '••••••••');
  expect(signingSecret).toHaveAttribute('placeholder', '••••••••');
  expect(clientSecret).toHaveValue('');
  expect(signingSecret).toHaveValue('');
  expect(clientSecret).toHaveAttribute('autoComplete', 'new-password');
  expect(signingSecret).toHaveAttribute('autoComplete', 'new-password');
  const field = clientSecret.parentElement!;
  await user.click(within(field).getByRole('button', { name: 'Show secret' }));
  expect(clientSecret).toHaveAttribute('type', 'text');
  expect(clientSecret).toHaveValue('');
  await user.type(clientSecret, 'new-client-secret');
  await user.click(within(field).getByRole('button', { name: 'Hide secret' }));
  expect(clientSecret).toHaveAttribute('type', 'password');
  expect(clientSecret).toHaveValue('new-client-secret');
  expect(signingSecret).toHaveValue('');
});

test('marks a new app’s unsaved secrets as unset', async () => {
  const user = userEvent.setup();
  page();
  await user.click(await screen.findByRole('button', { name: 'com_ui_slack_apps_add' }));
  const dialog = screen.getByRole('dialog');
  const clientSecret = within(dialog).getByLabelText(/com_ui_slack_apps_client_secret/);
  const signingSecret = within(dialog).getByLabelText(/com_ui_slack_apps_signing_secret/);
  expect(clientSecret).toHaveAccessibleName('com_ui_slack_apps_client_secret (com_ui_unset)');
  expect(signingSecret).toHaveAccessibleName('com_ui_slack_apps_signing_secret (com_ui_unset)');
  expect(clientSecret).not.toHaveAttribute('placeholder');
  expect(signingSecret).not.toHaveAttribute('placeholder');
  expect(screen.queryByText('com_ui_slack_apps_hint')).not.toBeInTheDocument();
  const settings = within(dialog).getByRole('link', { name: 'com_ui_slack_apps_dashboard' });
  expect(settings).toHaveAttribute('href', 'https://api.slack.com/apps');
  expect(
    signingSecret.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(within(dialog).getAllByText('com_ui_unset')).toHaveLength(2);
  await user.type(clientSecret, 'new-client-secret');
  expect(clientSecret).toHaveAccessibleName('com_ui_slack_apps_client_secret (com_ui_unset)');
  expect(clientSecret).toHaveValue('new-client-secret');
  expect(signingSecret).toHaveValue('');
});

test('saves only actual edits and resets dirty state when changes are undone', async () => {
  const user = userEvent.setup();
  jest.spyOn(dataService, 'getSlackApps').mockResolvedValue({
    configured: true,
    canManage: true,
    apps: [{ ...registration, name: 'Support Bot' }],
  });
  page();
  await user.click(await action('com_ui_slack_apps_update'));
  const save = screen.getByRole('button', { name: 'com_ui_save' });
  const name = screen.getByRole('textbox', { name: /com_ui_name/ });
  const secret = screen.getByLabelText(/com_ui_slack_apps_signing_secret/);
  expect(save).toBeDisabled();
  await user.type(name, '   ');
  expect(save).toBeDisabled();
  fireEvent.submit(name.closest('form')!);
  expect(dataService.configureSlackApp).not.toHaveBeenCalled();
  await user.clear(name);
  expect(save).toBeEnabled();
  await user.type(name, 'Support Bot');
  expect(save).toBeDisabled();
  await user.type(name, ' updated');
  expect(save).toBeEnabled();
  await user.clear(name);
  await user.type(name, 'Support Bot');
  expect(save).toBeDisabled();
  await user.type(secret, 'replacement-signing-secret');
  expect(save).toBeEnabled();
  await user.clear(secret);
  expect(save).toBeDisabled();
  const clientId = screen.getByLabelText('com_ui_slack_apps_client_id');
  await user.clear(clientId);
  await user.type(clientId, '123.789');
  expect(save).toBeEnabled();
  await user.clear(clientId);
  await user.type(clientId, registration.clientId);
  expect(save).toBeDisabled();
});

test('a signing-secret-only edit omits the untouched client secret', async () => {
  const user = userEvent.setup();
  page();
  await user.click(await action('com_ui_slack_apps_update'));
  await user.type(screen.getByLabelText(/com_ui_slack_apps_signing_secret/), 'replacement-signing');
  await user.click(screen.getByRole('button', { name: 'com_ui_save' }));
  await waitFor(() =>
    expect(dataService.configureSlackApp).toHaveBeenCalledWith({
      appId: 'A123',
      clientId: '123.456',
      name: '',
      expectedRevision: 'r1',
      signingSecret: 'replacement-signing',
    }),
  );
});

test('keeps app header controls independently keyboard accessible without toggling the disclosure', async () => {
  const user = userEvent.setup();
  page({
    workspaces: [workspace],
    renderWorkspace: (value) => <p key={value.workspaceId}>{value.teamName}</p>,
  });
  const trigger = await screen.findByRole('button', { name: /A123/, expanded: false });
  const edit = await screen.findByRole('button', { name: 'com_ui_slack_apps_edit_named: A123' });
  const remove = screen.getByRole('button', { name: 'com_ui_slack_apps_remove_named: A123' });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(trigger.contains(edit)).toBe(false);
  expect(trigger.contains(remove)).toBe(false);
  await user.click(edit);
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /cancel/i }));
  expect(edit).toHaveFocus();
  trigger.focus();
  await user.keyboard('{Enter}');
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('Engineering')).toBeInTheDocument();
  await user.tab();
  expect(edit).toHaveFocus();
  await user.tab();
  expect(remove).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(
    screen.getByRole('dialog', { name: 'com_ui_slack_apps_remove_title' }),
  ).toBeInTheDocument();
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /cancel/i }));
  expect(remove).toHaveFocus();
  trigger.focus();
  await user.keyboard(' ');
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test.each([
  ['empty', undefined],
  ['disconnected', 'disconnected'],
] as const)('allows the initial installation for an %s app', async (_name, status) => {
  const user = userEvent.setup();
  page({ workspaces: status ? [{ ...workspace, status }] : [] });
  await user.click(await screen.findByRole('button', { name: /A123/, expanded: false }));
  await user.click(screen.getByRole('button', { name: 'com_ui_slack_workspaces_connect' }));
  expect(install).toHaveBeenCalledWith('A123');
});

test.each([
  { workspaces: [{ ...workspace, status: 'active' as const }] },
  { workspaces: [], hasMoreWorkspaces: true },
])(
  'does not offer another installation when connected or workspace discovery is incomplete',
  async (props) => {
    const user = userEvent.setup();
    page(props);
    await user.click(await screen.findByRole('button', { name: /A123/, expanded: false }));
    expect(
      screen.queryByRole('button', { name: 'com_ui_slack_workspaces_connect' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'com_ui_slack_apps_connection_settings_named: A123' }),
    ).toBeEnabled();
    expect(install).not.toHaveBeenCalled();
  },
);

test('connection settings use the selected app and friendly name', async () => {
  const user = userEvent.setup();
  jest.spyOn(dataService, 'getSlackApps').mockResolvedValue({
    configured: true,
    canManage: true,
    apps: [registration, { ...registration, appId: 'A456', name: 'Support bot' }],
    setup: {
      redirectUri: 'https://chat.example/api/channels/workspaces/oauth/callback',
      eventsBaseUrl: 'https://gateway.example/slack/events',
      interactionsBaseUrl: 'https://gateway.example/slack/interactions',
    },
  });
  page();
  await user.click(await screen.findByRole('button', { name: /A456/, expanded: false }));
  await user.click(
    screen.getByRole('button', {
      name: 'com_ui_slack_apps_connection_settings_named: Support bot (A456)',
    }),
  );
  const dialog = screen.getByRole('dialog', { name: 'com_ui_slack_apps_connection_settings' });
  expect(dialog).toHaveAccessibleDescription('Support bot · A456');
  expect(within(dialog).getByLabelText('com_ui_slack_apps_events')).toHaveValue(
    'https://gateway.example/slack/events/org.a/A456',
  );
  expect(
    within(dialog).queryByLabelText('com_ui_slack_apps_manifest_json'),
  ).not.toBeInTheDocument();
});

test('adds an already configured app directly and closes without opening setup after saving', async () => {
  const user = userEvent.setup();
  const created = { appId: 'A999', clientId: '123.999', name: 'New bot', revision: 'created-r1' };
  const setup = {
    redirectUri: 'https://chat.example/api/channels/workspaces/oauth/callback',
    eventsBaseUrl: 'https://gateway.example/slack/events',
    interactionsBaseUrl: 'https://gateway.example/slack/interactions',
  };
  const list = jest.spyOn(dataService, 'getSlackApps');
  jest.spyOn(dataService, 'configureSlackApp').mockImplementation(async () => {
    list.mockResolvedValue({
      configured: true,
      canManage: true,
      apps: [registration, created],
      setup,
    });
    return created;
  });
  const { client } = page();
  const add = await screen.findByRole('button', { name: 'com_ui_slack_apps_add' });
  await user.click(add);
  expect(screen.getByLabelText('com_ui_slack_apps_app_id')).toBeInTheDocument();
  expect(screen.queryByLabelText('com_ui_slack_apps_manifest_json')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'com_ui_slack_apps_create_new' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'com_ui_continue' })).not.toBeInTheDocument();
  await user.type(screen.getByRole('textbox', { name: /com_ui_name/ }), 'New bot');
  await user.type(screen.getByLabelText('com_ui_slack_apps_app_id'), 'A999');
  await user.type(screen.getByLabelText('com_ui_slack_apps_client_id'), '123.999');
  await user.type(screen.getByLabelText(/com_ui_slack_apps_client_secret/), 'new-client-secret');
  await user.type(screen.getByLabelText(/com_ui_slack_apps_signing_secret/), 'new-signing-secret');
  await user.click(screen.getByRole('button', { name: 'com_ui_save' }));
  await screen.findByRole('status');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(dataService.configureSlackApp).toHaveBeenCalledWith({
    appId: 'A999',
    clientId: '123.999',
    name: 'New bot',
    expectedRevision: undefined,
    clientSecret: 'new-client-secret',
    signingSecret: 'new-signing-secret',
  });
  expect(screen.getByRole('button', { name: /New bot.*A999/, expanded: true })).toBeInTheDocument();
  expect(screen.queryByLabelText('com_ui_slack_apps_manifest_json')).not.toBeInTheDocument();
  await act(async () => {
    await client.invalidateQueries([QueryKeys.slackApps]);
  });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
