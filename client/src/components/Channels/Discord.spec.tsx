import React from 'react';
import userEvent from '@testing-library/user-event';
import { QueryKeys, dataService } from 'librechat-data-provider';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import type {
  DiscordApplicationPage,
  DiscordApplication,
  DiscordGuildPage,
  DiscordConnect,
  DiscordGuild,
} from 'librechat-data-provider';
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
      registerDiscordCommands: jest.fn(),
      connectDiscordGuild: jest.fn(),
      cancelDiscordInstall: jest.fn(),
      disconnectDiscordGuild: jest.fn(),
      listDiscordDmSelections: jest.fn(async () => ({ enabled: false, selections: [] })),
      channelIdentityClient: {
        ...actual.dataService.channelIdentityClient,
        list: jest.fn(async () => []),
      },
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
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function page({ configuration = true } = {}) {
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
  const user = userEvent.setup();
  // Configuration scenarios enter through the same disclosure as a person using the app.
  if (configuration) {
    for (const summary of screen.getAllByText('com_ui_discord_setup_details')) {
      await user.click(summary);
    }
  }
  return { ...view, client, user };
}
/** A rotation whose save is rejected, settled and ready to be dismissed with Refresh. */
async function failedSave() {
  jest
    .mocked(dataService.configureDiscordApplication)
    .mockRejectedValueOnce(Object.assign(new Error('safe'), { code: 'unsupported_installation' }));
  const view = await page();
  const trigger = screen.getByRole('button', { name: 'com_ui_discord_rotate_named' });
  await view.user.click(trigger);
  await view.user.type(screen.getByLabelText('com_ui_discord_bot_token'), 'private-bot-token');
  await view.user.click(screen.getByRole('button', { name: 'com_ui_save' }));
  expect(await screen.findByText('com_ui_discord_code_grant')).toBeVisible();
  await waitFor(() => expect(trigger).toBeEnabled());
  return { ...view, trigger };
}
beforeEach(() => {
  jest.spyOn(dataService, 'getDiscordApps').mockResolvedValue({
    applications: [app],
    setup: { oauthCallbackUrl: 'https://chat.example/api/channels/discord/callback' },
  });
  jest.spyOn(dataService, 'getDiscordGuilds').mockResolvedValue({ guilds: [guild] });
  jest.spyOn(dataService, 'configureDiscordApplication').mockResolvedValue(app);
  jest.spyOn(dataService, 'registerDiscordCommands').mockResolvedValue({
    applicationId: app.applicationId,
    commandId: '623456789012345678',
    providerVersion: '723456789012345678',
    manifestVersion: '2',
  });
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

test('hides server management from people without organization authority', async () => {
  jest
    .mocked(dataService.getDiscordApps)
    .mockRejectedValueOnce(Object.assign(new Error('safe'), { status: 403 }));
  const client = new QueryClient({ logger: { log: () => {}, warn: () => {}, error: () => {} } });
  render(
    <QueryClientProvider client={client}>
      <Discord userId="member" />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(dataService.getDiscordApps).toHaveBeenCalled());
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'com_ui_discord_app_create' })).toBeNull(),
  );
  expect(screen.queryByText('com_ui_discord_admin')).toBeNull();
});

test.each([404])(
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
  const trigger = screen.getByRole('button', { name: 'com_ui_manage' });
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

test('returns focus to the editor trigger only after the refresh settles', async () => {
  const { user, trigger } = await failedSave();
  const reads = deferred<{ applications: DiscordApplication[] }>();
  jest.mocked(dataService.getDiscordApps).mockReturnValueOnce(reads.promise);
  await user.click(screen.getByRole('button', { name: 'com_ui_refresh' }));
  await waitFor(() => expect(trigger).toBeDisabled());
  expect(trigger).not.toHaveFocus();
  expect(screen.getByRole('button', { name: 'com_ui_discord_app_create' })).toBeDisabled();
  expect(screen.queryByLabelText('com_ui_discord_bot_token')).toBeNull();
  await act(async () => reads.resolve({ applications: [{ ...app, revision: 'app-r2' }] }));
  await waitFor(() => expect(trigger).toBeEnabled());
  await waitFor(() => expect(trigger).toHaveFocus());
});

test('moves focus to the load failure when the refresh cannot reconcile, then back after a retry', async () => {
  const { user, trigger } = await failedSave();
  jest.mocked(dataService.getDiscordApps).mockRejectedValueOnce(new Error('network'));
  await user.click(screen.getByRole('button', { name: 'com_ui_refresh' }));
  const failure = (await screen.findByText('com_ui_discord_error')).closest(
    '[role="alert"]',
  ) as HTMLElement;
  await waitFor(() => expect(failure).toHaveFocus());
  expect(trigger).toBeDisabled();
  expect(trigger).not.toHaveFocus();
  await user.click(within(failure).getByRole('button', { name: 'com_ui_retry' }));
  await waitFor(() => expect(trigger).toBeEnabled());
  await waitFor(() => expect(trigger).toHaveFocus());
});

test('falls back to the applications heading when the refreshed list no longer has the trigger', async () => {
  const { user, trigger } = await failedSave();
  jest.mocked(dataService.getDiscordApps).mockResolvedValueOnce({ applications: [] });
  await user.click(screen.getByRole('button', { name: 'com_ui_refresh' }));
  await waitFor(() => expect(trigger).not.toBeInTheDocument());
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'com_ui_discord_apps' })).toHaveFocus(),
  );
});

test('does not move focus in the next account when the previous account refresh settles', async () => {
  const { user, trigger, client, rerender } = await failedSave();
  const reads = deferred<{ applications: DiscordApplication[] }>();
  jest.mocked(dataService.getDiscordApps).mockReturnValueOnce(reads.promise);
  await user.click(screen.getByRole('button', { name: 'com_ui_refresh' }));
  await waitFor(() => expect(dataService.getDiscordApps).toHaveBeenCalledTimes(3));
  expect(trigger).toBeDisabled();
  rerender(
    <QueryClientProvider client={client}>
      <Discord userId="next-admin" tenantId="other-org" />
    </QueryClientProvider>,
  );
  const next = await screen.findByRole('button', { name: 'com_ui_discord_rotate_named' });
  await waitFor(() => expect(next).toBeEnabled());
  await act(async () => reads.resolve({ applications: [app] }));
  expect(next).toBeEnabled();
  expect(next).not.toHaveFocus();
  expect(document.body).toHaveFocus();
});

const checkedAt = Date.UTC(2026, 10, 16, 7, 45, 12);
const observed = (credentialHealth: unknown) =>
  ({ ...app, credentialHealth }) as unknown as DiscordApplication;

test.each([
  ['valid', 'com_ui_discord_health_valid'],
  ['invalid', 'com_ui_discord_health_invalid'],
])('shows the %s bot token observation with its last checked time', async (state, key) => {
  jest
    .mocked(dataService.getDiscordApps)
    .mockResolvedValue({ applications: [observed({ state, checkedAt })] });
  await page();
  expect(screen.getByText(key)).toBeVisible();
  expect(screen.getByText('com_ui_discord_health_checked', { exact: false })).toBeVisible();
  const time = screen.getByText(new Date(checkedAt).toLocaleString());
  expect(time.tagName).toBe('TIME');
  expect(time).toHaveAttribute('datetime', new Date(checkedAt).toISOString());
});

test.each([
  ['absent', undefined],
  ['empty', {}],
  ['an unrecognized state', { state: 'degraded', checkedAt }],
  ['a missing time', { state: 'valid' }],
  ['a fractional time', { state: 'valid', checkedAt: 1.5 }],
  ['a negative time', { state: 'invalid', checkedAt: -1 }],
  ['a time outside the date range', { state: 'valid', checkedAt: Number.MAX_SAFE_INTEGER }],
  ['extra fields', { state: 'valid', checkedAt, probe: true }],
  ['a bare string', 'valid'],
  ['null', null],
])('shows unknown for %s without a time', async (_name, credentialHealth) => {
  jest
    .mocked(dataService.getDiscordApps)
    .mockResolvedValue({ applications: [observed(credentialHealth)] });
  await page();
  expect(screen.getByText('com_ui_discord_health_unknown')).toBeVisible();
  expect(screen.queryByText('com_ui_discord_health_valid')).toBeNull();
  expect(screen.queryByText('com_ui_discord_health_invalid')).toBeNull();
  expect(document.querySelector('time')).toBeNull();
});

