import React from 'react';
import '@testing-library/jest-dom';
import userEvent from '@testing-library/user-event';
import { QueryKeys } from 'librechat-data-provider';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TPullRequestConnection, TStartupConfig } from 'librechat-data-provider';
import { usePullRequestConnectionStatus } from '~/data-provider/PullRequest/connection';
import { stopPullRequestSignIns } from '~/data-provider/PullRequest/signIn';
import { endPullRequestSession } from '~/data-provider/PullRequest/queries';
import ConnectedAccounts from '../ConnectedAccounts';

const mockGetConnection = jest.fn();
const mockConnect = jest.fn();
const mockDisconnect = jest.fn();
const mockStartup: { current: Partial<TStartupConfig> | undefined } = {
  current: { pullRequestsConnect: 'github' },
};

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string | number>) =>
    values == null ? key : `${key}:${Object.values(values).join(',')}`,
}));

jest.mock('~/data-provider/Endpoints', () => ({
  ...jest.requireActual('~/data-provider/Endpoints'),
  useGetStartupConfig: () => ({ data: mockStartup.current }),
}));

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getPullRequestConnection: (...args: unknown[]) => mockGetConnection(...args),
      connectPullRequestAccount: (...args: unknown[]) => mockConnect(...args),
      disconnectPullRequestAccount: (...args: unknown[]) => mockDisconnect(...args),
    },
  };
});

const connection = (connected: boolean): TPullRequestConnection => ({
  configured: true,
  provider: 'github',
  connected,
});

/** Rejections are part of these tests; keep React Query from logging each one. */
const logger = { log: () => undefined, warn: () => undefined, error: () => undefined };

const renderRow = () => {
  const client = new QueryClient({ logger, defaultOptions: { queries: { retry: false } } });
  const invalidate = jest.spyOn(client, 'invalidateQueries');
  const { unmount } = render(
    <QueryClientProvider client={client}>
      <ConnectedAccounts />
    </QueryClientProvider>,
  );
  return { client, invalidate, unmount };
};

/** Settings as the registry shows the row: inside a tab panel, only while the status allows it. */
function SettingsPanel() {
  const status = usePullRequestConnectionStatus();
  return (
    <div role="tabpanel" tabIndex={-1}>
      {status?.connected === true && <ConnectedAccounts />}
    </div>
  );
}

/** Settings with its own visibility rule (context.tsx): the row shows for a known grant, or while
 *  the startup config offers an app and the server has not said there is none. */
function ConfigPanel() {
  const status = usePullRequestConnectionStatus();
  const shown =
    status?.connected === true ||
    (mockStartup.current?.pullRequestsConnect != null && status?.configured !== false);
  return (
    <div role="tabpanel" tabIndex={-1}>
      {shown && <ConnectedAccounts />}
    </div>
  );
}

