import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';

type ModelRow = { id: string; name?: string; description?: string; provider?: string };

async function login(request: APIRequestContext): Promise<string> {
  const { email, password } = getE2EUser();
  const response = await request.post('/api/auth/login', { data: { email, password } });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { token: string }).token;
}

async function createAgent(request: APIRequestContext, token: string, name: string) {
  const response = await request.post('/api/agents', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      name,
      description: 'Listed by the remote models route.',
      provider: 'Mock Provider A',
      model: 'mock-model-a',
      model_parameters: {},
      tools: [],
    },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function expectListedAgent(
  playwright: PlaywrightWorkerArgs['playwright'],
  baseURL: string | undefined,
  path: string,
) {
  const request = await playwright.request.newContext({ baseURL });
  let agentId = '';
  let keyId = '';
  let token = '';
  try {
    token = await login(request);
    const name = `Models list ${randomUUID().slice(0, 8)}`;
    agentId = await createAgent(request, token, name);
    /** The remote routes authenticate with an agent API key, not the session JWT. */
    const created = await request.post('/api/api-keys', {
      headers: { Authorization: `Bearer ${token}` },
      data: { name },
    });
    expect(created.status()).toBe(201);
    const apiKey = (await created.json()) as { id: string; key: string };
    keyId = apiKey.id;

    const response = await request.get(path, {
      headers: { Authorization: `Bearer ${apiKey.key}` },
    });
    expect(response.status()).toBe(200);
    const { data } = (await response.json()) as { data: ModelRow[] };

    expect(data.find((row) => row.id === agentId)).toMatchObject({
      id: agentId,
      name,
      description: 'Listed by the remote models route.',
      provider: 'Mock Provider A',
    });
  } finally {
    if (keyId) {
      await request.delete(`/api/api-keys/${keyId}`, {
        headers: { Authorization: `Bearer ${token}` },
        failOnStatusCode: false,
      });
    }
    if (agentId) {
      await request.delete(`/api/agents/${agentId}`, {
        headers: { Authorization: `Bearer ${token}` },
        failOnStatusCode: false,
      });
    }
    await request.dispose();
  }
}

test.describe('remote models list', () => {
  test("the chat completions models list shows the caller's agent with its details @scenario:remote-models-list-shows-agent-details", async ({
    playwright,
    baseURL,
  }) => {
    await expectListedAgent(playwright, baseURL, '/api/agents/v1/models');
  });

  test("the responses models list shows the caller's agent with its details @scenario:remote-responses-models-list-shows-agent-details", async ({
    playwright,
    baseURL,
  }) => {
    await expectListedAgent(playwright, baseURL, '/api/agents/v1/responses/models');
  });
});
