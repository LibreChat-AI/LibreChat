/** @jest-environment-options {"url":"https://chat.example.test"} */
import React from 'react';
import { RecoilRoot } from 'recoil';
import { QRCodeSVG } from 'qrcode.react';
import { ToastProvider } from '@librechat/client';
import userEvent from '@testing-library/user-event';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { request, channelConfigSchema, dataService } from 'librechat-data-provider';
import type { ChannelLinkView } from 'librechat-data-provider';
import ChannelLinkRoute from '../ChannelLinkRoute';
import { useAuthContext } from '~/hooks';
import store from '~/store';

jest.mock('~/data-provider/Agents', () => ({
  useGetAgentByIdQuery: () => ({ data: { name: 'Forecast assistant' } }),
}));

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getStartupConfig: jest.fn(),
      getUserTerms: jest.fn(),
      acceptTerms: jest.fn(),
    },
  };
});
jest.mock(
  '~/components/Chat/Messages/Content/MarkdownLite',
  () =>
    ({ content }: { content: string }) => <p>{content}</p>,
);
const mockAuthUrls: string[] = [];
const mockAuthConfigurations: Array<{ optional?: boolean } | undefined> = [];
const mockClipboard = jest.fn();
jest.mock('qrcode.react', () => ({
  QRCodeSVG: jest.fn(({ title }: { title: string }) => <svg role="img" aria-label={title} />),
}));
jest.mock('~/hooks', () => ({
  useAuthContext: jest.fn(),
  useLocalize: () => (key: string) => key,
  useCopyToClipboard: jest.requireActual('~/hooks/Messages/useCopyToClipboard').default,
}));
jest.mock('copy-to-clipboard', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockClipboard(...args),
}));
jest.mock('~/hooks/AuthContext', () => ({
  AuthContextProvider: ({
    children,
    authConfig,
  }: {
    children: React.ReactNode;
    authConfig?: { optional?: boolean };
  }) => {
    mockAuthUrls.push(globalThis.window.location.href);
    mockAuthConfigurations.push(authConfig);
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
    user: value ? { id: 'user-a', tenantId: 'tenant', email: 'account@example.com' } : undefined,
    isAuthenticated: value,
    isAuthReady: true,
    logout: jest.fn(),
  } as unknown as ReturnType<typeof useAuthContext>);
}
function savedTicket() {
  return JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
}
function renderRoute() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <RecoilRoot
        initializeState={({ set }) => {
          set(store.queriesEnabled, true);
          set(store.user, jest.mocked(useAuthContext)().user as never);
        }}
      >
        <ToastProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/channels/link" element={<ChannelLinkRoute />} />
              <Route path="/login" element={<div data-testid="login" />} />
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </RecoilRoot>
    </QueryClientProvider>
  );
  const mounted = render(tree());
  return { ...mounted, client, rerenderRoute: () => mounted.rerender(tree()) };
}

