import { useEffect, useState } from 'react';

/** Recheck absolute deadlines in bounded browser timer chunks. */
export default function useDeadline(expiresAt?: number): boolean {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const current = Date.now();
      setNow(current);
      if (expiresAt != null && expiresAt > current)
        timer = setTimeout(check, Math.min(expiresAt - current, 2147483647));
    };
    check();
    return () => clearTimeout(timer);
  }, [expiresAt]);
  return expiresAt != null && expiresAt <= now;
}
