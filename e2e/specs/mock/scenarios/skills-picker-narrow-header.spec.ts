import { devices, expect, test, type Locator, type Page } from '@playwright/test';
import { openAgentBuilder } from '../agents.helpers';

const TOLERANCE = 2;
/** The dialog scales as it opens, so a box read on the first frame is smaller
 *  than the one the reader sees; poll until two reads agree. */
const STABLE_EPSILON = 0.5;

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

async function openSkillsPicker(page: Page): Promise<Locator> {
  const form = await openAgentBuilder(page);
  await form.getByRole('radio', { name: 'Selected', exact: true }).click();
  /** With nothing selected the only trigger is the dashed empty-state card, and
   *  its accessible name carries the hint line as well as the label. */
  const addSkill = form.getByRole('button', { name: /Add skill/ }).first();
  await expect(addSkill).toBeVisible();
  await addSkill.click();

  const dialog = page.getByRole('dialog', { name: 'Skills', exact: true });
  await expect(dialog).toBeVisible();
  await settledBox(dialog);
  return dialog;
}

function headerParts(dialog: Locator) {
  return {
    header: dialog
      .getByRole('heading', { name: 'Skills', exact: true })
      .locator('..')
      .locator('..'),
    view: dialog.getByRole('radiogroup', { name: 'Filter skills', exact: true }),
    create: dialog.getByRole('button', { name: 'Create Skill', exact: true }),
    filter: dialog.getByRole('textbox', { name: 'Search skills...', exact: true }),
  };
}

async function expectNoHeaderOverflow(header: Locator): Promise<void> {
  await expect
    .poll(() => header.evaluate((element) => element.scrollWidth === element.clientWidth))
    .toBe(true);
}

/** Every option has to sit inside the dialog, which is `overflow-hidden`: an
 *  option past its edge is not scrollable into view, it is simply gone. */
async function expectOptionsInsideDialog(dialog: Locator, view: Locator): Promise<void> {
  const dialogBox = await settledBox(dialog);
  const options = view.getByRole('radio');
  const count = await options.count();
  expect(count).toBeGreaterThan(0);

  for (let index = 0; index < count; index += 1) {
    const optionBox = await options.nth(index).boundingBox();
    expect(optionBox).not.toBeNull();
    expect(optionBox!.x).toBeGreaterThanOrEqual(dialogBox.x - TOLERANCE);
    expect(optionBox!.y).toBeGreaterThanOrEqual(dialogBox.y - TOLERANCE);
    expect(optionBox!.x + optionBox!.width).toBeLessThanOrEqual(
      dialogBox.x + dialogBox.width + TOLERANCE,
    );
    expect(optionBox!.y + optionBox!.height).toBeLessThanOrEqual(
      dialogBox.y + dialogBox.height + TOLERANCE,
    );
  }
}

