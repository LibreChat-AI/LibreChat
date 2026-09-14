import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessage,
  sendMessageAndWaitForCompletion,
} from '../helpers';

/**
 * The artifacts pane can leave the side panel for a window of its own. The pane
 * stays in this tab's React tree and is portaled into that window, so these
 * scenarios are about what survives the move: the artifact itself, its styling,
 * its preview frame, its menus, and unsaved editor text.
 */

const UNDOCK = 'Open in new window';
const DOCK = 'Dock back to panel';
const HTML_ARTIFACT = 'E2E HTML Artifact';
const UNDOCKED_PANE = '#undocked-artifacts-root #artifact-viewer';

async function openHtmlArtifact(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const response = await sendMessage(page, 'E2E_HTML_ARTIFACT_REPLY');
  expect(response.ok()).toBeTruthy();

  await messagesView(page)
    .getByRole('button', { name: `${HTML_ARTIFACT} Click to open`, exact: true })
    .click();
  const panel = page.getByRole('region', { name: HTML_ARTIFACT });
  await expect(panel).toBeVisible();
  return panel;
}

async function undock(page: Page) {
  const panel = page.getByRole('region', { name: HTML_ARTIFACT });
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    panel.getByRole('button', { name: UNDOCK }).click(),
  ]);
  await expect(popup.locator(UNDOCKED_PANE)).toBeVisible({ timeout: 20000 });
  return popup;
}

/** The undock control is desktop-only: it is hidden below 868px. */
test.use({ viewport: { width: 1280, height: 800 } });

