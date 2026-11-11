import React from 'react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { dataService, request, QueryKeys, MutationKeys } from 'librechat-data-provider';
import { SLACK_CHANNEL_BOT_SCOPES, SLACK_CHANNEL_BOT_EVENTS } from 'librechat-data-provider';
import type { AgentChannel, SlackChannelManifest, SlackWorkspace } from 'librechat-data-provider';
import Channels from '../Channels';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useDebounce: jest.requireActual('~/hooks/Input/useDebounce').default,
}));
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  dataService: {
    ...jest.requireActual('librechat-data-provider').dataService,
    listAgentChannels: jest.fn(),
    getSlackWorkspaces: jest.fn(),
    getSlackWorkspace: jest.fn(),
    createWorkspaceAgentChannel: jest.fn(),
    getAgentChannelWorkspaceRoutes: jest.fn(),
    getAgentChannelWorkspaceTarget: jest.fn(),
    setAgentChannelWorkspaceRoute: jest.fn(),
    removeAgentChannelWorkspaceRoute: jest.fn(),
    createAgentChannel: jest.fn(),
    getAgentChannelManifest: jest.fn(),
    activateAgentChannel: jest.fn(),
    disableAgentChannel: jest.fn(),
    deleteAgentChannel: jest.fn(),
    changeAgentChannelMode: jest.fn(),
  },
}));
const pending: AgentChannel = {
  revision: 'revision-1',
  channelId: 'channel-1',
  agentId: 'agent-1',
  createdBy: 'admin-1',
  type: 'slack',
  status: 'pending_install',
  credentialMode: 'per_user',
};
const manifest: SlackChannelManifest = {
  display_information: { name: 'Test agent' },
  features: {
    bot_user: { display_name: 'test_agent' },
    agent_view: { agent_description: 'Test agent' },
    app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
  },
  oauth_config: { scopes: { bot: [...SLACK_CHANNEL_BOT_SCOPES] } },
  settings: {
    socket_mode_enabled: true,
    event_subscriptions: { bot_events: [...SLACK_CHANNEL_BOT_EVENTS] },
    interactivity: { is_enabled: true },
    org_deploy_enabled: false,
    token_rotation_enabled: false,
  },
};
function renderChannels({
  agentId = 'agent-1',
  wrapInForm = false,
  userId = 'admin-1',
  tenantId = 'tenant-a',
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  const submit = jest.fn((event) => event.preventDefault());
  const component = <Channels agentId={agentId || undefined} userId={userId} tenantId={tenantId} />;
  const view = render(
    <QueryClientProvider client={client}>
      {wrapInForm ? (
        <form onSubmit={submit}>
          {component}
          <button type="submit">{'Save agent'}</button>
        </form>
      ) : (
        component
      )}
    </QueryClientProvider>,
  );
  return { ...view, client, submit };
}
async function openConnection(
  user: ReturnType<typeof userEvent.setup>,
  status: AgentChannel['status'] = 'pending_install',
) {
  await user.click(
    await screen.findByRole('button', {
      name: status === 'pending_install' ? 'com_ui_channels_setup' : 'com_ui_channels_manage',
    }),
  );
}
async function chooseBot(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('combobox', { name: 'com_ui_channels_slack_bot' }));
  await user.click(await screen.findByRole('option', { name: /Engineering/ }));
}
async function openAdd(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'com_ui_channels_add' })).toBeEnabled(),
  );
  await user.click(screen.getByRole('button', { name: 'com_ui_channels_add' }));
}
beforeEach(() => {
  jest
    .mocked(dataService.getSlackWorkspaces)
    .mockReset()
    .mockResolvedValue({ configured: false, canManage: false, workspaces: [] });
  jest.mocked(dataService.listAgentChannels).mockReset().mockResolvedValue([]);
  jest.mocked(dataService.createAgentChannel).mockReset().mockResolvedValue(pending);
  jest.mocked(dataService.getAgentChannelManifest).mockReset().mockResolvedValue(manifest);
  jest
    .mocked(dataService.activateAgentChannel)
    .mockReset()
    .mockResolvedValue({ ...pending, status: 'active' });
  jest
    .mocked(dataService.disableAgentChannel)
    .mockReset()
    .mockResolvedValue({ ...pending, status: 'disabled' });
  jest.mocked(dataService.deleteAgentChannel).mockReset().mockResolvedValue(undefined);
  jest
    .mocked(dataService.changeAgentChannelMode)
    .mockReset()
    .mockResolvedValue({ ...pending, status: 'disabled', credentialMode: 'shared' });
});
test('unsaved Agent shows a disabled row without fetching', () => {
  renderChannels({ agentId: '' });
  expect(screen.getByRole('heading', { name: 'com_ui_channels_title' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'com_ui_channels_add' })).toBeDisabled();
  expect(screen.getByText('com_ui_channels_save_first')).toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(dataService.listAgentChannels).not.toHaveBeenCalled();
});
test('Add opens without creating; Escape returns focus and resets mode', async () => {
  const user = userEvent.setup();
  renderChannels();
  expect(screen.queryByText('com_ui_channels_shared_notice')).not.toBeInTheDocument();
  await openAdd(user);
  expect(screen.getByRole('button', { name: 'com_ui_channel_link_per_user' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await user.click(screen.getByRole('button', { name: 'com_ui_channel_link_shared' }));
  expect(dataService.createAgentChannel).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'com_ui_channels_add' })).toHaveFocus();
  await openAdd(user);
  expect(screen.getByRole('button', { name: 'com_ui_channel_link_per_user' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});
test.each(['per_user', 'shared'] as const)(
  'Continue creates %s then activation keeps credentials write-only',
  async (mode) => {
    const user = userEvent.setup();
    jest
      .mocked(dataService.listAgentChannels)
      .mockResolvedValueOnce([])
      .mockResolvedValue([pending]);
    const { client, submit } = renderChannels({ wrapInForm: true });
    await openAdd(user);
    if (mode === 'shared')
      await user.click(screen.getByRole('button', { name: 'com_ui_channel_link_shared' }));
    await user.click(screen.getByRole('button', { name: 'com_ui_continue' }));
    await waitFor(() =>
      expect(dataService.createAgentChannel).toHaveBeenCalledWith('agent-1', mode),
    );
    expect(
      (await screen.findByText('com_ui_channels_manifest', { selector: 'summary' })).closest(
        'details',
      ),
    ).toHaveAttribute('open');
    expect(screen.getByLabelText('com_ui_channels_manifest')).toHaveValue(
      JSON.stringify(manifest, null, 2),
    );
    expect(screen.getByLabelText('com_ui_channels_manifest')).toHaveAttribute('readonly');
    expect(
      screen.queryByRole('link', { name: 'com_ui_channels_download_manifest' }),
    ).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('com_ui_channels_app_id'), 'A123{Enter}');
    expect(screen.getByLabelText('com_ui_channels_bot_token')).toHaveAttribute('type', 'password');
    await user.type(screen.getByLabelText('com_ui_channels_bot_token'), 'test-token');
    await user.type(screen.getByLabelText(/com_ui_channels_signing_secret/), 'test-secret');
    jest
      .mocked(dataService.listAgentChannels)
      .mockResolvedValue([{ ...pending, status: 'active' }]);
    await user.click(screen.getByRole('button', { name: 'com_ui_channels_activate' }));
    await waitFor(() =>
      expect(dataService.activateAgentChannel).toHaveBeenCalledWith('agent-1', 'channel-1', {
        slack: { appId: 'A123', botToken: 'test-token', signingSecret: 'test-secret' },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(submit).not.toHaveBeenCalled();
    expect(
      JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map((x) => x.state.variables),
      ),
    ).not.toContain('test-token');
  },
);
test('pending setup is resumable and closing clears secrets', async () => {
  const user = userEvent.setup();
  jest.mocked(dataService.listAgentChannels).mockResolvedValue([pending]);
  renderChannels();
  await screen.findByText('com_ui_channels_pending');
  expect(screen.queryByLabelText('com_ui_channels_bot_token')).not.toBeInTheDocument();
  await openConnection(user);
  await user.type(screen.getByLabelText('com_ui_channels_bot_token'), 'test-token');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await openConnection(user);
  expect(screen.getByLabelText('com_ui_channels_bot_token')).toHaveValue('');
  expect(screen.getByLabelText(/com_ui_channels_signing_secret/)).toHaveValue('');
  expect(dataService.deleteAgentChannel).not.toHaveBeenCalled();
});
test('manifest is a read-only definition without editing or download controls', async () => {
  const user = userEvent.setup();
  jest.mocked(dataService.listAgentChannels).mockResolvedValue([pending]);
  renderChannels();
  await openConnection(user);
  const field = await screen.findByLabelText('com_ui_channels_manifest');
  expect(field).toHaveAttribute('readonly');
  await user.type(field, 'changed');
  expect(field).toHaveValue(JSON.stringify(manifest, null, 2));
  expect(
    screen.queryByRole('link', { name: 'com_ui_channels_download_manifest' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'com_ui_channels_manifest_reset' }),
  ).not.toBeInTheDocument();
  expect(dataService.activateAgentChannel).not.toHaveBeenCalled();
});

test('active credentials require disabling before replacement', async () => {
  const user = userEvent.setup();
  jest.mocked(dataService.listAgentChannels).mockResolvedValue([{ ...pending, status: 'active' }]);
  renderChannels();
  await openConnection(user, 'active');
  expect(screen.queryByText('com_ui_channels_replace_notice')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'com_ui_channels_setup' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('com_ui_channels_bot_token')).not.toBeInTheDocument();
  jest
    .mocked(dataService.listAgentChannels)
    .mockResolvedValue([{ ...pending, status: 'disabled', revision: 'r1' }]);
  await user.click(screen.getByRole('button', { name: 'com_ui_channels_disable' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await openConnection(user, 'disabled');
  await user.click(screen.getByRole('button', { name: 'com_ui_channels_setup' }));
  expect(screen.getByLabelText('com_ui_channels_bot_token')).toHaveValue('');
});
test.each(['per_user', 'shared'] as const)(
  'Manage shows the %s connection indicator, metadata and expanded manifest',
  async (credentialMode) => {
    const user = userEvent.setup();
    jest.mocked(dataService.listAgentChannels).mockResolvedValue([
      {
        ...pending,
        status: 'active',
        credentialMode,
        slack: { teamId: 'T123', appId: 'A123', botUserId: 'B123' },
      },
    ]);
    renderChannels();
    await openConnection(user, 'active');
    const dialog = screen.getByRole('dialog');
    const type = within(dialog).getByText('com_ui_channels_connection_type').closest('div')!;
    expect(
      within(type).getByText(
        credentialMode === 'shared' ? 'com_ui_channel_link_shared' : 'com_ui_channel_link_per_user',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('channel-1')).toHaveClass('font-mono', 'text-end');
    expect(within(dialog).getByText('channel-1').closest('div')).toHaveClass('justify-between');
    expect(
      within(dialog).queryByText('com_ui_channels_manifest_description'),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByText('com_ui_channels_gateway_required')).not.toBeInTheDocument();
    expect(within(dialog).getByText('T123')).toHaveClass('font-mono');
    expect(within(dialog).getByText('A123')).toBeInTheDocument();
    expect(await within(dialog).findByLabelText('com_ui_channels_manifest')).toHaveValue(
      JSON.stringify(manifest, null, 2),
    );
    expect(
      within(dialog)
        .getByText('com_ui_channels_manifest', { selector: 'summary' })
        .closest('details'),
    ).toHaveAttribute('open');
    expect(dataService.getAgentChannelManifest).toHaveBeenCalledWith('agent-1', 'channel-1');
    expect(within(dialog).queryByLabelText('com_ui_channels_bot_token')).not.toBeInTheDocument();
    const remove = within(dialog).getByRole('button', { name: 'com_ui_delete' });
    expect(remove).toHaveClass('bg-surface-destructive');
    expect(remove.parentElement).toHaveClass('sm:justify-between');
    expect(remove.parentElement!.firstElementChild).toBe(remove);
    expect(within(dialog).queryByRole('button', { name: 'com_ui_done' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(dataService.disableAgentChannel).not.toHaveBeenCalled();
    expect(dataService.deleteAgentChannel).not.toHaveBeenCalled();
  },
);
test('manifest failure in Manage can retry without hiding connection controls', async () => {
  const user = userEvent.setup();
  jest.mocked(dataService.listAgentChannels).mockResolvedValue([{ ...pending, status: 'active' }]);
  jest
    .mocked(dataService.getAgentChannelManifest)
    .mockRejectedValueOnce(new Error('private-error'))
    .mockResolvedValue(manifest);
  renderChannels();
  await openConnection(user, 'active');
  await screen.findByText('com_ui_channels_manifest_error');
  expect(screen.getByRole('button', { name: 'com_ui_channels_disable' })).toBeEnabled();
  expect(screen.queryByText('private-error')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'com_ui_channels_retry' }));
  expect(await screen.findByLabelText('com_ui_channels_manifest')).toHaveValue(
    JSON.stringify(manifest, null, 2),
  );
});
test('mode/delete confirmations replace setup and discard secrets; mode requires revision', async () => {
  const user = userEvent.setup();
  jest
    .mocked(dataService.listAgentChannels)
    .mockResolvedValue([{ ...pending, status: 'disabled', revision: 'r1' }]);
  renderChannels();
  await openConnection(user, 'disabled');
  await user.click(screen.getByRole('button', { name: 'com_ui_channels_setup' }));
  await user.type(screen.getByLabelText('com_ui_channels_bot_token'), 'test-token');
  await user.click(screen.getByRole('button', { name: 'com_ui_channel_link_change_mode' }));
  expect(screen.queryByLabelText('com_ui_channels_bot_token')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'com_ui_delete' }));
  expect(
    screen.queryByRole('group', { name: 'com_ui_channel_link_mode_confirm' }),
  ).not.toBeInTheDocument();
  await user.click(
    within(screen.getByRole('group', { name: 'com_ui_channels_delete_confirm' })).getByRole(
      'button',
      { name: 'com_ui_cancel' },
    ),
  );
  expect(dataService.deleteAgentChannel).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'com_ui_channels_setup' }));
  expect(screen.getByLabelText('com_ui_channels_bot_token')).toHaveValue('');
  await user.click(screen.getByRole('button', { name: 'com_ui_channel_link_change_mode' }));
  expect(dataService.changeAgentChannelMode).not.toHaveBeenCalled();
  await user.click(
    within(screen.getByRole('group', { name: 'com_ui_channel_link_mode_confirm' })).getByRole(
      'button',
      { name: 'com_ui_channel_link_switch_shared' },
    ),
  );
  await waitFor(() =>
    expect(dataService.changeAgentChannelMode).toHaveBeenCalledWith(
      'agent-1',
      'channel-1',
      'shared',
      'r1',
    ),
  );
});
test.each(['active', 'pending_install'] as const)(
  '%s connection has no mode control',
  async (status) => {
    const user = userEvent.setup();
    jest.mocked(dataService.listAgentChannels).mockResolvedValue([{ ...pending, status }]);
    renderChannels();
    await openConnection(user, status);
    expect(
      screen.queryByRole('button', { name: 'com_ui_channel_link_change_mode' }),
    ).not.toBeInTheDocument();
  },
);
test('list/manifest/activation errors can retry without exposing backend details; signing secret optional', async () => {
  const user = userEvent.setup();
  jest
    .mocked(dataService.listAgentChannels)
    .mockRejectedValueOnce(new Error('private-error'))
    .mockResolvedValue([pending]);
  jest
    .mocked(dataService.getAgentChannelManifest)
    .mockRejectedValueOnce(new Error('private-error'))
    .mockResolvedValue(manifest);
  jest
    .mocked(dataService.activateAgentChannel)
    .mockRejectedValueOnce(new Error('private-error'))
    .mockResolvedValue({ ...pending, status: 'active' });
  renderChannels();
  await user.click(await screen.findByRole('button', { name: 'com_ui_channels_retry' }));
  await openConnection(user);
  await user.click(await screen.findByRole('button', { name: 'com_ui_channels_retry' }));
  await screen.findByText('com_ui_channels_manifest', { selector: 'summary' });
  await user.type(screen.getByLabelText('com_ui_channels_app_id'), 'A123');
  await user.type(screen.getByLabelText('com_ui_channels_bot_token'), 'test-token');
  await user.click(screen.getByRole('button', { name: 'com_ui_channels_activate' }));
  await screen.findByText('com_ui_channels_action_error');
  expect(screen.getByText('com_ui_channels_activation_retry')).toBeInTheDocument();
  expect(screen.getByText('com_ui_channels_signing_secret_optional')).toBeInTheDocument();
  expect(screen.queryByText('private-error')).not.toBeInTheDocument();
  expect(screen.getByLabelText('com_ui_channels_bot_token')).toHaveValue('');
  await user.type(screen.getByLabelText('com_ui_channels_bot_token'), 'test-token');
  await user.click(screen.getByRole('button', { name: 'com_ui_channels_activate' }));
  await waitFor(() =>
    expect(dataService.activateAgentChannel).toHaveBeenLastCalledWith('agent-1', 'channel-1', {
      slack: { appId: 'A123', botToken: 'test-token' },
    }),
  );
});
test('creation failure stays retryable inside Add', async () => {
  const user = userEvent.setup();
  jest.mocked(dataService.createAgentChannel).mockRejectedValueOnce(new Error('private-error'));
  renderChannels();
  await openAdd(user);
  await user.click(screen.getByRole('button', { name: 'com_ui_continue' }));
  await screen.findByText('com_ui_channels_action_error');
  expect(screen.getByRole('button', { name: 'com_ui_continue' })).toBeEnabled();
  expect(screen.queryByText('private-error')).not.toBeInTheDocument();
});
describe('asynchronous deletion refresh', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });
  const advance = (ms: number) =>
    act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  test('requires confirmation, disables draining row and stops polling after deletion', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    jest
      .mocked(dataService.listAgentChannels)
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([{ ...pending, status: 'deleting' }])
      .mockResolvedValue([]);
    renderChannels();
    await openConnection(user);
    await user.click(screen.getByRole('button', { name: 'com_ui_delete' }));
    expect(dataService.deleteAgentChannel).not.toHaveBeenCalled();
    await user.click(
      within(screen.getByRole('group', { name: 'com_ui_channels_delete_confirm' })).getByRole(
        'button',
        { name: 'com_ui_delete' },
      ),
    );
    await screen.findByText('com_ui_channels_deleting');
    expect(screen.getByRole('button', { name: 'com_ui_channels_manage' })).toBeDisabled();
    await advance(2000);
    await waitFor(() =>
      expect(screen.queryByText('com_ui_channels_deleting')).not.toBeInTheDocument(),
    );
    expect(dataService.listAgentChannels).toHaveBeenCalledTimes(3);
    await advance(10000);
    expect(dataService.listAgentChannels).toHaveBeenCalledTimes(3);
  });
  test.each(['active', 'pending_install', 'disabled', 'empty'] as const)(
    'does not poll idle %s list',
    async (status) => {
      jest
        .mocked(dataService.listAgentChannels)
        .mockResolvedValue(status === 'empty' ? [] : [{ ...pending, status }]);
      renderChannels();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'com_ui_channels_add' })).toBeEnabled(),
      );
      await advance(10000);
      expect(dataService.listAgentChannels).toHaveBeenCalledTimes(1);
    },
  );
  test('mixed list stops polling when deleting row disappears', async () => {
    const active: AgentChannel = { ...pending, channelId: 'channel-active', status: 'active' };
    jest
      .mocked(dataService.listAgentChannels)
      .mockResolvedValueOnce([active, { ...pending, status: 'deleting' }])
      .mockResolvedValue([active]);
    renderChannels();
    await screen.findByText('com_ui_channels_deleting');
    await advance(2000);
    await waitFor(() =>
      expect(screen.queryByText('com_ui_channels_deleting')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('com_ui_channels_active')).toBeInTheDocument();
    await advance(10000);
    expect(dataService.listAgentChannels).toHaveBeenCalledTimes(2);
  });
  test('refetch error stops polling until successful manual retry', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    jest
      .mocked(dataService.listAgentChannels)
      .mockResolvedValueOnce([{ ...pending, status: 'deleting' }])
      .mockRejectedValueOnce(new Error('private-error'))
      .mockResolvedValueOnce([{ ...pending, status: 'deleting' }])
      .mockResolvedValue([]);
    renderChannels();
    await screen.findByText('com_ui_channels_deleting');
    await advance(2000);
    await screen.findByText('com_ui_channels_list_error');
    expect(screen.getByRole('button', { name: 'com_ui_channels_manage' })).toBeDisabled();
    await advance(10000);
    expect(dataService.listAgentChannels).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: 'com_ui_channels_retry' }));
    await waitFor(() => expect(dataService.listAgentChannels).toHaveBeenCalledTimes(3));
    await advance(2000);
    await waitFor(() =>
      expect(screen.queryByText('com_ui_channels_deleting')).not.toBeInTheDocument(),
    );
    expect(dataService.listAgentChannels).toHaveBeenCalledTimes(4);
  });
  test('unmount stops polling', async () => {
    jest
      .mocked(dataService.listAgentChannels)
      .mockResolvedValue([{ ...pending, status: 'deleting' }]);
    const { unmount } = renderChannels();
    await screen.findByText('com_ui_channels_deleting');
    unmount();
    await advance(10000);
    expect(dataService.listAgentChannels).toHaveBeenCalledTimes(1);
  });
});

