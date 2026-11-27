import { WifiOff } from 'lucide-react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import RetryableError from './RetryableError';

const labels = {
  retry: 'Try Again',
  retrying: 'Retrying',
  countdown: (seconds: number) => `Retrying automatically in ${seconds}s`,
};

describe('RetryableError', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('retries on its own until the backoff is spent', () => {
    const onRetry = jest.fn();
    render(
      <RetryableError
        icon={WifiOff}
        title="Connection Problem"
        detail="Check your connection"
        labels={labels}
        onRetry={onRetry}
        retryDelaysMs={[1000, 2000]}
      />,
    );

    expect(screen.getByText('Retrying automatically in 1s')).toBeInTheDocument();

    for (const delay of [1000, 2000]) {
      act(() => {
        jest.advanceTimersByTime(delay);
      });
    }

    expect(onRetry).toHaveBeenCalledTimes(2);
    act(() => {
      jest.advanceTimersByTime(60000);
    });
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Retrying automatically/)).not.toBeInTheDocument();
  });

  it('offers the reload escape hatch only when a label is given for it', () => {
    const exhaust = () =>
      act(() => {
        jest.advanceTimersByTime(1000);
      });

    const { unmount } = render(
      <RetryableError
        title="Connection Problem"
        labels={labels}
        onRetry={jest.fn()}
        retryDelaysMs={[1000]}
      />,
    );
    exhaust();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    unmount();

    render(
      <RetryableError
        title="Connection Problem"
        labels={{ ...labels, reload: 'Refresh page' }}
        onRetry={jest.fn()}
        retryDelaysMs={[1000]}
      />,
    );
    exhaust();
    expect(screen.getByRole('button', { name: 'Refresh page' })).toBeInTheDocument();
  });

  it('leaves failures a repeat request cannot fix alone', () => {
    const onRetry = jest.fn();
    render(
      <RetryableError title="Not Found" labels={labels} onRetry={onRetry} autoRetry={false} />,
    );

    act(() => {
      jest.advanceTimersByTime(60000);
    });
    expect(onRetry).not.toHaveBeenCalled();
    expect(screen.queryByText(/Retrying automatically/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('keeps the retry control focusable and blocks a second activation while retrying', () => {
    const onRetry = jest.fn();
    render(
      <RetryableError title="Connection Problem" labels={labels} onRetry={onRetry} isRetrying />,
    );

    const button = screen.getByRole('button', { name: 'Retrying' });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onRetry).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Retrying');
  });
});
