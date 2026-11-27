import type { BaseInitializeParams } from '~/types';

jest.mock('~/auth', () => ({
  validateEndpointURL: jest.fn(),
  createSSRFSafeUndiciConnect: jest.fn(() => ({ lookup: jest.fn() })),
}));

const mockGetOpenAIConfig = jest.fn((..._args: unknown[]) => ({
  llmConfig: { model: 'claude-haiku-4-5' } as Record<string, unknown>,
  configOptions: {},
}));
jest.mock('~/endpoints/openai/config', () => ({
  getOpenAIConfig: (...args: unknown[]) => mockGetOpenAIConfig(...args),
}));

jest.mock('~/endpoints/models', () => ({ fetchModels: jest.fn() }));
jest.mock('~/cache', () => ({
  standardCache: jest.fn(() => ({ get: jest.fn().mockResolvedValue(null) })),
  tokenConfigCache: jest.fn(() => ({ get: jest.fn().mockResolvedValue(null) })),
}));
jest.mock('~/utils', () => ({
  isUserProvided: (val: string) => val === 'user_provided',
  checkUserKeyExpiry: jest.fn(),
}));

const mockGetCustomEndpointConfig = jest.fn();
jest.mock('~/app/config', () => ({
  getCustomEndpointConfig: (...args: unknown[]) => mockGetCustomEndpointConfig(...args),
}));

import { initializeCustom } from './initialize';

function makeParams({
  allBlock,
  endpointStreamRate,
}: {
  allBlock?: Record<string, unknown>;
  endpointStreamRate?: number;
} = {}): BaseInitializeParams {
  mockGetCustomEndpointConfig.mockReturnValue({
    apiKey: 'test-key',
    baseURL: 'https://gateway.example.com/v1',
    models: { default: ['claude-haiku-4-5'], fetch: false },
    streamRate: endpointStreamRate,
  });

  return {
    req: {
      user: { id: 'user-1' },
      body: {},
      config: allBlock ? { endpoints: { all: allBlock } } : {},
    } as unknown as BaseInitializeParams['req'],
    endpoint: 'ClickHouse',
    model_parameters: { model: 'claude-haiku-4-5' },
    db: { getUserKeyValues: jest.fn() } as unknown as BaseInitializeParams['db'],
  };
}

function streamDelayOf(options: { llmConfig: unknown }): unknown {
  return (options.llmConfig as Record<string, unknown>)._lc_stream_delay;
}

describe('custom endpoint streamRate resolution', () => {
  beforeEach(() => jest.clearAllMocks());

  it('applies the endpoint streamRate when no `endpoints.all` block is present', async () => {
    const options = await initializeCustom(makeParams({ endpointStreamRate: 25 }));
    expect(streamDelayOf(options)).toBe(25);
  });

  it('preserves the endpoint streamRate when `endpoints.all` exists without its own streamRate', async () => {
    const options = await initializeCustom(
      makeParams({
        endpointStreamRate: 25,
        allBlock: { activityLabel: true, activityModel: 'gpt-5.6-luna' },
      }),
    );
    expect(streamDelayOf(options)).toBe(25);
  });

  it('lets `endpoints.all.streamRate` override the endpoint streamRate', async () => {
    const options = await initializeCustom(
      makeParams({ endpointStreamRate: 25, allBlock: { streamRate: 10 } }),
    );
    expect(streamDelayOf(options)).toBe(10);
  });

  it('leaves the stream delay unset when neither level configures a streamRate', async () => {
    const options = await initializeCustom(makeParams({ allBlock: { activityLabel: true } }));
    expect(streamDelayOf(options)).toBeUndefined();
  });

  it('lets `endpoints.all.streamRate: 0` override an endpoint streamRate (explicit disable)', async () => {
    const options = await initializeCustom(
      makeParams({ endpointStreamRate: 25, allBlock: { streamRate: 0 } }),
    );
    expect(streamDelayOf(options)).toBe(0);
  });

  it('passes an explicit endpoint `streamRate: 0` through to the llmConfig', async () => {
    const options = await initializeCustom(makeParams({ endpointStreamRate: 0 }));
    expect(streamDelayOf(options)).toBe(0);
  });
});
