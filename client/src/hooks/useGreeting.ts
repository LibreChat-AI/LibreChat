import { useState, useEffect } from 'react';
import type { TranslationKeys } from './useLocalize';
import { getGreetingKey, getMsUntilNextGreeting } from '~/utils/greeting';
import useLocalize from './useLocalize';

/**
 * Returns the localized, schedule-based greeting for the user's local time. The key is
 * resolved only after mount so server-rendered markup matches the first client render.
 * A single timer is armed for the next slot boundary, and the key is recalculated when
 * the tab becomes visible again in case the clock or timezone moved while it was hidden.
 */
export default function useGreeting(name?: string, fallback = ''): string {
  const localize = useLocalize();
  const [greetingKey, setGreetingKey] = useState<TranslationKeys | null>(null);

  const hasName = Boolean(name);

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>;

    const update = () => {
      clearTimeout(timeoutId);
      const now = new Date();
      setGreetingKey(getGreetingKey(now, hasName));
      timeoutId = setTimeout(update, Math.max(getMsUntilNextGreeting(now), 1000));
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        update();
      }
    };

    update();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', update);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', update);
    };
  }, [hasName]);

  if (greetingKey == null) {
    return fallback;
  }

  return localize(greetingKey, { name });
}
