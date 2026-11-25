/** A theme role's stored value: a bare `R G B` channel triplet, optionally with `/ alpha`. */
const TRIPLET = /^[\d.]+(?:\s+[\d.]+){2}(?:\s*\/\s*[\d.]+%?)?$/;

/**
 * Reads a theme color property as a CSS color, for code that paints outside the stylesheet (a
 * canvas, a favicon, a screenshot backdrop). Roles hold channel triplets, which only `rgb()`
 * turns into a color, so a triplet is wrapped; any other value is returned as set. Returns null
 * when the property is unset or still an unresolved `var()`, so a caller never paints a color the
 * active theme did not choose.
 */
export function readThemeColor(
  property: string,
  element: Element = document.documentElement,
): string | null {
  const value = getComputedStyle(element).getPropertyValue(property).trim();
  if (!value || value.startsWith('var(')) {
    return null;
  }
  return TRIPLET.test(value) ? `rgb(${value})` : value;
}
