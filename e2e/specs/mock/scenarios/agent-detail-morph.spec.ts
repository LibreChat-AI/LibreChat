import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { cleanupAgent, uniqueAgentName, waitForPersistedAgent } from '../agents.helpers';
import { getAccessToken, MOCK_ENDPOINTS, NEW_CHAT_PATH, requestJson } from '../helpers';

/**
 * `DIALOG_SCRIM_CLASS` in `packages/client/src/components/OriginalDialog.tsx`: the
 * one class OGDialog's overlay and the morph's own backdrop both carry, which is
 * what lets the count below tell a shared scrim from a second one.
 */
const SCRIM_CLASS = 'bg-scrim';

type CreatedAgent = {
  id: string;
  name: string;
};

const createAgent = async (
  page: Page,
  prefix: string,
  description: string,
  conversationStarters: string[] = [],
): Promise<CreatedAgent> => {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  const token = await getAccessToken(page);
  const name = uniqueAgentName(prefix);
  const agent = await requestJson<CreatedAgent>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description,
      instructions: 'Use the mock model and answer deterministically for this scenario.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      model_parameters: {},
      tools: [],
      conversation_starters: conversationStarters,
      category: 'general',
    },
  });
  await waitForPersistedAgent(page, name, description);
  return { id: agent.id, name };
};

const openAgent = async (page: Page, agentName: string) => {
  await page.goto(`/agents/all?q=${encodeURIComponent(agentName)}`, { timeout: 10000 });
  const trigger = page.getByRole('button', { name: agentName, exact: true });
  await expect(trigger).toBeVisible({ timeout: 30000 });
  return trigger;
};

/** Overrides the theme token the way a stored or reference theme does, on the root. */
const setSurfaceRadius = async (page: Page, radius: string) => {
  await page.evaluate((value) => {
    document.documentElement.style.setProperty('--theme-surface-radius', value);
  }, radius);
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--theme-surface-radius').trim(),
    ),
  ).toBe(radius);
};

const readBorderRadius = (locator: Locator) =>
  locator.evaluate((element) => getComputedStyle(element).borderRadius);

