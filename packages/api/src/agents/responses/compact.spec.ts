import express from 'express';
import request from 'supertest';
import { createResponseCompaction, responseRunOperation } from './compact';
const key = 'ab'.repeat(32);
function fixture(config: { maxInputBytes?: number } = {}) {
  let now = 10000;
  let activeKey = key;
  let summary = true;
  let enabled = true;
  let calls = 0;
  const modeReads: unknown[] = [];
  const handlers = createResponseCompaction({
    getKey: () => activeKey,
    now: () => now,
    create: async (req, res) => {
      calls++;
      const op = responseRunOperation(req);
      modeReads.push(op.runOptions);
      expect(req.body.store).toBe(false);
      expect(req.body.tools).toBeUndefined();
      if (summary)
        op.handlers({
          on_summarize_complete: { handle: (_event: string, _data: unknown) => {} },
        }).on_summarize_complete.handle('on_summarize_complete', {
          summary: {
            content: [{ type: 'summary_text', text: 'Tuesday launch; notify support first.' }],
          },
        });
      res.json({
        status: 'completed',
        usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
      });
    },
  });
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use((req, _res, next) => {
    Object.assign(req, {
      user: {
        id: req.headers['x-owner'] ?? 'owner',
        tenantId:
          req.headers['x-tenant'] === 'none' ? undefined : (req.headers['x-tenant'] ?? 'tenant'),
      },
      tenantId: req.headers['x-request-tenant'],
      config: {
        endpoints: {
          agents: { responses: { compaction: { enabled, maxAgeMs: 1000, ...config } } },
        },
      },
    });
    next();
  });
  app.post('/compact', handlers.expand, handlers.create);
  app.post('/responses', handlers.expand, (req, res) => {
    res.json({ input: req.body.input, mode: responseRunOperation(req).runOptions });
  });
  return {
    app,
    modeReads,
    get calls() {
      return calls;
    },
    rotate: () => {
      activeKey = 'cd'.repeat(32);
    },
    unavailableKey: () => {
      activeKey = '';
    },
    rewind: (ms: number) => {
      now -= ms;
    },
    expire: () => {
      now += 2000;
    },
    empty: () => {
      summary = false;
    },
    disable: () => {
      enabled = false;
    },
  };
}
it('uses summarize-only execution and returns opaque scoped replayable context', async () => {
  const f = fixture();
  const compact = await request(f.app)
    .post('/compact')
    .send({ model: 'agent', input: 'launch Tuesday', store: true, tools: [{ name: 'danger' }] })
    .expect(200);
  expect(f.modeReads).toEqual([{ summarizeOnly: true, summarizeFullWindow: true }]);
  expect(compact.body.object).toBe('response.compaction');
  expect(JSON.stringify(compact.body)).not.toContain('Tuesday');
  const next = await request(f.app)
    .post('/responses')
    .send({
      model: 'agent',
      input: [...compact.body.output, { type: 'message', role: 'user', content: 'When?' }],
      summarizeOnly: true,
    })
    .expect(200);
  expect(next.body.mode).toEqual({});
  expect(next.body.input[0]).toEqual({
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'Tuesday launch; notify support first.' }],
  });
});
it.each(['owner', 'tenant', 'model', 'tampered', 'expired', 'disabled'])(
  'rejects %s replay before execution',
  async (kind) => {
    const f = fixture();
    const compact = await request(f.app)
      .post('/compact')
      .send({ model: 'agent', input: 'launch Tuesday' })
      .expect(200);
    const input = compact.body.output;
    if (kind === 'tampered') input[0].encrypted_content = 'not-a-valid-token';
    if (kind === 'expired') f.expire();
    if (kind === 'disabled') f.disable();
    await request(f.app)
      .post('/responses')
      .set('x-owner', kind === 'owner' ? 'other' : 'owner')
      .set('x-tenant', kind === 'tenant' ? 'other' : 'tenant')
      .send({ model: kind === 'model' ? 'other' : 'agent', input })
      .expect(400);
    expect(f.calls).toBe(1);
  },
);
it('does not substitute an empty summary with a successful compaction', async () => {
  const f = fixture();
  f.empty();
  const r = await request(f.app)
    .post('/compact')
    .send({ model: 'agent', input: 'launch Tuesday' })
    .expect(503);
  expect(r.body.error.code).toBe('compaction_failed');
});
it('requires explicit input/model and refuses disabled compaction', async () => {
  const f = fixture();
  await request(f.app).post('/compact').send({ input: 'text' }).expect(400);
  expect(f.calls).toBe(0);
  f.disable();
  await request(f.app).post('/compact').send({ model: 'agent', input: 'text' }).expect(404);
  expect(f.calls).toBe(0);
});

