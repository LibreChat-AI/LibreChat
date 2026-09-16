import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const SERVER_NAME = 'e2e-memory';
const SERVER_TITLE = 'E2E Memory';
const FLOW_ID = 'e2e-user:e2e-memory';

/** The MCP Builder panel card for the mock server, which owns Connect/Cancel. */
async function openMcpPanel(page: Page) {
  const nav = page.getByRole('button', { name: 'MCP Settings' });
  if ((await nav.getAttribute('aria-pressed')) !== 'true') {
    await nav.click();
  }
}
const serverCard = (page: Page) => page.getByLabel(new RegExp(`^${SERVER_TITLE} - `));

/** Selection state lives in the composer palette; open it fresh per check and
 *  close with Escape so the panel underneath stays interactable. */
const paletteOption = (page: Page) =>
  page
    .getByRole('dialog', { name: 'Attach and tools' })
    .getByRole('button', { name: new RegExp(`^${SERVER_TITLE}\\b`) });
async function expectSelected(page: Page, checked: 'true' | 'false') {
  await page.getByRole('button', { name: 'Attach and tools' }).click();
  await expect(paletteOption(page)).toHaveAttribute('aria-pressed', checked);
  await page.keyboard.press('Escape');
}

test.describe('MCP OAuth readiness', () => {
  test('keeps the server unselected until post-OAuth tool readiness completes', async ({
    page,
  }) => {
    test.setTimeout(120000);

    let reinitializeCalls = 0;
    let flowStatusCalls = 0;
    let readinessComplete = false;
    let markPendingPolled!: () => void;
    let markReadinessStarted!: () => void;
    let releaseReadiness!: () => void;
    const readinessStarted = new Promise<void>((resolve) => {
      markReadinessStarted = resolve;
    });
    const pendingPolled = new Promise<void>((resolve) => {
      markPendingPolled = resolve;
    });
    const readinessGate = new Promise<void>((resolve) => {
      releaseReadiness = resolve;
    });

    await page.route('**/api/mcp/connection/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          oauthTimeout: 30000,
          connectionStatus: {
            [SERVER_NAME]: readinessComplete
              ? {
                  connectionState: 'connected',
                  requiresOAuth: true,
                  authorizationState: 'authorized',
                }
              : {
                  /** A retry can begin while React Query still holds the previous attempt's
                   * terminal status. The live PENDING flow must supersede this stale error. */
                  connectionState: 'error',
                  requiresOAuth: true,
                  authorizationState: 'error',
                },
          },
        }),
      });
    });

    await page.route(`**/api/mcp/${SERVER_NAME}/reinitialize`, async (route) => {
      reinitializeCalls++;
      if (reinitializeCalls === 1) {
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
        return;
      }

      markReadinessStarted();
      await readinessGate;
      readinessComplete = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          message: 'MCP server reinitialized successfully',
          serverName: SERVER_NAME,
          oauthRequired: false,
        }),
      });
    });

    await page.route('**/api/mcp/oauth/status/**', async (route) => {
      flowStatusCalls++;
      if (flowStatusCalls === 1) {
        markPendingPolled();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'PENDING', completed: false, failed: false }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'COMPLETED', completed: true, failed: false }),
      });
    });

    await page.goto('/c/new', { timeout: 10000 });
    await expectSelected(page, 'false');

    await openMcpPanel(page);
    const card = serverCard(page);
    await card.getByRole('button', { name: 'Connect', exact: true }).click();
    await pendingPolled;

    await expect(card.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(page.getByText('Failed to initialize MCP server')).toHaveCount(0);

    await readinessStarted;

    await expectSelected(page, 'false');
    await expect(card.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(
      page.getByText(`MCP server '${SERVER_NAME}' authenticated successfully`),
    ).toHaveCount(0);

    releaseReadiness();

    await expect(
      page.getByText(`MCP server '${SERVER_NAME}' authenticated successfully`).first(),
    ).toBeVisible();
    await expectSelected(page, 'true');
    expect(reinitializeCalls).toBe(2);
  });

  test('stops a reused OAuth spinner at the attempt remaining lifetime', async ({ page }) => {
    test.setTimeout(30000);

    let flowStatusCalls = 0;
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
          oauthTimeout: 5500,
        }),
      });
    });
    await page.route('**/api/mcp/oauth/status/**', async (route) => {
      flowStatusCalls++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'PENDING', completed: false, failed: false }),
      });
    });

    await page.goto('/c/new', { timeout: 10000 });
    await openMcpPanel(page);
    const card = serverCard(page);
    await card.getByRole('button', { name: 'Connect', exact: true }).click();

    await expect(page.getByText(`OAuth login timed out for ${SERVER_NAME}`).first()).toBeVisible({
      timeout: 15000,
    });
    expect(flowStatusCalls).toBe(2);

    await expect(card.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
  });

  test('accepts completion found by the final poll after the attempt deadline', async ({
    page,
  }) => {
    test.setTimeout(30000);

    let reinitializeCalls = 0;
    let flowStatusCalls = 0;
    await page.route('**/api/mcp/connection/status', async (route) => {
      const readinessComplete = reinitializeCalls > 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          oauthTimeout: 30000,
          connectionStatus: {
            [SERVER_NAME]: {
              connectionState: readinessComplete ? 'connected' : 'error',
              requiresOAuth: true,
              authorizationState: readinessComplete ? 'authorized' : 'error',
            },
          },
        }),
      });
    });
    await page.route(`**/api/mcp/${SERVER_NAME}/reinitialize`, async (route) => {
      reinitializeCalls++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          reinitializeCalls === 1
            ? {
                success: true,
                message: 'OAuth authorization required',
                serverName: SERVER_NAME,
                oauthRequired: true,
                oauthUrl: 'https://oauth.example.test/authorize',
                flowId: FLOW_ID,
                oauthTimeout: 1000,
              }
            : {
                success: true,
                message: 'MCP server reinitialized successfully',
                serverName: SERVER_NAME,
                oauthRequired: false,
              },
        ),
      });
    });
    await page.route('**/api/mcp/oauth/status/**', async (route) => {
      flowStatusCalls++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'COMPLETED', completed: true, failed: false }),
      });
    });

    await page.goto('/c/new', { timeout: 10000 });
    await openMcpPanel(page);
    const card = serverCard(page);
    await card.getByRole('button', { name: 'Connect', exact: true }).click();

    await expect(
      page.getByText(`MCP server '${SERVER_NAME}' authenticated successfully`).first(),
    ).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(`OAuth login timed out for ${SERVER_NAME}`)).toHaveCount(0);
    await expectSelected(page, 'true');
    expect(flowStatusCalls).toBe(1);
    expect(reinitializeCalls).toBe(2);
  });

  test('stops polling at the attempt deadline during repeated transient errors', async ({
    page,
  }) => {
    test.setTimeout(30000);

    let flowStatusCalls = 0;
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
          oauthTimeout: 1000,
        }),
      });
    });
    await page.route('**/api/mcp/oauth/status/**', async (route) => {
      flowStatusCalls++;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Temporary shared-state failure' }),
      });
    });

    await page.goto('/c/new', { timeout: 10000 });
    await openMcpPanel(page);
    const card = serverCard(page);
    await card.getByRole('button', { name: 'Connect', exact: true }).click();

    await expect(page.getByText(`OAuth login timed out for ${SERVER_NAME}`).first()).toBeVisible({
      timeout: 15000,
    });
    expect(flowStatusCalls).toBe(1);
  });

  test('keeps polling when an older fallback pod still reports authorization in progress', async ({
    page,
  }) => {
    test.setTimeout(30000);

    let flowStatusCalls = 0;
    await page.route('**/api/mcp/connection/status', async (route) => {
      let serverStatus = {
        connectionState: 'connected',
        requiresOAuth: true,
        authorizationState: 'authorized',
      };
      if (flowStatusCalls === 0) {
        serverStatus = {
          connectionState: 'error',
          requiresOAuth: true,
          authorizationState: 'error',
        };
      } else if (flowStatusCalls === 1) {
        serverStatus = {
          connectionState: 'error',
          requiresOAuth: true,
          authorizationState: 'authorizing',
        };
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          oauthTimeout: 30000,
          connectionStatus: { [SERVER_NAME]: serverStatus },
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
      flowStatusCalls++;
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Route not found' }),
      });
    });

    await page.goto('/c/new', { timeout: 10000 });
    await openMcpPanel(page);
    const card = serverCard(page);
    await card.getByRole('button', { name: 'Connect', exact: true }).click();

    await expect(card.getByRole('button', { name: 'Cancel' })).toBeVisible({
      timeout: 8000,
    });
    await expect(page.getByText('Failed to initialize MCP server')).toHaveCount(0);
    await expect(
      page.getByText(`MCP server '${SERVER_NAME}' authenticated successfully`).first(),
    ).toBeVisible({ timeout: 20000 });
    await expectSelected(page, 'true');
    expect(flowStatusCalls).toBeGreaterThanOrEqual(2);
  });
});
