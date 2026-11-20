import React from 'react';
import userEvent from '@testing-library/user-event';
import { QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import type { ChannelIdentityClient, ChannelLinkView } from 'librechat-data-provider';
import Links from './Links';
import Link from './Link';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
const mockAgentQuery = jest.fn((agentId: string) =>
  agentId === 'missing-agent'
    ? { data: undefined, isLoading: false }
    : { data: { name: 'Support agent' } },
);
jest.mock('~/data-provider', () => ({
  useGetAgentByIdQuery: (agentId: string) => mockAgentQuery(agentId),
}));
const pending: ChannelLinkView = {
  identity: {
    tenantId: 'tenant',
    channelId: 'channel',
    channelRevision: 'c-rev',
    teamId: 'T1',
    externalUserId: 'U1',
    agentId: 'agent',
  },
  linkId: 'link',
  revision: 'revision',
  state: 'pending',
  expiresAtMs: Date.now() + 60000,
};
let api: jest.Mocked<ChannelIdentityClient>;
function renderPage(element: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  return {
    client,
    ...render(<QueryClientProvider client={client}>{element}</QueryClientProvider>),
  };
}
beforeEach(() => {
  window.history.replaceState({}, '', '/channels/link');
  api = {
    preview: jest.fn().mockResolvedValue({ ok: true, value: pending }),
    accept: jest.fn().mockImplementation(async () => {
      const result = { ok: true as const, value: { ...pending, state: 'accepted' as const } };
      api.preview.mockResolvedValue(result);
      return result;
    }),
    list: jest.fn().mockResolvedValue([{ ...pending, state: 'active' }]),
    revoke: jest.fn().mockResolvedValue({ ok: true, value: { ...pending, state: 'revoked' } }),
  };
});

test('preview is read-only, clears the fragment, and requires explicit acceptance then Slack confirmation', async () => {
  const user = userEvent.setup();
  window.history.replaceState({}, '', '/channels/link#private-ticket');
  const { client } = renderPage(
    <Link api={api} accountLabel="Account A" principalKey="tenant:user-a" />,
  );
  await screen.findByText('U1');
  expect(window.location.hash).toBe('');
  expect(api.preview).toHaveBeenCalledWith('private-ticket');
  expect(api.accept).not.toHaveBeenCalled();
  expect(
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ),
  ).not.toContain('private-ticket');
  await user.click(screen.getByRole('button', { name: 'com_ui_channel_link_accept' }));
  await waitFor(() =>
    expect(api.accept).toHaveBeenCalledWith({
      ticket: 'private-ticket',
      expectedRevision: 'revision',
    }),
  );
  expect(await screen.findByRole('status')).toHaveTextContent('com_ui_channel_link_confirm_slack');
  expect(
    screen.queryByRole('button', { name: 'com_ui_channel_link_accept' }),
  ).not.toBeInTheDocument();
});

test('expired or failed tickets cannot activate a link or expose server error text', async () => {
  api.preview.mockResolvedValue({ ok: false, error: { code: 'expired' } });
  renderPage(
    <Link api={api} accountLabel="Account A" principalKey="tenant:user-a" ticket="ticket" />,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_channel_link_expired');
  expect(
    screen.queryByRole('button', { name: 'com_ui_channel_link_accept' }),
  ).not.toBeInTheDocument();
  expect(api.accept).not.toHaveBeenCalled();
});

test('missing ticket cannot issue any link API calls', () => {
  renderPage(<Link api={api} accountLabel="Account A" principalKey="tenant:user-a" />);
  expect(screen.getByRole('alert')).toHaveTextContent('com_ui_channel_link_invalid');
  expect(api.preview).not.toHaveBeenCalled();
  expect(api.accept).not.toHaveBeenCalled();
});

test('personal revocation requires confirmation and uses exact link revision', async () => {
  const user = userEvent.setup();
  renderPage(<Links api={api} principalKey="tenant:user-a" />);
  await user.click(await screen.findByRole('button', { name: /com_ui_channel_link_revoke_for/ }));
  expect(api.revoke).not.toHaveBeenCalled();
  const confirmation = screen.getByRole('dialog', { name: 'com_ui_channel_link_revoke_title' });
  api.list.mockResolvedValue([{ ...pending, state: 'revoked' }]);
  await user.click(
    within(confirmation).getByRole('button', { name: 'com_ui_channel_link_revoke' }),
  );
  await waitFor(() => expect(api.revoke).toHaveBeenCalledWith('link', 'revision'));
  expect(await screen.findByText('com_ui_channel_link_revoked')).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /com_ui_channel_link_revoke/ }),
  ).not.toBeInTheDocument();
});

