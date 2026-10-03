import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
} from '../db';
import { openAgentBuilder, selectMockModel } from '../agents.helpers';
import { NEW_CHAT_PATH, messagesView } from '../helpers';
import { getE2EUser } from '../../../setup/user';

/**
 * Three literals outlived the theme sweep: the Agent Builder's provider chip
 * was always white on black, the artifact sheet's phone backdrop was always
 * black, and the artifact refresh veil was always black at 70%. Each now paints
 * a role, so a theme decides them. These scenarios read the computed paint of
 * each element, first against the role as the bundled palette resolves it and
 * then under a definition whose triples no bundled palette holds, which only
 * the role can deliver.
 */

const THEME_PARAM = 'e2eThemeMode';
const ROOT_PARENT = '00000000-0000-0000-0000-000000000000';
const ARTIFACT_TITLE = 'Overlay roles';
const ARTIFACT_TEXT = [
  `:::artifact{identifier="e2e-overlay-roles" type="text/html" title="${ARTIFACT_TITLE}"}`,
  '<main><h1>Overlay roles</h1></main>',
  ':::',
].join('\n');

/** No bundled palette holds these triples, so only the definition can produce them. */
const REFERENCE_COLORS = {
  'rgb-surface-primary': '12 34 56',
  'rgb-text-primary': '201 202 203',
  'rgb-surface-overlay': '40 50 60',
  'rgb-surface-media-overlay': '10 20 30',
};
const REFERENCE_THEME = {
  version: 1,
  name: 'e2e-theme-sweep-roles',
  modes: { light: { colors: REFERENCE_COLORS }, dark: { colors: REFERENCE_COLORS } },
} as const;

type Paint = { background: string; color: string; roles: Record<string, string> };

/** Same bridge as `dialog-scrim-role`: the mode rides in the URL, the definition in storage. */
async function installThemeBridge(page: Page, definition?: unknown) {
  await page.addInitScript((stored) => {
    const mode = new URL(location.href).searchParams.get('e2eThemeMode');
    if (mode) {
      localStorage.setItem('color-theme', mode);
    }
    localStorage.removeItem('theme-colors');
    localStorage.removeItem('theme-name');
    if (stored) {
      localStorage.setItem('theme-definition', JSON.stringify(stored));
      localStorage.setItem('theme-source', 'definition');
    } else {
      localStorage.removeItem('theme-definition');
      localStorage.removeItem('theme-source');
    }
  }, definition ?? null);
}

/** The project's own scheme, so each project checks the palette it renders. */
const projectMode = (): 'light' | 'dark' =>
  test.info().project.use.colorScheme === 'dark' ? 'dark' : 'light';

/**
 * The element's paint and each role triple as the element sees it, all rounded
 * through a canvas: Tailwind 4 serializes alpha utilities as `oklab()`, and the
 * canvas gives back the sRGB channels either spelling describes.
 */
async function readPaint(target: Locator, roles: string[]): Promise<Paint> {
  return target.evaluate((element, names) => {
    const brush = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!brush) {
      throw new Error('the color-normalizing canvas has no 2d context');
    }
    const normalize = (css: string) => {
      brush.clearRect(0, 0, 1, 1);
      brush.fillStyle = css;
      brush.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = brush.getImageData(0, 0, 1, 1).data;
      const alpha = Math.round((a / 255) * 100) / 100;
      return alpha === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };
    const style = getComputedStyle(element);
    const resolved: Record<string, string> = {};
    for (const name of names) {
      resolved[name] = normalize(`rgb(${style.getPropertyValue(`--${name}`).trim()})`);
    }
    return {
      background: normalize(style.backgroundColor),
      color: normalize(style.color),
      roles: resolved,
    };
  }, roles);
}

const withAlpha = (rgb: string, alpha: number) =>
  rgb.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);

