import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@testing-library/react';
import type { BranchUsage } from '~/utils/tokens';
import Usage from './Usage';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const usage: BranchUsage = {
  input: 37_900,
  output: 551_600,
  cacheRead: 60_900_000,
  cacheWrite: 4_900_000,
  cost: 39.45,
  costKnown: true,
};

const renderUsage = (props: Partial<React.ComponentProps<typeof Usage>> = {}) =>
  render(
    <Usage
      title="com_ui_context_current_turn"
      usage={usage}
      cost={usage.cost}
      costLabel="com_ui_context_cost_current_turn"
      testId="usage"
      {...props}
    />,
  );

describe('Token usage summary', () => {
  it('keeps all metrics visible in a condensed, labelled summary', () => {
    renderUsage();
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    const section = screen.getByRole('region', { name: 'com_ui_context_current_turn' });
    expect(within(section).getByRole('heading')).toHaveTextContent('$39.45');
    for (const value of ['37.9K', '551.6K', '60.9M', '4.9M']) {
      expect(within(section).getByText(value)).toBeVisible();
    }
    for (const label of [
      'com_ui_context_uncached_input',
      'com_ui_output',
      'com_ui_cache_read',
      'com_ui_cache_write',
    ]) {
      expect(within(section).getByText(label).tagName).toBe('DT');
    }
    expect(section.querySelector('dl')).toHaveClass('grid-cols-2');
  });

  it('discloses full-size details with Enter and Space without duplicating metrics', async () => {
    renderUsage();
    const trigger = screen.getByRole('button');
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const content = document.getElementById(trigger.getAttribute('aria-controls')!);
    expect(content).toContainElement(screen.getByText('60.9M'));
    expect(content?.querySelector('dl')).toHaveClass('text-sm');
    expect(screen.getAllByText('37.9K')).toHaveLength(1);
    await userEvent.keyboard(' ');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('37.9K')).toBeVisible();
  });

  it('shows known zeroes, but never substitutes missing usage with zero', () => {
    const { rerender } = renderUsage({
      usage: { ...usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
    });
    expect(screen.getAllByText('0')).toHaveLength(4);
    expect(screen.getByTestId('usage-cost')).toHaveTextContent('$0.00');
    rerender(
      <Usage
        title="com_ui_context_current_turn"
        unavailable="com_ui_context_waiting_usage"
        costLabel="com_ui_context_cost_current_turn"
        testId="usage"
      />,
    );
    expect(screen.getByRole('button')).toBeDisabled();
    expect(screen.getByText('com_ui_context_waiting_usage')).toBeVisible();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('usage-cost')).not.toBeInTheDocument();
  });

  it('keeps the subagent subtotal explicitly all-branches and honors currency', () => {
    renderUsage({
      subagentTokens: 44_600_000,
      currency: { code: 'EUR', rate: 2 },
    });
    expect(screen.getByText('com_ui_context_subagents_all').nextElementSibling).toHaveTextContent(
      '44.6M',
    );
    expect(screen.getByTestId('usage-cost')).toHaveTextContent('€78.90');
  });

  it('omits unknown and non-finite costs', () => {
    const { rerender } = renderUsage({ cost: undefined });
    expect(screen.queryByTestId('usage-cost')).not.toBeInTheDocument();
    rerender(
      <Usage
        title="com_ui_context_current_turn"
        usage={usage}
        cost={NaN}
        costLabel="com_ui_context_cost_current_turn"
        testId="usage"
      />,
    );
    expect(screen.queryByTestId('usage-cost')).not.toBeInTheDocument();
  });
});
