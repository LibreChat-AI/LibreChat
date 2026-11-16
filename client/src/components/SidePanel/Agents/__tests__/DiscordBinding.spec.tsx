import React from 'react';
import userEvent from '@testing-library/user-event';
import { dataService, QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import type {
  DiscordAgentChannel,
  DiscordBindingStatus,
  DiscordBindingView,
  DiscordGuild,
} from 'librechat-data-provider';
import DiscordBinding from '../DiscordBinding';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useDebounce: jest.requireActual('~/hooks/Input/useDebounce').default,
}));
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getDiscordGuilds: jest.fn(),
      getDiscordBinding: jest.fn(),
      bindDiscordChannel: jest.fn(),
      removeDiscordBinding: jest.fn(),
    },
  };
});
const guild: DiscordGuild = {
  installationId: 'install-1',
  applicationId: '123456789012345678',
  guildId: '223456789012345678',
  guildName: 'Engineering',
  revision: 'guild-r1',
  createdBy: 'admin',
  authorityWrites: 0,
  status: 'active',
};
const channel: DiscordAgentChannel = {
  channelId: 'channel-1',
  agentId: 'agent-1',
  createdBy: 'other-admin',
  revision: 'channel-r1',
  type: 'discord',
  status: 'active',
  credentialMode: 'per_user',
  installationId: guild.installationId,
  installationRevision: guild.revision,
  discord: {
    applicationId: guild.applicationId,
    guildId: guild.guildId,
    externalChannelId: '323456789012345678',
    botUserId: '423456789012345678',
  },
};
const available: DiscordBindingStatus = {
  occupied: false,
  assignedToThisAgent: false,
  canReplace: true,
};
let observed: DiscordBindingStatus;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function page(initial: DiscordAgentChannel | null = channel) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  const onClose = jest.fn();
  const component = (userId = 'admin') => (
    <QueryClientProvider client={client}>
      <DiscordBinding
        agentId="agent-1"
        userId={userId}
        tenantId="org"
        channel={initial ?? undefined}
        enabled
        onClose={onClose}
      />
    </QueryClientProvider>
  );
  const view = render(component());
  await waitFor(() => expect(dataService.getDiscordGuilds).toHaveBeenCalled());
  return { ...view, client, onClose, component, user: userEvent.setup() };
}
async function ready() {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'com_ui_discord_binding_connect' })).toBeEnabled(),
  );
}
async function target(
  user: ReturnType<typeof userEvent.setup>,
  externalChannelId = channel.discord.externalChannelId,
) {
  await user.click(await screen.findByRole('combobox', { name: 'com_ui_discord_binding_server' }));
  await user.click(
    await screen.findByRole('option', { name: 'com_ui_discord_binding_server_named' }),
  );
  await user.type(screen.getByLabelText('com_ui_discord_binding_channel'), externalChannelId);
}
beforeEach(() => {
  observed = available;
  jest
    .mocked(dataService.getDiscordGuilds)
    .mockReset()
    .mockResolvedValue({ guilds: [guild] });
  jest
    .mocked(dataService.getDiscordBinding)
    .mockReset()
    .mockImplementation(async () => observed);
  jest
    .mocked(dataService.bindDiscordChannel)
    .mockReset()
    .mockImplementation(async () => {
      observed = {
        occupied: true,
        assignedToThisAgent: true,
        canReplace: true,
        revision: 'route-r2',
      };
      return { channel, routeRevision: 'route-r2' };
    });
  jest
    .mocked(dataService.removeDiscordBinding)
    .mockReset()
    .mockImplementation(async () => {
      observed = available;
      return null;
    });
});

test('waits for installation metadata before checking the immutable destination', async () => {
  const pending = deferred<{ guilds: DiscordGuild[] }>();
  jest.mocked(dataService.getDiscordGuilds).mockReturnValue(pending.promise);
  const { user } = await page();
  expect(screen.getByRole('status')).toHaveTextContent('com_ui_channels_loading');
  expect(dataService.getDiscordBinding).not.toHaveBeenCalled();
  expect(screen.getByLabelText('com_ui_discord_binding_channel')).toHaveAttribute('readonly');
  expect(screen.getByRole('combobox', { name: 'com_ui_discord_binding_server' })).toBeDisabled();
  await act(async () => pending.resolve({ guilds: [guild] }));
  await ready();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_binding_connect' }));
  await waitFor(() =>
    expect(dataService.bindDiscordChannel).toHaveBeenCalledWith({
      agentId: 'agent-1',
      installationId: guild.installationId,
      externalChannelId: channel.discord.externalChannelId,
    }),
  );
});

