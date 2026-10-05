import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@testing-library/react';
import type { TBalanceResponse, TConversation } from 'librechat-data-provider';
import type { TokenUsageView } from '~/hooks/Chat/useTokenUsage';
import { TokenCredits, AutoRefill } from '~/components/Nav/Settings/BillingControls';
import TokenUsage from './index';

const mockStartupConfig = jest.fn();
const mockBalance = jest.fn();
const mockTokenUsage = jest.fn();

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockStartupConfig() }),
  useGetUserBalance: (config?: { enabled?: boolean }) =>
    config?.enabled === false
      ? { data: undefined, isError: false, isFetched: false }
      : { data: mockBalance(), isError: false, isFetched: true },
  useGetLangfuseSessionLinkQuery: () => ({ data: undefined }),
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ isAuthenticated: true }),
}));

jest.mock('~/hooks/Chat/useTokenUsage', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockTokenUsage(...args),
}));

jest.mock('~/hooks/Chat/useCompactConversation', () => ({
  __esModule: true,
  default: () => ({ compact: jest.fn(), canCompact: false, isCompacting: false }),
  supportsCompaction: () => false,
}));

jest.mock('./Breakdown', () => ({
  __esModule: true,
  default: () => <div data-testid="context-breakdown-stub" />,
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
  contextUsage,
}: {
  balanceEnabled?: boolean;
  display?: 'credits' | 'currency' | 'percent';
  contextUsage?: boolean;
} = {}) => ({
  balance: { enabled: balanceEnabled, startBalance: 20_000, display },
  interface: { contextUsage, currency: { code: 'USD', rate: 1 } },
});

const usage = (usedTokens: number) =>
  ({ usedTokens, maxTokens: 200_000, percent: (usedTokens / 200_000) * 100 }) as TokenUsageView;

const conversation = { conversationId: 'convo-1', endpoint: 'openAI' } as TConversation;

const renderGauge = () =>
  render(<TokenUsage index={0} conversation={conversation} isSubmitting={false} />);

const openCard = async () => {
  const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
  await user.click(screen.getByTestId('token-usage'));
  return screen.findByRole('dialog');
};

describe('TokenUsage gauge', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    mockBalance.mockReturnValue(balance);
    mockTokenUsage.mockReturnValue(usage(0));
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('stays hidden on a fresh chat when balance is off', () => {
    mockStartupConfig.mockReturnValue(config({ balanceEnabled: false }));
    renderGauge();
    expect(screen.queryByTestId('token-usage')).not.toBeInTheDocument();
  });

  it('shows the balance on a fresh chat when balance is on', async () => {
    mockStartupConfig.mockReturnValue(config());
    renderGauge();
    const card = await openCard();
    expect(within(card).getByTestId('balance-summary')).toBeInTheDocument();
    expect(within(card).queryByTestId('context-breakdown-stub')).not.toBeInTheDocument();
  });

  it('places the balance below the context window', async () => {
    mockStartupConfig.mockReturnValue(config());
    mockTokenUsage.mockReturnValue(usage(83_200));
    renderGauge();
    const card = await openCard();
    const context = within(card).getByTestId('context-breakdown-stub');
    const summary = within(card).getByTestId('balance-summary');
    expect(context.compareDocumentPosition(summary)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('keeps a balance-only gauge when context usage is off, without reading context', async () => {
    mockStartupConfig.mockReturnValue(config({ contextUsage: false, display: 'percent' }));
    renderGauge();
    expect(mockTokenUsage).not.toHaveBeenCalled();
    expect(screen.getByRole('meter', { name: 'Share of balance used' })).toHaveAttribute(
      'aria-valuenow',
      '38',
    );
    const card = await openCard();
    expect(within(card).getByTestId('balance-value')).toHaveTextContent('38% used');
  });

  it('mounts nothing when both context usage and balance are off', () => {
    mockStartupConfig.mockReturnValue(config({ balanceEnabled: false, contextUsage: false }));
    const { container } = renderGauge();
    expect(container).toBeEmptyDOMElement();
  });

  it.each(['credits', 'currency', 'percent'] as const)(
    'shows the same %s reading in the gauge and in settings',
    async (display) => {
      mockStartupConfig.mockReturnValue(config({ display }));
      renderGauge();
      const card = await openCard();
      const gauge = within(card).getByTestId('balance-summary').textContent;

      const settings = render(
        <>
          <TokenCredits />
          <AutoRefill />
        </>,
      );
      const settingsSummary = within(settings.container).getByTestId('balance-summary');
      expect(settingsSummary.textContent).toBe(gauge);

      const refillRow = within(settings.container).queryByText('Refill Amount:');
      if (display === 'percent') {
        expect(refillRow).not.toBeInTheDocument();
        expect(settings.container).not.toHaveTextContent(/5,000,000|\$5\.00/);
      } else {
        const amount = display === 'currency' ? '$5.00' : '5,000,000';
        expect(refillRow?.nextElementSibling).toHaveTextContent(amount);
        expect(gauge).toContain(`+${amount}`);
      }
    },
  );
});
