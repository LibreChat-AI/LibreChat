import { useState, useRef, useEffect } from 'react';
import type { ReactNode } from 'react';

const useDelayedRender = (delay: number) => {
  const [delayed, setDelayed] = useState(true);
  const timerPromiseRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (delayed) {
      const timerPromise = new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          setDelayed(false);
          resolve();
        }, delay);

        return () => {
          clearTimeout(timeout);
        };
      });

      timerPromiseRef.current = timerPromise;
    }

    return () => {
      timerPromiseRef.current = null;
    };
  }, [delay, delayed]);

  return (fn: () => ReactNode): ReactNode => {
    if (delayed && timerPromiseRef.current) {
      throw timerPromiseRef.current;
    }
    return fn();
  };
};

export default useDelayedRender;
