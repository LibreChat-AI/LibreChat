import React from 'react';
import userEvent from '@testing-library/user-event';
import { dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import type {
  Agent,
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
      getAgentById: jest.fn(),
      listDiscordDmSelections: jest.fn(),
      issueDiscordDmCode: jest.fn(),
      revokeDiscordDmSelection: jest.fn(),
      channelIdentityClient: { ...actual.dataService.channelIdentityClient, list: jest.fn() },
    },
  };
});
const mockClipboard = jest.fn();
jest.mock('copy-to-clipboard', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockClipboard(...args),
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
  await user.click(
    await screen.findByRole('button', {
      name: /^Use in Direct Messages: agent agent, Discord user 789/,
    }),
  );
  await user.click(screen.getByRole('button', { name: 'Generate Code' }));
}
beforeEach(() => {
  mockClipboard.mockReset().mockReturnValue(true);
  jest
    .mocked(dataService.getAgentById)
    .mockReset()
    .mockResolvedValue({ name: 'Support agent' } as Agent);
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
  expect(await screen.findByLabelText('Selection code')).toHaveValue(secret);
  expect(screen.getByLabelText('Selection code')).toHaveFocus();
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
  await f.user.click(
    screen.getByRole('button', { name: /^Use in Direct Messages: agent agent, Discord user 789/ }),
  );
  expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Generate Code' })).toBeVisible();
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
  await f.user.click(
    await screen.findByRole('button', {
      name: /^Use in Direct Messages: agent agent, Discord user 789/,
    }),
  );
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
  await screen.findByText('This code has expired. Generate a new code to continue.');
  expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Generate Code' })).toBeEnabled();
});

test('failed code issuance exposes safe guidance and permits a fresh explicit attempt', async () => {
  jest
    .mocked(dataService.issueDiscordDmCode)
    .mockRejectedValueOnce(
      Object.assign(new Error('private provider response'), { code: 'capacity' }),
    );
  const f = page();
  await openCode(f.user);
  await screen.findByText(
    'Too many pending selections. Wait for an unused code to expire, then try again.',
  );
  expect(screen.queryByText('private provider response')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Selection code')).not.toBeInTheDocument();
  await f.user.click(screen.getByRole('button', { name: 'Generate Code' }));
  expect(await screen.findByLabelText('Selection code')).toHaveValue(secret);
});

test.each(['pending', 'accepted', 'expired', 'revoked', 'unavailable'] as const)(
  'does not offer DM selection for a %s account link',
  async (state) => {
    jest.mocked(dataService.channelIdentityClient.list).mockResolvedValue([{ ...link, state }]);
    page();
    await screen.findByText(
      'Link your Discord account to an agent in a server channel and confirm it in Discord before selecting that agent for direct messages.',
    );
    expect(
      screen.queryByRole('button', {
        name: /^Use in Direct Messages: agent agent, Discord user 789/,
      }),
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
  await screen.findByText(
    'Link your Discord account to an agent in a server channel and confirm it in Discord before selecting that agent for direct messages.',
  );
  expect(
    screen.queryByRole('button', {
      name: /^Use in Direct Messages: agent agent, Discord user 789/,
    }),
  ).not.toBeInTheDocument();
});

test('disabled deployments still allow revision-fenced cleanup of unavailable selections, with cancel and focus restoration', async () => {
  jest
    .mocked(dataService.listDiscordDmSelections)
    .mockResolvedValue({ enabled: false, selections: [{ ...selection, state: 'unavailable' }] });
  const f = page();
  await screen.findByText(
    'New Discord DM selections are disabled. You can still revoke existing selections.',
  );
  expect(
    screen.queryByRole('button', {
      name: /^Use in Direct Messages: agent agent, Discord user 789/,
    }),
  ).not.toBeInTheDocument();
  const trigger = await screen.findByRole('button', {
    name: /^Revoke DM Selection: agent agent, channel 999$/,
  });
  await f.user.click(trigger);
  await f.user.click(
    within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }),
  );
  expect(dataService.revokeDiscordDmSelection).not.toHaveBeenCalled();
  await waitFor(() => expect(trigger).toHaveFocus());
  await f.user.click(trigger);
  jest
    .mocked(dataService.listDiscordDmSelections)
    .mockResolvedValue({ enabled: false, selections: [{ ...selection, state: 'revoked' }] });
  await f.user.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Revoke DM Selection',
    }),
  );
  await waitFor(() =>
    expect(dataService.revokeDiscordDmSelection).toHaveBeenCalledWith({
      selectionId: 'selection',
      revision: 'selection-v1',
    }),
  );
  await screen.findByText('Revoked');
  expect(
    screen.queryByRole('button', { name: /^Revoke DM Selection: agent agent, channel 999$/ }),
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
  await f.user.click(
    await screen.findByRole('button', { name: /^Revoke DM Selection: agent agent, channel 999$/ }),
  );
  await f.user.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Revoke DM Selection',
    }),
  );
  await screen.findByText(
    'This link or selection is no longer available. Refresh the list and try again.',
  );
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
  await f.user.click(await screen.findByRole('button', { name: 'Load more' }));
  await screen.findByText(
    'The operation could not be confirmed. Refresh the configuration before trying again.',
  );
  expect(
    screen.getByRole('button', { name: /^Revoke DM Selection: agent agent, channel 999$/ }),
  ).toBeVisible();
  jest.mocked(dataService.listDiscordDmSelections).mockImplementation(async (cursor) =>
    cursor
      ? {
          enabled: true,
          selections: [{ ...selection, selectionId: 'second', dmChannelId: '888' }],
        }
      : { enabled: true, selections: [selection], next: 'next-page' },
  );
  await f.user.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() =>
    expect(
      screen.getAllByRole('button', {
        name: /^Revoke DM Selection: agent agent, channel (?:999|888)$/,
      }),
    ).toHaveLength(2),
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
  await f.user.click(await screen.findByRole('button', { name: 'Retry' }));
  await screen.findByRole('button', { name: /^Use for DMs/ });
  expect(dataService.issueDiscordDmCode).not.toHaveBeenCalled();
});

