import { StrictMode, createRef, useRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { RefObject } from 'react';
import useScrollToRef from '../useScrollToRef';

const followLabel = 'Follow';
const jumpLabel = 'Jump';
const scrollActions = [
  { label: followLabel, behavior: 'instant', interval: 145 },
  { label: jumpLabel, behavior: 'smooth', interval: 750 },
];

function Harness({
  callback,
  smoothCallback,
  targetRef: suppliedRef,
}: {
  callback: () => void;
  smoothCallback: () => void;
  targetRef?: RefObject<HTMLDivElement>;
}) {
  const localRef = useRef<HTMLDivElement>(null);
  const targetRef = suppliedRef ?? localRef;
  const { scrollToRef, handleSmoothToRef } = useScrollToRef({
    targetRef,
    callback,
    smoothCallback,
  });
  return (
    <div>
      <button onClick={() => scrollToRef?.()}>{followLabel}</button>
      <button onClick={handleSmoothToRef}>{jumpLabel}</button>
      <div ref={targetRef} data-testid="end" />
    </div>
  );
}

describe('useScrollToRef lifecycle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it.each(['Follow', 'Jump'])('cancels trailing %s work when the chat unmounts', (button) => {
    const callback = jest.fn();
    const smoothCallback = jest.fn();
    const { unmount } = render(<Harness callback={callback} smoothCallback={smoothCallback} />, {
      wrapper: StrictMode,
    });
    const scroll = jest.fn();
    screen.getByTestId('end').scrollIntoView = scroll;
    fireEvent.click(screen.getByText(button));
    fireEvent.click(screen.getByText(button));
    expect(callback.mock.calls.length + smoothCallback.mock.calls.length).toBe(1);

    unmount();
    act(() => jest.advanceTimersByTime(1000));
    expect(callback.mock.calls.length + smoothCallback.mock.calls.length).toBe(1);
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it.each(['Follow', 'Jump'])('uses the latest callback for pending %s work', (button) => {
    const previous = jest.fn();
    const latest = jest.fn();
    const { rerender } = render(<Harness callback={previous} smoothCallback={previous} />, {
      wrapper: StrictMode,
    });
    const scroll = jest.fn();
    screen.getByTestId('end').scrollIntoView = scroll;
    fireEvent.click(screen.getByText(button));
    fireEvent.click(screen.getByText(button));
    rerender(<Harness callback={latest} smoothCallback={latest} />);
    act(() => jest.advanceTimersByTime(1000));

    expect(previous).toHaveBeenCalledTimes(1);
    expect(latest).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledTimes(2);
  });

  it.each(scrollActions)(
    'preserves leading and trailing $label timing',
    ({ label, behavior, interval }) => {
      const callback = jest.fn();
      render(<Harness callback={callback} smoothCallback={callback} />, { wrapper: StrictMode });
      const scroll = jest.fn();
      screen.getByTestId('end').scrollIntoView = scroll;

      fireEvent.click(screen.getByText(label));
      expect(scroll).toHaveBeenLastCalledWith({ behavior });
      expect(callback).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByText(label));
      act(() => jest.advanceTimersByTime(interval - 1));
      expect(callback).toHaveBeenCalledTimes(1);
      act(() => jest.advanceTimersByTime(1));
      expect(callback).toHaveBeenCalledTimes(2);
      expect(scroll).toHaveBeenLastCalledWith({ behavior });
    },
  );

  it.each(scrollActions)('cancels queued $label work when the target ref changes', ({ label }) => {
    const callback = jest.fn();
    const previousRef = createRef<HTMLDivElement>();
    const nextRef = createRef<HTMLDivElement>();
    const { rerender } = render(
      <Harness callback={callback} smoothCallback={callback} targetRef={previousRef} />,
      { wrapper: StrictMode },
    );
    const scroll = jest.fn();
    screen.getByTestId('end').scrollIntoView = scroll;
    fireEvent.click(screen.getByText(label));
    fireEvent.click(screen.getByText(label));

    rerender(<Harness callback={callback} smoothCallback={callback} targetRef={nextRef} />);
    act(() => jest.advanceTimersByTime(1000));
    expect(callback).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText(label));
    expect(callback).toHaveBeenCalledTimes(2);
    expect(scroll).toHaveBeenCalledTimes(2);
  });
});