it.each(['tag', 'ciphertext'])('rejects a validly encoded modified %s', async (part) => {
  const f = fixture();
  const response = await request(f.app)
    .post('/compact')
    .send({ model: 'agent', input: 'text' })
    .expect(200);
  const token = response.body.output[0].encrypted_content.split(':');
  const index = part === 'tag' ? 2 : 3;
  const data = Buffer.from(token[index], 'base64');
  data[part === 'tag' ? 0 : data.length - 4] ^= 1;
  token[index] = data.toString('base64');
  response.body.output[0].encrypted_content = token.join(':');
  const rejected = await request(f.app)
    .post('/responses')
    .send({ model: 'agent', input: response.body.output })
    .expect(400);
  expect(rejected.body.error.code).toBe('invalid_compaction');
});
it('fails before model work if the key is unavailable and cannot open a rotated key token', async () => {
  const f = fixture();
  const response = await request(f.app)
    .post('/compact')
    .send({ model: 'agent', input: 'text' })
    .expect(200);
  f.rotate();
  await request(f.app)
    .post('/responses')
    .send({ model: 'agent', input: response.body.output })
    .expect(400);
  const unavailable = fixture();
  unavailable.unavailableKey();
  await request(unavailable.app)
    .post('/compact')
    .send({ model: 'agent', input: 'text' })
    .expect(503);
  expect(unavailable.calls).toBe(0);
});

it.each([null, '', [], {}])(
  'rejects an empty or unsupported input window %p before model work',
  async (input) => {
    const f = fixture();
    await request(f.app).post('/compact').send({ model: 'agent', input }).expect(400);
    expect(f.calls).toBe(0);
  },
);
it('requires a new chain when replaying compacted input', async () => {
  const f = fixture();
  const response = await request(f.app)
    .post('/compact')
    .send({ model: 'agent', input: 'text' })
    .expect(200);
  const rejected = await request(f.app)
    .post('/responses')
    .send({ model: 'agent', previous_response_id: 'resp_old', input: response.body.output })
    .expect(400);
  expect(rejected.body.error.code).toBe('invalid_compaction');
});

it('refuses unresolved tool calls instead of silently dropping them from the summary', async () => {
  const f = fixture();
  const result = await request(f.app)
    .post('/compact')
    .send({
      model: 'agent',
      input: [{ type: 'function_call', call_id: 'pending', name: 'client', arguments: '{}' }],
    })
    .expect(400);
  expect(result.body.error.code).toBe('invalid_compaction');
  expect(f.calls).toBe(0);
});

it.each([
  { skew: 500, expected: 200 },
  { skew: 30001, expected: 400 },
])('bounds replica clock skew by the configured allowance: %p', async ({ skew, expected }) => {
  const f = fixture();
  const compact = await request(f.app)
    .post('/compact')
    .send({ model: 'agent', input: 'context' })
    .expect(200);
  f.rewind(skew);
  const result = await request(f.app)
    .post('/responses')
    .send({ model: 'agent', input: compact.body.output });
  expect(result.status).toBe(expected);
});

it.each(['none', 'credential-tenant'])(
  'binds effective request tenants with user tenant %s',
  async (userTenant) => {
    const f = fixture();
    const compact = await request(f.app)
      .post('/compact')
      .set('x-tenant', userTenant)
      .set('x-request-tenant', 'request-a')
      .send({ model: 'agent', input: 'context' })
      .expect(200);
    for (const tenant of ['request-a', 'request-b']) {
      const replay = await request(f.app)
        .post('/responses')
        .set('x-tenant', userTenant)
        .set('x-request-tenant', tenant)
        .send({ model: 'agent', input: compact.body.output })
        .expect(tenant === 'request-a' ? 200 : 400);
      if (tenant === 'request-b') expect(replay.body.error.code).toBe('invalid_compaction');
      else expect(replay.body.input).toHaveLength(1);
    }
  },
);

it('bounds mixed expanded UTF-8 input including ordinary items and separators', async () => {
  const f = fixture({ maxInputBytes: 1024 });
  const compact = await request(f.app)
    .post('/compact')
    .send({ model: 'agent', input: 'context' })
    .expect(200);
  const restored = {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'Tuesday launch; notify support first.' }],
  };
  const ordinary = { type: 'message', role: 'user', content: '🦊'.repeat(40) };
  const input = [compact.body.output[0], ordinary];
  const expected = [restored, ordinary];
  while (Buffer.byteLength(JSON.stringify([...expected, ordinary])) <= 1024) {
    input.push(ordinary);
    expected.push(ordinary);
  }
  await request(f.app).post('/responses').send({ model: 'agent', input }).expect(200);
  const rejected = await request(f.app)
    .post('/responses')
    .send({ model: 'agent', input: [...input, ordinary] })
    .expect(413);
  expect(rejected.body.error.code).toBe('request_too_large');
});

it('expands repeated valid items with linear serialization work', async () => {
  const f = fixture();
  const compact = await request(f.app)
    .post('/compact')
    .send({ model: 'agent', input: 'context' })
    .expect(200);
  const stringify = JSON.stringify;
  let serialized = 0;
  const spy = jest
    .spyOn(JSON, 'stringify')
    .mockImplementation((...args: Parameters<typeof JSON.stringify>) => {
      const value = stringify(...args);
      serialized += value?.length ?? 0;
      return value;
    });
  try {
    const input = Array.from({ length: 1000 }, () => compact.body.output[0]);
    const result = await request(f.app)
      .post('/responses')
      .send({ model: 'agent', input })
      .expect(200);
    expect(result.body.input).toHaveLength(1000);
    // Includes client request encoding and the final response, not just expansion internals.
    const wireBytes = stringify(input).length + stringify(result.body).length;
    expect(serialized).toBeLessThan(wireBytes * 4);
  } finally {
    spy.mockRestore();
  }
});
