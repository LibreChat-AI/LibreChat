import { Run, Providers } from '@librechat/agents';
import { encryptV3 } from '@librechat/data-schemas';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import type { AppConfig, IUser } from '@librechat/data-schemas';
import type { Response } from 'express';
import { isLangfuseTraceSampled } from '~/langfuse/policy';
import { traceIdForMessage } from '~/langfuse/trace';
import { createMemoryProcessor } from './memory';

jest.mock('@librechat/data-schemas', () => {
  process.env.CREDS_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  return jest.requireActual('@librechat/data-schemas');
});

const envKeys = [
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_BASE_URL',
  'LANGFUSE_HOST',
  'LANGFUSE_BASEURL',
  'LANGFUSE_TRACING_ENABLED',
  'LANGFUSE_SAMPLE_RATE',
  'LANGFUSE_FANOUT_ENABLED',
  'LANGFUSE_FANOUT_COLLECTOR_URL',
  'LANGFUSE_FANOUT_TENANT_DESTINATIONS',
  'LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED',
  'LANGFUSE_FANOUT_CENTRAL_MEDIA_UPLOAD_DISABLED',
  'TENANT_ISOLATION_STRICT',
];
const originalEnv = process.env;

async function runMemory(overrides: Partial<Parameters<typeof createMemoryProcessor>[0]> = {}) {
  const processStream = jest.fn().mockResolvedValue('done');
  const create = jest.spyOn(Run, 'create').mockResolvedValue({ processStream } as never);
  const [, processMemory] = await createMemoryProcessor({
    res: { write: jest.fn() } as unknown as Response,
    userId: 'user-1',
    user: { id: 'user-1', email: 'memory@example.com', role: 'USER' } as IUser,
    messageId: 'message-1',
    conversationId: 'conversation-1',
    config: { llmConfig: { provider: Providers.OPENAI, model: 'memory-model' } },
    memoryMethods: {
      setMemory: jest.fn(),
      deleteMemory: jest.fn(),
      getUserMemories: jest.fn(),
      getFormattedMemories: jest.fn().mockResolvedValue({
        withKeys: '',
        withoutKeys: '',
        totalTokens: 0,
      }),
    },
    ...overrides,
  });
  expect(processMemory).toBeDefined();
  await processMemory!([new HumanMessage('Synthetic memory input')]);
  expect(create).toHaveBeenCalledTimes(1);
  expect(processStream).toHaveBeenCalledTimes(1);
  return { run: create.mock.calls[0][0], stream: processStream.mock.calls[0][1] };
}

