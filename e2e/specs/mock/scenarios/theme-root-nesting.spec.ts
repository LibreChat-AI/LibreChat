import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { disabledFillClasses } from '../../../../packages/client/src/utils/theme';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * A control follows the theme root nearest to it. `applyTheme` writes `--theme-field-focus-style`
 * and `--theme-disabled-style` on every root it themes (and mirrors a non-default choice as a
 * `data-theme-*` attribute), and the variants read the inherited property, so a root themed with
 * the default style inside one themed with the other gets the default behavior back, and a third
 * level gets the other one again. The roots below write what `applyTheme` writes.
 */

type Root = { field: 'ring' | 'border'; disabled: 'dim' | 'fill' };

/** The focus classes `fieldBase` carries, so nothing but the shared field rules styles the probe. */
const FIELD_CLASSES =
  'lc-field border border-border-control focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-control theme-field-border:focus:border-border-field-focus theme-field-border:focus-visible:ring-1 theme-field-border:focus-visible:ring-border-field-focus';

/** The disabled treatment every primitive carries: half opacity, or the fill a `fill` theme paints. */
const DISABLED_CLASSES = `disabled:opacity-50 ${disabledFillClasses}`;

/** The edge a border-focus field swaps to, set on the outermost root so every level inherits it. */
const FIELD_FOCUS_EDGE = 'rgb(10, 20, 30)';

/**
 * Builds nested roots, outermost first, each holding a field and a disabled button labelled by
 * its depth, and returns the depths.
 */
async function nestRoots(page: Page, roots: Root[]): Promise<number[]> {
  await page.evaluate(
    ([levels, fieldClasses, disabledClasses]) => {
      let parent: HTMLElement = document.body;
      levels.forEach((level, depth) => {
        const root = document.createElement('div');
        root.dataset.theme = `nested-${depth}`;
        root.style.setProperty('--theme-field-focus-style', level.field);
        root.style.setProperty('--theme-disabled-style', level.disabled);
        if (level.field === 'border') {
          root.setAttribute('data-theme-field-focus', 'border');
        }
        if (level.disabled === 'fill') {
          root.setAttribute('data-theme-disabled', 'fill');
        }
        if (depth === 0) {
          root.style.setProperty('--border-field-focus', '10 20 30');
        }
        const field = document.createElement('input');
        field.className = fieldClasses;
        field.setAttribute('aria-label', `field ${depth}`);
        const button = document.createElement('button');
        button.className = disabledClasses;
        button.disabled = true;
        button.textContent = `button ${depth}`;
        root.append(field, button);
        parent.append(root);
        parent = root;
      });
    },
    [roots, FIELD_CLASSES, DISABLED_CLASSES] as const,
  );
  return roots.map((_, depth) => depth);
}

async function openChat(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 30000,
  });
}

/** The ring's spread on keyboard focus (`2px` for the ring style, `1px` for the edge one). */
async function keyboardRing(page: Page, depth: number): Promise<string> {
  const field = page.getByRole('textbox', { name: `field ${depth}` });
  await field.click();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(field).toBeFocused();
  return field.evaluate((node) => {
    const layers = getComputedStyle(node).boxShadow.split(/,(?![^(]*\))/);
    const ring = layers.find((layer) => !/0px 0px 0px 0px\s*$/.test(layer.trim())) ?? 'none';
    return /(\d+px)\s*$/.exec(ring.trim())?.[1] ?? ring;
  });
}

/** The edge a pointer-focused field keeps: the swapped edge, or the reset one. */
async function pointerEdge(page: Page, depth: number): Promise<string> {
  const field = page.getByRole('textbox', { name: `field ${depth}` });
  await page.evaluate(() =>
    document.documentElement.setAttribute('data-input-modality', 'pointer'),
  );
  await field.click();
  await expect(field).toBeFocused();
  return field.evaluate((node) => getComputedStyle(node).borderTopColor);
}

const disabledOpacity = (page: Page, depth: number) =>
  page
    .getByRole('button', { name: `button ${depth}` })
    .evaluate((node) => getComputedStyle(node).opacity);

test.describe('nested theme roots', () => {
  test('a field follows the focus style of its nearest themed root @scenario:nested-theme-roots-field-focus', async ({
    page,
  }) => {
    await openChat(page);
    const depths = await nestRoots(page, [
      { field: 'border', disabled: 'dim' },
      { field: 'ring', disabled: 'dim' },
      { field: 'border', disabled: 'dim' },
    ]);

    const rings = [];
    for (const depth of depths) {
      rings.push(await keyboardRing(page, depth));
    }
    expect(rings).toEqual(['1px', '2px', '1px']);

    const edges = [];
    for (const depth of depths) {
      edges.push(await pointerEdge(page, depth));
    }
    expect(edges[0]).toBe(FIELD_FOCUS_EDGE);
    expect(edges[1]).not.toBe(FIELD_FOCUS_EDGE);
    expect(edges[2]).toBe(FIELD_FOCUS_EDGE);
  });

  test('a ring root keeps its ring and a border root nested in it swaps the edge @scenario:nested-theme-roots-border-inside-ring', async ({
    page,
  }) => {
    await openChat(page);
    const depths = await nestRoots(page, [
      { field: 'ring', disabled: 'dim' },
      { field: 'border', disabled: 'dim' },
    ]);

    const rings = [];
    for (const depth of depths) {
      rings.push(await keyboardRing(page, depth));
    }
    expect(rings).toEqual(['2px', '1px']);
  });

  test('a disabled control follows the disabled style of its nearest themed root @scenario:nested-theme-roots-disabled', async ({
    page,
  }) => {
    await openChat(page);
    const fillOuter = await nestRoots(page, [
      { field: 'ring', disabled: 'fill' },
      { field: 'ring', disabled: 'dim' },
      { field: 'ring', disabled: 'fill' },
    ]);
    const opacities = [];
    for (const depth of fillOuter) {
      opacities.push(await disabledOpacity(page, depth));
    }
    expect(opacities).toEqual(['1', '0.5', '1']);

    await openChat(page);
    const dimOuter = await nestRoots(page, [
      { field: 'ring', disabled: 'dim' },
      { field: 'ring', disabled: 'fill' },
      { field: 'ring', disabled: 'dim' },
    ]);
    const dimmed = [];
    for (const depth of dimOuter) {
      dimmed.push(await disabledOpacity(page, depth));
    }
    expect(dimmed).toEqual(['0.5', '1', '0.5']);
  });
});
