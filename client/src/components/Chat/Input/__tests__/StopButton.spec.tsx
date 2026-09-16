import { render, screen, fireEvent } from '@testing-library/react';
import StopButton from '../StopButton';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

describe('StopButton', () => {
  it('hides itself and aborts the run on click', () => {
    const stop = jest.fn();
    const setShowStopButton = jest.fn();
    render(<StopButton stop={stop} setShowStopButton={setShowStopButton} />);

    fireEvent.click(screen.getByTestId('stop-generation-button'));

    expect(setShowStopButton).toHaveBeenCalledWith(false);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('stays visible but inert while the abort would be a no-op', () => {
    const stop = jest.fn();
    const setShowStopButton = jest.fn();
    render(<StopButton stop={stop} setShowStopButton={setShowStopButton} canStop={false} />);

    const button = screen.getByTestId('stop-generation-button');
    expect(button).toBeDisabled();

    fireEvent.click(button);

    expect(setShowStopButton).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it('keeps an out-of-layout control the stop shortcut can still reach', () => {
    const stop = jest.fn();
    const setShowStopButton = jest.fn();
    render(<StopButton stop={stop} setShowStopButton={setShowStopButton} hidden />);

    const button = screen.getByTestId('stop-generation-button');
    expect(button).toHaveClass('hidden');
    expect(button).not.toHaveClass('flex');

    button.click();

    expect(setShowStopButton).toHaveBeenCalledWith(false);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