test.each([403, 404])(
  'shows provider/management readiness status %s without binding requests',
  async (status) => {
    jest
      .mocked(dataService.getDiscordGuilds)
      .mockRejectedValue(Object.assign(new Error('safe'), { status }));
    await page();
    expect(
      await screen.findByText(
        status === 403 ? 'com_ui_discord_binding_forbidden' : 'com_ui_discord_disabled',
      ),
    ).toBeVisible();
    expect(dataService.getDiscordBinding).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'com_ui_discord_binding_connect' })).toBeDisabled();
  },
);

test('explains an empty installation list and only offers active guilds for new bindings', async () => {
  jest
    .mocked(dataService.getDiscordGuilds)
    .mockResolvedValue({ guilds: [{ ...guild, status: 'disconnected' }] });
  await page(null);
  expect(await screen.findByText('com_ui_discord_binding_empty')).toBeVisible();
  expect(dataService.getDiscordBinding).not.toHaveBeenCalled();
});

test('creates a new binding after selecting a guild and validating a string snowflake', async () => {
  const { user, onClose } = await page(null);
  await target(user);
  await ready();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_binding_connect' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(dataService.bindDiscordChannel).toHaveBeenCalledWith({
    agentId: 'agent-1',
    installationId: guild.installationId,
    externalChannelId: channel.discord.externalChannelId,
  });
});

test.each(['01234', '18446744073709551616', '123abc'])(
  'rejects invalid channel ID %s without a status request',
  async (value) => {
    const { user } = await page(null);
    await target(user, value);
    expect(screen.getByLabelText('com_ui_discord_binding_channel')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(dataService.getDiscordBinding).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'com_ui_discord_binding_connect' })).toBeDisabled();
  },
);

test.each([undefined, 'Visible agent'])(
  'confirms collisions using only the permission-filtered name %s and exact revision',
  async (name) => {
    observed = {
      ...available,
      occupied: true,
      revision: 'route-r1',
      ...(name ? { assignedAgentName: name } : {}),
    };
    const { user, client, onClose } = await page();
    expect(
      await screen.findByText(
        name ? 'com_ui_discord_binding_collision_named' : 'com_ui_discord_binding_collision',
      ),
    ).toBeVisible();
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    await user.click(screen.getByRole('button', { name: 'com_ui_discord_binding_replace' }));
    const dialog = screen.getByRole('alertdialog', { name: 'com_ui_discord_binding_replace' });
    expect(within(dialog).getByRole('button', { name: 'com_ui_cancel' })).toHaveFocus();
    expect(dataService.bindDiscordChannel).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'com_ui_confirm' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(dataService.bindDiscordChannel).toHaveBeenCalledWith({
      agentId: 'agent-1',
      installationId: guild.installationId,
      externalChannelId: channel.discord.externalChannelId,
      expectedRevision: 'route-r1',
    });
    expect(invalidate).toHaveBeenCalledWith([QueryKeys.agentChannels]);
  },
);

test('cancels replacement and restores keyboard focus', async () => {
  observed = { ...available, occupied: true, revision: 'route-r1' };
  const { user } = await page();
  const trigger = await screen.findByRole('button', { name: 'com_ui_discord_binding_replace' });
  await user.click(trigger);
  await user.click(
    within(screen.getByRole('alertdialog')).getByRole('button', { name: 'com_ui_cancel' }),
  );
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(dataService.bindDiscordChannel).not.toHaveBeenCalled();
});

test('blocks a confirmation whose route revision changed during refetch', async () => {
  observed = { ...available, occupied: true, revision: 'route-r1' };
  const { user, client } = await page();
  await user.click(await screen.findByRole('button', { name: 'com_ui_discord_binding_replace' }));
  observed = { ...observed, revision: 'route-r2' };
  await act(async () => {
    await client.invalidateQueries([QueryKeys.discordBindings]);
  });
  await waitFor(() =>
    expect(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'com_ui_confirm' }),
    ).toBeDisabled(),
  );
  expect(dataService.bindDiscordChannel).not.toHaveBeenCalled();
});

test('removes a binding created by another admin even while creation is unavailable', async () => {
  observed = { occupied: true, assignedToThisAgent: true, canReplace: false, revision: 'route-r1' };
  jest
    .mocked(dataService.getDiscordGuilds)
    .mockResolvedValue({ guilds: [{ ...guild, status: 'disconnected' }] });
  const { user, onClose } = await page();
  await user.click(await screen.findByRole('button', { name: 'com_ui_discord_binding_remove' }));
  await user.click(
    within(screen.getByRole('alertdialog')).getByRole('button', { name: 'com_ui_confirm' }),
  );
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(dataService.removeDiscordBinding).toHaveBeenCalledWith({
    agentId: 'agent-1',
    installationId: guild.installationId,
    externalChannelId: channel.discord.externalChannelId,
    expectedRevision: 'route-r1',
  });
});

