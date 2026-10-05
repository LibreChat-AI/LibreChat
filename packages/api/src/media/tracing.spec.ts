import { FileSources, resolveMediaConfig } from 'librechat-data-provider';
import type { ModelInvocationTrace, traceModelInvocation } from '@librechat/agents';
import type { LLMResult } from '@langchain/core/outputs';
import type { MediaModelTraceInput } from './tracing';
import { createMediaModelTracer } from './tracing';

const input: MediaModelTraceInput = {
  jobId: 'job',
  threadId: 'thread',
  kind: 'submission',
  provider: 'openai',
  model: 'text-model',
  context: {
    scope: { ownerId: 'user', tenantId: 'tenant-a' },
    user: { id: 'user' },
    appConfig: { config: {}, fileStrategy: FileSources.local, imageOutputType: 'png' },
    config: resolveMediaConfig(),
    canCreate: true,
    canUse: true,
  },
};
const response = {
  text: 'private generated title',
  usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
};

function fixture() {
  const calls: ModelInvocationTrace[] = [];
  const projections: Array<LLMResult | undefined> = [];
  const trace: typeof traceModelInvocation = async (params, work, project) => {
    calls.push(params);
    const result = await work();
    projections.push(project?.(result));
    return result;
  };
  const config = jest.fn(() => ({ enabled: true }));
  return { tracer: createMediaModelTracer({ trace, config }), calls, projections, config };
}

it('passes existing tenant policy and redacted usage projection to the SDK lifecycle', async () => {
  const { tracer, calls, projections, config } = fixture();
  await expect(
    tracer.run(
      input,
      async () => response,
      (result) => result.usage,
    ),
  ).resolves.toBe(response);
  expect(config).toHaveBeenCalledWith(
    expect.objectContaining({
      tenantId: 'tenant-a',
      appConfig: input.context.appConfig,
      user: input.context.user,
      traceContext: { conversationId: 'thread', provider: 'openai', model: 'text-model' },
    }),
  );
  expect(calls[0]).toMatchObject({
    langfuse: { enabled: true },
    userId: 'user',
    sessionId: 'thread',
    tags: ['librechat', 'media', 'submission'],
    traceIdSeed: 'job',
  });
  expect(projections[0]).toMatchObject({
    generations: [
      [
        {
          message: { usage_metadata: response.usage },
        },
      ],
    ],
  });
  expect(JSON.stringify(projections)).not.toContain(response.text);
});

it('delegates real title callbacks without a synthetic external-model result projection', async () => {
  const { tracer, calls, projections, config } = fixture();
  await expect(
    tracer.run(
      { ...input, kind: 'title' },
      async () => response,
      (result) => result.usage,
    ),
  ).resolves.toBe(response);
  expect(projections).toEqual([undefined]);
  expect(calls[0].traceIdSeed).toBe('title-job');
  expect(config).toHaveBeenCalledWith(expect.objectContaining({ runId: 'title-job' }));
});

it('preserves inference when host tracing configuration is unavailable', async () => {
  const work = jest.fn(async () => response);
  const tracer = createMediaModelTracer({
    config: () => {
      throw new Error('unavailable');
    },
  });
  await expect(tracer.run(input, work, (result) => result.usage)).resolves.toBe(response);
  expect(work).toHaveBeenCalledTimes(1);
});

it('resolves the tenant-only destination before handing it to the SDK lifecycle', async () => {
  const keys = [
    'CREDS_KEY',
    'LANGFUSE_PUBLIC_KEY',
    'LANGFUSE_SECRET_KEY',
    'LANGFUSE_TRACING_ENABLED',
    'LANGFUSE_SAMPLE_RATE',
    'TENANT_ISOLATION_STRICT',
    'LANGFUSE_FANOUT_ENABLED',
  ];
  const original = new Map(keys.map((key) => [key, process.env[key]]));
  const calls: ModelInvocationTrace[] = [];
  try {
    for (const key of keys) delete process.env[key];
    process.env.CREDS_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    await jest.isolateModulesAsync(async () => {
      const { encryptV3 } = await import('@librechat/data-schemas');
      const { createMediaModelTracer: isolatedFactory } = await import('./tracing');
      const trace: typeof traceModelInvocation = async (params, work) => {
        calls.push(params);
        return work();
      };
      const tracer = isolatedFactory({ trace });
      await tracer.run(
        {
          ...input,
          context: {
            ...input.context,
            appConfig: {
              ...input.context.appConfig,
              langfuse: {
                enabled: true,
                publicKey: 'pk-tenant',
                secretKey: encryptV3('sk-tenant'),
                destination: 'us',
              },
            },
          },
        },
        async () => response,
        (result) => result.usage,
      );
    });
    expect(calls[0].langfuse).toMatchObject({
      publicKey: 'pk-tenant',
      secretKey: 'sk-tenant',
      baseUrl: 'https://us.cloud.langfuse.com',
      metadata: { 'librechat.tenant.id': 'tenant-a' },
    });
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
