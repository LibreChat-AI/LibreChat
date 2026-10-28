import { useEffect, useMemo, useRef } from 'react';
import throttle from 'lodash/throttle';
import type { RefObject } from 'react';

type TUseScrollToRef = {
  targetRef: RefObject<HTMLDivElement>;
  callback: () => void;
  smoothCallback: () => void;
};

type ThrottledFunction = (() => void) & {
  cancel: () => void;
  flush: () => void;
};

type ScrollToRefReturn = {
  scrollToRef?: ThrottledFunction;
  handleSmoothToRef: React.MouseEventHandler<HTMLButtonElement>;
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
      throttle(
        () => {
          targetRef.current?.scrollIntoView({ behavior: 'instant' });
          callbacksRef.current.callback();
        },
        145,
        { leading: true },
      ),
    [targetRef],
  );

  const scrollToRefSmooth = useMemo(
    () =>
      throttle(
        () => {
          targetRef.current?.scrollIntoView({ behavior: 'smooth' });
          callbacksRef.current.smoothCallback();
        },
        750,
        { leading: true },
      ),
    [targetRef],
  );

  useEffect(
    () => () => {
      scrollToRef.cancel();
      scrollToRefSmooth.cancel();
    },
    [scrollToRef, scrollToRefSmooth],
  );

  const handleSmoothToRef: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    e.preventDefault();
    scrollToRefSmooth();
  };

  return {
    scrollToRef,
    handleSmoothToRef,
  };
}
