import { act, render, cleanup, waitFor, fireEvent } from '@testing-library/react';
import PixelCard from './PixelCard';

const frameCallbacks = new Map<number, FrameRequestCallback>();
const observers: WatchingIntersectionObserver[] = [];
const originalMatchMedia = window.matchMedia;
const originalObserver = window.IntersectionObserver;
let frameId = 0;
let now = 0;
let hidden = false;
const context: Pick<CanvasRenderingContext2D, 'clearRect' | 'fillRect' | 'fillStyle'> = {
  clearRect: jest.fn(),
  fillRect: jest.fn(),
  fillStyle: '',
};

class WatchingIntersectionObserver implements IntersectionObserver {
  root = null;
  rootMargin = '';
  thresholds = [0];
  target?: Element;
  disconnect = jest.fn();
  unobserve = jest.fn();
  takeRecords = () => [];

  constructor(private callback: IntersectionObserverCallback) {
    observers.push(this);
  }
  observe(target: Element) {
    this.target = target;
  }
  visible(isIntersecting: boolean) {
    if (!this.target) throw new Error('Expected an observed card');
    const bounds = this.target.getBoundingClientRect();
    this.callback(
      [
        {
          target: this.target,
          isIntersecting,
          intersectionRatio: isIntersecting ? 1 : 0,
          time: now,
          boundingClientRect: bounds,
          intersectionRect: bounds,
          rootBounds: bounds,
        },
      ],
      this,
    );
  }
}

function motion(matches: boolean) {
  const query = Object.assign(new EventTarget(), {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
  });
  window.matchMedia = jest.fn(() => query);
  return (next: boolean) => {
    query.matches = next;
    act(() => query.dispatchEvent(new Event('change')));
  };
}

function tick() {
  now += 20;
  const scheduled = [...frameCallbacks];
  frameCallbacks.clear();
  act(() => scheduled.forEach(([, callback]) => callback(now)));
}

/** The canvas draws with whatever the palette resolved to, so the test reads what the card
 *  asked the page for: which theme variables, and whether it asks again after a theme change. */
describe('PixelCard palette', () => {
  let fillStyles: string[];
  let channels: Record<string, string>;

  beforeEach(() => {
    fillStyles = [];
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
      return {
        clearRect: jest.fn(),
        fillRect: jest.fn(),
        set fillStyle(value: string) {
          fillStyles.push(value);
        },
      } as unknown as CanvasRenderingContext2D;
    });
    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 10,
      height: 10,
    } as DOMRect);
    channels = {
      '--surface-primary-alt': '1 2 3',
      '--surface-tertiary': '1 2 3',
      '--border-medium': '1 2 3',
    };
    const computed = window.getComputedStyle.bind(window);
    jest.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      const style = computed(element);
      return {
        ...style,
        getPropertyValue: (name: string) =>
          name.startsWith('--') ? (channels[name] ?? '') : style.getPropertyValue(name),
      } as CSSStyleDeclaration;
    });
  });

  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
    document.documentElement.className = '';
  });

  it('draws the default variant from theme variables', async () => {
    render(<PixelCard progress={1} />);

    await waitFor(() => expect(fillStyles).toContain('rgb(1 2 3)'));
    expect(fillStyles.every((style) => style === 'rgb(1 2 3)')).toBe(true);
  });

  it('draws each default slot from its own theme variable, and currentColor when one is unset', async () => {
    channels = { '--surface-primary-alt': '1 1 1', '--surface-tertiary': '2 2 2' };
    jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ width: 200, height: 200 } as DOMRect);
    let sample = 0;
    jest.spyOn(Math, 'random').mockImplementation(() => ((sample++ % 7) + 0.5) / 7);
    render(<PixelCard progress={1} />);

    await waitFor(() =>
      expect(new Set(fillStyles)).toEqual(new Set(['rgb(1 1 1)', 'rgb(2 2 2)', 'currentColor'])),
    );
  });

  it('keeps an explicit colors prop as given', async () => {
    render(<PixelCard progress={1} colors="#123456" />);

    await waitFor(() => expect(fillStyles).toContain('#123456'));
    expect(fillStyles.every((style) => style === '#123456')).toBe(true);
  });

  it('re-reads the palette when the theme changes', async () => {
    render(<PixelCard progress={1} />);
    await waitFor(() => expect(fillStyles).toContain('rgb(1 2 3)'));

    fillStyles = [];
    channels = {
      '--surface-primary-alt': '9 9 9',
      '--surface-tertiary': '9 9 9',
      '--border-medium': '9 9 9',
    };
    document.documentElement.classList.add('dark');

    await waitFor(() => expect(fillStyles).toContain('rgb(9 9 9)'));
  });

  it('keeps its pixels when an unrelated root variable changes', async () => {
    render(<PixelCard progress={1} />);
    await waitFor(() => expect(fillStyles).toContain('rgb(1 2 3)'));
    const measure = HTMLElement.prototype.getBoundingClientRect as jest.Mock;
    const layouts = measure.mock.calls.length;

    document.documentElement.style.setProperty('--message-scrollbar-gutter', '8px');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(measure.mock.calls.length).toBe(layouts);
    document.documentElement.style.removeProperty('--message-scrollbar-gutter');
  });
});

