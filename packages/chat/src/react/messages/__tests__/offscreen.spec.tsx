/** @jest-environment jsdom */
import { useRef } from 'react';
import { render, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  useOffscreenRow,
  useOffscreenRows,
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

function Row({ id }: { id: string }) {
  const rowRef = useOffscreenRow();
  return <div ref={rowRef} data-testid={id} />;
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

  it('leaves a row alone outside a thread that watches its rows', () => {
    const { getByTestId } = render(<Row id="lone" />);
    expect(MockIntersectionObserver.instances).toHaveLength(0);
    expect(getByTestId('lone').hasAttribute(OFFSCREEN_ROW_ATTRIBUTE)).toBe(false);
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
