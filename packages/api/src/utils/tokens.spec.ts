import { EModelEndpoint } from 'librechat-data-provider';
import type { EndpointTokenConfig } from '~/types';
import { getModelMaxTokens, getModelMaxOutputTokens, findMatchingPattern } from './tokens';

describe('Bedrock OpenAI context windows', () => {
  const models = [
    'gpt-6-sol',
    'gpt-6-luna',
    'gpt-6-astra',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
  ];

  it.each(models)('resolves %s across Bedrock inference profiles', (model) => {
    for (const prefix of ['', 'us.', 'global.']) {
      expect(getModelMaxTokens(`${prefix}openai.${model}`, EModelEndpoint.bedrock)).toBe(950000);
    }
  });

  it('matches versioned profiles without changing the native OpenAI context window', () => {
    expect(getModelMaxTokens('us.openai.gpt-6-sol-2026-09-22', EModelEndpoint.bedrock)).toBe(
      950000,
    );
    expect(getModelMaxTokens('gpt-6-sol', EModelEndpoint.openAI)).toBe(1050000);
  });

  it('keeps GPT-OSS limits and unknown-model fallback unchanged', () => {
    for (const model of ['openai.gpt-oss-20b-1:0', 'us.openai.gpt-oss-120b-1:0']) {
      expect(getModelMaxTokens(model, EModelEndpoint.bedrock)).toBe(128000);
    }
    expect(getModelMaxTokens('us.openai.unknown-model', EModelEndpoint.bedrock)).toBeUndefined();
  });

  it('preserves explicit endpoint overrides while falling back for unlisted profiles', () => {
    const override: EndpointTokenConfig = {
      'openai.gpt-6-sol': { context: 64000, prompt: 1, completion: 1 },
    };
    expect(getModelMaxTokens('us.openai.gpt-6-sol', EModelEndpoint.bedrock, override)).toBe(64000);
    expect(getModelMaxTokens('global.openai.gpt-6-luna', EModelEndpoint.bedrock, override)).toBe(
      950000,
    );
  });

  it('prefers the GPT-5.6 key over shorter keys proposed for Bedrock Mantle', () => {
    const keys = {
      'openai.gpt-5': 272000,
      'openai.gpt-5.5': 272000,
      'openai.gpt-5.6': 950000,
    };
    expect(findMatchingPattern('us.openai.gpt-5.6-sol', keys)).toBe('openai.gpt-5.6');
  });
});

describe('getModelMaxTokens partial-override fallback', () => {
  const partialOverride: EndpointTokenConfig = {
    'custom-model': { prompt: 1, completion: 2, context: 32000, output: 4096 },
  };

  it('returns undefined for non-string model values from JavaScript consumers', () => {
    for (const model of [undefined, null, 123]) {
      expect(getModelMaxTokens(model as unknown as string)).toBeUndefined();
    }
  });

  it('uses the override for a listed model', () => {
    expect(getModelMaxTokens('custom-model', EModelEndpoint.openAI, partialOverride)).toBe(32000);
  });

  it('falls back to the built-in map for a model absent from a partial override', () => {
    const fallback = getModelMaxTokens('gpt-4o', EModelEndpoint.openAI, partialOverride);
    const builtin = getModelMaxTokens('gpt-4o', EModelEndpoint.openAI);
    expect(fallback).toBe(builtin);
    expect(fallback).toBeGreaterThan(100000);
  });
});

describe('future Claude context windows', () => {
  it('uses the 1M profile for future Sonnet and Opus model IDs', () => {
    for (const model of ['claude-sonnet-6', 'claude-opus-6']) {
      expect(getModelMaxTokens(model, EModelEndpoint.anthropic)).toBe(1000000);
    }
  });

  it('keeps the safe Claude fallback for unsupported model families', () => {
    expect(getModelMaxTokens('claude-haiku-4', EModelEndpoint.anthropic)).toBe(100000);
  });
});

describe('getModelMaxOutputTokens partial-override fallback', () => {
  const partialOverride: EndpointTokenConfig = {
    'custom-model': { prompt: 1, completion: 2, context: 32000, output: 4096 },
  };

  it('falls back to the built-in map for a model absent from a partial override', () => {
    const fallback = getModelMaxOutputTokens('gpt-4o', EModelEndpoint.openAI, partialOverride);
    const builtin = getModelMaxOutputTokens('gpt-4o', EModelEndpoint.openAI);
    expect(fallback).toBe(builtin);
    expect(fallback).toBeGreaterThan(0);
  });
});