test.each([
  ['active', 'com_ui_channel_link_active'],
  ['expired', 'com_ui_channel_link_expired'],
  ['revoked', 'com_ui_channel_link_revoked'],
  ['unavailable', 'com_ui_channel_link_unavailable'],
] as const)('a current %s preview replaces an earlier acceptance receipt', async (state, label) => {
  const user = userEvent.setup();
  const { client } = renderPage(
    <Link api={api} accountLabel="Account A" principalKey="tenant:user-a" ticket="ticket" />,
  );
  await user.click(await screen.findByRole('button', { name: 'com_ui_channel_link_accept' }));
  expect(await screen.findByRole('status')).toHaveTextContent('com_ui_channel_link_confirm_slack');
  api.preview.mockResolvedValue({ ok: true, value: { ...pending, state } });
  await act(async () => {
    await client.invalidateQueries([QueryKeys.channelLinkTicket]);
  });
  expect(await screen.findByText(label)).toBeInTheDocument();
  expect(screen.queryByText('com_ui_channel_link_confirm_slack')).not.toBeInTheDocument();
  expect(api.accept).toHaveBeenCalledTimes(1);
});

test.each(['expired', 'revoked'] as const)(
  'a current %s preview error replaces an earlier acceptance receipt',
  async (code) => {
    const user = userEvent.setup();
    const { client } = renderPage(
      <Link api={api} accountLabel="Account A" principalKey="tenant:user-a" ticket="ticket" />,
    );
    await user.click(await screen.findByRole('button', { name: 'com_ui_channel_link_accept' }));
    await screen.findByRole('status');
    api.preview.mockResolvedValue({ ok: false, error: { code } });
    await act(async () => {
      await client.invalidateQueries([QueryKeys.channelLinkTicket]);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(`com_ui_channel_link_${code}`);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  },
);

test('an expired successful preview explains how to recover without offering acceptance', async () => {
  api.preview.mockResolvedValue({ ok: true, value: { ...pending, state: 'expired' } });
  renderPage(
    <Link api={api} accountLabel="Account A" principalKey="tenant:user-a" ticket="ticket" />,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_channel_link_expired');
  expect(
    screen.queryByRole('button', { name: 'com_ui_channel_link_accept' }),
  ).not.toBeInTheDocument();
});

test('a link that cannot be used gets its own heading, no stepper and a way back', async () => {
  api.preview.mockResolvedValue({ ok: true, value: { ...pending, state: 'revoked' } });
  renderPage(
    <Link api={api} accountLabel="Account A" principalKey="tenant:user-a" ticket="ticket" />,
  );
  expect(
    await screen.findByRole('heading', { name: 'com_ui_channel_link_unusable_title' }),
  ).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'com_ui_channel_link_steps' })).toBeNull();
  expect(screen.getByRole('link', { name: 'com_ui_channel_link_go_home' })).toHaveAttribute(
    'href',
    '/',
  );
  expect(screen.queryByRole('button', { name: 'com_ui_channel_link_accept' })).toBeNull();
});

test('the way back keeps a subdirectory deployment inside the app', async () => {
  const base = document.createElement('base');
  base.setAttribute('href', '/librechat/');
  document.head.append(base);
  try {
    api.preview.mockResolvedValue({ ok: true, value: { ...pending, state: 'revoked' } });
    renderPage(
      <Link api={api} accountLabel="Account A" principalKey="tenant:user-a" ticket="ticket" />,
    );
    expect(
      await screen.findByRole('link', { name: 'com_ui_channel_link_go_home' }),
    ).toHaveAttribute('href', '/librechat/');
  } finally {
    base.remove();
  }
});

test('a pending link past its expiry says so instead of leaving a silent disabled button', async () => {
  api.preview.mockResolvedValue({
    ok: true,
    value: { ...pending, expiresAtMs: Date.now() - 1000 },
  });
  renderPage(
    <Link api={api} accountLabel="Account A" principalKey="tenant:user-a" ticket="ticket" />,
  );
  expect(await screen.findByText('com_ui_channel_link_expired')).toBeInTheDocument();
  expect(
    screen.getByRole('heading', { name: 'com_ui_channel_link_unusable_title' }),
  ).toBeInTheDocument();
});

