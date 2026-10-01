import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { AgentDetail } from './agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from './agents.helpers';
import {
  MOCK_ENDPOINTS,
  getAccessToken,
  messagesView,
  replyPrompt,
  replyText,
  requestJson,
  selectMockEndpoint,
  sendMessage,
  sendMessageAndWaitForCompletion,
} from './helpers';

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const DESKTOP_VIEWPORT = { width: 1280, height: 900 };

type NativeWatcher = EventTarget & { requestClose(): void; destroy(): void };
type WatchedWindow = Window & {
  CloseWatcher: new () => NativeWatcher;
  overlayWatchers: Set<NativeWatcher>;
};

async function previousUrl(page: Page): Promise<string> {
  return page.evaluate(() => {
    const { navigation } = window as Window & {
      navigation: {
        currentEntry: { index: number };
        entries(): { index: number; url: string }[];
      };
    };
    const previous = navigation
      .entries()
      .find((entry) => entry.index === navigation.currentEntry.index - 1);
    if (!previous) throw new Error('The fixture must have a real previous history entry');
    return previous.url;
  });
}

async function backClosesOverlay(page: Page, overlay: Locator, chatUrl: string): Promise<void> {
  await expect(overlay).toBeVisible();
  const historyBefore = await page.evaluate(() => ({
    length: history.length,
    state: history.state,
  }));
  await page.evaluate(() => history.back());
  await expect(overlay).toBeHidden();
  await expect(page).toHaveURL(chatUrl);
  expect(await page.evaluate(() => ({ length: history.length, state: history.state }))).toEqual(
    historyBefore,
  );
}

