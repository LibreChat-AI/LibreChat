import React from 'react';
import { I18nextProvider } from 'react-i18next';
import { render, screen, fireEvent } from '@testing-library/react';
import OutOfCreditNotice from './OutOfCreditNotice';
import i18n from '~/locales/i18n';

const mockUseCreditRequestStatus = jest.fn();

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, opts?: Record<string, unknown>) =>
    opts ? `${key} ${JSON.stringify(opts)}` : key,
  useCreditRequestStatus: () => mockUseCreditRequestStatus(),
}));

/**
 * The `<strong>{{duration}}</strong>`-style subtitles render via a real
 * `<Trans>` (so the bold tag survives), which needs a genuine i18next
 * instance on context — the `useLocalize` mock above only covers plain
 * `localize()` calls, not `Trans`.
 */
function renderNotice() {
  return render(
    <I18nextProvider i18n={i18n}>
      <OutOfCreditNotice />
    </I18nextProvider>,
  );
}

function baseStatus(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    isLoading: false,
    tokenCredits: 5000,
    refillAmount: undefined,
    nextRefillAt: undefined,
    pendingCreditRequest: undefined,
    submit: jest.fn(),
    isSubmitting: false,
    ...overrides,
  };
}

describe('OutOfCreditNotice', () => {
  it('renders nothing when the user has a healthy balance', () => {
    mockUseCreditRequestStatus.mockReturnValue(baseStatus());

    const { container } = renderNotice();

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when balance is disabled for this deployment, even though tokenCredits defaults to 0', () => {
    mockUseCreditRequestStatus.mockReturnValue(baseStatus({ enabled: false, tokenCredits: 0 }));

    const { container } = renderNotice();

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the balance query is still loading, even though tokenCredits defaults to 0', () => {
    mockUseCreditRequestStatus.mockReturnValue(baseStatus({ isLoading: true, tokenCredits: 0 }));

    const { container } = renderNotice();

    expect(container).toBeEmptyDOMElement();
  });

  it('shows the out-of-credits card and a Request reset CTA when tokenCredits is zero', () => {
    mockUseCreditRequestStatus.mockReturnValue(baseStatus({ tokenCredits: 0 }));

    renderNotice();

    expect(screen.getByText('com_nav_balance_out_of_credit_title')).toBeInTheDocument();
    expect(screen.getByText('com_nav_balance_request_reset_button')).toBeInTheDocument();
  });

  it('shows the "Reset requested" state (clock icon, new title/subtitle, Pending pill) when a request is pending', () => {
    mockUseCreditRequestStatus.mockReturnValue(
      baseStatus({
        tokenCredits: 0,
        pendingCreditRequest: { requestId: 'req-1', requestedAt: new Date().toISOString() },
      }),
    );

    renderNotice();

    // A pending request replaces the title/subtitle entirely — it's a
    // distinct state, not just the out-of-credits card with a different
    // button.
    expect(screen.queryByText('com_nav_balance_out_of_credit_title')).not.toBeInTheDocument();
    expect(screen.getByText('com_nav_balance_reset_requested_title')).toBeInTheDocument();
    expect(
      screen.getByText('com_nav_balance_reset_requested_subtitle_no_refill'),
    ).toBeInTheDocument();
    expect(screen.getByText('com_nav_balance_pending_pill')).toBeInTheDocument();
    expect(screen.queryByText('com_nav_balance_request_reset_button')).not.toBeInTheDocument();
  });

  it('shows the "Reset requested" state for the running-low case too, without the progress bar', () => {
    mockUseCreditRequestStatus.mockReturnValue(
      baseStatus({
        tokenCredits: 1200,
        refillAmount: 10000,
        pendingCreditRequest: { requestId: 'req-1', requestedAt: new Date().toISOString() },
      }),
    );

    renderNotice();

    expect(screen.queryByText('com_nav_balance_running_low_title')).not.toBeInTheDocument();
    expect(screen.getByText('com_nav_balance_reset_requested_title')).toBeInTheDocument();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.getByText('com_nav_balance_pending_pill')).toBeInTheDocument();
    expect(screen.queryByText('com_nav_balance_request_reset_button')).not.toBeInTheDocument();
  });

  it('shows the countdown in the "Reset requested" subtitle when a next refill time is available', () => {
    const nextRefillAt = new Date(Date.now() + 3 * 60 * 60 * 1000 + 12 * 60 * 1000);
    mockUseCreditRequestStatus.mockReturnValue(
      baseStatus({
        tokenCredits: 0,
        nextRefillAt,
        pendingCreditRequest: { requestId: 'req-1', requestedAt: new Date().toISOString() },
      }),
    );

    renderNotice();

    const duration = `com_nav_balance_refill_countdown_hm ${JSON.stringify({ hours: 3, minutes: 12 })}`;
    const strong = screen.getByText(duration, { selector: 'strong' });
    expect(strong.closest('span')).toHaveTextContent(
      `Awaiting admin approval · refills in ${duration}`,
    );
  });

  it('opens a reason-collecting confirmation dialog from the Request reset button, and submits the trimmed reason', () => {
    const submit = jest.fn();
    mockUseCreditRequestStatus.mockReturnValue(baseStatus({ tokenCredits: 0, submit }));

    renderNotice();
    fireEvent.click(screen.getByText('com_nav_balance_request_reset_button'));

    expect(screen.getByText('com_nav_balance_reset_dialog_title')).toBeInTheDocument();
    expect(screen.getByText('com_nav_balance_reset_dialog_description')).toBeInTheDocument();
    const textarea = screen.getByPlaceholderText('com_nav_balance_reset_reason_placeholder');
    fireEvent.change(textarea, { target: { value: '  finishing a report  ' } });
    fireEvent.click(screen.getByText('com_nav_balance_send_request_button'));

    expect(submit).toHaveBeenCalledWith('finishing a report');
  });

  it('shows the "running low" warning with a progress bar when below 20% of the configured refill amount', () => {
    mockUseCreditRequestStatus.mockReturnValue(
      baseStatus({ tokenCredits: 1200, refillAmount: 10000 }),
    );

    renderNotice();

    expect(screen.getByText('com_nav_balance_running_low_title')).toBeInTheDocument();
    const credits = screen.getByText('1,200', { selector: 'strong' });
    expect(credits.closest('span')).toHaveTextContent('1,200 credits left');
    expect(screen.getByRole('meter')).toBeInTheDocument();
  });

  it('does not show the "running low" warning when no refillAmount is configured (nothing to compare against)', () => {
    mockUseCreditRequestStatus.mockReturnValue(baseStatus({ tokenCredits: 100 }));

    const { container } = renderNotice();

    expect(container).toBeEmptyDOMElement();
  });

  it('does not show the "running low" warning when the balance is still above the threshold', () => {
    mockUseCreditRequestStatus.mockReturnValue(
      baseStatus({ tokenCredits: 5000, refillAmount: 10000 }),
    );

    const { container } = renderNotice();

    expect(container).toBeEmptyDOMElement();
  });

  it('shows a live countdown when a next refill time is available', () => {
    const nextRefillAt = new Date(Date.now() + 3 * 60 * 60 * 1000 + 12 * 60 * 1000);
    mockUseCreditRequestStatus.mockReturnValue(baseStatus({ tokenCredits: 0, nextRefillAt }));

    renderNotice();

    // The countdown ("3 hr 12 min") is computed and threaded through as the
    // outer subtitle's `duration` interpolation value, rendered bold.
    const duration = `com_nav_balance_refill_countdown_hm ${JSON.stringify({ hours: 3, minutes: 12 })}`;
    const strong = screen.getByText(duration, { selector: 'strong' });
    expect(strong.closest('span')).toHaveTextContent(`Your balance refills in ${duration}`);
  });
});
