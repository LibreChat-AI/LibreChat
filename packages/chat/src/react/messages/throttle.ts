/** A throttled call that runs on the leading edge and once more on the trailing edge. */
export type ThrottledFunction = (() => void) & {
  /** Drops the pending trailing call. */
  cancel: () => void;
};

/** Runs `run` at once, then at most once per `wait` ms while calls keep arriving: a call
 *  inside the window is deferred to the window's end, and that run opens the next window. */
export function throttle(run: () => void, wait: number): ThrottledFunction {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  const closeWindow = (): void => {
    if (!pending) {
      timer = null;
      return;
    }
    pending = false;
    run();
    timer = setTimeout(closeWindow, wait);
  };
  const throttled = (): void => {
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
