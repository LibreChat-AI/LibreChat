import { useEffect } from 'react';
import { Provider } from 'jotai';
import * as RadixToast from '@radix-ui/react-toast';
import { render, act, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';
import { useToast } from '~/hooks';
import { Toast } from '../Toast';

const MESSAGE = 'The file is too large.';
const REPLACEMENT = 'The upload finished.';

function ShowOnMount({ duration }: { duration?: number }): null {
  const { showToast } = useToast(0);

  /** One toast per mount — re-running on a changed identity would reset the timers under test. */
  useEffect(() => {
    showToast({ message: MESSAGE, duration });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

function ShowTwice({ duration, gap }: { duration: number; gap: number }): null {
  const { showToast } = useToast(0);

  /** One pair per mount, for the same reason ShowOnMount runs once. */
  useEffect(() => {
    showToast({ message: MESSAGE, duration });
    const timer = window.setTimeout(() => showToast({ message: REPLACEMENT, duration }), gap);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

function renderToast(trigger: ReactElement): void {
  render(
    <Provider>
      <RadixToast.Provider>
        {trigger}
        <Toast />
        <RadixToast.Viewport />
      </RadixToast.Provider>
    </Provider>,
  );
}

function setup(duration?: number): void {
  renderToast(<ShowOnMount duration={duration} />);
}

/** Radix removes the root once it has closed, so an absent node and a node
 *  marked closed are the same observable outcome. */
function state(): string {
  return document.querySelector('.toast-root')?.getAttribute('data-state') ?? 'unmounted';
}

function message(): string {
  return document.querySelector('.toast-root')?.textContent ?? '';
}

function advance(ms: number): void {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

describe('Toast duration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('honors a duration shorter than the Radix default', () => {
    setup(3000);
    advance(0);
    expect(state()).toBe('open');

    advance(2900);
    expect(state()).toBe('open');

    advance(200);
    expect(state()).not.toBe('open');
  });

  test('honors a duration longer than the Radix default', () => {
    setup(10000);
    advance(0);
    expect(state()).toBe('open');

    advance(5500);
    expect(state()).toBe('open');
  });

  test('treats a duration of 0 as persistent', () => {
    setup(0);
    advance(0);
    expect(state()).toBe('open');

    advance(60000);
    expect(state()).toBe('open');
  });

  test('offers a dismissal only for a persistent toast', () => {
    setup(0);
    advance(0);

    const close = document.querySelector('[aria-label="com_ui_close"]');
    expect(close).not.toBeNull();

    act(() => {
      fireEvent.click(close as Element);
    });

    expect(state()).not.toBe('open');
  });

  test('leaves a self-dismissing toast without a close control', () => {
    setup(3000);
    advance(0);

    expect(document.querySelector('[aria-label="com_ui_close"]')).toBeNull();
  });

  test('restarts the deadline when a toast replaces one that is still open', () => {
    renderToast(<ShowTwice duration={3000} gap={2000} />);
    advance(0);
    expect(state()).toBe('open');

    advance(2001);
    expect(message()).toContain(REPLACEMENT);

    /** Past the first toast's deadline: the replacement keeps its own full duration. */
    advance(1200);
    expect(state()).toBe('open');

    advance(2000);
    expect(state()).not.toBe('open');
  });
});
