import React from 'react';
import { RecoilRoot, type MutableSnapshot } from 'recoil';
import { render, screen, act } from '@testing-library/react';
import Elapsed, { shouldShowElapsed } from '~/components/Chat/Messages/Elapsed';
import store from '~/store';

function renderElapsed(initializeState?: (snapshot: MutableSnapshot) => void) {
  return render(
    <RecoilRoot initializeState={initializeState}>
      <Elapsed index={0} />
    </RecoilRoot>,
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
    renderElapsed(({ set }) => set(store.submissionStartFamily(0), start));

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
    renderElapsed(({ set }) => set(store.submissionStartFamily(0), start));

    expect(screen.getByTestId('stream-elapsed')).toHaveTextContent(/^0s$/);

    advance(61_000);
    expect(screen.getByTestId('stream-elapsed')).toHaveTextContent(/^1s$/);
  });

  it('continues from the anchored start across an unmount and remount', () => {
    const start = Date.now() - 30_000;
    const view = render(
      <RecoilRoot initializeState={({ set }) => set(store.submissionStartFamily(0), start)}>
        <Elapsed index={0} />
      </RecoilRoot>,
    );

    expect(screen.getByTestId('stream-elapsed')).toHaveTextContent(/^30s$/);

    view.rerender(
      <RecoilRoot initializeState={({ set }) => set(store.submissionStartFamily(0), start)}>
        {null}
      </RecoilRoot>,
    );
    expect(screen.queryByTestId('stream-elapsed')).toBeNull();

    advance(5_000);
    view.rerender(
      <RecoilRoot initializeState={({ set }) => set(store.submissionStartFamily(0), start)}>
        <Elapsed index={0} />
      </RecoilRoot>,
    );
    expect(screen.getByTestId('stream-elapsed')).toHaveTextContent(/^35s$/);
  });

  it('clears its interval on unmount', () => {
    const view = renderElapsed();
    const timersWhileMounted = jest.getTimerCount();
    expect(timersWhileMounted).toBeGreaterThanOrEqual(1);

    view.rerender(<RecoilRoot>{null}</RecoilRoot>);
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
