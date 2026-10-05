import { render, screen, within } from '@testing-library/react';
import TokenCreditsItem from './TokenCreditsItem';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

it('shows available credits after holds and owed credits separately', () => {
  render(<TokenCreditsItem tokenCredits={100} reservedCredits={30} mediaDebtCredits={20} />);
  expect(screen.getByRole('note')).toHaveTextContent('100.00');
  for (const [label, amount] of [
    ['com_nav_balance_available', '70.00'],
    ['com_nav_balance_held', '10.00'],
    ['com_nav_balance_owed', '20.00'],
  ]) {
    const row = screen.getByText(label).parentElement!;
    expect(within(row).getByText(amount)).toBeVisible();
  }
});

it('keeps legacy balance responses usable and clamps spendable credits to zero', () => {
  const { rerender } = render(<TokenCreditsItem tokenCredits={100} />);
  expect(
    within(screen.getByText('com_nav_balance_available').parentElement!).getByText('100.00'),
  ).toBeVisible();
  rerender(<TokenCreditsItem tokenCredits={10} reservedCredits={20} mediaDebtCredits={30} />);
  expect(
    within(screen.getByText('com_nav_balance_available').parentElement!).getByText('0.00'),
  ).toBeVisible();
});