test('replaces the observation once updated credentials are saved', async () => {
  jest
    .mocked(dataService.getDiscordApps)
    .mockResolvedValue({ applications: [observed({ state: 'invalid', checkedAt })] });
  const { user } = await page();
  expect(screen.getByText('com_ui_discord_health_invalid')).toBeVisible();
  const later = checkedAt + 3_600_000;
  jest.mocked(dataService.getDiscordApps).mockResolvedValue({
    applications: [{ ...observed({ state: 'valid', checkedAt: later }), revision: 'app-r2' }],
  });
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_rotate_named' }));
  await user.type(screen.getByLabelText('com_ui_discord_bot_token'), 'private-bot-token');
  await user.click(screen.getByRole('button', { name: 'com_ui_save' }));
  expect(await screen.findByText('com_ui_discord_health_valid')).toBeVisible();
  expect(screen.queryByText('com_ui_discord_health_invalid')).toBeNull();
  expect(screen.getByText(new Date(later).toLocaleString())).toHaveAttribute(
    'datetime',
    new Date(later).toISOString(),
  );
});

test('reconciles the observation when a failed save is dismissed with Refresh', async () => {
  jest
    .mocked(dataService.getDiscordApps)
    .mockResolvedValue({ applications: [observed({ state: 'valid', checkedAt })] });
  const { user, trigger } = await failedSave();
  expect(screen.getByText('com_ui_discord_health_valid')).toBeVisible();
  jest.mocked(dataService.getDiscordApps).mockResolvedValue({
    applications: [observed({ state: 'invalid', checkedAt: checkedAt + 1000 })],
  });
  await user.click(screen.getByRole('button', { name: 'com_ui_refresh' }));
  expect(await screen.findByText('com_ui_discord_health_invalid')).toBeVisible();
  expect(screen.queryByText('com_ui_discord_health_valid')).toBeNull();
  await waitFor(() => expect(trigger).toHaveFocus());
});

test('never shows the previous account observation to the next account', async () => {
  jest
    .mocked(dataService.getDiscordApps)
    .mockResolvedValue({ applications: [observed({ state: 'valid', checkedAt })] });
  const { client, rerender } = await page();
  expect(screen.getByText('com_ui_discord_health_valid')).toBeVisible();
  const next = deferred<{ applications: DiscordApplication[] }>();
  jest.mocked(dataService.getDiscordApps).mockReturnValueOnce(next.promise);
  rerender(
    <QueryClientProvider client={client}>
      <Discord userId="next-admin" tenantId="other-org" />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.queryByText('com_ui_discord_health_valid')).toBeNull());
  expect(document.querySelector('time')).toBeNull();
  await act(async () => next.resolve({ applications: [app] }));
  expect(await screen.findByText('com_ui_discord_health_unknown')).toBeVisible();
  expect(screen.queryByText('com_ui_discord_health_valid')).toBeNull();
});

type User = ReturnType<typeof userEvent.setup>;
type Dismissal = { origin: HTMLElement; dismiss: () => Promise<void> };
/** The reads that follow an operation have settled, so the next refetch is the dismissal's own. */
const readsSettled = () =>
  waitFor(() => expect(dataService.getDiscordApps).toHaveBeenCalledTimes(2));
async function failedCommand(user: User): Promise<Dismissal> {
  jest
    .mocked(dataService.registerDiscordCommands)
    .mockRejectedValueOnce(Object.assign(new Error('safe'), { code: 'rate_limited' }));
  const origin = screen.getByRole('button', { name: 'com_ui_discord_commands_named' });
  await user.click(origin);
  const alert = (await screen.findByText('com_ui_discord_rate_limited')).closest(
    '[role="alert"]',
  ) as HTMLElement;
  const refresh = within(alert).getByRole('button', { name: 'com_ui_refresh' });
  await waitFor(() => expect(refresh).toBeEnabled());
  await readsSettled();
  return { origin, dismiss: () => user.click(refresh) };
}
async function cancelledAuthorization(user: User): Promise<Dismissal> {
  const origin = screen.getByRole('button', { name: 'com_ui_discord_connect_named' });
  await user.click(origin);
  await waitFor(() => expect(popup.location.href).toBe(connectResponse.url));
  await readsSettled();
  const cancel = screen.getByRole('button', { name: 'com_ui_cancel' });
  return { origin, dismiss: () => user.click(cancel) };
}
async function failedAuthorization(user: User): Promise<Dismissal> {
  jest
    .mocked(dataService.connectDiscordGuild)
    .mockRejectedValueOnce(Object.assign(new Error('safe'), { code: 'application_changed' }));
  const origin = screen.getByRole('button', { name: 'com_ui_discord_connect_named' });
  await user.click(origin);
  const failure = (await screen.findByText('com_ui_discord_changed')).closest(
    '[role="alert"]',
  ) as HTMLElement;
  const refresh = within(failure).getByRole('button', { name: 'com_ui_refresh' });
  await waitFor(() => expect(refresh).toBeEnabled());
  await readsSettled();
  return {
    origin,
    dismiss: async () => {
      await user.click(refresh);
      await user.click(await screen.findByRole('button', { name: 'com_ui_cancel' }));
    },
  };
}
const dismissals: [string, (user: User) => Promise<Dismissal>][] = [
  ['a failed command registration', failedCommand],
  ['a cancelled authorization', cancelledAuthorization],
  ['a failed authorization', failedAuthorization],
];

test.each(dismissals)(
  'returns focus to the originating control only after %s settles',
  async (_name, arrange) => {
    const { user } = await page();
    const { origin, dismiss } = await arrange(user);
    const reads = deferred<{ applications: DiscordApplication[] }>();
    jest.mocked(dataService.getDiscordApps).mockReturnValueOnce(reads.promise);
    await dismiss();
    await waitFor(() => expect(origin).toBeDisabled());
    expect(origin).not.toHaveFocus();
    await act(async () => reads.resolve({ applications: [app] }));
    await waitFor(() => expect(origin).toBeEnabled());
    await waitFor(() => expect(origin).toHaveFocus());
  },
);

test.each(dismissals)(
  'moves focus to the load failure when the reads fail after %s, then back after a retry',
  async (_name, arrange) => {
    const { user } = await page();
    const { origin, dismiss } = await arrange(user);
    jest.mocked(dataService.getDiscordApps).mockRejectedValueOnce(new Error('network'));
    await dismiss();
    const failure = (await screen.findByText('com_ui_discord_error')).closest(
      '[role="alert"]',
    ) as HTMLElement;
    await waitFor(() => expect(failure).toHaveFocus());
    expect(origin).toBeDisabled();
    expect(origin).not.toHaveFocus();
    await user.click(within(failure).getByRole('button', { name: 'com_ui_retry' }));
    await waitFor(() => expect(origin).toBeEnabled());
    await waitFor(() => expect(origin).toHaveFocus());
  },
);

test.each(dismissals)(
  'falls back to the applications heading when the refreshed list no longer has the control after %s',
  async (_name, arrange) => {
    const { user } = await page();
    const { origin, dismiss } = await arrange(user);
    jest.mocked(dataService.getDiscordApps).mockResolvedValueOnce({ applications: [] });
    await dismiss();
    await waitFor(() => expect(origin).not.toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'com_ui_discord_apps' })).toHaveFocus(),
    );
  },
);

