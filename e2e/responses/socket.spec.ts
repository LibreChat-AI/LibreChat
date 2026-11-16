import { z } from 'zod';
import WebSocket from 'ws';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { withMongo } from '../specs/mock/db';
import { loginAdmin } from '../specs/mock/content-filters.helpers';

const eventSchema = z.object({
  type: z.string(),
  status: z.number().optional(),
  response: z.object({ id: z.string() }).passthrough().optional(),
  error: z.object({ code: z.string() }).passthrough().optional(),
});
function turn(ws: WebSocket, body: object) {
  return new Promise<z.infer<typeof eventSchema>>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (raw: WebSocket.RawData) => {
      const event = eventSchema.parse(JSON.parse(raw.toString()));
      if (event.type === 'response.completed' || event.type === 'error') {
        cleanup();
        resolve(event);
      }
    };
    const timer = setTimeout(() => onError(new Error('Responses turn timed out')), 10000);
    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.send(JSON.stringify({ type: 'response.create', store: false, ...body }));
  });
}

for (const disableStreaming of [false, true]) {
  test(`real API reauthenticates, isolates history, and enforces storage policy with disableStreaming=${disableStreaming}`, async ({
    request,
    baseURL,
  }) => {
    const token = await loginAdmin(request);
    const headers = { Authorization: `Bearer ${token}` };
    const agentResponse = await request.post('/api/agents', {
      headers,
      data: {
        name: `Socket ${randomUUID()}`,
        provider: 'Mock Provider A',
        model: 'mock-model-a',
        model_parameters: { disableStreaming },
        tools: [],
      },
    });
    expect(agentResponse.status(), await agentResponse.text()).toBe(201);
    const agent = await agentResponse.json();
    expect(agent.model_parameters).toMatchObject({ disableStreaming });
    const keyResponse = await request.post('/api/api-keys', {
      headers,
      data: { name: 'Socket test' },
    });
    expect(keyResponse.status()).toBe(201);
    const key = await keyResponse.json();
    const url = new URL('/api/agents/v1/responses', baseURL);
    url.protocol = 'ws:';
    const sockets: WebSocket[] = [];
    const connect = async () => {
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key.key}` } });
      sockets.push(ws);
      await once(ws, 'open');
      return ws;
    };
    try {
      const ws = await connect();
      const marker = `history-${randomUUID()}`;
      const first = await turn(ws, { model: agent.id, input: `E2E_REPLY: ${marker}` });
      expect(first.type).toBe('response.completed');
      const second = await turn(ws, {
        model: agent.id,
        previous_response_id: first.response?.id,
        input: `E2E_ASSERT_HISTORY: ${marker}`,
      });
      expect(second.type).toBe('response.completed');
      expect(JSON.stringify(second.response)).toContain(`E2E history assertion present: ${marker}`);
      const other = await connect();
      expect(
        (
          await turn(other, {
            model: agent.id,
            previous_response_id: second.response?.id,
            input: 'Cannot reuse another socket',
          })
        ).error?.code,
      ).toBe('previous_response_not_found');
      await withMongo(async (db) => {
        expect(await db.collection('messages').countDocuments({ model: agent.id })).toBe(0);
        expect(await db.collection('conversations').countDocuments({ agent_id: agent.id })).toBe(0);
      });
      const persistedMarker = `stored-${randomUUID()}`;
      const stored = await request.post('/api/agents/v1/responses', {
        headers: { Authorization: `Bearer ${key.key}` },
        data: { model: agent.id, store: true, input: `E2E_REPLY: ${persistedMarker}` },
      });
      expect(stored.status(), await stored.text()).toBe(200);
      const persisted = await stored.json();
      const counts = () =>
        withMongo(async (db) => ({
          messages: await db.collection('messages').countDocuments({ model: agent.id }),
          conversations: await db
            .collection('conversations')
            .countDocuments({ agent_id: agent.id }),
        }));
      const before = await counts();
      expect(before.messages).toBeGreaterThan(0);
      const rejected = await turn(other, {
        model: agent.id,
        previous_response_id: persisted.id,
        input: 'No persisted fallback',
      });
      expect(rejected.error?.code).toBe('previous_response_not_found');
      expect(await counts()).toEqual(before);
      const continued = await turn(other, {
        model: agent.id,
        store: true,
        previous_response_id: persisted.id,
        input: `E2E_ASSERT_HISTORY: ${persistedMarker}`,
      });
      expect(continued.type).toBe('response.completed');
      expect(JSON.stringify(continued.response)).toContain(
        `E2E history assertion present: ${persistedMarker}`,
      );
      expect((await request.delete(`/api/api-keys/${key.id}`, { headers })).ok()).toBe(true);
      expect((await turn(ws, { model: agent.id, input: 'Revoked' })).status).toBe(401);
      const anonymous = new WebSocket(url);
      sockets.push(anonymous);
      const denied = await new Promise<number>((resolve) => {
        anonymous.on('unexpected-response', (_req, res) => {
          resolve(res.statusCode!);
          res.resume();
          anonymous.terminate();
        });
        anonymous.on('error', () => {});
      });
      expect(denied).toBe(401);
    } finally {
      for (const ws of sockets) ws.terminate();
      await request.delete(`/api/api-keys/${key.id}`, { headers });
      await request.delete(`/api/agents/${agent.id}`, { headers });
    }
  });
}
