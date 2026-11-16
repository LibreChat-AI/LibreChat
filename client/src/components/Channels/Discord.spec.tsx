import React from 'react';
import userEvent from '@testing-library/user-event';
import { dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import type { DiscordApplication, DiscordGuild, DiscordConnect } from 'librechat-data-provider';
import { OAUTH_SETTLED_CHANNEL } from '~/data-provider/PullRequest/signIn';
import Discord, { DiscordSettings } from './Discord';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getDiscordApps: jest.fn(),
      getDiscordGuilds: jest.fn(),
      configureDiscordApplication: jest.fn(),
      connectDiscordGuild: jest.fn(),
      cancelDiscordInstall: jest.fn(),
      disconnectDiscordGuild: jest.fn(),
    },
  };
});
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAuthContext: () => ({ user: { id: 'admin', tenantId: 'org' } }),
}));
const app: DiscordApplication = {
  applicationId: '123456789012345678',
  botUserId: '223456789012345678',
  publicKey: 'a'.repeat(64),
  name: 'Engineering',
  revision: 'app-r1',
  createdBy: 'admin',
  authorityWrites: 0,
};
const guild: DiscordGuild = {
  applicationId: app.applicationId,
  installationId: 'installation-1',
  guildId: '323456789012345678',
  guildName: 'Developers',
  revision: 'guild-r1',
  createdBy: 'admin',
  authorityWrites: 0,
  status: 'active',
};
const connectResponse: DiscordConnect = {
  url: `https://discord.com/oauth2/authorize?client_id=${app.applicationId}`,
  flowId: 'this-flow',
  expiresInSeconds: 600,
};
const popup = { opener: null, closed: false, location: { href: '' }, close: jest.fn() };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function page() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <Discord userId="admin" tenantId="org" />
    </QueryClientProvider>,
  );
  await screen.findByText('Engineering');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'com_ui_discord_app_create' })).toBeEnabled(),
  );
  return { ...view, client, user: userEvent.setup() };
}
beforeEach(() => {
  jest.spyOn(dataService, 'getDiscordApps').mockResolvedValue({
    applications: [app],
    setup: { oauthCallbackUrl: 'https://chat.example/api/channels/discord/callback' },
  });
  jest.spyOn(dataService, 'getDiscordGuilds').mockResolvedValue({ guilds: [guild] });
  jest.spyOn(dataService, 'configureDiscordApplication').mockResolvedValue(app);
  jest.spyOn(dataService, 'connectDiscordGuild').mockResolvedValue(connectResponse);
  jest.spyOn(dataService, 'cancelDiscordInstall').mockResolvedValue(true);
  jest
    .spyOn(dataService, 'disconnectDiscordGuild')
    .mockResolvedValue({ ...guild, status: 'disconnected' });
  jest.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  popup.closed = false;
  popup.location.href = '';
  popup.close.mockClear();
});
afterEach(() => jest.restoreAllMocks());

test('loads independent metadata, server URLs and configuration-needed state', async () => {
  const apps = deferred<{ applications: DiscordApplication[] }>();
  jest.mocked(dataService.getDiscordApps).mockReturnValue(apps.promise);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Discord userId="admin" />
    </QueryClientProvider>,
  );
  expect(screen.getByRole('status')).toHaveTextContent('com_ui_channels_loading');
  expect(dataService.getDiscordGuilds).toHaveBeenCalled();
  await act(async () => apps.resolve({ applications: [] }));
  expect(await screen.findByText('com_ui_discord_empty')).toBeVisible();
  expect(screen.queryByLabelText('com_ui_discord_callback')).toBeNull();
});

test.each([403, 404])(
  'explains management authority status %s and retries without Slack',
  async (status) => {
    jest
      .mocked(dataService.getDiscordApps)
      .mockRejectedValueOnce(Object.assign(new Error('safe'), { status }));
    const client = new QueryClient({ logger: { log: () => {}, warn: () => {}, error: () => {} } });
    render(
      <QueryClientProvider client={client}>
        <Discord userId="admin" />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByText(status === 403 ? 'com_ui_discord_admin' : 'com_ui_discord_disabled'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'com_ui_discord_app_create' })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(await screen.findByText('Engineering')).toBeVisible();
  },
);

