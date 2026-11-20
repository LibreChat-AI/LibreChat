import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * The welcome greeting picks its size from its length alone, so where it wraps
 * depends on the name in it. On a narrow phone that used to leave the last word
 * alone on its own line ("Good morning, Daniel / Xavier"); the greeting now
 * balances its lines instead, and a greeting that fits keeps its single line.
 */

const NBSP = String.fromCharCode(0xa0);

/** Answers the startup config with a fixed greeting, so the text does not follow the clock. */
async function serveGreeting(page: Page, greeting: () => string) {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    await route.fulfill({
      response,
      json: {
        ...config,
        interface: { ...config.interface, landingHeading: 'greeting', customWelcome: greeting() },
      },
    });
  });
}

/** The greeting's lines, as the words each one holds, read from the word boxes' layout. */
async function greetingLines(page: Page, greeting: string) {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  const heading = page.locator('main .split-parent');
  await expect(heading).toContainText(greeting, { timeout: 30000 });
  return heading.evaluate((node, nbsp) => {
    const lines = new Map<number, string[]>();
    for (const word of Array.from(
      node.querySelectorAll<HTMLElement>(':scope > span[aria-hidden]'),
    )) {
      const text = (word.textContent ?? '').split(nbsp).join(' ').trim();
      lines.set(word.offsetTop, [...(lines.get(word.offsetTop) ?? []), text]);
    }
    return [...lines.entries()].sort(([a], [b]) => a - b).map(([, line]) => line);
  }, NBSP);
}

/** Greetings that left a word alone at these widths before the lines were balanced. */
const NARROW_CASES = [
  { width: 320, greeting: 'Good morning, Daniel Xavier' },
  { width: 320, greeting: "How's the day going, Test User?" },
  { width: 340, greeting: "How's the day going, Daniel Xavier?" },
];

test('a wrapped greeting leaves no word alone on its last line on a narrow phone @scenario:wrapped-greeting-has-no-orphan-on-a-narrow-phone', async ({
  page,
}) => {
  test.setTimeout(90000);
  let current = NARROW_CASES[0].greeting;
  await serveGreeting(page, () => current);
  for (const { width, greeting } of NARROW_CASES) {
    current = greeting;
    await page.setViewportSize({ width, height: 700 });
    const lines = await greetingLines(page, greeting);
    const label = `${greeting} at ${width}px: ${JSON.stringify(lines)}`;
    expect(lines.length, label).toBeGreaterThan(1);
    expect(lines.at(-1)!.length, label).toBeGreaterThan(1);
  }
});

test('a greeting that fits keeps a single line on a wide screen @scenario:fitting-greeting-stays-on-one-line', async ({
  page,
}) => {
  const greeting = "How's the day going, Daniel Xavier?";
  await serveGreeting(page, () => greeting);
  await page.setViewportSize({ width: 1280, height: 800 });
  expect(await greetingLines(page, greeting)).toHaveLength(1);
});