async function showProviderChip(page: Page, mode: string): Promise<Locator> {
  await page.goto(`${NEW_CHAT_PATH}?${THEME_PARAM}=${mode}`, { timeout: 15000 });
  await openAgentBuilder(page, { navigate: false });
  await selectMockModel(page, true);
  const chip = page.locator('#provider').locator('div.rounded-full').first();
  await expect(chip).toBeVisible();
  return chip;
}

async function openArtifact(page: Page, conversationId: string, mode: string) {
  await page.goto(`/c/${conversationId}?${THEME_PARAM}=${mode}`, { timeout: 15000 });
  await messagesView(page).locator('[data-artifact-trigger]').first().click();
  const panel = page.locator('#artifact-viewer');
  await expect(panel).toBeVisible({ timeout: 15000 });
  /** Always mounted, transparent and `aria-hidden` until a refresh runs. */
  const veil = panel.locator('div.absolute.inset-0[role="status"]');
  await expect(veil).toHaveCount(1);
  /** Phone only: the backdrop is the panel's preceding sibling. */
  const backdrop = page.locator('#artifact-viewer').locator('xpath=preceding-sibling::div[1]');
  return { veil, backdrop };
}

test.describe('theme sweep roles', () => {
  test('the agent provider chip paints surface and text primary @scenario:agent-provider-chip-role', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const mode = projectMode();
    await installThemeBridge(page);

    const bundled = await readPaint(await showProviderChip(page, mode), [
      'surface-primary',
      'text-primary',
    ]);
    expect(bundled.background).toBe(bundled.roles['surface-primary']);
    expect(bundled.color).toBe(bundled.roles['text-primary']);

    /** Registered later, so it runs after the first bridge and wins. */
    await installThemeBridge(page, REFERENCE_THEME);
    const chip = await showProviderChip(page, mode);
    await expect(page.locator('html')).toHaveAttribute('data-theme', REFERENCE_THEME.name);
    const themed = await readPaint(chip, []);
    expect(themed.background).toBe('rgb(12, 34, 56)');
    expect(themed.color).toBe('rgb(201, 202, 203)');
  });

  test('the artifact refresh veil and phone backdrop paint overlay roles @scenario:artifact-overlay-roles', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120000);
    const mode = projectMode();
    const isMobile = testInfo.project.use.isMobile === true;
    const conversationId = randomUUID();
    const email = getE2EUser().email;
    await seedConversations(email, [
      { conversationId, title: ARTIFACT_TITLE, updatedAt: new Date() },
    ]);
    await seedMessages(email, conversationId, [
      {
        messageId: randomUUID(),
        parentMessageId: ROOT_PARENT,
        text: ARTIFACT_TEXT,
        isCreatedByUser: false,
        sender: 'Assistant',
        model: 'mock-model-a',
      },
    ]);

    try {
      await installThemeBridge(page);
      let { veil, backdrop } = await openArtifact(page, conversationId, mode);
      const roles = ['surface-media-overlay', 'surface-overlay'];
      const bundledVeil = await readPaint(veil, roles);
      expect(bundledVeil.background).toBe(
        withAlpha(bundledVeil.roles['surface-media-overlay'], 0.7),
      );
      expect(bundledVeil.background).toBe('rgba(0, 0, 0, 0.7)');
      if (isMobile) {
        const bundledBackdrop = await readPaint(backdrop, roles);
        expect(bundledBackdrop.background).toBe(bundledBackdrop.roles['surface-overlay']);
      }

      await installThemeBridge(page, REFERENCE_THEME);
      ({ veil, backdrop } = await openArtifact(page, conversationId, mode));
      await expect(page.locator('html')).toHaveAttribute('data-theme', REFERENCE_THEME.name);
      expect((await readPaint(veil, [])).background).toBe('rgba(10, 20, 30, 0.7)');
      if (isMobile) {
        /** Its class carries no alpha; the fade is the inline `opacity`. */
        expect((await readPaint(backdrop, [])).background).toBe('rgb(40, 50, 60)');
      } else {
        /** The desktop rail mounts no backdrop at all. */
        await expect(page.locator('* + #artifact-viewer')).toHaveCount(0);
      }
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });
});
