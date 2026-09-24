import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { encodeEphemeralAgentId } from 'librechat-data-provider';
import type { FrameLocator, Page, Response, Route } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  getAccessToken,
  messagesView,
  requestJson,
  selectMockEndpoint,
  sendMessage,
  sendMessageAndWaitForCompletion,
} from './helpers';

const MCP_SERVER_TITLE = 'E2E MCP App';
const LEGACY_FRAME_TITLE = 'MCP HTML Resource (Embedded Content)';
const CHAT_ORIGIN = new URL(process.env.E2E_BASE_URL || 'http://127.0.0.1:3080').origin;
const MCP_APP_ORIGIN = `http://127.0.0.1:${process.env.E2E_MCP_APP_PORT || '8768'}`;
const MCP_APP_LINK_ORIGIN = `http://localhost:${process.env.E2E_MCP_APP_PORT || '8768'}`;
const LABEL_SERVER = `http://127.0.0.1:${process.env.E2E_LABEL_PORT || '8889'}`;
const MCP_APP_PHASE_ENDPOINT = { label: 'Mock Provider F', model: 'mock-model-f' };
const MCP_APP_PHASE_AGENT_ID = encodeEphemeralAgentId({
  endpoint: MCP_APP_PHASE_ENDPOINT.label,
  model: MCP_APP_PHASE_ENDPOINT.model,
  sender: MCP_APP_PHASE_ENDPOINT.label,
});
const MCP_APP_PHASE_PARENT_LABEL = 'Rendered two MCP Apps in one activity phase';
const APP_ROUTE_PATHS = new Set([
  '/api/mcp/app/validate',
  '/api/mcp/app-tool-call',
  '/api/mcp/resources/read',
  '/api/mcp/resources/list',
  '/api/mcp/resources/templates/list',
]);
const EXECUTABLE_FRAME_SELECTORS = [
  'iframe[data-sandbox-url]',
  `iframe[title="${LEGACY_FRAME_TITLE}"]`,
];
const PHASE = process.env.E2E_MCP_APPS_PHASE ?? 'standalone';
const STATE_PATH =
  process.env.E2E_MCP_APPS_STATE_PATH ??
  path.resolve(process.cwd(), 'e2e/.generated/mcp-apps-state.json');

type DebugEvent = { method: string; params: Record<string, unknown> };
type MCPAppsPolicy = {
  enabled: boolean;
  legacyHtmlEnabled: boolean;
  sandboxUrl?: string;
  maxAdmissionRequestsPerMinute?: number;
};
type StoredToolCall = { id?: string; agentId?: string; stepId?: string };
type StoredContentPart = {
  type?: string;
  agentId?: string;
  tool_call?: StoredToolCall;
};
type UIResourceAttachment = {
  type?: string;
  toolCallId?: string;
  agentId?: string;
  stepId?: string;
  ui_resources?: Array<Record<string, unknown>>;
};
type StoredMessage = {
  [key: string]: unknown;
  attachments?: UIResourceAttachment[];
  content?: Array<StoredContentPart | null>;
  isCreatedByUser?: boolean;
};
type PersistedState = {
  conversationId: string;
  label: string;
  retryLabel: string;
  messageFingerprint: string;
  uiFingerprint: string;
};
type SharePayload = {
  shareId: string;
  messages?: Array<{ attachments?: Array<Record<string, unknown>> }>;
};

type RawResult = { json: unknown; status: number; text: string };

