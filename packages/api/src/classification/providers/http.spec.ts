import type { ProviderFetch } from './transport';
import { ClassificationError } from '../types';
import { createHttpClassifier } from './http';

interface StubResponse {
  ok: boolean;
  status: number;
  body: string;
  headers?: Record<string, string>;
}

function stubTransport(queue: Array<StubResponse | Error>): {
  transport: ProviderFetch;
  calls: Array<{ url: string; headers: Record<string, string>; body: string }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  let index = 0;
  const transport: ProviderFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const next = queue[Math.min(index, queue.length - 1)];
    index++;
    if (next instanceof Error) {
      throw next;
    }
    return {
      ok: next.ok,
      status: next.status,
      headers: { get: (name: string) => next.headers?.[name.toLowerCase()] ?? null },
      text: async () => next.body,
    };
  };
  return { transport, calls };
}

const ENDPOINT = 'https://classifier.test/v1/classify';

const ANSWER = JSON.stringify({
  model: 'test-1',
  answers: { verdict: { type: 'boolean', probability: 0.82 } },
  usage: { input_tokens: 120, output_tokens: 8 },
});

const QUESTION = {
  verdict: { type: 'boolean' as const, instructions: 'Is this urgent?' },
};

function build(queue: Array<StubResponse | Error>, overrides = {}) {
  const { transport, calls } = stubTransport(queue);
  const classifier = createHttpClassifier({
    apiKey: 'sk-test',
    endpoint: ENDPOINT,
    fetch: transport,
    sleep: async () => undefined,
    ...overrides,
  });
  return { classifier, calls };
}

