import { renderHook, act } from '@testing-library/react';
import useMediaQuery from '../useMediaQuery';

type Listener = () => void;

/** The shared setup installs a writable (not configurable) `matchMedia`, so
 *  these stubs assign over it rather than redefining the property. */
function stubMatchMedia(matches: boolean) {
  const listeners = new Set<Listener>();
  const media = {
    matches,
    addEventListener: (_event: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_event: string, listener: Listener) => listeners.delete(listener),
  };
  window.matchMedia = jest.fn(() => media) as unknown as typeof window.matchMedia;
  return (next: boolean) => {
    media.matches = next;
    for (const listener of listeners) {
      listener();
    }
  };
}

describe('useMediaQuery', () => {
  const original = window.matchMedia;

  afterEach(() => {
    window.matchMedia = original;
  });

  /** Callers that branch once at mount — freezing an entrance animation,
   *  choosing a layout before paint — only ever see the first render. */
  test('reports a match on the first render, before any effect runs', () => {
    stubMatchMedia(true);

    const { result } = renderHook(() => useMediaQuery('(prefers-reduced-motion: reduce)'));

    expect(result.current).toBe(true);
  });

  test('reports no match on the first render when the query does not match', () => {
    stubMatchMedia(false);

    const { result } = renderHook(() => useMediaQuery('(prefers-reduced-motion: reduce)'));

    expect(result.current).toBe(false);
  });

  test('tracks later changes to the query', () => {
    const change = stubMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery('(min-width: 768px)'));
    expect(result.current).toBe(false);

    act(() => change(true));

    expect(result.current).toBe(true);
  });

  test('falls back to no match where matchMedia is unavailable', () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;

    const { result } = renderHook(() => useMediaQuery('(min-width: 768px)'));

    expect(result.current).toBe(false);
  });
});
