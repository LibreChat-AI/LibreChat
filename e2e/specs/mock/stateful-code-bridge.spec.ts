import { expect, request as playwrightRequest, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AgentDetail } from './agents.helpers';
import cleanupUser from '../../setup/cleanupUser';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from './agents.helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  getAccessToken,
  messagesView,
  requestJson,
  sendMessage,
} from './helpers';

const CODE_VALUE = 'librechat-bridge-persisted';

interface PairingResponse {
  environmentId: string;
  workerId: string;
  code: string;
  expiresAt: string;
}

interface RegisteredEnvironment {
  resourceId: string;
  id: string;
  name: string;
  type: 'attached';
  configSchema?: {
    permissions?: {
      fileWrite?: { allowed: string[]; default: string };
      commandExecution?: { allowed: string[]; default: string };
    };
  };
  settings?: {
    permissions?: { fileWrite?: string; commandExecution?: string };
  };
}

interface EnvironmentStatus {
  environmentId: string;
  status: 'offline' | 'starting' | 'ready';
  leaseExpiresInMs?: number;
  sandboxProfile?: string;
  runtimes?: string[];
  operations?: string[];
}

interface PersistedMessage {
  messageId?: string;
  isCreatedByUser?: boolean;
  unfinished?: boolean;
  text?: string;
}

async function sendApprovedCommand(page: Page, prompt: string) {
  const token = await getAccessToken(page);
  const commandOutputs = messagesView(page).getByText(`stdout: ${CODE_VALUE}`, { exact: false });
  const existingOutputCount = await commandOutputs.count();
  const existingConversationId = new URL(page.url()).pathname.match(/^\/c\/([^/]+)$/)?.[1];
  const existingMessages = existingConversationId
    ? await requestJson<PersistedMessage[]>(page, {
        path: `/api/messages/${encodeURIComponent(existingConversationId)}`,
        token,
      })
    : [];
  const existingMessageIds = new Set(existingMessages.map(({ messageId }) => messageId));
  const response = await sendMessage(page, prompt);
  expect(response.ok()).toBe(true);
  await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });

  const approval = messagesView(page).getByTestId('tool-approval').last();
  await expect(approval).toBeVisible({ timeout: 30000 });
  await approval.getByRole('button', { name: 'Approve' }).click();
  const submit = approval.getByRole('button', { name: 'Submit' });
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(commandOutputs).toHaveCount(existingOutputCount + 1, { timeout: 30000 });
  const conversationId = new URL(page.url()).pathname.replace(/^\/c\//, '');
  await expect
    .poll(
      async () => {
        const messages = await requestJson<PersistedMessage[]>(page, {
          path: `/api/messages/${encodeURIComponent(conversationId)}`,
          token,
        });
        return messages.some(
          (message) =>
            !existingMessageIds.has(message.messageId) &&
            message.isCreatedByUser === false &&
            message.unfinished === false,
        );
      },
      { timeout: 30000, intervals: [250, 500, 1000] },
    )
    .toBe(true);
}

