import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH, messagesView, selectMockEndpoint, sendMessage } from '../helpers';

const ENDPOINT = { label: 'Mock Provider F', model: 'mock-model-f' };
const MCP_SERVER_TITLE = 'E2E Memory';
const uniqueLabel = () => `peek-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

async function enableMemoryServer(page: Page) {
  await page.getByRole('button', { name: 'Attach and tools' }).click();
  const item = page
    .getByRole('dialog', { name: 'Attach and tools' })
    .getByRole('button', { name: new RegExp(`^${MCP_SERVER_TITLE}\\b`) });
  await expect(item).toBeVisible();
  await item.click();
  await expect(item).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listitem', { name: MCP_SERVER_TITLE, exact: true })).toBeVisible();
}

/** Sample the peek until the final text lands; report whether it was ever visible. */
async function peekSamples(page: Page, finalText: string) {
  const peek = messagesView(page).getByTestId('streaming-thought-peek');
  const final = messagesView(page).getByText(finalText);
  const samples = { total: 0, visible: 0 };
  for (let index = 0; index < 300; index += 1) {
    if (await final.isVisible().catch(() => false)) {
      break;
    }
    samples.total += 1;
    if (await peek.isVisible().catch(() => false)) {
      samples.visible += 1;
    }
    await page.waitForTimeout(100);
  }
  return samples;
}

test.describe('streaming thought peek', () => {
  test('the peek shows only while pure reasoning streams @scenario:thought-peek-only-while-thinking', async ({
    page,
  }) => {
    test.setTimeout(180000);

    /** Pure reasoning: the peek sits under the collapsed card. */
    const reasoning = uniqueLabel();
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, ENDPOINT);
    const first = await sendMessage(page, `E2E_SLOW_THINK_REPLY:${reasoning}`);
    expect(first.ok()).toBeTruthy();
    const pure = await peekSamples(page, `E2E slow think reply done ${reasoning}`);
    expect(pure.visible, 'peek during pure reasoning').toBeGreaterThan(0);
    await expect(
      messagesView(page).getByText(`E2E slow think reply done ${reasoning}`),
    ).toBeVisible({ timeout: 60000 });

    /** A thought that streams after a tool call never shows the peek. */
    const afterTool = uniqueLabel();
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    /** The endpoint choice persists across new chats on some viewports only. */
    const trigger = page.getByRole('button', { name: 'Select a model' }).first();
    await expect(trigger).toBeVisible();
    if (!(await trigger.textContent())?.includes(ENDPOINT.model)) {
      await selectMockEndpoint(page, ENDPOINT);
    }
    await enableMemoryServer(page);
    const second = await sendMessage(page, `E2E_TOOL_THEN_THINK_REPLY:${afterTool}`);
    expect(second.ok()).toBeTruthy();
    const finalText = `E2E tool then think reply done ${afterTool}`;
    const toolRun = await peekSamples(page, finalText);
    expect(toolRun.total, 'sampled while streaming').toBeGreaterThan(5);
    expect(toolRun.visible, 'peek after a tool call').toBe(0);
    await expect(messagesView(page).getByText(finalText)).toBeVisible({ timeout: 60000 });
    /** The run really was a tool call followed by a thought, not a bare reply. */
    await expect(
      messagesView(page)
        .getByRole('button', { name: /Thoughts|Thinking|remember|Memory/i })
        .first(),
    ).toBeVisible();
  });
});
