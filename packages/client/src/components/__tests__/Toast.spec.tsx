import { useEffect } from 'react';
import { Provider } from 'jotai';
import * as RadixToast from '@radix-ui/react-toast';
import { render, act, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { TShowToast } from '~/common';
import { useToast } from '~/hooks';
import { Toast } from '../Toast';

const MESSAGE = 'The file is too large.';
const REPLACEMENT = 'The upload finished.';
const NOTICE = 'Still uploading report.pdf';
const NOTICE_STATUSES = ['warning', 'success', 'info'] as const;

const persistentError: TShowToast = { message: MESSAGE, status: 'error', duration: Infinity };

let show: (toast: TShowToast) => void = () => undefined;

/** Hands the hook's `showToast` to the test, so each request lands when the test says. */
function Trigger({ showDelay }: { showDelay?: number }): null {
  show = useToast(showDelay).showToast;
  return null;
}

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

function request(toast: TShowToast): void {
  act(() => {
    show(toast);
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

describe('Persistent error toast', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('once it is shown', () => {
    beforeEach(() => {
      renderToast(<Trigger showDelay={0} />);
      request(persistentError);
      advance(0);
    });

    test.each(NOTICE_STATUSES)('is not replaced by a later %s toast', (status) => {
      request({ message: NOTICE, status, duration: 10000 });
      advance(60000);

      expect(state()).toBe('open');
      expect(message()).toContain(MESSAGE);
    });

    test('is replaced by a later error', () => {
      request({ message: REPLACEMENT, status: 'error', duration: 3000 });
      advance(0);

      expect(message()).toContain(REPLACEMENT);
    });

    test('lets a later toast show once it is dismissed', () => {
      act(() => {
        fireEvent.click(document.querySelector('[aria-label="com_ui_close"]') as Element);
      });
      request({ message: NOTICE, status: 'warning', duration: 10000 });
      advance(0);

      expect(state()).toBe('open');
      expect(message()).toContain(NOTICE);
    });
  });

  describe('while it is still waiting to show', () => {
    beforeEach(() => {
      renderToast(<Trigger />);
      request(persistentError);
      advance(50);
    });

    test.each(NOTICE_STATUSES)('is not cancelled by a later %s toast', (status) => {
      request({ message: NOTICE, status, duration: 10000 });
      advance(60000);

      expect(state()).toBe('open');
      expect(message()).toContain(MESSAGE);
    });

    test('is replaced by a later error', () => {
      request({ message: REPLACEMENT, status: 'error', duration: Infinity });
      advance(1000);

      expect(message()).toContain(REPLACEMENT);
    });
  });

  test('is held when it asks for no timeout with a duration of 0', () => {
    renderToast(<Trigger showDelay={0} />);
    request({ message: MESSAGE, status: 'error', duration: 0 });
    advance(0);
    request({ message: NOTICE, status: 'warning', duration: 10000 });
    advance(60000);

    expect(message()).toContain(MESSAGE);
  });

  test('does not hold an error that closes itself', () => {
    renderToast(<Trigger showDelay={0} />);
    request({ message: MESSAGE, status: 'error', duration: 5000 });
    advance(0);
    request({ message: NOTICE, status: 'warning', duration: 10000 });
    advance(0);

    expect(message()).toContain(NOTICE);
  });

  test('does not hold a persistent toast that is not an error', () => {
    renderToast(<Trigger showDelay={0} />);
    request({ message: MESSAGE, status: 'warning', duration: Infinity });
    advance(0);
    request({ message: NOTICE, status: 'info', duration: 10000 });
    advance(0);

    expect(message()).toContain(NOTICE);
  });
});
