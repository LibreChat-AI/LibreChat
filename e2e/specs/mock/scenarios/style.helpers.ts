import type { Locator, Page } from '@playwright/test';

/**
 * Style probes for the scenarios that assert what the app paints. Both sides of
 * every comparison are resolved by the browser out of the stylesheet the app
 * shipped, never written down here: the same assertion then holds in light mode,
 * dark mode, under a custom theme, and across a Tailwind major.
 */

/**
 * Paint a throwaway element with `classes` and read `property` off it. This is
 * how an expected value is obtained without restating it: the utility resolves
 * through the same CSS the app loaded. `tag` matters where the rule under test
 * is a preflight default on one element kind — `button` for the cursor shim.
 */
export function probeStyle(
  page: Page,
  classes: string,
  property: string,
  tag = 'div',
): Promise<string> {
  return page.evaluate(
    ([className, name, element]) => {
      const probe = document.createElement(element);
      probe.className = className;
      document.body.append(probe);
      const value = getComputedStyle(probe).getPropertyValue(name);
      probe.remove();
      return value.trim();
    },
    [classes, property, tag] as [string, string, string],
  );
}

/** A theme custom property as the browser resolves it on the document root. */
export function themeValue(page: Page, property: string): Promise<string> {
  return page.evaluate(
    (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
    property,
  );
}

/**
 * The placeholder colour a plain field inherits from the app's stylesheet, read
 * off a throwaway input so no field's own `placeholder:` utility is in the way.
 */
export function probePlaceholderColor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement('input');
    probe.placeholder = 'probe';
    document.body.append(probe);
    const color = getComputedStyle(probe, '::placeholder').color;
    probe.remove();
    return color;
  });
}

/**
 * Normalise a colour expression — `rgb(227 227 227 / 1)`, `color-mix(...)`, a
 * token triplet — to the form `getComputedStyle` returns, by letting the browser
 * compute it. Comparing two normalised values compares colours, not spellings.
 */
export function normalizeColor(page: Page, value: string): Promise<string> {
  return page.evaluate((color) => {
    const probe = document.createElement('span');
    probe.style.color = color;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, value);
}

/**
 * Read several computed properties off a rendered element in one round trip.
 * Names are written the way the callers read them back (`touchAction`);
 * `getPropertyValue` only answers to the CSS spelling, so the hyphenation
 * happens here rather than at each call site — and a name it does not know
 * comes back empty, which fails the assertion instead of passing it.
 */
export function computedStyles<K extends string>(
  locator: Locator,
  properties: readonly K[],
): Promise<Record<K, string>> {
  return locator.evaluate((node, names: readonly string[]) => {
    const style = getComputedStyle(node as HTMLElement);
    const result: Record<string, string> = {};
    for (const name of names) {
      const property = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      result[name] = style.getPropertyValue(property).trim();
    }
    return result;
  }, properties) as Promise<Record<K, string>>;
}

/** Pin the stored appearance so a run's browser colour scheme cannot pick one. */
export function useStoredTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  return page.addInitScript((selected) => {
    localStorage.setItem('color-theme', selected);
    localStorage.setItem('navVisible', 'true');
    localStorage.removeItem('theme-definition');
    localStorage.removeItem('theme-source');
    localStorage.removeItem('theme-colors');
    localStorage.removeItem('theme-name');
  }, theme);
}
