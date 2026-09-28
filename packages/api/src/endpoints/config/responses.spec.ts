import {
  EModelEndpoint,
  resolveEffectiveUseResponsesApi,
  validateAzureGroups,
} from 'librechat-data-provider';
import type { OpenAIClientOptions } from '@librechat/agents';
import type { TAzureGroup } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { createEndpointsConfigService } from './endpoints';
import { initializeOpenAI } from '../openai/initialize';
import { getResponsesApiRouting } from './responses';

// Only DNS/URL validation is stubbed. Actual credential resolution, group
// selection, parameter precedence and getOpenAIConfig all execute below.
jest.mock('~/auth', () => ({
  ...jest.requireActual('~/auth'),
  validateEndpointURL: jest.fn().mockResolvedValue(undefined),
}));
const config = (endpoints: Record<string, unknown> = {}) => ({ endpoints }) as AppConfig;
const env = { ...process.env };
const enabled = { default: true, on: true, off: false };
const disabled = { default: false, on: false, off: false };
const optIn = { default: false, on: true, off: false };
const models = ['gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra'];
function grouped(overrides: Partial<TAzureGroup> = {}) {
  const azure = validateAzureGroups([
    {
      group: 'test',
      apiKey: 'test-key',
      instanceName: 'test-instance',
      deploymentName: 'deployment',
      version: '2025-04-01-preview',
      models: Object.fromEntries(models.map((m) => [m, true])),
      ...overrides,
    },
  ]);
  expect(azure.isValid).toBe(true);
  return config({ azureOpenAI: azure });
}
const db = {
  getUserKey: jest.fn().mockResolvedValue('test-key'),
  getUserKeyValues: jest
    .fn()
    .mockResolvedValue({ apiKey: 'test-key', baseURL: 'https://user-gateway.example/v1' }),
};
async function runtime(
  appConfig: AppConfig,
  endpoint: EModelEndpoint,
  model: string,
  value?: boolean,
  webSearch?: boolean,
) {
  return (
    (
      (
        await initializeOpenAI({
          endpoint,
          model_parameters: { model, useResponsesApi: value, web_search: webSearch },
          db,
          runtime: { appConfig, requestBody: { key: '2099-01-01' } },
        })
      ).llmConfig as OpenAIClientOptions
    ).useResponsesApi === true
  );
}
async function expectParity(appConfig: AppConfig, endpoint: EModelEndpoint, model: string) {
  const routing = getResponsesApiRouting(appConfig, endpoint as EModelEndpoint.openAI);
  for (const value of [undefined, false, true]) {
    for (const webSearch of [false, true]) {
      const actual = await runtime(appConfig, endpoint, model, value, webSearch);
      expect(resolveEffectiveUseResponsesApi({ endpoint, model, value, webSearch, routing })).toBe(
        actual,
      );
    }
  }
  return routing;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.OPENAI_REVERSE_PROXY;
  delete process.env.AZURE_OPENAI_BASEURL;
  delete process.env.AZURE_OPENAI_DEFAULT_MODEL;
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.AZURE_API_KEY = 'test-key';
  process.env.AZURE_OPENAI_API_INSTANCE_NAME = 'test-instance';
  process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME = 'deployment';
  process.env.AZURE_OPENAI_API_VERSION = '2025-04-01-preview';
});
afterEach(() => {
  process.env = { ...env };
});

describe.each([EModelEndpoint.openAI, EModelEndpoint.azureOpenAI])(
  '%s routing parity',
  (endpoint) => {
    it.each(models)(
      'matches every stored toggle and web-search state for native %s',
      async (model) => {
        const routing = await expectParity(config(), endpoint, model);
        expect(routing[model]).toMatchObject(enabled);
      },
    );
    it.each(models)(
      'matches environment/discovered snapshot %s without guessing Azure group members',
      async (model) => {
        const routing = await expectParity(config(), endpoint, `${model}-2026-09-22`);
        expect(routing[`${model}-*`]).toMatchObject(enabled);
      },
    );
    it('does not apply unsupported global parameter drops', async () => {
      const appConfig = config({ all: { dropParams: ['useResponsesApi'] } });
      const routing = await expectParity(appConfig, endpoint, 'gpt-6-sol');
      expect(routing['gpt-6-sol']).toMatchObject(enabled);
    });
    it('matches a noncanonical reverse proxy without advertising its URL', async () => {
      process.env[
        endpoint === EModelEndpoint.openAI ? 'OPENAI_REVERSE_PROXY' : 'AZURE_OPENAI_BASEURL'
      ] = 'https://gateway.example/v1';
      const routing = await expectParity(config(), endpoint, 'gpt-6-sol');
      expect(routing['gpt-6-sol']).toMatchObject(optIn);
      expect(JSON.stringify(routing)).not.toMatch(/gateway|https|apiKey|api-key/);
    });
    it('handles a user-provided URL conservatively but retains forced routing by web search', async () => {
      process.env[
        endpoint === EModelEndpoint.openAI ? 'OPENAI_REVERSE_PROXY' : 'AZURE_OPENAI_BASEURL'
      ] = 'user_provided';
      const routing = await expectParity(config(), endpoint, 'gpt-6-sol');
      expect(routing['gpt-6-sol']).toMatchObject(optIn);
      expect(db.getUserKeyValues).toHaveBeenCalled();
    });
  },
);

