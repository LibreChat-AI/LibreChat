import { useEffect, useRef, useCallback } from 'react';

type TUseTimeoutParams = {
  callback: (error: string | number | boolean | null) => void;
  delay?: number;
};
type TTimeout = ReturnType<typeof setTimeout> | null;

function useTimeout({ callback, delay = 400 }: TUseTimeoutParams) {
  const timeout = useRef<TTimeout>(null);

  const callOnTimeout = useCallback(
    (value?: string) => {
      // Clear existing timeout
      if (timeout.current !== null) {
        clearTimeout(timeout.current);
      }

      // Set new timeout
      if (value != null && value) {
        console.log(value);
        timeout.current = setTimeout(() => {
          callback(value);
        }, delay);
      }
    },
    [callback, delay],
  );

  // Clear timeout when the component unmounts
  useEffect(() => {
    return () => {
      if (timeout.current !== null) {
        clearTimeout(timeout.current);
      }
    };
  }, []);

  return callOnTimeout;
}

export default useTimeout;
