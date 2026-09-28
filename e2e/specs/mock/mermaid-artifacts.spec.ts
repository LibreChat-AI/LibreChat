import { expect, test } from '@playwright/test';
import type { Download, Page, Request } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessage,
} from './helpers';

const isStartupConfigRequest = (request: Request) =>
  new URL(request.url()).pathname === '/api/config';

const isSandboxResourceRequest = (request: Request) => {
  if (request.resourceType() !== 'script') {
    return false;
  }

  const pathname = new URL(request.url()).pathname.toLowerCase();
  return pathname.includes('/sandboxartifacttabs.') || pathname.includes('/sandpack.');
};

const waitForForbiddenMermaidRequest = (page: Page) =>
  page
    .waitForRequest(
      (request) => isStartupConfigRequest(request) || isSandboxResourceRequest(request),
      { timeout: 1500 },
    )
    .then((request) => request.url())
    .catch(() => null);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_EXPORT_DIMENSION = 16_384;
const MAX_EXPORT_PIXELS = 16_777_216;
const REPEATED_PNG_EXPORTS = 5;

async function downloadBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

test.describe('Mermaid Artifact resource boundary', () => {
  test('opens Mermaid as an Artifact without startup config or Sandpack requests', async ({
    page,
  }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const response = await sendMessage(page, 'E2E_MERMAID_ARTIFACT_REPLY');
    expect(response.ok()).toBeTruthy();

    const messages = messagesView(page);
    await expect(messages.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible();

    const unexpectedRequest = waitForForbiddenMermaidRequest(page);
    await messages.getByRole('button', { name: 'Open as artifact', exact: true }).click();

    const panel = page.getByRole('region', { name: 'Mermaid diagram' });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible();
    const canvas = panel.getByTestId('mermaid-artifact-canvas');
    await expect(canvas).toHaveClass(/\bh-full\b/);
    await expect(canvas).toHaveClass(/\brounded-lg\b/);
    const panelBox = await panel.boundingBox();
    const canvasBox = await canvas.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(canvasBox).not.toBeNull();
    expect(canvasBox!.height).toBeGreaterThan(panelBox!.height * 0.75);
    await expect(panel.locator('iframe')).toHaveCount(0);
    const artifactRow = messages.locator('[data-artifact-trigger^="mermaid-artifact-"]');
    await expect(artifactRow).toHaveAttribute('aria-expanded', 'true');
    /* The trigger is an `ArtifactRow`: the diagram glyph rides the row's
     * glyph slot, tinted with the accent that marks a rendered preview. */
    await expect(artifactRow.locator('.lucide-workflow').locator('..')).toHaveClass(
      /\btext-status-info\b/,
    );

    expect(await unexpectedRequest).toBeNull();
  });

  test('keeps HTML Artifacts on the lazy Sandpack path', async ({ page }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const response = await sendMessage(page, 'E2E_HTML_ARTIFACT_REPLY');
    expect(response.ok()).toBeTruthy();

    const artifactButton = messagesView(page).getByRole('button', {
      name: 'E2E HTML Artifact HTML Opens as a rendered preview Click to open',
      exact: true,
    });
    await expect(artifactButton).toBeVisible();

    const sandpackRequest = page.waitForRequest(isSandboxResourceRequest, { timeout: 10000 });
    await artifactButton.click();

    await expect(page.getByRole('region', { name: 'E2E HTML Artifact' })).toBeVisible();
    expect((await sandpackRequest).resourceType()).toBe('script');
  });

  test('exports a Mermaid Artifact as valid SVG and PNG files', async ({ page }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const response = await sendMessage(page, 'E2E_MERMAID_ARTIFACT_REPLY');
    expect(response.ok()).toBeTruthy();

    const messages = messagesView(page);
    await expect(messages.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible();
    await messages.getByRole('button', { name: 'Open as artifact', exact: true }).click();

    const panel = page.getByRole('region', { name: 'Mermaid diagram' });
    await expect(panel.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible();

    const exportButton = panel.getByRole('button', { name: 'Export diagram' });
    await exportButton.click();
    const svgItem = page.getByRole('menuitem', { name: 'Export as SVG', exact: true });
    await expect(svgItem).toBeEnabled();

    const [svgDownload] = await Promise.all([page.waitForEvent('download'), svgItem.click()]);
    expect(svgDownload.suggestedFilename()).toBe('Mermaid diagram.svg');
    const svg = (await downloadBytes(svgDownload)).toString('utf8');
    expect(svg).toMatch(/<svg\b/);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('rx="8"');

    await exportButton.click();
    const pngItem = page.getByRole('menuitem', { name: 'Export as PNG', exact: true });
    await expect(pngItem).toBeEnabled();

    const [pngDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      pngItem.click(),
    ]);
    expect(pngDownload.suggestedFilename()).toBe('Mermaid diagram.png');
    const png = await downloadBytes(pngDownload);
    expect(png.length).toBeGreaterThan(24);
    expect(png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)).toBe(true);
    expect(png.readUInt32BE(16)).toBeGreaterThan(0);
    expect(png.readUInt32BE(20)).toBeGreaterThan(0);
    await expect(panel.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible();
  });

  test('repeatedly exports a large Mermaid Artifact without crashing the browser', async ({
    page,
  }, testInfo) => {
    testInfo.setTimeout(90_000);
    let didCrash = false;
    page.on('crash', () => {
      didCrash = true;
    });

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const response = await sendMessage(page, 'E2E_LARGE_MERMAID_ARTIFACT_REPLY');
    expect(response.ok()).toBeTruthy();

    const messages = messagesView(page);
    await expect(messages.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible();
    await messages.getByRole('button', { name: 'Open as artifact', exact: true }).click();

    const panel = page.getByRole('region', { name: 'Mermaid diagram' });
    const diagram = panel.getByRole('img', { name: 'Mermaid diagram' });
    await expect(diagram).toBeVisible();

    const exportButton = panel.getByRole('button', { name: 'Export diagram' });
    await exportButton.click();
    const svgItem = page.getByRole('menuitem', { name: 'Export as SVG', exact: true });
    const [svgDownload] = await Promise.all([page.waitForEvent('download'), svgItem.click()]);
    const svg = (await downloadBytes(svgDownload)).toString('utf8');
    expect(svg.length).toBeGreaterThan(100_000);
    expect(svg).toContain('Processing stage 179 with representative content');

    const pngItem = page.getByRole('menuitem', { name: 'Export as PNG', exact: true });
    for (let attempt = 0; attempt < REPEATED_PNG_EXPORTS; attempt++) {
      await exportButton.click();
      await expect(pngItem).toBeEnabled();
      const [pngDownload] = await Promise.all([
        page.waitForEvent('download', { timeout: 30_000 }),
        pngItem.click(),
      ]);
      expect(pngDownload.suggestedFilename()).toBe('Mermaid diagram.png');
      const png = await downloadBytes(pngDownload);
      expect(png.length).toBeGreaterThan(24);
      expect(png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)).toBe(true);
      const width = png.readUInt32BE(16);
      const height = png.readUInt32BE(20);
      expect(Math.max(width, height)).toBeLessThanOrEqual(MAX_EXPORT_DIMENSION);
      expect(width * height).toBeLessThanOrEqual(MAX_EXPORT_PIXELS);
      await expect(exportButton).not.toHaveAttribute('aria-busy', 'true');
      expect(didCrash).toBe(false);
      await expect(diagram).toBeVisible();
    }
  });
});
