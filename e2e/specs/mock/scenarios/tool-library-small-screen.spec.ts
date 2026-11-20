import { devices, expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { openAgentBuilder } from '../agents.helpers';

const TOOL_LIBRARY = 'Tool Library';
/** The dialog's own open animation moves it by a fraction of a pixel per frame,
 *  so geometry is only meaningful once two consecutive reads agree. */
const STABLE_EPSILON = 0.5;
const EDGE_TOLERANCE = 1;

type Box = { x: number; y: number; width: number; height: number };

async function settledBox(locator: Locator): Promise<Box> {
  const last: { box: Box | null } = { box: null };
  await expect
    .poll(
      async () => {
        const box = await locator.boundingBox();
        if (!box) {
          return false;
        }
        const previous = last.box;
        last.box = box;
        return (
          previous !== null &&
          Math.abs(box.x - previous.x) < STABLE_EPSILON &&
          Math.abs(box.y - previous.y) < STABLE_EPSILON &&
          Math.abs(box.width - previous.width) < STABLE_EPSILON &&
          Math.abs(box.height - previous.height) < STABLE_EPSILON
        );
      },
      { timeout: 15000 },
    )
    .toBe(true);
  return last.box!;
}

async function openToolLibrary(page: Page): Promise<Locator> {
  const form = await openAgentBuilder(page);
  await form.getByRole('button', { name: 'Add tools' }).click();
  const dialog = page.getByRole('dialog', { name: TOOL_LIBRARY });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The actions fade over the shared motion duration, so the resting value is
 *  what matters, not the frame the assertion happened to land on. */
async function expectOpacity(locator: Locator, value: string): Promise<void> {
  await expect
    .poll(() => locator.evaluate((element) => getComputedStyle(element).opacity), {
      timeout: 10000,
    })
    .toBe(value);
}

async function blurAndMovePointer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      active.blur();
    }
  });
  await page.mouse.move(0, 0);
}

/** The dialog's close button is absolutely positioned over the search row, so the
 *  field has to stop short of it at every width. */
async function expectClearOfCloseButton(page: Page, dialog: Locator): Promise<void> {
  const close = page.getByRole('dialog').locator('button.absolute.right-4');
  if ((await close.count()) === 0) {
    return;
  }
  const field = await dialog.getByRole('textbox', { name: 'Search tools…' }).boundingBox();
  const button = await close.first().boundingBox();
  expect(field).not.toBeNull();
  expect(button).not.toBeNull();
  const sameRow = field!.y < button!.y + button!.height && button!.y < field!.y + field!.height;
  expect(sameRow && field!.x + field!.width > button!.x).toBe(false);
}

test.describe('tool library on a touch viewport', () => {
  test.use({ viewport: devices['Pixel 7'].viewport, hasTouch: true });

  test('@scenario:tool-library-fills-a-phone-viewport the catalog stays within a phone viewport', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const dialog = await openToolLibrary(page);
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();

    const dialogBox = await settledBox(dialog);
    expect(dialogBox.x).toBeLessThanOrEqual(EDGE_TOLERANCE);
    expect(Math.abs(dialogBox.width - viewport!.width)).toBeLessThanOrEqual(EDGE_TOLERANCE);
    await expect(dialog.locator('aside')).toHaveCount(0);
    await expect(dialog.getByRole('group', { name: TOOL_LIBRARY })).toBeVisible();

    /** The regression this pins: the dialog content is a grid, and without
     *  `min-w-0` its column sized to the chip row's 744px min-content, which
     *  pushed every card past the right edge of a 412px screen. */
    const cards = dialog.getByRole('list', { name: TOOL_LIBRARY }).locator(':scope > li');
    await expect(cards.first()).toBeVisible();
    for (let index = 0; index < (await cards.count()); index += 1) {
      const cardBox = await cards.nth(index).boundingBox();
      expect(cardBox).not.toBeNull();
      expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(viewport!.width + EDGE_TOLERANCE);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport!.width);

    /** The chip row is this layout's primary navigation and only a finger reaches
     *  it, so every chip owes the shared 44px tap-target floor. */
    const chips = dialog.getByRole('group', { name: TOOL_LIBRARY }).getByRole('button');
    for (let index = 0; index < (await chips.count()); index += 1) {
      const chipBox = await chips.nth(index).boundingBox();
      expect(chipBox).not.toBeNull();
      expect(chipBox!.height).toBeGreaterThanOrEqual(44);
    }

    /** The close button is absolutely positioned over this row, so the search
     *  field owes it clearance; a responsive padding utility silently reset it. */
    await expectClearOfCloseButton(page, dialog);
  });

  test('@scenario:tool-library-filter-chips-narrow-the-catalog filter chips narrow the catalog and expose an empty favorites state', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const dialog = await openToolLibrary(page);
    const cards = dialog.getByRole('list', { name: TOOL_LIBRARY }).locator(':scope > li');
    const allChip = dialog.getByRole('button', { name: /^All(?:\s+\d+)?$/ });
    await expect(allChip).toHaveAttribute('aria-pressed', 'true');
    const allCount = await cards.count();

    const mcpChip = dialog.getByRole('button', { name: /^MCP servers(?:\s+\d+)?$/ });
    const mcpCount = Number.parseInt((await mcpChip.locator('span').last().innerText()).trim(), 10);
    expect(mcpCount).toBeGreaterThan(0);
    await mcpChip.click();
    await expect.poll(() => cards.count()).toBe(mcpCount);
    expect(await cards.count()).toBeLessThan(allCount);

    await dialog.getByRole('button', { name: 'Favorites', exact: true }).click();
    await expect(
      dialog.getByText("You haven't favorited anything yet", { exact: true }),
    ).toBeVisible();
    await expect(cards).toHaveCount(0);
  });

  test('@scenario:tool-card-actions-are-visible-without-hover-on-touch card actions are visible without hover on a coarse pointer', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const dialog = await openToolLibrary(page);
    await blurAndMovePointer(page);

    const configure = dialog.getByRole('button', { name: 'Configure', exact: true }).first();
    const favorite = dialog.getByRole('button', { name: 'Add to favorites', exact: true }).first();
    await expect(configure).toBeVisible();
    await expect(favorite).toBeVisible();
    /** The reason the actions are visible: the hide rule is gated on the absence
     *  of a coarse pointer, not on the absence of hover. */
    expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);
    await expectOpacity(configure, '1');
    await expectOpacity(favorite, '1');

    /** The actions rest over the card's content, and on touch they never fade out,
     *  so the card has to keep its description clear of them. */
    const overlap = await dialog
      .locator('ul > li')
      .first()
      .evaluate((card) => {
        const cluster = card.querySelector('div.absolute')?.getBoundingClientRect();
        const paragraphs = Array.from(card.querySelectorAll('p'));
        const description = paragraphs[paragraphs.length - 1]?.getBoundingClientRect();
        if (!cluster || !description) {
          return null;
        }
        return description.bottom > cluster.top && description.right > cluster.left;
      });
    expect(overlap).toBe(false);
  });

  test('@scenario:tool-row-actions-are-visible-without-hover-on-touch selected tool row actions stay visible without hover', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const form = await openAgentBuilder(page);
    await form.getByRole('button', { name: 'Add tools' }).click();
    const dialog = page.getByRole('dialog', { name: TOOL_LIBRARY });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Search tools…' }).fill('Calculator');
    const calculator = dialog.getByRole('button', { name: /^Calculator/ }).first();
    await expect(calculator).toBeVisible();
    await calculator.click();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();

    const row = form.locator('li').filter({ hasText: 'Calculator' }).first();
    await expect(row).toBeVisible();
    const details = row.getByRole('button', { name: 'Tool details', exact: true });
    const remove = row.getByRole('button', { name: 'Remove from agent', exact: true });
    /** The row hides the whole action cluster, so the wrapper is what the gate
     *  applies to; a visible button inside a transparent parent is still invisible. */
    const actionWrapper = details.locator('xpath=..');
    await expect(details).toBeVisible();
    await expect(remove).toBeVisible();
    await expectOpacity(actionWrapper, '1');
  });
});

