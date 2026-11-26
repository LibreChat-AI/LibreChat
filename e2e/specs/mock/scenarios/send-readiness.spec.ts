import { randomUUID } from 'node:crypto';
import { getPrimaryE2EUser } from '../../../setup/users.mock';
import { installCodeMocks, LIA_ID, singleMachine, secondMachine } from './codeWorkspaceMocks';
import { deleteConversations, seedConversations, withMongo } from '../db';
import { expect, test } from '../fixtures';
import { sendMessage } from '../helpers';

test('Enter waits for restored workspace readiness @scenario:send-waits-for-restored-workspaces', async ({
  page,
}) => {
  await page.context().addInitScript(() => localStorage.setItem('enterToSend', 'true'));
  await installCodeMocks(page, { environments: [singleMachine(), secondMachine()] });
  const conversationId = randomUUID();
  await seedConversations(getPrimaryE2EUser().email, [
    { conversationId, title: 'Restored workspaces', updatedAt: new Date() },
  ]);
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: string[] = [];
  await page.route('**/api/code-environments/*/status', async (route) => {
    await ready;
    await route.fallback();
  });
  await page.route(/\/api\/agents\/chat(?:\/[^/?]+)?(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    requests.push(route.request().postDataJSON().text);
    await route.fulfill({ status: 200, json: { conversationId } });
  });
  try {
    await withMongo((db) =>
      db.collection('conversations').updateOne(
        { conversationId },
        {
          $set: {
            endpoint: 'agents',
            agent_id: LIA_ID,
            codeEnvironmentMode: 'attached',
            codeWorkspaces: [
              { environmentId: 'env-zimacube', workspaceId: 'librechat' },
              { environmentId: 'env-studio', workspaceId: 'docs' },
            ],
          },
        },
      ),
    );
    await page.goto(`/c/${conversationId}`);
    const input = page.getByRole('textbox', { name: 'Message input' });
    const text = 'Wait for both restored workspaces';
    const sending = sendMessage(page, text);
    await expect(input).toHaveValue(text);
    await expect(page.getByTestId('send-button')).toBeDisabled();
    expect(requests).toEqual([]);
    release();
    const admitted = await sending;
    expect(admitted.ok()).toBe(true);
    expect(requests).toEqual([text]);
  } finally {
    release();
    await deleteConversations([conversationId]);
  }
});