test.each(dismissals)(
  'does not move focus in the next account when the previous account settles after %s',
  async (_name, arrange) => {
    const { user, client, rerender } = await page();
    const { origin, dismiss } = await arrange(user);
    const reads = deferred<{ applications: DiscordApplication[] }>();
    jest.mocked(dataService.getDiscordApps).mockReturnValueOnce(reads.promise);
    await dismiss();
    await waitFor(() => expect(dataService.getDiscordApps).toHaveBeenCalledTimes(3));
    expect(origin).toBeDisabled();
    rerender(
      <QueryClientProvider client={client}>
        <Discord userId="next-admin" tenantId="other-org" />
      </QueryClientProvider>,
    );
    const next = await screen.findByRole('button', { name: 'com_ui_discord_connect_named' });
    await waitFor(() => expect(next).toBeEnabled());
    await act(async () => reads.resolve({ applications: [app] }));
    expect(next).toBeEnabled();
    expect(next).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  },
);

test('does not touch the document when the view unmounts before a command refresh settles', async () => {
  const { user, unmount } = await page();
  const { dismiss } = await failedCommand(user);
  const reads = deferred<{ applications: DiscordApplication[] }>();
  jest.mocked(dataService.getDiscordApps).mockReturnValueOnce(reads.promise);
  await dismiss();
  await waitFor(() => expect(dataService.getDiscordApps).toHaveBeenCalledTimes(3));
  unmount();
  await act(async () => reads.resolve({ applications: [app] }));
  expect(document.body).toHaveFocus();
});

test('keeps focus on a failed cancellation and restores it only once the retry succeeds', async () => {
  jest.mocked(dataService.cancelDiscordInstall).mockRejectedValueOnce(new Error('network'));
  const { user } = await page();
  const origin = screen.getByRole('button', { name: 'com_ui_discord_connect_named' });
  await user.click(origin);
  await waitFor(() => expect(popup.location.href).toBe(connectResponse.url));
  await user.click(screen.getByRole('button', { name: 'com_ui_cancel' }));
  const failed = (await screen.findByText('com_ui_discord_unconfirmed')).closest(
    '[role="alert"]',
  ) as HTMLElement;
  await waitFor(() => expect(failed).toHaveFocus());
  expect(origin).toBeDisabled();
  expect(origin).not.toHaveFocus();
  await user.click(within(failed).getByRole('button', { name: 'com_ui_cancel' }));
  await waitFor(() => expect(screen.queryByText('com_ui_discord_unconfirmed')).toBeNull());
  await waitFor(() => expect(origin).toBeEnabled());
  await waitFor(() => expect(origin).toHaveFocus());
});

test('returns focus to the reconnect control after a cancelled reconnection', async () => {
  const { user } = await page();
  const origin = screen.getByRole('button', { name: 'com_ui_discord_reconnect_named' });
  await user.click(origin);
  await waitFor(() => expect(popup.location.href).toBe(connectResponse.url));
  expect(dataService.connectDiscordGuild).toHaveBeenCalledWith(
    app.applicationId,
    guild.installationId,
  );
  await user.click(screen.getByRole('button', { name: 'com_ui_cancel' }));
  await waitFor(() => expect(screen.queryByText('com_ui_discord_pending')).toBeNull());
  await waitFor(() => expect(origin).toBeEnabled());
  await waitFor(() => expect(origin).toHaveFocus());
});

test('returns focus to the editor trigger when a failed save is dismissed after its editor was cancelled', async () => {
  const { user, trigger } = await failedSave();
  await user.click(screen.getByRole('button', { name: 'com_ui_cancel' }));
  await waitFor(() => expect(screen.queryByLabelText('com_ui_discord_bot_token')).toBeNull());
  await user.click(screen.getByRole('button', { name: 'com_ui_refresh' }));
  await waitFor(() => expect(screen.queryByText('com_ui_discord_code_grant')).toBeNull());
  await waitFor(() => expect(trigger).toBeEnabled());
  await waitFor(() => expect(trigger).toHaveFocus());
});

test('moves focus to the remaining authorization notice when a failed connection is dismissed', async () => {
  const { user } = await page();
  const { origin } = await failedAuthorization(user);
  await user.click(screen.getByRole('button', { name: 'com_ui_refresh' }));
  const remaining = (await screen.findByText('com_ui_discord_unconfirmed')).closest(
    '[role="alert"]',
  ) as HTMLElement;
  await waitFor(() => expect(remaining).toHaveFocus());
  expect(origin).toBeDisabled();
});

test('registers commands only after explicit action using current revision and metadata-only variables', async () => {
  const pending = deferred<{
    applicationId: string;
    commandId: string;
    providerVersion: string;
    manifestVersion: '2';
  }>();
  jest.mocked(dataService.registerDiscordCommands).mockReturnValueOnce(pending.promise);
  const { user, client } = await page();
  expect(dataService.registerDiscordCommands).not.toHaveBeenCalled();
  expect(screen.getByText('com_ui_discord_commands_help')).toBeVisible();
  const trigger = screen.getByRole('button', { name: 'com_ui_discord_commands_named' });
  await user.click(trigger);
  expect(await screen.findByText('com_ui_discord_commands_registering')).toBeVisible();
  expect(trigger).toHaveAttribute('aria-busy', 'true');
  expect(trigger).toBeDisabled();
  expect(screen.getByRole('button', { name: 'com_ui_discord_connect_named' })).toBeDisabled();
  const input = {
    applicationId: app.applicationId,
    expectedRevision: app.revision,
    manifestVersion: '2',
  };
  expect(dataService.registerDiscordCommands).toHaveBeenCalledWith(input);
  expect(
    client
      .getMutationCache()
      .getAll()
      .find((entry) => entry.options.mutationKey?.includes('commands'))?.state.variables,
  ).toEqual(input);
  await act(async () =>
    pending.resolve({
      applicationId: app.applicationId,
      commandId: '623456789012345678',
      providerVersion: '723456789012345678',
      manifestVersion: '2',
    }),
  );
  expect(await screen.findByText('com_ui_discord_commands_success')).toBeVisible();
  expect(
    client
      .getMutationCache()
      .getAll()
      .find((entry) => entry.options.mutationKey?.includes('commands'))?.state.data,
  ).toBeUndefined();
  await waitFor(() => expect(trigger).toBeEnabled());
  expect(dataService.getDiscordApps).toHaveBeenCalledTimes(2);
  expect(dataService.getDiscordGuilds).toHaveBeenCalledTimes(2);
});

test.each([
  ['application_changed', 'com_ui_discord_changed'],
  ['rate_limited', 'com_ui_discord_rate_limited'],
  ['provider_refused', 'com_ui_discord_refused'],
])('refetches and explicitly retries registration after safe failure %s', async (code, label) => {
  jest
    .mocked(dataService.registerDiscordCommands)
    .mockRejectedValueOnce(Object.assign(new Error('private provider payload'), { code }));
  const { user } = await page();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_commands_named' }));
  expect(await screen.findByText(label)).toBeVisible();
  expect(screen.queryByText(/private provider payload/)).toBeNull();
  expect(dataService.registerDiscordCommands).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'com_ui_discord_commands_named' })).toBeDisabled();
  jest
    .mocked(dataService.getDiscordApps)
    .mockResolvedValue({ applications: [{ ...app, revision: 'app-r2' }] });
  await user.click(await screen.findByRole('button', { name: 'com_ui_refresh' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'com_ui_discord_commands_named' })).toBeEnabled(),
  );
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_commands_named' }));
  await waitFor(() =>
    expect(jest.mocked(dataService.registerDiscordCommands).mock.calls[1][0]).toEqual({
      applicationId: app.applicationId,
      expectedRevision: 'app-r2',
      manifestVersion: '2',
    }),
  );
});

test.each([
  ['transactions_unavailable', 'com_ui_channels_transaction_required'],
  ['application_changed', 'com_ui_discord_changed'],
  ['installation_changed', 'com_ui_discord_changed'],
  ['provider_refused', 'com_ui_discord_refused'],
  ['unsupported_installation', 'com_ui_discord_code_grant'],
  ['application_in_use', 'com_ui_discord_in_use'],
  ['rate_limited', 'com_ui_discord_rate_limited'],
  ['provider_unavailable', 'com_ui_discord_provider_unavailable'],
  ['timeout', 'com_ui_discord_timeout'],
])('explains safe code %s with its own state instead of the generic one', async (code, label) => {
  jest
    .mocked(dataService.registerDiscordCommands)
    .mockRejectedValueOnce(Object.assign(new Error('private provider payload'), { code }));
  const { user } = await page();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_commands_named' }));
  expect(await screen.findByText(label)).toBeVisible();
  expect(screen.queryByText('com_ui_discord_error')).toBeNull();
  expect(screen.queryByText(/private provider payload/)).toBeNull();
});

