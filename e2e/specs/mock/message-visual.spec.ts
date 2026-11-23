import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  replyPrompt,
  replyText,
  selectMockEndpoint,
  sendMessage,
  sendMessageAndWaitForCompletion,
} from './helpers';

type VisualTheme = 'light' | 'dark';
type VisualViewport = {
  height: number;
  name: 'desktop' | 'mobile';
  snapshotSuffix: '' | '-mobile';
  width: number;
};

const THEMES: VisualTheme[] = ['light', 'dark'];
const VIEWPORTS: VisualViewport[] = [
  { name: 'desktop', width: 1280, height: 900, snapshotSuffix: '' },
  { name: 'mobile', width: 390, height: 844, snapshotSuffix: '-mobile' },
];
const PROVIDER_C = { label: 'Mock Provider C', model: 'mock-model-c' };
const MCP_SERVER_TITLE = 'E2E Memory';
const VISUAL_OPTIONS = {
  animations: 'disabled' as const,
  caret: 'hide' as const,
  maxDiffPixels: 20,
  scale: 'css' as const,
};

/**
 * Pixel baselines only compare cleanly against the machine that produced them, and this
 * repository tracks none. Until baselines are generated on the runner image itself, the
 * flows below still run and assert their structure, while the screenshot comparison is
 * opt-in through `E2E_VISUAL_SNAPSHOTS=1 npx playwright test --config=e2e/playwright.config.mock.ts --update-snapshots`.
 */
const VISUAL_BASELINES_ENABLED = process.env.E2E_VISUAL_SNAPSHOTS === '1';

const messageRows = (page: Page) => messagesView(page).locator('.message-render');
const userRow = (page: Page) =>
  messageRows(page)
    .filter({ has: page.locator('.user-turn') })
    .last();
const assistantRow = (page: Page) =>
  messageRows(page)
    .filter({ has: page.locator('.agent-turn') })
    .last();
const stopButton = (page: Page) => page.getByRole('button', { name: 'Stop generating' });

async function openChat(page: Page, theme: VisualTheme, viewport: VisualViewport) {
  await page.addInitScript((selectedTheme: VisualTheme) => {
    localStorage.setItem('color-theme', selectedTheme);
    localStorage.removeItem('theme-definition');
    localStorage.removeItem('theme-colors');
    localStorage.removeItem('theme-name');
    localStorage.removeItem('theme-source');
  }, theme);
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await expect(page.locator('html')).toHaveClass(new RegExp(`(^|\\s)${theme}(\\s|$)`));
}

async function expectMessageScreenshot(locator: Locator, name: string) {
  await expect(locator).toBeVisible();
  await locator.scrollIntoViewIfNeeded();
  await locator.page().evaluate(async () => {
    await document.fonts.ready;
  });
  if (!VISUAL_BASELINES_ENABLED) {
    return;
  }
  await expect(locator).toHaveScreenshot(name, VISUAL_OPTIONS);
}

async function selectEphemeralMCP(page: Page) {
  await page.getByRole('button', { name: 'Attach and tools' }).click();
  const serverItem = page
    .getByRole('dialog', { name: 'Attach and tools' })
    .getByRole('button', { name: new RegExp(`^${MCP_SERVER_TITLE}\\b`) });
  await expect(serverItem).toBeVisible();
  await serverItem.click();
  await expect(serverItem).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
}

