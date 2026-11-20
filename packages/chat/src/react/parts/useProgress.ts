import { useState, useEffect, useMemo, useCallback } from 'react';

export default function useProgress(
  initialProgress = 0.01,
  increment = 0.007,
  fileSize?: number,
): number {
  const calculateIncrement = useCallback(
    (size?: number) => {
      const baseRate = 0.05;
      const minRate = 0.002;
      const sizeMB = size ? size / (1024 * 1024) : 0;

      if (!size) {
        return increment;
      }

      if (sizeMB <= 1) {
        return baseRate * 2;
      } else {
        return Math.max(baseRate / Math.sqrt(sizeMB), minRate);
      }
    },
    [increment],
  );

  const incrementValue = useMemo(
    () => calculateIncrement(fileSize),
    [fileSize, calculateIncrement],
  );
  const [progress, setProgress] = useState(initialProgress);

  const getDynamicIncrement = useCallback(
    (currentProgress: number) => {
      if (!fileSize) {
        return incrementValue;
      }
      if (currentProgress < 0.7) {
        return incrementValue;
      } else {
        return Math.max(0.0005, incrementValue * (1 - currentProgress));
      }
    },
    [incrementValue, fileSize],
  );

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    let timer: ReturnType<typeof setInterval>;
    if (initialProgress >= 1 && progress >= 1) {
      return;
    } else if (initialProgress >= 1 && progress < 1) {
      setProgress(0.99);
      timeout = setTimeout(() => {
        setProgress(1);
      }, 200);
    } else {
      timer = setInterval(() => {
        setProgress((prevProgress) => {
          if (prevProgress >= 1) {
            clearInterval(timer);
            return 1;
          }
          const currentIncrement = getDynamicIncrement(prevProgress);
          return Math.min(prevProgress + currentIncrement, 0.95);
        });
      }, 200);
    }

    return () => {
      clearInterval(timer);
      clearTimeout(timeout);
    };
  }, [progress, initialProgress, incrementValue, fileSize, getDynamicIncrement]);

  return progress;
}
