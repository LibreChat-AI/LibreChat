import React from 'react';
import { render, screen } from '@testing-library/react';
import RequestCreditsButton from './RequestCreditsButton';

const mockUseCreditRequestStatus = jest.fn();

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useCreditRequestStatus: () => mockUseCreditRequestStatus(),
}));

describe('RequestCreditsButton', () => {
  it('shows a "Request sent" disabled state when a request is already pending', () => {
    mockUseCreditRequestStatus.mockReturnValue({
      enabled: true,
      isLoading: false,
      tokenCredits: 0,
      pendingCreditRequest: { requestId: 'req-1', requestedAt: new Date().toISOString() },
      submit: jest.fn(),
      isSubmitting: false,
    });

    render(<RequestCreditsButton />);

    const button = screen.getByText('com_nav_balance_request_sent');
    expect(button).toBeDisabled();
  });

  it('shows an enabled "Request more credits" trigger when nothing is pending', () => {
    mockUseCreditRequestStatus.mockReturnValue({
      enabled: true,
      isLoading: false,
      tokenCredits: 100,
      pendingCreditRequest: undefined,
      submit: jest.fn(),
      isSubmitting: false,
    });

    render(<RequestCreditsButton />);

    const button = screen.getByText('com_nav_balance_request_button');
    expect(button).not.toBeDisabled();
  });
});