test('keeps a rejected revocation visible and refreshes its revision before retry', async () => {
  const user = userEvent.setup();
  api.revoke.mockResolvedValueOnce({ ok: false, error: { code: 'changed' } });
  renderPage(<Links api={api} principalKey="tenant:user-a" />);
  await user.click(await screen.findByRole('button', { name: /com_ui_channel_link_revoke_for/ }));
  const dialog = screen.getByRole('dialog', { name: 'com_ui_channel_link_revoke_title' });
  api.list.mockResolvedValue([{ ...pending, state: 'active', revision: 'fresh-revision' }]);
  await user.click(within(dialog).getByRole('button', { name: 'com_ui_channel_link_revoke' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('com_ui_channel_link_changed');
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(
      within(dialog).getByRole('button', { name: 'com_ui_channel_link_revoke' }),
    ).toBeEnabled(),
  );
  api.list.mockResolvedValue([{ ...pending, state: 'revoked' }]);
  await user.click(within(dialog).getByRole('button', { name: 'com_ui_channel_link_revoke' }));
  await waitFor(() => expect(api.revoke).toHaveBeenLastCalledWith('link', 'fresh-revision'));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('an unavailable personal connection remains explicitly revocable', async () => {
  const user = userEvent.setup();
  api.list.mockResolvedValue([{ ...pending, state: 'unavailable' }]);
  renderPage(<Links api={api} principalKey="tenant:user-a" />);
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent(
      'com_ui_channels_workspace_unavailable_status',
    ),
  );
  await user.click(screen.getByRole('button', { name: /com_ui_channel_link_revoke_for/ }));
  api.list.mockResolvedValue([{ ...pending, state: 'revoked' }]);
  await user.click(
    within(screen.getByRole('dialog', { name: 'com_ui_channel_link_revoke_title' })).getByRole(
      'button',
      {
        name: 'com_ui_channel_link_revoke',
      },
    ),
  );
  expect(api.revoke).toHaveBeenCalledWith('link', 'revision');
  expect(await screen.findByText('com_ui_channel_link_revoked')).toBeInTheDocument();
});

test('a late acceptance failure after unmount does not refetch under a new session', async () => {
  const user = userEvent.setup();
  let fail!: (error: Error) => void;
  api.accept.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  const mounted = renderPage(
    <Link api={api} accountLabel="Account A" principalKey="tenant:user-a" ticket="ticket" />,
  );
  await user.click(await screen.findByRole('button', { name: 'com_ui_channel_link_accept' }));
  mounted.unmount();
  await act(async () => {
    fail(new Error('late lost acknowledgement'));
  });
  expect(api.preview).toHaveBeenCalledTimes(1);
});

test('an earlier in-flight preview cannot roll back successful acceptance', async () => {
  const user = userEvent.setup();
  let accept!: (value: Awaited<ReturnType<ChannelIdentityClient['accept']>>) => void;
  let oldPreview!: (value: Awaited<ReturnType<ChannelIdentityClient['preview']>>) => void;
  api.accept.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        accept = resolve;
      }),
  );
  const { client } = renderPage(
    <Link api={api} accountLabel="Account A" principalKey="tenant:user-a" ticket="ticket" />,
  );
  await user.click(await screen.findByRole('button', { name: 'com_ui_channel_link_accept' }));
  api.preview.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        oldPreview = resolve;
      }),
  );
  act(() => {
    void client.invalidateQueries([QueryKeys.channelLinkTicket]);
  });
  await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
  api.preview.mockResolvedValue({ ok: true, value: { ...pending, state: 'accepted' } });
  await act(async () => {
    accept({ ok: true, value: { ...pending, state: 'accepted' } });
  });
  expect(await screen.findByRole('status')).toHaveTextContent('com_ui_channel_link_confirm_slack');
  await act(async () => {
    oldPreview({ ok: true, value: pending });
  });
  expect(screen.getByRole('status')).toHaveTextContent('com_ui_channel_link_confirm_slack');
  expect(
    screen.queryByRole('button', { name: 'com_ui_channel_link_accept' }),
  ).not.toBeInTheDocument();
});

test('a delayed acceptance acknowledgement cannot replace a newer active preview', async () => {
  const user = userEvent.setup();
  let accept!: (value: Awaited<ReturnType<ChannelIdentityClient['accept']>>) => void;
  api.accept.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        accept = resolve;
      }),
  );
  const { client } = renderPage(
    <Link api={api} accountLabel="Account A" principalKey="tenant:user-a" ticket="ticket" />,
  );
  await user.click(await screen.findByRole('button', { name: 'com_ui_channel_link_accept' }));
  api.preview.mockResolvedValue({ ok: true, value: { ...pending, state: 'active' } });
  await act(async () => {
    await client.invalidateQueries([QueryKeys.channelLinkTicket]);
  });
  expect(await screen.findByRole('status')).toHaveTextContent('com_ui_channel_link_active');
  await act(async () => {
    accept({ ok: true, value: { ...pending, state: 'accepted' } });
  });
  expect(screen.getByRole('status')).toHaveTextContent('com_ui_channel_link_active');
  expect(screen.queryByText('com_ui_channel_link_confirm_slack')).not.toBeInTheDocument();
});