test('does not read or create channels before the owner is available', () => {
  renderChannels({ userId: '' });
  expect(dataService.listAgentChannels).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'com_ui_channels_add' })).toBeDisabled();
});

test.each(['pending_install', 'active', 'disabled'] as const)(
  'foreign %s connections are read-only without owner-only requests',
  async (status) => {
    jest
      .mocked(dataService.listAgentChannels)
      .mockResolvedValue([{ ...pending, status, createdBy: 'another-owner' }]);
    renderChannels();
    expect(await screen.findByRole('button', { name: 'com_ui_channels_read_only' })).toBeDisabled();
    expect(dataService.getAgentChannelManifest).not.toHaveBeenCalled();
    expect(dataService.activateAgentChannel).not.toHaveBeenCalled();
    expect(dataService.disableAgentChannel).not.toHaveBeenCalled();
    expect(dataService.deleteAgentChannel).not.toHaveBeenCalled();
  },
);

test('requires the signing secret advertised by a webhook manifest before activation', async () => {
  const user = userEvent.setup();
  jest.mocked(dataService.listAgentChannels).mockResolvedValue([pending]);
  jest.mocked(dataService.getAgentChannelManifest).mockResolvedValue({
    ...manifest,
    settings: { ...manifest.settings, socket_mode_enabled: false },
  });
  renderChannels();
  await openConnection(user);
  await user.type(screen.getByLabelText('com_ui_channels_app_id'), 'A123');
  await user.type(screen.getByLabelText('com_ui_channels_bot_token'), 'test-token');
  const activate = screen.getByRole('button', { name: 'com_ui_channels_activate' });
  expect(activate).toBeDisabled();
  const signing = screen.getByLabelText(/com_ui_channels_signing_secret/);
  expect(signing).toBeRequired();
  expect(screen.getByText('com_ui_channels_signing_secret_required')).toBeInTheDocument();
  expect(screen.queryByText('com_ui_channels_signing_secret_optional')).not.toBeInTheDocument();
  await user.type(signing, 'test-secret');
  expect(activate).toBeEnabled();
  await user.click(activate);
  expect(dataService.activateAgentChannel).toHaveBeenCalledWith('agent-1', 'channel-1', {
    slack: { appId: 'A123', botToken: 'test-token', signingSecret: 'test-secret' },
  });
});

