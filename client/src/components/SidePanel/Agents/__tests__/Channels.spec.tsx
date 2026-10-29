import React from 'react';
import userEvent from '@testing-library/user-event';
import { dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { AgentChannel, SlackChannelManifest } from 'librechat-data-provider';
import Channels from '../Channels';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  dataService: {
    ...jest.requireActual('librechat-data-provider').dataService,
    listAgentChannels: jest.fn(),
    createAgentChannel: jest.fn(),
    getAgentChannelManifest: jest.fn(),
    activateAgentChannel: jest.fn(),
    disableAgentChannel: jest.fn(),
    deleteAgentChannel: jest.fn(),
    changeAgentChannelMode: jest.fn(),
  },
}));
const pending: AgentChannel = {
  channelId: 'channel-1',
  agentId: 'agent-1',
  createdBy: 'admin-1',
  type: 'slack',
  status: 'pending_install',
  credentialMode: 'per_user',
};
const manifest: SlackChannelManifest = {
  display_information: { name: 'Test agent' },
  features: { bot_user: { display_name: 'Test agent' } },
  oauth_config: { scopes: { bot: ['app_mentions:read'] } },
  settings: {
    socket_mode_enabled: true,
    event_subscriptions: { bot_events: ['app_mention'] },
    org_deploy_enabled: false,
    token_rotation_enabled: false,
  },
};
function renderChannels({ agentId = 'agent-1', wrapInForm = false } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  const submit = jest.fn((event) => event.preventDefault());
  const component = <Channels agentId={agentId || undefined} />;
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
async function openAdd(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'com_ui_channels_add' })).toBeEnabled(),
  );
  await user.click(screen.getByRole('button', { name: 'com_ui_channels_add' }));
}
beforeEach(() => {
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
    await user.type(screen.getByLabelText('com_ui_channels_signing_secret'), 'test-secret');
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
  expect(screen.getByLabelText('com_ui_channels_signing_secret')).toHaveValue('');
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
test.each(['active', 'pending_install', 'disabled'] as const)(
  'legacy %s connection has no mode control',
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
  expect(screen.queryByText('private-error')).not.toBeInTheDocument();
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
