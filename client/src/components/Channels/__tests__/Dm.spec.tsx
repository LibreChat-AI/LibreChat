import React from 'react';
import userEvent from '@testing-library/user-event';
import { dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import type {
  ChannelLinkView,
  DiscordDmIssuedCode,
  DiscordDmSelectionView,
} from 'librechat-data-provider';
import Dm from '../Dm';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      listDiscordDmSelections: jest.fn(),
      issueDiscordDmCode: jest.fn(),
      revokeDiscordDmSelection: jest.fn(),
      channelIdentityClient: { ...actual.dataService.channelIdentityClient, list: jest.fn() },
    },
  };
});
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/data-provider', () => ({
  useGetAgentByIdQuery: () => ({ data: { name: 'Support agent' } }),
}));
const link: ChannelLinkView = {
  linkId: 'link',
  revision: 'link-v1',
  state: 'active',
  expiresAtMs: Date.now() + 3600000,
  identity: {
    provider: 'discord',
    tenantId: 'tenant',
    channelId: 'binding',
    channelRevision: 'binding-v1',
    agentId: 'agent',
    applicationId: '123',
    guildId: '456',
    externalUserId: '789',
  },
};
const selection: DiscordDmSelectionView = {
  selectionId: 'selection',
  revision: 'selection-v1',
  linkId: link.linkId,
  agentId: 'agent',
  applicationId: '123',
  dmChannelId: '999',
  expiresAtMs: Date.now() + 3600000,
  state: 'active',
};
const secret = 'private-one-time-code';
function page() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  const view = (principal = 'tenant:user') => (
    <QueryClientProvider client={client}>
      <Dm principalKey={principal} />
    </QueryClientProvider>
  );
  return { ...render(view()), client, view, user: userEvent.setup() };
}
async function openCode(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'com_ui_discord_dm_select_for' }));
  await user.click(screen.getByRole('button', { name: 'com_ui_discord_dm_generate' }));
}
beforeEach(() => {
  jest.mocked(dataService.channelIdentityClient.list).mockReset().mockResolvedValue([link]);
  jest
    .mocked(dataService.listDiscordDmSelections)
    .mockReset()
    .mockResolvedValue({ enabled: true, selections: [] });
  jest
    .mocked(dataService.issueDiscordDmCode)
    .mockReset()
    .mockResolvedValue({ code: secret, expiresAtMs: Date.now() + 60000 });
  jest.mocked(dataService.revokeDiscordDmSelection).mockReset().mockResolvedValue(null);
});

test('issues only an owned active link revision, keeps code out of query and mutation caches, and clears on close', async () => {
  const f = page();
  await openCode(f.user);
  expect(await screen.findByLabelText('com_ui_discord_dm_code')).toHaveValue(secret);
  expect(screen.getByLabelText('com_ui_discord_dm_code')).toHaveFocus();
  expect(dataService.issueDiscordDmCode).toHaveBeenCalledWith({
    linkId: 'link',
    expectedLinkRevision: 'link-v1',
  });
  const cached = JSON.stringify({
    queries: f.client
      .getQueryCache()
      .getAll()
      .map((q) => q.state),
    mutations: f.client
      .getMutationCache()
      .getAll()
      .map((m) => m.state),
  });
  expect(cached).not.toContain(secret);
  await f.user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
  await f.user.click(screen.getByRole('button', { name: 'com_ui_discord_dm_select_for' }));
  expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'com_ui_discord_dm_generate' })).toBeVisible();
});

test('ignores a code that resolves after dialog cancellation or an account switch', async () => {
  let resolve!: (value: DiscordDmIssuedCode) => void;
  jest.mocked(dataService.issueDiscordDmCode).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const f = page();
  await openCode(f.user);
  await f.user.click(screen.getByRole('button', { name: 'Cancel' }));
  f.rerender(f.view('tenant:other-user'));
  await act(async () => resolve({ code: secret, expiresAtMs: Date.now() + 60000 }));
  expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
  await f.user.click(await screen.findByRole('button', { name: 'com_ui_discord_dm_select_for' }));
  expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
  expect(
    JSON.stringify(
      f.client
        .getMutationCache()
        .getAll()
        .map((m) => m.state),
    ),
  ).not.toContain(secret);
});

test('expired codes are removed and may be regenerated', async () => {
  jest
    .mocked(dataService.issueDiscordDmCode)
    .mockResolvedValue({ code: secret, expiresAtMs: Date.now() - 1 });
  const f = page();
  await openCode(f.user);
  await screen.findByText('com_ui_discord_dm_code_expired');
  expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'com_ui_discord_dm_generate' })).toBeEnabled();
});

test('failed code issuance exposes safe guidance and permits a fresh explicit attempt', async () => {
  jest
    .mocked(dataService.issueDiscordDmCode)
    .mockRejectedValueOnce(
      Object.assign(new Error('private provider response'), { code: 'capacity' }),
    );
  const f = page();
  await openCode(f.user);
  await screen.findByText('com_ui_discord_dm_capacity');
  expect(screen.queryByText('private provider response')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('com_ui_discord_dm_code')).not.toBeInTheDocument();
  await f.user.click(screen.getByRole('button', { name: 'com_ui_discord_dm_generate' }));
  expect(await screen.findByLabelText('com_ui_discord_dm_code')).toHaveValue(secret);
});

