import { renderHook } from '@testing-library/react';
import useExpandCollapse, {
  EXPAND_TRANSITION,
  REDUCED_MOTION_EXPAND_TRANSITION,
} from '../useExpandCollapse';

function stubReducedMotion(reduce: boolean) {
  window.matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? reduce : false,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })) as unknown as typeof window.matchMedia;
}

describe('useExpandCollapse', () => {
  const original = window.matchMedia;

  afterEach(() => {
    window.matchMedia = original;
  });

  test('animates the disclosure by default', () => {
    stubReducedMotion(false);

    const { result } = renderHook(() => useExpandCollapse(true));

    expect(result.current.style.transition).toBe(EXPAND_TRANSITION);
    expect(result.current.style.gridTemplateRows).toBe('1fr');
    expect(result.current.style.opacity).toBe(1);
  });

  /** The transition is an inline style, so it cannot carry a media query.
   *  Without this the panel still folds over 300ms for a reader who asked
   *  the platform for no motion. */
  test('collapses the duration under prefers-reduced-motion', () => {
    stubReducedMotion(true);

    const { result } = renderHook(() => useExpandCollapse(true));

    expect(result.current.style.transition).toBe(REDUCED_MOTION_EXPAND_TRANSITION);
    expect(result.current.style.transition).not.toBe(EXPAND_TRANSITION);
  });

  /** `transition: none` would emit no `transitionend`, and ToolCallGroup
   *  waits on that event to unmount a collapsed body. Keeping a real (if
   *  imperceptible) transition preserves that completion signal. */
  test('keeps a transition that still emits transitionend', () => {
    stubReducedMotion(true);

    const { result } = renderHook(() => useExpandCollapse(false));

    expect(result.current.style.transition).not.toBe('none');
    expect(result.current.style.transition).toContain('grid-template-rows');
    expect(result.current.style.transition).toContain('opacity');
  });

  test('still collapses to a zero row under reduced motion', () => {
    stubReducedMotion(true);

    const { result } = renderHook(() => useExpandCollapse(false));

    expect(result.current.style.gridTemplateRows).toBe('0fr');
    expect(result.current.style.opacity).toBe(0);
  });
});
