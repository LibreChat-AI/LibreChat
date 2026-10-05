import { render, screen } from '@testing-library/react';
import type { TBalanceResponse } from 'librechat-data-provider';
import type { BalanceState } from '~/hooks/useBalanceSummary';
import { summarizeBalance } from '~/utils';
import Summary from '../Summary';

const NOW = Date.parse('2026-07-05T00:00:00.000Z');

const record: TBalanceResponse = {
  tokenCredits: 3_100_000,
  autoRefillEnabled: true,
  refillAmount: 5_000_000,
  refillIntervalValue: 7,
  refillIntervalUnit: 'days',
  lastRefill: '2026-07-01T00:00:00.000Z',
};

const success = (
  display: 'credits' | 'currency' | 'percent',
  over: Partial<TBalanceResponse> = {},
): BalanceState => ({
  status: 'success',
  summary: summarizeBalance({ ...record, ...over }, { display, startBalance: 20_000 }),
});

describe('balance Summary', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows credits, the share spent and the next refill', () => {
    render(<Summary state={success('credits')} />);
    expect(screen.getByRole('heading', { name: 'Balance' })).toBeInTheDocument();
    expect(screen.getByTestId('balance-value')).toHaveTextContent('3,100,000 credits');
    expect(screen.getByRole('progressbar', { name: 'Share of balance used' })).toHaveAttribute(
      'aria-valuenow',
      '38',
    );
    expect(screen.getByTestId('balance-refill')).toHaveTextContent(
      '+5,000,000 available in 3 days',
    );
    expect(screen.getByTestId('balance-status')).toHaveTextContent('38% used');
  });

  it('shows money in currency mode', () => {
    render(<Summary state={success('currency')} currency={{ code: 'EUR', rate: 0.5 }} />);
    expect(screen.getByTestId('balance-value')).toHaveTextContent('€1.55');
    expect(screen.getByTestId('balance-refill')).toHaveTextContent('+€2.50 available in 3 days');
  });

  it('shows no credit or money figure in percent mode', () => {
    const { container } = render(<Summary state={success('percent')} />);
    expect(screen.getByRole('heading', { name: 'Usage limit' })).toBeInTheDocument();
    expect(screen.getByTestId('balance-value')).toHaveTextContent('38% used');
    expect(screen.getByTestId('balance-refill')).toHaveTextContent('Refill available in 3 days');
    expect(container).not.toHaveTextContent(/credits|5,000,000|3,100,000|\$/);
  });

  it('says when a due refill will land rather than a past date', () => {
    render(<Summary state={success('percent', { lastRefill: '2026-06-01T00:00:00.000Z' })} />);
    expect(screen.getByTestId('balance-refill')).toHaveTextContent('Refills when you run out');
  });

  it('flags an empty balance', () => {
    render(<Summary state={success('credits', { tokenCredits: 0 })} />);
    expect(screen.getByTestId('balance-status')).toHaveTextContent('Out of credits');
    expect(screen.getByTestId('balance-value')).toHaveClass('text-text-destructive');
  });

  it('says usage is unavailable in percent mode when nothing measures the spend', () => {
    const state: BalanceState = {
      status: 'success',
      summary: summarizeBalance(
        { tokenCredits: 900, autoRefillEnabled: false },
        { display: 'percent', startBalance: 0 },
      ),
    };
    render(<Summary state={state} />);
    expect(screen.getByTestId('balance-value')).toHaveTextContent('Usage unavailable');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('reads an empty balance as fully used even without an allotment', () => {
    const state: BalanceState = {
      status: 'success',
      summary: summarizeBalance(
        { tokenCredits: 0, autoRefillEnabled: false },
        { display: 'percent', startBalance: 0 },
      ),
    };
    render(<Summary state={state} />);
    expect(screen.getByTestId('balance-value')).toHaveTextContent('100% used');
    expect(screen.getByTestId('balance-status')).toHaveTextContent('Out of credits');
  });

  it('omits the bar when nothing measures the spend', () => {
    const state: BalanceState = {
      status: 'success',
      summary: summarizeBalance({ tokenCredits: 900, autoRefillEnabled: false }),
    };
    render(<Summary state={state} />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByTestId('balance-refill')).toHaveTextContent("Doesn't refill automatically");
  });

  it('marks itself busy while loading', () => {
    render(<Summary state={{ status: 'loading' }} />);
    expect(screen.getByTestId('balance-summary')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByTestId('balance-value')).not.toBeInTheDocument();
  });

  it('reports a failed load', () => {
    render(<Summary state={{ status: 'error' }} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load your balance");
  });

  it('renders nothing when the server has no balance for the user', () => {
    const { container } = render(<Summary state={{ status: 'empty' }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