test.each(['unavailable', 'unrecognized_code'])(
  'keeps the generic unconfirmed state for the %s code',
  async (code) => {
    jest
      .mocked(dataService.registerDiscordCommands)
      .mockRejectedValueOnce(Object.assign(new Error('private provider payload'), { code }));
    const { user } = await page();
    await user.click(screen.getByRole('button', { name: 'com_ui_discord_commands_named' }));
    expect(await screen.findByText('com_ui_discord_error')).toBeVisible();
    expect(screen.queryByText(/private provider payload/)).toBeNull();
  },
);

test.each([
  [403, 'com_ui_discord_admin'],
  [404, 'com_ui_discord_disabled'],
])('keeps HTTP status %s ahead of a provider code', async (status, label) => {
  jest.mocked(dataService.registerDiscordCommands).mockRejectedValueOnce(
    Object.assign(new Error('private provider payload'), {
      status,
      code: 'provider_refused',
    }),
  );
  const { user } = await page();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_commands_named' }));
  expect(await screen.findByText(label)).toBeVisible();
  expect(screen.queryByText('com_ui_discord_refused')).toBeNull();
});

test.each([
  ['provider_refused', 'com_ui_discord_refused'],
  ['unsupported_installation', 'com_ui_discord_code_grant'],
  ['application_in_use', 'com_ui_discord_in_use'],
])('explains %s after a credential save without echoing the credential', async (code, label) => {
  jest
    .mocked(dataService.configureDiscordApplication)
    .mockRejectedValueOnce(Object.assign(new Error('Bot private-bot-token refused'), { code }));
  const { user } = await page();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_rotate_named' }));
  await user.type(screen.getByLabelText('com_ui_discord_bot_token'), 'private-bot-token');
  await user.click(screen.getByRole('button', { name: 'com_ui_save' }));
  expect(await screen.findByText(label)).toBeVisible();
  expect(screen.queryByText('com_ui_discord_error')).toBeNull();
  expect(screen.queryByText(/private-bot-token/)).toBeNull();
  expect(screen.getByLabelText('com_ui_discord_bot_token')).toHaveValue('');
  expect(await screen.findByRole('button', { name: 'com_ui_refresh' })).toBeVisible();
});

test('moves focus to a failed save so a scrolled form cannot hide it', async () => {
  jest
    .mocked(dataService.configureDiscordApplication)
    .mockRejectedValueOnce(Object.assign(new Error('safe'), { code: 'unsupported_installation' }));
  const { user } = await page();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_rotate_named' }));
  await user.type(screen.getByLabelText('com_ui_discord_bot_token'), 'private-bot-token');
  await user.click(screen.getByRole('button', { name: 'com_ui_save' }));
  const alert = (await screen.findByText('com_ui_discord_code_grant')).closest('[role="alert"]');
  await waitFor(() => expect(alert).toHaveFocus());
  expect(
    within(alert as HTMLElement).getByRole('button', { name: 'com_ui_refresh' }),
  ).toBeVisible();
});

test('moves focus to a failed command registration beside its application', async () => {
  jest
    .mocked(dataService.registerDiscordCommands)
    .mockRejectedValueOnce(Object.assign(new Error('safe'), { code: 'rate_limited' }));
  const { user } = await page();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_commands_named' }));
  const alert = (await screen.findByText('com_ui_discord_rate_limited')).closest('[role="alert"]');
  await waitFor(() => expect(alert).toHaveFocus());
});

test('moves focus to a failed authorization but leaves a pending one alone', async () => {
  const { user } = await page();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_connect_named' }));
  const pending = (await screen.findByText('com_ui_discord_pending')).closest('[role="alert"]');
  expect(pending).not.toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'com_ui_cancel' }));
  await waitFor(() => expect(screen.queryByText('com_ui_discord_pending')).toBeNull());
  jest.mocked(window.open).mockReturnValue(null);
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_connect_named' }));
  const failed = (await screen.findByText('com_ui_discord_unconfirmed')).closest('[role="alert"]');
  await waitFor(() => expect(failed).toHaveFocus());
});

test('moves focus to the alert when the callback settles a pending authorization as failed', async () => {
  const { user } = await page();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_connect_named' }));
  await waitFor(() => expect(popup.location.href).toBe(connectResponse.url));
  const pending = screen.getByText('com_ui_discord_pending').closest('[role="alert"]');
  expect(pending).not.toHaveFocus();
  act(() =>
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: OAUTH_SETTLED_CHANNEL,
        newValue: JSON.stringify({ outcome: 'failed', flowId: connectResponse.flowId }),
      }),
    ),
  );
  const failed = (await screen.findByText('com_ui_discord_unconfirmed')).closest('[role="alert"]');
  await waitFor(() => expect(failed).toHaveFocus());
});

test('clears old registration success when credentials rotate and uses the refreshed app revision', async () => {
  const { user } = await page();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_commands_named' }));
  expect(await screen.findByText('com_ui_discord_commands_success')).toBeVisible();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'com_ui_discord_rotate_named' })).toBeEnabled(),
  );
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_rotate_named' }));
  await user.type(screen.getByLabelText('com_ui_discord_bot_token'), 'private-rotated-token');
  jest
    .mocked(dataService.getDiscordApps)
    .mockResolvedValue({ applications: [{ ...app, revision: 'app-r2' }] });
  await user.click(screen.getByRole('button', { name: 'com_ui_save' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'com_ui_discord_commands_named' })).toBeEnabled(),
  );
  expect(screen.queryByText('com_ui_discord_commands_success')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_commands_named' }));
  await waitFor(() =>
    expect(jest.mocked(dataService.registerDiscordCommands).mock.calls[1][0]).toEqual({
      applicationId: app.applicationId,
      expectedRevision: 'app-r2',
      manifestVersion: '2',
    }),
  );
});

test('does not attach a previous account registration result to the next account', async () => {
  const pending = deferred<{
    applicationId: string;
    commandId: string;
    providerVersion: string;
    manifestVersion: '2';
  }>();
  jest.mocked(dataService.registerDiscordCommands).mockReturnValueOnce(pending.promise);
  const { user, client, rerender } = await page();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_commands_named' }));
  rerender(
    <QueryClientProvider client={client}>
      <Discord userId="next-admin" tenantId="other-org" />
    </QueryClientProvider>,
  );
  await act(async () =>
    pending.resolve({
      applicationId: app.applicationId,
      commandId: '623456789012345678',
      providerVersion: '723456789012345678',
      manifestVersion: '2',
    }),
  );
  expect(screen.queryByText('com_ui_discord_commands_success')).toBeNull();
  expect(dataService.registerDiscordCommands).toHaveBeenCalledTimes(1);
});

test('keeps failures scoped to their application card', async () => {
  jest.mocked(dataService.getDiscordApps).mockResolvedValue({
    applications: [app, { ...app, applicationId: '823456789012345678', name: 'Support' }],
  });
  jest.mocked(dataService.registerDiscordCommands).mockRejectedValueOnce(new Error('safe'));
  const { user } = await page();
  const first = within(screen.getByText('Engineering').closest('li')!);
  const second = within(screen.getByText('Support').closest('li')!);
  await user.click(first.getByRole('button', { name: 'com_ui_discord_commands_named' }));
  expect(await first.findByText('com_ui_discord_error')).toBeVisible();
  await waitFor(() =>
    expect(second.getByRole('button', { name: 'com_ui_discord_commands_named' })).toBeEnabled(),
  );
  expect(first.getByRole('button', { name: 'com_ui_discord_commands_named' })).toBeDisabled();
});

