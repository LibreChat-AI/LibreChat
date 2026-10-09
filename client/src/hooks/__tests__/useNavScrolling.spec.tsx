import { renderHook, act } from '@testing-library/react';
import useNavScrolling from '../Nav/useNavScrolling';

type Observed = { element: Element; callback: ResizeObserverCallback };

const observed: Observed[] = [];

class MockResizeObserver {
  constructor(private callback: ResizeObserverCallback) {}
  observe(element: Element) {
    observed.push({ element, callback: this.callback });
  }

  unobserve() {}
  disconnect() {}
}

/** Fakes the layout numbers jsdom always reports as 0 */
function sizeContainer(
  container: HTMLDivElement,
  { clientHeight, scrollHeight, scrollTop = 0 }: Record<string, number>,
) {
  Object.defineProperty(container, 'clientHeight', { value: clientHeight, configurable: true });
  Object.defineProperty(container, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(container, 'scrollTop', { value: scrollTop, configurable: true });
}

describe('useNavScrolling', () => {
  const originalResizeObserver = global.ResizeObserver;

  beforeEach(() => {
    jest.useFakeTimers();
    observed.length = 0;
    global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    jest.useRealTimers();
    global.ResizeObserver = originalResizeObserver;
  });

  const setup = (
    props: Partial<Parameters<typeof useNavScrolling>[0]> = {},
    layout: Record<string, number> = { clientHeight: 500, scrollHeight: 200 },
  ) => {
    const fetchNextPage = jest.fn().mockResolvedValue({});
    const container = document.createElement('div');
    document.body.appendChild(container);
    sizeContainer(container, layout);

    const rendered = renderHook((hookProps: Record<string, unknown>) => {
      const nav = useNavScrolling({
        nextCursor: 'cursor-1',
        isFetchingNext: false,
        fetchNextPage,
        ...props,
        ...hookProps,
      });
      /** Stands in for the ref React would attach before effects run */
      nav.containerRef.current = container;
      return nav;
    });
    return { ...rendered, fetchNextPage, container };
  };

  it('fills a list that is too short to scroll', () => {
    const { rerender, fetchNextPage } = setup();

    act(() => {
      rerender({ nextCursor: 'cursor-2' });
      jest.advanceTimersByTime(1000);
    });

    expect(fetchNextPage).toHaveBeenCalledTimes(2);
  });

  it('does not restart a fetch when loading finishes with the same cursor', () => {
    const { rerender, fetchNextPage } = setup();
    expect(fetchNextPage).toHaveBeenCalledTimes(1);

    act(() => {
      rerender({ isFetchingNext: true });
    });
    act(() => {
      rerender({ isFetchingNext: false });
      jest.advanceTimersByTime(1000);
    });

    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('does not fetch while the container has no layout yet', () => {
    const { rerender, fetchNextPage } = setup({}, { clientHeight: 0, scrollHeight: 0 });

    act(() => {
      rerender({ nextCursor: 'cursor-2' });
    });

    expect(fetchNextPage).not.toHaveBeenCalled();
  });

  it('retries once the container gets laid out', () => {
    const { rerender, fetchNextPage, container } = setup({}, { clientHeight: 0, scrollHeight: 0 });

    act(() => {
      rerender({ nextCursor: 'cursor-2' });
    });
    expect(fetchNextPage).not.toHaveBeenCalled();

    sizeContainer(container, { clientHeight: 500, scrollHeight: 200 });
    act(() => {
      jest.advanceTimersByTime(1000);
      observed.forEach(({ callback }) => callback([], {} as unknown as ResizeObserver));
      jest.advanceTimersByTime(1000);
    });

    expect(fetchNextPage).toHaveBeenCalled();
  });

  it('stays put when disabled', () => {
    const { rerender, fetchNextPage } = setup({ enabled: false });

    act(() => {
      rerender({ nextCursor: 'cursor-2', enabled: false });
    });

    expect(fetchNextPage).not.toHaveBeenCalled();
  });

  it('stops at the end of the list', () => {
    const { rerender, fetchNextPage } = setup({ nextCursor: null });

    act(() => {
      rerender({ nextCursor: null });
    });

    expect(fetchNextPage).not.toHaveBeenCalled();
  });
});
