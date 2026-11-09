import { expect, test } from '@playwright/test';
import type { TConversationTag } from 'librechat-data-provider';
import type { Locator, Page } from '@playwright/test';
import { uniqueName } from '../helpers';
import { openPanel } from './panels';

/** The disclosure from LibreChat-AI/LibreChat#17913, long enough to wrap at every width below. */
const DISCLOSURE =
  'Custom MCP connectors are not verified by this application. Third-party MCP servers may receive and process conversation content and other data used with their tools under their own privacy practices. Only connect to servers you trust.';

const LONG_URL = `https://example.com/${'privacy-'.repeat(4)}${'a'.repeat(160)}`;

/** Phone through desktop: a line that breaks inside a word at any of these is the bug. */
const WIDTHS = [360, 414, 600, 1024];

/** Serves the startup config with a deployment's own trust checkbox sub-label. */
async function serveSubLabel(page: Page, subLabel: string): Promise<void> {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    await route.fulfill({
      response,
      json: {
        ...config,
        interface: {
          ...config.interface,
          mcpServers: {
            ...config.interface?.mcpServers,
            trustCheckbox: { ...config.interface?.mcpServers?.trustCheckbox, subLabel },
          },
        },
      },
    });
  });
}

async function openAddServerDialog(page: Page): Promise<Locator> {
  await page.goto('/c/new');
  await openPanel(page, 'mcp-builder', 'MCP Settings');
  await page.getByRole('button', { name: 'Add MCP', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add MCP Server' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * The words under `scope` whose glyphs sit on more than one line. Each run of
 * non-space characters is measured as a DOM range, so a word the browser split
 * reports one client rect per line it occupies.
 */
function wordsSplitAcrossLines(scope: Locator): Promise<string[]> {
  return scope.evaluate((root) => {
    const split: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const match of (node.textContent ?? '').matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const tops = new Set(
          Array.from(range.getClientRects())
            .filter((rect) => rect.width > 0)
            .map((rect) => Math.round(rect.top)),
        );
        if (tops.size > 1) {
          split.push(match[0]);
        }
      }
    }
    return split;
  });
}

/** Whether every glyph of `text` inside `scope` lies within `container`'s box. */
async function textStaysInside(scope: Locator, text: string, container: Locator): Promise<boolean> {
  const bounds = await container.boundingBox();
  const rects = await scope.evaluate((root, needle) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = (node.textContent ?? '').indexOf(needle);
      if (start === -1) {
        continue;
      }
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + needle.length);
      return Array.from(range.getClientRects()).map(({ left, right }) => ({ left, right }));
    }
    return [];
  }, text);
  if (!bounds || rects.length === 0) {
    return false;
  }
  return rects.every(
    ({ left, right }) => left >= bounds.x - 1 && right <= bounds.x + bounds.width + 1,
  );
}

test.describe('prose wraps between words', () => {
  test('@scenario:mcp-trust-disclosure-wraps-between-words a long trust disclosure in the Add MCP Server dialog never breaks inside a word', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await serveSubLabel(page, DISCLOSURE);
    const dialog = await openAddServerDialog(page);
    const description = dialog.locator('#trust-description');
    await expect(description).toHaveText(DISCLOSURE);

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await description.scrollIntoViewIfNeeded();
      expect(await wordsSplitAcrossLines(description), `split words at ${width}px`).toEqual([]);
    }
  });

  test('@scenario:mcp-trust-disclosure-contains-long-url an unbroken URL in the trust disclosure wraps inside the dialog', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await serveSubLabel(page, `Read the policy at ${LONG_URL} before you connect.`);
    const dialog = await openAddServerDialog(page);
    const description = dialog.locator('#trust-description');
    await expect(description).toContainText(LONG_URL);

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await description.scrollIntoViewIfNeeded();
      expect(await textStaysInside(description, LONG_URL, dialog), `URL at ${width}px`).toBe(true);
      expect(await wordsSplitAcrossLines(description), `split words at ${width}px`).toEqual([
        LONG_URL,
      ]);
    }
  });

  test('@scenario:bookmark-delete-name-wraps-between-words a multi-word bookmark name in the delete confirmation wraps on its spaces, and an unbroken one stays inside the dialog', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const spaced = `${uniqueName('Quarterly')} roadmap planning notes for the platform and infrastructure team`;
    const unbroken = `${uniqueName('archive')}-${'x'.repeat(120)}`;
    const tag = (name: string, position: number): TConversationTag => ({
      _id: `wrap-fixture-${position}`,
      user: 'wrap-fixture-user',
      tag: name,
      description: '',
      count: 0,
      position,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    });
    await page.route('**/api/tags', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: [tag(spaced, 0), tag(unbroken, 1)] })
        : route.continue(),
    );

    await page.setViewportSize({ width: 360, height: 900 });
    await page.goto('/c/new');
    await openPanel(page, 'bookmarks', 'Bookmarks');

    for (const [name, expectedSplit] of [
      [spaced, []],
      [unbroken, [unbroken]],
    ] as const) {
      const row = page.getByRole('listitem').filter({ hasText: name });
      await row.getByRole('button', { name: 'Delete Bookmark', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Delete Bookmark' });
      await expect(dialog).toBeVisible();
      const strong = dialog.locator('strong', { hasText: name });
      await expect(strong).toBeVisible();

      expect(await wordsSplitAcrossLines(strong)).toEqual(expectedSplit);
      expect(await textStaysInside(strong, name, dialog)).toBe(true);

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
  });
});