const renderPanel = () => {
  const client = new QueryClient({ logger, defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SettingsPanel />
    </QueryClientProvider>,
  );
  return { client };
};

const fakeWindow = () => ({ opener: {} as unknown, location: { href: '' }, close: jest.fn() });

describe('ConnectedAccounts', () => {
  let openSpy: jest.SpyInstance;

  beforeEach(() => {
    mockStartup.current = { pullRequestsConnect: 'github' };
    mockGetConnection.mockReset();
    mockConnect.mockReset();
    mockDisconnect.mockReset();
    openSpy = jest.spyOn(window, 'open');
  });

  afterEach(() => {
    /** A sign-in watch outlives the row, so each test ends the one it started. */
    stopPullRequestSignIns();
    openSpy.mockRestore();
  });

  it('renders nothing and asks nothing when the deployment offers no account to connect', () => {
    mockStartup.current = {};
    const { container } = render(
      <QueryClientProvider client={new QueryClient({ logger })}>
        <ConnectedAccounts />
      </QueryClientProvider>,
    );
    expect(container).toBeEmptyDOMElement();
    expect(mockGetConnection).not.toHaveBeenCalled();
  });

  it('offers Disconnect for a grant whose app is gone from a deployment with pull requests on', async () => {
    mockStartup.current = { pullRequestsEnabled: true };
    mockGetConnection.mockResolvedValue({ configured: false, connected: true });
    renderRow();

    expect(
      await screen.findByRole('button', {
        name: 'com_ui_pr_account_disconnect_aria:com_ui_settings_label_pull_request_account',
      }),
    ).toBeInTheDocument();
  });

  it('renders nothing for a deployment with pull requests on and nothing to disconnect', async () => {
    mockStartup.current = { pullRequestsEnabled: true };
    mockGetConnection.mockResolvedValue({ configured: false, connected: false });
    const { client } = renderRow();
    await waitFor(() => expect(mockGetConnection).toHaveBeenCalled());
    await waitFor(() =>
      expect(client.getQueryData([QueryKeys.pullRequestConnection])).toBeDefined(),
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders nothing once the server says no app is configured', async () => {
    mockGetConnection.mockResolvedValue({ configured: false, connected: false });
    renderRow();
    await waitFor(() => expect(mockGetConnection).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps Disconnect for a grant that outlives a turned-off app', async () => {
    mockGetConnection.mockResolvedValue({ configured: false, connected: true });
    renderRow();

    expect(
      await screen.findByRole('button', {
        name: 'com_ui_pr_account_disconnect_aria:com_ui_settings_label_pull_request_account',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /com_ui_pr_account_connect_aria/ })).toBeNull();
    /** No lookup uses a grant whose app is off, so it is not shown as in use. */
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_pr_account_not_in_use');
    expect(screen.queryByText('com_ui_pr_account_connected')).toBeNull();
    expect(screen.getByText('com_ui_pr_account_unused_description')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_pr_account_description')).toBeNull();
  });

  it('shows the success status and lookup copy for a grant the current app uses', async () => {
    mockGetConnection.mockResolvedValue(connection(true));
    renderRow();
    await screen.findByRole('button', { name: /com_ui_pr_account_disconnect_aria/ });
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_pr_account_connected');
    expect(screen.getByText('com_ui_pr_account_description')).toBeInTheDocument();
  });

  it('shows a checking status and no action while the connection loads', () => {
    mockGetConnection.mockReturnValue(new Promise(() => undefined));
    renderRow();
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_pr_account_checking');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('connects through a window opened in the click, then sends it to the sign-in page', async () => {
    const popup = fakeWindow();
    openSpy.mockReturnValue(popup as unknown as Window);
    mockGetConnection.mockResolvedValue(connection(false));
    mockConnect.mockResolvedValue({ url: 'https://github.com/login/oauth/authorize?x=1' });
    renderRow();

    const button = await screen.findByRole('button', {
      name: 'com_ui_pr_account_connect_aria:com_ui_pr_provider_github',
    });
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_pr_account_not_connected');
    await userEvent.click(button);

    expect(openSpy).toHaveBeenCalledWith('', '_blank');
    expect(popup.opener).toBeNull();
    expect(mockConnect).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(popup.location.href).toBe('https://github.com/login/oauth/authorize?x=1'),
    );
    expect(popup.close).not.toHaveBeenCalled();
  });

  it('keeps asking while the sign-in is open, so a finish without refocus still shows', async () => {
    const popup = fakeWindow();
    openSpy.mockReturnValue(popup as unknown as Window);
    mockGetConnection.mockResolvedValue(connection(false));
    mockConnect.mockResolvedValue({ url: 'https://github.com/login/oauth/authorize?x=1' });
    const { invalidate } = renderRow();

    await userEvent.click(
      await screen.findByRole('button', { name: /com_ui_pr_account_connect_aria/ }),
    );
    await waitFor(() => expect(popup.location.href).not.toBe(''));
    const before = mockGetConnection.mock.calls.length;
    mockGetConnection.mockResolvedValue(connection(true));

    expect(
      await screen.findByRole(
        'button',
        { name: /com_ui_pr_account_disconnect_aria/ },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(mockGetConnection.mock.calls.length).toBeGreaterThan(before);
    expect(invalidate).toHaveBeenCalledWith([QueryKeys.conversationPullRequest]);

    const settled = mockGetConnection.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(mockGetConnection).toHaveBeenCalledTimes(settled);
  }, 15000);

  it('stops watching when the flow the server started expires', async () => {
    const popup = fakeWindow();
    openSpy.mockReturnValue(popup as unknown as Window);
    mockGetConnection.mockResolvedValue(connection(false));
    mockConnect.mockResolvedValue({
      url: 'https://github.com/login/oauth/authorize?x=1',
      expiresInSeconds: 1,
    });
    renderRow();

    await userEvent.click(
      await screen.findByRole('button', { name: /com_ui_pr_account_connect_aria/ }),
    );
    await waitFor(() => expect(popup.location.href).not.toBe(''));
    const started = mockGetConnection.mock.calls.length;
    /** Past one poll interval: a watch still running would have asked again by now. */
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(mockGetConnection).toHaveBeenCalledTimes(started);
  }, 10000);

  it('still sends the window to the sign-in page when Settings closes first', async () => {
    const popup = fakeWindow();
    openSpy.mockReturnValue(popup as unknown as Window);
    mockGetConnection.mockResolvedValue(connection(false));
    let answer: (value: { url: string }) => void = () => undefined;
    mockConnect.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const { unmount } = renderRow();

    await userEvent.click(
      await screen.findByRole('button', { name: /com_ui_pr_account_connect_aria/ }),
    );
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1));
    unmount();
    answer({ url: 'https://github.com/login/oauth/authorize?x=1' });

    await waitFor(() =>
      expect(popup.location.href).toBe('https://github.com/login/oauth/authorize?x=1'),
    );
    expect(popup.close).not.toHaveBeenCalled();
  });

  it('starts nothing when the window is closed before the server answers', async () => {
    const popup = { ...fakeWindow(), closed: false };
    openSpy.mockReturnValue(popup as unknown as Window);
    mockGetConnection.mockResolvedValue(connection(false));
    let answer: (value: { url: string }) => void = () => undefined;
    mockConnect.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    renderRow();

    await userEvent.click(
      await screen.findByRole('button', { name: /com_ui_pr_account_connect_aria/ }),
    );
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1));
    popup.closed = true;
    const asked = mockGetConnection.mock.calls.length;
    answer({ url: 'https://github.com/login/oauth/authorize?x=1' });

    /** Past the first poll: a watch started anyway would have asked by now. */
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(popup.location.href).toBe('');
    expect(mockGetConnection).toHaveBeenCalledTimes(asked);
  }, 10000);

  it('closes the window instead of signing in when the session ends first', async () => {
    const popup = fakeWindow();
    openSpy.mockReturnValue(popup as unknown as Window);
    mockGetConnection.mockResolvedValue(connection(false));
    let answer: (value: { url: string }) => void = () => undefined;
    mockConnect.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const { unmount } = renderRow();

    await userEvent.click(
      await screen.findByRole('button', { name: /com_ui_pr_account_connect_aria/ }),
    );
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1));
    unmount();
    endPullRequestSession();
    answer({ url: 'https://github.com/login/oauth/authorize?x=1' });

    await waitFor(() => expect(popup.close).toHaveBeenCalledTimes(1));
    expect(popup.location.href).toBe('');
  });

  it('shows the sign-in error page in the window when the connection fails after Settings closed', async () => {
    const popup = fakeWindow();
    openSpy.mockReturnValue(popup as unknown as Window);
    mockGetConnection.mockResolvedValue(connection(false));
    let fail: (error: Error) => void = () => undefined;
    mockConnect.mockReturnValueOnce(new Promise((_resolve, reject) => (fail = reject)));
    const { unmount } = renderRow();

    await userEvent.click(
      await screen.findByRole('button', { name: /com_ui_pr_account_connect_aria/ }),
    );
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1));
    unmount();
    fail(new Error('500'));

    /** The row is gone, so the window explains the failure instead of vanishing. */
    await waitFor(() => expect(popup.location.href).toBe('/oauth/error?error=connect_failed'));
    expect(popup.close).not.toHaveBeenCalled();
  });

  it('refreshes pull requests when the sign-in finishes after Settings closed', async () => {
    const popup = fakeWindow();
    openSpy.mockReturnValue(popup as unknown as Window);
    mockGetConnection.mockResolvedValue(connection(false));
    mockConnect.mockResolvedValue({ url: 'https://github.com/login/oauth/authorize?x=1' });
    const { client, invalidate, unmount } = renderRow();

    await userEvent.click(
      await screen.findByRole('button', { name: /com_ui_pr_account_connect_aria/ }),
    );
    await waitFor(() => expect(popup.location.href).not.toBe(''));
    unmount();
    const before = invalidate.mock.calls.length;
    mockGetConnection.mockResolvedValue(connection(true));

    await waitFor(
      () =>
        expect(client.getQueryData([QueryKeys.pullRequestConnection])).toEqual(connection(true)),
      { timeout: 5000 },
    );
    expect(invalidate.mock.calls.length).toBeGreaterThan(before);
    expect(invalidate).toHaveBeenLastCalledWith([QueryKeys.conversationPullRequest]);
  }, 10000);

  it('closes the opened window and explains when the connection cannot start', async () => {
    const popup = fakeWindow();
    openSpy.mockReturnValue(popup as unknown as Window);
    mockGetConnection.mockResolvedValue(connection(false));
    mockConnect.mockRejectedValue(new Error('500'));
    renderRow();

    await userEvent.click(
      await screen.findByRole('button', { name: /com_ui_pr_account_connect_aria/ }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_pr_account_connect_error');
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(popup.location.href).toBe('');
  });

  it('does not start the flow when the browser blocks the window', async () => {
    openSpy.mockReturnValue(null);
    mockGetConnection.mockResolvedValue(connection(false));
    renderRow();

    await userEvent.click(
      await screen.findByRole('button', { name: /com_ui_pr_account_connect_aria/ }),
    );

    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_pr_account_popup_blocked');
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('asks before disconnecting, then disconnects and refreshes pull requests', async () => {
    mockGetConnection.mockResolvedValue(connection(true));
    mockDisconnect.mockResolvedValue(undefined);
    const { invalidate } = renderRow();

    const trigger = await screen.findByRole('button', {
      name: 'com_ui_pr_account_disconnect_aria:com_ui_pr_provider_github',
    });
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_pr_account_connected');
    await userEvent.click(trigger);

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(
      'com_ui_pr_account_disconnect_title:com_ui_pr_provider_github',
    );
    expect(mockDisconnect).not.toHaveBeenCalled();

    mockGetConnection.mockResolvedValue(connection(false));
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_pr_account_disconnect' }));

    await waitFor(() => expect(mockDisconnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(invalidate).toHaveBeenCalledWith([QueryKeys.pullRequestConnection]);
    expect(invalidate).toHaveBeenCalledWith([QueryKeys.conversationPullRequest]);
    const connect = await screen.findByRole('button', { name: /com_ui_pr_account_connect_aria/ });
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_pr_account_not_connected');
    await waitFor(() => expect(connect).toHaveFocus());
  });

  it('asks for the status once when Settings reveals a grant whose app is off', async () => {
    mockStartup.current = { pullRequestsEnabled: true };
    mockGetConnection.mockResolvedValue({ configured: false, connected: true });
    renderPanel();

    expect(
      await screen.findByRole('button', { name: /com_ui_pr_account_disconnect_aria/ }),
    ).toBeInTheDocument();
    expect(mockGetConnection).toHaveBeenCalledTimes(1);
  });

  it('moves focus to the panel when disconnecting removes the last row', async () => {
    mockStartup.current = { pullRequestsEnabled: true };
    mockGetConnection.mockResolvedValue({ configured: false, connected: true });
    mockDisconnect.mockResolvedValue(undefined);
    renderPanel();

    await userEvent.click(
      await screen.findByRole('button', { name: /com_ui_pr_account_disconnect_aria/ }),
    );
    await screen.findByRole('alertdialog');
    mockGetConnection.mockResolvedValue({ configured: false, connected: false });
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_pr_account_disconnect' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('group')).toBeNull();
    await waitFor(() => expect(screen.getByRole('tabpanel')).toHaveFocus());
  });

  it('moves focus to the panel when a retry finds the app gone and hides the row', async () => {
    mockGetConnection.mockRejectedValueOnce(new Error('500'));
    const client = new QueryClient({ logger, defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ConfigPanel />
      </QueryClientProvider>,
    );

    const retry = await screen.findByRole('button', { name: 'com_ui_retry' });
    mockGetConnection.mockResolvedValue({ configured: false, connected: false });
    await userEvent.click(retry);

    await waitFor(() => expect(screen.queryByRole('group')).toBeNull());
    await waitFor(() => expect(screen.getByRole('tabpanel')).toHaveFocus());
  });

  it('cannot be cancelled or dismissed once the disconnect is sent', async () => {
    mockGetConnection.mockResolvedValue(connection(true));
    let settle: () => void = () => undefined;
    mockDisconnect.mockReturnValueOnce(new Promise<void>((resolve) => (settle = resolve)));
    renderRow();

    await userEvent.click(
      await screen.findByRole('button', { name: /com_ui_pr_account_disconnect_aria/ }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'com_ui_pr_account_disconnect' }),
    );

    const cancel = screen.getByRole('button', { name: 'com_ui_cancel' });
    await waitFor(() => expect(cancel).toBeDisabled());
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    settle();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('keeps the confirmation open with an error when disconnecting fails', async () => {
    mockGetConnection.mockResolvedValue(connection(true));
    mockDisconnect.mockRejectedValue(new Error('500'));
    renderRow();

    await userEvent.click(
      await screen.findByRole('button', { name: /com_ui_pr_account_disconnect_aria/ }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'com_ui_pr_account_disconnect' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'com_ui_pr_account_disconnect_error',
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('closes the confirmation when a failed disconnect had ended the connection after all', async () => {
    mockGetConnection.mockResolvedValue(connection(true));
    mockDisconnect.mockRejectedValue(new Error('500'));
    const { invalidate } = renderRow();

    await userEvent.click(
      await screen.findByRole('button', { name: /com_ui_pr_account_disconnect_aria/ }),
    );
    const asked = mockGetConnection.mock.calls.length;
    invalidate.mockClear();
    /** The server fenced the grant before the request failed. */
    mockGetConnection.mockResolvedValue(connection(false));
    await userEvent.click(
      await screen.findByRole('button', { name: 'com_ui_pr_account_disconnect' }),
    );

    await waitFor(() => expect(mockGetConnection.mock.calls.length).toBeGreaterThan(asked));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    const connect = await screen.findByRole('button', { name: /com_ui_pr_account_connect_aria/ });
    await waitFor(() => expect(connect).toHaveFocus());
    /** Pull requests follow the server's token now. */
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith([QueryKeys.conversationPullRequest]),
    );
  });

  it('hands focus on when a dismissed failed disconnect turns out to have ended the connection', async () => {
    mockGetConnection.mockResolvedValue(connection(true));
    mockDisconnect.mockRejectedValue(new Error('500'));
    renderRow();

    await userEvent.click(
      await screen.findByRole('button', { name: /com_ui_pr_account_disconnect_aria/ }),
    );
    /** The status read after the failure is slow. */
    let answer: (status: TPullRequestConnection) => void = () => undefined;
    mockGetConnection.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await userEvent.click(
      await screen.findByRole('button', { name: 'com_ui_pr_account_disconnect' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'com_ui_pr_account_disconnect_error',
    );
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());

    act(() => answer(connection(false)));
    const connect = await screen.findByRole('button', { name: /com_ui_pr_account_connect_aria/ });
    await waitFor(() => expect(connect).toHaveFocus());
  });

  it('keeps the error when the status read after a failed disconnect still shows the grant', async () => {
    mockGetConnection.mockResolvedValue(connection(true));
    mockDisconnect.mockRejectedValue(new Error('500'));
    renderRow();

    await userEvent.click(
      await screen.findByRole('button', { name: /com_ui_pr_account_disconnect_aria/ }),
    );
    const asked = mockGetConnection.mock.calls.length;
    await userEvent.click(
      await screen.findByRole('button', { name: 'com_ui_pr_account_disconnect' }),
    );

    await waitFor(() => expect(mockGetConnection.mock.calls.length).toBeGreaterThan(asked));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'com_ui_pr_account_disconnect_error',
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('keeps the confirmation button named while the disconnect is in flight', async () => {
    mockGetConnection.mockResolvedValue(connection(true));
    let settle: () => void = () => undefined;
    mockDisconnect.mockReturnValueOnce(new Promise<void>((resolve) => (settle = resolve)));
    renderRow();

    await userEvent.click(
      await screen.findByRole('button', { name: /com_ui_pr_account_disconnect_aria/ }),
    );
    const confirm = await screen.findByRole('button', { name: 'com_ui_pr_account_disconnect' });
    await userEvent.click(confirm);

    await waitFor(() => expect(confirm).toHaveAttribute('aria-busy', 'true'));
    expect(screen.getByRole('button', { name: 'com_ui_pr_account_disconnect' })).toBe(confirm);
    settle();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('names the provider the server reports over a stale startup config', async () => {
    mockGetConnection.mockResolvedValue({ configured: true, provider: 'gitlab', connected: false });
    renderRow();

    expect(
      await screen.findByRole('button', {
        name: 'com_ui_pr_account_connect_aria:com_ui_pr_provider_gitlab',
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('group')).toHaveAccessibleName('com_ui_pr_provider_gitlab');
  });

  it('explains a failed status check and retries it', async () => {
    mockGetConnection.mockRejectedValueOnce(new Error('500'));
    renderRow();

    const retry = await screen.findByRole('button', { name: 'com_ui_retry' });
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_pr_account_status_error');

    mockGetConnection.mockResolvedValueOnce(connection(true));
    await userEvent.click(retry);

    expect(
      await screen.findByRole('button', { name: /com_ui_pr_account_disconnect_aria/ }),
    ).toBeInTheDocument();
    expect(mockGetConnection).toHaveBeenCalledTimes(2);
  });

  it('keeps Disconnect for a known grant when a later status check fails', async () => {
    mockGetConnection.mockResolvedValueOnce(connection(true));
    const { client } = renderRow();
    await screen.findByRole('button', { name: /com_ui_pr_account_disconnect_aria/ });

    mockGetConnection.mockRejectedValueOnce(new Error('500'));
    await client.refetchQueries([QueryKeys.pullRequestConnection]);

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('com_ui_pr_account_status_error'),
    );
    expect(
      screen.getByRole('button', { name: /com_ui_pr_account_disconnect_aria/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_ui_retry' })).toBeNull();
  });

  it('keeps the retry button named while a failed refresh is retried', async () => {
    mockGetConnection.mockResolvedValueOnce(connection(false));
    const { client } = renderRow();
    await screen.findByRole('button', { name: /com_ui_pr_account_connect_aria/ });

    mockGetConnection.mockRejectedValueOnce(new Error('500'));
    await client.refetchQueries([QueryKeys.pullRequestConnection]);
    const retry = await screen.findByRole('button', { name: 'com_ui_retry' });

    let answer: (value: TPullRequestConnection) => void = () => undefined;
    mockGetConnection.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    await userEvent.click(retry);

    await waitFor(() => expect(retry).toHaveAttribute('aria-busy', 'true'));
    expect(screen.getByRole('button', { name: 'com_ui_retry' })).toBe(retry);
    answer(connection(false));
    expect(
      await screen.findByRole('button', { name: /com_ui_pr_account_connect_aria/ }),
    ).toBeInTheDocument();
  });
});
