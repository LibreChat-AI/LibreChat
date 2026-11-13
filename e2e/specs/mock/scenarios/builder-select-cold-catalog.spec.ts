import { expect, test } from '@playwright/test';
import type { Request } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../agents.helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  getAccessToken,
  replyPrompt,
  requestJson,
} from '../helpers';

type ChatStart = { endpoint?: string; agent_id?: string };

const isChatStart = (request: Request) =>
  request.method() === 'POST' &&
  /^\/api\/agents\/chat\/(?!abort$|resume$)[^/]+$/.test(new URL(request.url()).pathname);

const isAgentsMapRequest = (request: Request) => {
  const url = new URL(request.url());
  return url.pathname === '/api/agents' && url.searchParams.get('requiredPermission') === '1';
};

test.describe('builder select on a cold agents catalog', () => {
  test('Select starts a chat with the agent before the agents catalog has warmed @scenario:builder-select-applies-before-agents-catalog-warms', async ({
    page,
  }) => {
    test.setTimeout(60000);
    let agentId: string | undefined;

    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      const token = await getAccessToken(page);
      const agent = await requestJson<AgentDetail>(page, {
        path: '/api/agents',
        token,
        method: 'POST',
        body: {
          name: uniqueAgentName('E2E Cold Catalog Agent'),
          instructions: 'Reply to the deterministic end-to-end request.',
          provider: MOCK_ENDPOINTS[0].label,
          model: MOCK_ENDPOINTS[0].model,
        },
      });
      agentId = agent.id;

      /** Catalog warmup waits for an idle main thread. Never granting one holds the agents map
       *  back for the whole test, the state a busy first load leaves a quick user in. */
      await page.addInitScript(() => {
        window.requestIdleCallback = () => 0;
      });
      let agentsMapRequested = false;
      page.on('request', (request) => {
        agentsMapRequested ||= isAgentsMapRequest(request);
      });

      const form = await openAgentBuilder(page);
      await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
      await page.getByRole('option', { name: agent.name! }).click();
      await expect(form.getByLabel('Agent name')).toHaveValue(agent.name!);
      expect(agentsMapRequested, 'the agents catalog must still be cold').toBe(false);
      await form.getByRole('button', { name: 'Select Agent' }).click();

      const input = page.getByRole('textbox', { name: 'Message input' });
      await expect(input).toHaveAttribute('placeholder', `Message ${agent.name}`);
      await input.fill(replyPrompt(`cold-catalog-${Date.now()}`));
      const [start] = await Promise.all([page.waitForRequest(isChatStart), input.press('Enter')]);

      expect(new URL(start.url()).pathname).toBe('/api/agents/chat/agents');
      expect((start.postDataJSON() as ChatStart).agent_id).toBe(agent.id);
    } finally {
      await cleanupAgent(page, agentId);
    }
  });
});
