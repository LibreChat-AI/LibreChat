import { QueryKeys } from 'librechat-data-provider';
import userEvent from '@testing-library/user-event';
import { act, cleanup, render, screen, within, waitFor } from '@testing-library/react';
import type { TBalanceResponse } from 'librechat-data-provider';
import { balance, config, response, deferred, createBalanceTestHarness } from 'test/balance';
import { TokenCredits, AutoRefill } from '~/components/Nav/Settings/BillingControls';
import Credits from '../Credits';

const NOW = Date.parse('2026-07-05T00:00:00.000Z');
let harness: ReturnType<typeof createBalanceTestHarness>;
const renderCredits = (mobile = false) =>
  render(<Credits mobile={mobile} />, { wrapper: harness.Wrapper });
const openCard = async () => {
  const interaction = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
  await interaction.click(await screen.findByRole('button', { name: 'Account usage' }));
  return screen.findByRole('dialog', { name: 'Account usage' });
};

describe('sidebar credits', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    harness = createBalanceTestHarness();
  });
  afterEach(() => {
    cleanup();
    harness.client.clear();
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
      harness.getConfig.mockResolvedValue(response(config({ balanceEnabled: false })));
    if (reason === 'signed out') harness.state.authenticated = false;
    renderCredits();
    await waitFor(() =>
      expect(
        harness.client.getQueryState([
          QueryKeys.startupConfig,
          harness.state.authenticated,
          'default',
        ])?.status,
      ).toBe('success'),
    );
    expect(screen.queryByRole('button', { name: 'Account usage' })).not.toBeInTheDocument();
    expect(harness.getBalance).not.toHaveBeenCalled();
  });

  it('does not request config or balance while queries are disabled', () => {
    harness.state.queriesEnabled = false;
    renderCredits();
    expect(screen.queryByRole('button', { name: 'Account usage' })).not.toBeInTheDocument();
    expect(harness.getConfig).not.toHaveBeenCalled();
    expect(harness.getBalance).not.toHaveBeenCalled();
  });

  it('waits for config before requesting the balance', async () => {
    const pending = deferred<ReturnType<typeof config>>();
    harness.getConfig.mockReturnValue(pending.promise);
    renderCredits();
    await waitFor(() => expect(harness.getConfig).toHaveBeenCalledTimes(1));
    expect(harness.getBalance).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Account usage' })).not.toBeInTheDocument();
    pending.resolve(config());
    const card = await openCard();
    expect(await within(card).findByTestId('balance-value')).toHaveTextContent('3,100,000 credits');
  });

  it('hides the control after a successful response with no balance record', async () => {
    harness.getBalance.mockResolvedValue(response(null));
    renderCredits();
    await waitFor(() =>
      expect(harness.client.getQueryState([QueryKeys.balance])?.status).toBe('success'),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Account usage' })).not.toBeInTheDocument(),
    );
    expect(harness.getBalance).toHaveBeenCalledTimes(1);
  });

  it('shows no amounts in percent mode', async () => {
    harness.getConfig.mockResolvedValue(response(config({ display: 'percent' })));
    renderCredits();
    const card = await openCard();
    expect(await within(card).findByTestId('balance-value')).toHaveTextContent('62% left');
    expect(card).not.toHaveTextContent(/credits|3,100,000|5,000,000|\$/i);
  });

  it('keeps unknown allowance distinct from zero remaining', async () => {
    harness.getConfig.mockResolvedValue(
      response({
        ...config({ display: 'percent' }),
        balance: { enabled: true, startBalance: 0, display: 'percent' },
      }),
    );
    harness.getBalance.mockResolvedValue(response({ tokenCredits: 900, autoRefillEnabled: false }));
    renderCredits();
    const card = await openCard();
    expect(await within(card).findByTestId('balance-value')).toHaveTextContent('Usage unavailable');
    expect(card).not.toHaveTextContent('0% left');
  });

  it('keeps exhausted credits visible after a real failed refetch', async () => {
    harness.getBalance
      .mockResolvedValueOnce(response({ ...balance, tokenCredits: 0 }))
      .mockRejectedValue(new Error('Balance service unavailable'));
    renderCredits();
    const card = await openCard();
    expect(await within(card).findByTestId('balance-value')).toHaveTextContent('0 credits');
    await act(async () => {
      await harness.client.refetchQueries({ queryKey: [QueryKeys.balance], exact: true });
    });
    expect(harness.getBalance).toHaveBeenCalledTimes(2);
    expect(harness.client.getQueryState([QueryKeys.balance])?.status).toBe('error');
    expect(within(card).getByTestId('balance-value')).toHaveTextContent('0 credits');
    expect(within(card).getByRole('status')).toHaveTextContent('Out of credits');
    expect(within(card).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows loading until the balance HTTP response arrives', async () => {
    const pending = deferred<TBalanceResponse>();
    harness.getBalance.mockReturnValue(pending.promise);
    renderCredits();
    const card = await openCard();
    expect(within(card).getByTestId('balance-summary')).toHaveAttribute('aria-busy', 'true');
    pending.resolve(balance);
    expect(await within(card).findByTestId('balance-value')).toHaveTextContent('3,100,000 credits');
  });

  it('shows an alert when the initial balance request fails', async () => {
    harness.getBalance.mockRejectedValue(new Error('Balance service unavailable'));
    renderCredits();
    const card = await openCard();
    expect(await within(card).findByRole('alert')).toHaveTextContent("Couldn't load your balance");
    expect(harness.getBalance).toHaveBeenCalledTimes(1);
  });

  it.each(['credits', 'currency', 'dollars'])(
    'agrees with Settings in %s mode',
    async (display) => {
      harness.getConfig.mockResolvedValue(response(config({ display })));
      renderCredits();
      const card = await openCard();
      const amount = (await within(card).findByTestId('balance-value')).textContent;
      const refill = within(card).getByTestId('balance-refill').textContent;
      const settings = render(
        <>
          <TokenCredits />
          <AutoRefill />
        </>,
        { wrapper: harness.Wrapper },
      );
      expect(await within(settings.container).findByTestId('balance-value')).toHaveTextContent(
        amount!,
      );
      expect(within(settings.container).getByTestId('balance-refill')).toHaveTextContent(refill!);
      expect(harness.getBalance).toHaveBeenCalledTimes(1);
    },
  );

  it('agrees with Settings when the refill amount is not positive', async () => {
    harness.getBalance.mockResolvedValue(response({ ...balance, refillAmount: 0 }));
    renderCredits();
    const card = await openCard();
    expect(await within(card).findByTestId('balance-refill')).toHaveTextContent(
      "Doesn't refill automatically",
    );
    const settings = render(<AutoRefill />, { wrapper: harness.Wrapper });
    expect(await within(settings.container).findByText('Auto-Refill is disabled.')).toBeVisible();
    expect(settings.container).not.toHaveTextContent('Error loading auto-refill settings.');
  });

  it('shows the auto-refill row loading without the balance row', async () => {
    const pending = deferred<TBalanceResponse>();
    harness.getBalance.mockReturnValue(pending.promise);
    const settings = render(<AutoRefill />, { wrapper: harness.Wrapper });
    await waitFor(() => expect(harness.getBalance).toHaveBeenCalledTimes(1));
    expect(within(settings.container).getByTestId('auto-refill-loading')).toBeInTheDocument();
    pending.resolve(balance);
    await waitFor(() =>
      expect(
        within(settings.container).queryByTestId('auto-refill-loading'),
      ).not.toBeInTheDocument(),
    );
    expect(harness.getBalance).toHaveBeenCalledTimes(1);
  });

  it('shows the auto-refill error without the balance row', async () => {
    harness.getBalance.mockRejectedValue(new Error('Balance service unavailable'));
    const settings = render(<AutoRefill />, { wrapper: harness.Wrapper });
    expect(await within(settings.container).findByRole('alert')).toHaveTextContent(
      'Error loading auto-refill settings.',
    );
    expect(harness.getBalance).toHaveBeenCalledTimes(1);
  });
});