describe('gpt-5.6 tiers', () => {
  it('resolves 1.05M context and 128K output for every tier and the sol alias', () => {
    for (const model of ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(getModelMaxTokens(model, EModelEndpoint.openAI)).toBe(1050000);
      expect(getModelMaxOutputTokens(model, EModelEndpoint.openAI)).toBe(128000);
    }
  });

  it('matches the longest tier key over the shorter gpt-5 pattern', () => {
    expect(getModelMaxTokens('openai/gpt-5.6-terra-2026-07-09', EModelEndpoint.openAI)).toBe(
      1050000,
    );
    expect(getModelMaxTokens('gpt-5', EModelEndpoint.openAI)).toBe(400000);
  });
});

describe('Gemini 3.7 Flash', () => {
  it('resolves the 1,048,576-token context window', () => {
    expect(getModelMaxTokens('gemini-3.7-flash', EModelEndpoint.google)).toBe(1048576);
  });

  it('matches the longest key over the shorter gemini-3 pattern for aliases', () => {
    expect(getModelMaxTokens('models/gemini-3.7-flash-latest', EModelEndpoint.google)).toBe(
      1048576,
    );
    expect(getModelMaxTokens('gemini-3', EModelEndpoint.google)).toBe(1000000);
  });
});

describe('Gemini 3.8 Flash', () => {
  it('resolves the 1,048,576-token context window', () => {
    expect(getModelMaxTokens('gemini-3.8-flash', EModelEndpoint.google)).toBe(1048576);
  });

  it('matches the longest key over the shorter gemini-3 pattern for aliases', () => {
    expect(getModelMaxTokens('models/gemini-3.8-flash-latest', EModelEndpoint.google)).toBe(
      1048576,
    );
  });
});

describe('GPT-6 Astra', () => {
  it('resolves 1.05M context and 128K output', () => {
    expect(getModelMaxTokens('gpt-6-astra', EModelEndpoint.openAI)).toBe(1050000);
    expect(getModelMaxOutputTokens('gpt-6-astra', EModelEndpoint.openAI)).toBe(128000);
  });

  it('matches its own key for snapshots and provider prefixes', () => {
    for (const model of [
      'gpt-6-astra-2026-04-30',
      'openai/gpt-6-astra',
      'gpt-6-astra-2026-04-30/openai',
    ]) {
      expect(getModelMaxTokens(model, EModelEndpoint.openAI)).toBe(1050000);
      expect(getModelMaxOutputTokens(model, EModelEndpoint.openAI)).toBe(128000);
    }
  });
});

describe('Qwen3.5 and later generations', () => {
  it('resolves 262K for the vLLM model id that regressed to the qwen3 window', () => {
    expect(getModelMaxTokens('Qwen/Qwen3.5-397B-A17B-FP8', EModelEndpoint.openAI)).toBe(262144);
  });

  it('resolves 262K natively for every 3.5 through 3.8 generation', () => {
    for (const model of ['qwen3.5', 'qwen3.6', 'qwen3.7', 'qwen3.8']) {
      expect(getModelMaxTokens(model, EModelEndpoint.openAI)).toBe(262144);
      expect(getModelMaxTokens(`Qwen/${model}-27B`, EModelEndpoint.openAI)).toBe(262144);
    }
  });

  it('prefers the hosted plus/flash tiers over the generation window', () => {
    for (const model of ['qwen3.5-plus', 'qwen3.6-flash', 'qwen3.7-plus']) {
      expect(getModelMaxTokens(model, EModelEndpoint.openAI)).toBe(1000000);
    }
  });

  it('leaves the qwen3 generation and its parameter sizes untouched', () => {
    expect(getModelMaxTokens('qwen3', EModelEndpoint.openAI)).toBe(40960);
    expect(getModelMaxTokens('qwen3-30b-a3b', EModelEndpoint.openAI)).toBe(40960);
    expect(getModelMaxTokens('qwen3-235b-a22b', EModelEndpoint.openAI)).toBe(40960);
    expect(getModelMaxTokens('qwen2.5-72b', EModelEndpoint.openAI)).toBe(32000);
  });
});

describe('Meta Muse and Llama 4', () => {
  it('resolves the 1M Muse Spark window across id spellings', () => {
    for (const model of ['muse-spark-1.1', 'meta/muse-spark-1.2', 'musespark']) {
      expect(getModelMaxTokens(model, EModelEndpoint.openAI)).toBe(1000000);
    }
  });

  it('resolves the 131K Muse Glimmer window', () => {
    expect(getModelMaxTokens('meta-models/Muse-Glimmer-30B', EModelEndpoint.openAI)).toBe(131072);
  });

  it('resolves Llama 4 instead of falling through to no match', () => {
    for (const model of [
      'meta.llama4-scout-17b-instruct-v1:0',
      'meta-llama/Llama-4-Maverick-17B-128E-Instruct',
    ]) {
      expect(getModelMaxTokens(model, EModelEndpoint.bedrock)).toBe(1048576);
    }
  });

  it('keeps Llama 3.x on its own window', () => {
    expect(getModelMaxTokens('llama-3.3-70b', EModelEndpoint.openAI)).toBe(127500);
  });
});

