import path from 'node:path';
import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { SeedMessage } from '../db';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import {
  seedMessages,
  seedConversations,
  deleteConversations,
  deleteMessagesByConversation,
} from '../db';
import { getE2EUser } from '../../../setup/user';
import { expect, test } from '../fixtures';

/**
 * The legacy MCP UI renderer, the App Bridge and the export helpers load on demand, each in a
 * chunk of its own next to `vendor`. The build's chunk groups capture a module's dependencies with
 * it, so a shared dependency (zod was the first) can pull one of these chunks into the entry
 * page. A chat that never shows an MCP view and never exports must not download any of them, and
 * an App a viewer opens must work while its code is still on the way.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ON_DEMAND_CHUNKS = ['mcp-ui', 'mcp-apps', 'export-tools', 'Bridge'] as const;
const chunkPath = (names: readonly string[]) =>
  new RegExp(`/assets/(?:${names.join('|')})\\.[\\w-]+\\.js$`);
const ON_DEMAND_CHUNK = chunkPath(ON_DEMAND_CHUNKS);
const BRIDGE_CHUNK = chunkPath(['Bridge']);
const SANDBOX_ORIGIN = 'http://sandbox.e2e.invalid';
const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const TOOL_NAME = 'show_dashboard';

/** A worker-served chunk would bypass the route that holds the bridge back. */
test.use({ serviceWorkers: 'block' });

function recordOnDemandRequests(page: Page): string[] {
  const requested: string[] = [];
  page.on('request', (request) => {
    if (ON_DEMAND_CHUNK.test(new URL(request.url()).pathname)) {
      requested.push(request.url());
    }
  });
  return requested;
}

/** The harness enables MCP Apps only in its dedicated fixture profile, so the test sets the
 *  deployment policy in the startup config the client reads. */
async function enableMCPApps(page: Page) {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = (await response.json()) as { mcpApps?: Record<string, unknown> };
    await route.fulfill({
      response,
      json: {
        ...config,
        mcpApps: {
          ...config.mcpApps,
          enabled: true,
          legacyHtmlEnabled: true,
          sandboxUrl: `${SANDBOX_ORIGIN}/api/mcp/sandbox`,
        },
      },
    });
  });
  /** The sandbox lives on its own origin; an empty document keeps the frame off the network. */
  await page.route(`${SANDBOX_ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>sandbox</title>' }),
  );
}

async function seedAppTurn() {
  const conversationId = randomUUID();
  const userMessageId = randomUUID();
  const messageId = randomUUID();
  const toolCallId = `app-${conversationId.slice(0, 8)}`;
  const messages = [
    {
      messageId: userMessageId,
      parentMessageId: NO_PARENT,
      isCreatedByUser: true,
      sender: 'User',
      text: 'Open the dashboard.',
    },
    {
      messageId,
      parentMessageId: userMessageId,
      isCreatedByUser: false,
      sender: 'Assistant',
      text: '',
      content: [
        {
          type: 'tool_call',
          tool_call: {
            id: toolCallId,
            name: 'show_dashboard_mcp_e2e-app',
            args: '{}',
            output: 'Shown',
            progress: 1,
          },
        },
        { type: 'text', text: 'Here is the dashboard.' },
      ],
      attachments: [
        {
          type: 'ui_resources',
          messageId,
          conversationId,
          toolCallId,
          ui_resources: [
            {
              uri: `ui://e2e-app/${toolCallId}`,
              mimeType: 'text/html;profile=mcp-app',
              text: '<p>app</p>',
              toolName: TOOL_NAME,
              serverName: 'e2e-app',
              serverBinding: 'e2e-binding',
            },
          ],
        },
      ],
    },
  ] as SeedMessage[];

  await seedConversations(getE2EUser().email, [
    { conversationId, title: 'Lazy MCP App', updatedAt: new Date() },
  ]);
  await seedMessages(getE2EUser().email, conversationId, messages);
  return { conversationId, messageId };
}

