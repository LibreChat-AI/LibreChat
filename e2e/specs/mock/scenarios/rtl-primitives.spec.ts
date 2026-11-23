import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * The shared primitives place their parts on logical sides, so the same markup lays out mirrored
 * under `dir="rtl"`. The document direction is set by hand after load: the language that flips it
 * belongs to the i18n layer, and what these scenarios hold is how the primitives follow it.
 */
test.describe.configure({ timeout: 120_000 });
test.use({ viewport: { width: 1280, height: 800 } });

type Direction = 'ltr' | 'rtl';

/** Pins the document direction the way an RTL language would. The app's language sync stamps
 *  `dir` from the UI language whenever it runs (at boot, and again as settings mount), so the
 *  pin re-applies the value after any such write. */
async function setDirection(page: Page, dir: Direction) {
  await page.evaluate((value) => {
    const root = document.documentElement;
    const state = window as unknown as { __e2eDirPin?: MutationObserver };
    state.__e2eDirPin?.disconnect();
    root.dir = value;
    const pin = new MutationObserver(() => {
      if (root.dir !== value) {
        root.dir = value;
      }
    });
    pin.observe(root, { attributes: true, attributeFilter: ['dir'] });
    state.__e2eDirPin = pin;
  }, dir);
  await expect(page.locator('html')).toHaveAttribute('dir', dir);
}

async function openGeneralSettings(page: Page, dir: Direction): Promise<Locator> {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await page.getByTestId('nav-user').click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({
    timeout: 15000,
  });
  await dialog.getByRole('tab', { name: 'General' }).click();
  await setDirection(page, dir);
  return dialog;
}

/** Where the thumb sits inside its track once its transition settles, in track pixels. */
async function thumbOffsets(control: Locator) {
  let previous = '';
  await expect
    .poll(async () => {
      const next = JSON.stringify(await readThumb(control));
      const settled = next === previous;
      previous = next;
      return settled;
    })
    .toBe(true);
  return JSON.parse(previous) as Awaited<ReturnType<typeof readThumb>>;
}

function readThumb(control: Locator) {
  return control.evaluate((node: HTMLElement) => {
    const track = node.getBoundingClientRect();
    const thumb = (node.firstElementChild as HTMLElement).getBoundingClientRect();
    return {
      state: node.getAttribute('data-state'),
      fromLeft: Math.round(thumb.left - track.left),
      fromRight: Math.round(track.right - thumb.right),
    };
  });
}

/** Toggles the switch, reads both states, and leaves it as it was. */
async function bothStates(control: Locator) {
  const first = await thumbOffsets(control);
  await control.click();
  const second = await thumbOffsets(control);
  await control.click();
  await expect(control).toHaveAttribute('data-state', first.state ?? '');
  const checked = first.state === 'checked' ? first : second;
  const unchecked = first.state === 'checked' ? second : first;
  return { checked, unchecked };
}

async function openArchivedChats(page: Page, dir: Direction): Promise<Locator> {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await page.getByTestId('nav-user').click();
  await page.getByRole('menuitem', { name: 'Archived chats' }).click();
  const dialog = page.getByRole('dialog', { name: 'Archived chats' });
  await expect(dialog.getByRole('heading', { name: 'Archived chats' })).toBeVisible({
    timeout: 15000,
  });
  await setDirection(page, dir);
  return dialog;
}

async function archivedLayout(dialog: Locator) {
  return dialog.evaluate((node: HTMLElement) => {
    const box = node.getBoundingClientRect();
    const close = Array.from(node.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Close',
    ) as HTMLElement;
    const closeBox = close.getBoundingClientRect();
    const heading = node.querySelector('h2') as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(heading);
    const text = range.getBoundingClientRect();
    return {
      closeCenter: (closeBox.left + closeBox.right) / 2 - box.left,
      dialogWidth: box.width,
      textOverlapsClose: text.right > closeBox.left && text.left < closeBox.right,
    };
  });
}