const randomLabel = () => `app-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

function isRoute(response: Response, pathname: string) {
  return response.request().method() === 'POST' && new URL(response.url()).pathname === pathname;
}

async function getPolicy(page: Page, token: string): Promise<MCPAppsPolicy> {
  const config = await requestJson<{ mcpApps: MCPAppsPolicy }>(page, {
    path: '/api/config',
    token,
  });
  return config.mcpApps;
}

async function getMessages(page: Page, token: string, conversationId: string) {
  return requestJson<StoredMessage[]>(page, {
    path: `/api/messages/${encodeURIComponent(conversationId)}`,
    token,
  });
}

function uiResources(messages: StoredMessage[]) {
  return messages.flatMap((message) =>
    (message.attachments ?? [])
      .filter((attachment) => attachment.type === 'ui_resources')
      .flatMap((attachment) => attachment.ui_resources ?? []),
  );
}

function persistedServerBinding(messages: StoredMessage[]): string {
  const binding = uiResources(messages).find(
    (resource) => resource.mimeType === 'text/html;profile=mcp-app',
  )?.serverBinding;
  if (typeof binding !== 'string' || !binding) {
    throw new Error('Expected a persisted MCP App server binding');
  }
  return binding;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function fingerprintUI(messages: StoredMessage[]) {
  const resources = uiResources(messages).sort((left, right) =>
    String(left.uri).localeCompare(String(right.uri)),
  );
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(resources)))
    .digest('hex');
}

function fingerprintMessages(messages: StoredMessage[]) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(messages)))
    .digest('hex');
}

function writeState(state: PersistedState) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function readState(): PersistedState {
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as PersistedState;
}

async function trackExecutableEffects(page: Page) {
  const appRequests: string[] = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      pathname === '/api/mcp/sandbox' ||
      (request.method() === 'POST' && APP_ROUTE_PATHS.has(pathname))
    ) {
      appRequests.push(`${request.method()} ${pathname}`);
    }
  });
  await page.addInitScript(
    ({ selectors }) => {
      const state = { app: 0, legacy: 0 };
      Object.defineProperty(window, '__mcpExecutableFrames', { value: state });
      const inspect = (node: Node) => {
        if (!(node instanceof Element)) {
          return;
        }
        for (const [index, selector] of selectors.entries()) {
          const key = index === 0 ? 'app' : 'legacy';
          if (node.matches(selector)) {
            state[key] += 1;
          }
          state[key] += node.querySelectorAll(selector).length;
        }
      };
      new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          mutation.addedNodes.forEach(inspect);
        }
      }).observe(document, { childList: true, subtree: true });
    },
    { selectors: EXECUTABLE_FRAME_SELECTORS },
  );
  return appRequests;
}

async function executableFrameCounts(page: Page) {
  return page.evaluate(() => {
    return (window as typeof window & { __mcpExecutableFrames?: { app: number; legacy: number } })
      .__mcpExecutableFrames;
  });
}

async function rawAuthenticatedRequest(
  page: Page,
  token: string,
  path: string,
  body: Record<string, unknown>,
): Promise<RawResult> {
  return page.evaluate(
    async ({ accessToken, requestBody, urlPath }) => {
      const response = await fetch(urlPath, {
        method: 'POST',
        credentials: 'include',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { json, status: response.status, text };
    },
    { accessToken: token, requestBody: body, urlPath: path },
  );
}

/** The redesigned composer seats MCP servers in the attach-and-tools palette as
 *  toggleable rows, so enabling one for the run opens the palette, waits for the
 *  server wave of the catalog, and flips the row's pressed state. */
async function selectMcpAppServer(page: Page) {
  const paletteButton = page.getByRole('button', { name: 'Attach and tools' });
  await expect(paletteButton).toBeVisible();
  await paletteButton.click();
  const palette = page.getByRole('dialog', { name: 'Attach and tools' });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('columnheader', { name: 'MCP Servers', exact: true })).toBeVisible(
    { timeout: 20000 },
  );
  const server = palette.locator('[data-row-key]').filter({ hasText: MCP_SERVER_TITLE });
  await expect(server).toBeVisible();
  await server.click();
  await expect(server.getByRole('button').first()).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
}

function appFrame(page: Page, toolName = 'show_app', occurrence = 0): FrameLocator {
  return page
    .locator(`iframe[title="MCP App: ${toolName}"]`)
    .nth(occurrence)
    .contentFrame()
    .locator('iframe')
    .contentFrame();
}

async function expectConnectedApp(
  page: Page,
  label: string,
  toolName = 'show_app',
  occurrence = 0,
) {
  // The placeholder is async after reload, and opening one View removes its button.
  // Match the stable host-owned tool identity rather than a shifting list of placeholders.
  const view = page.locator(`[data-mcp-app-view="${toolName}"]`).nth(occurrence);
  await expect(view).toBeVisible({ timeout: 30_000 });
  const open = view.getByRole('button', { name: 'Open app' });
  if (await open.count()) {
    // Pre-scroll before clicking a sibling View: Chrome can drop Playwright's first click when
    // scrolling past an active sandbox iframe and dispatch it to the old focused frame.
    await open.scrollIntoViewIfNeeded();
    await open.boundingBox();
    await open.click();
    await expect(view.getByRole('button', { name: 'Close app' })).toBeVisible();
  }
  const app = appFrame(page, toolName, occurrence);
  await expect(app.getByTestId('status')).toHaveText('connected', { timeout: 30_000 });
  await expect(app.getByTestId('document-source')).toHaveText('resources-read-document');
  await expect(app.getByTestId('input')).toContainText(`"label":"${label}"`);
  await expect(app.getByTestId('result')).toContainText(`"label":"${label}"`);
  await expect(app.getByTestId('result-content')).toContainText('tool-result-embedded-document');
  await expect(app.getByTestId('events')).toHaveText('input,result');

  const capabilities = app.getByTestId('capabilities');
  await expect(capabilities).toContainText('serverTools');
  await expect(capabilities).toContainText('serverResources');
  await expect(capabilities).toContainText('message');
  await expect(app.getByTestId('call-tool')).toBeEnabled();
  return app;
}

async function expectAppHeight(page: Page, occurrence: number) {
  const outerFrame = page.locator('iframe[title="MCP App: show_app"]').nth(occurrence);
  const container = outerFrame.locator('..');
  await expect(outerFrame).toHaveCSS('height', '260px');
  await expect(container).toHaveCSS('height', '260px');
}

async function expectAppFramesOutsidePanels(page: Page, count: number) {
  const outerFrames = page.locator('iframe[title="MCP App: show_app"]');
  await expect(outerFrames).toHaveCount(count);
  for (let index = 0; index < count; index += 1) {
    await expect(outerFrames.nth(index)).toBeVisible();
  }
  expect(
    await outerFrames.evaluateAll((frames) =>
      frames.every(
        (frame) =>
          frame.closest('[data-testid="activity-phase-panel"]') == null &&
          frame.closest('[data-testid="tool-call-group-panel"]') == null,
      ),
    ),
  ).toBe(true);
  await expect(
    page.locator('[data-testid="activity-phase-panel"] iframe[data-sandbox-url]'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-testid="tool-call-group-panel"] iframe[data-sandbox-url]'),
  ).toHaveCount(0);
}

async function clickAndExpectRoute(
  page: Page,
  app: FrameLocator,
  buttonTestId: string,
  pathname: string,
) {
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => isRoute(candidate, pathname), { timeout: 30_000 }),
    app.getByTestId(buttonTestId).click(),
  ]);
  expect(response.ok(), `${pathname} should complete through LibreChat`).toBeTruthy();
  return response;
}

async function resetEvents(page: Page) {
  const response = await page.request.post(`${MCP_APP_ORIGIN}/__debug/reset`);
  expect(response.status()).toBe(204);
}

function mcpAppPhaseLabels(label: string) {
  return {
    first: `Rendered alpha MCP App ${label}`,
    second: `Rendered beta MCP App ${label}`,
  };
}

async function configureMcpAppPhaseLabels(page: Page, label: string) {
  const reset = await page.request.post(`${LABEL_SERVER}/__e2e/reset`);
  expect(reset.ok()).toBeTruthy();
  const labels = mcpAppPhaseLabels(label);
  const response = await page.request.post(`${LABEL_SERVER}/__e2e/behavior`, {
    data: {
      phaseLabel: MCP_APP_PHASE_PARENT_LABEL,
      labelsByPrompt: {
        [`phase alpha ${label}`]: labels.first,
        [`phase beta ${label}`]: labels.second,
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  return labels;
}

async function readEvents(page: Page): Promise<DebugEvent[]> {
  const response = await page.request.get(`${MCP_APP_ORIGIN}/__debug/events`);
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { events: DebugEvent[] };
  return body.events;
}

async function createShare(page: Page, conversationId: string): Promise<SharePayload> {
  await page.getByRole('button', { name: 'Export/Share' }).click();
  await page.getByTestId('share-conversation-menu-item').click();
  const dialog = page.getByRole('dialog', { name: 'Share link to chat' });
  await expect(dialog).toBeVisible();

  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.request().method() === 'POST' &&
        new URL(candidate.url()).pathname === `/api/share/${conversationId}`,
      { timeout: 30_000 },
    ),
    dialog.getByRole('button', { name: 'Create a shared link' }).click(),
  ]);
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<SharePayload>;
}

test.describe('MCP Apps full integration', () => {
  test.skip(process.env.E2E_MCP_APPS !== 'true', 'requires the dedicated MCP Apps fixture profile');

  test('runs an official SDK View, reloads its snapshot, and omits UI from a public share', async ({
    page,
  }, testInfo) => {
    test.skip(!['standalone', 'true'].includes(PHASE));
    test.setTimeout(180_000);
    const label = randomLabel();
    const appRequests: string[] = [];
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname;
      if (request.method() === 'POST' && APP_ROUTE_PATHS.has(pathname)) {
        appRequests.push(pathname);
      }
    });

    await resetEvents(page);
    await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
    const token = await getAccessToken(page);
    expect(await getPolicy(page, token)).toMatchObject({
      enabled: true,
      legacyHtmlEnabled: true,
      sandboxUrl: process.env.E2E_MCP_SANDBOX_URL,
      maxAdmissionRequestsPerMinute: 240,
    });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await selectMcpAppServer(page);

    const sandboxResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/mcp/sandbox',
      { timeout: 60_000 },
    );
    const generation = await sendMessage(page, `E2E_MCP_APP:${label}`);
    expect(generation.ok()).toBeTruthy();
    await expect(messagesView(page).getByText(`E2E MCP App complete: ${label}`)).toBeVisible({
      timeout: 60_000,
    });
    // Merely receiving a completed App result must not run its code or perform App RPCs.
    await expect(page.locator('iframe[data-sandbox-url]')).toHaveCount(0);
    expect(appRequests).toEqual([]);
    await page.getByRole('button', { name: 'Open app' }).click();
    await expect(page.locator('iframe[data-sandbox-url]')).toHaveCount(1);
    const outerCsp = (await sandboxResponse).headers()['content-security-policy'];
    expect(outerCsp).toContain('frame-src blob:');
    expect(outerCsp?.split(/[;,\n]+/).map((directive) => directive.trim())).toContain(
      `frame-ancestors ${CHAT_ORIGIN}`,
    );

    const outerFrame = page.locator('iframe[title="MCP App: show_app"]').nth(0);
    const sandboxUrl = await outerFrame.getAttribute('data-sandbox-url');
    expect(sandboxUrl).toBeTruthy();
    expect(new URL(sandboxUrl!).origin).not.toBe(new URL(page.url()).origin);
    expect(new URL(sandboxUrl!).origin).toBe('http://localhost:3080');
    await expect(outerFrame).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-forms',
    );
    await expect(outerFrame).toHaveAttribute('allow', 'geolocation; clipboard-write');

    const innerFrame = page.frameLocator('iframe[title="MCP App: show_app"]').locator('iframe');
    await expect(innerFrame).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
    await expect(innerFrame).toHaveAttribute('allow', 'geolocation; clipboard-write');

    const viewCsp = await appFrame(page)
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute('content');
    expect(viewCsp).toContain("default-src 'none'");
    expect(viewCsp).toContain("script-src 'self' 'unsafe-inline'");
    expect(viewCsp).toContain("style-src 'self' 'unsafe-inline'");
    expect(viewCsp).toContain("connect-src 'none'");
    expect(viewCsp).toContain("frame-src 'none'");
    expect(viewCsp).toContain("object-src 'none'");
    expect(viewCsp).not.toContain(MCP_APP_ORIGIN);

    const app = await expectConnectedApp(page, label);
    // App code can dispatch events without a user gesture. It must still be denied by default.
    await app.getByTestId('call-tool').evaluate((button) => (button as HTMLElement).click());
    const toolDialog = page.getByRole('alertdialog');
    await expect(toolDialog).toContainText('follow_up');
    expect(
      (await readEvents(page)).filter((event) => event.method === 'tools/call:follow_up'),
    ).toHaveLength(0);
    await toolDialog.getByRole('button', { name: 'Cancel' }).click();
    expect(
      (await readEvents(page)).filter((event) => event.method === 'tools/call:follow_up'),
    ).toHaveLength(0);
    // Repeated App-generated actions must not trap the viewer behind new approval modals.
    for (let i = 0; i < 3; i++) {
      await app.getByTestId('call-tool').evaluate((button) => (button as HTMLElement).click());
    }
    await expect(toolDialog).toHaveCount(0);
    expect(
      (await readEvents(page)).filter((event) => event.method === 'tools/call:follow_up'),
    ).toHaveLength(0);
    const appView = page.locator('[data-mcp-app-view="show_app"]').first();
    await appView.getByRole('button', { name: 'Close app' }).focus();
    await page.keyboard.press('Enter');
    await expect(appView.getByRole('button', { name: 'Open app' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(appView.getByRole('button', { name: 'Close app' })).toBeFocused();
    await expectConnectedApp(page, label);
    const approvedTool = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/mcp/app-tool-call',
    );
    await app.getByTestId('call-tool').click();
    await expect(toolDialog).toContainText('"label":"from-view"');
    await toolDialog.getByRole('button', { name: 'Run tool' }).click();
    expect((await approvedTool).ok()).toBeTruthy();
    await expect(app.getByTestId('operation')).toContainText('"followUp":"from-view"');
    await page.screenshot({ path: testInfo.outputPath('settled-app.png'), fullPage: true });

    await clickAndExpectRoute(page, app, 'read-resource', '/api/mcp/resources/read');
    await expect(app.getByTestId('operation')).toHaveText('fixture-detail:current');

    await clickAndExpectRoute(page, app, 'list-resources', '/api/mcp/resources/list');
    await expect(app.getByTestId('operation')).toContainText('ui://e2e/app.html');
    await expect(app.getByTestId('operation')).toContainText('ui://e2e/details/current');
    await expect(app.getByTestId('operation')).toContainText('ui://e2e/link-app.html');

    const currentConversationId = new URL(page.url()).pathname.split('/').pop();
    expect(currentConversationId).toMatch(/^[0-9a-fA-F-]{36}$/);
    const serverBinding = persistedServerBinding(
      await getMessages(page, token, currentConversationId!),
    );
    const templates = await requestJson<{ resourceTemplates: Array<{ uriTemplate: string }> }>(
      page,
      {
        path: '/api/mcp/resources/templates/list',
        method: 'POST',
        token,
        body: { serverName: 'e2e-app', serverBinding },
      },
    );
    expect(templates.resourceTemplates).toEqual(
      expect.arrayContaining([expect.objectContaining({ uriTemplate: 'ui://e2e/details/{id}' })]),
    );

    const appMessage = 'E2E_MCP_APP_MESSAGE:from-view';
    const nextGeneration = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /^\/api\/(agents|ask)\//.test(new URL(response.url()).pathname),
      { timeout: 30_000 },
    );
    await app.getByTestId('send-message').click();
    const messageDialog = page.getByRole('alertdialog');
    await expect(messageDialog).toContainText(appMessage);
    await expect(messageDialog).toContainText('selected agent and tools may be used');
    await messageDialog.getByRole('button', { name: 'Send message' }).click();
    await expect(app.getByTestId('operation')).toHaveText('message-sent');
    expect((await nextGeneration).ok()).toBeTruthy();
    await expect(messagesView(page).getByText(appMessage, { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    let events = await readEvents(page);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'tools/call:show_app', params: { label } }),
        expect.objectContaining({
          method: 'tools/call:follow_up',
          params: { label: 'from-view' },
        }),
        expect.objectContaining({ method: 'resources/read:details' }),
      ]),
    );
    expect(events.filter((event) => event.method === 'resources/read:show_app')).toHaveLength(1);

    await expectAppHeight(page, 0);
    await outerFrame.evaluate((frame) => {
      frame.dataset.retrySibling = 'retained';
    });

    const retryLabel = `retry-${label}`;
    const retrySandboxRequests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/mcp/sandbox') {
        retrySandboxRequests.push(request.url());
      }
    });
    let failNextSandbox = true;
    const failFirstSandboxRequest = async (route: Route) => {
      if (!failNextSandbox) {
        await route.continue();
        return;
      }
      failNextSandbox = false;
      await route.fulfill({
        status: 503,
        contentType: 'text/plain',
        body: 'temporary sandbox unavailable',
      });
    };
    await page.route('**/api/mcp/sandbox**', failFirstSandboxRequest);
    const failedSandboxResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/mcp/sandbox' && response.status() === 503,
      { timeout: 30_000 },
    );

    const retryGeneration = await sendMessage(page, `E2E_MCP_APP:${retryLabel}`);
    expect(retryGeneration.ok()).toBeTruthy();
    await expect(messagesView(page).getByText(`E2E MCP App complete: ${retryLabel}`)).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator('iframe[title="MCP App: show_app"]')).toHaveCount(1);
    await page
      .locator('[data-mcp-app-view]')
      .nth(1)
      .getByRole('button', { name: 'Open app' })
      .click();
    expect((await failedSandboxResponse).status()).toBe(503);
    await expect(page.locator('iframe[title="MCP App: show_app"]')).toHaveCount(2);

    const retryOuterFrame = page.locator('iframe[title="MCP App: show_app"]').nth(1);
    await retryOuterFrame.evaluate((frame) => {
      frame.dataset.retryTarget = 'retained';
    });
    const retryContainer = retryOuterFrame.locator('..');
    const retryAlert = retryContainer.getByRole('alert');
    await expect(retryAlert).toContainText('Interactive view failed to load.', {
      timeout: 30_000,
    });
    expect(retrySandboxRequests).toHaveLength(1);
    const retryButton = retryAlert.getByRole('button', { name: 'Retry', exact: true });
    await expect(retryButton).toBeVisible();

    const conversationUrl = page.url();
    await page.unroute('**/api/mcp/sandbox**', failFirstSandboxRequest);
    const recoveredSandboxResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/mcp/sandbox' && response.status() === 200,
      { timeout: 30_000 },
    );
    await retryButton.focus();
    await expect(retryButton).toBeFocused();
    await retryButton.press('Enter');

    expect((await recoveredSandboxResponse).ok()).toBeTruthy();
    await expectConnectedApp(page, retryLabel, 'show_app', 1);
    expect(page.url()).toBe(conversationUrl);
    await expect(retryOuterFrame).toHaveAttribute('data-retry-target', 'retained');
    await expect(outerFrame).toHaveAttribute('data-retry-sibling', 'retained');
    await expectConnectedApp(page, label);
    await expectAppHeight(page, 0);
    await expectAppHeight(page, 1);
    await expect.poll(() => retrySandboxRequests.length).toBe(2);

    events = await readEvents(page);
    expect(
      events
        .filter((event) => event.method === 'tools/call:show_app')
        .map((event) => event.params.label),
    ).toEqual([label, retryLabel]);
    expect(events.filter((event) => event.method === 'resources/read:show_app')).toHaveLength(2);

    const linkGeneration = await sendMessage(page, `E2E_MCP_LINK_APP:${label}`);
    expect(linkGeneration.ok()).toBeTruthy();
    await expect(messagesView(page).getByText(`E2E MCP link App complete: ${label}`)).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator('iframe[data-sandbox-url]')).toHaveCount(2);
    const linkApp = await expectConnectedApp(page, label, 'show_link_app');
    await expect(page.locator('iframe[data-sandbox-url]')).toHaveCount(3);
    const linkViewCsp = await linkApp
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute('content');
    expect(linkViewCsp).toContain(`script-src 'self' 'unsafe-inline' ${MCP_APP_LINK_ORIGIN}`);
    expect(linkViewCsp).toContain("connect-src 'none'");
    expect(linkViewCsp).toContain("frame-src 'none'");

    const popupPromise = page.waitForEvent('popup', { timeout: 30_000 });
    await linkApp.getByTestId('open-link').click();
    const openedPage = await popupPromise;
    await openedPage.waitForLoadState('domcontentloaded');
    expect(new URL(openedPage.url()).origin).toBe(MCP_APP_LINK_ORIGIN);
    expect(new URL(openedPage.url()).pathname).toBe('/opened');
    await expect(openedPage.getByText('policy-permitted-open')).toBeVisible();
    await expect(linkApp.getByTestId('operation')).toHaveText('{}');
    await openedPage.close();
    expect(
      (await readEvents(page)).filter((event) => event.method === 'resources/read:show_link_app'),
    ).toHaveLength(1);

    const legacyGeneration = await sendMessage(page, `E2E_MCP_LEGACY:${label}`);
    expect(legacyGeneration.ok()).toBeTruthy();
    const legacyFrameElement = page.locator(`iframe[title="${LEGACY_FRAME_TITLE}"]`);
    await expect(legacyFrameElement).toHaveCount(1);
    const legacyFrame = page.frameLocator(`iframe[title="${LEGACY_FRAME_TITLE}"]`);
    await expect(legacyFrame.getByTestId('legacy-status')).toHaveText('legacy-ready');
    await expect(legacyFrameElement).toHaveCSS('height', '120px');

    const legacyActionGeneration = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /^\/api\/(agents|ask)\//.test(new URL(response.url()).pathname),
      { timeout: 30_000 },
    );
    await legacyFrame.getByTestId('legacy-action').click();
    expect((await legacyActionGeneration).ok()).toBeTruthy();
    await expect(legacyFrame.getByTestId('legacy-expanded')).toBeVisible();
    await expect(legacyFrameElement).toHaveCSS('height', '360px');
    await expect(messagesView(page).getByText('E2E legacy action complete')).toBeVisible({
      timeout: 30_000,
    });
    expect(await readEvents(page)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'tools/call:show_legacy', params: { label } }),
        expect.objectContaining({
          method: 'tools/call:legacy_action',
          params: { label: 'legacy-view' },
        }),
      ]),
    );

    const conversationPath = new URL(page.url()).pathname;
    const conversationId = conversationPath.split('/').pop();
    expect(conversationId).toMatch(/^[0-9a-fA-F-]{36}$/);
    const persistedMessages = await getMessages(page, token, conversationId!);
    const persistedResources = uiResources(persistedMessages);
    expect(persistedResources.map((resource) => resource.uri).sort()).toEqual([
      'ui://e2e/app.html',
      'ui://e2e/app.html',
      'ui://e2e/legacy.html',
      'ui://e2e/link-app.html',
    ]);
    expect(
      persistedResources
        .filter((resource) => resource.mimeType === 'text/html;profile=mcp-app')
        .every((resource) => typeof resource.serverBinding === 'string'),
    ).toBe(true);
    writeState({
      conversationId: conversationId!,
      label,
      retryLabel,
      messageFingerprint: fingerprintMessages(persistedMessages),
      uiFingerprint: fingerprintUI(persistedMessages),
    });

    await resetEvents(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('iframe[data-sandbox-url]')).toHaveCount(0);
    await expectConnectedApp(page, label);
    await expectConnectedApp(page, retryLabel, 'show_app', 1);
    await expectConnectedApp(page, label, 'show_link_app');
    await expectAppHeight(page, 0);
    await expectAppHeight(page, 1);
    await expect(page.locator(`iframe[title="${LEGACY_FRAME_TITLE}"]`)).toHaveCount(1);
    expect(
      (await readEvents(page)).filter((event) => event.method.startsWith('resources/read:show_')),
    ).toEqual([]);

    const share = await createShare(page, conversationId!);
    expect(share.shareId).toBeTruthy();
    const appRequestCountBeforeShare = appRequests.length;

    const shareResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === `/api/share/${share.shareId}`,
      { timeout: 30_000 },
    );
    await page.goto(`/share/${share.shareId}`, { waitUntil: 'domcontentloaded' });
    const publicPayload = (await (await shareResponse).json()) as SharePayload;
    const sharedMessages = JSON.stringify(publicPayload.messages);
    expect(sharedMessages).toContain(`E2E MCP App result: ${label}`);
    expect(sharedMessages).toContain(`E2E MCP App result: ${retryLabel}`);
    expect(sharedMessages).toContain(`E2E MCP link App result: ${label}`);
    expect(sharedMessages).toContain(`E2E legacy MCP-UI result: ${label}`);
    expect(
      publicPayload.messages?.every(
        (message) => !message.attachments?.some((attachment) => attachment.type === 'ui_resources'),
      ),
    ).toBe(true);
    await expect(page.locator('iframe[data-sandbox-url]')).toHaveCount(0);
    await expect(page.locator(`iframe[title="${LEGACY_FRAME_TITLE}"]`)).toHaveCount(0);
    expect(appRequests).toHaveLength(appRequestCountBeforeShare);
  });

  test('keeps two labeled phase App results visible and correlated while panels stay closed', async ({
    page,
  }, testInfo) => {
    test.skip(!['standalone', 'true'].includes(PHASE));
    test.setTimeout(180_000);
    const label = randomLabel();
    const alphaLabel = `phase alpha ${label}`;
    const betaLabel = `phase beta ${label}`;
    const alphaToolCallId = `call_e2e_mcp_app_phase_alpha_${label}`;
    const betaToolCallId = `call_e2e_mcp_app_phase_beta_${label}`;
    const childLabels = await configureMcpAppPhaseLabels(page, label);

    await resetEvents(page);
    await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
    const token = await getAccessToken(page);
    expect(await getPolicy(page, token)).toMatchObject({
      enabled: true,
      legacyHtmlEnabled: true,
      sandboxUrl: process.env.E2E_MCP_SANDBOX_URL,
    });
    await selectMockEndpoint(page, MCP_APP_PHASE_ENDPOINT);
    await selectMcpAppServer(page);

    const generation = await sendMessageAndWaitForCompletion(page, `E2E_MCP_APP_PHASE:${label}`, {
      timeout: 90_000,
    });
    expect(generation.ok()).toBeTruthy();
    await expect(messagesView(page).getByText(`E2E MCP App phase complete: ${label}`)).toBeVisible({
      timeout: 60_000,
    });

    const conversationId = new URL(page.url()).pathname.split('/').pop();
    expect(conversationId).toMatch(/^[0-9a-fA-F-]{36}$/);
    let messages = await getMessages(page, token, conversationId!);
    await expect
      .poll(async () => {
        messages = await getMessages(page, token, conversationId!);
        const serialized = JSON.stringify(messages);
        return (
          serialized.includes(MCP_APP_PHASE_PARENT_LABEL) &&
          serialized.includes(childLabels.first) &&
          serialized.includes(childLabels.second)
        );
      })
      .toBe(true);

    const assistant = messages.find(
      (message) =>
        message.isCreatedByUser === false &&
        JSON.stringify(message).includes(`E2E MCP App phase complete: ${label}`),
    );
    expect(assistant).toBeDefined();
    const toolParts = (assistant?.content ?? []).filter(
      (part): part is StoredContentPart & { tool_call: StoredToolCall & { id: string } } =>
        typeof part?.tool_call?.id === 'string',
    );
    const attachments = (assistant?.attachments ?? []).filter(
      (attachment) => attachment.type === 'ui_resources',
    );
    expect(attachments).toHaveLength(2);

    for (const expected of [
      { id: alphaToolCallId, label: alphaLabel, otherLabel: betaLabel },
      { id: betaToolCallId, label: betaLabel, otherLabel: alphaLabel },
    ]) {
      const part = toolParts.find((candidate) => candidate.tool_call.id === expected.id);
      expect(part, `persisted tool call ${expected.id}`).toBeDefined();
      const stepId = part?.tool_call.stepId;
      expect(stepId).toEqual(expect.any(String));

      const attachment = attachments.find((candidate) => candidate.toolCallId === expected.id);
      expect(attachment, `persisted App attachment ${expected.id}`).toBeDefined();
      expect(attachment).toMatchObject({
        toolCallId: expected.id,
        agentId: MCP_APP_PHASE_AGENT_ID,
        stepId,
      });
      expect(attachment?.ui_resources).toHaveLength(1);
      const serialized = JSON.stringify(attachment?.ui_resources);
      expect(serialized).toContain(expected.label);
      expect(serialized).not.toContain(expected.otherLabel);
    }

    const phaseHeader = messagesView(page).getByRole('button', {
      name: MCP_APP_PHASE_PARENT_LABEL,
      exact: true,
    });
    await expect(phaseHeader).toBeVisible({ timeout: 60_000 });
    await expect(phaseHeader).toHaveAttribute('aria-expanded', 'false');
    await expectAppFramesOutsidePanels(page, 0);

    await expectConnectedApp(page, alphaLabel, 'show_app', 0);
    await expectConnectedApp(page, betaLabel, 'show_app', 1);
    await expectAppFramesOutsidePanels(page, 2);
    await page.screenshot({
      path: testInfo.outputPath('settled-grouped-apps.png'),
      fullPage: true,
    });

    const initialEvents = await readEvents(page);
    expect(
      initialEvents
        .filter((event) => event.method === 'tools/call:show_app')
        .map((event) => event.params.label),
    ).toEqual([alphaLabel, betaLabel]);
    expect(
      initialEvents.filter((event) => event.method === 'resources/read:show_app'),
    ).toHaveLength(2);

    await page.reload({ waitUntil: 'domcontentloaded' });
    const reloadedHeader = messagesView(page).getByRole('button', {
      name: MCP_APP_PHASE_PARENT_LABEL,
      exact: true,
    });
    await expect(reloadedHeader).toBeVisible({ timeout: 60_000 });
    await expect(reloadedHeader).toHaveAttribute('aria-expanded', 'false');
    await expectAppFramesOutsidePanels(page, 0);
    await expectConnectedApp(page, alphaLabel, 'show_app', 0);
    await expectConnectedApp(page, betaLabel, 'show_app', 1);
    await expectAppFramesOutsidePanels(page, 2);
    expect(
      (await readEvents(page)).filter((event) => event.method === 'resources/read:show_app'),
    ).toHaveLength(2);
  });

  test('disables all persisted executable UI when Apps are explicitly false', async ({ page }) => {
    test.skip(PHASE !== 'false');
    test.setTimeout(90_000);
    const state = readState();
    const appRequests = await trackExecutableEffects(page);
    let releaseConfig!: () => void;
    const configGate = new Promise<void>((resolve) => {
      releaseConfig = resolve;
    });
    let observePolicy!: (policy: MCPAppsPolicy) => void;
    const observedPolicy = new Promise<MCPAppsPolicy>((resolve) => {
      observePolicy = resolve;
    });
    await page.route('**/api/config', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { mcpApps?: MCPAppsPolicy };
      if (!body.mcpApps) {
        await route.fulfill({ response });
        return;
      }
      observePolicy(body.mcpApps);
      await configGate;
      await route.fulfill({ response });
    });

    const navigation = page.goto(`/c/${state.conversationId}`, { waitUntil: 'domcontentloaded' });
    await expect(observedPolicy).resolves.toMatchObject({
      enabled: false,
      legacyHtmlEnabled: false,
      sandboxUrl: process.env.E2E_MCP_SANDBOX_URL,
    });
    expect(await executableFrameCounts(page)).toEqual({ app: 0, legacy: 0 });
    expect(appRequests).toEqual([]);
    releaseConfig();
    await navigation;
    await page.unroute('**/api/config');

    const token = await getAccessToken(page);
    const persistedMessages = await getMessages(page, token, state.conversationId);
    expect(fingerprintMessages(persistedMessages)).toBe(state.messageFingerprint);
    expect(fingerprintUI(persistedMessages)).toBe(state.uiFingerprint);
    const persistedText = JSON.stringify(persistedMessages);
    expect(persistedText).toContain(`E2E MCP App result: ${state.label}`);
    expect(persistedText).toContain(`E2E MCP App result: ${state.retryLabel}`);
    expect(persistedText).toContain(`E2E MCP link App result: ${state.label}`);
    expect(persistedText).toContain(`E2E legacy MCP-UI result: ${state.label}`);
    await expect(
      messagesView(page).getByText(`E2E MCP App complete: ${state.label}`),
    ).toBeVisible();
    await expect(
      messagesView(page).getByText(`E2E MCP App complete: ${state.retryLabel}`),
    ).toBeVisible();
    await expect(
      messagesView(page).getByText(`E2E MCP link App complete: ${state.label}`),
    ).toBeVisible();
    await expect(messagesView(page).getByText('Legacy MCP-UI:', { exact: true })).toBeVisible();
    await expect(page.locator('iframe[data-sandbox-url]')).toHaveCount(0);
    await expect(page.locator(`iframe[title="${LEGACY_FRAME_TITLE}"]`)).toHaveCount(0);
    expect(await executableFrameCounts(page)).toEqual({ app: 0, legacy: 0 });
    expect(appRequests).toEqual([]);
  });

  test('keeps omitted-policy legacy HTML while rejecting new App production', async ({ page }) => {
    test.skip(PHASE !== 'omitted');
    test.setTimeout(120_000);
    const label = randomLabel();
    const appRequests = await trackExecutableEffects(page);

    await resetEvents(page);
    await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
    const token = await getAccessToken(page);
    expect(await getPolicy(page, token)).toMatchObject({
      enabled: false,
      legacyHtmlEnabled: true,
      sandboxUrl: process.env.E2E_MCP_SANDBOX_URL,
    });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await selectMcpAppServer(page);

    const appGeneration = await sendMessageAndWaitForCompletion(page, `E2E_MCP_APP:${label}`);
    expect(appGeneration.ok()).toBeTruthy();
    await expect(messagesView(page).getByText(`E2E MCP App complete: ${label}`)).toBeVisible({
      timeout: 60_000,
    });
    const eventsAfterApp = await readEvents(page);
    expect(
      eventsAfterApp.filter(
        (event) => event.method === 'tools/call:show_app' && event.params.label === label,
      ),
    ).toHaveLength(1);
    expect(eventsAfterApp.filter((event) => event.method === 'resources/read:show_app')).toEqual(
      [],
    );
    await expect(page.locator('iframe[data-sandbox-url]')).toHaveCount(0);

    const appConversationId = new URL(page.url()).pathname.split('/').pop();
    expect(appConversationId).toMatch(/^[0-9a-fA-F-]{36}$/);
    const messagesAfterApp = await getMessages(page, token, appConversationId!);
    expect(JSON.stringify(messagesAfterApp)).toContain(`E2E MCP App result: ${label}`);
    expect(
      uiResources(messagesAfterApp).filter(
        (resource) => resource.mimeType === 'text/html;profile=mcp-app',
      ),
    ).toEqual([]);

    const legacyGeneration = await sendMessageAndWaitForCompletion(
      page,
      `E2E_MCP_LEGACY_MIMELESS:${label}`,
    );
    expect(legacyGeneration.ok()).toBeTruthy();
    await expect(
      messagesView(page).getByText('MIME-less Legacy MCP-UI:', { exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    const legacyElement = page.locator(`iframe[title="${LEGACY_FRAME_TITLE}"]`);
    await expect(legacyElement).toHaveCount(1);
    await expect(
      page
        .frameLocator(`iframe[title="${LEGACY_FRAME_TITLE}"]`)
        .getByTestId('legacy-mimeless-status'),
    ).toHaveText('legacy-mimeless-ready');
    await expect(legacyElement).toHaveCSS('height', '140px');
    const messagesAfterLegacy = await getMessages(page, token, appConversationId!);
    expect(JSON.stringify(messagesAfterLegacy)).toContain(
      `E2E MIME-less legacy MCP-UI result: ${label}`,
    );
    expect(
      uiResources(messagesAfterLegacy).filter(
        (resource) =>
          resource.uri === 'ui://e2e/legacy-mimeless.html' && resource.mimeType === 'text/html',
      ),
    ).toHaveLength(1);
    expect(
      (await readEvents(page)).filter(
        (event) =>
          event.method === 'tools/call:show_legacy_mimeless' && event.params.label === label,
      ),
    ).toHaveLength(1);
    expect((await executableFrameCounts(page))?.app).toBe(0);
    expect((await executableFrameCounts(page))?.legacy).toBe(1);
    expect(appRequests).toEqual([]);
  });

  test('enforces independent configured resource and tool-call quotas', async ({ page }) => {
    test.skip(PHASE !== 'quota');
    test.setTimeout(90_000);
    await resetEvents(page);
    await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
    const token = await getAccessToken(page);
    expect(await getPolicy(page, token)).toMatchObject({
      enabled: true,
      legacyHtmlEnabled: true,
      sandboxUrl: process.env.E2E_MCP_SANDBOX_URL,
    });
    const state = readState();
    const serverBinding = persistedServerBinding(
      await getMessages(page, token, state.conversationId),
    );

    const resources = async () =>
      rawAuthenticatedRequest(page, token, '/api/mcp/resources/list', {
        serverName: 'e2e-app',
        serverBinding,
      });
    expect((await resources()).status).toBe(200);
    expect((await resources()).status).toBe(200);
    const blockedResource = await resources();
    expect(blockedResource.status).toBe(429);
    expect(blockedResource.json).toEqual({
      message: 'Too many app resource requests. Try again later',
    });

    const toolCall = async () =>
      rawAuthenticatedRequest(page, token, '/api/mcp/app-tool-call', {
        serverName: 'e2e-app',
        serverBinding,
        toolName: 'follow_up',
        arguments: { label: 'quota' },
      });
    expect((await toolCall()).status).toBe(200);
    expect((await toolCall()).status).toBe(200);
    const blockedTool = await toolCall();
    expect(blockedTool.status).toBe(429);
    expect(blockedTool.json).toEqual({
      message: 'Too many app tool call requests. Try again later',
    });
    expect(
      (await readEvents(page)).filter(
        (event) => event.method === 'tools/call:follow_up' && event.params.label === 'quota',
      ),
    ).toHaveLength(2);
  });
});
