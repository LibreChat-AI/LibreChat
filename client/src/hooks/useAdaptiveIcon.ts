import { useEffect, useState } from 'react';
import { isSvgIcon, detectMonochrome, isSameOriginOrDataIcon } from '~/utils';

const monochromeCache = new Map<string, boolean>();
const inFlight = new Map<string, Promise<boolean>>();
/** Bounds the cache so a session cycling many unique data-URI icons cannot grow it forever. */
const MAX_MONOCHROME_CACHE = 256;

function resolveMonochrome(src: string): Promise<boolean> {
  const cached = monochromeCache.get(src);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }
  const existing = inFlight.get(src);
  if (existing) {
    return existing;
  }
  const promise = detectMonochrome(src).then((monochrome) => {
    if (monochromeCache.size >= MAX_MONOCHROME_CACHE) {
      const oldest = monochromeCache.keys().next().value;
      if (oldest !== undefined) {
        monochromeCache.delete(oldest);
      }
    }
    monochromeCache.set(src, monochrome);
    inFlight.delete(src);
    return monochrome;
  });
  inFlight.set(src, promise);
  return promise;
}

/**
 * Whether a custom icon should be tinted to `currentColor`. An explicit
 * `monochrome` flag wins; otherwise same-origin and data-URI SVGs are sampled
 * once per source (see `detectMonochrome`) and the verdict cached.
 */
export default function useAdaptiveIcon(
  src?: string | null,
  monochrome?: boolean,
): { shouldTint: boolean } {
  const key =
    typeof monochrome !== 'boolean' && isSvgIcon(src) && isSameOriginOrDataIcon(src) ? src : null;
  const [state, setState] = useState<{ key: string | null; monochrome: boolean }>(() => ({
    key,
    monochrome: key != null && (monochromeCache.get(key) ?? false),
  }));

  useEffect(() => {
    if (key == null) {
      return;
    }
    let active = true;
    resolveMonochrome(key).then((resolved) => {
      if (active) {
        setState((prev) =>
          prev.key === key && prev.monochrome === resolved ? prev : { key, monochrome: resolved },
        );
      }
    });
    return () => {
      active = false;
    };
  }, [key]);

  if (typeof monochrome === 'boolean') {
    return { shouldTint: monochrome };
  }
  return { shouldTint: state.key === key && state.monochrome };
}
