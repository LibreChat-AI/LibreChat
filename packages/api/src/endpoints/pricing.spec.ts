import mongoose from 'mongoose';
import { EModelEndpoint } from 'librechat-data-provider';
import { createTxMethods } from '@librechat/data-schemas';
import type { EndpointTokenConfig } from '~/types';
import { matchModelName, findMatchingPattern } from '~/utils';
import { buildTokenConfigMap } from './pricing';

/** Adapters: TxDeps types are looser than the utils signatures (string endpoint, undefined miss) */
const { getValueKey, getMultiplier, getCacheMultiplier } = createTxMethods(mongoose, {
  matchModelName: (model, endpoint) => matchModelName(model, endpoint as EModelEndpoint),
  findMatchingPattern: (model, values) => findMatchingPattern(model, values) ?? undefined,
});

const deps = { getValueKey, getMultiplier, getCacheMultiplier };

describe('buildTokenConfigMap', () => {
  it('exposes Bedrock GPT context windows without changing GPT-OSS', () => {
    const models = [
      'us.openai.gpt-6-sol',
      'global.openai.gpt-6-astra',
      'us.openai.gpt-5.6-terra',
      'us.openai.gpt-oss-120b-1:0',
    ];
    const map = buildTokenConfigMap({ modelsConfig: { [EModelEndpoint.bedrock]: models } }, deps);

    for (const model of models.slice(0, 3)) {
      expect(map[EModelEndpoint.bedrock][model].context).toBe(950000);
    }
    expect(map[EModelEndpoint.bedrock][models[3]].context).toBe(128000);
  });

  it('resolves context windows without pricing by default', () => {
    const map = buildTokenConfigMap(
      {
        modelsConfig: {
          [EModelEndpoint.openAI]: ['gpt-4o'],
          [EModelEndpoint.anthropic]: ['claude-3-5-sonnet-20241022'],
        },
      },
      deps,
    );

    expect(map[EModelEndpoint.openAI]['gpt-4o'].context).toBeGreaterThan(100000);
    expect(map[EModelEndpoint.anthropic]['claude-3-5-sonnet-20241022'].context).toBe(200000);
    expect(map[EModelEndpoint.openAI]['gpt-4o'].prompt).toBeUndefined();
    expect(map[EModelEndpoint.openAI]['gpt-4o'].completion).toBeUndefined();
  });

  it('includes pattern-matched pricing when enabled', () => {
    const map = buildTokenConfigMap(
      {
        modelsConfig: {
          [EModelEndpoint.anthropic]: ['claude-3-5-sonnet-20241022'],
        },
        includePricing: true,
      },
      deps,
    );

    const tokenomics = map[EModelEndpoint.anthropic]['claude-3-5-sonnet-20241022'];
    expect(tokenomics.prompt).toBe(3);
    expect(tokenomics.completion).toBe(15);
    expect(tokenomics.cacheWrite).toBe(3.75);
    expect(tokenomics.cacheRead).toBe(0.3);
  });

  it('treats unknown endpoints as custom for context lookups', () => {
    const map = buildTokenConfigMap(
      {
        modelsConfig: { MyProxy: ['gpt-4o-mini'] },
      },
      deps,
    );

    expect(map.MyProxy['gpt-4o-mini'].context).toBeGreaterThan(0);
  });

  it('prefers endpoint token config overrides for context and rates', () => {
    const override: EndpointTokenConfig = {
      'custom-model': { prompt: 1.5, completion: 4.5, context: 32000 },
    };
    const map = buildTokenConfigMap(
      {
        modelsConfig: { MyProxy: ['custom-model', 'gpt-4o-mini'] },
        endpointTokenConfigs: { MyProxy: override },
        includePricing: true,
      },
      deps,
    );

    expect(map.MyProxy['custom-model']).toEqual({
      context: 32000,
      prompt: 1.5,
      completion: 4.5,
    });
    /** Models absent from the override fall back to static tables */
    expect(map.MyProxy['gpt-4o-mini'].context).toBeGreaterThan(0);
    expect(map.MyProxy['gpt-4o-mini'].prompt).toBeGreaterThan(0);
  });

  it('carries static cache rates from the override', () => {
    const override: EndpointTokenConfig = {
      'cached-model': {
        prompt: 3,
        completion: 15,
        context: 200000,
        cacheRead: 0.3,
        cacheWrite: 3.75,
      } as EndpointTokenConfig[string],
    };
    const map = buildTokenConfigMap(
      {
        modelsConfig: { MyProxy: ['cached-model'] },
        endpointTokenConfigs: { MyProxy: override },
        includePricing: true,
      },
      deps,
    );

    expect(map.MyProxy['cached-model']).toEqual({
      context: 200000,
      prompt: 3,
      completion: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
  });

  it('skips endpoints with empty model lists', () => {
    const map = buildTokenConfigMap({ modelsConfig: { [EModelEndpoint.agents]: [] } }, deps);
    expect(map[EModelEndpoint.agents]).toBeUndefined();
  });
});