test('rejects a mismatched registration acknowledgement without claiming success', async () => {
  jest.mocked(dataService.registerDiscordCommands).mockResolvedValueOnce({
    applicationId: '823456789012345678',
    commandId: '623456789012345678',
    providerVersion: '723456789012345678',
    manifestVersion: '2',
  });
  const { user } = await page();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_commands_named' }));
  expect(await screen.findByText('com_ui_discord_error')).toBeVisible();
  expect(screen.queryByText('com_ui_discord_commands_success')).toBeNull();
});

const guilds = (...records: DiscordGuild[]) => ({ guilds: records });
const changed = { ...guild, status: 'disconnected' as const, revision: 'guild-r2' };
async function openConfirmation(user: User) {
  const origin = screen.getByRole('button', { name: 'com_ui_discord_disconnect_named' });
  await user.click(origin);
  const dialog = screen.getByRole('alertdialog', { name: 'com_ui_discord_disconnect' });
  return {
    origin,
    dialog,
    confirm: () => within(dialog).getByRole('button', { name: 'com_ui_discord_disconnect' }),
    cancel: () => within(dialog).getByRole('button', { name: 'com_ui_cancel' }),
  };
}
/**
 * A rejected disconnect: the dialog stays open on its failure while the reads refresh behind it.
 * The request stays pending until the busy state has reached the view, so a held read is consumed
 * by the refetch that follows the failure rather than by the refresh inside the mutation.
 */
async function failedDisconnect(user: User, held?: () => Promise<{ guilds: DiscordGuild[] }>) {
  let reject!: (error: Error) => void;
  jest.mocked(dataService.disconnectDiscordGuild).mockReturnValueOnce(
    new Promise<DiscordGuild>((_, fail) => {
      reject = fail;
    }),
  );
  const view = await openConfirmation(user);
  await user.click(view.confirm());
  await waitFor(() => expect(view.confirm()).toBeDisabled());
  if (held) jest.mocked(dataService.getDiscordGuilds).mockImplementationOnce(held);
  await act(async () => reject(Object.assign(new Error('safe'), { code: 'rate_limited' })));
  const [alert] = await within(view.dialog).findAllByRole('alert');
  return { ...view, alert };
}
const headingOf = (name: string) => screen.getByRole('heading', { name });

test('moves focus to the disconnect failure and retries while the confirmed server is current', async () => {
  const { user } = await page();
  const { alert, confirm } = await failedDisconnect(user);
  expect(alert).toHaveFocus();
  await waitFor(() => expect(confirm()).toBeEnabled());
  expect(within(alert).queryByText('com_ui_discord_disconnect_stale')).toBeNull();
  expect(alert).toHaveTextContent('com_ui_discord_rate_limited');
  await user.click(confirm());
  await waitFor(() => expect(dataService.disconnectDiscordGuild).toHaveBeenCalledTimes(2));
  expect(dataService.disconnectDiscordGuild).toHaveBeenLastCalledWith(
    guild.installationId,
    guild.revision,
  );
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
});

test.each([
  ['committed before the failure was reported', guilds(changed)],
  ['changed by another administrator', guilds({ ...guild, revision: 'guild-r2' })],
  ['removed', guilds()],
])('blocks the retry once the refreshed reads show the server %s', async (_name, reads) => {
  const { user } = await page();
  jest.mocked(dataService.getDiscordGuilds).mockResolvedValue(reads);
  const { dialog, alert, confirm } = await failedDisconnect(user);
  await waitFor(() => expect(alert).toHaveTextContent('com_ui_discord_disconnect_stale'));
  expect(within(dialog).queryByText('com_ui_discord_rate_limited')).toBeNull();
  expect(confirm()).toBeDisabled();
  expect(alert).toHaveFocus();
  expect(dataService.disconnectDiscordGuild).toHaveBeenCalledTimes(1);
});

test.each([
  ['Cancel', (user: User, cancel: HTMLElement) => user.click(cancel)],
  ['Escape', (user: User) => user.keyboard('{Escape}')],
])(
  'returns focus to the disconnect control only after the reads behind a failure settle on %s',
  async (_name, dismiss) => {
    const { user } = await page();
    const reads = deferred<{ guilds: DiscordGuild[] }>();
    const { origin, cancel } = await failedDisconnect(user, () => reads.promise);
    await dismiss(user, cancel());
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(origin).toBeDisabled();
    expect(origin).not.toHaveFocus();
    await act(async () => reads.resolve(guilds(guild)));
    await waitFor(() => expect(origin).toBeEnabled());
    await waitFor(() => expect(origin).toHaveFocus());
  },
);

test('moves focus to the load failure when the reads fail behind a failed disconnect, then back after a retry', async () => {
  const { user } = await page();
  const { origin, cancel } = await failedDisconnect(user, () =>
    Promise.reject(new Error('network')),
  );
  await user.click(cancel());
  const failure = (await screen.findByText('com_ui_discord_error')).closest(
    '[role="alert"]',
  ) as HTMLElement;
  await waitFor(() => expect(failure).toHaveFocus());
  expect(origin).toBeDisabled();
  expect(origin).not.toHaveFocus();
  await user.click(within(failure).getByRole('button', { name: 'com_ui_retry' }));
  await waitFor(() => expect(origin).toBeEnabled());
  await waitFor(() => expect(origin).toHaveFocus());
});

test('falls back to the servers heading when the refreshed list no longer has the disconnect control', async () => {
  const { user } = await page();
  jest.mocked(dataService.getDiscordGuilds).mockResolvedValue(guilds(changed));
  const { origin, cancel } = await failedDisconnect(user);
  await waitFor(() => expect(origin).not.toBeInTheDocument());
  await user.click(cancel());
  await waitFor(() => expect(headingOf('com_ui_discord_guilds')).toHaveFocus());
});

test('returns focus to the servers heading once a disconnect succeeds and its reads settle', async () => {
  const { user } = await page();
  jest.mocked(dataService.getDiscordGuilds).mockResolvedValue(guilds(changed));
  const { origin, confirm } = await openConfirmation(user);
  await user.click(confirm());
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  await waitFor(() => expect(origin).not.toBeInTheDocument());
  await waitFor(() => expect(headingOf('com_ui_discord_guilds')).toHaveFocus());
});

test('moves focus to the load failure when the reads fail after a disconnect succeeds, then to the servers heading after a retry', async () => {
  const { user } = await page();
  jest.mocked(dataService.getDiscordGuilds).mockRejectedValueOnce(new Error('network'));
  const { confirm } = await openConfirmation(user);
  await user.click(confirm());
  const failure = (await screen.findByText('com_ui_discord_error')).closest(
    '[role="alert"]',
  ) as HTMLElement;
  await waitFor(() => expect(failure).toHaveFocus());
  jest.mocked(dataService.getDiscordGuilds).mockResolvedValue(guilds(changed));
  await user.click(within(failure).getByRole('button', { name: 'com_ui_retry' }));
  await waitFor(() => expect(headingOf('com_ui_discord_guilds')).toHaveFocus());
});

test('does not move focus in the next account when the previous account settles after a failed disconnect', async () => {
  const { user, client, rerender } = await page();
  const reads = deferred<{ guilds: DiscordGuild[] }>();
  const { origin, cancel } = await failedDisconnect(user, () => reads.promise);
  await user.click(cancel());
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(origin).toBeDisabled();
  rerender(
    <QueryClientProvider client={client}>
      <Discord userId="next-admin" tenantId="other-org" />
    </QueryClientProvider>,
  );
  const next = await screen.findByRole('button', { name: 'com_ui_discord_disconnect_named' });
  await waitFor(() => expect(next).toBeEnabled());
  await act(async () => reads.resolve(guilds(guild)));
  expect(next).toBeEnabled();
  expect(next).not.toHaveFocus();
  expect(document.body).toHaveFocus();
});

test('does not touch the document when the view unmounts before the reads behind a failed disconnect settle', async () => {
  const { user, unmount } = await page();
  const reads = deferred<{ guilds: DiscordGuild[] }>();
  const { cancel } = await failedDisconnect(user, () => reads.promise);
  await user.click(cancel());
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  unmount();
  await act(async () => reads.resolve(guilds(guild)));
  expect(document.body).toHaveFocus();
});