/** Hovers the sidebar's new-chat button, whose tooltip asks for the physical `right` side. */
async function newChatTooltip(page: Page) {
  const anchor = page.getByTestId('new-chat-button');
  await page.mouse.move(0, 0);
  await expect(page.locator('.tooltip')).toBeHidden();
  await anchor.hover();
  const tooltip = page.locator('.tooltip');
  await expect(tooltip).toBeVisible({ timeout: 10000 });
  /** Read once the popover has settled where it opens. */
  let previous = '';
  await expect
    .poll(async () => {
      const [a, t] = await Promise.all([anchor.boundingBox(), tooltip.boundingBox()]);
      const next = JSON.stringify({
        anchorLeft: Math.round(a?.x ?? 0),
        anchorRight: Math.round((a?.x ?? 0) + (a?.width ?? 0)),
        tooltipLeft: Math.round(t?.x ?? 0),
        tooltipRight: Math.round((t?.x ?? 0) + (t?.width ?? 0)),
      });
      const settled = next === previous;
      previous = next;
      return settled;
    })
    .toBe(true);
  return JSON.parse(previous) as {
    anchorLeft: number;
    anchorRight: number;
    tooltipLeft: number;
    tooltipRight: number;
  };
}

test.describe('RTL shared primitives', () => {
  test('a switch thumb travels toward the inline end and stays inside its track in RTL @scenario:rtl-switch-thumb-stays-in-track', async ({
    page,
  }) => {
    const dialog = await openGeneralSettings(page, 'rtl');
    const control = dialog.getByRole('switch').first();
    await expect(control).toBeVisible();
    /** Radix Tabs stamps its resolved direction on the settings panel, which stays `ltr` until the
     *  app mounts a direction provider, so the switch's own container carries the RTL direction. */
    await control.evaluate((node) => node.parentElement?.setAttribute('dir', 'rtl'));

    const { checked, unchecked } = await bothStates(control);
    /** Unchecked rests on the inline start (the right in RTL), checked on the inline end. */
    expect(unchecked.fromRight).toBeLessThanOrEqual(unchecked.fromLeft);
    expect(checked.fromLeft).toBeLessThan(checked.fromRight);
    for (const reading of [checked, unchecked]) {
      expect(reading.fromLeft).toBeGreaterThanOrEqual(0);
      expect(reading.fromRight).toBeGreaterThanOrEqual(0);
    }

    /** An LTR island inside the RTL page keeps the LTR travel. */
    await control.evaluate((node) => node.parentElement?.setAttribute('dir', 'ltr'));
    const island = await bothStates(control);
    expect(island.checked.fromRight).toBeLessThan(island.checked.fromLeft);
    expect(island.checked.fromRight).toBeGreaterThanOrEqual(0);
  });

  test('a dialog puts its close button on the inline end, clear of its title, in RTL @scenario:rtl-dialog-close-button-mirrors', async ({
    page,
  }) => {
    const dialog = await openArchivedChats(page, 'rtl');
    const layout = await archivedLayout(dialog);

    expect(layout.closeCenter).toBeLessThan(layout.dialogWidth / 2);
    expect(layout.textOverlapsClose).toBe(false);
  });

  test('an LTR page keeps the switch thumb and dialog close button on their physical sides @scenario:ltr-primitives-keep-physical-sides', async ({
    page,
  }) => {
    const settings = await openGeneralSettings(page, 'ltr');
    const control = settings.getByRole('switch').first();
    await expect(control).toBeVisible();
    const { checked, unchecked } = await bothStates(control);
    expect(unchecked.fromLeft).toBeLessThanOrEqual(unchecked.fromRight);
    expect(checked.fromRight).toBeLessThan(checked.fromLeft);
    for (const reading of [checked, unchecked]) {
      expect(reading.fromLeft).toBeGreaterThanOrEqual(0);
      expect(reading.fromRight).toBeGreaterThanOrEqual(0);
    }

    const dialog = await openArchivedChats(page, 'ltr');
    const layout = await archivedLayout(dialog);
    expect(layout.closeCenter).toBeGreaterThan(layout.dialogWidth / 2);
    expect(layout.textOverlapsClose).toBe(false);
  });

  test('a side tooltip follows the writing direction when it flips without a reload @scenario:rtl-side-tooltip-follows-direction-switch', async ({
    page,
  }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    await expect(page.getByTestId('new-chat-button')).toBeVisible({ timeout: 15000 });
    await setDirection(page, 'ltr');
    const ltr = await newChatTooltip(page);
    expect(ltr.tooltipLeft).toBeGreaterThanOrEqual(ltr.anchorRight);

    /** The same mounted anchor, after the document turns RTL the way a language switch does. */
    await setDirection(page, 'rtl');
    const rtl = await newChatTooltip(page);
    expect(rtl.tooltipRight).toBeLessThanOrEqual(rtl.anchorLeft);
  });
});
