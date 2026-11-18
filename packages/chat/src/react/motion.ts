import { useState, useEffect } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Whether the person using this has asked for less movement.
 *
 * Stylesheets can answer that themselves, so this is for the motion they cannot
 * reach: transitions written as inline styles, and animations played from
 * script. It follows the setting rather than reading it once, since it can be
 * changed while the page is open.
 */
export default function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(QUERY).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(QUERY);
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return reduced;
}
