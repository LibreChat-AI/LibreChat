import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH, selectModelSpec } from '../helpers';
import { openPanel } from './panels';

const PROVIDER = 'Mock Provider A';
const HAIKU_55 = 'claude-haiku-5-5';
const HAIKU_45 = 'claude-haiku-4-5';

const SPEC_LABELS: Record<string, string> = {
  [HAIKU_55]: 'E2E Claude Haiku 5.5',
  [HAIKU_45]: 'E2E Claude Haiku 4.5',
};

/** Mock Provider A takes Anthropic's parameter set and is reached through model specs, so
 *  each Haiku model gets a spec pinned to it; the model name alone then decides which of
 *  those settings the panel keeps. */
async function openParametersFor(page: Page, model: string): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/models',
    async (route) => {
      const response = await route.fetch();
      const models = await response.json();
      models[PROVIDER] = [...(models[PROVIDER] ?? []), HAIKU_55, HAIKU_45];
      await route.fulfill({ response, json: models });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/config',
    async (route) => {
      const response = await route.fetch();
      const config = await response.json();
      const list = Array.isArray(config.modelSpecs?.list) ? config.modelSpecs.list : [];
      const specs = [HAIKU_55, HAIKU_45].map((name) => ({
        name: `e2e-${name}`,
        label: SPEC_LABELS[name],
        preset: { endpoint: PROVIDER, model: name },
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
  await openPanel(page, 'parameters', 'Parameters');
  await expect(page.getByRole('region', { name: 'Reasoning' })).toBeVisible();
}

test.describe('Claude Haiku model parameters', () => {
  test('Haiku 5.5 offers thinking and effort without a budget or sampling controls @scenario:haiku-55-hides-budget-and-sampling', async ({
    page,
  }) => {
    await openParametersFor(page, HAIKU_55);

    const reasoning = page.getByRole('region', { name: 'Reasoning' });
    await expect(reasoning.getByRole('switch', { name: /^Thinking/ }).first()).toBeVisible();
    await expect(reasoning.getByText('Effort', { exact: true }).first()).toBeVisible();

    await expect(page.getByText('Thinking Budget')).toHaveCount(0);
    await expect(page.getByText('Temperature', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Top P', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Top K', { exact: true })).toHaveCount(0);
  });

  test('Haiku 4.5 keeps the thinking budget and sampling controls @scenario:haiku-45-keeps-budget-and-sampling', async ({
    page,
  }) => {
    await openParametersFor(page, HAIKU_45);

    const reasoning = page.getByRole('region', { name: 'Reasoning' });
    await expect(reasoning.getByRole('switch', { name: /^Thinking/ }).first()).toBeVisible();
    await expect(reasoning.getByText('Thinking Budget')).toBeVisible();
    await expect(page.getByText('Temperature', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Top P', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Top K', { exact: true }).first()).toBeVisible();
  });
});