async function enterMobileChat(page: Page): Promise<void> {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(page.getByTestId('header-open-sidebar-button')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message input', exact: true })).toBeVisible();
}

async function prepareMockChat(page: Page, prompt: string): Promise<string> {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  /** Enter through a real SPA link so Back has a same-document destination. */
  await page.goto('/search');
  await page.getByTestId('new-chat-button').click();
  await expect(page).toHaveURL(/\/c\/new/);
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const response = await sendMessageAndWaitForCompletion(page, prompt);
  expect(response.ok()).toBeTruthy();
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden();
  await enterMobileChat(page);
  return page.url();
}

test.describe('supported mobile Back dismisses overlays without changing history', () => {
  test.use({ viewport: MOBILE_VIEWPORT });

  test('keeps the Agent instructions draft when Back closes the expanded editor', async ({
    page,
  }) => {
    const label = 'mobile-instructions-back';
    const chatUrl = await prepareMockChat(page, replyPrompt(label));
    await page.getByTestId('header-open-sidebar-button').click();
    await page.getByTestId('panel-switcher-button').click();
    await page.getByRole('menuitemcheckbox', { name: 'Agent Builder', exact: true }).click();

    const form = page.getByRole('form', { name: 'Agent configuration form' });
    const agentName = uniqueAgentName('E2E Back Draft');
    await form.getByLabel('Agent name').fill(agentName);
    await form.getByRole('button', { name: 'Expand editor', exact: true }).click();

    const editor = page.getByRole('dialog', { name: 'Instructions', exact: true });
    const draft = 'Keep this unsaved instruction draft.\nDo not navigate away from the chat.';
    await editor.getByRole('textbox', { name: 'Instructions', exact: true }).fill(draft);
    await backClosesOverlay(page, editor, chatUrl);
    await expect(form.getByLabel('Instructions', { exact: true })).toHaveValue(draft);
    await expect(form.getByLabel('Agent name')).toHaveValue(agentName);

    await form.getByRole('button', { name: 'Expand editor', exact: true }).click();
    await expect(editor.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue(
      draft,
    );
    await backClosesOverlay(page, editor, chatUrl);
    await page.getByTestId('close-sidebar-button').click();
    await expect(messagesView(page).getByText(replyText(label), { exact: true })).toBeVisible();
    await expect(page).toHaveURL(chatUrl);
  });

  test('returns Settings detail to its list before closing Settings on the next Back', async ({
    page,
  }) => {
    const label = 'mobile-settings-back';
    const chatUrl = await prepareMockChat(page, replyPrompt(label));
    const previous = await previousUrl(page);
    await page.getByTestId('header-open-sidebar-button').click();
    await page.getByTestId('nav-user').click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();

    const settings = page.getByRole('dialog');
    const closeSettings = settings.getByRole('button', { name: 'Close Settings', exact: true });
    const list = settings.getByRole('tablist', { name: 'Settings', exact: true });
    await expect(list).toBeVisible();
    await settings.getByRole('tab', { name: 'General', exact: true }).click();
    const detailBack = settings.getByRole('button', { name: 'Back', exact: true });
    await expect(detailBack).toBeVisible();
    await expect(settings.getByRole('tabpanel')).toBeVisible();
    await expect(list).toBeHidden();

    await page.evaluate(() => history.back());
    await expect(detailBack).toBeHidden();
    await expect(list).toBeVisible();
    await expect(closeSettings).toBeVisible();
    await expect(page).toHaveURL(chatUrl);

    await backClosesOverlay(page, closeSettings, chatUrl);
    await page.getByTestId('close-sidebar-button').click();
    await expect(messagesView(page).getByText(replyText(label), { exact: true })).toBeVisible();
    await expect(page).toHaveURL(chatUrl);
    await page.evaluate(() => history.back());
    await expect(page).toHaveURL(previous);
  });

  test('closes the Artifacts overlay and keeps the conversation and artifact available', async ({
    page,
  }) => {
    const chatUrl = await prepareMockChat(page, 'E2E_MERMAID_ARTIFACT_REPLY');
    const messages = messagesView(page);
    await expect(messages.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible();
    await messages.getByRole('button', { name: 'Open as artifact', exact: true }).click();

    const panel = page.getByRole('dialog', { name: 'Mermaid diagram', exact: true });
    await expect(panel.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible();
    await backClosesOverlay(page, panel, chatUrl);
    const artifact = messages.locator('[data-artifact-trigger^="mermaid-artifact-"]');
    await expect(artifact).toBeVisible();
    await expect(artifact).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('textbox', { name: 'Message input', exact: true })).toBeVisible();

    await artifact.click();
    await expect(panel.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible();
    await backClosesOverlay(page, panel, chatUrl);
    await expect(artifact).toHaveAttribute('aria-expanded', 'false');
  });

  test('keeps a child control draft through first-turn FINAL, then Back closes only the panel', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const label = `mobile-back-${Date.now().toString(36)}`;
    const createdAgentIds: string[] = [];

    try {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await page.goto('/search');
      await page.getByTestId('new-chat-button').click();
      await expect(page).toHaveURL(/\/c\/new/);
      const token = await getAccessToken(page);
      const parentName = uniqueAgentName('E2E Back Parent');
      const childIds: string[] = [];
      for (const name of [
        uniqueAgentName('E2E Back Child A'),
        uniqueAgentName('E2E Back Child B'),
        parentName,
      ]) {
        const agent = await requestJson<AgentDetail>(page, {
          path: '/api/agents',
          token,
          method: 'POST',
          body: {
            name,
            instructions: 'Follow the deterministic end-to-end request exactly.',
            provider: MOCK_ENDPOINTS[0].label,
            model: MOCK_ENDPOINTS[0].model,
            ...(name === parentName
              ? { subagents: { enabled: true, allowSelf: false, agent_ids: childIds } }
              : {}),
          },
        });
        createdAgentIds.push(agent.id);
        if (name !== parentName) {
          childIds.push(agent.id);
        }
      }

      const form = await openAgentBuilder(page);
      await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
      await page.getByRole('option', { name: parentName, exact: true }).click();
      await expect(form.getByLabel('Agent name')).toHaveValue(parentName);
      await form.getByRole('button', { name: 'Select Agent' }).click();
      await enterMobileChat(page);
      const response = await sendMessage(
        page,
        `E2E_SUBAGENT_ACTIVITY_FINAL:${childIds.join(',')}:${label}`,
      );
      expect(response.ok()).toBeTruthy();
      await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}/);
      const initialKey = await page.evaluate(() => history.state.key as string);
      /** FINAL removes the new-chat query parameters from this same conversation. */
      const { origin, pathname } = new URL(page.url());
      const chatUrl = `${origin}${pathname}`;
      const parentReply = messagesView(page).getByText(
        `E2E detached subagents dispatched ${label}`,
      );
      await page.getByRole('button', { name: /(?:Running|Ran) 2 agents/ }).click();
      const cards = page.locator('[data-subagent-tool-call^="call_e2e_subagent_activity_"]');
      await expect(cards).toHaveCount(2);
      await cards.first().click();

      const panel = page.getByRole('dialog', { name: 'Child agent activity', exact: true });
      const input = panel.getByRole('textbox', { name: 'Message input', exact: true });
      const draft = `Unsent child control draft ${label}`;
      await input.fill(draft);
      await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible();
      expect(await page.evaluate(() => history.state.key as string)).toBe(initialKey);
      await expect(panel).toContainText('child-1-phase-10', { timeout: 30_000 });

      /** The changed Router key proves FINAL synchronized /c/new, not just the URL mirror. */
      await expect
        .poll(() => page.evaluate(() => history.state.key as string), { timeout: 30_000 })
        .not.toBe(initialKey);
      await expect(panel).toBeVisible();
      await expect(input).toHaveValue(draft);
      await expect(parentReply).toContainText('chunk-159');
      await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden();
      await expect(page).toHaveURL(chatUrl);
      await backClosesOverlay(page, panel, chatUrl);
      await expect(parentReply).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Message input', exact: true })).toBeVisible();

      await cards.first().click();
      await expect(panel).toContainText(`E2E detached child 1 complete ${label}`, {
        timeout: 30_000,
      });
      await backClosesOverlay(page, panel, chatUrl);
      await expect(parentReply).toBeVisible();
    } finally {
      for (const agentId of createdAgentIds.reverse()) {
        await cleanupAgent(page, agentId);
      }
    }
  });

  test('preserves Forward after explicit close and after Back, reopen, and dismissal', async ({
    page,
  }) => {
    const chatUrl = await prepareMockChat(page, replyPrompt('forward-preserved'));
    const previous = await previousUrl(page);
    await page.getByTestId('header-new-chat-button').click();
    await expect(page).toHaveURL(/\/c\/new/);
    const nextUrl = page.url();
    await page.goBack();
    await expect(page).toHaveURL(chatUrl);
    const length = await page.evaluate(() => history.length);

    for (const explicit of [true, false]) {
      await page.getByTestId('header-open-sidebar-button').click();
      await page.getByTestId('nav-user').click();
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
      const settings = page.getByRole('dialog');
      const closeSettings = settings.getByRole('button', { name: 'Close Settings', exact: true });
      await expect(closeSettings).toBeVisible();
      if (explicit) {
        await closeSettings.click();
        await expect(closeSettings).toBeHidden();
      } else {
        await backClosesOverlay(page, closeSettings, chatUrl);
      }
      await page.getByTestId('close-sidebar-button').click();
      expect(await page.evaluate(() => history.length)).toBe(length);
      await page.goForward();
      await expect(page).toHaveURL(nextUrl);
      await page.goBack();
      await expect(page).toHaveURL(chatUrl);
    }
    await page.goBack();
    await expect(page).toHaveURL(previous);
  });

  test('native close requests dismiss one Settings layer at a time without history changes', async ({
    page,
  }) => {
    /** Observe real native instances, rather than replacing their close-event behavior. */
    await page.addInitScript(() => {
      const browser = window as WatchedWindow;
      const NativeCloseWatcher = browser.CloseWatcher;
      browser.overlayWatchers = new Set();
      browser.CloseWatcher = class extends NativeCloseWatcher {
        constructor() {
          super();
          browser.overlayWatchers.add(this);
          this.addEventListener('close', () => browser.overlayWatchers.delete(this));
        }
        destroy() {
          browser.overlayWatchers.delete(this);
          super.destroy();
        }
      };
    });
    const chatUrl = await prepareMockChat(page, replyPrompt('native-close'));
    const historyBefore = await page.evaluate(() => ({
      length: history.length,
      state: history.state,
    }));
    await page.getByTestId('header-open-sidebar-button').click();
    await page.getByTestId('nav-user').click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog');
    await settings.getByRole('tab', { name: 'General', exact: true }).click();
    await expect(settings.getByRole('tabpanel')).toBeVisible();
    for (const detail of [true, false]) {
      await expect
        .poll(() => page.evaluate(() => (window as WatchedWindow).overlayWatchers.size))
        .toBe(1);
      await page.evaluate(() => [...(window as WatchedWindow).overlayWatchers][0].requestClose());
      if (detail)
        await expect(
          settings.getByRole('tablist', { name: 'Settings', exact: true }),
        ).toBeVisible();
      else await expect(settings).toBeHidden();
    }
    await expect
      .poll(() => page.evaluate(() => (window as WatchedWindow).overlayWatchers.size))
      .toBe(0);
    await expect(page).toHaveURL(chatUrl);
    expect(await page.evaluate(() => ({ length: history.length, state: history.state }))).toEqual(
      historyBefore,
    );
  });

  test('leaves cross-document Back and Forward to the browser', async ({ page }) => {
    const chatUrl = await prepareMockChat(page, replyPrompt('cross-document-back'));
    await page.goto('/search');
    await page.goto(chatUrl);
    await enterMobileChat(page);
    const length = await page.evaluate(() => history.length);
    await page.getByTestId('header-open-sidebar-button').click();
    await page.getByTestId('nav-user').click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Close Settings', exact: true })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/search$/);
    await page.goForward();
    await expect(page).toHaveURL(chatUrl);
    expect(await page.evaluate(() => history.length)).toBe(length);
  });
});
