import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  messagesView,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';
import { probeStyle } from './style.helpers';

/**
 * The composer's own controls (the Thinking pill and its effort rail, the palette rows and
 * their mode chips, the numeric reasoning trigger and the pending steer actions) are drawn by
 * the shared Button. Each keeps the box, ink and fill it had as a local recipe, so these
 * assertions hold on the base as well as on the change; the colors resolve through probes
 * of the semantic utilities, which keeps them true in light and dark mode.
 */
test.describe.configure({ timeout: 120_000 });

const box = (locator: Locator) =>
  locator.evaluate((node: HTMLElement) => {
    const style = getComputedStyle(node);
    return {
      height: node.offsetHeight,
      radius: parseFloat(style.borderTopLeftRadius) >= 9999 ? 'full' : style.borderTopLeftRadius,
      paddingLeft: style.paddingLeft,
      gap: style.columnGap,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
    };
  });

const paint = (locator: Locator) =>
  locator.evaluate((node: HTMLElement) => {
    const style = getComputedStyle(node);
    return { color: style.color, background: style.backgroundColor };
  });

async function expectPaint(page: Page, locator: Locator, classes: string) {
  await page.mouse.move(0, 0);
  await expect
    .poll(() => paint(locator))
    .toEqual({
      color: await probeStyle(page, classes, 'color'),
      background: await probeStyle(page, classes, 'background-color'),
    });
}

/** Paint of a pressed state whose classes exist only behind the `aria-pressed:` variant. */
async function expectPressedPaint(page: Page, locator: Locator, classes: string) {
  const expected = await page.evaluate((className) => {
    const probe = document.createElement('button');
    probe.className = className;
    probe.setAttribute('aria-pressed', 'true');
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const value = { color: style.color, background: style.backgroundColor };
    probe.remove();
    return value;
  }, classes);
  await page.mouse.move(0, 0);
  await expect.poll(() => paint(locator)).toEqual(expected);
}

async function openComposer(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
}