test.describe('attached stateful code environment', () => {
  test.skip(!process.env.E2E_CODE_BRIDGE_URL, 'E2E_CODE_BRIDGE_URL is required');

  test('persists only the BYOM permissions exposed by the administrator', async ({ page }) => {
    test.skip(
      !process.env.E2E_CODE_BRIDGE_ADMIN_TOKEN,
      'E2E_CODE_BRIDGE_ADMIN_TOKEN is required for deployment-worker registration',
    );
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    const token = await getAccessToken(page);
    let environmentId: string | undefined;
    try {
      const registration = await requestJson<{ environment: RegisteredEnvironment }>(page, {
        path: '/api/code-environments',
        token,
        method: 'POST',
        body: { name: 'E2E configurable VM', controlPlaneId: 'e2e-vm' },
      });
      environmentId = registration.environment.id;

      const discovery = await requestJson<{ environments: RegisteredEnvironment[] }>(page, {
        path: '/api/code-environments',
        token,
      });
      expect(discovery.environments).toContainEqual(
        expect.objectContaining({
          id: environmentId,
          configSchema: {
            permissions: {
              fileWrite: { allowed: ['allow', 'ask', 'deny'], default: 'ask' },
              commandExecution: { allowed: ['ask', 'deny'], default: 'ask' },
            },
          },
        }),
      );

      const update = await requestJson<{ environment: RegisteredEnvironment }>(page, {
        path: `/api/code-environments/${environmentId}/settings`,
        token,
        method: 'PATCH',
        body: { settings: { permissions: { fileWrite: 'allow' } } },
      });
      expect(update.environment.settings).toEqual({
        permissions: { fileWrite: 'allow' },
      });
      const secondUpdate = await requestJson<{ environment: RegisteredEnvironment }>(page, {
        path: `/api/code-environments/${environmentId}/settings`,
        token,
        method: 'PATCH',
        body: { settings: { permissions: { commandExecution: 'deny' } } },
      });
      expect(secondUpdate.environment.settings).toEqual({
        permissions: { fileWrite: 'allow', commandExecution: 'deny' },
      });

      const invalid = await page.request.patch(`/api/code-environments/${environmentId}/settings`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { settings: { permissions: { commandExecution: 'allow' } } },
      });
      expect(invalid.status()).toBe(400);

      const persisted = await requestJson<{ environments: RegisteredEnvironment[] }>(page, {
        path: '/api/code-environments',
        token,
      });
      expect(persisted.environments.find(({ id }) => id === environmentId)?.settings).toEqual({
        permissions: { fileWrite: 'allow', commandExecution: 'deny' },
      });
    } finally {
      if (environmentId != null) {
        await requestJson(page, {
          path: `/api/code-environments/${environmentId}`,
          token,
          method: 'DELETE',
        });
      }
    }
  });

  test('routes two conversation turns through the bridge and preserves workspace state', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });

    const name = uniqueAgentName('E2E Attached Code Agent');
    let agentId: string | undefined;
    const stranger = {
      email: `code-bridge-stranger-${Date.now()}@example.com`,
      name: 'Code Bridge Stranger',
      password: 'securepassword123',
    };

    try {
      const token = await getAccessToken(page);
      if (process.env.E2E_CODE_BRIDGE_ADMIN_TOKEN) {
        const pairing = await requestJson<PairingResponse>(page, {
          path: '/api/admin/code-environments/e2e-vm/pairings',
          token,
          method: 'POST',
        });
        expect(pairing).toMatchObject({
          environmentId: 'e2e-vm',
          workerId: 'e2e-vm',
          code: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
          expiresAt: expect.any(String),
        });
        expect(pairing).not.toHaveProperty('token');
        expect(Number.isFinite(Date.parse(pairing.expiresAt))).toBe(true);
      }
      const registration = await requestJson<{ environment: RegisteredEnvironment }>(page, {
        path: '/api/code-environments',
        token,
        method: 'POST',
        body: {
          name: 'E2E principal-owned VM',
          controlPlaneId: 'e2e-vm',
          /** Neither field is trusted by the server; keep them here as an E2E
           * regression check against client-selected routing. */
          workerId: 'attacker-worker',
          baseURL: 'https://attacker.invalid',
        },
      });
      expect(registration.environment).toMatchObject({
        resourceId: expect.any(String),
        id: expect.stringMatching(/^code-/),
        name: 'E2E principal-owned VM',
        type: 'attached',
      });
      expect(registration.environment).not.toHaveProperty('baseURL');
      expect(registration.environment).not.toHaveProperty('workerId');

      const ownerList = await requestJson<{ environments: RegisteredEnvironment[] }>(page, {
        path: '/api/code-environments',
        token,
      });
      expect(ownerList.environments).toContainEqual(
        expect.objectContaining(registration.environment),
      );

      let workerStatus: EnvironmentStatus | undefined;
      await expect
        .poll(
          async () => {
            workerStatus = await requestJson<EnvironmentStatus>(page, {
              path: `/api/code-environments/${registration.environment.id}/status`,
              token,
            });
            return workerStatus.status;
          },
          {
            message: 'BYOM worker should become ready before workspace commands run',
            timeout: 30_000,
            intervals: [250, 500, 1_000],
          },
        )
        .toBe('ready');
      expect(workerStatus).toMatchObject({
        environmentId: registration.environment.id,
        status: 'ready',
        leaseExpiresInMs: expect.any(Number),
        sandboxProfile: expect.any(String),
        runtimes: expect.any(Array),
      });

      await cleanupUser(stranger);
      const strangerApi = await playwrightRequest.newContext({
        baseURL: new URL(page.url()).origin,
        storageState: { cookies: [], origins: [] },
      });
      try {
        expect(
          (
            await strangerApi.post('/api/auth/register', {
              data: {
                email: stranger.email,
                name: stranger.name,
                password: stranger.password,
                confirm_password: stranger.password,
              },
            })
          ).ok(),
        ).toBe(true);
        const strangerLogin = await strangerApi.post('/api/auth/login', {
          data: { email: stranger.email, password: stranger.password },
        });
        expect(strangerLogin.ok()).toBe(true);
        const strangerToken = ((await strangerLogin.json()) as { token?: string }).token;
        expect(strangerToken).toEqual(expect.any(String));
        const strangerList = await strangerApi.get('/api/code-environments', {
          headers: { Authorization: `Bearer ${strangerToken}` },
        });
        expect(strangerList.ok()).toBe(true);
        expect(await strangerList.json()).toMatchObject({ environments: [] });
      } finally {
        await strangerApi.dispose();
        await cleanupUser(stranger);
      }

      const agent = await requestJson<AgentDetail>(page, {
        path: '/api/agents',
        token,
        method: 'POST',
        body: {
          name,
          description: 'Exercises the outbound stateful code bridge.',
          instructions: 'Use the requested code tool and report its output.',
          provider: MOCK_ENDPOINTS[0].label,
          model: MOCK_ENDPOINTS[0].model,
          tools: ['execute_code'],
          stateful_code_sessions: true,
          stateful_code_environment: 'conversation',
          code_environment_id: registration.environment.id,
        },
      });
      agentId = agent.id;

      const form = await openAgentBuilder(page);
      await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
      await page.getByRole('option', { name }).click();
      await expect(form.getByLabel('Agent name')).toHaveValue(name);
      await form.getByRole('button', { name: 'Select Agent' }).click();

      await sendApprovedCommand(page, 'E2E_STATEFUL_CODE:write');
      await sendApprovedCommand(page, 'E2E_STATEFUL_CODE:read');
    } finally {
      await cleanupAgent(page, agentId);
    }
  });
});
