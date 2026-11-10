import { Provider } from 'jotai';
import { RecoilRoot } from 'recoil';
import axios, { AxiosHeaders } from 'axios';
import { QueryKeys } from 'librechat-data-provider';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, within, waitFor } from '@testing-library/react';
import type { TBalanceResponse, TUser } from 'librechat-data-provider';
import type { AxiosResponse } from 'axios';
import type { ReactNode } from 'react';
import type { TAuthContext } from '~/common';
import { TokenCredits, AutoRefill } from '~/components/Nav/Settings/BillingControls';
import { AuthContext } from '~/hooks/AuthContext';
import Credits from '../Credits';
import store from '~/store';

const NOW = Date.parse('2026-07-05T00:00:00.000Z');
const balance: TBalanceResponse = {
  tokenCredits: 3_100_000,
  autoRefillEnabled: true,
  refillAmount: 5_000_000,
  refillIntervalValue: 7,
  refillIntervalUnit: 'days',
  lastRefill: '2026-07-01T00:00:00.000Z',
};
const user: TUser = {
  id: 'usage-user',
  username: 'usage-user',
  email: 'usage@example.com',
  name: 'Usage User',
  avatar: '',
  role: 'USER',
  provider: 'local',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const auth: TAuthContext = {
  user,
  token: undefined,
  isAuthenticated: true,
  isAuthReady: true,
  error: undefined,
  login: jest.fn(),
  logout: jest.fn(),
  completeAuthentication: jest.fn(),
  setError: jest.fn(),
};
const config = ({
  balanceEnabled = true,
  display = 'credits',
}: { balanceEnabled?: boolean; display?: string } = {}) => ({
  balance: { enabled: balanceEnabled, startBalance: 20_000, display },
  interface: { contextUsage: false, currency: { code: 'USD', rate: 1 } },
});
function response<T>(data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
}
function deferred<T>() {
  let resolve!: (value: AxiosResponse<T>) => void;
  const promise = new Promise<AxiosResponse<T>>((done) => {
    resolve = done;
  });
  return { promise, resolve: (data: T) => resolve(response(data)) };
}
const getConfig = jest.fn<Promise<AxiosResponse<ReturnType<typeof config>>>, []>();
const getBalance = jest.fn<Promise<AxiosResponse<TBalanceResponse | null>>, []>();
let client: QueryClient;
let authenticated = true;
let queriesEnabled = true;
function Wrapper({ children }: { children: ReactNode }) {
  const currentUser = authenticated ? user : undefined;
  return (
    <QueryClientProvider client={client}>
      <RecoilRoot
        initializeState={({ set }) => {
          set(store.user, currentUser);
          set(store.queriesEnabled, queriesEnabled);
        }}
      >
        <Provider>
          <AuthContext.Provider
            value={{ ...auth, user: currentUser, isAuthenticated: authenticated }}
          >
            {children}
          </AuthContext.Provider>
        </Provider>
      </RecoilRoot>
    </QueryClientProvider>
  );
}
const renderCredits = (mobile = false) => render(<Credits mobile={mobile} />, { wrapper: Wrapper });
const openCard = async () => {
  const interaction = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
  await interaction.click(await screen.findByRole('button', { name: 'Account usage' }));
  return screen.findByRole('dialog', { name: 'Account usage' });
};

describe('sidebar credits', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    authenticated = true;
    queriesEnabled = true;
    client = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: 0 } } });
    getConfig.mockReset().mockResolvedValue(response(config()));
    getBalance.mockReset().mockResolvedValue(response(balance));
    jest.spyOn(axios, 'get').mockImplementation((url) => {
      if (url === '/api/config') return getConfig();
      if (url === '/api/balance') return getBalance();
      throw new Error(`Unexpected GET ${url}`);
    });
  });
  afterEach(() => {
    cleanup();
    client.clear();
    jest.useRealTimers();
  });

  it.each([false, true])(
    'shows the account balance independently of context usage, mobile=%s',
    async (mobile) => {
      renderCredits(mobile);
      const card = await openCard();
      expect(await within(card).findByText('62% left')).toBeVisible();
      expect(within(card).getByTestId('balance-value')).toHaveTextContent('3,100,000 credits');
      expect(within(card).getByTestId('balance-refill')).toHaveTextContent(
        '+5,000,000 available in 3 days',
      );
      expect(within(card).queryByRole('progressbar')).not.toBeInTheDocument();
      expect(card).toHaveClass('max-w-[calc(100vw-1rem)]');
    },
  );

  it('supports keyboard opening, Escape and focus return', async () => {
    renderCredits();
    const trigger = await screen.findByRole('button', { name: 'Account usage' });
    const interaction = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    act(() => trigger.focus());
    await interaction.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Account usage' })).toBeVisible();
    await interaction.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it.each(['disabled', 'signed out'])('does not request a balance when %s', async (reason) => {
    if (reason === 'disabled')
      getConfig.mockResolvedValue(response(config({ balanceEnabled: false })));
    if (reason === 'signed out') authenticated = false;
    renderCredits();
    await waitFor(() =>
      expect(
        client.getQueryState([QueryKeys.startupConfig, authenticated, 'default'])?.status,
      ).toBe('success'),
    );
    expect(screen.queryByRole('button', { name: 'Account usage' })).not.toBeInTheDocument();
    expect(getBalance).not.toHaveBeenCalled();
  });

  it('does not request config or balance while queries are disabled', () => {
    queriesEnabled = false;
    renderCredits();
    expect(screen.queryByRole('button', { name: 'Account usage' })).not.toBeInTheDocument();
    expect(getConfig).not.toHaveBeenCalled();
    expect(getBalance).not.toHaveBeenCalled();
  });

  it('waits for config before requesting the balance', async () => {
    const pending = deferred<ReturnType<typeof config>>();
    getConfig.mockReturnValue(pending.promise);
    renderCredits();
    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1));
    expect(getBalance).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Account usage' })).not.toBeInTheDocument();
    pending.resolve(config());
    const card = await openCard();
    expect(await within(card).findByTestId('balance-value')).toHaveTextContent('3,100,000 credits');
  });

  it('hides the control after a successful response with no balance record', async () => {
    getBalance.mockResolvedValue(response(null));
    renderCredits();
    await waitFor(() => expect(client.getQueryState([QueryKeys.balance])?.status).toBe('success'));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Account usage' })).not.toBeInTheDocument(),
    );
    expect(getBalance).toHaveBeenCalledTimes(1);
  });

  it('shows no amounts in percent mode', async () => {
    getConfig.mockResolvedValue(response(config({ display: 'percent' })));
    renderCredits();
    const card = await openCard();
    expect(await within(card).findByTestId('balance-value')).toHaveTextContent('62% left');
    expect(card).not.toHaveTextContent(/credits|3,100,000|5,000,000|\$/i);
  });

  it('keeps unknown allowance distinct from zero remaining', async () => {
    getConfig.mockResolvedValue(
      response({
        ...config({ display: 'percent' }),
        balance: { enabled: true, startBalance: 0, display: 'percent' },
      }),
    );
    getBalance.mockResolvedValue(response({ tokenCredits: 900, autoRefillEnabled: false }));
    renderCredits();
    const card = await openCard();
    expect(await within(card).findByTestId('balance-value')).toHaveTextContent('Usage unavailable');
    expect(card).not.toHaveTextContent('0% left');
  });

  it('keeps exhausted credits visible after a real failed refetch', async () => {
    getBalance
      .mockResolvedValueOnce(response({ ...balance, tokenCredits: 0 }))
      .mockRejectedValue(new Error('Balance service unavailable'));
    renderCredits();
    const card = await openCard();
    expect(await within(card).findByTestId('balance-value')).toHaveTextContent('0 credits');
    await act(async () => {
      await client.refetchQueries({ queryKey: [QueryKeys.balance], exact: true });
    });
    expect(getBalance).toHaveBeenCalledTimes(2);
    expect(client.getQueryState([QueryKeys.balance])?.status).toBe('error');
    expect(within(card).getByTestId('balance-value')).toHaveTextContent('0 credits');
    expect(within(card).getByRole('status')).toHaveTextContent('Out of credits');
    expect(within(card).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows loading until the balance HTTP response arrives', async () => {
    const pending = deferred<TBalanceResponse>();
    getBalance.mockReturnValue(pending.promise);
    renderCredits();
    const card = await openCard();
    expect(within(card).getByTestId('balance-summary')).toHaveAttribute('aria-busy', 'true');
    pending.resolve(balance);
    expect(await within(card).findByTestId('balance-value')).toHaveTextContent('3,100,000 credits');
  });

  it('shows an alert when the initial balance request fails', async () => {
    getBalance.mockRejectedValue(new Error('Balance service unavailable'));
    renderCredits();
    const card = await openCard();
    expect(await within(card).findByRole('alert')).toHaveTextContent("Couldn't load your balance");
    expect(getBalance).toHaveBeenCalledTimes(1);
  });

  it.each(['credits', 'currency', 'dollars'])(
    'agrees with Settings in %s mode',
    async (display) => {
      getConfig.mockResolvedValue(response(config({ display })));
      renderCredits();
      const card = await openCard();
      const amount = (await within(card).findByTestId('balance-value')).textContent;
      const refill = within(card).getByTestId('balance-refill').textContent;
      const settings = render(
        <>
          <TokenCredits />
          <AutoRefill />
        </>,
        { wrapper: Wrapper },
      );
      expect(await within(settings.container).findByTestId('balance-value')).toHaveTextContent(
        amount!,
      );
      expect(within(settings.container).getByTestId('balance-refill')).toHaveTextContent(refill!);
      expect(getBalance).toHaveBeenCalledTimes(1);
    },
  );

  it('agrees with Settings when the refill amount is not positive', async () => {
    getBalance.mockResolvedValue(response({ ...balance, refillAmount: 0 }));
    renderCredits();
    const card = await openCard();
    expect(await within(card).findByTestId('balance-refill')).toHaveTextContent(
      "Doesn't refill automatically",
    );
    const settings = render(<AutoRefill />, { wrapper: Wrapper });
    expect(await within(settings.container).findByText('Auto-Refill is disabled.')).toBeVisible();
    expect(settings.container).not.toHaveTextContent('Error loading auto-refill settings.');
  });

  it('shows the auto-refill row loading without the balance row', async () => {
    const pending = deferred<TBalanceResponse>();
    getBalance.mockReturnValue(pending.promise);
    const settings = render(<AutoRefill />, { wrapper: Wrapper });
    await waitFor(() => expect(getBalance).toHaveBeenCalledTimes(1));
    expect(within(settings.container).getByTestId('auto-refill-loading')).toBeInTheDocument();
    pending.resolve(balance);
    await waitFor(() =>
      expect(
        within(settings.container).queryByTestId('auto-refill-loading'),
      ).not.toBeInTheDocument(),
    );
    expect(getBalance).toHaveBeenCalledTimes(1);
  });

  it('shows the auto-refill error without the balance row', async () => {
    getBalance.mockRejectedValue(new Error('Balance service unavailable'));
    const settings = render(<AutoRefill />, { wrapper: Wrapper });
    expect(await within(settings.container).findByRole('alert')).toHaveTextContent(
      'Error loading auto-refill settings.',
    );
    expect(getBalance).toHaveBeenCalledTimes(1);
  });
});
