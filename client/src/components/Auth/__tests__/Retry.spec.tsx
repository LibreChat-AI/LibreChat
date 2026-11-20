import { render, screen, fireEvent } from '@testing-library/react';
import Retry from '~/components/Auth/Retry';

jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => (key: string) => key,
}));

describe('Retry', () => {
  it('calls onRetry when the button is clicked', () => {
    const onRetry = jest.fn();
    render(<Retry onRetry={onRetry} />);

    fireEvent.click(screen.getByRole('button', { name: 'com_auth_session_check_retry' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('disables the button and shows retrying copy while isRetrying is true', () => {
    const onRetry = jest.fn();
    render(<Retry onRetry={onRetry} isRetrying />);

    const button = screen.getByRole('button', { name: 'com_auth_session_check_retrying' });
    expect(button).toBeDisabled();

    fireEvent.click(button);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('announces the unavailable message in a live region', () => {
    render(<Retry onRetry={jest.fn()} />);

    const heading = screen.getByRole('heading', {
      name: 'com_auth_session_check_unavailable_title',
    });
    expect(heading).toHaveAttribute('aria-live', 'polite');
    expect(heading).toHaveAttribute('aria-atomic', 'true');
  });
});