test('a lost acknowledgement reconciles successful acceptance without offering a duplicate retry', async () => {
  const user = userEvent.setup();
  api.accept.mockImplementationOnce(async () => {
    api.preview.mockResolvedValue({ ok: true, value: { ...pending, state: 'accepted' } });
    throw new Error('lost acknowledgement');
  });
  renderPage(
    <Link api={api} accountLabel="Account A" principalKey="tenant:user-a" ticket="ticket" />,
  );
  await user.click(await screen.findByRole('button', { name: 'com_ui_channel_link_accept' }));
  expect(await screen.findByRole('status')).toHaveTextContent('com_ui_channel_link_confirm_slack');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'com_ui_retry' })).not.toBeInTheDocument();
});

test('shows the account and agent name while keeping identifiers in expandable details', async () => {
  const user = userEvent.setup();
  renderPage(
    <Link
      api={api}
      accountLabel="reader@example.com"
      agentLabel="Forecast assistant"
      principalKey="tenant:user-a"
      ticket="ticket"
    />,
  );
  expect(await screen.findByText('Forecast assistant')).toBeVisible();
  expect(screen.getByText('reader@example.com')).toBeVisible();
  const details = screen.getByText('com_ui_channel_link_details').closest('details');
  expect(details).not.toHaveAttribute('open');
  expect(within(details!).getByText('U1')).not.toBeVisible();
  await user.click(screen.getByText('com_ui_channel_link_details'));
  expect(within(details!).getByText('U1')).toBeVisible();
  expect(
    screen.queryByRole('link', { name: 'com_ui_channel_link_open_slack' }),
  ).not.toBeInTheDocument();
});

test('accepted consent clearly points back to the verified Slack workspace without activating the link', async () => {
  const user = userEvent.setup();
  renderPage(
    <Link api={api} accountLabel="Account A" principalKey="tenant:user-a" ticket="ticket" />,
  );
  await user.click(await screen.findByRole('button', { name: 'com_ui_channel_link_accept' }));
  expect(
    await screen.findByRole('heading', { name: 'com_ui_channel_link_finish_title' }),
  ).toBeVisible();
  expect(screen.getByRole('link', { name: 'com_ui_channel_link_open_slack' })).toHaveAttribute(
    'href',
    'slack://open?team=T1',
  );
  expect(screen.getByRole('status')).toHaveTextContent('com_ui_channel_link_confirm_slack');
  expect(screen.queryByText('com_ui_channel_link_active')).not.toBeInTheDocument();
});

test('each link is a row: the agent name, the Slack ids, a status and a hover-only revoke', async () => {
  api.list.mockResolvedValue([{ ...pending, state: 'active' }]);
  renderPage(<Links api={api} principalKey="tenant:user-a" />);
  const row = (await screen.findByText('Support agent')).closest('li')!;
  expect(within(row).getByText('com_ui_channel_link_slack_ids')).toBeInTheDocument();
  expect(within(row).getByRole('status')).toHaveClass('sr-only');
  expect(within(row).getByRole('status')).toHaveTextContent('com_ui_channel_link_active');
  const revoke = within(row).getByRole('button', { name: /com_ui_channel_link_revoke_for/ });
  expect(revoke.parentElement).toHaveClass('no-touch:opacity-0', 'group-hover:opacity-100');
});

test('a link whose agent cannot be read keeps its agent id, so two such rows stay apart', async () => {
  api.list.mockResolvedValue([
    {
      ...pending,
      state: 'unavailable',
      identity: { ...pending.identity, agentId: 'missing-agent' },
    },
  ]);
  renderPage(<Links api={api} principalKey="tenant:user-a" />);
  expect(await screen.findByText('missing-agent')).toBeInTheDocument();
  expect(screen.queryByText('com_ui_channel_link_agent_fallback')).not.toBeInTheDocument();
});

test('hides the linked-account section after a successful empty list', async () => {
  api.list.mockResolvedValue([]);
  const { container } = renderPage(<Links api={api} principalKey="tenant:user-a" />);
  await waitFor(() => expect(container).toBeEmptyDOMElement());
  expect(
    screen.queryByRole('heading', { name: 'com_ui_channel_link_personal' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText('com_ui_channel_link_empty')).not.toBeInTheDocument();
  expect(screen.queryByText('com_ui_channel_link_boundary')).not.toBeInTheDocument();
});

test('does not present a loading linked-account list as empty', () => {
  api.list.mockImplementation(() => new Promise(() => {}));
  renderPage(<Links api={api} principalKey="tenant:user-a" />);
  expect(screen.queryByText('com_ui_channel_link_empty')).not.toBeInTheDocument();
});

test('shows a list error with retry instead of an empty linked-account state', async () => {
  api.list.mockRejectedValue(new Error('synthetic list failure'));
  renderPage(<Links api={api} principalKey="tenant:user-a" />);
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'com_ui_retry' })).toBeInTheDocument();
  expect(screen.queryByText('com_ui_channel_link_empty')).not.toBeInTheDocument();
});
