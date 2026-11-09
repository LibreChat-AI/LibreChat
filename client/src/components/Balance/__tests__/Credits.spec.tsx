import { Provider, createStore } from 'jotai';
import userEvent from '@testing-library/user-event';
import { SettingsTabValues } from 'librechat-data-provider';
import { act, render, screen, within, waitFor } from '@testing-library/react';
import type { TBalanceResponse } from 'librechat-data-provider';
import type { ComponentProps } from 'react';
import type SettingsDialog from '~/components/Nav/Settings/Dialog';
import { TokenCredits, AutoRefill } from '~/components/Nav/Settings/BillingControls';
import Settings, { settingsOpenAtom } from '~/components/Nav/Settings';
import Credits from '../Credits';

const mockStartupConfig = jest.fn();
const mockBalance = jest.fn();
const mockBalanceQuery = jest.fn();
let mockAuthenticated = true;
const mockSettingsProps: { current?: ComponentProps<typeof SettingsDialog> } = {};

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockStartupConfig() }),
  useGetUserBalance: (config?: { enabled?: boolean }) =>
    config?.enabled === false
      ? { data: undefined, isError: false, isFetched: false }
      : (mockBalanceQuery() ?? { data: mockBalance(), isError: false, isFetched: true }),
}));
jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ isAuthenticated: mockAuthenticated }),
}));
jest.mock('~/components/Nav/Settings/Dialog', () => ({
  __esModule: true,
  default: (props: ComponentProps<typeof SettingsDialog>) => {
    mockSettingsProps.current = props;
    return <div data-testid="settings-dialog" />;
  },
}));

const NOW = Date.parse('2026-07-05T00:00:00.000Z');
const balance: TBalanceResponse = {
  tokenCredits: 3_100_000,
  autoRefillEnabled: true,
  refillAmount: 5_000_000,
  refillIntervalValue: 7,
  refillIntervalUnit: 'days',
  lastRefill: '2026-07-01T00:00:00.000Z',
};
const config = ({
  balanceEnabled = true,
  display = 'credits',
}: { balanceEnabled?: boolean; display?: string } = {}) => ({
  balance: { enabled: balanceEnabled, startBalance: 20_000, display },
  interface: { contextUsage: false, currency: { code: 'USD', rate: 1 } },
});
const renderCredits = (mobile = false) => {
  const store = createStore();
  const result = render(
    <Provider store={store}>
      <Credits mobile={mobile} />
      <Settings />
    </Provider>,
  );
  return { ...result, store };
};
const openCard = async () => {
  const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
  await user.click(screen.getByRole('button', { name: 'Account usage' }));
  return screen.findByRole('dialog', { name: 'Account usage' });
};

