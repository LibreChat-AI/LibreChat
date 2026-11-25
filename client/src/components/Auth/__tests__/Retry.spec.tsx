import { render, screen, fireEvent } from '@testing-library/react';
import Retry from '~/components/Auth/Retry';

jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => (key: string) => key,
}));

describe('Retry', () => {
  it('calls onRetry when the button is clicked', () => {
    const onRetry = jest.fn();
    render(<Retry onRetry={onRetry} onSignInAgain={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'com_auth_session_check_retry' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('disables the button and shows retrying copy while isRetrying is true', () => {
    const onRetry = jest.fn();
    render(<Retry onRetry={onRetry} onSignInAgain={jest.fn()} isRetrying />);

    const button = screen.getByRole('button', { name: 'com_auth_session_check_retrying' });
    expect(button).toBeDisabled();

    fireEvent.click(button);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('announces the unavailable message in a live region', () => {
    render(<Retry onRetry={jest.fn()} onSignInAgain={jest.fn()} />);

    const heading = screen.getByRole('heading', {
      name: 'com_auth_session_check_unavailable_title',
    });
    expect(heading).toHaveAttribute('aria-live', 'polite');
    expect(heading).toHaveAttribute('aria-atomic', 'true');
  });

  it('calls onSignInAgain when the sign-in button is clicked', () => {
    const onRetry = jest.fn();
    const onSignInAgain = jest.fn();
    render(<Retry onRetry={onRetry} onSignInAgain={onSignInAgain} />);

    fireEvent.click(screen.getByRole('button', { name: 'com_auth_session_check_sign_in_again' }));

    expect(onSignInAgain).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('keeps the sign-in button available while a retry is in progress', () => {
    const onSignInAgain = jest.fn();
    render(<Retry onRetry={jest.fn()} onSignInAgain={onSignInAgain} isRetrying />);

    const button = screen.getByRole('button', { name: 'com_auth_session_check_sign_in_again' });
    expect(button).toBeEnabled();

    fireEvent.click(button);
    expect(onSignInAgain).toHaveBeenCalledTimes(1);
  });
});