test.describe('the on-demand MCP UI and export chunks', () => {
  test('a chat that shows no MCP view and exports nothing downloads none of them @scenario:a-plain-chat-never-downloads-mcp-ui-or-export-chunks', async ({
    page,
  }) => {
    /** A chunk renamed in the build would leave the request filter matching nothing. */
    const built = readdirSync(path.join(REPO_ROOT, 'client/dist/assets'));
    for (const name of ON_DEMAND_CHUNKS) {
      expect(
        built.some((file) => chunkPath([name]).test(`/assets/${file}`)),
        `the build has no ${name} chunk`,
      ).toBe(true);
    }

    const requested = recordOnDemandRequests(page);
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const response = await sendMessageAndWaitForCompletion(page, 'Hello there');
    expect(response.ok()).toBeTruthy();
    await expect(messagesView(page).getByText('Hello there')).toBeVisible();

    expect(requested).toEqual([]);
  });

  test('an MCP App opens while its bridge downloads and can be closed before it arrives @scenario:an-mcp-app-opens-while-its-bridge-downloads', async ({
    page,
  }) => {
    const requested = recordOnDemandRequests(page);
    let bridgeArrived = false;
    page.on('response', (response) => {
      bridgeArrived ||= BRIDGE_CHUNK.test(new URL(response.url()).pathname);
    });
    let releaseBridge: () => void = () => undefined;
    const bridgeHeld = new Promise<void>((resolve) => {
      releaseBridge = resolve;
    });
    await page.route(BRIDGE_CHUNK, async (route) => {
      await bridgeHeld;
      await route.continue();
    });
    await enableMCPApps(page);
    /* The bridge checks the App's server binding before it loads the sandbox. No MCP server
     * stands behind this App, so the check is held: the opened view stays loading, as it does
     * while a real server answers, instead of failing at once. */
    await page.route('**/api/mcp/app/validate', () => new Promise<void>(() => undefined));
    const { conversationId, messageId } = await seedAppTurn();

    try {
      await page.goto(`/c/${conversationId}`);
      const view = page.locator(`[id="${messageId}"] [data-mcp-app-view="${TOOL_NAME}"]`);
      const open = view.getByRole('button', { name: `Open app: ${TOOL_NAME} (1)`, exact: true });
      const close = view.getByRole('button', { name: `Close app: ${TOOL_NAME} (1)`, exact: true });
      const frame = page.locator('iframe[data-sandbox-url]');
      await expect(open).toBeVisible();
      expect(requested, 'a placeholder must not fetch the bridge').toEqual([]);

      /* The Close control does not wait for the bridge, and a silent loading box stands in for the
       * frame until it arrives: the frame's own status announces the loading once it mounts, so
       * one open never announces it twice. */
      await open.click();
      await expect(close).toBeFocused();
      await expect(view.getByText('Loading interactive view...')).toBeVisible();
      await expect(view.getByRole('status')).toHaveCount(0);
      await expect(frame).toHaveCount(0);

      /* Closing while the bridge is on its way returns to the placeholder, and the late arrival
       * mounts nothing. */
      await close.click();
      await expect(open).toBeFocused();
      await expect(view.getByText('Loading interactive view...')).toHaveCount(0);
      releaseBridge();
      await expect.poll(() => bridgeArrived).toBe(true);
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      await expect(open).toBeVisible();
      await expect(frame).toHaveCount(0);

      /* The next open finds the bridge loaded and mounts the frame, which keeps the loading status
       * until its App answers. */
      await open.click();
      await expect(close).toBeFocused();
      await expect(frame).toHaveCount(1);
      await expect(view.getByRole('status')).toHaveText('Loading interactive view...');
      await expect(page.locator(`iframe[title="MCP App: ${TOOL_NAME}"]`)).toHaveAttribute(
        'data-sandbox-url',
        new RegExp(`^${SANDBOX_ORIGIN}/api/mcp/sandbox`),
      );
      await close.click();
      await expect(frame).toHaveCount(0);

      expect(requested.some((url) => BRIDGE_CHUNK.test(new URL(url).pathname))).toBe(true);
      expect(requested.some((url) => chunkPath(['mcp-apps']).test(new URL(url).pathname))).toBe(
        true,
      );
    } finally {
      releaseBridge();
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });
});
