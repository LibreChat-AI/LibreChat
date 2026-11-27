import type { Page } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import { MOCK_ENDPOINTS, NEW_CHAT_PATH, getAccessToken, requestJson } from '../helpers';
import { cleanupAgent, uniqueAgentName } from '../agents.helpers';
import { expect, test } from '../fixtures';

/**
 * The welcome screen names the selected agent, draws its icon beside the name,
 * and carries the generic footer by default. A deployment can greet the user
 * instead and drop that footer; the greeting then stands without the icon, which
 * the header selector already shows, and the description stays either way.
 * Temporary chat keeps its own mark under both headings. The footer is hidden
 * below `sm`, so this runs on the desktop viewport it describes.
 */

const DESCRIPTION = 'Landing heading acceptance fixture.';
const DISCLAIMER = 'Every AI for Everyone.';
/** The round mark beside the heading, and the badge anchored to it when the birthday icon is on. */
const HEADING_ICON = '.avatar-stroke';
const BIRTHDAY_BADGE = "It's my 1st birthday!";

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

/** Answers the startup config with the deployment's welcome screen settings, and any
 *  top-level setting beside them, such as the birthday icon. */
async function serveInterface(
  page: Page,
  overrides: Record<string, unknown>,
  startup: Record<string, unknown> = {},
) {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    await route.fulfill({
      response,
      json: { ...config, ...startup, interface: { ...config.interface, ...overrides } },
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

  test('an opted-in deployment places the footer directly under the composer @scenario:landing-footer-under-the-composer', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const name = uniqueAgentName('E2E Landing Composer Footer');
    let agentId: string | undefined;

    try {
      agentId = (await createAgent(page, name)).id;
      await serveInterface(page, { landingFooter: 'composer' });
      await openAgentLanding(page, agentId);

      const disclaimer = page.getByText(DISCLAIMER);
      await expect(disclaimer).toBeVisible();
      await expect.poll(() => composerClearance(page)).toBe(16);
      const composerBox = await page.locator('form:has(#prompt-textarea)').boundingBox();
      const disclaimerBox = await disclaimer.boundingBox();
      expect(disclaimerBox!.y - (composerBox!.y + composerBox!.height)).toBeLessThanOrEqual(24);
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
      /** The header selector follows the conversation on a short delay, so it names the agent a
       *  beat after the welcome screen paints. Once it does, that label is the only mention. */
      await expect(main.getByRole('button', { name: 'Select a model', exact: true })).toHaveText(
        name,
      );
      await expect(main.getByText(name, { exact: true })).toHaveCount(1);
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('the default heading keeps the agent icon and its birthday badge beside the name @scenario:landing-default-heading-keeps-the-agent-icon', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const name = uniqueAgentName('E2E Landing Icon Default');
    let agentId: string | undefined;

    try {
      agentId = (await createAgent(page, name)).id;
      await serveInterface(page, {}, { showBirthdayIcon: true });
      const main = await openAgentLanding(page, agentId);

      await expect(main.getByText(name, { exact: true }).last()).toBeVisible();
      await expect(main.locator(HEADING_ICON)).toHaveCount(1);
      await expect(main.getByLabel(BIRTHDAY_BADGE)).toBeVisible();
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('an opted-in deployment greets the user without the agent icon or its birthday badge @scenario:landing-greeting-drops-the-agent-icon', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const name = uniqueAgentName('E2E Landing Icon Greeting');
    const welcome = 'Hello without the icon';
    let agentId: string | undefined;

    try {
      agentId = (await createAgent(page, name)).id;
      await serveInterface(
        page,
        { landingHeading: 'greeting', customWelcome: welcome },
        { showBirthdayIcon: true },
      );
      const main = await openAgentLanding(page, agentId);

      /** The description is already up and the greeting beside it, so the absences below are
       *  not a screen that has yet to draw. */
      await expect(main.getByText(welcome)).toBeVisible();
      await expect(main.locator(HEADING_ICON)).toHaveCount(0);
      await expect(main.getByLabel(BIRTHDAY_BADGE)).toHaveCount(0);
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('temporary chat keeps its incognito icon under the greeting heading @scenario:landing-greeting-keeps-the-temporary-chat-icon', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const welcome = 'Hello before the mode changes';
    await serveInterface(page, { landingHeading: 'greeting', customWelcome: welcome });
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    const main = page.locator('main');
    await expect(main.getByText(welcome)).toBeVisible({ timeout: 30000 });
    await expect(main.locator(HEADING_ICON)).toHaveCount(0);

    /** The chat route resets temporary mode on load, so it is turned on the way a user does. */
    const toggle = page.locator('button[aria-label="Temporary Chat"]');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    await expect(main.getByText('Temporary Chat', { exact: true }).first()).toBeVisible();
    await expect(main.locator(`${HEADING_ICON} svg.lucide-hat-glasses`)).toBeVisible();
  });
});
