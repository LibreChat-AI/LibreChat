import React from 'react';
import { render, fireEvent, createEvent } from '@testing-library/react';
import Spinner from '../Spinner';

type FakeAnimation = { startTime: number | null; animationName: string };

const ROTATE = 'librechat-spinner-rotate';

const rotation = (startTime: number | null): FakeAnimation => ({
  startTime,
  animationName: ROTATE,
});

const mockGetAnimations = (impl: () => FakeAnimation[]) => {
  const getAnimations = jest.fn(impl);
  Object.defineProperty(SVGElement.prototype, 'getAnimations', {
    configurable: true,
    value: getAnimations,
  });
  return getAnimations;
};

const flushMicrotasks = () => Promise.resolve();

/** jsdom has no AnimationEvent, so its events carry no `animationName`. */
const startAnimation = (element: Element, animationName: string) => {
  const event = createEvent.animationStart(element);
  Object.defineProperty(event, 'animationName', { value: animationName });
  fireEvent(element, event);
};

describe('Spinner', () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    delete (SVGElement.prototype as Partial<SVGElement>).getAnimations;
    window.matchMedia = originalMatchMedia;
  });

  it('pins its rotation to the document timeline origin so spinners share one phase', async () => {
    const animation = rotation(1234);
    mockGetAnimations(() => [animation]);

    render(<Spinner />);
    await flushMicrotasks();

    expect(animation.startTime).toBe(0);
  });

  it('pins every rotation on the svg', async () => {
    const animations = [rotation(10), rotation(20)];
    mockGetAnimations(() => animations);

    render(<Spinner />);
    await flushMicrotasks();

    expect(animations.map((a) => a.startTime)).toEqual([0, 0]);
  });

  it('leaves animations the caller added through className alone', async () => {
    const own = rotation(5);
    const callerFade: FakeAnimation = { startTime: 7, animationName: 'caller-fade' };
    mockGetAnimations(() => [own, callerFade]);

    render(<Spinner className="animate-caller-fade" />);
    await flushMicrotasks();

    expect(callerFade.startTime).toBe(7);
  });

  it('pins the rotation that starts when reduced motion is switched off', async () => {
    let listener: (() => void) | undefined;
    window.matchMedia = jest.fn().mockImplementation(() => ({
      matches: true,
      addEventListener: (_type: string, cb: () => void) => {
        listener = cb;
      },
      removeEventListener: jest.fn(),
    }));
    let current: FakeAnimation[] = [];
    mockGetAnimations(() => current);

    render(<Spinner />);
    await flushMicrotasks();

    const started = rotation(99);
    current = [started];
    listener?.();
    await flushMicrotasks();

    expect(started.startTime).toBe(0);
  });

  it('stops listening for the reduced motion preference on unmount', () => {
    const removeEventListener = jest.fn();
    window.matchMedia = jest.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: jest.fn(),
      removeEventListener,
    }));

    render(<Spinner />).unmount();

    expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('renders and cleans up on engines whose MediaQueryList only has addListener', () => {
    const addListener = jest.fn();
    const removeListener = jest.fn();
    window.matchMedia = jest.fn().mockImplementation(() => ({
      matches: false,
      addListener,
      removeListener,
    }));

    const view = render(<Spinner />);
    expect(view.container.querySelector('svg')).not.toBeNull();
    expect(addListener).toHaveBeenCalledWith(expect.any(Function));

    view.unmount();
    expect(removeListener).toHaveBeenCalledWith(expect.any(Function));
  });

  it('pins the rotation that starts when a legacy engine reports the preference change', async () => {
    let listener: (() => void) | undefined;
    window.matchMedia = jest.fn().mockImplementation(() => ({
      matches: true,
      addListener: (cb: () => void) => {
        listener = cb;
      },
      removeListener: jest.fn(),
    }));
    let current: FakeAnimation[] = [];
    mockGetAnimations(() => current);

    render(<Spinner />);
    await flushMicrotasks();

    const started = rotation(99);
    current = [started];
    listener?.();
    await flushMicrotasks();

    expect(started.startTime).toBe(0);
  });

  it('pins a rotation the browser recreates after the spinner was hidden and shown', async () => {
    let current: FakeAnimation[] = [rotation(1)];
    mockGetAnimations(() => current);

    const { container } = render(<Spinner />);
    await flushMicrotasks();

    const recreated = rotation(42);
    current = [recreated];
    startAnimation(container.querySelector('svg') as SVGElement, ROTATE);
    await flushMicrotasks();

    expect(recreated.startTime).toBe(0);
  });

  it('ignores animationstart events from animations the caller added', async () => {
    const callerFade: FakeAnimation = { startTime: 7, animationName: 'caller-fade' };
    mockGetAnimations(() => [callerFade]);

    const { container } = render(<Spinner />);
    await flushMicrotasks();
    const getAnimations = SVGElement.prototype.getAnimations as jest.Mock;
    getAnimations.mockClear();

    startAnimation(container.querySelector('svg') as SVGElement, 'caller-fade');
    await flushMicrotasks();

    expect(getAnimations).not.toHaveBeenCalled();
  });

  it('pins on engines without queueMicrotask', async () => {
    const original = globalThis.queueMicrotask;
    Object.defineProperty(globalThis, 'queueMicrotask', { configurable: true, value: undefined });
    try {
      const animation = rotation(1234);
      mockGetAnimations(() => [animation]);

      render(<Spinner />);
      await flushMicrotasks();

      expect(animation.startTime).toBe(0);
    } finally {
      Object.defineProperty(globalThis, 'queueMicrotask', { configurable: true, value: original });
    }
  });

  it('reads every animation before writing any start time when spinners mount together', async () => {
    const animations = [rotation(1), rotation(2), rotation(3)];
    const writesSeenAtRead: number[] = [];
    let next = 0;
    mockGetAnimations(() => {
      writesSeenAtRead.push(animations.filter((a) => a.startTime === 0).length);
      return [animations[next++]];
    });

    render(
      <>
        <Spinner />
        <Spinner />
        <Spinner />
      </>,
    );
    await flushMicrotasks();

    expect(writesSeenAtRead).toEqual([0, 0, 0]);
    expect(animations.map((a) => a.startTime)).toEqual([0, 0, 0]);
  });

  it('does not touch the animations of a spinner that unmounted before the batch ran', async () => {
    const animation = rotation(99);
    const getAnimations = mockGetAnimations(() => [animation]);

    render(<Spinner />).unmount();
    await flushMicrotasks();

    expect(getAnimations).not.toHaveBeenCalled();
    expect(animation.startTime).toBe(99);
  });

  it('renders when the browser has no Web Animations API', async () => {
    const { container } = render(<Spinner />);
    await flushMicrotasks();

    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('follows the surrounding ink by default and pins a text role on request', () => {
    const { container, rerender } = render(<Spinner />);
    const svg = () => container.querySelector('svg');

    expect(svg()).not.toHaveClass('text-text-primary');
    expect(svg()).not.toHaveClass('text-text-secondary');

    rerender(<Spinner tone="primary" />);
    expect(svg()).toHaveClass('text-text-primary');

    rerender(<Spinner tone="secondary" />);
    expect(svg()).toHaveClass('text-text-secondary');
  });
});