test('does not send credentials when the installation manifest is unavailable', async () => {
  const user = userEvent.setup();
  jest.mocked(dataService.listAgentChannels).mockResolvedValue([pending]);
  jest.mocked(dataService.getAgentChannelManifest).mockRejectedValue(new Error('offline'));
  renderChannels();
  await openConnection(user);
  await user.type(screen.getByLabelText('com_ui_channels_app_id'), 'A123');
  await user.type(screen.getByLabelText('com_ui_channels_bot_token'), 'test-token');
  await user.type(screen.getByLabelText(/com_ui_channels_signing_secret/), 'test-secret');
  expect(screen.getByRole('button', { name: 'com_ui_channels_activate' })).toBeDisabled();
  expect(dataService.activateAgentChannel).not.toHaveBeenCalled();
});

test('a late operation for A cannot close B or discard B credentials', async () => {
  const user = userEvent.setup();
  const second = { ...pending, channelId: 'channel-2' };
  jest.mocked(dataService.listAgentChannels).mockResolvedValue([pending, second]);
  let finish!: (channel: AgentChannel) => void;
  jest.mocked(dataService.activateAgentChannel).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  renderChannels();
  await user.click((await screen.findAllByRole('button', { name: 'com_ui_channels_setup' }))[0]);
  await user.type(screen.getByLabelText('com_ui_channels_app_id'), 'A123');
  await user.type(screen.getByLabelText('com_ui_channels_bot_token'), 'A-token');
  await user.click(screen.getByRole('button', { name: 'com_ui_channels_activate' }));
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await user.click(screen.getAllByRole('button', { name: 'com_ui_channels_setup' })[1]);
  await user.type(screen.getByLabelText('com_ui_channels_bot_token'), 'B-token');
  await act(async () => {
    finish({ ...pending, status: 'active' });
  });
  await waitFor(() =>
    expect(screen.getByLabelText('com_ui_channels_bot_token')).toHaveValue('B-token'),
  );
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(dataService.activateAgentChannel).toHaveBeenCalledTimes(1);
});