describe('PixelCard animation lifecycle', () => {
  beforeEach(() => {
    frameCallbacks.clear();
    observers.length = 0;
    frameId = 0;
    now = 0;
    hidden = false;
    jest.mocked(context.clearRect).mockClear();
    jest.mocked(context.fillRect).mockClear();
    window.IntersectionObserver = WatchingIntersectionObserver;
    motion(false);
    jest.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(context as CanvasRenderingContext2D);
    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 20,
      height: 20,
      top: 0,
      left: 0,
      right: 20,
      bottom: 20,
      toJSON: () => ({}),
    });
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameCallbacks.set(++frameId, callback);
      return frameId;
    });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frameCallbacks.delete(id);
    });
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    window.IntersectionObserver = originalObserver;
    jest.restoreAllMocks();
  });

  it('renders a stable decorative frame without animation when reduced motion is enabled', () => {
    motion(true);
    const view = render(<PixelCard noFocus progress={0.1} width="20px" height="20px" />);
    expect(context.fillRect).toHaveBeenCalled();
    expect(frameCallbacks.size).toBe(0);
    const pixels = [
      ...new Set(jest.mocked(context.fillRect).mock.calls.map((call) => JSON.stringify(call))),
    ];
    jest.mocked(context.fillRect).mockClear();
    view.rerender(<PixelCard noFocus progress={0.8} width="20px" height="20px" />);
    expect([
      ...new Set(jest.mocked(context.fillRect).mock.calls.map((call) => JSON.stringify(call))),
    ]).toEqual(pixels);
    expect(frameCallbacks.size).toBe(0);
    view.unmount();
  });

  it('responds to reduced motion changes and releases every scheduled frame on unmount', () => {
    const changeMotion = motion(false);
    const view = render(<PixelCard progress={0.5} />);
    const originalObserver = observers[observers.length - 1]!;
    expect(frameCallbacks.size).toBe(1);
    changeMotion(true);
    act(() => originalObserver.visible(true));
    expect(frameCallbacks.size).toBe(0);
    expect(context.fillRect).toHaveBeenCalled();
    changeMotion(false);
    act(() => originalObserver.visible(false));
    expect(frameCallbacks.size).toBe(1);
    view.unmount();
    expect(frameCallbacks.size).toBe(0);
    expect(observers.every((observer) => observer.disconnect.mock.calls.length > 0)).toBe(true);
    act(() => observers.forEach((observer) => observer.visible(true)));
    tick();
    expect(frameCallbacks.size).toBe(0);
  });

  it('pauses hidden cards and resumes with the latest progress when visible again', () => {
    const view = render(<PixelCard progress={0.2} />);
    const observer = observers[observers.length - 1]!;
    act(() => observer.visible(false));
    expect(frameCallbacks.size).toBe(0);
    view.rerender(<PixelCard progress={0.8} />);
    expect(frameCallbacks.size).toBe(0);
    act(() => observer.visible(true));
    expect(frameCallbacks.size).toBe(1);
    tick();
    tick();
    expect(context.fillRect).toHaveBeenCalled();
    view.unmount();
  });

  it('pauses background tabs and resumes without retaining listeners after unmount', () => {
    const view = render(<PixelCard progress={0.4} />);
    hidden = true;
    fireEvent(document, new Event('visibilitychange'));
    expect(frameCallbacks.size).toBe(0);
    hidden = false;
    fireEvent(document, new Event('visibilitychange'));
    expect(frameCallbacks.size).toBe(1);
    view.unmount();
    fireEvent(document, new Event('visibilitychange'));
    expect(frameCallbacks.size).toBe(0);
  });

  it('preserves hover behavior for cards without progress and avoids decorative tab stops', () => {
    const view = render(<PixelCard noFocus />);
    expect(frameCallbacks.size).toBe(0);
    const card = view.container.querySelector('[tabindex]')!;
    expect(card).toHaveAttribute('tabindex', '-1');
    fireEvent.mouseEnter(card);
    expect(frameCallbacks.size).toBe(1);
    fireEvent.mouseLeave(card);
    tick();
    expect(frameCallbacks.size).toBe(0);
    view.unmount();
  });
});
