import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH, selectModelSpec } from '../helpers';
import { expect, test } from '../fixtures';

const AZURE = 'azureOpenAI';
const DECLARED = 'production-west';
const UNDECLARED = 'production-chat';

const SPEC_LABELS: Record<string, string> = {
  [DECLARED]: 'E2E Azure Reasoning Deployment',
  [UNDECLARED]: 'E2E Azure Chat Deployment',
};

/** The mock fleet has no Azure group, and adding one would change the endpoint list every other
 *  scenario sees, so the served config carries the shape `getEndpointsConfig` builds from
 *  `reasoningEfforts`. The composer, the submit check and the payload are the real ones. */
async function openDeployment(page: Page, model: string): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/endpoints',
    async (route) => {
      const response = await route.fetch();
      const endpoints = await response.json();
      endpoints[AZURE] = {
        userProvide: false,
        order: 99,
        modelReasoningEfforts: { [DECLARED]: ['low', 'high'] },
      };
      await route.fulfill({ response, json: endpoints });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/models',
    async (route) => {
      const response = await route.fetch();
      const models = await response.json();
      models[AZURE] = [DECLARED, UNDECLARED];
      await route.fulfill({ response, json: models });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/config',
    async (route) => {
      const response = await route.fetch();
      const config = await response.json();
      const list = Array.isArray(config.modelSpecs?.list) ? config.modelSpecs.list : [];
      const specs = [DECLARED, UNDECLARED].map((name) => ({
        name: `e2e-${name}`,
        label: SPEC_LABELS[name],
        preset: { endpoint: AZURE, model: name },
      }));
      await route.fulfill({
        response,
        json: {
          ...config,
          modelSpecs: { ...(config.modelSpecs ?? {}), list: [...list, ...specs] },
        },
      });
    },
  );
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectModelSpec(page, SPEC_LABELS[model]);
}

const thinkingChip = (page: Page) => page.getByRole('button', { name: /^Thinking: / });

test.describe('Native Azure reasoning effort', () => {
  test('An Azure deployment that declares efforts offers them in the composer @scenario:azure-declared-efforts-offered', async ({
    page,
  }) => {
    await openDeployment(page, DECLARED);

    await thinkingChip(page).click();
    const panel = page.getByRole('dialog', { name: /^Thinking: / });
    await expect(panel.getByRole('button', { name: 'Auto', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(panel.getByRole('radio', { name: 'Low', exact: true })).toBeVisible();
    await expect(panel.getByRole('radio', { name: 'High', exact: true })).toBeVisible();
    await expect(panel.getByRole('radio', { name: 'Medium', exact: true })).toHaveCount(0);
  });

  test('An Azure deployment without a declaration shows no effort control @scenario:azure-undeclared-no-control', async ({
    page,
  }) => {
    await openDeployment(page, UNDECLARED);

    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
    await expect(thinkingChip(page)).toHaveCount(0);
  });

  test('A chosen effort is submitted with the message @scenario:azure-chosen-effort-submitted', async ({
    page,
  }) => {
    await openDeployment(page, DECLARED);

    let submitted: Record<string, unknown> | undefined;
    await page.route(
      (url) => url.pathname.startsWith('/api/agents/chat'),
      async (route) => {
        submitted = route.request().postDataJSON();
        await route.fulfill({ status: 500, json: { message: 'stopped by the scenario' } });
      },
    );

    await thinkingChip(page).click();
    const panel = page.getByRole('dialog', { name: /^Thinking: / });
    await panel.getByRole('radio', { name: 'High', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(thinkingChip(page)).toHaveAccessibleName(/High/);

    const input = page.getByRole('textbox', { name: 'Message input' });
    await input.fill('Use the chosen effort');
    await input.press('Enter');

    await expect
      .poll(() => submitted?.reasoningOverride)
      .toEqual({
        key: 'reasoning_effort',
        value: 'high',
      });
    expect(submitted?.model).toBe(DECLARED);
  });
});
