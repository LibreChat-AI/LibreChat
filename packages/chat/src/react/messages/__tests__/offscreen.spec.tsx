/** @jest-environment jsdom */
import { useRef } from 'react';
import { render, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  reachRow,
  useRowReached,
  useOffscreenRow,
  useOffscreenRows,
  RowReachProvider,
  revealOffscreenRows,
  OffscreenRowsProvider,
  OFFSCREEN_ROW_ATTRIBUTE,
} from '../offscreen';

type Record = Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>;

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  observed = new Set<Element>();
  disconnected = false;
  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    MockIntersectionObserver.instances.push(this);
  }
  observe(element: Element) {
    this.observed.add(element);
  }
  unobserve(element: Element) {
    this.observed.delete(element);
  }
  disconnect() {
    this.disconnected = true;
    this.observed.clear();
  }
  report(records: Record[]) {
    this.callback(records as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }
}

const live = () => MockIntersectionObserver.instances.filter((observer) => !observer.disconnected);

function Toolbar({ id }: { id: string }) {
  return useRowReached() ? <button type="button" data-testid={`${id}-toolbar`} /> : null;
}

function Row({ id, far = false }: { id: string; far?: boolean }) {
  const { rowRef, reach } = useOffscreenRow(far);
  return (
    <div ref={rowRef} data-testid={id}>
      <RowReachProvider reach={reach}>
        <Toolbar id={id} />
      </RowReachProvider>
    </div>
  );
}

function Thread({ children }: { children: ReactNode }) {
  const scrollableRef = useRef<HTMLDivElement>(null);
  const observe = useOffscreenRows(scrollableRef);
  return (
    <div ref={scrollableRef} data-testid="scroller">
      <OffscreenRowsProvider observe={observe}>{children}</OffscreenRowsProvider>
    </div>
  );
}

const originalObserver = global.IntersectionObserver;

beforeEach(() => {
  MockIntersectionObserver.instances = [];
  global.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  global.IntersectionObserver = originalObserver;
});