test('the actual activation adapter prevents credential-bearing failures reaching the mutation cache', async () => {
  const user = userEvent.setup();
  jest.mocked(dataService.listAgentChannels).mockResolvedValue([pending]);
  jest
    .mocked(dataService.activateAgentChannel)
    .mockImplementation(
      jest.requireActual('librechat-data-provider').dataService.activateAgentChannel,
    );
  const unsafe = Object.assign(new Error('test-token'), {
    config: { data: JSON.stringify({ botToken: 'test-token', signingSecret: 'test-secret' }) },
    request: { authorization: 'test-token' },
  });
  const patch = jest.spyOn(request, 'patch').mockRejectedValueOnce(unsafe);
  const { client } = renderChannels();
  try {
    await openConnection(user);
    await user.type(screen.getByLabelText('com_ui_channels_app_id'), 'A123');
    await user.type(screen.getByLabelText('com_ui_channels_bot_token'), 'test-token');
    await user.type(screen.getByLabelText(/com_ui_channels_signing_secret/), 'test-secret');
    await user.click(screen.getByRole('button', { name: 'com_ui_channels_activate' }));
    await screen.findByText('com_ui_channels_action_error');
    await user.keyboard('{Escape}');
    const errors = client
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state.error);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual(new Error('Channel credential update failed'));
    expect(errors[0]).not.toBe(unsafe);
    const cache = JSON.stringify(
      client
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state),
    );
    expect(cache).not.toContain('test-token');
    expect(cache).not.toContain('test-secret');
  } finally {
    patch.mockRestore();
  }
});

test('switching owner isolates channel caches and discards the old credential form', async () => {
  const user = userEvent.setup();
  jest.mocked(dataService.listAgentChannels).mockResolvedValue([pending]);
  const mounted = renderChannels();
  await openConnection(user);
  await user.type(screen.getByLabelText('com_ui_channels_bot_token'), 'Owner-A-secret');
  jest
    .mocked(dataService.listAgentChannels)
    .mockResolvedValue([{ ...pending, channelId: 'channel-2', createdBy: 'admin-2' }]);
  mounted.rerender(
    <QueryClientProvider client={mounted.client}>
      <Channels agentId="agent-1" userId="admin-2" tenantId="tenant-b" />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await openConnection(user);
  expect(screen.getByLabelText('com_ui_channels_bot_token')).toHaveValue('');
  expect(dataService.getAgentChannelManifest).toHaveBeenLastCalledWith('agent-1', 'channel-2');
  expect(
    mounted.client.getQueryData([QueryKeys.agentChannels, 'admin-1', 'tenant-a', 'agent-1']),
  ).not.toEqual(
    mounted.client.getQueryData([QueryKeys.agentChannels, 'admin-2', 'tenant-b', 'agent-1']),
  );
});

test.each(['success', 'failure', 'pending-close'] as const)(
  'cached activation callbacks cannot reuse credentials after %s',
  async (outcome) => {
    const user = userEvent.setup();
    jest.mocked(dataService.listAgentChannels).mockResolvedValue([pending]);
    let settle!: (value: AgentChannel) => void;
    if (outcome === 'failure')
      jest
        .mocked(dataService.activateAgentChannel)
        .mockRejectedValueOnce(new Error('safe failure'));
    if (outcome === 'pending-close')
      jest.mocked(dataService.activateAgentChannel).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
      );
    const { client } = renderChannels();
    await openConnection(user);
    await user.type(screen.getByLabelText('com_ui_channels_app_id'), 'A123');
    await user.type(screen.getByLabelText('com_ui_channels_bot_token'), 'one-use-token');
    await user.type(screen.getByLabelText(/com_ui_channels_signing_secret/), 'one-use-secret');
    await user.click(screen.getByRole('button', { name: 'com_ui_channels_activate' }));
    await waitFor(() => expect(dataService.activateAgentChannel).toHaveBeenCalledTimes(1));
    const cached = client.getMutationCache().find<AgentChannel | void, Error, 'activate'>({
      mutationKey: [MutationKeys.agentChannels, 'admin-1', 'tenant-a', 'agent-1', 'channel-1'],
      exact: true,
    });
    expect(cached?.options.mutationFn).toEqual(expect.any(Function));
    if (outcome === 'failure') {
      await screen.findByText('com_ui_channels_action_error');
      expect(screen.getByLabelText('com_ui_channels_bot_token')).toHaveValue('');
      expect(screen.getByLabelText(/com_ui_channels_signing_secret/)).toHaveValue('');
    } else if (outcome === 'pending-close') {
      await user.keyboard('{Escape}');
    } else {
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    }
    await act(async () => {
      await expect(cached?.options.mutationFn?.('activate')).rejects.toThrow(/unavailable/);
    });
    expect(dataService.activateAgentChannel).toHaveBeenCalledTimes(1);
    expect(dataService.activateAgentChannel).toHaveBeenCalledWith('agent-1', 'channel-1', {
      slack: { appId: 'A123', botToken: 'one-use-token', signingSecret: 'one-use-secret' },
    });
    if (outcome === 'pending-close')
      await act(async () => settle({ ...pending, status: 'active' }));
  },
);