beforeEach(() => {
  mockAuthUrls.length = 0;
  mockAuthConfigurations.length = 0;
  mockClipboard.mockReset().mockReturnValue(true);
  jest.mocked(QRCodeSVG).mockClear();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/channels/link');
  authenticated(false);
  jest
    .mocked(dataService.getStartupConfig)
    .mockReset()
    .mockResolvedValue({ interface: {} } as never);
  jest
    .mocked(dataService.getUserTerms)
    .mockReset()
    .mockResolvedValue({ termsAccepted: true, termsAcceptedAt: '2030-01-01' });
  jest
    .mocked(dataService.acceptTerms)
    .mockReset()
    .mockResolvedValue({ message: 'Accepted', termsAcceptedAt: '2030-01-01' });
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
  post = jest.spyOn(request, 'post').mockImplementation(async (url) => {
    if (String(url).endsWith('/accept')) pending = { ...pending, state: 'accepted' };
    return { ok: true, value: pending };
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test('preserves mixed-case tickets across login and sends exact POST bodies, never redirect URLs', async () => {
  window.history.replaceState({}, '', `/channels/link#${ticket}`);
  const first = renderRoute();
  await userEvent.click(
    await screen.findByRole('button', { name: 'com_ui_channel_handoff_continue' }),
  );
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
  await userEvent.click(
    await screen.findByRole('button', { name: 'com_ui_channel_handoff_continue' }),
  );
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
    expect(post).toHaveBeenCalledWith('/api/channels/links/accept', {
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
  await waitFor(() => expect(savedTicket().expiresAtMs).toBe(pending.expiresAtMs));
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
  await userEvent.click(
    await screen.findByRole('button', { name: 'com_ui_channel_handoff_continue' }),
  );
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

test('waits beyond the old redirect timeout for a restored session while keeping the ticket private', async () => {
  window.history.replaceState({}, '', `/channels/link#${ticket}`);
  jest.mocked(useAuthContext).mockReturnValue({
    user: undefined,
    isAuthenticated: false,
    isAuthReady: false,
    logout: jest.fn(),
  } as unknown as ReturnType<typeof useAuthContext>);
  const mounted = renderRoute();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  expect(screen.queryByTestId('login')).not.toBeInTheDocument();
  expect(post).not.toHaveBeenCalled();
  expect(window.location.href).not.toContain(ticket);
  authenticated();
  mounted.rerenderRoute();
  expect(await screen.findByText('U1')).toBeInTheDocument();
  expect(post).toHaveBeenCalledWith('/api/channels/links/preview', { ticket });
});

test('uses the actual terms modal before preview or acceptance can send a POST', async () => {
  authenticated();
  window.history.replaceState({}, '', `/channels/link#${ticket}`);
  jest.mocked(dataService.getStartupConfig).mockResolvedValue({
    interface: { termsOfService: { modalAcceptance: true, modalContent: 'Current terms' } },
  } as never);
  jest
    .mocked(dataService.getUserTerms)
    .mockResolvedValue({ termsAccepted: false, termsAcceptedAt: null });
  renderRoute();
  const accept = await screen.findByRole('button', { name: 'com_ui_accept' });
  expect(post).not.toHaveBeenCalled();
  await userEvent.click(accept);
  expect(dataService.acceptTerms).toHaveBeenCalledTimes(1);
  await screen.findByText('U1');
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith('/api/channels/links/preview', { ticket });
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_channel_link_accept' }));
  expect(post).toHaveBeenCalledWith('/api/channels/links/accept', { ticket, revision: 'revision' });
});

test.each(['config', 'terms'] as const)(
  'blocks private POSTs until a failed %s read succeeds',
  async (failed) => {
    authenticated();
    window.history.replaceState({}, '', `/channels/link#${ticket}`);
    jest
      .mocked(dataService.getStartupConfig)
      .mockResolvedValue({ interface: { termsOfService: { modalAcceptance: true } } } as never);
    if (failed === 'config')
      jest.mocked(dataService.getStartupConfig).mockRejectedValueOnce(new Error('private failure'));
    else jest.mocked(dataService.getUserTerms).mockRejectedValueOnce(new Error('private failure'));
    renderRoute();
    expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_channel_link_error');
    expect(post).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('private failure');
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(await screen.findByText('U1')).toBeInTheDocument();
  },
);

test('an old owner acknowledgement cannot replace the new owner preview or consume its tab ticket', async () => {
  authenticated();
  window.history.replaceState({}, '', `/channels/link#${ticket}`);
  let finish!: (value: { ok: true; value: ChannelLinkView }) => void;
  post.mockImplementation(async (url) =>
    String(url).endsWith('/accept')
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : { ok: true, value: pending },
  );
  const mounted = renderRoute();
  await userEvent.click(await screen.findByRole('button', { name: 'com_ui_channel_link_accept' }));
  jest.mocked(useAuthContext).mockReturnValue({
    user: { id: 'user-b', tenantId: 'other-tenant', email: 'b@example.com' },
    isAuthenticated: true,
    isAuthReady: true,
    logout: jest.fn(),
  } as unknown as ReturnType<typeof useAuthContext>);
  mounted.rerenderRoute();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'com_ui_channel_link_accept' })).toBeEnabled(),
  );
  await act(async () => {
    finish({ ok: true, value: { ...pending, state: 'accepted' } });
  });
  expect(screen.queryByText('com_ui_channel_link_confirm_slack')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'com_ui_channel_link_accept' })).toBeEnabled();
  expect(savedTicket().ticket).toBe(ticket);
});

test('offers private phone handoff before login without reading account data', async () => {
  window.history.replaceState({}, '', `/channels/link?unused=value#${ticket}`);
  renderRoute();
  expect(
    await screen.findByRole('button', { name: 'com_ui_channel_handoff_continue' }),
  ).toBeVisible();
  expect(screen.queryByTestId('login')).not.toBeInTheDocument();
  expect(mockAuthConfigurations.every((config) => config?.optional === true)).toBe(true);
  expect(post).not.toHaveBeenCalled();
  expect(dataService.getStartupConfig).not.toHaveBeenCalled();
  expect(jest.mocked(QRCodeSVG)).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain('account@example.com');
  expect(document.body.textContent).not.toContain('U1');
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_channel_handoff_phone' }));
  const url = `${window.location.origin}/channels/link#${ticket}`;
  expect(screen.queryByLabelText('com_ui_channel_handoff_private_link')).not.toBeInTheDocument();
  expect(jest.mocked(QRCodeSVG).mock.calls.at(-1)?.[0].value).toBe(url);
  expect(screen.getByText('com_ui_channel_handoff_privacy')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_copy_link' }));
  expect(mockClipboard).toHaveBeenCalledWith(
    url,
    expect.objectContaining({ format: 'text/plain' }),
  );
  expect(screen.getByRole('button', { name: 'com_ui_copied' })).toBeVisible();
  expect(window.location.href).not.toContain(ticket);
  expect(mockAuthUrls.every((authUrl) => !authUrl.includes(ticket))).toBe(true);
  expect(post).not.toHaveBeenCalled();
});

test('phone handoff permits manual copy when clipboard access fails', async () => {
  mockClipboard.mockReturnValue(false);
  window.history.replaceState({}, '', `/channels/link#${ticket}`);
  renderRoute();
  await userEvent.click(
    await screen.findByRole('button', { name: 'com_ui_channel_handoff_phone' }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_copy_link' }));
  expect(screen.getByText('com_ui_channel_handoff_copy_failed')).toBeVisible();
  const input = screen.getByLabelText('com_ui_channel_handoff_private_link');
  await userEvent.click(input);
  expect(input).toHaveFocus();
  expect(
    window.getSelection()?.toString() || (input as HTMLTextAreaElement).selectionEnd,
  ).toBeTruthy();
});

test('blocked storage warns before sign-in and still allows private phone handoff', async () => {
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Blocked', 'SecurityError');
  });
  window.history.replaceState({}, '', `/channels/link#${ticket}`);
  renderRoute();
  expect(await screen.findByText('com_ui_channel_handoff_storage')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_channel_handoff_phone' }));
  expect(jest.mocked(QRCodeSVG).mock.calls.at(-1)?.[0].value).toBe(
    `${window.location.origin}/channels/link#${ticket}`,
  );
  expect(window.location.hash).toBe('');
  expect(post).not.toHaveBeenCalled();
});

test('expired stored tickets do not offer a QR code or a sign-in loop', async () => {
  sessionStorage.setItem(
    storageKey,
    JSON.stringify({ ticket, savedAt: Date.now() - maxAgeMs - 1 }),
  );
  renderRoute();
  expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_channel_link_invalid');
  expect(
    screen.queryByRole('button', { name: 'com_ui_channel_handoff_continue' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'com_ui_channel_handoff_phone' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByTestId('login')).not.toBeInTheDocument();
  expect(post).not.toHaveBeenCalled();
});

test('phone handoff disappears when the tab ticket expires', async () => {
  jest.useFakeTimers();
  sessionStorage.setItem(
    storageKey,
    JSON.stringify({ ticket, savedAt: Date.now(), expiresAtMs: Date.now() + 1000 }),
  );
  renderRoute();
  const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
  await user.click(await screen.findByRole('button', { name: 'com_ui_channel_handoff_phone' }));
  expect(screen.getByRole('img', { name: 'com_ui_channel_handoff_qr' })).toBeVisible();
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1000);
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_channel_link_invalid');
  expect(screen.queryByLabelText('com_ui_channel_handoff_private_link')).not.toBeInTheDocument();
  expect(savedTicket()).toBeNull();
});

test.each(['', '#malformed-ticket'])(
  'missing or malformed fragment %s has a safe unauthenticated recovery',
  async (hash) => {
    window.history.replaceState({}, '', `/channels/link${hash}`);
    renderRoute();
    expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_channel_link_invalid');
    expect(screen.getByRole('link', { name: 'com_ui_channel_link_go_home' })).toHaveAttribute(
      'href',
      '/',
    );
    expect(
      screen.queryByRole('button', { name: 'com_ui_channel_handoff_phone' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('login')).not.toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(post).not.toHaveBeenCalled();
  },
);