describe('rows far from the viewport', () => {
  it('watches the rows that mounted before the thread did, and the ones that mount later', () => {
    const { getByTestId, rerender } = render(
      <Thread>
        <Row id="a" />
        <Row id="b" />
      </Thread>,
    );
    const [observer] = live();
    expect(observer.options?.root).toBe(getByTestId('scroller'));
    expect(observer.options?.rootMargin).toBe('100% 0px');
    expect(observer.observed).toEqual(new Set([getByTestId('a'), getByTestId('b')]));

    rerender(
      <Thread>
        <Row id="a" />
        <Row id="b" />
        <Row id="c" />
      </Thread>,
    );
    expect(live()).toHaveLength(1);
    expect(observer.observed.has(getByTestId('c'))).toBe(true);
  });

  it('marks a row that leaves the margin and clears the mark when it returns', () => {
    const { getByTestId } = render(
      <Thread>
        <Row id="a" />
        <Row id="b" />
      </Thread>,
    );
    const [observer] = live();
    const a = getByTestId('a');
    const b = getByTestId('b');

    act(() =>
      observer.report([
        { target: a, isIntersecting: false },
        { target: b, isIntersecting: true },
      ]),
    );
    expect(a.hasAttribute(OFFSCREEN_ROW_ATTRIBUTE)).toBe(true);
    expect(b.hasAttribute(OFFSCREEN_ROW_ATTRIBUTE)).toBe(false);

    act(() => observer.report([{ target: a, isIntersecting: true }]));
    expect(a.hasAttribute(OFFSCREEN_ROW_ATTRIBUTE)).toBe(false);
  });

  it('stops watching a row that unmounts', () => {
    const { getByTestId, rerender } = render(
      <Thread>
        <Row id="a" />
        <Row id="b" />
      </Thread>,
    );
    const [observer] = live();
    const b = getByTestId('b');
    act(() => observer.report([{ target: b, isIntersecting: false }]));

    rerender(
      <Thread>
        <Row id="a" />
      </Thread>,
    );
    expect(observer.observed.has(b)).toBe(false);
    expect(b.hasAttribute(OFFSCREEN_ROW_ATTRIBUTE)).toBe(false);
  });

  it('lays every row out for a consumer that clones the thread, then resumes', () => {
    const { getByTestId } = render(
      <Thread>
        <Row id="a" />
        <Row id="b" />
      </Thread>,
    );
    const [observer] = live();
    const a = getByTestId('a');
    act(() => observer.report([{ target: a, isIntersecting: false }]));

    const resume = revealOffscreenRows();
    expect(a.hasAttribute(OFFSCREEN_ROW_ATTRIBUTE)).toBe(false);
    expect(live()).toHaveLength(0);
    /** A late report from the observer that was just dropped must not skip a row mid-capture. */
    expect(observer.observed.size).toBe(0);

    resume();
    const [resumed] = live();
    expect(resumed).not.toBe(observer);
    expect(resumed.observed).toEqual(new Set([a, getByTestId('b')]));
  });

  it('keeps every row laid out until the last of several overlapping consumers is done', () => {
    const { getByTestId } = render(
      <Thread>
        <Row id="a" />
        <Row id="b" />
      </Thread>,
    );
    const a = getByTestId('a');
    act(() => live()[0].report([{ target: a, isIntersecting: false }]));

    /** A second export started before the first finished. */
    const resumeFirst = revealOffscreenRows();
    const resumeSecond = revealOffscreenRows();
    expect(live()).toHaveLength(0);

    resumeFirst();
    expect(live()).toHaveLength(0);
    expect(a.hasAttribute(OFFSCREEN_ROW_ATTRIBUTE)).toBe(false);

    /** One consumer finishing twice must not stand in for the other. */
    resumeFirst();
    expect(live()).toHaveLength(0);

    resumeSecond();
    expect(live()).toHaveLength(1);
    expect(live()[0].observed).toEqual(new Set([a, getByTestId('b')]));
  });

  it('watches nothing when a consumer finishes after the thread has unmounted', () => {
    const { unmount } = render(
      <Thread>
        <Row id="a" />
      </Thread>,
    );
    const resume = revealOffscreenRows();

    unmount();
    resume();

    expect(live()).toHaveLength(0);
  });

  it('leaves a row alone outside a thread that watches its rows', () => {
    const { getByTestId } = render(<Row id="lone" />);
    expect(MockIntersectionObserver.instances).toHaveLength(0);
    expect(getByTestId('lone').hasAttribute(OFFSCREEN_ROW_ATTRIBUTE)).toBe(false);
  });

  it('holds back what a far row keeps for a reader until the row comes near, then keeps it', () => {
    const { getByTestId, queryByTestId } = render(
      <Thread>
        <Row id="near" />
        <Row id="far" far />
      </Thread>,
    );
    const [observer] = live();
    const far = getByTestId('far');
    expect(queryByTestId('near-toolbar')).not.toBeNull();
    expect(queryByTestId('far-toolbar')).toBeNull();

    /** The observer's first report on a row away from the viewport changes nothing. */
    act(() => observer.report([{ target: far, isIntersecting: false }]));
    expect(queryByTestId('far-toolbar')).toBeNull();

    act(() => observer.report([{ target: far, isIntersecting: true }]));
    expect(queryByTestId('far-toolbar')).not.toBeNull();

    act(() => observer.report([{ target: far, isIntersecting: false }]));
    expect(queryByTestId('far-toolbar')).not.toBeNull();
  });

  it('mounts it at once for a caller about to use the row', () => {
    const { getByTestId, queryByTestId } = render(
      <Thread>
        <Row id="far" far />
      </Thread>,
    );
    expect(queryByTestId('far-toolbar')).toBeNull();

    /** No `act`: the button has to be in the document when the call returns. */
    const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    environment.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      reachRow(getByTestId('far'));
      expect(queryByTestId('far-toolbar')).not.toBeNull();

      reachRow(getByTestId('far'));
      reachRow(null);
      expect(queryByTestId('far-toolbar')).not.toBeNull();
    } finally {
      environment.IS_REACT_ACT_ENVIRONMENT = true;
    }
  });

  it('mounts it in every row for a consumer that clones the thread', () => {
    const { queryByTestId } = render(
      <Thread>
        <Row id="far" far />
        <Row id="farther" far />
      </Thread>,
    );
    expect(queryByTestId('far-toolbar')).toBeNull();

    const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    environment.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      /** In the document when the call returns: the clone is taken next. */
      const resume = revealOffscreenRows();
      expect(queryByTestId('far-toolbar')).not.toBeNull();
      expect(queryByTestId('farther-toolbar')).not.toBeNull();
      resume();
    } finally {
      environment.IS_REACT_ACT_ENVIRONMENT = true;
    }
    expect(queryByTestId('far-toolbar')).not.toBeNull();
  });

  it('holds nothing back where no thread watches the row or nothing can say it came near', () => {
    const lone = render(<Row id="lone" far />);
    expect(lone.queryByTestId('lone-toolbar')).not.toBeNull();
    lone.unmount();

    // @ts-expect-error a browser without the observer
    delete global.IntersectionObserver;
    const { queryByTestId } = render(
      <Thread>
        <Row id="far" far />
      </Thread>,
    );
    expect(queryByTestId('far-toolbar')).not.toBeNull();
  });

  it('drops its observer and every mark when the thread unmounts', () => {
    const { getByTestId, unmount } = render(
      <Thread>
        <Row id="a" />
      </Thread>,
    );
    const [observer] = live();
    const a = getByTestId('a');
    act(() => observer.report([{ target: a, isIntersecting: false }]));

    unmount();
    expect(observer.disconnected).toBe(true);
    expect(a.hasAttribute(OFFSCREEN_ROW_ATTRIBUTE)).toBe(false);
    expect(revealOffscreenRows()).toBeInstanceOf(Function);
    expect(live()).toHaveLength(0);
  });
});
