import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { loginAdmin } from '../content-filters.helpers';
import cleanupUser from '../../../setup/cleanupUser';
import { withMongo } from '../db';

const tools = [
  {
    type: 'function',
    name: 'client_lookup',
    parameters: { type: 'object', properties: { key: { type: 'string' } } },
  },
];
type Item = { type: string; call_id?: string; content?: { text?: string }[] };
type Response = { id: string; store: boolean; output: Item[]; tools: unknown[] };

async function completed(response: APIResponse, stream: boolean): Promise<Response> {
  const text = await response.text();
  expect(response.status(), text).toBe(200);
  if (!stream) return JSON.parse(text) as Response;
  const events = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .flatMap((line) => {
      try {
        return [JSON.parse(line.slice(6)) as { type: string; response: Response }];
      } catch {
        return [];
      }
    });
  const terminal = events.find((event) => event.type === 'response.completed');
  expect(terminal, text).toBeTruthy();
  return terminal!.response;
}

async function remote(request: APIRequestContext, token: string) {
  const headers = { Authorization: `Bearer ${token}` };
  const created = await request.post('/api/agents', {
    headers,
    data: {
      name: `Client tools ${randomUUID()}`,
      provider: 'Mock Provider A',
      model: 'mock-model-a',
      model_parameters: {},
      tools: [],
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const agent = (await created.json()) as { id: string };
  const keyResponse = await request.post('/api/api-keys', {
    headers,
    data: { name: 'Client tool continuation' },
  });
  expect(keyResponse.status()).toBe(201);
  const key = (await keyResponse.json()) as { id: string; key: string };
  return {
    agentId: agent.id,
    headers: { Authorization: `Bearer ${key.key}` },
    cleanup: async () => {
      await request.delete(`/api/api-keys/${key.id}`, { headers });
      await request.delete(`/api/agents/${agent.id}`, { headers });
    },
  };
}

for (const stream of [false, true])
  for (const parallel of [false, true]) {
    test(`stored client-tool lifecycle: stream=${stream}, parallel=${parallel} @scenario:responses-stored-client-tools-${stream}-${parallel}`, async ({
      playwright,
      baseURL,
    }) => {
      const request = await playwright.request.newContext({ baseURL });
      const client = await remote(request, await loginAdmin(request));
      const post = (data: object) =>
        request.post('/api/agents/v1/responses', {
          headers: client.headers,
          data: { model: client.agentId, tools, store: true, ...data },
        });
      try {
        const first = await completed(
          await post({
            stream,
            input: `E2E_STORED_CLIENT_TOOLS:${parallel ? 'parallel' : 'single'}`,
          }),
          stream,
        );
        expect(first.store).toBe(true);
        expect(first.output.map((item) => item.type)).toEqual(
          parallel ? ['function_call', 'function_call'] : ['function_call'],
        );
        const retrieved = await request.get(`/api/agents/v1/responses/${first.id}`, {
          headers: client.headers,
        });
        expect(retrieved.status()).toBe(200);
        expect(((await retrieved.json()) as Response).output).toEqual(first.output);
        const results = first.output.map((item) => ({
          type: 'function_call_output',
          call_id: item.call_id,
          output: `result:${item.call_id}`,
        }));
        const unanswered = await post({
          stream,
          previous_response_id: first.id,
          input: 'continue',
        });
        expect(unanswered.status()).toBe(400);
        if (parallel) {
          const partial = await post({
            stream,
            previous_response_id: first.id,
            input: results.slice(0, 1),
          });
          expect(partial.status()).toBe(400);
        }
        const duplicate = await post({
          stream,
          previous_response_id: first.id,
          input: [...results, results[0]],
        });
        expect(duplicate.status()).toBe(400);
        const unknown = await post({
          stream,
          previous_response_id: first.id,
          input: [...results, { type: 'function_call_output', call_id: 'unknown', output: 'bad' }],
        });
        expect(unknown.status()).toBe(400);

        const next = await completed(
          await post({
            stream,
            tools: undefined,
            previous_response_id: first.id,
            input: results.toReversed(),
          }),
          stream,
        );
        const expected = `E2E_CLIENT_RESULTS:${JSON.stringify(first.output.map((item) => ({ id: item.call_id, content: `result:${item.call_id}` })))}`;
        expect(
          next.output.flatMap((item) => item.content?.map((part) => part.text) ?? []).join(''),
        ).toBe(expected);
        expect(next.store).toBe(true);
        expect(next.tools).toEqual([]);
        const later = await completed(
          await post({
            stream,
            tools: undefined,
            previous_response_id: next.id,
            input: 'E2E_STORED_CLIENT_TOOLS:verify',
          }),
          stream,
        );
        expect(
          later.output.flatMap((item) => item.content?.map((part) => part.text) ?? []).join(''),
        ).toBe(expected);
        expect(later.tools).toEqual([]);
        const unchanged = await request.get(`/api/agents/v1/responses/${first.id}`, {
          headers: client.headers,
        });
        expect(((await unchanged.json()) as Response).output).toEqual(first.output);

        const replay = await completed(
          await post({ stream, store: false, input: [...first.output, ...results] }),
          stream,
        );
        expect(replay.store).toBe(false);
        await request
          .get(`/api/agents/v1/responses/${replay.id}`, { headers: client.headers })
          .then((response) => expect(response.status()).toBe(404));
      } finally {
        await client.cleanup();
        await request.dispose();
      }
    });
  }

test('another authenticated API-key owner cannot retrieve or continue the handoff @scenario:responses-stored-client-tools-owner-isolation', async ({
  playwright,
  baseURL,
}) => {
  const request = await playwright.request.newContext({ baseURL });
  const strangerRequest = await playwright.request.newContext({ baseURL });
  const user = {
    email: `client-tools-${randomUUID()}@example.com`,
    name: 'Other tool caller',
    password: 'E2eOtherCaller123!',
  };
  const client = await remote(request, await loginAdmin(request));
  let stranger: Awaited<ReturnType<typeof remote>> | undefined;
  try {
    const registered = await strangerRequest.post('/api/auth/register', {
      data: { ...user, confirm_password: user.password },
    });
    expect(registered.ok()).toBe(true);
    // Seed an independent admitted caller before its first authenticated request.
    // This fixture changes no shared role or authorization policy.
    await withMongo(async (db) => {
      const promoted = await db
        .collection('users')
        .updateOne({ email: user.email }, { $set: { role: 'ADMIN' } });
      expect(promoted.modifiedCount).toBe(1);
    });
    const login = await strangerRequest.post('/api/auth/login', {
      data: { email: user.email, password: user.password },
    });
    expect(login.status()).toBe(200);
    const { token } = (await login.json()) as { token: string };
    stranger = await remote(strangerRequest, token);
    // Prove this credential can run its own agent before testing the foreign reference.
    await completed(
      await strangerRequest.post('/api/agents/v1/responses', {
        headers: stranger.headers,
        data: { model: stranger.agentId, input: 'hello', store: false },
      }),
      false,
    );
    const first = await completed(
      await request.post('/api/agents/v1/responses', {
        headers: client.headers,
        data: {
          model: client.agentId,
          tools,
          store: true,
          input: 'E2E_STORED_CLIENT_TOOLS:single',
        },
      }),
      false,
    );
    const read = await strangerRequest.get(`/api/agents/v1/responses/${first.id}`, {
      headers: stranger.headers,
    });
    expect(read.status()).toBe(404);
    const continued = await strangerRequest.post('/api/agents/v1/responses', {
      headers: stranger.headers,
      data: {
        model: stranger.agentId,
        previous_response_id: first.id,
        input: [
          { type: 'function_call_output', call_id: first.output[0].call_id, output: 'foreign' },
        ],
      },
    });
    expect(continued.status()).toBe(404);
    expect(await continued.text()).not.toContain('call_a');
  } finally {
    await stranger?.cleanup();
    await client.cleanup();
    await cleanupUser(user);
    await strangerRequest.dispose();
    await request.dispose();
  }
});