describe('sidebar credits', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    jest.clearAllMocks();
    mockStartupConfig.mockReturnValue(config());
    mockBalance.mockReturnValue(balance);
    mockBalanceQuery.mockReset();
    mockAuthenticated = true;
    mockSettingsProps.current = undefined;
  });
  afterEach(() => jest.useRealTimers());

  it.each([false, true])(
    'shows the account balance independently of context usage, mobile=%s',
    async (mobile) => {
      renderCredits(mobile);
      const card = await openCard();
      expect(within(card).getByText('62% left')).toBeVisible();
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
    const trigger = screen.getByRole('button', { name: 'Account usage' });
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    act(() => trigger.focus());
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Account usage' })).toBeVisible();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('opens Account billing and resets the destination for ordinary Settings opens', async () => {
    const { store } = renderCredits();
    const card = await openCard();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await user.click(within(card).getByRole('button', { name: 'Manage usage' }));
    await screen.findByTestId('settings-dialog');
    expect(mockSettingsProps.current).toMatchObject({
      initialTab: SettingsTabValues.ACCOUNT,
      initialSection: 'billing',
    });
    expect(screen.queryByRole('dialog', { name: 'Account usage' })).not.toBeInTheDocument();
    act(() => mockSettingsProps.current?.onOpenChange(false));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Account usage' })).toHaveFocus(),
    );
    act(() => store.set(settingsOpenAtom, true));
    await screen.findByTestId('settings-dialog');
    expect(mockSettingsProps.current?.initialTab).toBeUndefined();
    expect(mockSettingsProps.current?.initialSection).toBeUndefined();
  });

  it.each(['disabled', 'signed out', 'missing config', 'missing record'])(
    'hides the control when %s',
    (reason) => {
      if (reason === 'disabled')
        mockStartupConfig.mockReturnValue(config({ balanceEnabled: false }));
      if (reason === 'signed out') mockAuthenticated = false;
      if (reason === 'missing config') mockStartupConfig.mockReturnValue(undefined);
      if (reason === 'missing record') mockBalance.mockReturnValue(undefined);
      renderCredits();
      expect(screen.queryByRole('button', { name: 'Account usage' })).not.toBeInTheDocument();
      if (reason !== 'missing record') expect(mockBalanceQuery).not.toHaveBeenCalled();
    },
  );

  it('shows no amounts in percent mode', async () => {
    mockStartupConfig.mockReturnValue(config({ display: 'percent' }));
    renderCredits();
    const card = await openCard();
    expect(within(card).getByTestId('balance-value')).toHaveTextContent('62% left');
    expect(card).not.toHaveTextContent(/credits|3,100,000|5,000,000|\$/i);
  });

  it('keeps unknown allowance distinct from zero remaining', async () => {
    mockStartupConfig.mockReturnValue({
      balance: { enabled: true, startBalance: 0, display: 'percent' },
    });
    mockBalance.mockReturnValue({ tokenCredits: 900, autoRefillEnabled: false });
    renderCredits();
    const card = await openCard();
    expect(within(card).getByTestId('balance-value')).toHaveTextContent('Usage unavailable');
    expect(card).not.toHaveTextContent('0% left');
  });

  it('shows exhausted credits and keeps the shared stale reading after a refetch failure', async () => {
    mockBalanceQuery.mockReturnValue({
      data: { ...balance, tokenCredits: 0 },
      isError: true,
      isFetched: true,
    });
    renderCredits();
    const card = await openCard();
    expect(within(card).getByTestId('balance-value')).toHaveTextContent('0 credits');
    expect(within(card).getByRole('status')).toHaveTextContent('Out of credits');
    expect(within(card).queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    ['loading', { data: undefined, isError: false, isFetched: false }],
    ['error', { data: undefined, isError: true, isFetched: true }],
  ] as const)('keeps %s feedback in the popover', async (status, query) => {
    mockBalanceQuery.mockReturnValue(query);
    renderCredits();
    const card = await openCard();
    if (status === 'loading')
      expect(within(card).getByTestId('balance-summary')).toHaveAttribute('aria-busy', 'true');
    else expect(within(card).getByRole('alert')).toHaveTextContent("Couldn't load your balance");
  });

  it.each(['credits', 'currency', 'dollars'])(
    'preserves the configured %s amount and refill in settings',
    async (display) => {
      mockStartupConfig.mockReturnValue(config({ display }));
      renderCredits();
      const card = await openCard();
      const amount = within(card).getByTestId('balance-value').textContent;
      const refill = within(card).getByTestId('balance-refill').textContent;
      const settings = render(
        <>
          <TokenCredits />
          <AutoRefill />
        </>,
      );
      expect(within(settings.container).getByTestId('balance-value')).toHaveTextContent(amount!);
      expect(within(settings.container).getByTestId('balance-refill')).toHaveTextContent(refill!);
    },
  );
  it('agrees with the card when auto-refill is on but the refill amount is not positive', async () => {
    mockStartupConfig.mockReturnValue(config());
    mockBalance.mockReturnValue({ ...balance, refillAmount: 0 });
    renderCredits();
    const card = await openCard();
    expect(within(card).getByTestId('balance-refill')).toHaveTextContent(
      "Doesn't refill automatically",
    );
    const settings = render(<AutoRefill />);
    expect(settings.container).toHaveTextContent('Auto-Refill is disabled.');
    expect(settings.container).not.toHaveTextContent('Error loading auto-refill settings.');
  });

  it.each([
    ['loading', { data: undefined, isError: false, isFetched: false }, 'auto-refill-loading'],
    ['failed', { data: undefined, isError: true, isFetched: true }, 'alert'],
  ] as const)(
    'shows the auto-refill row %s on its own when settings search hides the balance row',
    (_state, query, marker) => {
      mockStartupConfig.mockReturnValue(config());
      mockBalanceQuery.mockReturnValue(query);
      const settings = render(<AutoRefill />);
      const node =
        marker === 'alert'
          ? within(settings.container).getByRole('alert')
          : within(settings.container).getByTestId(marker);
      expect(node).toBeInTheDocument();
      if (marker === 'alert') {
        expect(node).toHaveTextContent('Error loading auto-refill settings.');
      }
    },
  );
});
