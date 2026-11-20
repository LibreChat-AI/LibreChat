import { once } from 'node:events';
import { createServer } from 'node:http';
import type { TStartupConfig, TConversationTag } from 'librechat-data-provider';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { uniqueName } from '../helpers';
import { openPanel } from './panels';

/** The disclosure from LibreChat-AI/LibreChat#17913, long enough to wrap at every width below. */
const DISCLOSURE =
  'Custom MCP connectors are not verified by this application. Third-party MCP servers may receive and process conversation content and other data used with their tools under their own privacy practices. Only connect to servers you trust.';

const UNBROKEN = 'a'.repeat(160);
const LONG_URL = `https://example.com/${'privacy-'.repeat(4)}${UNBROKEN}`;

/** Phone through desktop: a line that breaks inside a word at any of these is the bug. */
const WIDTHS = [360, 414, 600, 1024];

/** Reuses this test's fixed deployment config across viewport reloads, without mixing login states. */
async function serveSubLabel(page: Page, subLabel: string): Promise<void> {
  const configs = new Map<boolean, Promise<string>>();
  await page.route('**/api/config', async (route) => {
    const authenticated = Boolean(route.request().headers()['authorization']);
    let config = configs.get(authenticated);
    if (!config) {
      // Cache the promise too: startup can issue concurrent requests for the same login state.
      config = (async () => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        const body = (await response.json()) as TStartupConfig;
        return JSON.stringify({
          ...body,
          interface: {
            ...body.interface,
            mcpServers: {
              ...body.interface?.mcpServers,
              trustCheckbox: { ...body.interface?.mcpServers?.trustCheckbox, subLabel },
            },
          },
        });
      })();
      configs.set(authenticated, config);
    }
    await route.fulfill({ contentType: 'application/json', body: await config });
  });
}

/** Sizes the page first: crossing the mobile breakpoint with the dialog open closes it. */
async function openAddServerDialog(page: Page, width: number): Promise<Locator> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/c/new');
  await openPanel(page, 'mcp-builder', 'MCP Settings');
  await page.getByRole('button', { name: 'Add MCP', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add MCP Server' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * The words under `scope` whose glyphs sit on more than one line. Each run
 * between spaces, hyphens and slashes (where a line may legitimately break) is
 * measured as a DOM range, so a word the browser split reports one client rect
 * per line it occupies.
 */
function wordsSplitAcrossLines(scope: Locator): Promise<string[]> {
  return scope.evaluate((root) => {
    const split: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const match of (node.textContent ?? '').matchAll(/[^\s/-]+/g)) {
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
  test('@scenario:wrapping-config-reuses-deployment-snapshot coalesces config reads by login state across viewport reloads', async ({
    page,
  }) => {
    const reads = { anonymous: 0, authenticated: 0 };
    let resetConfigRequests = false;
    const server = createServer((req, res) => {
      if (req.url !== '/api/config') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>Wrapping config regression</title>');
        return;
      }
      const authenticated = Boolean(req.headers.authorization);
      reads[authenticated ? 'authenticated' : 'anonymous']++;
      if (resetConfigRequests) {
        req.socket.resetAndDestroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          appTitle: 'Wrapping fixture',
          interface: {
            modelSelect: authenticated,
            ...(authenticated
              ? { mcpServers: { use: true, trustCheckbox: { label: 'Trust this server' } } }
              : {}),
          },
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Wrapping config fixture did not bind a TCP port');
      }
      await page.goto(`http://127.0.0.1:${address.port}`);
      await serveSubLabel(page, DISCLOSURE);
      const readConfigs = () =>
        page.evaluate(async () => {
          const read = async (authenticated: boolean) => {
            const response = await fetch('/api/config', {
              headers: authenticated ? { Authorization: 'Bearer wrapping-fixture' } : {},
            });
            return response.json();
          };
          return Promise.all([read(false), read(false), read(true), read(true)]);
        });
      const [anonymous, duplicateAnonymous, authenticated, duplicateAuthenticated] =
        await readConfigs();
      expect(reads).toEqual({ anonymous: 1, authenticated: 1 });
      expect(anonymous).toEqual({
        appTitle: 'Wrapping fixture',
        interface: {
          modelSelect: false,
          mcpServers: { trustCheckbox: { subLabel: DISCLOSURE } },
        },
      });
      expect(authenticated).toEqual({
        appTitle: 'Wrapping fixture',
        interface: {
          modelSelect: true,
          mcpServers: {
            use: true,
            trustCheckbox: { label: 'Trust this server', subLabel: DISCLOSURE },
          },
        },
      });
      expect(duplicateAnonymous).toEqual(anonymous);
      expect(duplicateAuthenticated).toEqual(authenticated);

      // Any redundant upstream config request now resets instead of returning a fixture.
      resetConfigRequests = true;
      server.closeAllConnections();
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.reload();
        expect(await readConfigs()).toEqual([anonymous, anonymous, authenticated, authenticated]);
      }
      expect(reads).toEqual({ anonymous: 1, authenticated: 1 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('@scenario:mcp-trust-disclosure-wraps-between-words a long trust disclosure in the Add MCP Server dialog never breaks inside a word', async ({
    page,
  }) => {
    test.setTimeout(240000);
    await serveSubLabel(page, DISCLOSURE);

    for (const width of WIDTHS) {
      const dialog = await openAddServerDialog(page, width);
      const description = dialog.locator('#trust-description');
      await expect(description).toHaveText(DISCLOSURE);
      await description.scrollIntoViewIfNeeded();
      expect(await wordsSplitAcrossLines(description), `split words at ${width}px`).toEqual([]);
    }
  });

  test('@scenario:mcp-trust-disclosure-contains-long-url an unbroken URL in the trust disclosure wraps inside the dialog', async ({
    page,
  }) => {
    test.setTimeout(240000);
    await serveSubLabel(page, `Read the policy at ${LONG_URL} before you connect.`);

    for (const width of WIDTHS) {
      const dialog = await openAddServerDialog(page, width);
      const label = dialog.locator('label[for="trust"]');
      const description = dialog.locator('#trust-description');
      await expect(description).toContainText(LONG_URL);
      await description.scrollIntoViewIfNeeded();
      /** The run without a break opportunity is the only one allowed to split. */
      expect(await wordsSplitAcrossLines(description), `split words at ${width}px`).toEqual([
        UNBROKEN,
      ]);
      expect(await textStaysInside(description, LONG_URL, label), `URL at ${width}px`).toBe(true);
      expect(await textStaysInside(description, LONG_URL, dialog), `URL at ${width}px`).toBe(true);
    }
  });

  test('@scenario:bookmark-delete-name-wraps-between-words a multi-word bookmark name in the delete confirmation wraps on its spaces, and an unbroken one stays inside the dialog', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const spaced = `${uniqueName('Quarterly')} roadmap planning notes for the platform and infrastructure team, with the follow up items from every regional review meeting this autumn`;
    const run = 'x'.repeat(160);
    const unbroken = `${uniqueName('archive')}-${run}`;
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

    await page.goto('/c/new');
    await openPanel(page, 'bookmarks', 'Bookmarks');

    for (const [name, expectedSplit] of [
      [spaced, []],
      [unbroken, [run]],
    ] as const) {
      const row = page.getByRole('listitem').filter({ hasText: name });
      /** Row actions reveal on hover; the keyboard reaches them the way a user would. */
      await row.getByRole('button', { name: 'Delete Bookmark', exact: true }).focus();
      await page.keyboard.press('Enter');
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
