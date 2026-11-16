import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { withMongo } from '../specs/mock/db';
import { loginAdmin } from '../specs/mock/content-filters.helpers';

for (const stream of [false, true]) {
  test(`standalone compaction preserves the API boundary and replays through stream=${stream}`, async ({
    request,
  }) => {
    const token = await loginAdmin(request);
    const headers = { Authorization: `Bearer ${token}` };
    const created = await request.post('/api/agents', {
      headers,
      data: {
        name: `Compact ${randomUUID()}`,
        provider: 'Mock Provider A',
        model: 'mock-model-a',
        model_parameters: {},
        tools: [],
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const agent = await created.json();
    const keyResponse = await request.post('/api/api-keys', {
      headers,
      data: { name: 'Compaction test' },
    });
    expect(keyResponse.status()).toBe(201);
    const key = await keyResponse.json();
    const remote = { Authorization: `Bearer ${key.key}` };
    try {
      // An unavailable tool must not turn a model-only compaction into tool initialization or OAuth.
      await withMongo(async (db) => {
        await db
          .collection('agents')
          .updateOne({ id: agent.id }, { $set: { tools: ['mcp__offline__unavailable'] } });
      });
      const toolResult = `COMPACTION_HISTORY_${randomUUID()}`;
      const result = await request.post('/api/agents/v1/responses/compact', {
        headers: remote,
        data: {
          model: agent.id,
          store: true,
          input: [
            { type: 'message', role: 'user', content: 'Launch Tuesday and notify support first.' },
            { type: 'message', role: 'assistant', content: 'I will preserve that plan.' },
            {
              type: 'function_call',
              call_id: 'historical',
              name: 'previous_client_tool',
              arguments: '{}',
            },
            {
              type: 'function_call_output',
              call_id: 'historical',
              output: toolResult,
            },
          ],
        },
      });
      expect(result.status(), await result.text()).toBe(200);
      const recorded = await request.get('http://127.0.0.1:8889/__e2e/requests');
      expect(JSON.stringify(await recorded.json())).toContain(toolResult);
      const compact = await result.json();
      expect(compact.object).toBe('response.compaction');
      expect(compact.output).toHaveLength(1);
      expect(compact.output[0]).toMatchObject({
        type: 'compaction',
        encrypted_content: expect.stringMatching(/^v1:/),
      });
      expect(compact.usage).toMatchObject({ input_tokens: 42, output_tokens: 7, total_tokens: 49 });
      expect(JSON.stringify(compact)).not.toContain('Tuesday');
      await withMongo(async (db) => {
        expect(await db.collection('conversations').countDocuments({ agent_id: agent.id })).toBe(0);
        expect(await db.collection('messages').countDocuments({ model: agent.id })).toBe(0);
        await db.collection('agents').updateOne({ id: agent.id }, { $set: { tools: [] } });
      });
      const replay = await request.post('/api/agents/v1/responses', {
        headers: remote,
        data: {
          model: agent.id,
          store: false,
          stream,
          input: [...compact.output, { type: 'message', role: 'user', content: 'Continue.' }],
        },
      });
      expect(replay.status(), await replay.text()).toBe(200);
      if (stream) expect(await replay.text()).toContain('event: response.completed');
      else expect((await replay.json()).status).toBe('completed');
      const invalid = await request.post('/api/agents/v1/responses', {
        headers: remote,
        data: { model: agent.id, input: [{ ...compact.output[0], encrypted_content: 'modified' }] },
      });
      expect(invalid.status()).toBe(400);
      expect(await invalid.text()).not.toContain('Tuesday');
      await withMongo(async (db) => {
        await db
          .collection('agents')
          .updateOne({ id: agent.id }, { $set: { summarization: { enabled: false } } });
      });
      const disabled = await request.post('/api/agents/v1/responses/compact', {
        headers: remote,
        data: { model: agent.id, input: 'Cannot summarize' },
      });
      expect(disabled.status(), await disabled.text()).toBe(409);

      expect(
        (
          await request.post('/api/agents/v1/responses/compact', {
            data: { model: agent.id, input: 'Unauthorized' },
          })
        ).status(),
      ).toBe(401);
    } finally {
      await request.delete(`/api/api-keys/${key.id}`, { headers });
      await request.delete(`/api/agents/${agent.id}`, { headers });
    }
  });
}
