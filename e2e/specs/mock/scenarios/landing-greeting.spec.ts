import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import { MOCK_ENDPOINTS, NEW_CHAT_PATH, getAccessToken, requestJson } from '../helpers';
import { cleanupAgent, uniqueAgentName } from '../agents.helpers';

/**
 * The welcome screen names the selected agent and carries the generic footer
 * by default. A deployment can greet the user instead and drop that footer;
 * the agent's icon and description stay either way. The footer is hidden
 * below `sm`, so this runs on the desktop viewport it describes.
 */

const DESCRIPTION = 'Landing heading acceptance fixture.';
const DISCLAIMER = 'Every AI for Everyone.';

test.use({ viewport: { width: 1280, height: 800 } });

async function createAgent(page: Page, name: string) {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  const token = await getAccessToken(page);
  return requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description: DESCRIPTION,
      instructions: 'Keep this fixture deterministic.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
    },
  });
}

/** Answers the startup config with the deployment's welcome screen settings. */
async function serveInterface(page: Page, overrides: Record<string, unknown>) {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    await route.fulfill({
      response,
      json: { ...config, interface: { ...config.interface, ...overrides } },
    });
  });
}

async function openAgentLanding(page: Page, agentId: string) {
  await page.goto(`${NEW_CHAT_PATH}?agent_id=${encodeURIComponent(agentId)}`, {
    timeout: 15000,
  });
  const main = page.locator('main');
  await expect(main.getByText(DESCRIPTION)).toBeVisible({ timeout: 30000 });
  return main;
}

/** The room the composer leaves beneath itself for a footer bar, in pixels. */
function composerClearance(page: Page) {
  return page
    .locator('form:has(#prompt-textarea)')
    .evaluate((form) => parseFloat(getComputedStyle(form).marginBottom));
}

test.describe('welcome screen heading and footer', () => {
  test('the agent name heads the welcome screen above the footer by default @scenario:landing-names-the-agent-by-default', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const name = uniqueAgentName('E2E Landing Default');
    let agentId: string | undefined;

    try {
      agentId = (await createAgent(page, name)).id;
      const main = await openAgentLanding(page, agentId);

      await expect(main.getByText(name, { exact: true }).last()).toBeVisible();
      await expect(page.getByText(DISCLAIMER)).toBeVisible();
      await expect.poll(() => composerClearance(page)).toBeGreaterThan(16);
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('an opted-in deployment greets the user and drops the footer @scenario:landing-greets-the-user-without-a-footer', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const name = uniqueAgentName('E2E Landing Greeting');
    const welcome = 'Hello from the welcome screen';
    let agentId: string | undefined;

    try {
      agentId = (await createAgent(page, name)).id;
      await serveInterface(page, {
        landingHeading: 'greeting',
        landingFooter: false,
        customWelcome: welcome,
      });
      const main = await openAgentLanding(page, agentId);

      await expect(main.getByText(welcome)).toBeVisible();
      await expect(page.getByText(DISCLAIMER)).toHaveCount(0);
      /** No footer beneath it, so the composer keeps only its shadow clearance. */
      await expect.poll(() => composerClearance(page)).toBe(16);
      /** The header selector still names the agent; the welcome screen does not repeat it. */
      const inSelector = await page
        .locator('button, [role="combobox"]')
        .getByText(name, { exact: true })
        .count();
      await expect(main.getByText(name, { exact: true })).toHaveCount(inSelector);
    } finally {
      await cleanupAgent(page, agentId);
    }
  });
});
