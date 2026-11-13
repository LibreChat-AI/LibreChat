import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
} from '../db';
import { expect, test } from '../fixtures';
import { messagesView } from '../helpers';

const ROOT_PARENT = '00000000-0000-0000-0000-000000000000';
/** The static client serves each preview from a random `<id>-` subdomain of its default host. */
const STATIC_BUNDLER_HOST = /^[\w-]+-preview\.sandpack-static-server\.codesandbox\.io$/;
const RUNTIME_BUNDLER_HOST = /^[\w-]+-sandpack\.codesandbox\.io$/;

/** Serves `/api/config` with the bundler URLs a Compose `${VAR:-}` passthrough produces. */
async function serveEmptyBundlerURLs(page: Page) {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    await route.fulfill({
      response,
      json: { ...config, bundlerURL: '', staticBundlerURL: '' },
    });
  });
}

/** Keeps the default bundler hosts offline: the test only needs to see the preview aimed at them. */
async function stubDefaultBundlers(page: Page) {
  await page.route(/^https:\/\/[^/]*codesandbox\.io\//, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>stub</title>',
    }),
  );
}

const cases = [
  {
    name:
      'an HTML artifact preview loads the default static bundler when the URL is empty ' +
      '@scenario:empty-static-bundler-url-uses-default-bundler',
    trigger: 'page.html HTML Opens as a rendered preview Click to open',
    text: [
      ':::artifact{identifier="e2e-empty-static" type="text/html" title="page.html"}',
      '<main><h1>Static preview</h1></main>',
      ':::',
    ].join('\n'),
    host: (hostname: string) => STATIC_BUNDLER_HOST.test(hostname),
  },
  {
    name:
      'a React artifact preview loads the default bundler when the URL is empty ' +
      '@scenario:empty-runtime-bundler-url-uses-default-bundler',
    trigger: 'App.tsx React Opens as a rendered preview Click to open',
    text: [
      ':::artifact{identifier="e2e-empty-runtime" type="application/vnd.react" title="App.tsx"}',
      '```tsx',
      'export default function App() {',
      '  return <h1>Runtime preview</h1>;',
      '}',
      '```',
      ':::',
    ].join('\n'),
    host: (hostname: string) => RUNTIME_BUNDLER_HOST.test(hostname),
  },
] as const;

test.describe('empty Sandpack bundler URLs', () => {
  for (const testCase of cases) {
    test(testCase.name, async ({ page }) => {
      const conversationId = randomUUID();
      const userEmail = getE2EUser().email;

      try {
        await seedConversations(userEmail, [
          { conversationId, title: 'Empty bundler URL', updatedAt: new Date() },
        ]);
        await seedMessages(userEmail, conversationId, [
          {
            messageId: randomUUID(),
            parentMessageId: ROOT_PARENT,
            text: testCase.text,
            isCreatedByUser: false,
            sender: 'Assistant',
            model: 'mock-model-a',
          },
        ]);

        await serveEmptyBundlerURLs(page);
        await stubDefaultBundlers(page);
        await page.goto(`/c/${conversationId}`, { timeout: 10000 });

        const trigger = messagesView(page).getByRole('button', {
          name: testCase.trigger,
          exact: true,
        });
        await expect(trigger).toBeVisible();

        const bundlerRequest = page.waitForRequest(
          (request) => {
            if (request.resourceType() !== 'document') {
              return false;
            }
            return testCase.host(new URL(request.url()).hostname);
          },
          { timeout: 15000 },
        );
        await trigger.click();

        const request = await bundlerRequest;
        expect(request.frame()).not.toBe(page.mainFrame());
        await expect(page.locator(`iframe[src*="${new URL(request.url()).hostname}"]`)).toHaveCount(
          1,
        );
      } finally {
        await deleteMessagesByConversation([conversationId]);
        await deleteConversations([conversationId]);
      }
    });
  }
});
