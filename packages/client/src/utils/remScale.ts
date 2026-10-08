const BASE_FONT_SIZE = 16;

let cache: number | null = null;

/**
 * Ratio between a rendered rem and the 16px baseline that pixel layout constants
 * assume. Measured from the DOM rather than the stored preference, so it stays
 * correct for readers whose browser default is not 16px.
 *
 * Kept in its own module so consumers can import it by path: the `~/utils` barrel
 * is partially mocked in several suites, which would otherwise leave this
 * undefined at the point a hook reads it.
 */
export const getRemScale = (): number => {
  if (cache != null) {
    return cache;
  }
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    return 1;
  }
  const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
  cache = Number.isFinite(rootFontSize) && rootFontSize > 0 ? rootFontSize / BASE_FONT_SIZE : 1;
  return cache;
};

export const invalidateRemScale = (): void => {
  cache = null;
};
