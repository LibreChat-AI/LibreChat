const OPPOSITE: Record<string, string> = { left: 'right', right: 'left' };

/** Reads the writing direction the browser resolved for the element itself (a `dir` attribute,
 *  `dir="auto"`, or a CSS `direction` override), so an LTR island inside an RTL page (and the
 *  reverse) resolves correctly instead of following the document. Without a computed value (a
 *  non-rendering DOM such as jsdom) the nearest `dir` attribute decides. */
export function isRtl(element?: Element | null): boolean {
  if (!element || typeof window === 'undefined') {
    return false;
  }
  const computed = window.getComputedStyle(element).direction;
  if (computed === 'rtl' || computed === 'ltr') {
    return computed === 'rtl';
  }
  return element.closest('[dir]')?.getAttribute('dir') === 'rtl';
}

/** Maps a physical `left`/`right` side or placement (`right`, `left-start`) to the side that
 *  is visually equivalent under RTL; `top`/`bottom` and LTR anchors pass through unchanged.
 *  The `-start`/`-end` suffix is left alone: floating positioning already resolves it per direction. */
export function resolveSide<T extends string>(side: T, element?: Element | null): T {
  if (!isRtl(element)) {
    return side;
  }
  const [base, ...rest] = side.split('-');
  const opposite = OPPOSITE[base];
  return (opposite ? [opposite, ...rest].join('-') : side) as T;
}

/** Swaps ArrowLeft and ArrowRight for horizontal navigation when the element is RTL. */
export function resolveArrowKey(key: string, element?: Element | null): string {
  if (!isRtl(element)) {
    return key;
  }
  if (key === 'ArrowLeft') {
    return 'ArrowRight';
  }
  return key === 'ArrowRight' ? 'ArrowLeft' : key;
}
