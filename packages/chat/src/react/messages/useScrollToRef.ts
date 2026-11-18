import { useEffect, useMemo, useRef } from 'react';
import type { MouseEventHandler, RefObject } from 'react';
import type { ThrottledFunction } from './throttle';
import { throttle } from './throttle';

type TUseScrollToRef = {
  targetRef: RefObject<HTMLDivElement>;
  callback: () => void;
  smoothCallback: () => void;
};

type ScrollToRefReturn = {
  scrollToRef?: ThrottledFunction;
  handleSmoothToRef: MouseEventHandler<HTMLButtonElement>;
};

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