const settle = (notice: Record<string, unknown>) =>
  act(() =>
    window.dispatchEvent(
      new StorageEvent('storage', { key: OAUTH_SETTLED_CHANNEL, newValue: JSON.stringify(notice) }),
    ),
  );
async function pendingAuthorization(user: User) {
  const origin = screen.getByRole('button', { name: 'com_ui_discord_connect_named' });
  await user.click(origin);
  await waitFor(() => expect(popup.location.href).toBe(connectResponse.url));
  return origin;
}
const failedNotice = async () =>
  (await screen.findByText('com_ui_discord_unconfirmed')).closest('[role="alert"]') as HTMLElement;
const refused = {
  outcome: 'failed',
  flowId: connectResponse.flowId,
  errorCode: 'discord_provider_refused',
};

test.each([
  ['discord_provider_refused', 'com_ui_discord_oauth_refused'],
  ['discord_missing_permissions', 'com_ui_discord_permissions'],
  ['discord_guild_changed', 'com_ui_discord_guild_changed'],
  ['discord_timeout', 'com_ui_discord_provider_unavailable'],
  ['discord_transactions_unavailable', 'com_ui_channels_transaction_required'],
])(
  'shows why the callback failed beside the unconfirmed recovery wording (%s)',
  async (code, key) => {
    const { user } = await page();
    await pendingAuthorization(user);
    settle({ outcome: 'failed', flowId: connectResponse.flowId, errorCode: code });
    const notice = await failedNotice();
    expect(within(notice).getByText(key)).toBeVisible();
    expect(within(notice).getByRole('button', { name: 'com_ui_cancel' })).toBeEnabled();
    await waitFor(() => expect(notice).toHaveFocus());
    expect(screen.queryByText('com_ui_discord_refused')).toBeNull();
  },
);

test.each([
  ['an old notice without a code', { outcome: 'failed' }],
  ['a code outside the approved set', { outcome: 'failed', errorCode: 'provider_secret_detail' }],
  ['a management only code', { outcome: 'failed', errorCode: 'provider_refused' }],
])('keeps only the unconfirmed wording for %s', async (_name, extra) => {
  const { user } = await page();
  await pendingAuthorization(user);
  settle({ flowId: connectResponse.flowId, ...extra });
  const notice = await failedNotice();
  expect(notice.querySelectorAll('p')).toHaveLength(1);
  expect(notice).toHaveTextContent('com_ui_discord_unconfirmed');
});

test('ignores a coded failure for another flow and keeps the pending authorization', async () => {
  const { user } = await page();
  await pendingAuthorization(user);
  settle({ ...refused, flowId: 'other-flow' });
  expect(screen.getByText('com_ui_discord_pending')).toBeVisible();
  expect(screen.queryByText('com_ui_discord_unconfirmed')).toBeNull();
  expect(screen.queryByText('com_ui_discord_oauth_refused')).toBeNull();
});

test('never treats a code carried on a success notice as a failure', async () => {
  const { user } = await page();
  await pendingAuthorization(user);
  settle({ outcome: 'succeeded', flowId: connectResponse.flowId, errorCode: 'discord_forbidden' });
  await waitFor(() => expect(screen.queryByText('com_ui_discord_pending')).toBeNull());
  expect(screen.queryByText('com_ui_discord_unconfirmed')).toBeNull();
  expect(screen.queryByText('com_ui_discord_admin')).toBeNull();
});

test('refreshes the server reads after a coded failure settles', async () => {
  const { user } = await page();
  await pendingAuthorization(user);
  const before = jest.mocked(dataService.getDiscordGuilds).mock.calls.length;
  settle(refused);
  await failedNotice();
  await waitFor(() =>
    expect(jest.mocked(dataService.getDiscordGuilds).mock.calls.length).toBeGreaterThan(before),
  );
});

test('clears the reason when the notice is dismissed and for the next attempt', async () => {
  const { user } = await page();
  const origin = await pendingAuthorization(user);
  settle(refused);
  const notice = await failedNotice();
  expect(within(notice).getByText('com_ui_discord_oauth_refused')).toBeVisible();
  await user.click(within(notice).getByRole('button', { name: 'com_ui_cancel' }));
  await waitFor(() => expect(screen.queryByText('com_ui_discord_unconfirmed')).toBeNull());
  expect(screen.queryByText('com_ui_discord_oauth_refused')).toBeNull();
  await waitFor(() => expect(origin).toBeEnabled());
  jest.mocked(window.open).mockReturnValue(null);
  await user.click(origin);
  const next = await failedNotice();
  expect(next.querySelectorAll('p')).toHaveLength(1);
  expect(screen.queryByText('com_ui_discord_oauth_refused')).toBeNull();
});

test('does not carry the reason into the next account', async () => {
  const { user, client, rerender } = await page();
  await pendingAuthorization(user);
  settle(refused);
  expect(within(await failedNotice()).getByText('com_ui_discord_oauth_refused')).toBeVisible();
  rerender(
    <QueryClientProvider client={client}>
      <Discord userId="next-admin" tenantId="other-org" />
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: 'com_ui_discord_connect_named' });
  expect(screen.queryByText('com_ui_discord_oauth_refused')).toBeNull();
  expect(screen.queryByText('com_ui_discord_unconfirmed')).toBeNull();
});

const second: DiscordApplication = { ...app, applicationId: '423456789012345678', name: 'Support' };
const other: DiscordGuild = {
  ...guild,
  installationId: 'installation-2',
  guildName: 'Support server',
};
const silent = { log: () => {}, warn: () => {}, error: () => {} };
const appsHeading = () => screen.getByRole('heading', { name: 'com_ui_discord_apps' });
const retryOf = (alert: HTMLElement) => within(alert).getByRole('button', { name: 'com_ui_retry' });
const loadFailure = async () =>
  (await screen.findByText('com_ui_discord_error')).closest('[role="alert"]') as HTMLElement;
const nextAccount = (client: QueryClient) => (
  <QueryClientProvider client={client}>
    <Discord userId="next-admin" tenantId="other-org" />
  </QueryClientProvider>
);
/** A first load whose read fails once, so the page opens on its load failure. */
async function unreadable(read: 'apps' | 'guilds') {
  const failing =
    read === 'apps'
      ? jest.mocked(dataService.getDiscordApps)
      : jest.mocked(dataService.getDiscordGuilds);
  failing.mockRejectedValueOnce(new Error('network'));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    logger: silent,
  });
  const view = render(
    <QueryClientProvider client={client}>
      <Discord userId="admin" tenantId="org" />
    </QueryClientProvider>,
  );
  return { ...view, client, user: userEvent.setup(), failure: await loadFailure() };
}

test.each(['apps', 'guilds'] as const)(
  'moves focus to the applications heading once an initial load succeeds on retry (%s read failed)',
  async (read) => {
    const { user, failure } = await unreadable(read);
    await user.click(retryOf(failure));
    expect(await screen.findByText('Engineering')).toBeVisible();
    await waitFor(() => expect(appsHeading()).toHaveFocus());
  },
);

test('returns focus to the load failure when an initial retry fails again, then to the heading', async () => {
  const { user, failure } = await unreadable('apps');
  const again = deferred<DiscordApplicationPage>();
  jest.mocked(dataService.getDiscordApps).mockReturnValueOnce(again.promise);
  await user.click(retryOf(failure));
  await waitFor(() => expect(screen.queryByText('com_ui_discord_error')).toBeNull());
  await act(async () => again.reject(new Error('network')));
  const repeated = await loadFailure();
  await waitFor(() => expect(repeated).toHaveFocus());
  await user.click(retryOf(repeated));
  expect(await screen.findByText('Engineering')).toBeVisible();
  await waitFor(() => expect(appsHeading()).toHaveFocus());
});

