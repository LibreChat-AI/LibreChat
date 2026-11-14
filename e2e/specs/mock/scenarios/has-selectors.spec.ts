import postcss from 'postcss';
import { expect, test } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * No `:has()` rule in the shipped stylesheet may leave the browser unable to tell which
 * elements it can reach.
 *
 * `:has()` makes an element's style depend on what is under it, so when something changes
 * under an anchor the browser re-styles whatever the rule's subject could be. Two shapes give
 * it nothing to narrow that by, and it falls back to the anchor's entire subtree:
 *
 * - a subject that is every descendant: `.wrap:has(:disabled) *`
 * - `:has()` inside `:is()` or `:where()` with more selector after it:
 *   `.x:is(:where(.group):has(:focus-visible) *)`, which is what Tailwind's `group-has-[…]`
 *   and `peer-has-[…]` emit
 *
 * Message rows are `:has()` anchors, so one rule of either shape made a button mounting, or
 * flipping `disabled`, in every row re-style every row: 90 to 110 ms in a 250-message thread,
 * at the start and the end of each run. The same rules written with a named subject
 * (`:where(.group):has(:focus-visible) .x`) match the same elements at a tenth of the cost;
 * `e2e/benchmarks-fade/restyle.perf.spec.ts` measures it.
 */

/** Splits at the top level only, so a separator inside `()` or `[]` is left alone. */
function splitTopLevel(text: string, isSeparator: (char: string) => boolean): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(' || char === '[') {
      depth += 1;
    } else if (char === ')' || char === ']') {
      depth -= 1;
    }
    if (depth === 0 && isSeparator(char)) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

const compoundsOf = (complex: string): string[] =>
  splitTopLevel(complex, (char) => /[\s>+~]/.test(char));

/** The arguments of every `:is()`, `:where()` and `:not()` in a selector, at any depth. */
function functionalArguments(selector: string): string[] {
  const found: string[] = [];
  const opener = /:(?:is|where|not)\(/g;
  for (let match = opener.exec(selector); match != null; match = opener.exec(selector)) {
    let depth = 1;
    let end = match.index + match[0].length;
    while (end < selector.length && depth > 0) {
      if (selector[end] === '(') {
        depth += 1;
      } else if (selector[end] === ')') {
        depth -= 1;
      }
      end += 1;
    }
    found.push(selector.slice(match.index + match[0].length, end - 1));
  }
  return found;
}

/** A compound the browser can look up: it names a class, an id, an attribute or a tag. */
function namesItsSubject(compound: string): boolean {
  const bare = compound.replace(/^\*/, '');
  return /^[a-zA-Z.#[]/.test(bare) || /[.#[]/.test(bare);
}

/** Why a selector leaves a `:has()` unbounded, or `null` when it does not. */
function unboundedHas(selector: string): string | null {
  for (const complex of splitTopLevel(selector, (char) => char === ',')) {
    if (!complex.includes(':has(')) {
      continue;
    }
    const compounds = compoundsOf(complex);
    const subject = compounds[compounds.length - 1];
    const anchored = compounds.slice(0, -1).some((compound) => compound.includes(':has('));
    if (anchored && !namesItsSubject(subject)) {
      return 'its subject is every descendant of the :has() anchor';
    }
    for (const argument of functionalArguments(complex)) {
      for (const inner of splitTopLevel(argument, (char) => char === ',')) {
        const innerCompounds = compoundsOf(inner);
        if (innerCompounds.slice(0, -1).some((compound) => compound.includes(':has('))) {
          return ':has() sits inside :is()/:where() with more selector after it';
        }
      }
    }
  }
  return null;
}

test.describe(':has() selectors', () => {
  test('the checker reports the two unbounded shapes and passes their bounded forms @scenario:has-selector-checker-knows-its-shapes', () => {
    const FOCUS = ':focus-visible:not(:is(input,textarea,[contenteditable]))';
    for (const selector of [
      '.theme-disabled-within\\:\\[\\&_\\*\\]\\:text-text-disabled:is(:root *):has(:disabled) *',
      '.wrap:has(:disabled) *',
      '.wrap:has(:disabled) > :hover',
      `.group-has-\\[x\\]\\:opacity-100:is(:where(.group):has(${FOCUS}) *)`,
      '.x:is(:where(.group):has([data-hover-active]) *)',
      '.x:where(.peer:has(:checked) ~ *)',
      '.fine, .wrap:has(:disabled) *',
    ]) {
      expect(unboundedHas(selector), selector).not.toBeNull();
    }
    for (const selector of [
      `:where(.group):has(${FOCUS}) .grouped-keyboard-focus\\:opacity-100`,
      '.wrap:has(:disabled) .part',
      '.wrap:has(:disabled) p',
      '.theme-disabled-within\\:opacity-100:is(:root *):has(:disabled)',
      '.has-\\[\\:disabled\\]\\:opacity-50:has(:disabled)',
      '.result-streaming>:is(ul,ol):last-child>li:last-child:not(:has(>:is(ul,ol,pre))):after',
      `.message-render:has(${FOCUS}) .message-timestamp`,
      '.theme-disabled-fill\\:\\[\\&_\\*\\]\\:text-text-disabled:is(:root *) *',
      '.animated-panels:has(>[data-was-open])>.animated-tab-panel:not([dir=ltr])',
    ]) {
      expect(unboundedHas(selector), selector).toBeNull();
    }
  });

  test('every :has() rule the app ships names what it can reach @scenario:has-selectors-stay-scoped', async ({
    page,
  }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await expect(page.locator('html')).toBeVisible();
    const hrefs = await page.evaluate(() =>
      Array.from(document.styleSheets)
        .map((sheet) => sheet.href)
        .filter((href): href is string => href != null && href.startsWith(location.origin)),
    );
    expect(hrefs.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    let checked = 0;
    for (const href of hrefs) {
      const response = await page.request.get(href);
      expect(response.ok()).toBeTruthy();
      postcss.parse(await response.text()).walkRules((rule) => {
        if (!rule.selector.includes(':has(')) {
          return;
        }
        checked += 1;
        const reason = unboundedHas(rule.selector);
        if (reason != null) {
          offenders.push(`${rule.selector.replace(/\s+/g, ' ')}\n    ${reason}`);
        }
      });
    }

    /** A stylesheet with no `:has()` at all would pass for the wrong reason. */
    expect(checked).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
