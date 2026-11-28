import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../agents.helpers';
import {
  CODE_API_BASE,
  NEW_CHAT_PATH,
  MOCK_ENDPOINTS,
  mockReply,
  uniqueName,
  requestJson,
  sendMessage,
  messagesView,
  getAccessToken,
  getCodeProvisionedUploads,
  sendMessageAndWaitForCompletion,
} from '../helpers';

/**
 * An agent's Run Code file is uploaded to the code environment again whenever its stored copy
 * there is not confirmed live, which the fake code server never confirms. One such upload that
 * reaches the server and then fails has an unknown outcome; the next turn must still upload the
 * file again instead of failing the same way for as long as the server process runs.
 */

test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

async function createAgent(page: Page): Promise<AgentDetail> {
  const token = await getAccessToken(page);
  return requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: uniqueAgentName('E2E Code File Agent'),
      instructions: 'Answer briefly.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      model_parameters: {},
      tools: ['execute_code'],
    },
  });
}

async function attachCodeFile(page: Page, agentId: string, filename: string) {
  const token = await getAccessToken(page);
  const response = await page.request.post('/api/files', {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      endpoint: 'agents',
      agent_id: agentId,
      tool_resource: 'execute_code',
      file_id: randomUUID(),
      file: { name: filename, mimeType: 'text/plain', buffer: Buffer.from('ROWS = 3\n') },
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function selectAgent(page: Page, agent: AgentDetail) {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: agent.name }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(agent.name ?? '');
  await form.getByRole('button', { name: 'Select Agent' }).click();
}

const uploadsOf = async (page: Page, filename: string) =>
  (await getCodeProvisionedUploads(page)).filter((upload) => upload.filename === filename);

test('an agent answers the next message after its Run Code file upload failed once @scenario:agent-code-file-recovers-after-lost-upload', async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  const agent = await createAgent(page);
  try {
    const filename = `${uniqueName('table')}.txt`;
    await attachCodeFile(page, agent.id, filename);
    expect(await uploadsOf(page, filename)).toHaveLength(1);
    await selectAgent(page, agent);

    const failed = await page.request.post(`${CODE_API_BASE}/__debug/fail-uploads`, {
      data: { filename, status: 500 },
    });
    expect(failed.ok()).toBeTruthy();
    await sendMessage(page, 'Use the table file.');
    await expect(messagesView(page).getByText(/could not be restored/)).toBeVisible({
      timeout: 30000,
    });
    expect(await uploadsOf(page, filename)).toHaveLength(1);

    /* The failed turn never saved its conversation, so the next message starts a new chat. */
    await selectAgent(page, agent);
    await sendMessageAndWaitForCompletion(page, 'Try the table file again.');
    await expect(mockReply(page).last()).toBeVisible();
    const uploads = await uploadsOf(page, filename);
    expect(uploads).toHaveLength(2);
    expect(uploads[1]).toMatchObject({ kind: 'agent', id: agent.id });
  } finally {
    await cleanupAgent(page, agent.id);
  }
});