test.describe('undocked artifacts pane', () => {
  test('the pane moves into a window of its own @scenario:artifacts-pane-moves-into-its-own-window', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await openHtmlArtifact(page);

    const popup = await undock(page);

    await expect(popup.getByRole('region', { name: HTML_ARTIFACT })).toBeVisible();
    /* The conversation gets its column back: nothing of the pane is left here. */
    await expect(page.locator('#artifact-viewer')).toHaveCount(0);
    await expect(page.getByRole('region', { name: HTML_ARTIFACT })).toHaveCount(0);
  });

  test('the artifact renders in the window with the app styling @scenario:undocked-pane-renders-the-artifact-preview', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await openHtmlArtifact(page);

    const popup = await undock(page);
    const pane = popup.locator(UNDOCKED_PANE);

    /* A portal carries nodes, not the document that styled them: an unstyled
     * pane would render transparent and collapsed. The mirrored sheet is a
     * fetch, so the painted canvas is what settles, not what renders first. */
    await expect
      .poll(
        () =>
          pane.evaluate(
            (node) => node.ownerDocument.defaultView?.getComputedStyle(node).backgroundColor ?? '',
          ),
        { timeout: 15000 },
      )
      .not.toBe('rgba(0, 0, 0, 0)');
    const paneBox = await pane.boundingBox();
    expect(paneBox).not.toBeNull();
    expect(paneBox!.height).toBeGreaterThan(200);

    /* The preview lives in the window too, in its own frame. */
    await expect(pane.locator('iframe')).toHaveCount(1);
    await expect(popup.getByRole('button', { name: 'Refresh' })).toBeVisible();
  });

  test('docking back returns the pane to the side panel @scenario:undocked-pane-returns-to-the-side-panel', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await openHtmlArtifact(page);
    const popup = await undock(page);

    await popup.getByRole('button', { name: DOCK }).click();

    await expect(page.getByRole('region', { name: HTML_ARTIFACT })).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole('button', { name: UNDOCK })).toBeVisible();
    await expect.poll(() => popup.isClosed(), { timeout: 10000 }).toBe(true);
  });

  test('closing the window brings the pane home @scenario:closing-the-undocked-window-returns-the-pane', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await openHtmlArtifact(page);
    const popup = await undock(page);

    await popup.close();

    await expect(page.getByRole('region', { name: HTML_ARTIFACT })).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole('button', { name: UNDOCK })).toBeVisible();
  });

  test('docking hands focus to the control that replaces it @scenario:docking-returns-focus-to-the-pane-control', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await openHtmlArtifact(page);
    const popup = await undock(page);

    /* Keyboard path: the button pressed in the window disappears with it, so
     * the press resolves against a page that is already gone. */
    const dockButton = popup.getByRole('button', { name: DOCK });
    await dockButton.focus();
    const closed = popup.waitForEvent('close');
    await popup.keyboard.press('Enter').catch(() => undefined);
    await closed;

    const undockButton = page.getByRole('button', { name: UNDOCK });
    await expect(undockButton).toBeVisible({ timeout: 20000 });
    await expect(undockButton).toBeFocused();
  });

  test('undocking hands focus to the pane in its new window @scenario:undocking-moves-focus-into-the-window', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const panel = await openHtmlArtifact(page);

    /* Keyboard path: the control pressed here disappears with the docked
     * toolbar, so focus has to follow the pane rather than stay on an empty
     * document in the window that just opened. */
    const undockButton = panel.getByRole('button', { name: UNDOCK });
    await undockButton.focus();
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.keyboard.press('Enter')]);

    await expect(popup.locator(UNDOCKED_PANE)).toBeVisible({ timeout: 20000 });
    await expect(popup.getByRole('button', { name: DOCK })).toBeFocused();
  });

  test('unsaved editor text moves with the pane @scenario:unsaved-artifact-edits-survive-undocking', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await sendMessageAndWaitForCompletion(page, 'E2E_HTML_ARTIFACT_REPLY', { timeout: 60000 });

    await messagesView(page)
      .getByRole('button', { name: `${HTML_ARTIFACT} Click to open`, exact: true })
      .click();
    const panel = page.getByRole('region', { name: HTML_ARTIFACT });
    await expect(panel).toBeVisible();

    await panel.getByRole('radio', { name: 'Code' }).click();
    const editor = panel.locator('#artifacts-code .monaco-editor').first();
    await expect(editor).toBeVisible({ timeout: 30000 });
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type('<!-- undock-edit -->');
    await expect(panel.locator('#artifacts-code')).toContainText('undock-edit', {
      timeout: 15000,
    });

    const popup = await undock(page);

    /* Landing back on the preview would read as the edit having been lost. */
    await expect(popup.getByRole('radio', { name: 'Code' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(popup.locator(`${UNDOCKED_PANE} #artifacts-code`)).toContainText('undock-edit', {
      timeout: 30000,
    });
  });

  test('pane menus open in the window that owns them @scenario:undocked-pane-menus-open-in-its-own-window', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const response = await sendMessage(page, 'E2E_MERMAID_ARTIFACT_REPLY');
    expect(response.ok()).toBeTruthy();

    const messages = messagesView(page);
    await expect(messages.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible();
    await messages.getByRole('button', { name: 'Open as artifact', exact: true }).click();

    const panel = page.getByRole('region', { name: 'Mermaid diagram' });
    await expect(panel.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible();

    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      panel.getByRole('button', { name: UNDOCK }).click(),
    ]);
    const pane = popup.locator(UNDOCKED_PANE);
    await expect(pane).toBeVisible({ timeout: 20000 });
    await expect(pane.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible({
      timeout: 20000,
    });

    await popup.getByRole('button', { name: 'Export diagram' }).click();

    /* Radix portals default to the host document's body; the menu has to open
     * where the user clicked instead. */
    await expect(popup.getByRole('menuitem', { name: 'Export as SVG', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Export as SVG', exact: true })).toHaveCount(0);
  });

  test('a failure raised in the window is reported there @scenario:undocked-pane-reports-failures-in-its-own-window', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await openHtmlArtifact(page);
    const popup = await undock(page);

    /* Take both clipboard paths away inside the window, which is what a
     * non-secure context with a refused selection copy looks like. */
    await popup.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error('denied')) },
      });
      document.execCommand = () => false;
    });

    await popup.getByRole('button', { name: 'Copy' }).click();

    /* The app's toast viewport lives in the chat tab, which the user is not
     * looking at: the notice has to appear in the window they are. */
    await expect(popup.getByText('Failed to copy to clipboard')).toBeVisible({ timeout: 15000 });
  });

  /* The capability is a deployment choice, and a viewer must not be able to
   * act on it before the deployment has answered. */
  test('a deployment can keep the pane docked @scenario:a-deployment-can-turn-undocking-off', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.route('**/api/config', async (route) => {
      const response = await route.fetch();
      const config = await response.json();
      await route.fulfill({
        response,
        json: { ...config, interface: { ...config.interface, artifactUndocking: false } },
      });
    });

    const panel = await openHtmlArtifact(page);

    await expect(panel.getByRole('button', { name: 'Copy' })).toBeVisible();
    await expect(panel.getByRole('button', { name: UNDOCK })).toHaveCount(0);
  });
});

test.describe('artifacts sheet on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the sheet offers no undock action @scenario:mobile-artifacts-sheet-offers-no-undock-action', async ({
    page,
  }) => {
    test.setTimeout(90000);
    expect(page.viewportSize()?.width ?? 0).toBeLessThan(868);

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const response = await sendMessage(page, 'E2E_HTML_ARTIFACT_REPLY');
    expect(response.ok()).toBeTruthy();

    await messagesView(page)
      .getByRole('button', { name: `${HTML_ARTIFACT} Click to open`, exact: true })
      .click();

    const sheet = page.getByRole('dialog', { name: HTML_ARTIFACT });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: UNDOCK })).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: 'Close' })).toBeVisible();
  });
});
