import { EModelEndpoint, validateAzureGroups } from 'librechat-data-provider';
import type { TAzureGroups, TEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { resolveVision } from './vision';

const litellm: Partial<TEndpoint> = {
  name: 'LiteLLM',
  vision: false,
  models: {
    default: ['qwen3', { name: 'gpt-4o', vision: true }, { name: 'gemma', description: 'Gemma' }],
  },
};

function withAzure(groups: TAzureGroups, vision?: boolean): AppConfig {
  const { modelNames, modelGroupMap, groupMap } = validateAzureGroups(groups);
  return {
    endpoints: {
      [EModelEndpoint.azureOpenAI]: {
        groups,
        modelNames,
        modelGroupMap,
        groupMap,
        isValid: true,
        errors: [],
        ...(vision != null ? { vision } : {}),
      },
    },
  } as unknown as AppConfig;
}

describe('resolveVision', () => {
  it('declares nothing when no config, entry or spec says anything', () => {
    expect(resolveVision({ endpoint: 'LiteLLM', model: 'qwen3' })).toBeUndefined();
    expect(
      resolveVision({
        endpoint: EModelEndpoint.openAI,
        model: 'gpt-4o',
        appConfig: { endpoints: { openAI: { models: ['gpt-4o'] } } } as unknown as AppConfig,
      }),
    ).toBeUndefined();
  });

  it("takes a custom endpoint model's own entry over the endpoint", () => {
    const resolve = (model: string) =>
      resolveVision({ endpoint: 'LiteLLM', model, customEndpointConfig: litellm });

    expect(resolve('gpt-4o')).toBe(true);
    expect(resolve('qwen3')).toBe(false);
    expect(resolve('gemma')).toBe(false);
    expect(resolve('fetched-only-model')).toBe(false);
  });

  it('takes the model spec over the model entry and the endpoint', () => {
    expect(
      resolveVision({
        endpoint: 'LiteLLM',
        model: 'gpt-4o',
        customEndpointConfig: litellm,
        modelSpec: { vision: false },
      }),
    ).toBe(false);
    expect(
      resolveVision({
        endpoint: 'LiteLLM',
        model: 'qwen3',
        customEndpointConfig: litellm,
        modelSpec: { vision: true },
      }),
    ).toBe(true);
    expect(
      resolveVision({
        endpoint: 'LiteLLM',
        model: 'qwen3',
        customEndpointConfig: litellm,
        modelSpec: {},
      }),
    ).toBe(false);
  });

  it("takes the agent's own text-only switch over every declaration", () => {
    expect(
      resolveVision({
        endpoint: 'LiteLLM',
        model: 'gpt-4o',
        customEndpointConfig: litellm,
        modelSpec: { vision: true },
        textOnly: true,
      }),
    ).toBe(false);
    expect(resolveVision({ endpoint: 'groq', model: 'llama3', textOnly: true })).toBe(false);
    expect(
      resolveVision({
        endpoint: 'LiteLLM',
        model: 'gpt-4o',
        customEndpointConfig: litellm,
        textOnly: false,
      }),
    ).toBe(true);
  });

  it.each([
    EModelEndpoint.openAI,
    EModelEndpoint.google,
    EModelEndpoint.anthropic,
    EModelEndpoint.bedrock,
  ])('reads the models list of the built-in %s endpoint', (endpoint) => {
    const appConfig = {
      endpoints: {
        [endpoint]: { vision: true, models: ['model-a', { name: 'model-b', vision: false }] },
      },
    } as unknown as AppConfig;

    expect(resolveVision({ appConfig, endpoint, model: 'model-b' })).toBe(false);
    expect(resolveVision({ appConfig, endpoint, model: 'model-a' })).toBe(true);
  });

  it('reads the model in its Azure group before the Azure endpoint', () => {
    const appConfig = withAzure(
      [
        {
          group: 'east',
          apiKey: 'key',
          instanceName: 'east',
          version: '2024-10-21',
          models: {
            'gpt-4o': { deploymentName: 'gpt-4o' },
            phi: { deploymentName: 'phi', vision: false },
          },
        },
      ],
      true,
    );
    const resolve = (model: string) =>
      resolveVision({ appConfig, endpoint: EModelEndpoint.azureOpenAI, model });

    expect(resolve('phi')).toBe(false);
    expect(resolve('gpt-4o')).toBe(true);
  });

  it('ignores the built-in config for an endpoint that is not listed', () => {
    const appConfig = { endpoints: { openAI: { vision: false } } } as unknown as AppConfig;

    expect(resolveVision({ appConfig, endpoint: 'groq', model: 'llama3' })).toBeUndefined();
  });
});
