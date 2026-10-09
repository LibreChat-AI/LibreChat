import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  isAgentsStream,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  escapeRegExp,
  fetchJson,
  getAccessToken,
  replyPrompt,
  replyText,
  requestJson,
  selectMockEndpoint,
} from './helpers';

const DESCRIPTION = 'Use this prompt to verify LibreChat prompt creation in mock e2e tests.';
const COMMAND = 'e2e-prompt';

type Prompt = {
  _id?: string;
  groupId: string;
  prompt: string;
  type: 'text' | 'chat';
};

type PromptGroup = {
  _id?: string;
  name: string;
  oneliner?: string;
  command?: string;
  productionPrompt?: Pick<Prompt, 'prompt'> | null;
};

type PromptGroupListResponse = {
  promptGroups?: PromptGroup[];
};

const uniquePromptName = () => `E2E Prompt ${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

async function findPromptGroup(
  page: Page,
  promptName: string,
  token: string,
): Promise<PromptGroup | null> {
  const body = await fetchJson<PromptGroupListResponse>(
    page,
    `/api/prompts/groups?name=${encodeURIComponent(promptName)}&limit=10`,
    token,
  );
  return body.promptGroups?.find((group) => group.name === promptName) ?? null;
}

async function waitForPersistedPrompt(
  page: Page,
  promptName: string,
  expectedPrompt: string,
): Promise<{ group: PromptGroup; prompts: Prompt[] }> {
  const token = await getAccessToken(page);
  let latestGroup: PromptGroup | null = null;
  let latestPrompts: Prompt[] = [];

  for (let attempt = 0; attempt < 20; attempt++) {
    const group = await findPromptGroup(page, promptName, token);
    if (group?._id) {
      latestGroup = await fetchJson<PromptGroup>(
        page,
        `/api/prompts/groups/${encodeURIComponent(group._id)}`,
        token,
      );
      latestPrompts = await fetchJson<Prompt[]>(
        page,
        `/api/prompts?groupId=${encodeURIComponent(group._id)}`,
        token,
      );

      const hasExpectedPrompt = latestPrompts.some((prompt) => prompt.prompt === expectedPrompt);
      if (
        latestGroup.oneliner === DESCRIPTION &&
        latestGroup.command === COMMAND &&
        latestGroup.productionPrompt?.prompt === expectedPrompt &&
        hasExpectedPrompt
      ) {
        return { group: latestGroup, prompts: latestPrompts };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  expect(latestGroup, `Expected prompt group "${promptName}" to be persisted`).not.toBeNull();
  expect(latestGroup?.oneliner).toBe(DESCRIPTION);
  expect(latestGroup?.command).toBe(COMMAND);
  expect(latestGroup?.productionPrompt?.prompt).toBe(expectedPrompt);
  expect(latestPrompts.some((prompt) => prompt.prompt === expectedPrompt)).toBe(true);
  return { group: latestGroup!, prompts: latestPrompts };
}

async function cleanupPromptGroup(page: Page, groupId?: string) {
  if (!groupId) {
    return;
  }

  const token = await getAccessToken(page);
  await requestJson<{ message?: string }>(page, {
    path: `/api/prompts/groups/${encodeURIComponent(groupId)}`,
    token,
    method: 'DELETE',
  });
}

async function openPromptsPanel(page: Page) {
  const promptsButton = page.getByRole('button', { name: 'Prompts', exact: true });
  await expect(promptsButton).toBeVisible();
  if ((await promptsButton.getAttribute('aria-pressed')) !== 'true') {
    await promptsButton.click();
  }
  await expect(page.getByRole('search')).toBeVisible();
}

async function ensureAutoSendPrompts(page: Page) {
  const autoSend = page.getByRole('button', { name: 'Send prompts on select' });
  await expect(autoSend).toBeVisible();
  if ((await autoSend.getAttribute('aria-pressed')) !== 'true') {
    await autoSend.click();
  }
  await expect(autoSend).toHaveAttribute('aria-pressed', 'true');
}

test.describe('prompt manager', () => {
  test('creates a prompt and can send it from chat', async ({ page }) => {
    test.setTimeout(120000);

    const promptName = uniquePromptName();
    const label = promptName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const promptText = replyPrompt(label);
    let createdGroupId: string | undefined;

    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      await openPromptsPanel(page);

      await page.getByRole('button', { name: 'Create Prompt' }).click();

      /** Prompts are created from a dialog rather than a dedicated page */
      const createDialog = page.getByRole('dialog');
      await expect(createDialog).toBeVisible();

      await createDialog.getByRole('textbox', { name: 'Prompt Name' }).fill(promptName);
      await createDialog.getByRole('textbox', { name: 'Prompt text input field' }).fill(promptText);
      await createDialog
        .getByRole('textbox', { name: 'Optional: Enter a description to display for the prompt' })
        .fill(DESCRIPTION);
      await createDialog
        .getByRole('textbox', {
          name: 'Optional: Enter a command for the prompt or name will be used',
        })
        .fill(COMMAND);

      const [createResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === '/api/prompts' &&
            response.status() >= 200 &&
            response.status() < 300,
          { timeout: 30000 },
        ),
        createDialog.getByRole('button', { name: 'Create Prompt' }).click(),
      ]);
      const createdPrompt = (await createResponse.json()) as {
        group?: PromptGroup;
        prompt?: Prompt;
      };
      createdGroupId = createdPrompt.group?._id ?? createdPrompt.prompt?.groupId;

      const { group } = await waitForPersistedPrompt(page, promptName, promptText);
      createdGroupId = group._id ?? createdGroupId;
      expect(createdGroupId).toBeTruthy();
      await expect(page).toHaveURL(new RegExp(`/prompts/${createdGroupId}$`));
      await expect(page.getByRole('button', { name: `Edit: ${promptName}` })).toBeVisible();

      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
      await openPromptsPanel(page);
      await ensureAutoSendPrompts(page);

      await page.getByLabel('Filter prompts by name').fill(promptName);
      const promptCard = page.getByRole('button', {
        name: new RegExp(`^${escapeRegExp(promptName)} prompt`),
      });
      await expect(promptCard).toBeVisible({ timeout: 10000 });

      const [response] = await Promise.all([
        page.waitForResponse(isAgentsStream, { timeout: 30000 }),
        promptCard.click(),
      ]);
      expect(response.ok()).toBeTruthy();

      await expect(page.getByTestId('messages-view').getByText(promptText)).toBeVisible();
      await expect(page.getByTestId('messages-view').getByText(replyText(label))).toBeVisible({
        timeout: 30000,
      });
    } finally {
      await cleanupPromptGroup(page, createdGroupId);
    }
  });
});
