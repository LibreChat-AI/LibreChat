import { useEffect, useMemo, useRef } from 'react';
import type { MouseEventHandler, RefObject } from 'react';

type TUseScrollToRef = {
  targetRef: RefObject<HTMLDivElement>;
  callback: () => void;
  smoothCallback: () => void;
};

/** A throttled call that runs on the leading edge and once more on the trailing edge. */
export type ThrottledFunction = (() => void) & {
  /** Drops the pending trailing call. */
  cancel: () => void;
};

type ScrollToRefReturn = {
  scrollToRef?: ThrottledFunction;
  handleSmoothToRef: MouseEventHandler<HTMLButtonElement>;
};

/** Runs `run` at once, then at most once per `wait` ms while calls keep arriving: a call
 *  inside the window is deferred to the window's end, and that run opens the next window. */
function throttle(run: () => void, wait: number): ThrottledFunction {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  const closeWindow = () => {
    if (!pending) {
      timer = null;
      return;
    }
    pending = false;
    run();
    timer = setTimeout(closeWindow, wait);
  };
  const throttled = () => {
    if (timer != null) {
      pending = true;
      return;
    }
    run();
    timer = setTimeout(closeWindow, wait);
  };
  throttled.cancel = () => {
    if (timer != null) {
      clearTimeout(timer);
    }
    timer = null;
    pending = false;
  };
  return throttled;
}

export default function useScrollToRef({
  targetRef,
  callback,
  smoothCallback,
}: TUseScrollToRef): ScrollToRefReturn {
  const callbacksRef = useRef({ callback, smoothCallback });
  useEffect(() => {
    callbacksRef.current = { callback, smoothCallback };
  }, [callback, smoothCallback]);

  const scrollToRef = useMemo(
    () =>
      throttle(() => {
        targetRef.current?.scrollIntoView({ behavior: 'instant' });
        callbacksRef.current.callback();
      }, 145),
    [targetRef],
  );

  const scrollToRefSmooth = useMemo(
    () =>
      throttle(() => {
        targetRef.current?.scrollIntoView({ behavior: 'smooth' });
        callbacksRef.current.smoothCallback();
      }, 750),
    [targetRef],
  );

  useEffect(
    () => () => {
      scrollToRef.cancel();
      scrollToRefSmooth.cancel();
    },
    [scrollToRef, scrollToRefSmooth],
  );

  const handleSmoothToRef: MouseEventHandler<HTMLButtonElement> = (e) => {
    e.preventDefault();
    scrollToRefSmooth();
  };

  return {
    scrollToRef,
    handleSmoothToRef,
  };
}
