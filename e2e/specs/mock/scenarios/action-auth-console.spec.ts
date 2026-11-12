import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';
import { getAccessToken, requestJson } from '../helpers';
import { openSidebar } from './sidebar';

/**
 * Saving an assistant Action used to `console.log` the whole auth form, which
 * holds the plaintext API key, so the secret reached the browser console where
 * extensions, session-replay and error-monitoring SDKs can read it. This drives
 * the real Action builder with an API key and asserts the save request carries
 * the key while nothing written to the console does.
 */

type CreatedAssistant = { id: string };

const ASSISTANT_NAME = 'E2E action auth console assistant';
const API_KEY = 'e2e-action-secret-7f3c91d2';

const OPENAPI_SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'E2E Console Secret API', version: '1.0.0' },
  servers: [{ url: 'https://example.com' }],
  paths: {
    '/widgets': {
      get: { operationId: 'e2eConsoleListWidgets', responses: { '200': { description: 'ok' } } },
    },
  },
});

async function createAssistant(page: Page): Promise<CreatedAssistant> {
  await page.goto('/c/new', { timeout: 10000 });
  const token = await getAccessToken(page);
  return requestJson<CreatedAssistant>(page, {
    path: '/api/assistants/v2',
    token,
    method: 'POST',
    body: { endpoint: 'assistants', model: 'gpt-4o-mini', name: ASSISTANT_NAME },
  });
}

async function deleteAssistant(page: Page, assistantId: string) {
  const token = await getAccessToken(page);
  await requestJson(page, {
    path: `/api/assistants/v2/${encodeURIComponent(assistantId)}?endpoint=assistants&model=gpt-4o-mini`,
    token,
    method: 'DELETE',
    body: { endpoint: 'assistants' },
  });
}

async function openBuilder(page: Page) {
  await page.goto('/c/new?endpoint=assistants&model=gpt-4o-mini', { timeout: 10000 });
  await openSidebar(page);
  /** The mobile drawer opens on chat history; its panels are items of the Control Panel menu. */
  const controlPanel = page.getByRole('button', { name: 'Control Panel' });
  if (await controlPanel.isVisible()) {
    await controlPanel.click();
    await page.getByRole('menuitemcheckbox', { name: 'Assistant Builder' }).click();
  } else {
    await page.getByRole('button', { name: 'Assistant Builder' }).first().click();
  }
  await expect(
    page.getByTestId('select-dropdown-button').first().getByText(ASSISTANT_NAME, { exact: true }),
  ).toBeVisible();
}

/** Serializes every argument, so an object logged by reference is searched by its contents. */
async function consoleText(message: ConsoleMessage): Promise<string> {
  const args = await Promise.all(message.args().map((arg) => arg.jsonValue().catch(() => '')));
  return `${message.text()} ${JSON.stringify(args)}`;
}

test.describe('action auth console', () => {
  test('saving an Action with an API key writes no secret to the console @scenario:action-auth-no-console-secret', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const pending: Promise<string>[] = [];
    page.on('console', (message) => {
      pending.push(consoleText(message));
    });

    const assistant = await createAssistant(page);
    try {
      await openBuilder(page);
      await page.getByRole('button', { name: 'Add Actions' }).click();

      await page.locator('#schemaInput').fill(OPENAPI_SPEC);
      await expect(page.getByText('e2eConsoleListWidgets')).toBeVisible();

      await page.getByRole('button', { name: /^None/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Authentication' });
      await dialog.getByRole('radio', { name: 'API Key' }).click();
      await dialog.locator('#auth-api-key').fill(API_KEY);
      await dialog.getByRole('button', { name: 'Done' }).click();
      await expect(dialog).toBeHidden();

      const saveRequest = page.waitForRequest(
        (request) =>
          request.method() === 'POST' &&
          request.url().includes(`/api/assistants/v2/actions/${assistant.id}`),
      );
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      expect((await saveRequest).postData() ?? '').toContain(API_KEY);
      await expect(
        page.getByText('Successfully created or updated Action', { exact: true }).first(),
      ).toBeVisible();

      const logged = await Promise.all(pending);
      expect(logged.filter((line) => line.includes(API_KEY))).toEqual([]);
    } finally {
      await deleteAssistant(page, assistant.id);
    }
  });
});