test('reconciles an uncertain write and requires an explicit status check before another action', async () => {
  jest
    .mocked(dataService.bindDiscordChannel)
    .mockRejectedValueOnce(Object.assign(new Error('safe'), { code: 'binding_uncertain' }));
  const { user } = await page();
  await ready();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_binding_connect' }));
  expect(await screen.findByText('com_ui_discord_binding_uncertain')).toBeVisible();
  expect(dataService.bindDiscordChannel).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'com_ui_discord_binding_connect' })).toBeDisabled();
  observed = {
    occupied: true,
    assignedToThisAgent: true,
    canReplace: true,
    revision: 'committed-r1',
  };
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'com_ui_discord_binding_check' })).toBeEnabled(),
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'com_ui_discord_binding_check' })).toHaveFocus(),
  );
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_binding_check' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'com_ui_discord_binding_remove' })).toBeEnabled(),
  );
  expect(dataService.bindDiscordChannel).toHaveBeenCalledTimes(1);
});

test.each([
  ['provider_refused', 'com_ui_discord_binding_refused'],
  ['rate_limited', 'com_ui_discord_rate_limited'],
  ['provider_unavailable', 'com_ui_discord_provider_unavailable'],
  ['timeout', 'com_ui_discord_provider_unavailable'],
  ['unsupported_installation', 'com_ui_discord_code_grant'],
])('explains provider code %s and still requires a status check', async (code, label) => {
  jest
    .mocked(dataService.bindDiscordChannel)
    .mockRejectedValueOnce(
      Object.assign(new Error('Bot private-token refused'), { code, status: 409 }),
    );
  const { user } = await page();
  await ready();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_binding_connect' }));
  expect(await screen.findByText(label)).toBeVisible();
  expect(screen.queryByText('com_ui_discord_binding_uncertain')).toBeNull();
  expect(screen.getByText('com_ui_discord_binding_check_help')).toBeVisible();
  expect(screen.queryByText(/private-token/)).toBeNull();
  expect(screen.getByRole('button', { name: 'com_ui_discord_binding_connect' })).toBeDisabled();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'com_ui_discord_binding_check' })).toHaveFocus(),
  );
  expect(dataService.bindDiscordChannel).toHaveBeenCalledTimes(1);
});

test.each(['binding_uncertain', 'unavailable', 'unrecognized_code'])(
  'keeps the uncertain wording for the %s code',
  async (code) => {
    jest
      .mocked(dataService.bindDiscordChannel)
      .mockRejectedValueOnce(Object.assign(new Error('safe'), { code }));
    const { user } = await page();
    await ready();
    await user.click(screen.getByRole('button', { name: 'com_ui_discord_binding_connect' }));
    expect(await screen.findByText('com_ui_discord_binding_uncertain')).toBeVisible();
    expect(screen.getByText('com_ui_discord_binding_check_help')).toBeVisible();
  },
);

test('keeps controls disabled when an uncertain write cannot be reconciled', async () => {
  const { user } = await page();
  await ready();
  jest.mocked(dataService.bindDiscordChannel).mockRejectedValueOnce(new Error('network'));
  jest.mocked(dataService.getDiscordBinding).mockRejectedValue(new Error('read unavailable'));
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_binding_connect' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'com_ui_discord_binding_check' })).toBeEnabled(),
  );
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_binding_check' }));
  expect(screen.getByRole('button', { name: 'com_ui_discord_binding_connect' })).toBeDisabled();
  expect(screen.getByLabelText('com_ui_discord_binding_channel')).toBeDisabled();
  expect(dataService.bindDiscordChannel).toHaveBeenCalledTimes(1);
});

test('does not close the next account view when an old write resolves', async () => {
  const pending = deferred<DiscordBindingView>();
  jest.mocked(dataService.bindDiscordChannel).mockReturnValueOnce(pending.promise);
  const { user, rerender, component, onClose } = await page();
  await ready();
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_binding_connect' }));
  rerender(component('next-admin'));
  await act(async () => pending.resolve({ channel, routeRevision: 'r2' }));
  expect(onClose).not.toHaveBeenCalled();
});

test('loads a later installation page and retries only the failed cursor', async () => {
  jest
    .mocked(dataService.getDiscordGuilds)
    .mockResolvedValueOnce({
      guilds: [{ ...guild, installationId: 'other-install', status: 'disconnected' }],
      next: 'cursor/next',
    })
    .mockRejectedValueOnce(new Error('page unavailable'))
    .mockResolvedValueOnce({ guilds: [guild] });
  const { user } = await page();
  expect(screen.queryByText('com_ui_discord_binding_empty')).toBeNull();
  await user.click(await screen.findByRole('button', { name: 'com_ui_discord_more_guilds' }));
  await user.click(await screen.findByRole('button', { name: 'com_ui_retry' }));
  await ready();
  expect(jest.mocked(dataService.getDiscordGuilds).mock.calls.map(([cursor]) => cursor)).toEqual([
    undefined,
    'cursor/next',
    'cursor/next',
  ]);
});