describe('newer windows for existing families', () => {
  it.each([
    ['grok-4.6', 500000],
    ['x-ai/grok-4-5', 500000],
    ['deepseek-v3.2', 163840],
    ['deepseek-v4-flash', 1048576],
    ['glm-4.7', 204800],
    ['z-ai/glm-5.2', 1048576],
    ['glm-5.3', 1048576],
    ['moonshotai/kimi-k3', 1048576],
    ['kimi-k2.7-code', 262144],
    ['minimax-m3', 1048576],
    ['mistral-medium-3-5', 262144],
    ['nova-2-lite', 995000],
  ])('resolves %s to %i tokens', (model, expected) => {
    expect(getModelMaxTokens(model, EModelEndpoint.openAI)).toBe(expected);
  });

  it('keeps command-a-plus off the wider command-a window', () => {
    expect(getModelMaxTokens('command-a', EModelEndpoint.openAI)).toBe(255500);
    expect(getModelMaxTokens('command-a-plus-05-2026', EModelEndpoint.openAI)).toBe(127500);
  });
});

describe('vendor-prefixed model ids', () => {
  it('matches the model segment rather than the vendor prefix', () => {
    expect(getModelMaxTokens('moonshotai/kimi-k2', EModelEndpoint.openAI)).toBe(262144);
    expect(getModelMaxTokens('moonshot/kimi-k2', EModelEndpoint.openAI)).toBe(262144);
    expect(getModelMaxTokens('moonshotai/kimi-k3', EModelEndpoint.openAI)).toBe(1048576);
  });

  it('still resolves prefixed ids whose model segment alone has no match', () => {
    expect(getModelMaxTokens('moonshot/v1-8k', EModelEndpoint.openAI)).toBe(
      getModelMaxTokens('moonshot', EModelEndpoint.openAI),
    );
  });

  it('keeps a vendor-keyed override entry over a bare one', () => {
    const config: EndpointTokenConfig = {
      'openrouter/foo': { prompt: 1, completion: 2, context: 900000, output: 1 },
      foo: { prompt: 1, completion: 2, context: 1000, output: 1 },
    };
    expect(getModelMaxTokens('openrouter/foo', EModelEndpoint.custom, config)).toBe(900000);
    expect(getModelMaxTokens('openrouter/foo-latest', EModelEndpoint.custom, config)).toBe(900000);
    expect(getModelMaxTokens('other/foo-latest', EModelEndpoint.custom, config)).toBe(1000);
  });

  it('leaves dot-separated bedrock ids alone', () => {
    expect(getModelMaxTokens('moonshot.kimi-k2-thinking', EModelEndpoint.bedrock)).toBe(262144);
    expect(getModelMaxTokens('us.anthropic.claude-3-5-sonnet-20241022-v2:0')).toBe(200000);
  });
});

describe('Grok 4.7 context window', () => {
  it.each(['grok-4.7', 'x-ai/grok-4.7', 'xai/grok-4.7', 'grok-4-7'])(
    'resolves %s through the custom endpoint without falling back to Grok 4',
    (model) => {
      expect(getModelMaxTokens(model, EModelEndpoint.custom)).toBe(500000);
    },
  );

  it('preserves explicit operator context overrides', () => {
    const config: EndpointTokenConfig = {
      'grok-4.7': { prompt: 2, completion: 6, context: 32000, output: 4096 },
    };
    expect(getModelMaxTokens('grok-4.7', EModelEndpoint.custom, config)).toBe(32000);
  });

  it('keeps older Grok context windows unchanged', () => {
    expect(getModelMaxTokens('grok-4', EModelEndpoint.custom)).toBe(256000);
    expect(getModelMaxTokens('grok-4-fast', EModelEndpoint.custom)).toBe(2000000);
    expect(getModelMaxTokens('grok-4.6', EModelEndpoint.custom)).toBe(500000);
  });
});

describe('Opus 5.5 token limits', () => {
  it.each([
    'claude-opus-5-5',
    'claude-opus-5.5',
    'anthropic/claude-opus-5-5',
    'global.anthropic.claude-opus-5-5',
  ])('resolves %s to the existing modern Claude profile', (model) => {
    expect(getModelMaxTokens(model)).toBe(1000000);
    expect(getModelMaxOutputTokens(model)).toBe(128000);
  });
});

describe.each(['gpt-6-sol', 'gpt-6-luna'])('%s token limits', (model) => {
  it('resolves exact, snapshot, and provider-prefixed IDs', () => {
    for (const name of [model, `${model}-2026-09-22`, `openai/${model}`]) {
      expect(getModelMaxTokens(name, EModelEndpoint.openAI)).toBe(1050000);
      expect(getModelMaxOutputTokens(name, EModelEndpoint.openAI)).toBe(128000);
    }
  });
});
