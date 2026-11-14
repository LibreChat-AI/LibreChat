import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';
import { openAgentBuilder, selectMockModel } from '../agents.helpers';
import { probeStyle } from './style.helpers';

/**
 * The Agent Builder, Tools and Skills panels after they moved onto the shared pieces: the empty
 * state, tooltip buttons in place of native titles, the card choice, the reserved scrollbar band
 * and the one-turn spin on the reset icon.
 */

/** Tooltips open on a pointer that hovers, and the panels sit in the desktop rail. */
test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false });

async function openToolLibrary(page: Page) {
  const form = await openAgentBuilder(page);
  await form.getByRole('button', { name: 'Add tools' }).click();
  const library = page.getByRole('dialog', { name: 'Tool Library' });
  await expect(library).toBeVisible();
  return library;
}

test('an empty Skills panel shows the shared empty state @scenario:skills-panel-shows-the-shared-empty-state', async ({
  page,
}) => {
  await page.route(
    (url) => url.pathname === '/api/skills',
    (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: { skills: [], has_more: false, after: null } })
        : route.continue(),
  );
  await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
  await page.getByRole('button', { name: 'Skills', exact: true }).first().click();

  const panel = page.getByRole('complementary', { name: 'Control Panel' });
  await expect(panel.getByText('No skills yet', { exact: true })).toBeVisible();
  await expect(
    panel.getByText('Add a skill to give your agent reusable instructions.'),
  ).toBeVisible();
});

test('tool card actions show a tooltip instead of a native title @scenario:tool-card-actions-show-a-tooltip-instead-of-a-title', async ({
  page,
}) => {
  const library = await openToolLibrary(page);
  const card = library.getByRole('listitem').first();
  await card.hover();
  const action = card.getByRole('button', { name: /^(Configure|Tool details)$/ });
  await expect(action).toBeVisible();
  await expect(action).not.toHaveAttribute('title', /.+/);

  const name = (await action.getAttribute('aria-label')) ?? '';
  await action.hover();
  await expect(page.getByRole('tooltip').filter({ hasText: name })).toBeVisible();
});

test('the Memory tool offers where memories are kept as two cards @scenario:memory-tool-offers-its-scope-as-two-cards', async ({
  page,
}) => {
  const library = await openToolLibrary(page);
  const card = library
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: /^Memory/ }) });
  await card.hover();
  await card.getByRole('button', { name: /^(Configure|Tool details)$/ }).click();
  const dialog = page.getByRole('dialog').filter({ hasNotText: 'Tool Library' }).last();
  await expect(dialog).toBeVisible();

  const scope = dialog.getByRole('radiogroup');
  const shared = scope.getByRole('radio', { name: /Shared memory/ });
  const own = scope.getByRole('radio', { name: /This agent only/ });
  await expect(shared).toBeChecked();
  await expect(own).not.toBeChecked();
  /** The radio itself is visually hidden; the card around it is the target a person presses. */
  await scope.getByText('This agent only', { exact: true }).click();
  await expect(own).toBeChecked();
  await expect(shared).not.toBeChecked();
});

test('the builder column reserves its scrollbar band @scenario:builder-column-reserves-its-scrollbar-band', async ({
  page,
}) => {
  const form = await openAgentBuilder(page);
  const reserved = await probeStyle(page, 'scrollbar-gutter-stable', 'scrollbar-gutter');
  expect(reserved).toBe('stable');

  /** A scrolling ancestor of the form reserves the band, so the column keeps its width when the
   *  scrollbar appears as sections open. */
  const bands = await form.evaluate((element) => {
    const found: string[] = [];
    for (let node = element.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY)) {
        found.push(style.scrollbarGutter);
      }
    }
    return found;
  });
  expect(bands).toContain(reserved);
});

test('pressing Reset Model Parameters spins its icon once @scenario:reset-model-parameters-spins-its-icon-once', async ({
  page,
}) => {
  const form = await openAgentBuilder(page);
  await selectMockModel(page);

  const reset = form.getByRole('button', { name: 'Reset Model Parameters' });
  const animation = () =>
    reset.locator('svg').evaluate((icon) => {
      const style = getComputedStyle(icon);
      return { name: style.animationName, count: style.animationIterationCount };
    });
  expect((await animation()).name).toBe('none');

  await reset.click();
  expect(await animation()).toEqual({ name: 'reset-spin', count: '1' });

  /** The icon is replaced on every press, so each press plays the turn again. */
  await reset.click();
  expect((await animation()).name).toBe('reset-spin');
});
