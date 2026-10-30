import React from 'react';
import userEvent from '@testing-library/user-event';
import { QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import type { ChannelIdentityClient, ChannelLinkView } from 'librechat-data-provider';
import Links from './Links';
import Link from './Link';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
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
  await user.click(await screen.findByRole('button', { name: 'com_ui_channel_link_revoke' }));
  expect(api.revoke).not.toHaveBeenCalled();
  const confirmation = screen.getByRole('group', { name: 'com_ui_channel_link_revoke_confirm' });
  api.list.mockResolvedValue([{ ...pending, state: 'revoked' }]);
  await user.click(
    within(confirmation).getByRole('button', { name: 'com_ui_channel_link_revoke' }),
  );
  await waitFor(() => expect(api.revoke).toHaveBeenCalledWith('link', 'revision'));
  expect(await screen.findByText('com_ui_channel_link_revoked')).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'com_ui_channel_link_revoke' }),
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

test('an unavailable personal connection remains explicitly revocable', async () => {
  const user = userEvent.setup();
  api.list.mockResolvedValue([{ ...pending, state: 'unavailable' }]);
  renderPage(<Links api={api} principalKey="tenant:user-a" />);
  expect(await screen.findByRole('status')).toHaveTextContent('com_ui_channel_link_unavailable');
  await user.click(screen.getByRole('button', { name: 'com_ui_channel_link_revoke' }));
  api.list.mockResolvedValue([{ ...pending, state: 'revoked' }]);
  await user.click(
    within(screen.getByRole('group')).getByRole('button', { name: 'com_ui_channel_link_revoke' }),
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
