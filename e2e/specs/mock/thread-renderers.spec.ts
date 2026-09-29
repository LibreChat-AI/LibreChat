import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AgentDetail } from './agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from './agents.helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  getAccessToken,
  isAgentsStream,
  messagesView,
  requestJson,
  selectMockEndpoint,
  sendMessage,
  sendMessageAndWaitForCompletion,
} from './helpers';

/**
 * Differential check of the two message-thread renderers. One conversation is
 * built through the real pipeline with the content shapes the seeded
 * benchmarks never produce (a regenerated branch, reasoning, markdown with a
 * table and code, provider attachments, and detached subagent activity), then
 * rendered by the flat list and by the recursive tree in turn. Both must
 * produce the same transcript, sibling counters, and activity groups, before
 * and after cycling a branch.
 */

type Transcript = {
  rows: string[];
  siblingCounters: string[];
  attachments: string[];
  activityGroups: number;
};

const uniqueLabel = (name: string) => `${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const countedPrompt = (label: string) => `E2E_COUNTED_REPLY:${label}`;
const countedReplyText = (label: string, count: number) => `E2E counted reply ${label} #${count}`;
const thinkPrompt = (label: string) => `E2E_THINK_REPLY:${label}`;
const thinkReplyText = (label: string) => `E2E reply ${label}`;
const PARAGRAPHS_PROMPT = 'E2E_PARAGRAPHS_REPLY';
const CLOSING_PARAGRAPH = 'E2E closing paragraph';
const SUBAGENT_ACTIVITY_MARKER = 'E2E_SUBAGENT_ACTIVITY:';

const textFixture = {
  name: 'renderer-context.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('This text attachment rides the message into both renderers.\n'),
};

const messageRender = (page: Page, text: string) =>
  page.locator('.message-render').filter({ hasText: text }).last();

async function setRenderer(page: Page, flat: boolean) {
  await page.evaluate((value) => {
    localStorage.setItem('LC_FLAT_THREAD', value ? 'true' : 'false');
  }, flat);
  await page.reload({ timeout: 15_000 });
}

/** Text a viewer sees, with clocks, relative ages and whitespace normalized so time passing between captures cannot differ. */
async function captureTranscript(page: Page, settledText: string): Promise<Transcript> {
  await expect(messagesView(page).getByText(settledText)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden();
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const normalize = (value: string) =>
      value
        .replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?\b/gi, '')
        .replace(/(\d+|\ban?)\s+(second|minute|hour|day)s?\s+ago\b/gi, '')
        .replace(/\bjust now\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    const view = document.querySelector('[data-testid="messages-view"]');
    if (!view) {
      throw new Error('messages view missing');
    }
    const rows = Array.from(view.querySelectorAll('.message-render')).map((row) =>
      normalize((row as HTMLElement).innerText),
    );
    const siblingCounters = Array.from(view.querySelectorAll('nav [role="status"]')).map((node) =>
      normalize((node as HTMLElement).innerText),
    );
    const attachments = Array.from(view.querySelectorAll('button'))
      .map((button) => button.getAttribute('aria-label') ?? button.textContent ?? '')
      .filter((name) => /\.(txt|png)$/i.test(name.trim()))
      .map((name) => name.trim());
    const activityGroups = Array.from(view.querySelectorAll('button')).filter((button) =>
      /^Ran \d+ agents?$/.test(button.textContent?.trim() ?? ''),
    ).length;
    return { rows, siblingCounters, attachments, activityGroups };
  });
}

async function clickMessageTitleButton(page: Page, text: string, title: string) {
  const render = messageRender(page, text);
  await render.scrollIntoViewIfNeeded();
  await render.hover();
  await render.getByRole('button', { name: title, exact: true }).last().click();
}

async function clickSibling(page: Page, text: string, direction: 'Previous' | 'Next') {
  const render = messageRender(page, text);
  await render.scrollIntoViewIfNeeded();
  await render.hover();
  await render.getByRole('button', { name: `${direction} sibling message` }).click();
}

async function sendAndExpectReply(page: Page, prompt: string, expectedReply: string) {
  const response = await sendMessage(page, prompt);
  expect(response.ok()).toBeTruthy();
  await expect(messagesView(page).getByText(expectedReply)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
    timeout: 30_000,
  });
}

async function uploadProviderFile(page: Page) {
  await page.getByRole('button', { name: 'Attach File Options' }).click();
  await expect(page.getByText('Upload to Provider')).toBeVisible();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByText('Upload to Provider').click();
  const fileChooser = await fileChooserPromise;
  const uploadResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/api/files') &&
      response.request().method() === 'POST' &&
      response.status() === 200,
    { timeout: 30_000 },
  );
  await fileChooser.setFiles(textFixture);
  expect((await uploadResponse).ok()).toBeTruthy();
  await page.waitForTimeout(350);
}

