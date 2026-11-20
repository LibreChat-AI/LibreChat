import { expect, test } from '@playwright/test';

const SERVER_NAME = 'e2e-memory';
const SERVER_TITLE = 'E2E Memory';
const FLOW_ID = 'e2e-user:e2e-memory';

/**
 * The QR backdrop stays white in every mode so the code scans, and it reads the `surface-qr`
 * role rather than a literal. The server logo tile needs a server icon, which the mock server
 * does not configure, so only the QR backdrop is asserted here.
 */
/** Set up through the MCP Settings panel that opens the OAuth dialog, which the mobile layout keeps in its drawer; the mobile project runs it at desktop size. */
test.use({ viewport: { width: 1280, height: 860 }, hasTouch: false, isMobile: false });

test('the OAuth QR backdrop stays white in every mode @scenario:mcp-oauth-qr-tile-stays-white', async ({
  page,
}) => {
  test.setTimeout(60000);

  await page.route('**/api/mcp/connection/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        oauthTimeout: 30000,
        connectionStatus: {
          [SERVER_NAME]: {
            connectionState: 'error',
            requiresOAuth: true,
            authorizationState: 'error',
          },
        },
      }),
    });
  });
  await page.route(`**/api/mcp/${SERVER_NAME}/reinitialize`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        message: 'OAuth authorization required',
        serverName: SERVER_NAME,
        oauthRequired: true,
        oauthUrl: 'https://oauth.example.test/authorize',
        flowId: FLOW_ID,
        oauthTimeout: 30000,
      }),
    });
  });
  await page.route('**/api/mcp/oauth/status/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'PENDING', completed: false, failed: false }),
    });
  });

  await page.goto('/c/new', { timeout: 10000 });
  const nav = page.getByRole('button', { name: 'MCP Settings' });
  if ((await nav.getAttribute('aria-pressed')) !== 'true') {
    await nav.click();
  }
  const card = page.getByLabel(new RegExp(`^${SERVER_TITLE} - `));
  await card.hover();
  await card.getByRole('button', { name: 'Connect', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: `Connect ${SERVER_NAME}`, exact: true });
  await expect(dialog).toBeVisible({ timeout: 10000 });
  await dialog.getByRole('button', { name: 'Show QR Code' }).click();

  const code = dialog.getByRole('img', { name: /QR/i }).first();
  await expect(code).toBeVisible();

  const paint = await code.evaluate((svg) => {
    const backdrop = svg.parentElement as HTMLElement;
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'rgb(var(--surface-qr))';
    document.body.appendChild(probe);
    const role = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { backdrop: getComputedStyle(backdrop).backgroundColor, role };
  });

  expect(paint.backdrop).toBe(paint.role);
  expect(paint.backdrop).toBe('rgb(255, 255, 255)');
});
