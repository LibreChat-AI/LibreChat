import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../agents.helpers';
import {
  NEW_CHAT_PATH,
  getAccessToken,
  messagesView,
  requestJson,
  sendMessageAndWaitForCompletion,
  uniqueName,
  uploadViaUnifiedButton,
} from '../helpers';

/** The last word of the attachment-only stand-in, which no other turn of this chat contains. */
const STAND_IN = 'file(s).';

async function createAndSelectAgent(page: Page): Promise<string> {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  const token = await getAccessToken(page);
  const agentName = uniqueAgentName('E2E No Resend Agent');
  const agent = await requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: agentName,
      description: 'Does not send earlier files again.',
      instructions: 'Read the attachment.',
      provider: 'google',
      model: 'gemini-2.5-flash',
      model_parameters: { resendFiles: false },
    },
  });

  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: agentName }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(agentName);
  await form.getByRole('button', { name: 'Select Agent' }).click();
  return agent.id;
}

/** Set up through the agent builder, which the mobile layout keeps in its drawer. */
test.use({ viewport: { width: 1280, height: 860 }, hasTouch: false, isMobile: false });

test.describe('attachment-only turns in history', () => {
  let agentId: string | undefined;

  test.afterEach(async ({ page }) => {
    await cleanupAgent(page, agentId);
    agentId = undefined;
  });

  test('a turn sent with only a file is not replayed empty when files are not resent @scenario:attachment-only-turn-keeps-stand-in', async ({
    page,
  }) => {
    test.setTimeout(120000);
    agentId = await createAndSelectAgent(page);

    const fileName = `${uniqueName('regions')}.txt`;
    const upload = await uploadViaUnifiedButton(page, {
      name: fileName,
      mimeType: 'text/plain',
      content: 'North grew 12 percent, South grew 4 percent.',
    });
    expect(upload.ok()).toBeTruthy();
    await expect(
      page.getByTestId('composer-tray').getByRole('button', { name: fileName, exact: true }),
    ).toBeVisible({ timeout: 15000 });

    await sendMessageAndWaitForCompletion(page, '');
    await sendMessageAndWaitForCompletion(page, `E2E_ASSERT_HISTORY:${STAND_IN}`);

    await expect(
      messagesView(page).getByText(`E2E history assertion present: ${STAND_IN}`),
    ).toBeVisible({ timeout: 30000 });
  });
});