test('leaves focus alone when the user moved on while an initial retry waited', async () => {
  const { user, failure } = await unreadable('apps');
  const reads = deferred<DiscordApplicationPage>();
  jest.mocked(dataService.getDiscordApps).mockReturnValueOnce(reads.promise);
  await user.click(retryOf(failure));
  const link = screen.getByRole('link', { name: 'com_ui_discord_developer_portal' });
  link.focus();
  await act(async () => reads.resolve({ applications: [app] }));
  expect(await screen.findByText('Engineering')).toBeVisible();
  expect(link).toHaveFocus();
  expect(appsHeading()).not.toHaveFocus();
});

test('does not move focus in the next account when an initial retry settles after the switch', async () => {
  const { user, failure, client, rerender } = await unreadable('apps');
  const reads = deferred<DiscordApplicationPage>();
  jest.mocked(dataService.getDiscordApps).mockReturnValueOnce(reads.promise);
  await user.click(retryOf(failure));
  rerender(nextAccount(client));
  expect(await screen.findByText('Engineering')).toBeVisible();
  await act(async () => reads.resolve({ applications: [app] }));
  expect(appsHeading()).not.toHaveFocus();
  expect(document.body).toHaveFocus();
});

test('does not touch the document when the view unmounts before an initial retry settles', async () => {
  const { user, failure, unmount } = await unreadable('apps');
  const reads = deferred<DiscordApplicationPage>();
  jest.mocked(dataService.getDiscordApps).mockReturnValueOnce(reads.promise);
  await user.click(retryOf(failure));
  unmount();
  await act(async () => reads.resolve({ applications: [app] }));
  expect(document.body).toHaveFocus();
});

/** Both sections page the same way: the first page names a cursor, `page` answers the rest. */
const sections = [
  {
    name: 'applications',
    more: 'com_ui_discord_more_apps',
    heading: 'com_ui_discord_apps',
    added: 'Support',
    cursors: () => jest.mocked(dataService.getDiscordApps).mock.calls.map(([cursor]) => cursor),
    serve: (
      page: (cursor: string) => Promise<{ next?: string }>,
      reads: (read: number) => Promise<void> = () => Promise.resolve(),
    ) => {
      let read = 0;
      return jest
        .mocked(dataService.getDiscordApps)
        .mockImplementation(async (cursor): Promise<DiscordApplicationPage> => {
          if (cursor) {
            return { applications: cursor === 'c2' ? [second] : [], ...(await page(cursor)) };
          }
          await reads((read += 1));
          return { applications: [app], next: 'c2' };
        });
    },
  },
  {
    name: 'servers',
    more: 'com_ui_discord_more_guilds',
    heading: 'com_ui_discord_guilds',
    added: 'Support server',
    cursors: () => jest.mocked(dataService.getDiscordGuilds).mock.calls.map(([cursor]) => cursor),
    serve: (
      page: (cursor: string) => Promise<{ next?: string }>,
      reads: (read: number) => Promise<void> = () => Promise.resolve(),
    ) => {
      let read = 0;
      return jest
        .mocked(dataService.getDiscordGuilds)
        .mockImplementation(async (cursor): Promise<DiscordGuildPage> => {
          if (cursor) return { guilds: cursor === 'c2' ? [other] : [], ...(await page(cursor)) };
          await reads((read += 1));
          return { guilds: [guild], next: 'c2' };
        });
    },
  },
] as const;
/** A browser drops focus from a control that disables itself; jsdom keeps it, so move it to the page. */
const dropsFocus = () =>
  act(() => {
    const sink = document.createElement('div');
    sink.tabIndex = -1;
    document.body.append(sink);
    sink.focus();
    sink.remove();
  });

test.each(sections)(
  'keeps focus on Load more $name while pages remain, then moves to the heading after the last page',
  async ({ more, heading, added, serve }) => {
    const reads = deferred<{ next?: string }>();
    serve((cursor) => (cursor === 'c2' ? reads.promise : Promise.resolve({})));
    const { user } = await page();
    const button = screen.getByRole('button', { name: more });
    await user.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    dropsFocus();
    expect(document.body).toHaveFocus();
    await act(async () => reads.resolve({ next: 'c3' }));
    expect(await screen.findByText(added)).toBeVisible();
    await waitFor(() => expect(button).toHaveFocus());
    await user.click(button);
    await waitFor(() => expect(screen.queryByRole('button', { name: more })).toBeNull());
    await waitFor(() => expect(screen.getByRole('heading', { name: heading })).toHaveFocus());
  },
);

test.each(sections)(
  'focuses the load failure when the next $name page fails and retries only that page',
  async ({ more, heading, cursors, serve }) => {
    let failing = true;
    serve(async (cursor) => {
      if (cursor === 'c2' && failing) {
        failing = false;
        throw new Error('network');
      }
      return {};
    });
    const { user } = await page();
    await user.click(screen.getByRole('button', { name: more }));
    const failure = await loadFailure();
    await waitFor(() => expect(failure).toHaveFocus());
    await user.click(retryOf(failure));
    await waitFor(() => expect(screen.queryByText('com_ui_discord_error')).toBeNull());
    await waitFor(() => expect(screen.getByRole('heading', { name: heading })).toHaveFocus());
    expect(cursors()).toEqual([undefined, 'c2', 'c2']);
  },
);

test.each(sections)(
  'leaves focus alone when the user moved on while Load more $name waited',
  async ({ more, added, serve }) => {
    const reads = deferred<{ next?: string }>();
    serve((cursor) => (cursor === 'c2' ? reads.promise : Promise.resolve({})));
    const { user } = await page();
    const button = screen.getByRole('button', { name: more });
    await user.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    dropsFocus();
    const link = screen.getByRole('link', { name: 'com_ui_discord_developer_portal' });
    link.focus();
    await act(async () => reads.resolve({ next: 'c3' }));
    expect(await screen.findByText(added)).toBeVisible();
    expect(link).toHaveFocus();
    expect(button).not.toHaveFocus();
  },
);

test('does not move focus in the next account when Load more settles after the switch', async () => {
  const [{ more, serve }] = sections;
  const reads = deferred<{ next?: string }>();
  serve((cursor) => (cursor === 'c2' ? reads.promise : Promise.resolve({})));
  const { user, client, rerender } = await page();
  const button = screen.getByRole('button', { name: more });
  await user.click(button);
  await waitFor(() => expect(button).toBeDisabled());
  dropsFocus();
  jest.mocked(dataService.getDiscordApps).mockResolvedValue({ applications: [app] });
  rerender(nextAccount(client));
  expect(await screen.findByText('Engineering')).toBeVisible();
  await act(async () => reads.resolve({ next: 'c3' }));
  expect(appsHeading()).not.toHaveFocus();
  expect(document.body).toHaveFocus();
});

test('does not touch the document when the view unmounts before Load more settles', async () => {
  const [{ more, serve }] = sections;
  const reads = deferred<{ next?: string }>();
  serve((cursor) => (cursor === 'c2' ? reads.promise : Promise.resolve({})));
  const { user, unmount } = await page();
  const button = screen.getByRole('button', { name: more });
  await user.click(button);
  await waitFor(() => expect(button).toBeDisabled());
  dropsFocus();
  unmount();
  await act(async () => reads.resolve({ next: 'c3' }));
  expect(document.body).toHaveFocus();
});

const unread = () => Promise.reject(new Error('network'));
const hintOf = async (dialog: HTMLElement) =>
  (await within(dialog).findByText('com_ui_discord_disconnect_unread')).closest(
    '[role="alert"]',
  ) as HTMLElement;

test('shows why Disconnect is unavailable when the reads behind a failed disconnect fail', async () => {
  const { user } = await page();
  const { dialog, alert, confirm } = await failedDisconnect(user, unread);
  const hint = await hintOf(dialog);
  expect(within(hint).getByRole('button', { name: 'com_ui_retry' })).toBeEnabled();
  expect(confirm()).toBeDisabled();
  expect(alert).toHaveFocus();
});