describe('automatic memory tracing policy', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of envKeys) {
      delete process.env[key];
    }
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-synthetic';
    process.env.LANGFUSE_SECRET_KEY = 'sk-synthetic';
    process.env.LANGFUSE_BASE_URL = 'https://central.example.com';
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('forwards configured identity and allowlisted request metadata through the processor', async () => {
    const { run, stream } = await runMemory({
      appConfig: {
        langfuse: {
          trace: {
            userIdField: 'email',
            userMetadataFields: ['role'],
            conversationMetadataFields: [
              'conversationId',
              'model',
              'provider',
              'endpoint',
              'endpointType',
              'modelLabel',
              'spec',
            ],
          },
        },
      } as AppConfig,
      traceContext: {
        endpoint: 'custom-endpoint',
        endpointType: 'agents',
        modelLabel: 'Chat Model',
        spec: 'spec-1',
      },
    });

    expect(run.langfuse).toMatchObject({
      deterministicTraceId: false,
      userId: 'memory@example.com',
      metadata: {
        'librechat.user.role': 'USER',
        'librechat.conversation.id': 'conversation-1',
        'librechat.model': 'memory-model',
        'librechat.provider': Providers.OPENAI,
        'librechat.endpoint': 'custom-endpoint',
        'librechat.endpoint.type': 'agents',
        'librechat.model.label': 'Chat Model',
        'librechat.spec': 'spec-1',
      },
    });
    expect(run.langfuse?.metadata).not.toHaveProperty('librechat.user.email');
    expect(run.runId).toBe('message-1');
    expect(stream.configurable).toMatchObject({
      user_id: 'user-1',
      thread_id: 'conversation-1',
    });
  });

  it('preserves caller trace-context overrides', async () => {
    const { run } = await runMemory({
      appConfig: {
        langfuse: { trace: { conversationMetadataFields: ['model', 'provider'] } },
      } as AppConfig,
      traceContext: { model: 'override-model', provider: 'override-provider' },
    });
    expect(run.langfuse?.metadata).toMatchObject({
      'librechat.model': 'override-model',
      'librechat.provider': 'override-provider',
    });
  });

  it('keeps the internal user id fallback without changing memory attachment identity', async () => {
    const { run, stream } = await runMemory({
      appConfig: { langfuse: { trace: { userIdField: 'samlId' } } } as AppConfig,
    });
    expect(run.langfuse).toBeDefined();
    expect(run.langfuse?.userId).toBeUndefined();
    expect(run.runId).toBe('message-1');
    expect(stream.configurable.user_id).toBe('user-1');
  });

  it.each([
    ['temporary chat', { isTemporary: true }],
    [
      'forced ephemeral retention',
      { appConfig: { interfaceConfig: { retentionMode: 'ephemeral' } } },
    ],
  ])(
    'explicitly disables every trace destination for %s despite env credentials',
    async (_name, options) => {
      const { run } = await runMemory(options as Parameters<typeof runMemory>[0]);
      expect(run.langfuse).toMatchObject({ enabled: false, deterministicTraceId: false });
    },
  );

  it('honors explicit temporary-chat opt-in', async () => {
    const { run } = await runMemory({
      isTemporary: true,
      appConfig: { langfuse: { trace: { temporaryChats: true } } } as AppConfig,
    });
    expect(run.langfuse).toMatchObject({ baseUrl: 'https://central.example.com' });
    expect(run.langfuse?.enabled).not.toBe(false);
  });

  it.each([
    ['LANGFUSE_TRACING_ENABLED', 'false'],
    ['LANGFUSE_SAMPLE_RATE', '0'],
  ])('explicitly disables tracing when %s=%s', async (key, value) => {
    process.env[key] = value;
    const { run } = await runMemory();
    expect(run.langfuse).toMatchObject({ enabled: false });
  });

  it.each([true, false])('uses the response message sampling decision (%s)', async (sampled) => {
    process.env.LANGFUSE_SAMPLE_RATE = '0.5';
    let messageId = '';
    for (let i = 0; i < 100; i++) {
      const candidate = `response-${i}`;
      if (isLangfuseTraceSampled(traceIdForMessage(candidate)) === sampled) {
        messageId = candidate;
        break;
      }
    }
    expect(messageId).not.toBe('');
    const { run } = await runMemory({ messageId });
    expect(run.runId).toBe(messageId);
    expect(run.langfuse).toBeDefined();
    expect(run.langfuse?.enabled === false).toBe(!sampled);
    expect(run.langfuse?.deterministicTraceId).toBe(false);
  });

  it('routes through the configured tenant collector instead of the central env destination', async () => {
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector.example.com:4318';
    const { run } = await runMemory({
      tenantId: 'tenant-1',
      appConfig: {
        langfuse: {
          enabled: true,
          publicKey: 'pk-tenant',
          secretKey: encryptV3('sk-tenant'),
          destination: 'us',
        },
      } as AppConfig,
    });
    expect(run.langfuse).toMatchObject({
      baseUrl: 'http://collector.example.com:4318/tenant/us',
      publicKey: 'pk-tenant',
      secretKey: 'sk-tenant',
      metadata: { 'librechat.tenant.id': 'tenant-1' },
      tags: ['tenant:tenant-1'],
    });
  });
});