test('submits write-only rotation credentials without retaining them in mutation state', async () => {
  const pending = deferred<DiscordApplication>();
  let submitted: unknown;
  jest.mocked(dataService.configureDiscordApplication).mockImplementation((input) => {
    submitted = { ...input };
    return pending.promise;
  });
  const { user, client } = await page();
  expect(screen.getByLabelText('com_ui_discord_callback')).toHaveValue(
    'https://chat.example/api/channels/discord/callback',
  );
  expect(screen.getByText('com_ui_discord_ingress_required')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_rotate_named' }));
  expect(screen.getByLabelText('com_ui_discord_application_id')).toHaveAttribute('readonly');
  expect(screen.getByLabelText('com_ui_discord_bot_token')).toHaveFocus();
  await user.type(screen.getByLabelText('com_ui_discord_bot_token'), 'private-bot-token');
  await user.click(screen.getByRole('button', { name: 'com_ui_save' }));
  await waitFor(() =>
    expect(submitted).toEqual({
      applicationId: app.applicationId,
      name: 'Engineering',
      expectedRevision: 'app-r1',
      botToken: 'private-bot-token',
    }),
  );
  expect(screen.getByLabelText('com_ui_discord_bot_token')).toHaveValue('');
  expect(
    client
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state.variables),
  ).not.toContainEqual(expect.objectContaining({ botToken: expect.anything() }));
  await act(async () => pending.resolve(app));
  expect(await screen.findByText('com_ui_discord_saved')).toBeVisible();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'com_ui_discord_rotate_named' })).toHaveFocus(),
  );
});

test('requires both credentials for a new application and clears them on cancel', async () => {
  const { user } = await page();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_app_create' }));
  await user.type(screen.getByLabelText('com_ui_discord_application_id'), app.applicationId);
  await user.type(screen.getByLabelText('com_ui_discord_bot_token'), 'private-token');
  await user.click(screen.getByRole('button', { name: 'com_ui_save' }));
  expect(dataService.configureDiscordApplication).not.toHaveBeenCalled();
  expect(screen.getByLabelText('com_ui_discord_client_secret')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await user.click(screen.getByRole('button', { name: 'com_ui_cancel' }));
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_app_create' }));
  expect(screen.getByLabelText('com_ui_discord_bot_token')).toHaveValue('');
});

test('cancels an attempt whose creation response arrives after cancellation', async () => {
  const pending = deferred<DiscordConnect>();
  jest.mocked(dataService.connectDiscordGuild).mockReturnValue(pending.promise);
  const { user } = await page();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_connect_named' }));
  await user.click(screen.getByRole('button', { name: 'com_ui_cancel' }));
  expect(popup.close).toHaveBeenCalled();
  await act(async () => pending.resolve(connectResponse));
  await waitFor(() => expect(dataService.cancelDiscordInstall).toHaveBeenCalledWith('this-flow'));
  expect(popup.location.href).toBe('');
  await waitFor(() => expect(screen.queryByText('com_ui_discord_pending')).toBeNull());
});

test('reconnects the exact installation and ignores unrelated callback messages', async () => {
  const { user } = await page();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_reconnect_named' }));
  await waitFor(() => expect(popup.location.href).toBe(connectResponse.url));
  expect(dataService.connectDiscordGuild).toHaveBeenCalledWith(
    app.applicationId,
    guild.installationId,
  );
  act(() =>
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: OAUTH_SETTLED_CHANNEL,
        newValue: JSON.stringify({ outcome: 'succeeded', flowId: 'other-flow' }),
      }),
    ),
  );
  expect(screen.getByText('com_ui_discord_pending')).toBeVisible();
  act(() =>
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: OAUTH_SETTLED_CHANNEL,
        newValue: JSON.stringify({ outcome: 'succeeded', flowId: 'this-flow' }),
      }),
    ),
  );
  await waitFor(() => expect(screen.queryByText('com_ui_discord_pending')).toBeNull());
  expect(dataService.getDiscordGuilds).toHaveBeenCalledTimes(3);
});

test('retains failed cancellation for retry and treats expiry as reconciliation', async () => {
  jest
    .mocked(dataService.cancelDiscordInstall)
    .mockRejectedValueOnce(new Error('network'))
    .mockRejectedValueOnce(Object.assign(new Error('expired'), { code: 'invalid_state' }));
  const { user } = await page();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_connect_named' }));
  await waitFor(() => expect(popup.location.href).toBe(connectResponse.url));
  await user.click(screen.getByRole('button', { name: 'com_ui_cancel' }));
  expect(await screen.findByText('com_ui_discord_unconfirmed')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'com_ui_cancel' }));
  await waitFor(() => expect(screen.queryByText('com_ui_discord_unconfirmed')).toBeNull());
  expect(dataService.cancelDiscordInstall).toHaveBeenCalledTimes(2);
});

