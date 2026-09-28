import { useEffect, useRef, useState } from 'react';

/**
 * Leading + trailing throttle for a rendered value: the first change paints at
 * once, later ones at most once per `intervalMs`, and the last value always
 * lands. A debounce would hold the display still for as long as changes keep
 * arriving, which is exactly when a streamed status line is worth reading.
 */
export default function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState(value);
  const latestRef = useRef(value);
  const paintedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  latestRef.current = value;

  useEffect(() => {
    const elapsed = Date.now() - paintedAtRef.current;
    if (elapsed >= intervalMs) {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      paintedAtRef.current = Date.now();
      setThrottled(value);
      return;
    }
    if (timerRef.current != null) {
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      paintedAtRef.current = Date.now();
      setThrottled(latestRef.current);
    }, intervalMs - elapsed);
  }, [value, intervalMs]);

  useEffect(
    () => () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    },
    [],
  );

  return throttled;
}