test.describe('composer controls on the shared Button', () => {
  test('Thinking pill and effort rail keep their look and keyboard @scenario:thinking-pill-and-effort-rail-keep-their-look', async ({
    page,
  }) => {
    await openComposer(page);
    const thinking = page.getByRole('button', { name: /^Thinking: / });
    await expect(thinking).toBeVisible();
    expect(await box(thinking)).toEqual({
      height: 32,
      radius: 'full',
      paddingLeft: '10px',
      gap: '4px',
      fontSize: '14px',
      fontWeight: '400',
    });
    await expectPaint(page, thinking, 'text-text-primary');

    await thinking.focus();
    await page.keyboard.press('Enter');
    const popover = page.getByRole('dialog', { name: /^Thinking: / });
    await expect(popover).toBeVisible();
    await expect(thinking).toHaveAttribute('aria-expanded', 'true');
    await expectPaint(page, thinking, 'bg-surface-hover text-text-primary');

    const auto = popover.getByRole('button', { name: 'Auto', exact: true });
    await expect(auto).toHaveAttribute('aria-pressed', 'true');
    expect(await box(auto)).toMatchObject({
      radius: 'full',
      paddingLeft: '8px',
      fontSize: '12px',
      fontWeight: '400',
    });
    await expectPressedPaint(
      page,
      auto,
      'aria-pressed:bg-accent-primary/15 aria-pressed:text-accent-primary',
    );

    await auto.click();
    await expect(auto).toHaveAttribute('aria-pressed', 'false');
    await expectPaint(page, auto, 'text-text-secondary');

    const checked = popover.getByRole('radio', { checked: true });
    await expect(checked).toHaveCount(1);
    const radios = popover.getByRole('radio');
    const count = await radios.count();
    const names = await radios.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('aria-label')),
    );
    const start = names.indexOf(await checked.getAttribute('aria-label'));
    const target = start === count - 1 ? start - 1 : start + 1;
    await checked.focus();
    await page.keyboard.press(target > start ? 'ArrowRight' : 'ArrowLeft');
    const moved = radios.nth(target);
    await expect(moved).toHaveAttribute('aria-checked', 'true');
    await expect(moved).toBeFocused();
    const ring = await moved.evaluate((node) => getComputedStyle(node).boxShadow);
    expect(ring).toContain('inset');
    await expect
      .poll(() => moved.evaluate((node) => getComputedStyle(node).backgroundColor))
      .toBe('rgba(0, 0, 0, 0)');

    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(thinking).toBeFocused();
    await expect(thinking).toHaveAttribute('aria-expanded', 'false');
    await expectPaint(page, thinking, 'text-text-primary');
  });

  test('Palette rows and mode chips keep their look and toggle @scenario:palette-rows-and-mode-chips-keep-their-look', async ({
    page,
  }) => {
    await openComposer(page);
    await page.getByRole('button', { name: 'Attach and tools' }).click();
    const palette = page.getByRole('dialog', { name: 'Attach and tools' });
    const runCode = palette.getByRole('button', { name: 'Run Code', exact: true });
    await expect(runCode).toBeVisible();
    expect(await box(runCode)).toMatchObject({
      radius: '8px',
      paddingLeft: '8px',
      gap: '10px',
      fontWeight: '400',
    });
    const inherited = await runCode.evaluate((node: HTMLElement) => ({
      own: getComputedStyle(node).color,
      cell: getComputedStyle(node.parentElement as HTMLElement).color,
      background: getComputedStyle(node).backgroundColor,
    }));
    expect(inherited.own).toBe(inherited.cell);
    expect(inherited.background).toBe('rgba(0, 0, 0, 0)');

    const artifacts = palette.getByRole('button', { name: 'Artifacts', exact: true });
    await artifacts.click();
    await expect(artifacts).toHaveAttribute('aria-pressed', 'true');
    const standard = palette.getByRole('button', { name: 'Default', exact: true });
    const shadcn = palette.getByRole('button', { name: 'shadcn/ui', exact: true });
    await expect(standard).toHaveAttribute('aria-pressed', 'true');
    await expect(shadcn).toHaveAttribute('aria-pressed', 'false');
    expect(await box(shadcn)).toMatchObject({
      height: 24,
      radius: 'full',
      paddingLeft: '8px',
      fontSize: '12px',
      fontWeight: '400',
    });
    await expectPaint(page, standard, 'bg-surface-active-alt text-text-primary');
    await expectPaint(page, shadcn, 'text-text-secondary');
    expect(await shadcn.evaluate((node) => getComputedStyle(node).borderTopColor)).toBe(
      await probeStyle(page, 'border border-border-medium', 'border-top-color'),
    );

    await shadcn.click();
    await expect(shadcn).toHaveAttribute('aria-pressed', 'true');
    await expect(standard).toHaveAttribute('aria-pressed', 'false');
    await expectPaint(page, shadcn, 'bg-surface-active-alt text-text-primary');
  });

  test('Reasoning trigger keeps its look @scenario:reasoning-trigger-keeps-its-look', async ({
    page,
  }) => {
    await page.route('**/api/endpoints', async (route) => {
      const response = await route.fetch();
      const endpoints = await response.json();
      endpoints['Mock Provider A'].customParams = {
        defaultParamsEndpoint: 'google',
        paramDefinitions: [
          {
            key: 'thinkingBudget',
            type: 'number',
            default: -1,
            range: { min: -1, positiveMin: 128, max: 32768, step: 128 },
          },
        ],
      };
      await route.fulfill({ response, json: endpoints });
    });
    await openComposer(page);
    const response = await sendMessage(page, `E2E_SLOW_REPLY:composer-buttons-${Date.now()}`);
    expect(response.ok()).toBeTruthy();
    await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15000 });

    /** The popover is modal, so Radix hides its trigger from the accessibility tree while open. */
    const reasoning = page.getByRole('button', {
      name: /Reasoning for next message/i,
      includeHidden: true,
    });
    await expect(reasoning).toBeVisible();
    expect(await box(reasoning)).toEqual({
      height: 32,
      radius: '12px',
      paddingLeft: '8px',
      gap: '6px',
      fontSize: '14px',
      fontWeight: '500',
    });
    await expectPaint(page, reasoning, 'text-text-secondary');
    await reasoning.click();
    await expect(page.getByRole('spinbutton')).toBeVisible();
    await expect(reasoning).toHaveAttribute('aria-expanded', 'true');
    await expectPaint(page, reasoning, 'bg-surface-hover text-text-primary');
    await page.keyboard.press('Escape');
    await expect(reasoning).toBeFocused();
    await expectPaint(page, reasoning, 'text-text-secondary');
  });
});