test.each(['pending', 'accepted', 'expired', 'revoked', 'unavailable'] as const)(
  'does not offer DM selection for a %s account link',
  async (state) => {
    jest.mocked(dataService.channelIdentityClient.list).mockResolvedValue([{ ...link, state }]);
    page();
    await screen.findByText('com_ui_discord_dm_link_first');
    expect(
      screen.queryByRole('button', { name: 'com_ui_discord_dm_select_for' }),
    ).not.toBeInTheDocument();
  },
);

test('does not offer Slack links for Discord selection', async () => {
  jest.mocked(dataService.channelIdentityClient.list).mockResolvedValue([
    {
      ...link,
      identity: {
        tenantId: 'tenant',
        channelId: 'channel',
        channelRevision: 'rev',
        teamId: 'team',
        externalUserId: 'U1',
        agentId: 'agent',
      },
    },
  ]);
  page();
  await screen.findByText('com_ui_discord_dm_link_first');
  expect(
    screen.queryByRole('button', { name: 'com_ui_discord_dm_select_for' }),
  ).not.toBeInTheDocument();
});

test('disabled deployments still allow revision-fenced cleanup of unavailable selections, with cancel and focus restoration', async () => {
  jest
    .mocked(dataService.listDiscordDmSelections)
    .mockResolvedValue({ enabled: false, selections: [{ ...selection, state: 'unavailable' }] });
  const f = page();
  await screen.findByText('com_ui_discord_dm_disabled');
  expect(
    screen.queryByRole('button', { name: 'com_ui_discord_dm_select_for' }),
  ).not.toBeInTheDocument();
  const trigger = await screen.findByRole('button', { name: 'com_ui_discord_dm_revoke_for' });
  await f.user.click(trigger);
  await f.user.click(
    within(screen.getByRole('alertdialog')).getByRole('button', { name: 'com_ui_cancel' }),
  );
  expect(dataService.revokeDiscordDmSelection).not.toHaveBeenCalled();
  await waitFor(() => expect(trigger).toHaveFocus());
  await f.user.click(trigger);
  jest
    .mocked(dataService.listDiscordDmSelections)
    .mockResolvedValue({ enabled: false, selections: [{ ...selection, state: 'revoked' }] });
  await f.user.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'com_ui_discord_dm_revoke',
    }),
  );
  await waitFor(() =>
    expect(dataService.revokeDiscordDmSelection).toHaveBeenCalledWith({
      selectionId: 'selection',
      revision: 'selection-v1',
    }),
  );
  await screen.findByText('com_ui_channel_link_revoked');
  expect(
    screen.queryByRole('button', { name: 'com_ui_discord_dm_revoke_for' }),
  ).not.toBeInTheDocument();
});

test('failed revocation stays open with safe copy and refreshes server metadata', async () => {
  jest
    .mocked(dataService.listDiscordDmSelections)
    .mockResolvedValue({ enabled: true, selections: [selection] });
  jest
    .mocked(dataService.revokeDiscordDmSelection)
    .mockRejectedValue(Object.assign(new Error('private provider payload'), { code: 'changed' }));
  const f = page();
  await f.user.click(await screen.findByRole('button', { name: 'com_ui_discord_dm_revoke_for' }));
  await f.user.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'com_ui_discord_dm_revoke',
    }),
  );
  await screen.findByText('com_ui_discord_dm_changed');
  expect(screen.getByRole('alertdialog')).toBeVisible();
  expect(screen.queryByText('private provider payload')).not.toBeInTheDocument();
  await waitFor(() => expect(dataService.listDiscordDmSelections).toHaveBeenCalledTimes(2));
});

test('a failed cursor page keeps the loaded prefix and retries only that page', async () => {
  jest.mocked(dataService.listDiscordDmSelections).mockImplementation(async (cursor) => {
    if (cursor) throw new Error('temporary');
    return { enabled: true, selections: [selection], next: 'next-page' };
  });
  const f = page();
  await f.user.click(await screen.findByRole('button', { name: 'com_ui_load_more' }));
  await screen.findByText('com_ui_discord_error');
  expect(screen.getByRole('button', { name: 'com_ui_discord_dm_revoke_for' })).toBeVisible();
  jest.mocked(dataService.listDiscordDmSelections).mockImplementation(async (cursor) =>
    cursor
      ? {
          enabled: true,
          selections: [{ ...selection, selectionId: 'second', dmChannelId: '888' }],
        }
      : { enabled: true, selections: [selection], next: 'next-page' },
  );
  await f.user.click(screen.getByRole('button', { name: 'com_ui_retry' }));
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: 'com_ui_discord_dm_revoke_for' })).toHaveLength(2),
  );
  expect(jest.mocked(dataService.listDiscordDmSelections).mock.calls).toEqual([
    [undefined],
    ['next-page'],
    ['next-page'],
  ]);
});

test('an initial list failure can be retried without issuing a code', async () => {
  jest.mocked(dataService.listDiscordDmSelections).mockRejectedValueOnce(new Error('temporary'));
  const f = page();
  await f.user.click(await screen.findByRole('button', { name: 'com_ui_retry' }));
  await screen.findByText('com_ui_discord_dm_empty');
  expect(dataService.issueDiscordDmCode).not.toHaveBeenCalled();
});