test('a completed closed operation cannot close a new dialog for the same channel', async () => {
  const user = userEvent.setup();
  jest.mocked(dataService.listAgentChannels).mockResolvedValue([pending]);
  let finish!: (value: AgentChannel) => void;
  jest.mocked(dataService.activateAgentChannel).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  renderChannels();
  await openConnection(user);
  await user.type(screen.getByLabelText('com_ui_channels_app_id'), 'A123');
  await user.type(screen.getByLabelText('com_ui_channels_bot_token'), 'old-operation-token');
  await user.click(screen.getByRole('button', { name: 'com_ui_channels_activate' }));
  await waitFor(() => expect(dataService.activateAgentChannel).toHaveBeenCalledTimes(1));
  await user.keyboard('{Escape}');
  await openConnection(user);
  await user.type(screen.getByLabelText('com_ui_channels_bot_token'), 'new-dialog-token');
  await act(async () => finish({ ...pending, status: 'active' }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByLabelText('com_ui_channels_bot_token')).toHaveValue('new-dialog-token');
  expect(dataService.activateAgentChannel).toHaveBeenCalledTimes(1);
});

test('channel creation explains the transaction prerequisite', async () => {
  const user = userEvent.setup();
  jest.mocked(dataService.createAgentChannel).mockRejectedValueOnce({
    isAxiosError: true,
    response: { status: 503, data: { error: 'transactions_unavailable' } },
  });
  renderChannels();
  await openAdd(user);
  await user.click(screen.getByRole('button', { name: 'com_ui_continue' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'com_ui_channels_transaction_required',
  );
  expect(screen.getByRole('button', { name: 'com_ui_continue' })).toBeEnabled();
});

test('the activation adapter preserves only the approved setup code and clears credentials', async () => {
  const user = userEvent.setup();
  jest.mocked(dataService.listAgentChannels).mockResolvedValue([pending]);
  jest
    .mocked(dataService.activateAgentChannel)
    .mockImplementation(
      jest.requireActual('librechat-data-provider').dataService.activateAgentChannel,
    );
  const patch = jest.spyOn(request, 'patch').mockRejectedValueOnce({
    isAxiosError: true,
    response: { status: 503, data: { error: 'transactions_unavailable', secret: 'test-secret' } },
    config: { data: 'test-token' },
    request: { authorization: 'test-token' },
  });
  const { client } = renderChannels();
  try {
    await openConnection(user);
    await user.type(screen.getByLabelText('com_ui_channels_app_id'), 'A123');
    await user.type(screen.getByLabelText('com_ui_channels_bot_token'), 'test-token');
    await user.click(screen.getByRole('button', { name: 'com_ui_channels_activate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'com_ui_channels_transaction_required',
    );
    expect(screen.getByLabelText('com_ui_channels_bot_token')).toHaveValue('');
    const mutations = client.getMutationCache().getAll();
    expect(mutations[0].state.error).toMatchObject({ code: 'transactions_unavailable' });
    expect(JSON.stringify(mutations.map((mutation) => mutation.state))).not.toMatch(
      /test-token|test-secret/,
    );
  } finally {
    patch.mockRestore();
  }
});

describe('organization workspace connections', () => {
  const workspace: SlackWorkspace = {
    canManageBot: true,
    workspaceId: 'workspace-1',
    tenantId: 'tenant-a',
    appId: 'A123',
    teamId: 'T123',
    teamName: 'Engineering',
    botUserId: 'U123',
    status: 'active',
    revision: 'installation-1',
    scopes: [],
  };
  const configured: AgentChannel = { ...pending, workspaceId: workspace.workspaceId };
  let rows: AgentChannel[];
  beforeEach(() => {
    rows = [];
    jest.mocked(dataService.listAgentChannels).mockImplementation(async () => rows);
    jest.mocked(dataService.getSlackWorkspaces).mockResolvedValue({
      configured: true,
      canManage: true,
      workspaces: [workspace],
    });
    jest
      .mocked(dataService.getSlackWorkspace)
      .mockReset()
      .mockResolvedValue({ configured: true, canManage: true, workspace });
    jest
      .mocked(dataService.createWorkspaceAgentChannel)
      .mockReset()
      .mockImplementation(async () => {
        rows = [configured];
        return configured;
      });
    jest
      .mocked(dataService.getAgentChannelWorkspaceRoutes)
      .mockReset()
      .mockResolvedValue({ routes: [] });
    jest
      .mocked(dataService.getAgentChannelWorkspaceTarget)
      .mockReset()
      .mockResolvedValue({ canReplace: true, occupied: false, assignedToThisChannel: false });
    jest
      .mocked(dataService.setAgentChannelWorkspaceRoute)
      .mockReset()
      .mockImplementation(async () => {
        const active: AgentChannel = {
          ...configured,
          status: 'active',
          revision: 'active-revision',
        };
        rows = [active];
        return active;
      });
    jest
      .mocked(dataService.removeAgentChannelWorkspaceRoute)
      .mockReset()
      .mockResolvedValue(undefined);
  });
  test('chooses a saved workspace and requires explicit confirmation before replacing another agent', async () => {
    const user = userEvent.setup();
    jest.mocked(dataService.getAgentChannelWorkspaceTarget).mockResolvedValue({
      canReplace: true,
      occupied: true,
      assignedToThisChannel: false,
      revision: 'observed-route',
    });
    const { submit } = renderChannels({ wrapInForm: true });
    await openAdd(user);
    await chooseBot(user);
    await user.click(screen.getByRole('button', { name: 'com_ui_continue' }));
    const activate = await screen.findByRole('button', {
      name: 'com_ui_channels_workspace_replace_assignment',
    });
    expect(
      screen.getByRole('link', { name: 'com_ui_channels_workspace_open_bot' }),
    ).toHaveAttribute('href', 'https://slack.com/app_redirect?app=A123&team=T123');
    expect(screen.getAllByText('com_ui_channels_workspace_not_assigned').length).toBeGreaterThan(0);
    expect(screen.queryByText('com_ui_channels_pending')).not.toBeInTheDocument();
    await waitFor(() => expect(activate).toBeEnabled());
    expect(screen.queryByText('com_ui_channels_workspace_routes')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'com_ui_channels_workspace_delete_connection' }),
    ).not.toBeInTheDocument();
    await user.click(activate);
    expect(dataService.setAgentChannelWorkspaceRoute).not.toHaveBeenCalled();
    const confirmation = screen.getByRole('dialog', {
      name: 'com_ui_channels_workspace_replace_assignment',
    });
    expect(screen.queryByLabelText('com_ui_channels_bot_token')).not.toBeInTheDocument();
    await user.click(
      within(confirmation).getByRole('button', {
        name: 'com_ui_channels_workspace_replace_assignment',
      }),
    );
    await screen.findByText('com_ui_channels_active');
    expect(dataService.createWorkspaceAgentChannel).toHaveBeenCalledWith('agent-1', 'workspace-1');
    expect(dataService.setAgentChannelWorkspaceRoute).toHaveBeenCalledWith('agent-1', 'channel-1', {
      channelRevision: 'revision-1',
      externalChannelId: undefined,
      expectedRevision: 'observed-route',
    });
    expect(dataService.createAgentChannel).not.toHaveBeenCalled();
    expect(dataService.activateAgentChannel).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
  test('cancelling setup leaves a manageable draft with no empty assignment section', async () => {
    const user = userEvent.setup();
    renderChannels();
    await openAdd(user);
    await chooseBot(user);
    await user.click(screen.getByRole('button', { name: 'com_ui_continue' }));
    await screen.findByRole('button', { name: 'com_ui_channels_workspace_assign' });
    await user.click(screen.getByRole('button', { name: 'com_ui_cancel' }));
    await openConnection(user, 'active');
    await screen.findByRole('button', { name: 'com_ui_channels_workspace_add_assignment' });
    expect(screen.queryByText('com_ui_channels_workspace_routes')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('group', { name: 'com_ui_channels_workspace_target' }),
    ).not.toBeInTheDocument();
    const remove = screen.getByRole('button', {
      name: 'com_ui_channels_workspace_delete_connection',
    });
    await user.click(remove);
    const confirmation = screen.getByRole('dialog', {
      name: 'com_ui_channels_workspace_delete_connection',
    });
    await user.click(within(confirmation).getByRole('button', { name: /Cancel/i }));
    expect(remove).toHaveFocus();
    expect(dataService.deleteAgentChannel).not.toHaveBeenCalled();
    jest.mocked(dataService.deleteAgentChannel).mockImplementationOnce(async () => {
      rows = [];
    });
    await user.click(remove);
    await user.click(
      within(
        screen.getByRole('dialog', { name: 'com_ui_channels_workspace_delete_connection' }),
      ).getByRole('button', { name: 'com_ui_channels_workspace_delete_connection' }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'com_ui_channels_manage' }),
      ).not.toBeInTheDocument(),
    );
    expect(dataService.deleteAgentChannel).toHaveBeenCalledWith('agent-1', 'channel-1');
  });

  test('requires fresh confirmation if an assignment changes while the replacement dialog is open', async () => {
    let revision = 'observed-route';
    jest.mocked(dataService.getAgentChannelWorkspaceTarget).mockImplementation(async () => ({
      canReplace: true,
      occupied: true,
      assignedToThisChannel: false,
      revision,
    }));
    const user = userEvent.setup();
    const { client } = renderChannels();
    await openAdd(user);
    await chooseBot(user);
    await user.click(screen.getByRole('button', { name: 'com_ui_continue' }));
    await user.click(
      await screen.findByRole('button', { name: 'com_ui_channels_workspace_replace_assignment' }),
    );
    revision = 'newer-route';
    await act(async () => {
      await client.invalidateQueries([QueryKeys.agentChannelWorkspaceTarget]);
    });
    const confirmation = screen.getByRole('dialog', {
      name: 'com_ui_channels_workspace_replace_assignment',
    });
    expect(
      await within(confirmation).findByText('com_ui_channels_workspace_replacement_changed'),
    ).toBeVisible();
    expect(
      within(confirmation).getByRole('button', {
        name: 'com_ui_channels_workspace_replace_assignment',
      }),
    ).toBeDisabled();
    expect(dataService.setAgentChannelWorkspaceRoute).not.toHaveBeenCalled();
    await user.click(within(confirmation).getByRole('button', { name: /Cancel/i }));
    await user.click(
      screen.getByRole('button', { name: 'com_ui_channels_workspace_replace_assignment' }),
    );
    await user.click(
      within(
        screen.getByRole('dialog', { name: 'com_ui_channels_workspace_replace_assignment' }),
      ).getByRole('button', { name: 'com_ui_channels_workspace_replace_assignment' }),
    );
    await waitFor(() =>
      expect(dataService.setAgentChannelWorkspaceRoute).toHaveBeenCalledWith(
        'agent-1',
        'channel-1',
        expect.objectContaining({ expectedRevision: 'newer-route' }),
      ),
    );
  });

  test('ungranted bots are not offered for a new connection', async () => {
    jest.mocked(dataService.getSlackWorkspaces).mockResolvedValue({
      configured: true,
      canManage: false,
      workspaces: [{ ...workspace, canManageBot: false }],
    });
    const user = userEvent.setup();
    renderChannels();
    await openAdd(user);
    await screen.findByText('com_ui_channels_workspace_connect_first');
    expect(screen.queryByRole('button', { name: 'Engineering' })).not.toBeInTheDocument();
    expect(dataService.createWorkspaceAgentChannel).not.toHaveBeenCalled();
  });

  test('a stale setup page cannot replace an assignment after bot management is revoked', async () => {
    jest
      .mocked(dataService.getSlackWorkspaces)
      .mockResolvedValue({ configured: true, canManage: false, workspaces: [workspace] });
    jest
      .mocked(dataService.getSlackWorkspace)
      .mockResolvedValue({ configured: true, canManage: false, workspace });
    jest.mocked(dataService.getAgentChannelWorkspaceTarget).mockResolvedValue({
      occupied: true,
      assignedToThisChannel: false,
      canReplace: false,
      revision: 'other-route',
    });
    const user = userEvent.setup();
    renderChannels();
    await openAdd(user);
    await chooseBot(user);
    await user.click(screen.getByRole('button', { name: 'com_ui_continue' }));
    await screen.findByText('com_ui_channels_bot_access_required');
    expect(
      screen.getByRole('button', { name: 'com_ui_channels_workspace_replace_assignment' }),
    ).toBeDisabled();
    expect(
      screen.queryByRole('checkbox', { name: 'com_ui_channels_workspace_replace' }),
    ).not.toBeInTheDocument();
    expect(dataService.createWorkspaceAgentChannel).toHaveBeenCalledWith('agent-1', 'workspace-1');
    expect(dataService.setAgentChannelWorkspaceRoute).not.toHaveBeenCalled();
  });

  test('refreshes a committed channel revision when an assignment response is lost', async () => {
    jest.mocked(dataService.setAgentChannelWorkspaceRoute).mockImplementationOnce(async () => {
      rows = [{ ...configured, status: 'active', revision: 'committed-revision' }];
      throw new Error('Response lost after commit');
    });
    const user = userEvent.setup();
    renderChannels();
    await openAdd(user);
    await chooseBot(user);
    await user.click(screen.getByRole('button', { name: 'com_ui_continue' }));
    await user.click(
      await screen.findByRole('button', { name: 'com_ui_channels_workspace_assign' }),
    );
    await screen.findByRole('alert');
    await screen.findAllByText('com_ui_channels_active');
    await user.click(screen.getByRole('button', { name: 'com_ui_channels_workspace_assign' }));
    await waitFor(() =>
      expect(dataService.setAgentChannelWorkspaceRoute).toHaveBeenLastCalledWith(
        'agent-1',
        'channel-1',
        expect.objectContaining({ channelRevision: 'committed-revision' }),
      ),
    );
  });

  test('waits for the current channel target instead of submitting a previous lookup while typing', async () => {
    rows = [{ ...configured, status: 'active' }];
    const user = userEvent.setup();
    renderChannels();
    await openConnection(user, 'active');
    await user.click(
      await screen.findByRole('button', { name: 'com_ui_channels_workspace_add_assignment' }),
    );
    const defaultOption = await screen.findByRole('radio', {
      name: 'com_ui_channels_workspace_default',
    });
    expect(defaultOption).toHaveAttribute('aria-checked', 'true');
    defaultOption.focus();
    await user.keyboard('{ArrowRight}');
    expect(
      screen.getByRole('radio', { name: 'com_ui_channels_workspace_specific' }),
    ).toHaveAttribute('aria-checked', 'true');
    await user.type(screen.getByLabelText('com_ui_channels_workspace_channel_id'), 'C999');
    const assign = screen.getByRole('button', { name: 'com_ui_channels_workspace_assign' });
    expect(assign).toBeDisabled();
    await waitFor(() => expect(assign).toBeEnabled());
    await user.click(assign);
    expect(dataService.setAgentChannelWorkspaceRoute).toHaveBeenCalledWith(
      'agent-1',
      'channel-1',
      expect.objectContaining({ externalChannelId: 'C999' }),
    );
  });
  test('lets members manage their own routes without installation administration', async () => {
    rows = [{ ...configured, status: 'active' }];
    jest
      .mocked(dataService.getSlackWorkspace)
      .mockResolvedValue({ configured: true, canManage: false, workspace });
    const user = userEvent.setup();
    renderChannels();
    await openConnection(user, 'active');
    await user.click(
      await screen.findByRole('button', { name: 'com_ui_channels_workspace_add_assignment' }),
    );
    await screen.findByRole('button', { name: 'com_ui_channels_workspace_assign' });
    expect(dataService.getAgentChannelWorkspaceRoutes).toHaveBeenCalled();
    expect(dataService.getAgentChannelWorkspaceTarget).toHaveBeenCalled();
    expect(screen.queryByText('com_ui_slack_workspaces_admin')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_cancel' })).toBeEnabled();
  });
  test('shows assignment status instead of a disabled action for the selected destination', async () => {
    rows = [{ ...configured, status: 'active' }];
    jest
      .mocked(dataService.getAgentChannelWorkspaceTarget)
      .mockImplementation(async (_agent, _channel, destination) => ({
        canReplace: true,
        occupied: destination === undefined,
        assignedToThisChannel: destination === undefined,
        revision: destination === undefined ? 'owned-route' : undefined,
      }));
    const user = userEvent.setup();
    renderChannels();
    await openConnection(user, 'active');
    await user.click(
      await screen.findByRole('button', { name: 'com_ui_channels_workspace_add_assignment' }),
    );
    await screen.findByText('com_ui_channels_workspace_assigned');
    expect(
      screen.queryByRole('button', { name: 'com_ui_channels_workspace_assign' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'com_ui_channels_workspace_specific' }));
    await user.type(screen.getByLabelText('com_ui_channels_workspace_channel_id'), 'C999');
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'com_ui_channels_workspace_assign' }),
      ).toBeEnabled(),
    );
    expect(screen.queryByText('com_ui_channels_workspace_assigned')).not.toBeInTheDocument();
    expect(dataService.setAgentChannelWorkspaceRoute).not.toHaveBeenCalled();
  });

  test.each([undefined, 'C123'])(
    'offers additional assignments only without a default (destination=%s)',
    async (externalChannelId) => {
      rows = [{ ...configured, status: 'active' }];
      jest.mocked(dataService.getAgentChannelWorkspaceRoutes).mockResolvedValue({
        routes: [{ externalChannelId, revision: 'route-1' }],
      });
      const user = userEvent.setup();
      renderChannels();
      await openConnection(user, 'active');
      await screen.findByRole('button', { name: 'com_ui_channels_workspace_remove_route' });
      const add = screen.queryByRole('button', {
        name: 'com_ui_channels_workspace_add_assignment',
      });
      if (externalChannelId) expect(add).toBeEnabled();
      else expect(add).not.toBeInTheDocument();
    },
  );

  test.each([undefined, 'C123'])(
    'reactivates a disabled connection using its retained assignment (destination=%s)',
    async (externalChannelId) => {
      rows = [{ ...configured, status: 'active' }];
      const retained = { externalChannelId, revision: 'retained-route' };
      jest
        .mocked(dataService.getAgentChannelWorkspaceRoutes)
        .mockResolvedValue({ routes: [retained] });
      jest.mocked(dataService.getAgentChannelWorkspaceTarget).mockResolvedValue({
        canReplace: true,
        occupied: true,
        assignedToThisChannel: true,
        revision: retained.revision,
      });
      jest.mocked(dataService.disableAgentChannel).mockImplementation(async () => {
        rows = [{ ...configured, status: 'disabled', revision: 'disabled-revision' }];
        return rows[0];
      });
      const user = userEvent.setup();
      renderChannels();
      await openConnection(user, 'active');
      await user.click(await screen.findByRole('button', { name: 'com_ui_channels_disable' }));
      await openConnection(user, 'disabled');
      await user.click(await screen.findByRole('button', { name: 'com_ui_channels_activate' }));
      if (externalChannelId) {
        expect(screen.getByLabelText('com_ui_channels_workspace_channel_id')).toHaveValue(
          externalChannelId,
        );
      }
      const assign = await screen.findByRole('button', {
        name: 'com_ui_channels_workspace_assign',
      });
      await waitFor(() => expect(assign).toBeEnabled());
      await user.click(assign);
      await screen.findByText('com_ui_channels_active');
      expect(dataService.setAgentChannelWorkspaceRoute).toHaveBeenCalledWith(
        'agent-1',
        'channel-1',
        {
          channelRevision: 'disabled-revision',
          externalChannelId,
          expectedRevision: retained.revision,
        },
      );
      expect(dataService.removeAgentChannelWorkspaceRoute).not.toHaveBeenCalled();
    },
  );

  test('removes a selected route only after confirmation and keeps the connection active', async () => {
    rows = [{ ...configured, status: 'active' }];
    let routes = [{ externalChannelId: 'C123', revision: 'route-1' }];
    jest
      .mocked(dataService.getAgentChannelWorkspaceRoutes)
      .mockImplementation(async () => ({ routes }));
    jest.mocked(dataService.removeAgentChannelWorkspaceRoute).mockImplementation(async () => {
      routes = [];
    });
    const user = userEvent.setup();
    renderChannels();
    await openConnection(user, 'active');
    await user.click(
      await screen.findByRole('button', { name: 'com_ui_channels_workspace_remove_route' }),
    );
    expect(dataService.removeAgentChannelWorkspaceRoute).not.toHaveBeenCalled();
    await user.click(
      within(
        screen.getByRole('dialog', { name: 'com_ui_channels_workspace_remove_assignment' }),
      ).getByRole('button', { name: 'com_ui_channels_workspace_remove_assignment' }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'com_ui_channels_workspace_remove_route' }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByText('com_ui_channels_workspace_routes')).not.toBeInTheDocument();
    expect(dataService.removeAgentChannelWorkspaceRoute).toHaveBeenCalledWith(
      'agent-1',
      'channel-1',
      { externalChannelId: 'C123', expectedRevision: 'route-1' },
    );
    expect(rows[0].status).toBe('active');
    expect(dataService.deleteAgentChannel).not.toHaveBeenCalled();
    expect(dataService.disableAgentChannel).not.toHaveBeenCalled();
  });
  test.each([404, 410])(
    'shows an unavailable connection for HTTP %s without fetching assignments',
    async (status) => {
      rows = [{ ...configured, status: 'disabled' }];
      jest.mocked(dataService.getSlackWorkspace).mockRejectedValue({
        isAxiosError: true,
        response: { status, data: { private: 'not-for-display' } },
      });
      const user = userEvent.setup();
      renderChannels();
      await openConnection(user, 'disabled');
      const dialog = screen.getByRole('dialog');
      await within(dialog).findByText('com_ui_channels_workspace_unavailable');
      expect(within(dialog).getByText('com_ui_channels_slack_connection')).toBeInTheDocument();
      expect(
        within(dialog).getByText('com_ui_channels_workspace_unavailable_status'),
      ).toBeInTheDocument();
      expect(dialog).toHaveFocus();
      expect(within(dialog).queryByRole('tooltip')).not.toBeInTheDocument();
      expect(
        within(dialog).queryByRole('button', { name: 'com_ui_retry' }),
      ).not.toBeInTheDocument();
      expect(
        within(dialog).queryByRole('button', { name: 'com_ui_channels_workspace_add_assignment' }),
      ).not.toBeInTheDocument();
      expect(
        within(dialog).queryByRole('button', { name: 'com_ui_channels_disable' }),
      ).not.toBeInTheDocument();
      expect(dataService.getAgentChannelWorkspaceRoutes).not.toHaveBeenCalled();
      expect(dataService.getAgentChannelWorkspaceTarget).not.toHaveBeenCalled();
      expect(screen.queryByText('not-for-display')).not.toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'com_ui_close' }));
      expect(screen.getByRole('button', { name: 'com_ui_channels_manage' })).toHaveFocus();
    },
  );

  test.each(['disconnected', 'unconfigured'] as const)(
    'treats a successfully loaded %s installation as unavailable',
    async (state) => {
      rows = [{ ...configured, status: 'disabled' }];
      jest.mocked(dataService.getSlackWorkspace).mockResolvedValue({
        configured: state !== 'unconfigured',
        canManage: true,
        workspace: { ...workspace, status: state === 'disconnected' ? 'disconnected' : 'active' },
      });
      const user = userEvent.setup();
      renderChannels();
      await openConnection(user, 'disabled');
      await screen.findByText('com_ui_channels_workspace_unavailable');
      expect(screen.getByRole('dialog')).toHaveTextContent('Engineering');
      expect(
        screen.queryByRole('link', { name: 'com_ui_channels_workspace_open_bot' }),
      ).not.toBeInTheDocument();
      expect(dataService.getAgentChannelWorkspaceRoutes).not.toHaveBeenCalled();
      expect(dataService.getAgentChannelWorkspaceTarget).not.toHaveBeenCalled();
    },
  );

  test.each([401, 403])(
    'distinguishes denied access (%s) from a missing connection',
    async (status) => {
      rows = [{ ...configured, status: 'active' }];
      jest
        .mocked(dataService.getSlackWorkspace)
        .mockRejectedValue({ isAxiosError: true, response: { status } });
      const user = userEvent.setup();
      renderChannels();
      await openConnection(user, 'active');
      await screen.findByText('com_ui_channels_workspace_access_denied');
      expect(screen.queryByText('com_ui_channels_workspace_unavailable')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'com_ui_retry' })).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'com_ui_channels_workspace_delete_connection' }),
      ).toBeEnabled();
      expect(dataService.getAgentChannelWorkspaceRoutes).not.toHaveBeenCalled();
      expect(dataService.getAgentChannelWorkspaceTarget).not.toHaveBeenCalled();
    },
  );

  test.each([undefined, 503])(
    'retries a temporary workspace read failure (%s) and restores assignment management',
    async (status) => {
      rows = [{ ...configured, status: 'disabled' }];
      jest
        .mocked(dataService.getSlackWorkspace)
        .mockRejectedValueOnce({ isAxiosError: true, response: status ? { status } : undefined });
      const user = userEvent.setup();
      renderChannels();
      await openConnection(user, 'disabled');
      await screen.findByText('com_ui_channels_workspace_load_error');
      expect(screen.queryByText('com_ui_channels_workspace_unavailable')).not.toBeInTheDocument();
      expect(dataService.getAgentChannelWorkspaceRoutes).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'com_ui_retry' }));
      await user.click(
        await screen.findByRole('button', { name: 'com_ui_channels_workspace_add_assignment' }),
      );
      const assign = await screen.findByRole('button', {
        name: 'com_ui_channels_workspace_assign',
      });
      await waitFor(() => expect(assign).toBeEnabled());
      expect(dataService.getAgentChannelWorkspaceTarget).toHaveBeenCalled();
    },
  );

  test('a failed refresh cannot leave cached assignment controls active', async () => {
    rows = [{ ...configured, status: 'active' }];
    const user = userEvent.setup();
    const { client } = renderChannels();
    await openConnection(user, 'active');
    await user.click(
      await screen.findByRole('button', { name: 'com_ui_channels_workspace_add_assignment' }),
    );
    await screen.findByRole('button', { name: 'com_ui_channels_workspace_assign' });
    const routeReads = jest.mocked(dataService.getAgentChannelWorkspaceRoutes).mock.calls.length;
    const targetReads = jest.mocked(dataService.getAgentChannelWorkspaceTarget).mock.calls.length;
    jest
      .mocked(dataService.getSlackWorkspace)
      .mockRejectedValue({ isAxiosError: true, response: { status: 404 } });
    await act(async () => {
      await client.invalidateQueries([QueryKeys.slackWorkspaces]);
    });
    await screen.findByText('com_ui_channels_workspace_unavailable');
    expect(screen.getByRole('dialog')).toHaveTextContent('Engineering');
    expect(
      screen.queryByRole('group', { name: 'com_ui_channels_workspace_target' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'com_ui_channels_workspace_assign' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'com_ui_channels_disable' }),
    ).not.toBeInTheDocument();
    expect(dataService.getAgentChannelWorkspaceRoutes).toHaveBeenCalledTimes(routeReads);
    expect(dataService.getAgentChannelWorkspaceTarget).toHaveBeenCalledTimes(targetReads);
    expect(
      screen.getByRole('button', { name: 'com_ui_channels_workspace_delete_connection' }),
    ).toBeEnabled();
  });

  test('can confirm, retry and cancel deletion even when the installation is unavailable', async () => {
    rows = [{ ...configured, status: 'disabled' }];
    jest
      .mocked(dataService.getSlackWorkspace)
      .mockRejectedValue({ isAxiosError: true, response: { status: 404 } });
    jest
      .mocked(dataService.deleteAgentChannel)
      .mockRejectedValueOnce(new Error('private-error'))
      .mockImplementationOnce(async () => {
        rows = [];
      });
    const user = userEvent.setup();
    renderChannels();
    await openConnection(user, 'disabled');
    await screen.findByText('com_ui_channels_workspace_unavailable');
    const remove = screen.getByRole('button', {
      name: 'com_ui_channels_workspace_delete_connection',
    });
    await user.click(remove);
    let confirmation = screen.getByRole('dialog', {
      name: 'com_ui_channels_workspace_delete_connection',
    });
    expect(dataService.deleteAgentChannel).not.toHaveBeenCalled();
    await user.click(within(confirmation).getByRole('button', { name: /Cancel/i }));
    expect(remove).toHaveFocus();
    await user.click(remove);
    confirmation = screen.getByRole('dialog', {
      name: 'com_ui_channels_workspace_delete_connection',
    });
    await user.click(
      within(confirmation).getByRole('button', {
        name: 'com_ui_channels_workspace_delete_connection',
      }),
    );
    await within(confirmation).findByRole('alert');
    expect(screen.queryByText('private-error')).not.toBeInTheDocument();
    await user.click(
      within(confirmation).getByRole('button', {
        name: 'com_ui_channels_workspace_delete_connection',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(dataService.deleteAgentChannel).toHaveBeenCalledTimes(2);
  });

  test('revoked bot management hides Add while retaining stop and remove for the owner', async () => {
    rows = [{ ...configured, status: 'active' }];
    jest.mocked(dataService.getSlackWorkspace).mockResolvedValue({
      configured: true,
      canManage: false,
      workspace: { ...workspace, canManageBot: false },
    });
    jest
      .mocked(dataService.getAgentChannelWorkspaceRoutes)
      .mockResolvedValue({ routes: [{ externalChannelId: 'C123', revision: 'route-1' }] });
    const user = userEvent.setup();
    renderChannels();
    await openConnection(user, 'active');
    await screen.findByText('com_ui_channels_bot_access_required');
    expect(
      screen.queryByRole('button', { name: 'com_ui_channels_workspace_add_assignment' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_channels_disable' })).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'com_ui_channels_workspace_delete_connection' }),
    ).toBeEnabled();
    expect(
      await screen.findByRole('button', { name: 'com_ui_channels_workspace_remove_route' }),
    ).toBeEnabled();
    expect(dataService.getAgentChannelWorkspaceTarget).not.toHaveBeenCalled();
  });
  test('waits for installation metadata before loading assignments', async () => {
    rows = [{ ...configured, status: 'disabled' }];
    let finish!: (value: Awaited<ReturnType<typeof dataService.getSlackWorkspace>>) => void;
    jest.mocked(dataService.getSlackWorkspace).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const user = userEvent.setup();
    renderChannels();
    await openConnection(user, 'disabled');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('status')).toHaveTextContent('com_ui_channels_loading');
    expect(
      within(dialog).queryByText('com_ui_channels_workspace_unavailable'),
    ).not.toBeInTheDocument();
    expect(dataService.getAgentChannelWorkspaceRoutes).not.toHaveBeenCalled();
    expect(dataService.getAgentChannelWorkspaceTarget).not.toHaveBeenCalled();
    await act(async () => finish({ configured: true, canManage: true, workspace }));
    await screen.findByRole('button', { name: 'com_ui_channels_workspace_add_assignment' });
    expect(dataService.getAgentChannelWorkspaceRoutes).toHaveBeenCalled();
  });
  test('shared setup offers a searchable bot picker without manual source controls or automatic selection', async () => {
    const bots = Array.from({ length: 20 }, (_, index) => ({
      ...workspace,
      workspaceId: `workspace-${index}`,
      appId: `A${index}XYZ`,
      appName: 'Same bot',
      teamName: `Team ${index}`,
    }));
    jest
      .mocked(dataService.getSlackWorkspaces)
      .mockResolvedValue({ configured: true, canManage: true, workspaces: bots });
    const user = userEvent.setup();
    renderChannels();
    await openAdd(user);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveFocus();
    expect(
      screen.queryByRole('button', { name: 'com_ui_channels_org_workspace' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'com_ui_channels_manual_app' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'com_ui_channel_link_shared' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_channels_workspace_identity')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_continue' })).toBeDisabled();
    const picker = await screen.findByRole('combobox', { name: 'com_ui_channels_slack_bot' });
    expect(
      screen.getByText('com_ui_channels_slack_bot', { selector: 'label:not(.sr-only)' }),
    ).toHaveAttribute('for', picker.id);
    await user.click(picker);
    await user.type(screen.getByPlaceholderText('com_ui_channels_slack_bot_search'), 'A19XYZ');
    const option = await screen.findByRole('option', { name: /Same bot.*Team 19.*A19XYZ/ });
    expect(within(option).getByText('Same bot')).toBeInTheDocument();
    expect(within(option).getByText(/Team 19/)).toHaveClass('text-text-secondary');
    await user.click(option);
    expect(picker).toHaveTextContent('Same bot');
    await user.click(screen.getByRole('button', { name: 'com_ui_continue' }));
    await waitFor(() =>
      expect(dataService.createWorkspaceAgentChannel).toHaveBeenCalledWith(
        'agent-1',
        'workspace-19',
      ),
    );
    expect(dataService.createAgentChannel).not.toHaveBeenCalled();
  });

  test('fallback bot labels keep app IDs searchable and closing Add resets selection', async () => {
    const user = userEvent.setup();
    renderChannels();
    await openAdd(user);
    await chooseBot(user);
    expect(screen.getByRole('combobox', { name: 'com_ui_channels_slack_bot' })).toHaveTextContent(
      'com_ui_channels_slack_app_fallback',
    );
    await user.click(screen.getByRole('button', { name: 'com_ui_cancel' }));
    await openAdd(user);
    expect(screen.getByRole('button', { name: 'com_ui_continue' })).toBeDisabled();
  });

  test('a selected bot disappearing on refresh cannot create a connection', async () => {
    const user = userEvent.setup();
    const { client } = renderChannels();
    await openAdd(user);
    await chooseBot(user);
    jest
      .mocked(dataService.getSlackWorkspaces)
      .mockResolvedValue({ configured: true, canManage: true, workspaces: [] });
    await act(async () => {
      await client.invalidateQueries([QueryKeys.slackWorkspaces]);
    });
    await screen.findByText('com_ui_channels_workspace_connect_first');
    expect(screen.getByRole('button', { name: 'com_ui_continue' })).toBeDisabled();
    expect(dataService.createWorkspaceAgentChannel).not.toHaveBeenCalled();
    expect(dataService.createAgentChannel).not.toHaveBeenCalled();
  });

  test('workspace loading never falls back to manual credentials', async () => {
    let finish!: (value: Awaited<ReturnType<typeof dataService.getSlackWorkspaces>>) => void;
    jest.mocked(dataService.getSlackWorkspaces).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const user = userEvent.setup();
    renderChannels();
    await openAdd(user);
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_channels_loading');
    expect(
      screen.queryByRole('button', { name: 'com_ui_channel_link_shared' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_continue' })).toBeDisabled();
    await act(async () => finish({ configured: true, canManage: true, workspaces: [workspace] }));
    await screen.findByRole('combobox', { name: 'com_ui_channels_slack_bot' });
    expect(dataService.createAgentChannel).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    'workspace read failure blocks creation instead of falling back to manual (cached=%s)',
    async (cached) => {
      const user = userEvent.setup();
      if (!cached)
        jest.mocked(dataService.getSlackWorkspaces).mockRejectedValue(new Error('private-error'));
      const { client } = renderChannels();
      await openAdd(user);
      if (cached) {
        await chooseBot(user);
        jest.mocked(dataService.getSlackWorkspaces).mockRejectedValue(new Error('private-error'));
        await act(async () => {
          await client.invalidateQueries([QueryKeys.slackWorkspaces]);
        });
      }
      await screen.findByText('com_ui_channels_workspace_load_error');
      expect(
        screen.queryByRole('button', { name: 'com_ui_channel_link_shared' }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'com_ui_continue' })).toBeDisabled();
      expect(screen.queryByText('private-error')).not.toBeInTheDocument();
      jest
        .mocked(dataService.getSlackWorkspaces)
        .mockResolvedValue({ configured: true, canManage: true, workspaces: [workspace] });
      await user.click(screen.getByRole('button', { name: 'com_ui_retry' }));
      await screen.findByRole('combobox', { name: 'com_ui_channels_slack_bot' });
      expect(
        screen.queryByRole('button', { name: 'com_ui_channel_link_shared' }),
      ).not.toBeInTheDocument();
      expect(dataService.createAgentChannel).not.toHaveBeenCalled();
    },
  );
  test('loading another page keeps the selected picker visible while creation waits', async () => {
    let finish!: (value: Awaited<ReturnType<typeof dataService.getSlackWorkspaces>>) => void;
    jest.mocked(dataService.getSlackWorkspaces).mockImplementation(async (cursor) => {
      if (cursor)
        return new Promise((resolve) => {
          finish = resolve;
        });
      return { configured: true, canManage: true, workspaces: [workspace], next: 'page-2' };
    });
    const user = userEvent.setup();
    renderChannels();
    await openAdd(user);
    await chooseBot(user);
    const picker = screen.getByRole('combobox', { name: 'com_ui_channels_slack_bot' });
    const more = screen.getByRole('button', { name: 'com_ui_slack_workspaces_more' });
    await user.click(more);
    expect(picker).toBeInTheDocument();
    expect(picker).toBeDisabled();
    expect(more).toBeInTheDocument();
    expect(more).toBeDisabled();
    expect(screen.getByRole('button', { name: 'com_ui_continue' })).toBeDisabled();
    await act(async () => finish({ configured: true, canManage: true, workspaces: [] }));
    await waitFor(() => expect(picker).toBeEnabled());
    expect(picker).toHaveTextContent('com_ui_channels_slack_app_fallback');
    expect(screen.getByRole('button', { name: 'com_ui_continue' })).toBeEnabled();
  });
});
