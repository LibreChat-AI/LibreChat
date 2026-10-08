import { expect, test } from '@playwright/test';
import type { Download } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';

async function downloadBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

test.describe('Mermaid artifact export menu', () => {
  test(
    'offers every Mermaid export format on both tabs ' +
      '@scenario:mermaid-export-menu-offers-every-format-on-both-tabs',
    async ({ page }) => {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

      const response = await sendMessage(page, 'E2E_MERMAID_ARTIFACT_REPLY');
      expect(response.ok()).toBeTruthy();

      const messages = messagesView(page);
      await expect(messages.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible();
      await messages.getByRole('button', { name: 'Open as artifact', exact: true }).click();

      /* The panel is a `region` on desktop and a `dialog` on mobile
       * (Artifacts.tsx:344), so address it by its stable id. */
      const panel = page.locator('#artifact-viewer');
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible();

      const exportButton = panel.getByRole('button', { name: 'Export diagram', exact: true });
      await expect(exportButton).toHaveCount(1);
      await expect(panel.getByRole('button', { name: /^Download / })).toHaveCount(0);

      await exportButton.click();
      const menu = page.getByRole('menu').last();
      await expect(
        menu.getByRole('menuitem', { name: 'Export as SVG', exact: true }),
      ).toBeEnabled();
      await expect(
        menu.getByRole('menuitem', { name: 'Export as PNG', exact: true }),
      ).toBeEnabled();
      await expect(
        menu.getByRole('menuitem', { name: 'Download source', exact: true }),
      ).toBeEnabled();
      await expect(menu.getByRole('menuitem')).toHaveCount(3);

      await exportButton.click();
      const codeTab = panel.getByRole('radio', { name: 'Code', exact: true });
      await codeTab.click();
      await expect(codeTab).toHaveAttribute('aria-checked', 'true');
      await expect(exportButton).toBeVisible();
      await exportButton.click();

      const codeMenu = page.getByRole('menu').last();
      await expect(
        codeMenu.getByRole('menuitem', { name: 'Export as SVG', exact: true }),
      ).toBeVisible();
      await expect(
        codeMenu.getByRole('menuitem', { name: 'Export as PNG', exact: true }),
      ).toBeVisible();
      const sourceItem = codeMenu.getByRole('menuitem', { name: 'Download source', exact: true });
      await expect(sourceItem).toBeEnabled();
      await expect(codeMenu.getByRole('menuitem')).toHaveCount(3);

      const [download] = await Promise.all([page.waitForEvent('download'), sourceItem.click()]);
      expect(download.suggestedFilename()).toMatch(/\.mmd$/);
      expect((await downloadBytes(download)).toString('utf8')).toContain('flowchart LR');
    },
  );
});
