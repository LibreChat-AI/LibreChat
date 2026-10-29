import React from 'react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { act, render, screen, waitFor } from '@testing-library/react';
import { request, channelConfigSchema } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChannelLinkView } from 'librechat-data-provider';
import ChannelLinkRoute from '../ChannelLinkRoute';
import { useAuthContext } from '~/hooks';

const mockAuthUrls: string[] = [];
jest.mock('~/hooks', () => ({
  useAuthContext: jest.fn(),
  useLocalize: () => (key: string) => key,
}));
jest.mock('~/hooks/AuthContext', () => ({
  AuthContextProvider: ({ children }: { children: React.ReactNode }) => {
    mockAuthUrls.push(globalThis.window.location.href);
    return <>{children}</>;
  },
}));
const ticket = 'Ab_-09'.repeat(8).slice(0, 43);
const nextTicket = 'Zy_-87'.repeat(8).slice(0, 43);
const storageKey = 'channel_link_pending_ticket';
const maxAgeMs = channelConfigSchema.shape.ticketLifetimeMs.removeDefault().maxValue!;
let pending: ChannelLinkView;
let post: jest.SpyInstance;
function authenticated(value = true) {
  jest.mocked(useAuthContext).mockReturnValue({
    user: value ? { id: 'user-a', email: 'account@example.com' } : undefined,
    isAuthenticated: value,
  } as ReturnType<typeof useAuthContext>);
}
function savedTicket() {
  return JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
}
function renderRoute() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  return render(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <Routes>
          <Route path="/channels/link" element={<ChannelLinkRoute />} />
          <Route path="/login" element={<div data-testid="login" />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  mockAuthUrls.length = 0;
  sessionStorage.clear();
  window.history.replaceState({}, '', '/channels/link');
  authenticated(false);
  pending = {
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
    expiresAtMs: Date.now() + 60_000,
  };
  post = jest.spyOn(request, 'post').mockImplementation(async (url) => ({
    ok: true,
    value: { ...pending, state: String(url).endsWith('/accept') ? 'accepted' : 'pending' },
  }));
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test('preserves mixed-case tickets across login and sends exact POST bodies, never redirect URLs', async () => {
  window.history.replaceState({}, '', `/channels/link#${ticket}`);
  const first = renderRoute();
  await screen.findByTestId('login');
  expect(mockAuthUrls.length).toBeGreaterThan(0);
  expect(mockAuthUrls.every((url) => !url.includes(ticket))).toBe(true);
  expect(window.location.href).not.toContain(ticket);
  expect(new URLSearchParams(window.location.search).get('redirect_to')).toBe('/channels/link');
  expect(savedTicket().ticket).toBe(ticket);
  expect(post).not.toHaveBeenCalled();
  first.unmount();
  window.history.replaceState({}, '', '/channels/link');
  authenticated();
  renderRoute();
  await screen.findByText('U1');
  expect(post).toHaveBeenCalledWith('/api/channels/links/preview', { ticket });
  expect(savedTicket()).toMatchObject({ ticket, expiresAtMs: pending.expiresAtMs });
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_channel_link_accept' }));
  expect(await screen.findByRole('status')).toHaveTextContent('com_ui_channel_link_confirm_slack');
  expect(post).toHaveBeenCalledWith('/api/channels/links/accept', { ticket, revision: 'revision' });
  expect(post.mock.calls.every(([url]) => !String(url).includes(ticket))).toBe(true);
  await waitFor(() => expect(savedTicket()).toBeNull());
});

test('a ticket older than the default lifetime can still reach authoritative preview', async () => {
  sessionStorage.setItem(
    storageKey,
    JSON.stringify({ ticket, savedAt: Date.now() - 11 * 60 * 1000 }),
  );
  authenticated();
  renderRoute();
  await screen.findByText('U1');
  expect(post).toHaveBeenCalledWith('/api/channels/links/preview', { ticket });
});

test('authenticated reload retains an unconsumed ticket and authoritative expiry', async () => {
  authenticated();
  window.history.replaceState({}, '', `/channels/link#${ticket}`);
  const first = renderRoute();
  await screen.findByText('U1');
  await waitFor(() => expect(savedTicket().expiresAtMs).toBe(pending.expiresAtMs));
  first.unmount();
  renderRoute();
  await screen.findByText('U1');
  expect(post).toHaveBeenCalledTimes(2);
  expect(savedTicket().ticket).toBe(ticket);
});

test('transient preview 401 retains the ticket for sign-in and retry', async () => {
  authenticated();
  post.mockRejectedValueOnce({ response: { status: 401 } });
  window.history.replaceState({}, '', `/channels/link#${ticket}`);
  const first = renderRoute();
  expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_channel_link_error');
  expect(savedTicket().ticket).toBe(ticket);
  first.unmount();
  authenticated(false);
  const login = renderRoute();
  await screen.findByTestId('login');
  expect(window.location.href).not.toContain(ticket);
  login.unmount();
  window.history.replaceState({}, '', '/channels/link');
  authenticated();
  renderRoute();
  await screen.findByText('U1');
  expect(post).toHaveBeenLastCalledWith('/api/channels/links/preview', { ticket });
});

test('same-route fragment replacement uses only the new exact ticket', async () => {
  authenticated();
  window.history.replaceState({}, '', `/channels/link#${ticket}`);
  renderRoute();
  await screen.findByText('U1');
  act(() => {
    window.history.pushState({}, '', `/channels/link#${nextTicket}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await waitFor(() =>
    expect(post).toHaveBeenLastCalledWith('/api/channels/links/preview', { ticket: nextTicket }),
  );
  expect(window.location.hash).toBe('');
  expect(savedTicket().ticket).toBe(nextTicket);
  await userEvent.click(await screen.findByRole('button', { name: 'com_ui_channel_link_accept' }));
  await waitFor(() =>
    expect(post).toHaveBeenLastCalledWith('/api/channels/links/accept', {
      ticket: nextTicket,
      revision: 'revision',
    }),
  );
  expect(mockAuthUrls.every((url) => !url.includes('#'))).toBe(true);
});

test('a late preview for the replaced ticket cannot alter the new tab entry', async () => {
  authenticated();
  let resolveOld: (value: { ok: true; value: ChannelLinkView }) => void = () => {};
  post.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  window.history.replaceState({}, '', `/channels/link#${ticket}`);
  renderRoute();
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  act(() => {
    window.history.pushState({}, '', `/channels/link#${nextTicket}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await screen.findByText('U1');
  await act(async () => resolveOld({ ok: true, value: { ...pending, state: 'accepted' } }));
  expect(savedTicket().ticket).toBe(nextTicket);
});

test('authoritative expiry clears an unconsumed ticket while the page stays open', async () => {
  jest.useFakeTimers();
  authenticated();
  pending.expiresAtMs = Date.now() + 1000;
  window.history.replaceState({}, '', `/channels/link#${ticket}`);
  renderRoute();
  await act(async () => {
    await jest.advanceTimersByTimeAsync(10);
  });
  expect(savedTicket().expiresAtMs).toBe(pending.expiresAtMs);
  expect(screen.getByRole('button', { name: 'com_ui_channel_link_accept' })).toBeInTheDocument();
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1000);
  });
  expect(savedTicket()).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'com_ui_channel_link_accept' }),
  ).not.toBeInTheDocument();
});

test.each(['maximum', 'authoritative'])('expired %s tab ticket cannot be reused', async (kind) => {
  sessionStorage.setItem(
    storageKey,
    JSON.stringify({
      ticket,
      savedAt: Date.now() - (kind === 'maximum' ? maxAgeMs + 1 : 100),
      ...(kind === 'authoritative' ? { expiresAtMs: Date.now() - 1 } : {}),
    }),
  );
  authenticated();
  renderRoute();
  expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_channel_link_invalid');
  expect(savedTicket()).toBeNull();
  expect(post).not.toHaveBeenCalled();
});

test.each(['expired', 'revoked', 'invalid_ticket'] as const)(
  'server %s clears persisted ticket',
  async (code) => {
    authenticated();
    window.history.replaceState({}, '', `/channels/link#${ticket}`);
    post.mockResolvedValueOnce({ ok: false, error: { code } });
    renderRoute();
    await screen.findByRole('alert');
    await waitFor(() => expect(savedTicket()).toBeNull());
  },
);

test('blocked storage never puts the ticket into the login URL', async () => {
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Blocked', 'SecurityError');
  });
  window.history.replaceState({}, '', `/channels/link#${ticket}`);
  const first = renderRoute();
  await screen.findByTestId('login');
  expect(window.location.href).not.toContain(ticket);
  expect(mockAuthUrls.every((url) => !url.includes(ticket))).toBe(true);
  expect(post).not.toHaveBeenCalled();
  first.unmount();
  window.history.replaceState({}, '', '/channels/link');
  authenticated();
  renderRoute();
  expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_channel_link_invalid');
});

test('blocked storage permits an already-authenticated in-memory ticket', async () => {
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Blocked', 'SecurityError');
  });
  authenticated();
  window.history.replaceState({}, '', `/channels/link#${ticket}`);
  renderRoute();
  await screen.findByText('U1');
  expect(post).toHaveBeenCalledWith('/api/channels/links/preview', { ticket });
  expect(window.location.hash).toBe('');
});