test('shows a background read failure inside the open confirmation without taking focus from Cancel', async () => {
  const { user, client } = await page();
  const { dialog, confirm, cancel } = await openConfirmation(user);
  expect(cancel()).toHaveFocus();
  jest.mocked(dataService.getDiscordGuilds).mockRejectedValueOnce(new Error('network'));
  await act(async () => {
    await client.invalidateQueries([QueryKeys.discordGuilds, JSON.stringify(['org', 'admin'])]);
  });
  expect(await hintOf(dialog)).toBeVisible();
  expect(confirm()).toBeDisabled();
  expect(cancel()).toHaveFocus();
});

test('retries only the failed read from the confirmation and returns focus to Cancel', async () => {
  const { user } = await page();
  const { dialog, confirm, cancel } = await failedDisconnect(user, unread);
  const hint = await hintOf(dialog);
  const appReads = jest.mocked(dataService.getDiscordApps).mock.calls.length;
  await user.click(within(hint).getByRole('button', { name: 'com_ui_retry' }));
  await waitFor(() =>
    expect(within(dialog).queryByText('com_ui_discord_disconnect_unread')).toBeNull(),
  );
  expect(jest.mocked(dataService.getDiscordApps).mock.calls.length).toBe(appReads);
  await waitFor(() => expect(confirm()).toBeEnabled());
  await waitFor(() => expect(cancel()).toHaveFocus());
});

test('keeps the hint, the disabled action and focus inside the confirmation when the retry fails', async () => {
  const { user } = await page();
  const { dialog, confirm } = await failedDisconnect(user, unread);
  const hint = await hintOf(dialog);
  const pageFailure = await loadFailure();
  const reads = jest.mocked(dataService.getDiscordGuilds).mock.calls.length;
  jest.mocked(dataService.getDiscordGuilds).mockRejectedValueOnce(new Error('network'));
  await user.click(within(hint).getByRole('button', { name: 'com_ui_retry' }));
  await waitFor(() =>
    expect(jest.mocked(dataService.getDiscordGuilds).mock.calls.length).toBeGreaterThan(reads),
  );
  await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
  expect(within(dialog).getByText('com_ui_discord_disconnect_unread')).toBeVisible();
  expect(confirm()).toBeDisabled();
  expect(pageFailure).not.toHaveFocus();
});

test('blocks the retry and moves focus to Cancel when the reread shows the server changed', async () => {
  const { user } = await page();
  const { dialog, alert, confirm, cancel } = await failedDisconnect(user, unread);
  const hint = await hintOf(dialog);
  jest.mocked(dataService.getDiscordGuilds).mockResolvedValue(guilds(changed));
  await user.click(within(hint).getByRole('button', { name: 'com_ui_retry' }));
  await waitFor(() => expect(alert).toHaveTextContent('com_ui_discord_disconnect_stale'));
  expect(confirm()).toBeDisabled();
  await waitFor(() => expect(cancel()).toHaveFocus());
});

/** What a returning window does to every active query: a stale one is read again. */
const refocus = () =>
  act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
const failsOnce = () => {
  let failing = true;
  return async () => {
    if (failing) {
      failing = false;
      throw new Error('network');
    }
    return {};
  };
};
const failsRead =
  (...which: number[]) =>
  async (read: number) => {
    if (which.includes(read)) throw new Error('network');
  };

test.each(sections)(
  'retries by rereading, not by fetching the next page, when a reread failed after a failed $name page was cleared',
  async ({ more, added, cursors, serve }) => {
    /** Reads, in order: the first load, an independent reread that succeeds, one that fails, the Retry. */
    serve(failsOnce(), failsRead(3));
    const { user } = await page();
    await user.click(screen.getByRole('button', { name: more }));
    await loadFailure();
    await refocus();
    await waitFor(() => expect(screen.queryByText('com_ui_discord_error')).toBeNull());
    await waitFor(() => expect(screen.getByRole('button', { name: more })).toHaveFocus());
    await refocus();
    const failure = await loadFailure();
    expect(failure).not.toHaveFocus();
    await user.click(retryOf(failure));
    await waitFor(() => expect(screen.queryByText('com_ui_discord_error')).toBeNull());
    expect(cursors()).toEqual([undefined, 'c2', undefined, undefined, undefined]);
    expect(screen.queryByText(added)).toBeNull();
    expect(screen.getByRole('button', { name: more })).toBeVisible();
    await waitFor(() => expect(appsHeading()).toHaveFocus());
  },
);

test.each(sections)(
  'retries by rereading when a reread fails while a failed $name page is still showing',
  async ({ more, added, cursors, serve }) => {
    serve(failsOnce(), failsRead(2));
    const { user } = await page();
    await user.click(screen.getByRole('button', { name: more }));
    await loadFailure();
    await refocus();
    await waitFor(() => expect(cursors()).toHaveLength(3));
    await user.click(retryOf(await loadFailure()));
    await waitFor(() => expect(screen.queryByText('com_ui_discord_error')).toBeNull());
    expect(cursors()).toEqual([undefined, 'c2', undefined, undefined]);
    expect(screen.queryByText(added)).toBeNull();
  },
);

test.each(sections)(
  'keeps retrying only the failed $name page while it keeps failing',
  async ({ more, added, cursors, serve }) => {
    let failures = 2;
    serve(async () => {
      if (failures-- > 0) throw new Error('network');
      return {};
    });
    const { user } = await page();
    await user.click(screen.getByRole('button', { name: more }));
    await user.click(retryOf(await loadFailure()));
    await waitFor(() => expect(cursors()).toHaveLength(3));
    await user.click(retryOf(await loadFailure()));
    expect(await screen.findByText(added)).toBeVisible();
    expect(cursors()).toEqual([undefined, 'c2', 'c2', 'c2']);
  },
);

test('does not carry a failed page from one account into the next account retry', async () => {
  const [{ more, cursors, serve }] = sections;
  serve(async () => {
    throw new Error('network');
  }, failsRead(2));
  const { user, client, rerender } = await page();
  await user.click(screen.getByRole('button', { name: more }));
  await loadFailure();
  rerender(nextAccount(client));
  await user.click(retryOf(await loadFailure()));
  expect(await screen.findByText('Engineering')).toBeVisible();
  expect(cursors()).toEqual([undefined, 'c2', undefined, undefined]);
});

test('keeps setup details quiet until opened without hiding connection actions', async () => {
  const { user } = await page({ configuration: false });
  expect(screen.getByRole('button', { name: 'com_ui_discord_connect_named' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'com_ui_discord_rotate_named' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'com_ui_discord_commands_named' })).not.toBeVisible();
  expect(screen.getByLabelText('com_ui_discord_callback')).not.toBeVisible();
  await user.click(screen.getByText('com_ui_discord_setup_details'));
  expect(screen.getByRole('button', { name: 'com_ui_discord_commands_named' })).toBeVisible();
  expect(screen.getByLabelText('com_ui_discord_callback')).toBeVisible();
  expect(dataService.registerDiscordCommands).not.toHaveBeenCalled();
});

test('reveals a command failure even when setup details were closed while waiting', async () => {
  const pending = deferred<never>();
  jest.mocked(dataService.registerDiscordCommands).mockReturnValueOnce(pending.promise);
  const { user } = await page();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_commands_named' }));
  await user.click(screen.getByText('com_ui_discord_setup_details'));
  await act(async () => pending.reject(new Error('safe')));
  expect(await screen.findByText('com_ui_discord_error')).toBeVisible();
  expect(screen.getByRole('button', { name: 'com_ui_refresh' })).toBeVisible();
});

test('keeps command setup details open while Refresh restores focus', async () => {
  const { user } = await page();
  const { origin, dismiss } = await failedCommand(user);
  const details = origin.closest('details');
  expect(details).toHaveAttribute('open');
  const reads = deferred<{ applications: DiscordApplication[] }>();
  jest.mocked(dataService.getDiscordApps).mockReturnValueOnce(reads.promise);
  await dismiss();
  expect(details).toHaveAttribute('open');
  await act(async () => reads.resolve({ applications: [app] }));
  await waitFor(() => expect(origin).toBeEnabled());
  expect(origin).toBeVisible();
  await waitFor(() => expect(origin).toHaveFocus());
  expect(details).toHaveAttribute('open');
});