test.skip(process.platform !== 'linux', 'Message visual baselines target the Linux CI runner');

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`${theme} ${viewport.name} message visuals`, () => {
      test(`captures normal user and assistant messages`, async ({ page }) => {
        await openChat(page, theme, viewport);
        await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

        const normalPrompt =
          viewport.name === 'mobile'
            ? 'Give me a concise plan for a calm morning before a busy day with several appointments.'
            : 'Give me a concise plan for a calm morning.';
        const response = await sendMessageAndWaitForCompletion(page, normalPrompt);
        expect(response.ok()).toBeTruthy();

        await expectMessageScreenshot(
          userRow(page),
          `message-normal-user-${theme}${viewport.snapshotSuffix}.png`,
        );
        await expectMessageScreenshot(
          assistantRow(page),
          `message-normal-assistant-${theme}${viewport.snapshotSuffix}.png`,
        );
      });

      test(`captures an active streaming response`, async ({ page }) => {
        test.setTimeout(60000);
        await openChat(page, theme, viewport);
        await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

        const response = await sendMessage(
          page,
          `E2E_EMPTY_SLOW_REPLY:message-visual-stream-${viewport.name}`,
        );
        expect(response.ok()).toBeTruthy();
        await expect(stopButton(page)).toBeVisible();

        await expectMessageScreenshot(
          assistantRow(page),
          `message-streaming-${theme}${viewport.snapshotSuffix}.png`,
        );

        await stopButton(page).click();
        await expect(stopButton(page)).toBeHidden({ timeout: 30000 });
      });

      test(`captures a user message in edit mode`, async ({ page }) => {
        await openChat(page, theme, viewport);
        await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

        const editPrompt =
          viewport.name === 'mobile'
            ? 'Turn this longer mobile message into an editable draft that wraps across multiple lines.'
            : 'Turn this message into an editable draft.';
        const response = await sendMessageAndWaitForCompletion(page, editPrompt);
        expect(response.ok()).toBeTruthy();

        const row = userRow(page);
        await row.hover();
        const editButton = row.locator('button[id^="edit-"]');
        await expect(editButton).toBeEnabled();
        await editButton.click();
        await expect(row.getByTestId('message-text-editor')).toBeVisible();
        await page.mouse.move(0, 0);

        await expectMessageScreenshot(
          row,
          `message-editing-${theme}${viewport.snapshotSuffix}.png`,
        );
      });

      test(`captures an applied steer message`, async ({ page }) => {
        test.setTimeout(150000);
        await page.addInitScript(() => {
          localStorage.setItem('duringRunDefaultAction', JSON.stringify('steer'));
        });
        const setupLabel = `message-visual-steer-setup-${viewport.name}`;
        const runLabel = `message-visual-steer-${viewport.name}`;
        const steerText =
          viewport.name === 'mobile'
            ? 'Prioritize the three most important steps and keep each one concise.'
            : 'Prioritize the three most important steps.';

        const setupViewport = viewport.name === 'mobile' ? VIEWPORTS[0] : viewport;
        await openChat(page, theme, setupViewport);
        await selectMockEndpoint(page, PROVIDER_C);
        await selectEphemeralMCP(page);

        const setupResponse = await sendMessageAndWaitForCompletion(page, replyPrompt(setupLabel));
        expect(setupResponse.ok()).toBeTruthy();
        await expect(messagesView(page).getByText(replyText(setupLabel))).toBeVisible();

        const runResponse = await sendMessage(page, `E2E_STEER_TOOL_REPLY:${runLabel}`);
        expect(runResponse.ok()).toBeTruthy();

        const input = page.getByRole('textbox', { name: 'Message input' });
        await input.fill(steerText);
        const duringRunSendButton = page.getByTestId('during-run-send-button');
        await expect(duringRunSendButton).toHaveAttribute('data-during-run-action', 'steer');
        await input.press('Enter');

        const steerPart = messagesView(page)
          .getByTestId('steer-part')
          .filter({ hasText: steerText });
        await expect(steerPart).toHaveCount(1, { timeout: 60000 });
        await expect(
          messagesView(page).getByText(`E2E steer tool reply done ${runLabel}`),
        ).toBeVisible({
          timeout: 60000,
        });

        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const closeSidebarButton = page.getByTestId('close-sidebar-button');
        if (viewport.name === 'mobile' && (await closeSidebarButton.isVisible())) {
          await closeSidebarButton.click();
        }

        await expectMessageScreenshot(
          steerPart,
          `message-steered-${theme}${viewport.snapshotSuffix}.png`,
        );
      });
    });
  }
}