test.describe('skills picker header on a phone', () => {
  test.use({ viewport: devices['Pixel 7'].viewport, hasTouch: true });

  test('@scenario:skills-picker-header-splits-on-a-phone-viewport splits the skills header into two rows on a phone', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const dialog = await openSkillsPicker(page);
    const { header, view, create, filter } = headerParts(dialog);
    const row = view.locator('..');
    const dialogBox = await settledBox(dialog);
    const viewBox = await settledBox(view);
    const createBox = await settledBox(create);
    const filterBox = await settledBox(filter);
    const rowBox = await settledBox(row);

    expect(Math.abs(viewBox.y - createBox.y)).toBeLessThanOrEqual(TOLERANCE);
    expect(createBox.x).toBeGreaterThan(viewBox.x);
    expect(createBox.x + createBox.width).toBeLessThanOrEqual(
      dialogBox.x + dialogBox.width + TOLERANCE,
    );
    /** `ml-auto` puts the create button on the row's right edge. */
    expect(Math.abs(createBox.x + createBox.width - (rowBox.x + rowBox.width))).toBeLessThanOrEqual(
      TOLERANCE,
    );
    expect(filterBox.y).toBeGreaterThan(viewBox.y + viewBox.height);
    expect(Math.abs(filterBox.x - rowBox.x)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(filterBox.x + filterBox.width - (rowBox.x + rowBox.width))).toBeLessThanOrEqual(
      TOLERANCE,
    );

    /** DOM order is tab order, so it has to read the way this layout does:
     *  radio, then create, then the field on the line below. */
    await view.getByRole('radio', { name: 'All', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(create).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(filter).toBeFocused();
    await expectNoHeaderOverflow(header);
  });
});

test.describe('skills picker view options at narrow widths', () => {
  test.use({ viewport: { width: 320, height: 800 }, hasTouch: true });

  test('@scenario:skills-picker-view-options-stay-reachable-at-320px keeps every wrapped view option reachable at narrow widths', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const dialog = await openSkillsPicker(page);
    const { header, view } = headerParts(dialog);

    await expectOptionsInsideDialog(dialog, view);
    await expectNoHeaderOverflow(header);

    /** Narrower than the group's own 261px minimum, so the segments have to flow
     *  onto a second row rather than run past the dialog. */
    await page.setViewportSize({ width: 280, height: 800 });
    await expect(dialog).toBeVisible();
    await expectOptionsInsideDialog(dialog, view);
    await expectNoHeaderOverflow(header);

    const favorites = view.getByRole('radio', { name: 'Favorites', exact: true });
    await favorites.click();
    await expect(favorites).toHaveAttribute('aria-checked', 'true');
    await expect(
      dialog.getByText("You haven't favorited anything yet", { exact: true }),
    ).toBeVisible();

    /** The moving indicator has to follow the checked segment onto the second
     *  row: it reproduced `inset-y-1` by assuming the group had no vertical
     *  padding, which left it 8px short of a padded group's segment. */
    const indicator = view.locator(':scope > div').first();
    await expect(indicator).toBeVisible();
    await expect
      .poll(async () => {
        const indicatorBox = await indicator.boundingBox();
        const checkedBox = await favorites.boundingBox();
        if (!indicatorBox || !checkedBox) {
          return false;
        }
        return (
          Math.abs(indicatorBox.x - checkedBox.x) <= TOLERANCE &&
          Math.abs(indicatorBox.y - checkedBox.y) <= TOLERANCE &&
          Math.abs(indicatorBox.width - checkedBox.width) <= TOLERANCE &&
          Math.abs(indicatorBox.height - checkedBox.height) <= TOLERANCE
        );
      })
      .toBe(true);
  });
});

/** The point of this one is that the rearrangement did not reach desktop, so it
 *  pins a desktop context instead of inheriting the run's project. */
test.describe('skills picker header on a desktop viewport', () => {
  test.use({ viewport: { width: 1280, height: 860 }, hasTouch: false, isMobile: false });

  test('@scenario:skills-picker-header-is-one-row-on-desktop keeps desktop header controls on one row', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const dialog = await openSkillsPicker(page);
    const { view, create, filter } = headerParts(dialog);
    const createBox = await settledBox(create);
    const filterBox = await settledBox(filter);
    const viewBox = await settledBox(view);

    expect(Math.abs(createBox.y - filterBox.y)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(filterBox.y - viewBox.y)).toBeLessThanOrEqual(TOLERANCE);
    expect(createBox.x).toBeLessThan(filterBox.x);
    expect(filterBox.x).toBeLessThan(viewBox.x);
    expect(filterBox.width).toBeGreaterThan(createBox.width);
    expect(filterBox.width).toBeGreaterThan(viewBox.width);

    /** Tab order follows the eye here too: create, then the field, then the radio.
     *  A visual-only reorder left desktop tabbing from the rightmost radio back to
     *  the create button. */
    await create.focus();
    await page.keyboard.press('Tab');
    await expect(filter).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(view.getByRole('radio', { name: 'All', exact: true })).toBeFocused();
  });
});
