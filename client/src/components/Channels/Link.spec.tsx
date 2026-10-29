import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
    accept: jest.fn().mockResolvedValue({ ok: true, value: { ...pending, state: 'accepted' } }),
    list: jest.fn().mockResolvedValue([{ ...pending, state: 'active' }]),
    revoke: jest.fn().mockResolvedValue({ ok: true, value: { ...pending, state: 'revoked' } }),
  };
});

test('preview is read-only, clears the fragment, and requires explicit acceptance then Slack confirmation', async () => {
  const user = userEvent.setup();
  window.history.replaceState({}, '', '/channels/link#private-ticket');
  const { client } = renderPage(<Link api={api} accountLabel="Account A" />);
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
  renderPage(<Link api={api} accountLabel="Account A" ticket="ticket" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_channel_link_expired');
  expect(
    screen.queryByRole('button', { name: 'com_ui_channel_link_accept' }),
  ).not.toBeInTheDocument();
  expect(api.accept).not.toHaveBeenCalled();
});

test('missing ticket cannot issue any link API calls', () => {
  renderPage(<Link api={api} accountLabel="Account A" />);
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
