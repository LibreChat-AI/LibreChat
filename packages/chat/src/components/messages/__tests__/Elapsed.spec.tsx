/**
 * @jest-environment jsdom
 */
import fs from 'node:fs';
import path from 'node:path';
import i18next from 'i18next';
import { Provider, createStore } from 'jotai';
import { initReactI18next } from 'react-i18next';
import { render, screen, act } from '@testing-library/react';
import { submissionStartFamily } from '../../../react/generation';
import Elapsed, { shouldShowElapsed } from '../Elapsed';

/** The app's English bundle, so the readings and their plural forms are the ones users see. */
const TRANSLATION = path.resolve(
  __dirname,
  '../../../../../../client/src/locales/en/translation.json',
);

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: JSON.parse(fs.readFileSync(TRANSLATION, 'utf8')) } },
    interpolation: { escapeValue: false },
  });
});

function storeWithStart(start?: number) {
  const jotaiStore = createStore();
  if (start != null) {
    jotaiStore.set(submissionStartFamily(0), start);
  }
  return jotaiStore;
}

function renderElapsed(start?: number) {
  return render(
    <Provider store={storeWithStart(start)}>
      <Elapsed index={0} />
    </Provider>,
  );
}

function advance(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

describe('Elapsed', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders seconds from the submission start anchor and rolls into minutes', () => {
    const start = Date.now() - 5_000;
    renderElapsed(start);

    expect(screen.getByTestId('stream-elapsed')).toHaveTextContent(/^5s$/);
    expect(screen.getByTestId('stream-elapsed')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('5 seconds elapsed')).toHaveClass('sr-only');
    /** The 6px inline-start inset that lines the reading up with the
     *  streaming dot and the hover-button glyphs that replace it. */
    expect(screen.getByTestId('stream-elapsed').parentElement).toHaveClass('ps-1.5');
    /** The same shimmer a running tool call's label carries: the timer only
     *  ever renders mid-generation, so it never animates a settled reading. */
    expect(screen.getByTestId('stream-elapsed')).toHaveClass('shimmer');

    advance(54_000);
    expect(screen.getByTestId('stream-elapsed')).toHaveTextContent(/^59s$/);

    advance(1_000);
    expect(screen.getByTestId('stream-elapsed')).toHaveTextContent(/^1m 0s$/);
    expect(screen.getByText('1 minute elapsed')).toHaveClass('sr-only');

    advance(59_000);
    expect(screen.getByTestId('stream-elapsed')).toHaveTextContent(/^1m 59s$/);

    advance(1_000);
    expect(screen.getByTestId('stream-elapsed')).toHaveTextContent(/^2m 0s$/);
  });

  it('counts from mount when no submission start is recorded', () => {
    renderElapsed();

    expect(screen.getByTestId('stream-elapsed')).toHaveTextContent(/^0s$/);

    advance(3_000);
    expect(screen.getByTestId('stream-elapsed')).toHaveTextContent(/^3s$/);
  });

  it('clamps a future anchor to zero instead of going negative', () => {
    const start = Date.now() + 60_000;
    renderElapsed(start);

    expect(screen.getByTestId('stream-elapsed')).toHaveTextContent(/^0s$/);

    advance(61_000);
    expect(screen.getByTestId('stream-elapsed')).toHaveTextContent(/^1s$/);
  });

  it('continues from the anchored start across an unmount and remount', () => {
    const start = Date.now() - 30_000;
    const jotaiStore = storeWithStart(start);
    const view = render(
      <Provider store={jotaiStore}>
        <Elapsed index={0} />
      </Provider>,
    );

    expect(screen.getByTestId('stream-elapsed')).toHaveTextContent(/^30s$/);

    view.rerender(<Provider store={jotaiStore}>{null}</Provider>);
    expect(screen.queryByTestId('stream-elapsed')).toBeNull();

    advance(5_000);
    view.rerender(
      <Provider store={jotaiStore}>
        <Elapsed index={0} />
      </Provider>,
    );
    expect(screen.getByTestId('stream-elapsed')).toHaveTextContent(/^35s$/);
  });

  it('clears its interval on unmount', () => {
    const view = renderElapsed();
    const timersWhileMounted = jest.getTimerCount();
    expect(timersWhileMounted).toBeGreaterThanOrEqual(1);

    view.unmount();
    expect(jest.getTimerCount()).toBe(timersWhileMounted - 1);
  });
});

describe('shouldShowElapsed', () => {
  const streamingRow = {
    isSubmitting: true,
    isLatestMessage: true,
    isCreatedByUser: false,
    siblingIdx: 1,
    siblingCount: 2,
  };

  it('shows under the newest sibling of the streaming latest assistant row', () => {
    expect(shouldShowElapsed(streamingRow)).toBe(true);
  });

  it('shows when sibling metadata is absent (a lone response)', () => {
    expect(
      shouldShowElapsed({ isSubmitting: true, isLatestMessage: true, isCreatedByUser: false }),
    ).toBe(true);
  });

  it('hides under an older sibling the reader paged to mid-stream', () => {
    expect(shouldShowElapsed({ ...streamingRow, siblingIdx: 0 })).toBe(false);
  });

  it('hides for user rows, settled rows, and non-latest rows', () => {
    expect(shouldShowElapsed({ ...streamingRow, isCreatedByUser: true })).toBe(false);
    expect(shouldShowElapsed({ ...streamingRow, isSubmitting: false })).toBe(false);
    expect(shouldShowElapsed({ ...streamingRow, isLatestMessage: false })).toBe(false);
  });
});
