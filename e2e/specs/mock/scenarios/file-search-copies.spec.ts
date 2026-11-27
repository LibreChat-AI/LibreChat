import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { UploadedFile } from '../helpers';
import type { AgentDetail } from '../agents.helpers';
import { cleanupAgent } from '../agents.helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  uniqueName,
  requestJson,
  seedRagCopy,
  messagesView,
  getRagAnswers,
  getAccessToken,
  getRagEmbedded,
  resetProvisioning,
  sendMessageAndWaitForCompletion,
} from '../helpers';

const PASSAGE = 'Either party may terminate with 30 days notice.';

/**
 * An agent's File Search reads the copies of a file owned by the agent and by the requesting
 * user, so a user who also holds the agent's file under their own id gets every passage from
 * both copies. The results must still list each passage once.
 */
test.describe('file_search stored copies', () => {
  test('an agent file the user also holds lists each passage once @scenario:file-search-duplicate-copies-shown-once', async ({
    page,
  }) => {
    test.setTimeout(180000);
    let agentId: string | undefined;
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });

    try {
      const token = await getAccessToken(page);
      const me = await requestJson<{ id?: string; _id?: string }>(page, {
        path: '/api/user',
        token,
      });
      const userId = me.id ?? me._id;
      expect(userId, 'the signed-in user should have an id').toBeTruthy();

      const agent = await requestJson<AgentDetail>(page, {
        path: '/api/agents',
        token,
        method: 'POST',
        body: {
          name: uniqueName('search-copies-agent'),
          description: 'File Search copies fixture.',
          instructions: 'Search the attached files.',
          provider: MOCK_ENDPOINTS[0].label,
          model: MOCK_ENDPOINTS[0].model,
          tools: ['file_search'],
        },
      });
      agentId = agent.id;

      const fileName = `${uniqueName('search-copies')}.txt`;
      const upload = await page.request.post('/api/files', {
        headers: { Authorization: `Bearer ${token}` },
        multipart: {
          endpoint: MOCK_ENDPOINTS[0].label,
          endpointType: 'custom',
          agent_id: agentId,
          tool_resource: 'file_search',
          file_id: randomUUID(),
          file: { name: fileName, mimeType: 'text/plain', buffer: Buffer.from(PASSAGE) },
        },
      });
      expect(upload.ok(), await upload.text()).toBeTruthy();
      /* The server assigns the stored id; the fake RAG records it rather than a name. */
      const fileId = ((await upload.json()) as UploadedFile).file_id as string;
      expect(fileId, 'upload response should include a file_id').toBeTruthy();
      await expect
        .poll(async () => (await getRagEmbedded(page)).map((e) => e.file_id), { timeout: 15000 })
        .toContain(fileId);

      /* The user's own copy of the same file, as attaching it to another chat embeds it. */
      await seedRagCopy(page, { file_id: fileId, filename: fileName, user_id: userId });
      await resetProvisioning(page);

      await page.goto(`${NEW_CHAT_PATH}?agent_id=${encodeURIComponent(agentId)}`, {
        timeout: 10000,
      });
      await sendMessageAndWaitForCompletion(page, `E2E_FILE_SEARCH:${uniqueName('rag-hit')}`);
      const answered = (await getRagAnswers(page)).filter((answer) => answer.file_id === fileId);
      expect(
        answered.map((answer) => [...answer.owners].sort()),
        "RAG answers the search from the agent's copy and the user's",
      ).toEqual([[agentId, userId].sort()]);

      const view = messagesView(page);
      await view.getByRole('button', { name: /searched your files/i }).click();
      const previews = view.getByRole('button', { name: `Preview: ${fileName}` });
      await expect(previews.first()).toBeVisible();
      await expect(previews).toHaveCount(1);
      await expect(view.getByText(PASSAGE, { exact: true })).toHaveCount(1);
    } finally {
      await cleanupAgent(page, agentId);
    }
  });
});