async function createAgent(
  page: Page,
  token: string,
  name: string,
  subagents?: AgentDetail['subagents'],
): Promise<AgentDetail> {
  return requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description: 'Playwright renderer parity: detached child activity.',
      instructions: 'Follow the deterministic end-to-end request exactly.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      subagents,
    },
  });
}

async function selectAgent(page: Page, name: string): Promise<void> {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(name);
  await form.getByRole('button', { name: 'Select Agent' }).click();
}

test.describe('thread renderers', () => {
  test('flat and recursive renderers agree on a branched, rich conversation', async ({ page }) => {
    test.setTimeout(240_000);
    const label = uniqueLabel('renderers');
    const firstReply = countedReplyText(label, 1);
    const regeneratedReply = countedReplyText(label, 2);
    const fileReply = `E2E provider file assertion passed: ${textFixture.name}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await sendAndExpectReply(page, countedPrompt(label), firstReply);
    const [regenerate] = await Promise.all([
      page.waitForResponse(isAgentsStream, { timeout: 30_000 }),
      clickMessageTitleButton(page, firstReply, 'Regenerate'),
    ]);
    expect(regenerate.ok()).toBeTruthy();
    await expect(messagesView(page).getByText(regeneratedReply)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
      timeout: 30_000,
    });
    await sendAndExpectReply(page, thinkPrompt(label), thinkReplyText(label));
    await sendAndExpectReply(page, PARAGRAPHS_PROMPT, CLOSING_PARAGRAPH);
    await uploadProviderFile(page);
    await sendAndExpectReply(page, `E2E_ASSERT_PROVIDER_FILE:${textFixture.name}`, fileReply);

    await setRenderer(page, false);
    const tree = await captureTranscript(page, fileReply);
    await clickSibling(page, regeneratedReply, 'Previous');
    const treeOlderBranch = await captureTranscript(page, firstReply);

    await setRenderer(page, true);
    const flat = await captureTranscript(page, fileReply);
    await clickSibling(page, regeneratedReply, 'Previous');
    const flatOlderBranch = await captureTranscript(page, firstReply);
    await clickSibling(page, firstReply, 'Next');
    await expect(messagesView(page).getByText(regeneratedReply)).toBeVisible();

    expect(tree.rows.length).toBeGreaterThanOrEqual(8);
    expect(tree.siblingCounters).toEqual(['2 / 2']);
    expect(tree.attachments).toContain(textFixture.name);
    expect(treeOlderBranch.rows.length).toBe(2);
    expect(treeOlderBranch.siblingCounters).toEqual(['1 / 2']);
    expect(flat).toEqual(tree);
    expect(flatOlderBranch).toEqual(treeOlderBranch);
  });

  test('flat and recursive renderers agree on detached subagent activity', async ({ page }) => {
    test.setTimeout(240_000);
    const label = `renderers-${Date.now().toString(36)}`;
    const createdAgentIds: string[] = [];
    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
      const token = await getAccessToken(page);
      const children: AgentDetail[] = [];
      for (const childName of [
        uniqueAgentName('E2E Renderer Child A'),
        uniqueAgentName('E2E Renderer Child B'),
      ]) {
        const child = await createAgent(page, token, childName);
        children.push(child);
        createdAgentIds.push(child.id);
      }
      const parentName = uniqueAgentName('E2E Renderer Parent');
      const parent = await createAgent(page, token, parentName, {
        enabled: true,
        allowSelf: false,
        agent_ids: children.map((child) => child.id),
      });
      createdAgentIds.push(parent.id);
      await selectAgent(page, parentName);

      const response = await sendMessageAndWaitForCompletion(
        page,
        `${SUBAGENT_ACTIVITY_MARKER}${children.map((child) => child.id).join(',')}:${label}`,
      );
      expect(response.ok()).toBeTruthy();
      const groupButton = page.getByRole('button', { name: 'Ran 2 agents' });
      await expect(groupButton).toBeVisible({ timeout: 30_000 });
      const settledText = await groupButton.textContent();
      expect(settledText).toBeTruthy();

      await setRenderer(page, false);
      const tree = await captureTranscript(page, settledText as string);
      await setRenderer(page, true);
      const flat = await captureTranscript(page, settledText as string);

      expect(tree.activityGroups).toBe(1);
      expect(flat).toEqual(tree);
    } finally {
      for (const agentId of createdAgentIds) {
        await cleanupAgent(page, agentId);
      }
    }
  });
});