describe('Azure group parity', () => {
  it.each([
    {},
    { serverless: true, baseURL: 'https://inference.example/v1' },
    { baseURL: 'https://gateway.example/v1' },
  ])('matches initialization without forcing serverless or gateway routes: %j', async (group) => {
    expect.hasAssertions();
    const appConfig = grouped(group);
    for (const model of models) await expectParity(appConfig, EModelEndpoint.azureOpenAI, model);
  });
  it.each([
    { dropParams: ['useResponsesApi'] },
    { addParams: { useResponsesApi: true } },
    { addParams: { useResponsesApi: false } },
    { addParams: { web_search: true } },
    { addParams: { model: 'gpt-4.1' } },
    { addParams: { web_search: true }, dropParams: ['useResponsesApi', 'web_search'] },
  ])('matches group parameter precedence: %j', async (group) => {
    expect.hasAssertions();
    await expectParity(grouped(group), EModelEndpoint.azureOpenAI, 'gpt-6-sol');
  });
  it.each([{ useResponsesApi: true }, { web_search: true }])(
    'preserves admin-forced routing with an unknown user URL: %j',
    async (addParams) => {
      process.env.AZURE_OPENAI_BASEURL = 'user_provided';
      const routing = await expectParity(
        grouped({ addParams }),
        EModelEndpoint.azureOpenAI,
        'gpt-6-sol',
      );
      expect(routing['gpt-6-sol'].default).toBe(true);
    },
  );
  it('never inherits snapshot capabilities for unconfigured deployments', () => {
    const routing = getResponsesApiRouting(grouped(), EModelEndpoint.azureOpenAI);
    expect(
      resolveEffectiveUseResponsesApi({
        endpoint: EModelEndpoint.azureOpenAI,
        model: 'gpt-6-sol-2026-09-22',
        routing,
      }),
    ).toBe(false);
    expect(routing['gpt-6-sol-*']).toBeUndefined();
  });
});

it('does not invent native add/drop support outside the native endpoint schema', async () => {
  expect.hasAssertions();
  await expectParity(
    config({ openAI: { addParams: { useResponsesApi: true }, dropParams: ['useResponsesApi'] } }),
    EModelEndpoint.openAI,
    'gpt-6-sol',
  );
});
it('leaves custom endpoints and old servers without model-inferred upload permissions', () => {
  expect(
    resolveEffectiveUseResponsesApi({ endpoint: EModelEndpoint.azureOpenAI, model: 'gpt-6-sol' }),
  ).toBeUndefined();
  expect(
    resolveEffectiveUseResponsesApi({
      endpoint: EModelEndpoint.custom,
      model: 'gpt-6-sol',
      routing: { 'gpt-6-sol': enabled },
    }),
  ).toBeUndefined();
});
it('serves sanitized policy without mutating cached endpoint entries across requests', async () => {
  const defaults = { azureOpenAI: { order: 0 } };
  const service = createEndpointsConfigService({
    getAppConfig: async () => grouped(),
    loadDefaultEndpointsConfig: async () => defaults,
  });
  const a = await service.getEndpointsConfig({
    config: grouped({ dropParams: ['useResponsesApi'] }),
  } as never);
  const b = await service.getEndpointsConfig({ config: grouped() } as never);
  expect(a?.azureOpenAI?.responsesApiRouting?.['gpt-6-sol']).toMatchObject(disabled);
  expect(b?.azureOpenAI?.responsesApiRouting?.['gpt-6-sol']).toMatchObject(enabled);
  expect(defaults.azureOpenAI).not.toHaveProperty('responsesApiRouting');
  expect(JSON.stringify(b)).not.toMatch(/test-key|test-instance|deployment|apiKey|api-key/);
});