test('retires an unmounted flow when a late response arrives', async () => {
  const pending = deferred<DiscordConnect>();
  jest.mocked(dataService.connectDiscordGuild).mockReturnValue(pending.promise);
  const { user, unmount } = await page();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_connect_named' }));
  unmount();
  await act(async () => pending.resolve(connectResponse));
  expect(dataService.cancelDiscordInstall).toHaveBeenCalledWith(connectResponse.flowId);
  expect(popup.location.href).toBe('');
});

test('rejects an unexpected authorization origin and handles blocked popups', async () => {
  jest
    .mocked(dataService.connectDiscordGuild)
    .mockResolvedValue({ ...connectResponse, url: 'https://evil.example/authorize' });
  const { user } = await page();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_connect_named' }));
  expect(await screen.findByText('com_ui_discord_unconfirmed')).toBeVisible();
  expect(popup.location.href).toBe('');
  expect(dataService.cancelDiscordInstall).toHaveBeenCalledWith(connectResponse.flowId);
  await user.click(screen.getByRole('button', { name: 'com_ui_cancel' }));
  jest.mocked(window.open).mockReturnValue(null);
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_connect_named' }));
  expect(screen.getByText('com_ui_discord_unconfirmed')).toBeVisible();
  expect(dataService.connectDiscordGuild).toHaveBeenCalledTimes(1);
});

test('confirms disconnect with revision and keeps failed canonical reads disabled', async () => {
  const { user } = await page();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_disconnect_named' }));
  const dialog = screen.getByRole('alertdialog', { name: 'com_ui_discord_disconnect' });
  expect(within(dialog).getByRole('button', { name: 'com_ui_cancel' })).toHaveFocus();
  jest.mocked(dataService.getDiscordGuilds).mockRejectedValue(new Error('network'));
  await user.click(within(dialog).getByRole('button', { name: 'com_ui_discord_disconnect' }));
  await waitFor(() =>
    expect(dataService.disconnectDiscordGuild).toHaveBeenCalledWith(
      guild.installationId,
      guild.revision,
    ),
  );
  expect(await screen.findByText('com_ui_discord_error')).toBeVisible();
  expect(screen.getByRole('button', { name: 'com_ui_discord_connect_named' })).toBeDisabled();
});

test('retries a failed next cursor without refetching the loaded prefix', async () => {
  jest
    .mocked(dataService.getDiscordApps)
    .mockResolvedValueOnce({ applications: [app], next: 'cursor/a' })
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce({
      applications: [{ ...app, applicationId: '423456789012345678', name: 'Support' }],
    });
  const { user } = await page();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_more_apps' }));
  expect(await screen.findByText('com_ui_discord_error')).toBeVisible();
  expect(screen.getByText('Engineering')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'com_ui_retry' }));
  expect(await screen.findByText('Support')).toBeVisible();
  expect(jest.mocked(dataService.getDiscordApps).mock.calls.map(([cursor]) => cursor)).toEqual([
    undefined,
    'cursor/a',
    'cursor/a',
  ]);
});

test('returns keyboard focus to the settings entry after Escape', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={client}>
      <DiscordSettings />
    </QueryClientProvider>,
  );
  const trigger = screen.getByRole('button', { name: 'com_ui_discord_title' });
  await user.click(trigger);
  expect(await screen.findByRole('dialog', { name: 'com_ui_discord_title' })).toBeVisible();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(trigger).toHaveFocus());
});

test('refreshes an uncertain credential update before reopening a current revision', async () => {
  jest
    .mocked(dataService.configureDiscordApplication)
    .mockRejectedValueOnce(Object.assign(new Error('safe'), { code: 'application_changed' }));
  const { user } = await page();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_rotate_named' }));
  await user.type(screen.getByLabelText('com_ui_discord_bot_token'), 'private-token');
  jest
    .mocked(dataService.getDiscordApps)
    .mockResolvedValue({ applications: [{ ...app, revision: 'app-r2' }] });
  await user.click(screen.getByRole('button', { name: 'com_ui_save' }));
  expect(await screen.findByText('com_ui_discord_changed')).toBeVisible();
  await waitFor(() => expect(screen.getByRole('button', { name: 'com_ui_refresh' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'com_ui_refresh' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'com_ui_discord_rotate_named' })).toBeEnabled(),
  );
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_rotate_named' }));
  expect(screen.getByLabelText('com_ui_discord_bot_token')).toHaveValue('');
  await user.type(screen.getByLabelText('com_ui_discord_bot_token'), 'replacement-token');
  await user.click(screen.getByRole('button', { name: 'com_ui_save' }));
  await waitFor(() =>
    expect(jest.mocked(dataService.configureDiscordApplication).mock.calls[1][0]).toMatchObject({
      expectedRevision: 'app-r2',
    }),
  );
});