test.describe('agent detail morph', () => {
  test('@scenario:card-expands-into-its-detail-dialog card expansion preserves the agent details', async ({
    page,
  }) => {
    const description = 'A detail morph scenario description that is visible on both surfaces.';
    let agentId: string | undefined;

    try {
      const agent = await createAgent(page, 'E2E Morph Detail', description);
      agentId = agent.id;
      const trigger = await openAgent(page, agent.name);
      await expect(trigger.locator('xpath=..')).toContainText('View details');
      await expect(trigger.locator('xpath=..')).toContainText(description);

      await trigger.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('heading', { name: agent.name, exact: true })).toBeVisible();
      /* The dialog is handed the card's own paragraph, and the word morph paints that
         copy as per-word spans beside one screen-reader copy of the same text — so the
         assertion is about the paragraph carrying the description, not about how many
         nodes spell it out. */
      const dialogDescription = dialog.locator('p').filter({ hasText: description });
      await expect(dialogDescription).toHaveCount(1);
      await expect(dialogDescription).toBeVisible();
      await expect(dialogDescription).toContainText(description);

      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('button', { name: agent.name, exact: true })).toBeVisible();
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('@scenario:escape-returns-focus-to-the-card Escape closes the detail dialog and restores the card focus', async ({
    page,
  }) => {
    const description = 'Keyboard focus should return to this card after Escape closes its dialog.';
    let agentId: string | undefined;

    try {
      const agent = await createAgent(page, 'E2E Morph Escape', description);
      agentId = agent.id;
      const trigger = await openAgent(page, agent.name);
      await trigger.focus();
      await expect(trigger).toBeFocused();

      await trigger.press('Enter');
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      /* The dialog takes focus once its open morph has handed the surface over; pressing
         Escape before that lands on the grid behind it and leaves the dialog open. */
      await expect
        .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
        .toBe(true);

      await dialog.press('Escape');
      await expect(dialog).toBeHidden({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: agent.name, exact: true })).toBeFocused();
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('@scenario:morph-dims-the-page-with-one-scrim the morph uses exactly one shared scrim throughout the animation', async ({
    page,
  }) => {
    const description = 'The expanding card should dim the marketplace with one shared scrim.';
    let agentId: string | undefined;

    try {
      const agent = await createAgent(page, 'E2E Morph Scrim', description);
      agentId = agent.id;
      const trigger = await openAgent(page, agent.name);
      await trigger.click();
      await expect(page.getByRole('dialog')).toBeVisible();

      const samples = await page.evaluate(async (scrimClass) => {
        const frames: Array<{ sharedScrims: number; otherDimViewportLayers: number }> = [];
        const isFullViewport = (element: HTMLElement) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.left <= 0 &&
            rect.top <= 0 &&
            rect.right >= window.innerWidth &&
            rect.bottom >= window.innerHeight
          );
        };
        /**
         * A second dim, whatever colour it paints. Keyed on alpha rather than on
         * black channels because the scrim role resolves to a gray in the light
         * theme, so a colour test would only ever catch a duplicate in the dark one.
         */
        const isDim = (element: HTMLElement) => {
          const background = getComputedStyle(element).backgroundColor;
          const match = background.match(/^rgba?\(([^)]+)\)$/);
          if (!match) {
            return false;
          }
          const channels = match[1].split(',').map((channel) => channel.trim());
          const alpha = channels.length === 4 ? Number.parseFloat(channels[3]) : 1;
          return alpha >= 0.3 && alpha < 1;
        };

        for (let frame = 0; frame < 24; frame++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const elements = Array.from(document.querySelectorAll<HTMLElement>('*'));
          const sharedScrims = elements.filter((element) => element.classList.contains(scrimClass));
          const otherDimViewportLayers = elements.filter(
            (element) =>
              !element.classList.contains(scrimClass) && isFullViewport(element) && isDim(element),
          );
          frames.push({
            sharedScrims: sharedScrims.length,
            otherDimViewportLayers: otherDimViewportLayers.length,
          });
        }
        return frames;
      }, SCRIM_CLASS);

      expect(samples.length).toBeGreaterThan(0);
      for (const sample of samples) {
        expect(sample.sharedScrims).toBe(1);
        expect(sample.otherDimViewportLayers).toBe(0);
      }
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('@scenario:card-and-dialog-follow-the-surface-radius card and dialog surfaces track the theme radius', async ({
    page,
  }) => {
    const description = 'The card and dialog should share the configured surface radius.';
    const initialRadius = '2px';
    const changedRadius = '11px';
    let agentId: string | undefined;
    let originalRadius = '';

    try {
      const agent = await createAgent(page, 'E2E Morph Radius', description);
      agentId = agent.id;
      const trigger = await openAgent(page, agent.name);
      const cardSurface = trigger.locator('xpath=..');
      originalRadius = await page.evaluate(() =>
        document.documentElement.style.getPropertyValue('--theme-surface-radius'),
      );

      await setSurfaceRadius(page, initialRadius);
      await expect.poll(() => readBorderRadius(cardSurface)).toBe(initialRadius);

      await trigger.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const dialogSurface = dialog.locator('div.rounded-theme-surface').first();
      await expect.poll(() => readBorderRadius(dialogSurface)).toBe(initialRadius);

      /* A morph resolves the token to a number once and animates that number
         (`client/src/components/Agents/morph.ts`), so a theme changed mid-flight is picked
         up by the next open rather than repainting a corner that is in motion. */
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await setSurfaceRadius(page, changedRadius);
      await expect.poll(() => readBorderRadius(cardSurface)).toBe(changedRadius);

      await trigger.click();
      await expect(dialog).toBeVisible();
      await expect
        .poll(() => readBorderRadius(dialog.locator('div.rounded-theme-surface').first()))
        .toBe(changedRadius);
    } finally {
      await page.evaluate((radius) => {
        if (radius) {
          document.documentElement.style.setProperty('--theme-surface-radius', radius);
        } else {
          document.documentElement.style.removeProperty('--theme-surface-radius');
        }
      }, originalRadius);
      await cleanupAgent(page, agentId);
    }
  });

  test('@scenario:dialog-controls-share-one-corner-radius conversation starters match the dialog action controls', async ({
    page,
  }) => {
    const description = 'The dialog controls should use one consistent corner radius.';
    const starters = ['Ask the first scenario question', 'Ask the second scenario question'];
    let agentId: string | undefined;

    try {
      const agent = await createAgent(page, 'E2E Morph Controls', description, starters);
      agentId = agent.id;
      const trigger = await openAgent(page, agent.name);
      await trigger.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();

      const starterButtons = starters.map((starter) =>
        dialog.getByRole('button', { name: starter, exact: true }),
      );
      for (const starterButton of starterButtons) {
        await expect(starterButton).toBeVisible();
      }
      const favouriteButton = dialog.locator('button[aria-pressed]').first();
      const startChatButton = dialog.getByRole('button', { name: /start chat/i });
      await expect(favouriteButton).toBeVisible();
      await expect(startChatButton).toBeVisible();

      const actionRadius = await readBorderRadius(favouriteButton);
      await expect.poll(() => readBorderRadius(startChatButton)).toBe(actionRadius);
      // This guards the removal of the hard-coded rounded-xl from starter buttons.
      for (const starterButton of starterButtons) {
        await expect.poll(() => readBorderRadius(starterButton)).toBe(actionRadius);
      }
    } finally {
      await cleanupAgent(page, agentId);
    }
  });
});
