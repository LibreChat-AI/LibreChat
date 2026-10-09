import { expect, test } from '@playwright/test';
import type { Page, Response } from '@playwright/test';
import {
  NEW_CHAT_PATH,
  isAgentsStream,
  mockReply,
  selectMockEndpoint,
  sendMessage,
} from './helpers';

/** Non-spec endpoints from e2e/config/librechat.e2e.yaml — switching between
 *  them exercises the no-spec `applyModelSpecEffects` path that previously
 *  wiped the ephemeral agent (MCP selection) for the active conversation. */
const PROVIDER_C = { label: 'Mock Provider C', model: 'mock-model-c' };
const PROVIDER_D = { label: 'Mock Provider D', model: 'mock-model-d' };

const MCP_SERVER_NAME = 'e2e-memory';
const MCP_SERVER_TITLE = 'E2E Memory';

const uniqueText = (prefix: string) => `${prefix} ${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

const mcpBadge = (page: Page) =>
  page.getByRole('listitem', { name: MCP_SERVER_TITLE, exact: true });

/** Select the MCP server from the composer palette. */
async function selectEphemeralMCP(page: Page) {
  await page.getByRole('button', { name: 'Attach and tools' }).click();
  const serverItem = page
    .getByRole('dialog', { name: 'Attach and tools' })
    .getByRole('button', { name: new RegExp(`^${MCP_SERVER_TITLE}\\b`) });
  await expect(serverItem).toBeVisible();
  await serverItem.click();
  await expect(serverItem).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(mcpBadge(page)).toBeVisible();
}

/** The `ephemeralAgent.mcp` array sent with a chat request. */
function requestMCP(response: Response): string[] | undefined {
  const body = response.request().postDataJSON() as { ephemeralAgent?: { mcp?: string[] } };
  return body.ephemeralAgent?.mcp;
}

test.describe('ephemeral MCP selection persistence', () => {
  test('keeps the MCP selection when switching models on a new chat', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });

    await selectMockEndpoint(page, PROVIDER_C);
    await selectEphemeralMCP(page);

    await selectMockEndpoint(page, PROVIDER_D);
    await expect(mcpBadge(page)).toBeVisible();

    const response = await sendMessage(page, uniqueText('mcp new chat switch'));
    expect(response.ok()).toBeTruthy();
    expect(requestMCP(response)).toContain(MCP_SERVER_NAME);

    await expect(mockReply(page)).toBeVisible({ timeout: 20000 });
  });

  test('keeps the MCP selection when regenerating after a model switch', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });

    await selectMockEndpoint(page, PROVIDER_C);
    await selectEphemeralMCP(page);

    const first = await sendMessage(page, uniqueText('mcp regenerate switch'));
    expect(first.ok()).toBeTruthy();
    expect(requestMCP(first)).toContain(MCP_SERVER_NAME);
    await expect(mockReply(page)).toBeVisible({ timeout: 20000 });
    await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });

    await selectMockEndpoint(page, PROVIDER_D);
    await expect(mcpBadge(page)).toBeVisible();

    const [regenerated] = await Promise.all([
      page.waitForResponse(isAgentsStream, { timeout: 30000 }),
      page.getByRole('button', { name: 'Regenerate', exact: true }).click(),
    ]);
    expect(regenerated.ok()).toBeTruthy();
    expect(requestMCP(regenerated)).toContain(MCP_SERVER_NAME);

    await expect(mockReply(page).first()).toBeVisible({ timeout: 20000 });
  });
});
