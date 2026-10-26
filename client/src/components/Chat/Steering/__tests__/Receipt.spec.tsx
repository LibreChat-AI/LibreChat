import React from 'react';
import { render, screen } from '@testing-library/react';
import Receipt from '../Receipt';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => {
    const english: Record<string, string> = jest.requireActual('~/locales/en/translation.json');
    return english[key] ?? key;
  },
}));

jest.mock('@librechat/client', () => ({
  ESide: { Top: 'top' },
  InfoHoverCard: ({ text, children }: { text: string; children: React.ReactNode }) => (
    <span aria-label={text}>{children}</span>
  ),
}));

describe('Steer receipt copy', () => {
  it('describes accepted guidance as waiting to apply', () => {
    render(<Receipt state="delivered" />);

    expect(screen.getByTestId('steer-receipt')).toHaveTextContent('Waiting to apply');
  });

  it('explains that accepted guidance has not reached the agent yet', () => {
    render(<Receipt state="delivered" />);

    expect(
      screen.getByLabelText(
        'Waiting to apply. Your message was accepted and will reach the agent at a safe insertion point after the current tool or reasoning step.',
      ),
    ).toBeInTheDocument();
  });
});