describe('createHttpClassifier', () => {
  it('posts the state and questions and reads the answers back', async () => {
    const { classifier, calls } = build([{ ok: true, status: 200, body: ANSWER }]);

    const result = await classifier.classify({ state: 'payouts are failing', questions: QUESTION });

    expect(result.answers.verdict).toEqual({ type: 'boolean', probability: 0.82 });
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 8 });
    expect(calls[0].url).toBe(ENDPOINT);
    expect(calls[0].headers.Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(calls[0].body)).toEqual({
      state: 'payouts are failing',
      questions: QUESTION,
    });
  });

  it('includes the model only when one is configured', async () => {
    const { classifier, calls } = build([{ ok: true, status: 200, body: ANSWER }], {
      model: 'test-1',
    });

    await classifier.classify({ state: 'x', questions: QUESTION });

    expect(JSON.parse(calls[0].body).model).toBe('test-1');
    expect(classifier.model).toBe('test-1');
    expect(classifier.id).toBe('http');
  });

  it('carries a choice answer through and drops a type it does not know', async () => {
    const body = JSON.stringify({
      model: 'test-1',
      answers: {
        pick: { type: 'choice', choice: 'b', confidence: 0.7, probabilities: { a: 0.3, b: 0.7 } },
        rate: { type: 'score', score: 1.4, confidence: 0.5, probabilities: { '0': 0.6, '1': 0.4 } },
      },
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const { classifier } = build([{ ok: true, status: 200, body }]);

    const result = await classifier.classify({
      state: 'x',
      questions: {
        pick: { type: 'choice', instructions: 'which', criteria: { a: null, b: null } },
      },
    });

    expect(result.answers.pick).toMatchObject({ type: 'choice', choice: 'b', confidence: 0.7 });
    expect(result.answers).not.toHaveProperty('rate');
  });

  it('retries a 429 and honors retry-after', async () => {
    const waits: number[] = [];
    const { transport, calls } = stubTransport([
      { ok: false, status: 429, body: 'slow down', headers: { 'retry-after': '2' } },
      { ok: true, status: 200, body: ANSWER },
    ]);
    const classifier = createHttpClassifier({
      apiKey: 'sk-test',
      endpoint: ENDPOINT,
      fetch: transport,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    await classifier.classify({ state: 'x', questions: QUESTION });

    expect(calls).toHaveLength(2);
    expect(waits).toEqual([2000]);
  });

  it('clamps an absurd retry-after', async () => {
    const waits: number[] = [];
    const { transport } = stubTransport([
      { ok: false, status: 503, body: 'down', headers: { 'retry-after': '3600' } },
      { ok: true, status: 200, body: ANSWER },
    ]);
    const classifier = createHttpClassifier({
      apiKey: 'sk-test',
      endpoint: ENDPOINT,
      fetch: transport,
      timeoutMs: 30_000,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    await classifier.classify({ state: 'x', questions: QUESTION });

    expect(waits).toEqual([10_000]);
  });

  it('gives up instead of waiting past its timeout for a retry', async () => {
    const waits: number[] = [];
    const { transport, calls } = stubTransport([
      { ok: false, status: 429, body: 'slow down', headers: { 'retry-after': '8' } },
      { ok: true, status: 200, body: ANSWER },
    ]);
    const classifier = createHttpClassifier({
      apiKey: 'sk-test',
      endpoint: ENDPOINT,
      fetch: transport,
      timeoutMs: 4_000,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    await expect(classifier.classify({ state: 'x', questions: QUESTION })).rejects.toMatchObject({
      failure: 'rate_limited',
    });
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('stops backing off as soon as the caller aborts', async () => {
    const controller = new AbortController();
    const { transport, calls } = stubTransport([
      { ok: false, status: 503, body: 'down', headers: { 'retry-after': '2' } },
      { ok: true, status: 200, body: ANSWER },
    ]);
    const classifier = createHttpClassifier({
      apiKey: 'sk-test',
      endpoint: ENDPOINT,
      fetch: transport,
      timeoutMs: 30_000,
    });
    const started = Date.now();
    setTimeout(() => controller.abort(), 20);

    await expect(
      classifier.classify({ state: 'x', questions: QUESTION, signal: controller.signal }),
    ).rejects.toMatchObject({ failure: 'aborted' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).toHaveLength(1);
  });

  it('gives up after maxRetries and names the provider', async () => {
    const { classifier, calls } = build([{ ok: false, status: 500, body: 'boom' }], {
      maxRetries: 2,
    });

    await expect(classifier.classify({ state: 'x', questions: QUESTION })).rejects.toMatchObject({
      name: 'ClassificationError',
      failure: 'server_error',
      provider: 'http',
      status: 500,
    });
    expect(calls).toHaveLength(3);
  });

  it('does not retry a rejected request', async () => {
    const { classifier, calls } = build([{ ok: false, status: 422, body: 'bad question' }]);

    await expect(classifier.classify({ state: 'x', questions: QUESTION })).rejects.toMatchObject({
      failure: 'bad_request',
    });
    expect(calls).toHaveLength(1);
  });

  it('does not retry a rejected key', async () => {
    const { classifier, calls } = build([{ ok: false, status: 401, body: 'nope' }]);

    await expect(classifier.classify({ state: 'x', questions: QUESTION })).rejects.toMatchObject({
      failure: 'unauthorized',
    });
    expect(calls).toHaveLength(1);
  });

  it('reports a body that is not JSON as malformed', async () => {
    const { classifier } = build([{ ok: true, status: 200, body: '<html>504</html>' }]);

    await expect(classifier.classify({ state: 'x', questions: QUESTION })).rejects.toMatchObject({
      failure: 'malformed_response',
    });
  });

  it('reports a JSON body with no answers as malformed', async () => {
    const { classifier } = build([
      { ok: true, status: 200, body: JSON.stringify({ model: 'test-1' }) },
    ]);

    await expect(classifier.classify({ state: 'x', questions: QUESTION })).rejects.toMatchObject({
      failure: 'malformed_response',
    });
  });

  it('drops an answer it cannot read rather than inventing one', async () => {
    const body = JSON.stringify({
      model: 'test-1',
      answers: { verdict: { type: 'something_new', value: 3 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const { classifier } = build([{ ok: true, status: 200, body }]);

    const result = await classifier.classify({ state: 'x', questions: QUESTION });

    expect(result.answers.verdict).toBeUndefined();
  });

  it('defaults usage when the response omits it', async () => {
    const { classifier } = build([
      {
        ok: true,
        status: 200,
        body: JSON.stringify({
          model: 'test-1',
          answers: { verdict: { type: 'boolean', probability: 1 } },
        }),
      },
    ]);

    const result = await classifier.classify({ state: 'x', questions: QUESTION });

    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('times out a transport that never settles', async () => {
    const transport: ProviderFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const classifier = createHttpClassifier({
      apiKey: 'sk-test',
      endpoint: ENDPOINT,
      timeoutMs: 15,
      maxRetries: 0,
      fetch: transport,
    });

    await expect(classifier.classify({ state: 'x', questions: QUESTION })).rejects.toMatchObject({
      failure: 'timeout',
    });
  });

  it('reports a caller abort as aborted, not as a timeout', async () => {
    const controller = new AbortController();
    const transport: ProviderFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const classifier = createHttpClassifier({
      apiKey: 'sk-test',
      endpoint: ENDPOINT,
      timeoutMs: 5_000,
      maxRetries: 0,
      fetch: transport,
    });

    const pending = classifier.classify({
      state: 'x',
      questions: QUESTION,
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ failure: 'aborted' });
  });

  it('retries a transport-level network failure', async () => {
    const { classifier, calls } = build([
      new Error('ECONNRESET'),
      { ok: true, status: 200, body: ANSWER },
    ]);

    await classifier.classify({ state: 'x', questions: QUESTION });

    expect(calls).toHaveLength(2);
  });

  it('refuses to build without a key', () => {
    expect(() => createHttpClassifier({ apiKey: '  ', endpoint: ENDPOINT })).toThrow(
      ClassificationError,
    );
  });

  it('refuses to build without an endpoint', () => {
    expect(() => createHttpClassifier({ apiKey: 'sk-test', endpoint: '' })).toThrow(
      ClassificationError,
    );
  });
});