/** A mouse device, asserted as one: these scenarios describe what a pointer that
 *  can hover and cannot tap sees, so they pin their own context rather than
 *  inheriting the run's project, one of which is a touch phone. */
test.describe('tool library on a mouse viewport', () => {
  test.use({ viewport: { width: 1280, height: 860 }, hasTouch: false, isMobile: false });

  test('@scenario:tool-card-actions-stay-hover-gated-with-a-mouse card actions remain hidden until hover on a mouse', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const dialog = await openToolLibrary(page);
    await blurAndMovePointer(page);

    const configure = dialog.getByRole('button', { name: 'Configure', exact: true }).first();
    const card = configure.locator('xpath=ancestor::li[1]');
    expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(false);
    await expectOpacity(configure, '0');
    await card.hover();
    await expectOpacity(configure, '1');
  });

  test('@scenario:tool-card-action-is-revealed-by-keyboard-focus keyboard focus reveals a card action', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const dialog = await openToolLibrary(page);
    await blurAndMovePointer(page);

    const configure = dialog.getByRole('button', { name: 'Configure', exact: true }).first();
    const card = configure.locator('xpath=ancestor::li[1]');
    const cardButton = card.getByRole('button').first();
    await cardButton.focus();
    await cardButton.press('Tab');
    await expect(configure).toBeFocused();
    expect(await configure.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
    await expectOpacity(configure, '1');
  });

  test('@scenario:tool-library-keeps-its-rail-on-desktop the desktop rail contains kind entries', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const dialog = await openToolLibrary(page);
    const rail = dialog.locator('aside');
    await expect(rail).toBeVisible();
    for (const name of ['All', 'Native', 'Tools', 'MCP servers', 'Actions']) {
      await expect(
        rail.getByRole('button', { name: new RegExp(`^${name}(?:\\s+\\d+)?$`) }),
      ).toBeVisible();
    }
    await expect(dialog.getByRole('group', { name: TOOL_LIBRARY })).toHaveCount(0);
    await expectClearOfCloseButton(page, dialog);
  });
});

/** A narrow desktop window is below md as well, so it gets the chip row without
 *  getting a finger to drag it. */
test.describe('tool library in a narrow mouse window', () => {
  test.use({ viewport: { width: 520, height: 900 }, hasTouch: false, isMobile: false });

  test('@scenario:tool-library-chips-stay-scrollable-with-a-mouse the overflowing chip row keeps a scrollbar without touch', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const dialog = await openToolLibrary(page);
    const chips = dialog.getByRole('group', { name: TOOL_LIBRARY });
    await expect(chips).toBeVisible();
    expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(false);

    const row = await chips.evaluate((element) => ({
      overflows: element.scrollWidth > element.clientWidth,
      scrollbar: element.offsetHeight - element.clientHeight,
    }));
    expect(row.overflows).toBe(true);
    /** The affordance itself: with the scrollbar hidden this is 0 and a wheel
     *  scrolls the page instead, so the trailing views cannot be reached. */
    expect(row.scrollbar).toBeGreaterThan(0);

    /** And it does scroll: the last view has to become reachable. */
    const favorites = chips.getByRole('button', { name: 'Favorites', exact: true });
    await favorites.scrollIntoViewIfNeeded();
    await favorites.click();
    await expect(favorites).toHaveAttribute('aria-pressed', 'true');
  });
});