test('shows the agent name once it loads and falls back to the id when it cannot be read', async () => {
  let resolve!: (agent: Agent) => void;
  jest.mocked(dataService.getAgentById).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  jest
    .mocked(dataService.listDiscordDmSelections)
    .mockResolvedValue({ enabled: true, selections: [{ ...selection, agentId: 'agent_abc123' }] });
  jest
    .mocked(dataService.channelIdentityClient.list)
    .mockResolvedValue([{ ...link, identity: { ...link.identity, agentId: 'agent_abc123' } }]);
  const first = page();
  expect((await screen.findAllByText('Channel agent')).length).toBeGreaterThan(0);
  await waitFor(() => expect(dataService.getAgentById).toHaveBeenCalled());
  await act(async () => resolve({ name: 'Support agent' } as Agent));
  expect((await screen.findAllByText('Support agent')).length).toBeGreaterThan(0);
  first.unmount();
  jest.mocked(dataService.getAgentById).mockReset().mockRejectedValue({ status: 404 });
  page();
  await waitFor(() => expect(screen.getAllByText('agent_abc123').length).toBeGreaterThan(0));
  expect(screen.queryByText('Support agent')).not.toBeInTheDocument();
});

test('copies the temporary selection code explicitly and offers manual copy on failure', async () => {
  const f = page();
  await openCode(f.user);
  await f.user.click(await screen.findByRole('button', { name: 'Copy code' }));
  expect(mockClipboard).toHaveBeenCalledWith(
    secret,
    expect.objectContaining({ format: 'text/plain' }),
  );
  expect(screen.getByRole('button', { name: 'Copied' })).toBeVisible();
  mockClipboard.mockReturnValue(false);
  await f.user.click(screen.getByRole('button', { name: 'Copied' }));
  expect(
    await screen.findByText('Select the link below to copy it manually.'),
  ).toBeVisible();
  expect(screen.getByLabelText('Selection code')).toHaveValue(secret);
  await f.user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('button', { name: 'Copy code' })).not.toBeInTheDocument();
});
