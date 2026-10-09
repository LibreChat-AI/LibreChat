/** Note: No hard-coded values should be used in this file. */
const { EModelEndpoint } = require('librechat-data-provider');
const {
  maxTokensMap,
  matchModelName,
  processModelData,
  getModelMaxTokens,
  maxOutputTokensMap,
  findMatchingPattern,
} = require('@librechat/api');

describe('getModelMaxTokens', () => {
  test('should return correct tokens for exact match', () => {
    expect(getModelMaxTokens('gpt-4-32k-0613')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-4-32k-0613'],
    );
  });

  test('should return correct tokens for partial match', () => {
    expect(getModelMaxTokens('gpt-4-32k-unknown')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-4-32k'],
    );
  });

  test('should return correct tokens for partial match (OpenRouter)', () => {
    expect(getModelMaxTokens('openai/gpt-4-32k')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-4-32k'],
    );
  });

  test('should return undefined for no match', () => {
    expect(getModelMaxTokens('unknown-model')).toBeUndefined();
  });

  test('should return correct tokens for another exact match', () => {
    expect(getModelMaxTokens('gpt-3.5-turbo-16k-0613')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-3.5-turbo-16k-0613'],
    );
  });

  test('should return correct tokens for another partial match', () => {
    expect(getModelMaxTokens('gpt-3.5-turbo-unknown')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-3.5-turbo'],
    );
  });

  test('should return undefined for undefined input', () => {
    expect(getModelMaxTokens(undefined)).toBeUndefined();
  });

  test('should return undefined for null input', () => {
    expect(getModelMaxTokens(null)).toBeUndefined();
  });

  test('should return undefined for number input', () => {
    expect(getModelMaxTokens(123)).toBeUndefined();
  });

  // 11/06 Update
  test('should return correct tokens for gpt-3.5-turbo-1106 exact match', () => {
    expect(getModelMaxTokens('gpt-3.5-turbo-1106')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-3.5-turbo-1106'],
    );
  });

  test('should return correct tokens for gpt-4-1106 exact match', () => {
    expect(getModelMaxTokens('gpt-4-1106')).toBe(maxTokensMap[EModelEndpoint.openAI]['gpt-4-1106']);
  });

  test('should return correct tokens for gpt-4-vision exact match', () => {
    expect(getModelMaxTokens('gpt-4-vision')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-4-vision'],
    );
  });

  test('should return correct tokens for gpt-3.5-turbo-1106 partial match', () => {
    expect(getModelMaxTokens('something-/gpt-3.5-turbo-1106')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-3.5-turbo-1106'],
    );
    expect(getModelMaxTokens('gpt-3.5-turbo-1106/something-/')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-3.5-turbo-1106'],
    );
  });

  test('should return correct tokens for gpt-4-1106 partial match', () => {
    expect(getModelMaxTokens('gpt-4-1106/something')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-4-1106'],
    );
    expect(getModelMaxTokens('gpt-4-1106-preview')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-4-1106'],
    );
    expect(getModelMaxTokens('gpt-4-1106-vision-preview')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-4-1106'],
    );
  });

  // 01/25 Update
  test('should return correct tokens for gpt-4-turbo/0125 matches', () => {
    expect(getModelMaxTokens('gpt-4-turbo')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-4-turbo'],
    );
    expect(getModelMaxTokens('gpt-4-turbo-preview')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-4-turbo'],
    );
    expect(getModelMaxTokens('gpt-4-0125')).toBe(maxTokensMap[EModelEndpoint.openAI]['gpt-4-0125']);
    expect(getModelMaxTokens('gpt-4-0125-preview')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-4-0125'],
    );
    expect(getModelMaxTokens('gpt-3.5-turbo-0125')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-3.5-turbo-0125'],
    );
  });

  test('should return correct tokens for gpt-4.5 matches', () => {
    expect(getModelMaxTokens('gpt-4.5')).toBe(maxTokensMap[EModelEndpoint.openAI]['gpt-4.5']);
    expect(getModelMaxTokens('gpt-4.5-preview')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-4.5'],
    );
    expect(getModelMaxTokens('openai/gpt-4.5-preview')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-4.5'],
    );
  });

  test('should return correct tokens for gpt-4.1 matches', () => {
    expect(getModelMaxTokens('gpt-4.1')).toBe(maxTokensMap[EModelEndpoint.openAI]['gpt-4.1']);
    expect(getModelMaxTokens('gpt-4.1-preview')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-4.1'],
    );
    expect(getModelMaxTokens('openai/gpt-4.1')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-4.1'],
    );
    expect(getModelMaxTokens('gpt-4.1-2024-08-06')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-4.1'],
    );
  });

  test('should return correct tokens for gpt-4.1-mini matches', () => {
    expect(getModelMaxTokens('gpt-4.1-mini')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-4.1-mini'],
    );
    expect(getModelMaxTokens('gpt-4.1-mini-preview')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-4.1-mini'],
    );
    expect(getModelMaxTokens('openai/gpt-4.1-mini')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-4.1-mini'],
    );
  });

  test('should return correct tokens for gpt-4.1-nano matches', () => {
    expect(getModelMaxTokens('gpt-4.1-nano')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-4.1-nano'],
    );
    expect(getModelMaxTokens('gpt-4.1-nano-preview')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-4.1-nano'],
    );
    expect(getModelMaxTokens('openai/gpt-4.1-nano')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-4.1-nano'],
    );
  });

  test('should return correct tokens for gpt-5 matches', () => {
    expect(getModelMaxTokens('gpt-5')).toBe(maxTokensMap[EModelEndpoint.openAI]['gpt-5']);
    expect(getModelMaxTokens('gpt-5-preview')).toBe(maxTokensMap[EModelEndpoint.openAI]['gpt-5']);
    expect(getModelMaxTokens('openai/gpt-5')).toBe(maxTokensMap[EModelEndpoint.openAI]['gpt-5']);
    expect(getModelMaxTokens('gpt-5-2025-01-30')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5'],
    );
  });

  test('should return correct tokens for gpt-5-mini matches', () => {
    expect(getModelMaxTokens('gpt-5-mini')).toBe(maxTokensMap[EModelEndpoint.openAI]['gpt-5-mini']);
    expect(getModelMaxTokens('gpt-5-mini-preview')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5-mini'],
    );
    expect(getModelMaxTokens('openai/gpt-5-mini')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5-mini'],
    );
  });

  test('should return correct tokens for gpt-5-nano matches', () => {
    expect(getModelMaxTokens('gpt-5-nano')).toBe(maxTokensMap[EModelEndpoint.openAI]['gpt-5-nano']);
    expect(getModelMaxTokens('gpt-5-nano-preview')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5-nano'],
    );
    expect(getModelMaxTokens('openai/gpt-5-nano')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5-nano'],
    );
  });

  test('should return correct tokens for gpt-5-pro matches', () => {
    expect(getModelMaxTokens('gpt-5-pro')).toBe(maxTokensMap[EModelEndpoint.openAI]['gpt-5-pro']);
    expect(getModelMaxTokens('gpt-5-pro-preview')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5-pro'],
    );
    expect(getModelMaxTokens('openai/gpt-5-pro')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5-pro'],
    );
    expect(getModelMaxTokens('gpt-5-pro-2025-01-30')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5-pro'],
    );
  });

  test('should return correct tokens for gpt-5.3 matches', () => {
    expect(getModelMaxTokens('gpt-5.3')).toBe(maxTokensMap[EModelEndpoint.openAI]['gpt-5.3']);
    expect(getModelMaxTokens('gpt-5.3-codex')).toBe(maxTokensMap[EModelEndpoint.openAI]['gpt-5.3']);
    expect(getModelMaxTokens('openai/gpt-5.3')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5.3'],
    );
    expect(getModelMaxTokens('gpt-5.3-2025-03-01')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5.3'],
    );
    expect(getModelMaxTokens('gpt-5.3-preview')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5.3'],
    );
  });

  test('should return correct tokens for gpt-5.4 matches', () => {
    expect(getModelMaxTokens('gpt-5.4')).toBe(maxTokensMap[EModelEndpoint.openAI]['gpt-5.4']);
    expect(getModelMaxTokens('gpt-5.4-thinking')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5.4'],
    );
    expect(getModelMaxTokens('openai/gpt-5.4')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5.4'],
    );
  });

  test('should return correct tokens for gpt-5.4-pro matches', () => {
    expect(getModelMaxTokens('gpt-5.4-pro')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5.4-pro'],
    );
    expect(getModelMaxTokens('openai/gpt-5.4-pro')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5.4-pro'],
    );
  });

  test('should return correct tokens for gpt-5.5 matches', () => {
    expect(maxTokensMap[EModelEndpoint.openAI]['gpt-5.5']).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5.5-pro'],
    );
    expect(getModelMaxTokens('gpt-5.5')).toBe(maxTokensMap[EModelEndpoint.openAI]['gpt-5.5']);
    expect(getModelMaxTokens('gpt-5.5-thinking')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5.5'],
    );
    expect(getModelMaxTokens('openai/gpt-5.5')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5.5'],
    );
    expect(getModelMaxTokens('gpt-5.5-2026-04-23')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5.5'],
    );
  });

  test('should return correct tokens for gpt-5.5-pro matches', () => {
    expect(getModelMaxTokens('gpt-5.5-pro')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5.5-pro'],
    );
    expect(getModelMaxTokens('openai/gpt-5.5-pro')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5.5-pro'],
    );
  });

  test('should return correct tokens for gpt-5.6 matches', () => {
    expect(getModelMaxTokens('gpt-5.6')).toBe(maxTokensMap[EModelEndpoint.openAI]['gpt-5.6']);
    expect(getModelMaxTokens('gpt-5.6-sol')).toBe(maxTokensMap[EModelEndpoint.openAI]['gpt-5.6']);
    expect(getModelMaxTokens('openai/gpt-5.6')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5.6'],
    );
    expect(getModelMaxTokens('gpt-5.6-terra')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5.6-terra'],
    );
    expect(getModelMaxTokens('gpt-5.6-luna-2026-07-09')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5.6-luna'],
    );
  });

  test('should return correct tokens for Anthropic models', () => {
    const models = [
      'claude-2.1',
      'claude-2',
      'claude-1.2',
      'claude-1',
      'claude-1-100k',
      'claude-instant-1',
      'claude-instant-1-100k',
      'claude-3-haiku',
      'claude-3-sonnet',
      'claude-3-opus',
      'claude-3-5-sonnet',
      'claude-3-7-sonnet',
    ];

    const maxTokens = {
      'claude-': maxTokensMap[EModelEndpoint.anthropic]['claude-'],
      'claude-2.1': maxTokensMap[EModelEndpoint.anthropic]['claude-2.1'],
      'claude-3': maxTokensMap[EModelEndpoint.anthropic]['claude-3-sonnet'],
    };

    models.forEach((model) => {
      let expectedTokens;

      if (model === 'claude-2.1') {
        expectedTokens = maxTokens['claude-2.1'];
      } else if (model.startsWith('claude-3')) {
        expectedTokens = maxTokens['claude-3'];
      } else {
        expectedTokens = maxTokens['claude-'];
      }

      expect(getModelMaxTokens(model, EModelEndpoint.anthropic)).toEqual(expectedTokens);
    });
  });

  test('should return undefined for no match - Google models', () => {
    expect(getModelMaxTokens('unknown-google-model', EModelEndpoint.google)).toBeUndefined();
  });

  test('should return correct tokens for partial match - Google models', () => {
    expect(getModelMaxTokens('gemini-2.0-flash-lite-preview-02-05', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemini-2.0-flash-lite'],
    );
    expect(getModelMaxTokens('gemini-2.0-flash-001', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemini-2.0-flash'],
    );
    expect(getModelMaxTokens('gemini-2.0-flash-exp', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemini-2.0-flash'],
    );
    expect(getModelMaxTokens('gemini-2.0-pro-exp-02-05', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemini-2.0'],
    );
    expect(getModelMaxTokens('gemini-1.5-flash-8b', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemini-1.5-flash-8b'],
    );
    expect(getModelMaxTokens('gemini-1.5-flash-thinking', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemini-1.5-flash'],
    );
    expect(getModelMaxTokens('gemini-1.5-pro-latest', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemini-1.5'],
    );
    expect(getModelMaxTokens('gemini-1.5-pro-preview-0409', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemini-1.5'],
    );
    expect(getModelMaxTokens('gemini-3', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemini-3'],
    );
    expect(getModelMaxTokens('gemini-3.1-pro-preview', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemini-3.1'],
    );
    expect(getModelMaxTokens('gemini-3.1-pro-preview-customtools', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemini-3.1'],
    );
    expect(getModelMaxTokens('gemini-3.5-flash', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemini-3.5-flash'],
    );
    expect(getModelMaxTokens('gemini-3.5-flash-lite', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemini-3.5-flash-lite'],
    );
    expect(getModelMaxTokens('gemini-3.6-flash', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemini-3.6-flash'],
    );
    expect(getModelMaxTokens('gemini-3.7-flash', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemini-3.7-flash'],
    );
    expect(getModelMaxTokens('gemini-3.8-flash', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemini-3.8-flash'],
    );
    expect(getModelMaxTokens('gemini-2.5-pro', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemini-2.5-pro'],
    );
    expect(getModelMaxTokens('gemini-2.5-flash', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemini-2.5-flash'],
    );
    expect(getModelMaxTokens('gemini-2.5-flash-lite', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemini-2.5-flash-lite'],
    );
    expect(getModelMaxTokens('gemini-pro-vision', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemini-pro-vision'],
    );
    expect(getModelMaxTokens('gemini-1.0', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemini'],
    );
    expect(getModelMaxTokens('gemini-pro', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemini'],
    );
  });

  test('should return correct context tokens for Gemma models', () => {
    expect(maxTokensMap[EModelEndpoint.google].gemma).toBe(32768);
    expect(getModelMaxTokens('gemma', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google].gemma,
    );
    expect(getModelMaxTokens('gemma-2-9b-it', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemma-2'],
    );
    expect(getModelMaxTokens('gemma-3-27b-it', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemma-3-27b'],
    );
    expect(getModelMaxTokens('gemma4:latest', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google].gemma4,
    );
    expect(getModelMaxTokens('gemma4:e4b', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google].gemma4,
    );
    expect(getModelMaxTokens('Gemma4:31B', EModelEndpoint.custom)).toBe(
      maxTokensMap[EModelEndpoint.custom]['gemma4:31b'],
    );
    expect(getModelMaxTokens('ollama/gemma4:31b', EModelEndpoint.custom)).toBe(
      maxTokensMap[EModelEndpoint.custom]['gemma4:31b'],
    );
    expect(getModelMaxTokens('google/gemma-4-31B-it', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemma-4-31b'],
    );
    expect(getModelMaxTokens('google/gemma-4-26B-A4B-it', EModelEndpoint.google)).toBe(
      maxTokensMap[EModelEndpoint.google]['gemma-4-26b-a4b'],
    );
  });

  test('should return correct tokens for partial match - Cohere models', () => {
    expect(getModelMaxTokens('command', EModelEndpoint.custom)).toBe(
      maxTokensMap[EModelEndpoint.custom]['command'],
    );
    expect(getModelMaxTokens('command-r-plus', EModelEndpoint.custom)).toBe(
      maxTokensMap[EModelEndpoint.custom]['command-r-plus'],
    );
  });

  test('should return correct tokens when using a custom endpointTokenConfig', () => {
    const customTokenConfig = {
      'custom-model': 12345,
    };
    expect(getModelMaxTokens('custom-model', EModelEndpoint.openAI, customTokenConfig)).toBe(12345);
  });

  test('should prioritize endpointTokenConfig over the default configuration', () => {
    const customTokenConfig = {
      'gpt-4-32k': 9999,
    };
    expect(getModelMaxTokens('gpt-4-32k', EModelEndpoint.openAI, customTokenConfig)).toBe(9999);
  });

  test('should return undefined if the model is not found in custom endpointTokenConfig', () => {
    const customTokenConfig = {
      'custom-model': 12345,
    };
    expect(
      getModelMaxTokens('nonexistent-model', EModelEndpoint.openAI, customTokenConfig),
    ).toBeUndefined();
  });

  test('should return correct tokens for exact match in azureOpenAI models', () => {
    expect(getModelMaxTokens('gpt-4-turbo', EModelEndpoint.azureOpenAI)).toBe(
      maxTokensMap[EModelEndpoint.azureOpenAI]['gpt-4-turbo'],
    );
  });

  test('should return undefined for no match in azureOpenAI models', () => {
    expect(
      getModelMaxTokens('nonexistent-azure-model', EModelEndpoint.azureOpenAI),
    ).toBeUndefined();
  });

  test('should return undefined for undefined, null, or number model argument with azureOpenAI endpoint', () => {
    expect(getModelMaxTokens(undefined, EModelEndpoint.azureOpenAI)).toBeUndefined();
    expect(getModelMaxTokens(null, EModelEndpoint.azureOpenAI)).toBeUndefined();
    expect(getModelMaxTokens(1234, EModelEndpoint.azureOpenAI)).toBeUndefined();
  });

  test('should respect custom endpointTokenConfig over azureOpenAI defaults', () => {
    const customTokenConfig = {
      'custom-azure-model': 4096,
    };
    expect(
      getModelMaxTokens('custom-azure-model', EModelEndpoint.azureOpenAI, customTokenConfig),
    ).toBe(4096);
  });

  test('should return correct tokens for partial match with custom endpointTokenConfig in azureOpenAI', () => {
    const customTokenConfig = {
      'azure-custom-': 1024,
    };
    expect(
      getModelMaxTokens('azure-custom-gpt-3', EModelEndpoint.azureOpenAI, customTokenConfig),
    ).toBe(1024);
  });

  test('should return undefined for a model when using an unsupported endpoint', () => {
    expect(getModelMaxTokens('azure-gpt-3', 'unsupportedEndpoint')).toBeUndefined();
  });

  test('should return correct max context tokens for o1-series models', () => {
    // Standard o1 variations
    const o1Tokens = maxTokensMap[EModelEndpoint.openAI]['o1'];
    expect(getModelMaxTokens('o1')).toBe(o1Tokens);
    expect(getModelMaxTokens('o1-latest')).toBe(o1Tokens);
    expect(getModelMaxTokens('o1-2024-12-17')).toBe(o1Tokens);
    expect(getModelMaxTokens('o1-something-else')).toBe(o1Tokens);
    expect(getModelMaxTokens('openai/o1-something-else')).toBe(o1Tokens);

    // Mini variations
    const o1MiniTokens = maxTokensMap[EModelEndpoint.openAI]['o1-mini'];
    expect(getModelMaxTokens('o1-mini')).toBe(o1MiniTokens);
    expect(getModelMaxTokens('o1-mini-latest')).toBe(o1MiniTokens);
    expect(getModelMaxTokens('o1-mini-2024-09-12')).toBe(o1MiniTokens);
    expect(getModelMaxTokens('o1-mini-something')).toBe(o1MiniTokens);
    expect(getModelMaxTokens('openai/o1-mini-something')).toBe(o1MiniTokens);

    // Preview variations
    const o1PreviewTokens = maxTokensMap[EModelEndpoint.openAI]['o1-preview'];
    expect(getModelMaxTokens('o1-preview')).toBe(o1PreviewTokens);
    expect(getModelMaxTokens('o1-preview-latest')).toBe(o1PreviewTokens);
    expect(getModelMaxTokens('o1-preview-2024-09-12')).toBe(o1PreviewTokens);
    expect(getModelMaxTokens('o1-preview-something')).toBe(o1PreviewTokens);
    expect(getModelMaxTokens('openai/o1-preview-something')).toBe(o1PreviewTokens);
  });

  test('should return correct max context tokens for o4-mini and o3', () => {
    const o4MiniTokens = maxTokensMap[EModelEndpoint.openAI]['o4-mini'];
    const o3Tokens = maxTokensMap[EModelEndpoint.openAI]['o3'];
    expect(getModelMaxTokens('o4-mini')).toBe(o4MiniTokens);
    expect(getModelMaxTokens('openai/o4-mini')).toBe(o4MiniTokens);
    expect(getModelMaxTokens('o3')).toBe(o3Tokens);
    expect(getModelMaxTokens('openai/o3')).toBe(o3Tokens);
  });

  test('should return correct tokens for GPT-OSS models', () => {
    const expected = maxTokensMap[EModelEndpoint.openAI]['gpt-oss'];
    [
      'gpt-oss:20b',
      'gpt-oss-20b',
      'gpt-oss-120b',
      'openai/gpt-oss-20b',
      'openai/gpt-oss-120b',
      'openai/gpt-oss:120b',
    ].forEach((name) => {
      expect(getModelMaxTokens(name)).toBe(expected);
    });
  });

  test('should return correct tokens for GLM models', () => {
    expect(getModelMaxTokens('glm-4.6')).toBe(maxTokensMap[EModelEndpoint.openAI]['glm-4.6']);
    expect(getModelMaxTokens('glm-4.5v')).toBe(maxTokensMap[EModelEndpoint.openAI]['glm-4.5v']);
    expect(getModelMaxTokens('glm-4.5-air')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['glm-4.5-air'],
    );
    expect(getModelMaxTokens('glm-4.5')).toBe(maxTokensMap[EModelEndpoint.openAI]['glm-4.5']);
    expect(getModelMaxTokens('glm-4-32b')).toBe(maxTokensMap[EModelEndpoint.openAI]['glm-4-32b']);
    expect(getModelMaxTokens('glm-4')).toBe(maxTokensMap[EModelEndpoint.openAI]['glm-4']);
    expect(getModelMaxTokens('glm4')).toBe(maxTokensMap[EModelEndpoint.openAI]['glm4']);
  });

  test('should return correct tokens for GLM models with provider prefixes', () => {
    expect(getModelMaxTokens('z-ai/glm-4.6')).toBe(maxTokensMap[EModelEndpoint.openAI]['glm-4.6']);
    expect(getModelMaxTokens('z-ai/glm-4.5')).toBe(maxTokensMap[EModelEndpoint.openAI]['glm-4.5']);
    expect(getModelMaxTokens('z-ai/glm-4.5-air')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['glm-4.5-air'],
    );
    expect(getModelMaxTokens('z-ai/glm-4.5v')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['glm-4.5v'],
    );
    expect(getModelMaxTokens('z-ai/glm-4-32b')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['glm-4-32b'],
    );

    expect(getModelMaxTokens('zai/glm-4.6')).toBe(maxTokensMap[EModelEndpoint.openAI]['glm-4.6']);
    expect(getModelMaxTokens('zai/glm-4.5-air')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['glm-4.5-air'],
    );
    expect(getModelMaxTokens('zai/glm-4.5v')).toBe(maxTokensMap[EModelEndpoint.openAI]['glm-4.5v']);

    expect(getModelMaxTokens('zai-org/GLM-4.6')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['glm-4.6'],
    );
    expect(getModelMaxTokens('zai-org/GLM-4.5')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['glm-4.5'],
    );
    expect(getModelMaxTokens('zai-org/GLM-4.5-Air')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['glm-4.5-air'],
    );
    expect(getModelMaxTokens('zai-org/GLM-4.5V')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['glm-4.5v'],
    );
    expect(getModelMaxTokens('zai-org/GLM-4-32B-0414')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['glm-4-32b'],
    );
  });

  test('should return correct tokens for GLM models with suffixes', () => {
    expect(getModelMaxTokens('glm-4.6-fp8')).toBe(maxTokensMap[EModelEndpoint.openAI]['glm-4.6']);
    expect(getModelMaxTokens('zai-org/GLM-4.6-FP8')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['glm-4.6'],
    );
    expect(getModelMaxTokens('zai-org/GLM-4.5-Air-FP8')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['glm-4.5-air'],
    );
  });

  test('should return correct max output tokens for GPT-5 models', () => {
    const { getModelMaxOutputTokens } = require('@librechat/api');
    const gpt5Models = [
      'gpt-5',
      'gpt-5.1',
      'gpt-5.2',
      'gpt-5.3',
      'gpt-5.4',
      'gpt-5.4-pro',
      'gpt-5.5',
      'gpt-5.5-pro',
      'gpt-5.6',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5-mini',
      'gpt-5-nano',
      'gpt-5-pro',
      'gpt-5.2-pro',
    ];
    for (const model of gpt5Models) {
      expect(getModelMaxOutputTokens(model)).toBe(maxOutputTokensMap[EModelEndpoint.openAI][model]);
      expect(getModelMaxOutputTokens(model, EModelEndpoint.openAI)).toBe(
        maxOutputTokensMap[EModelEndpoint.openAI][model],
      );
      expect(getModelMaxOutputTokens(model, EModelEndpoint.azureOpenAI)).toBe(
        maxOutputTokensMap[EModelEndpoint.azureOpenAI][model],
      );
    }
  });

  test('should return correct max output tokens for GPT-OSS models', () => {
    const { getModelMaxOutputTokens } = require('@librechat/api');
    ['gpt-oss-20b', 'gpt-oss-120b'].forEach((model) => {
      expect(getModelMaxOutputTokens(model)).toBe(maxOutputTokensMap[EModelEndpoint.openAI][model]);
      expect(getModelMaxOutputTokens(model, EModelEndpoint.openAI)).toBe(
        maxOutputTokensMap[EModelEndpoint.openAI][model],
      );
      expect(getModelMaxOutputTokens(model, EModelEndpoint.azureOpenAI)).toBe(
        maxOutputTokensMap[EModelEndpoint.azureOpenAI][model],
      );
    });
  });
});

describe('findMatchingPattern - longest match wins', () => {
  test('should prefer longer matching key over shorter cross-provider pattern', () => {
    const result = findMatchingPattern(
      'gpt-5.2-chat-2025-12-11',
      maxTokensMap[EModelEndpoint.openAI],
    );
    expect(result).toBe('gpt-5.2');
  });

  test('should match gpt-5.2 tokens for date-suffixed chat variant', () => {
    expect(getModelMaxTokens('gpt-5.2-chat-2025-12-11')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5.2'],
    );
  });

  test('should match gpt-5.2-pro over shorter patterns', () => {
    expect(getModelMaxTokens('gpt-5.2-pro-chat-2025-12-11')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5.2-pro'],
    );
  });

  test('should match gpt-5.5-pro over shorter patterns', () => {
    expect(getModelMaxTokens('gpt-5.5-pro-2026-04-23')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5.5-pro'],
    );
  });

  test('should match gpt-5-mini over gpt-5 for mini variants', () => {
    expect(getModelMaxTokens('gpt-5-mini-chat-2025-01-01')).toBe(
      maxTokensMap[EModelEndpoint.openAI]['gpt-5-mini'],
    );
  });

  test('should prefer gpt-4-1106 over gpt-4 for versioned model names', () => {
    const result = findMatchingPattern('gpt-4-1106-preview', maxTokensMap[EModelEndpoint.openAI]);
    expect(result).toBe('gpt-4-1106');
  });

  test('should prefer gpt-4-32k-0613 over gpt-4-32k for exact versioned names', () => {
    const result = findMatchingPattern('gpt-4-32k-0613', maxTokensMap[EModelEndpoint.openAI]);
    expect(result).toBe('gpt-4-32k-0613');
  });

  test('should prefer claude-3-5-sonnet over claude-3', () => {
    const result = findMatchingPattern(
      'claude-3-5-sonnet-20241022',
      maxTokensMap[EModelEndpoint.anthropic],
    );
    expect(result).toBe('claude-3-5-sonnet');
  });

  test('should prefer gemini-2.0-flash-lite over gemini-2.0-flash', () => {
    const result = findMatchingPattern(
      'gemini-2.0-flash-lite-preview',
      maxTokensMap[EModelEndpoint.google],
    );
    expect(result).toBe('gemini-2.0-flash-lite');
  });
});

describe('findMatchingPattern - bestLength selection', () => {
  test('should return the longest matching key when multiple keys match', () => {
    const tokensMap = { short: 100, 'short-med': 200, 'short-med-long': 300 };
    expect(findMatchingPattern('short-med-long-extra', tokensMap)).toBe('short-med-long');
  });

  test('should return the longest match regardless of key insertion order', () => {
    const tokensMap = { 'a-b-c': 300, a: 100, 'a-b': 200 };
    expect(findMatchingPattern('a-b-c-d', tokensMap)).toBe('a-b-c');
  });

  test('should return null when no key matches', () => {
    const tokensMap = { alpha: 100, beta: 200 };
    expect(findMatchingPattern('gamma-delta', tokensMap)).toBeNull();
  });

  test('should return the single matching key when only one matches', () => {
    const tokensMap = { alpha: 100, beta: 200, gamma: 300 };
    expect(findMatchingPattern('beta-extended', tokensMap)).toBe('beta');
  });

  test('should match case-insensitively against model name', () => {
    const tokensMap = { 'gpt-5': 400000 };
    expect(findMatchingPattern('GPT-5-turbo', tokensMap)).toBe('gpt-5');
  });

  test('should select the longest key among overlapping substring matches', () => {
    const tokensMap = { 'gpt-': 100, 'gpt-5': 200, 'gpt-5.2': 300, 'gpt-5.2-pro': 400 };
    expect(findMatchingPattern('gpt-5.2-pro-2025-01-01', tokensMap)).toBe('gpt-5.2-pro');
    expect(findMatchingPattern('gpt-5.2-chat-2025-01-01', tokensMap)).toBe('gpt-5.2');
    expect(findMatchingPattern('gpt-5.1-preview', tokensMap)).toBe('gpt-5');
    expect(findMatchingPattern('gpt-unknown', tokensMap)).toBe('gpt-');
  });

  test('should not be confused by a short key that appears later in the model name', () => {
    const tokensMap = { 'model-v2': 200, v2: 100 };
    expect(findMatchingPattern('model-v2-extended', tokensMap)).toBe('model-v2');
  });

  test('should handle exact-length match as the best match', () => {
    const tokensMap = { 'exact-model': 500, exact: 100 };
    expect(findMatchingPattern('exact-model', tokensMap)).toBe('exact-model');
  });

  test('should return null for empty model name', () => {
    expect(findMatchingPattern('', { 'gpt-5': 400000 })).toBeNull();
  });

  test('should prefer last-defined key on same-length ties', () => {
    const tokensMap = { 'aa-bb': 100, 'cc-dd': 200 };
    // model name contains both 5-char keys; last-defined wins in reverse iteration
    expect(findMatchingPattern('aa-bb-cc-dd', tokensMap)).toBe('cc-dd');
  });

  test('longest match beats short cross-provider pattern even when both present', () => {
    const tokensMap = { 'gpt-5.2': 400000, 'chat-': 8187 };
    expect(findMatchingPattern('gpt-5.2-chat-2025-12-11', tokensMap)).toBe('gpt-5.2');
  });

  test('should match case-insensitively against keys', () => {
    const tokensMap = { 'GPT-5': 400000 };
    expect(findMatchingPattern('gpt-5-turbo', tokensMap)).toBe('GPT-5');
  });
});

describe('findMatchingPattern - iteration performance', () => {
  let includesSpy;

  beforeEach(() => {
    includesSpy = jest.spyOn(String.prototype, 'includes');
  });

  afterEach(() => {
    includesSpy.mockRestore();
  });

  test('exact match early-exits with minimal includes() checks', () => {
    const openAIMap = maxTokensMap[EModelEndpoint.openAI];
    const keys = Object.keys(openAIMap);
    const lastKey = keys[keys.length - 1];
    includesSpy.mockClear();
    const result = findMatchingPattern(lastKey, openAIMap);
    const exactCalls = includesSpy.mock.calls.length;

    expect(result).toBe(lastKey);
    expect(exactCalls).toBe(1);
  });

  test('bestLength check skips includes() for shorter keys after a long match', () => {
    const openAIMap = maxTokensMap[EModelEndpoint.openAI];
    includesSpy.mockClear();
    findMatchingPattern('gpt-3.5-turbo-0301-test', openAIMap);
    const longKeyCalls = includesSpy.mock.calls.length;

    includesSpy.mockClear();
    findMatchingPattern('gpt-5.3-chat-latest', openAIMap);
    const shortKeyCalls = includesSpy.mock.calls.length;

    // gpt-3.5-turbo-0301 (20 chars) matches early, then bestLength prunes most keys
    // gpt-5.3 (7 chars) is short, so fewer keys are pruned by the length check
    expect(longKeyCalls).toBeLessThan(shortKeyCalls);
  });

  test('last-defined keys are checked first in reverse iteration', () => {
    const tokensMap = { first: 100, second: 200, third: 300 };
    includesSpy.mockClear();
    const result = findMatchingPattern('third', tokensMap);
    const calls = includesSpy.mock.calls.length;

    // 'third' is last key, found on first reverse check, exact match exits immediately
    expect(result).toBe('third');
    expect(calls).toBe(1);
  });
});

describe('deprecated PaLM2/Codey model removal', () => {
  test('deprecated PaLM2/Codey models no longer have token entries', () => {
    expect(getModelMaxTokens('text-bison-32k', EModelEndpoint.google)).toBeUndefined();
    expect(getModelMaxTokens('codechat-bison-32k', EModelEndpoint.google)).toBeUndefined();
    expect(getModelMaxTokens('code-bison', EModelEndpoint.google)).toBeUndefined();
    expect(getModelMaxTokens('chat-bison', EModelEndpoint.google)).toBeUndefined();
  });
});

describe('matchModelName', () => {
  it('should return the exact model name if it exists in maxTokensMap', () => {
    expect(matchModelName('gpt-4-32k-0613')).toBe('gpt-4-32k-0613');
  });

  it('should return the closest matching key for partial matches', () => {
    expect(matchModelName('gpt-4-32k-unknown')).toBe('gpt-4-32k');
  });

  it('should return the input model name if no match is found', () => {
    expect(matchModelName('unknown-model')).toBe('unknown-model');
  });

  it('should return undefined for non-string inputs', () => {
    expect(matchModelName(undefined)).toBeUndefined();
    expect(matchModelName(null)).toBeUndefined();
    expect(matchModelName(123)).toBeUndefined();
    expect(matchModelName({})).toBeUndefined();
  });

  // 11/06 Update
  it('should return the exact model name for gpt-3.5-turbo-1106 if it exists in maxTokensMap', () => {
    expect(matchModelName('gpt-3.5-turbo-1106')).toBe('gpt-3.5-turbo-1106');
  });

  it('should return the exact model name for gpt-4-1106 if it exists in maxTokensMap', () => {
    expect(matchModelName('gpt-4-1106')).toBe('gpt-4-1106');
  });

  it('should return the closest matching key for gpt-3.5-turbo-1106 partial matches', () => {
    expect(matchModelName('gpt-3.5-turbo-1106/something')).toBe('gpt-3.5-turbo-1106');
    expect(matchModelName('something/gpt-3.5-turbo-1106')).toBe('gpt-3.5-turbo-1106');
  });

  it('should return the closest matching key for gpt-4-1106 partial matches', () => {
    expect(matchModelName('gpt-4-1106/something')).toBe('gpt-4-1106');
    expect(matchModelName('gpt-4-1106-preview')).toBe('gpt-4-1106');
    expect(matchModelName('gpt-4-1106-vision-preview')).toBe('gpt-4-1106');
  });

  // 01/25 Update
  it('should return the closest matching key for gpt-4-turbo/0125 matches', () => {
    expect(matchModelName('openai/gpt-4-0125')).toBe('gpt-4-0125');
    expect(matchModelName('gpt-4-turbo-preview')).toBe('gpt-4-turbo');
    expect(matchModelName('gpt-4-turbo-vision-preview')).toBe('gpt-4-turbo');
    expect(matchModelName('gpt-4-0125')).toBe('gpt-4-0125');
    expect(matchModelName('gpt-4-0125-preview')).toBe('gpt-4-0125');
    expect(matchModelName('gpt-4-0125-vision-preview')).toBe('gpt-4-0125');
  });

  it('should return the closest matching key for gpt-4.1 matches', () => {
    expect(matchModelName('openai/gpt-4.1')).toBe('gpt-4.1');
    expect(matchModelName('gpt-4.1-preview')).toBe('gpt-4.1');
    expect(matchModelName('gpt-4.1-2024-08-06')).toBe('gpt-4.1');
    expect(matchModelName('gpt-4.1-2024-08-06-0718')).toBe('gpt-4.1');
  });

  it('should return the closest matching key for gpt-4.1-mini matches', () => {
    expect(matchModelName('openai/gpt-4.1-mini')).toBe('gpt-4.1-mini');
    expect(matchModelName('gpt-4.1-mini-preview')).toBe('gpt-4.1-mini');
    expect(matchModelName('gpt-4.1-mini-2024-08-06')).toBe('gpt-4.1-mini');
  });

  it('should return the closest matching key for gpt-4.1-nano matches', () => {
    expect(matchModelName('openai/gpt-4.1-nano')).toBe('gpt-4.1-nano');
    expect(matchModelName('gpt-4.1-nano-preview')).toBe('gpt-4.1-nano');
    expect(matchModelName('gpt-4.1-nano-2024-08-06')).toBe('gpt-4.1-nano');
  });

  it('should return the closest matching key for gpt-5 matches', () => {
    expect(matchModelName('openai/gpt-5')).toBe('gpt-5');
    expect(matchModelName('gpt-5-preview')).toBe('gpt-5');
    expect(matchModelName('gpt-5-2025-01-30')).toBe('gpt-5');
    expect(matchModelName('gpt-5-2025-01-30-0130')).toBe('gpt-5');
  });

  it('should return the closest matching key for gpt-5-mini matches', () => {
    expect(matchModelName('openai/gpt-5-mini')).toBe('gpt-5-mini');
    expect(matchModelName('gpt-5-mini-preview')).toBe('gpt-5-mini');
    expect(matchModelName('gpt-5-mini-2025-01-30')).toBe('gpt-5-mini');
  });

  it('should return the closest matching key for gpt-5-nano matches', () => {
    expect(matchModelName('openai/gpt-5-nano')).toBe('gpt-5-nano');
    expect(matchModelName('gpt-5-nano-preview')).toBe('gpt-5-nano');
    expect(matchModelName('gpt-5-nano-2025-01-30')).toBe('gpt-5-nano');
  });

  it('should return the closest matching key for gpt-5-pro matches', () => {
    expect(matchModelName('openai/gpt-5-pro')).toBe('gpt-5-pro');
    expect(matchModelName('gpt-5-pro-preview')).toBe('gpt-5-pro');
    expect(matchModelName('gpt-5-pro-2025-01-30')).toBe('gpt-5-pro');
    expect(matchModelName('gpt-5-pro-2025-01-30-0130')).toBe('gpt-5-pro');
  });

  it('should return the closest matching key for gpt-5.3 matches', () => {
    expect(matchModelName('openai/gpt-5.3')).toBe('gpt-5.3');
    expect(matchModelName('gpt-5.3-codex')).toBe('gpt-5.3');
    expect(matchModelName('gpt-5.3-2025-03-01')).toBe('gpt-5.3');
  });

  it('should return the closest matching key for gpt-5.4 matches', () => {
    expect(matchModelName('openai/gpt-5.4')).toBe('gpt-5.4');
    expect(matchModelName('gpt-5.4-thinking')).toBe('gpt-5.4');
    expect(matchModelName('gpt-5.4-pro')).toBe('gpt-5.4-pro');
  });

  it('should return the closest matching key for gpt-5.5 matches', () => {
    expect(matchModelName('openai/gpt-5.5')).toBe('gpt-5.5');
    expect(matchModelName('gpt-5.5-thinking')).toBe('gpt-5.5');
    expect(matchModelName('gpt-5.5-pro')).toBe('gpt-5.5-pro');
  });

  it('should return the input model name if no match is found - Google models', () => {
    expect(matchModelName('unknown-google-model', EModelEndpoint.google)).toBe(
      'unknown-google-model',
    );
  });
});

describe('Meta Models Tests', () => {
  describe('getModelMaxTokens', () => {
    test('should return correct tokens for LLaMa 2 models', () => {
      const llama2Tokens = maxTokensMap[EModelEndpoint.openAI]['llama2'];
      expect(getModelMaxTokens('llama2')).toBe(llama2Tokens);
      expect(getModelMaxTokens('llama2.70b')).toBe(llama2Tokens);
      expect(getModelMaxTokens('llama2-13b')).toBe(llama2Tokens);
      expect(getModelMaxTokens('llama2-70b')).toBe(llama2Tokens);
    });

    test('should return correct tokens for LLaMa 3 models', () => {
      const llama3Tokens = maxTokensMap[EModelEndpoint.openAI]['llama3'];
      expect(getModelMaxTokens('llama3')).toBe(llama3Tokens);
      expect(getModelMaxTokens('llama3.8b')).toBe(llama3Tokens);
      expect(getModelMaxTokens('llama3.70b')).toBe(llama3Tokens);
      expect(getModelMaxTokens('llama3-8b')).toBe(llama3Tokens);
      expect(getModelMaxTokens('llama3-70b')).toBe(llama3Tokens);
    });

    test('should return correct tokens for LLaMa 3.1 models', () => {
      const llama31Tokens = maxTokensMap[EModelEndpoint.openAI]['llama3.1:8b'];
      expect(getModelMaxTokens('llama3.1:8b')).toBe(llama31Tokens);
      expect(getModelMaxTokens('llama3.1:70b')).toBe(llama31Tokens);
      expect(getModelMaxTokens('llama3.1:405b')).toBe(llama31Tokens);
      expect(getModelMaxTokens('llama3-1-8b')).toBe(llama31Tokens);
      expect(getModelMaxTokens('llama3-1-70b')).toBe(llama31Tokens);
      expect(getModelMaxTokens('llama3-1-405b')).toBe(llama31Tokens);
    });

    test('should handle partial matches for Meta models', () => {
      const llama31Tokens = maxTokensMap[EModelEndpoint.openAI]['llama3.1:8b'];
      const llama3Tokens = maxTokensMap[EModelEndpoint.openAI]['llama3'];
      const llama2Tokens = maxTokensMap[EModelEndpoint.openAI]['llama2'];
      expect(getModelMaxTokens('meta/llama3.1:405b')).toBe(llama31Tokens);
      expect(getModelMaxTokens('meta/llama3.1:70b')).toBe(llama31Tokens);
      expect(getModelMaxTokens('meta/llama3.1:8b')).toBe(llama31Tokens);
      expect(getModelMaxTokens('meta/llama3-1-8b')).toBe(llama31Tokens);

      expect(getModelMaxTokens('meta/llama3.1')).toBe(llama31Tokens);
      expect(getModelMaxTokens('meta/llama3-1')).toBe(llama31Tokens);
      expect(getModelMaxTokens('meta/llama3')).toBe(llama3Tokens);
      expect(getModelMaxTokens('meta/llama2')).toBe(llama2Tokens);
    });

    test('should match Deepseek model variations', () => {
      expect(getModelMaxTokens('deepseek-chat')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['deepseek-chat'],
      );
      expect(getModelMaxTokens('deepseek-coder')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['deepseek'],
      );
      expect(getModelMaxTokens('deepseek-reasoner')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['deepseek-reasoner'],
      );
      expect(getModelMaxTokens('deepseek.r1')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['deepseek.r1'],
      );
    });

    test('should return correct context tokens for all DeepSeek models', () => {
      const deepseekChatTokens = maxTokensMap[EModelEndpoint.openAI]['deepseek-chat'];
      expect(getModelMaxTokens('deepseek-chat')).toBe(deepseekChatTokens);
      expect(getModelMaxTokens('deepseek-reasoner')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['deepseek-reasoner'],
      );
      expect(getModelMaxTokens('deepseek-r1')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['deepseek-r1'],
      );
      expect(getModelMaxTokens('deepseek-v3')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['deepseek'],
      );
      expect(getModelMaxTokens('deepseek.r1')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['deepseek.r1'],
      );
    });

    test('should handle DeepSeek models with provider prefixes', () => {
      expect(getModelMaxTokens('deepseek/deepseek-chat')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['deepseek-chat'],
      );
      expect(getModelMaxTokens('openrouter/deepseek-reasoner')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['deepseek-reasoner'],
      );
      expect(getModelMaxTokens('openai/deepseek-v3')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['deepseek'],
      );
    });
  });

  describe('matchModelName', () => {
    test('should match exact LLaMa model names', () => {
      expect(matchModelName('llama2')).toBe('llama2');
      expect(matchModelName('llama3')).toBe('llama3');
      expect(matchModelName('llama3.1:8b')).toBe('llama3.1:8b');
    });

    test('should match LLaMa model variations', () => {
      // Test full model names
      expect(matchModelName('meta/llama3.1:405b')).toBe('llama3.1:405b');
      expect(matchModelName('meta/llama3.1:70b')).toBe('llama3.1:70b');
      expect(matchModelName('meta/llama3.1:8b')).toBe('llama3.1:8b');
      expect(matchModelName('meta/llama3-1-8b')).toBe('llama3-1-8b');

      // Test base versions
      expect(matchModelName('meta/llama3.1')).toBe('llama3.1');
      expect(matchModelName('meta/llama3-1')).toBe('llama3-1');
    });

    test('should handle custom endpoint for Meta models', () => {
      expect(matchModelName('llama2', EModelEndpoint.bedrock)).toBe('llama2');
      expect(matchModelName('llama3', EModelEndpoint.bedrock)).toBe('llama3');
      expect(matchModelName('llama3.1:8b', EModelEndpoint.bedrock)).toBe('llama3.1:8b');
    });

    test('should match Deepseek model variations', () => {
      expect(matchModelName('deepseek-chat')).toBe('deepseek-chat');
      expect(matchModelName('deepseek-coder')).toBe('deepseek');
    });
  });

  describe('DeepSeek Max Output Tokens', () => {
    const { getModelMaxOutputTokens } = require('@librechat/api');

    test('should return correct max output tokens for deepseek-chat', () => {
      const expected = maxOutputTokensMap[EModelEndpoint.openAI]['deepseek-chat'];
      expect(getModelMaxOutputTokens('deepseek-chat')).toBe(expected);
      expect(getModelMaxOutputTokens('deepseek-chat', EModelEndpoint.openAI)).toBe(expected);
      expect(getModelMaxOutputTokens('deepseek-chat', EModelEndpoint.custom)).toBe(expected);
    });

    test('should return correct max output tokens for deepseek-reasoner', () => {
      const expected = maxOutputTokensMap[EModelEndpoint.openAI]['deepseek-reasoner'];
      expect(getModelMaxOutputTokens('deepseek-reasoner')).toBe(expected);
      expect(getModelMaxOutputTokens('deepseek-reasoner', EModelEndpoint.openAI)).toBe(expected);
      expect(getModelMaxOutputTokens('deepseek-reasoner', EModelEndpoint.custom)).toBe(expected);
    });

    test('should return correct max output tokens for deepseek-r1', () => {
      const expected = maxOutputTokensMap[EModelEndpoint.openAI]['deepseek-r1'];
      expect(getModelMaxOutputTokens('deepseek-r1')).toBe(expected);
      expect(getModelMaxOutputTokens('deepseek-r1', EModelEndpoint.openAI)).toBe(expected);
    });

    test('should return correct max output tokens for deepseek base pattern', () => {
      const expected = maxOutputTokensMap[EModelEndpoint.openAI]['deepseek'];
      expect(getModelMaxOutputTokens('deepseek')).toBe(expected);
      expect(getModelMaxOutputTokens('deepseek-v3')).toBe(expected);
    });

    test('should handle DeepSeek models with provider prefixes for max output tokens', () => {
      expect(getModelMaxOutputTokens('deepseek/deepseek-chat')).toBe(
        maxOutputTokensMap[EModelEndpoint.openAI]['deepseek-chat'],
      );
      expect(getModelMaxOutputTokens('openrouter/deepseek-reasoner')).toBe(
        maxOutputTokensMap[EModelEndpoint.openAI]['deepseek-reasoner'],
      );
    });
  });

  describe('processModelData with Meta models', () => {
    test('should process Meta model data correctly', () => {
      const input = {
        data: [
          {
            id: 'llama2',
            pricing: {
              prompt: '0.00001',
              completion: '0.00003',
            },
            context_length: 4000,
          },
          {
            id: 'llama3',
            pricing: {
              prompt: '0.00002',
              completion: '0.00004',
            },
            context_length: 8000,
          },
        ],
      };

      const result = processModelData(input);
      expect(result.llama2).toEqual({
        prompt: 10,
        completion: 30,
        context: 4000,
      });
      expect(result.llama3).toEqual({
        prompt: 20,
        completion: 40,
        context: 8000,
      });
    });
  });
});

describe('Grok Model Tests - Tokens', () => {
  describe('getModelMaxTokens', () => {
    test('should return correct tokens for Grok vision models', () => {
      const grok2VisionTokens = maxTokensMap[EModelEndpoint.openAI]['grok-2-vision'];
      expect(getModelMaxTokens('grok-2-vision-1212')).toBe(grok2VisionTokens);
      expect(getModelMaxTokens('grok-2-vision')).toBe(grok2VisionTokens);
      expect(getModelMaxTokens('grok-2-vision-latest')).toBe(grok2VisionTokens);
    });

    test('should return correct tokens for Grok beta models', () => {
      expect(getModelMaxTokens('grok-vision-beta')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['grok-vision-beta'],
      );
      expect(getModelMaxTokens('grok-beta')).toBe(maxTokensMap[EModelEndpoint.openAI]['grok-beta']);
    });

    test('should return correct tokens for Grok text models', () => {
      const grok2Tokens = maxTokensMap[EModelEndpoint.openAI]['grok-2'];
      expect(getModelMaxTokens('grok-2-1212')).toBe(grok2Tokens);
      expect(getModelMaxTokens('grok-2')).toBe(grok2Tokens);
      expect(getModelMaxTokens('grok-2-latest')).toBe(grok2Tokens);
    });

    test('should return correct tokens for Grok 3 series models', () => {
      expect(getModelMaxTokens('grok-3')).toBe(maxTokensMap[EModelEndpoint.openAI]['grok-3']);
      expect(getModelMaxTokens('grok-3-fast')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['grok-3-fast'],
      );
      expect(getModelMaxTokens('grok-3-mini')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['grok-3-mini'],
      );
      expect(getModelMaxTokens('grok-3-mini-fast')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['grok-3-mini-fast'],
      );
    });

    test('should return correct tokens for Grok 4 model', () => {
      expect(getModelMaxTokens('grok-4-0709')).toBe(maxTokensMap[EModelEndpoint.openAI]['grok-4']);
    });

    test('should return correct tokens for Grok 4 Fast and Grok 4.1 Fast models', () => {
      const grok4FastTokens = maxTokensMap[EModelEndpoint.openAI]['grok-4-fast'];
      const grok41FastTokens = maxTokensMap[EModelEndpoint.openAI]['grok-4-1-fast'];
      expect(getModelMaxTokens('grok-4-fast')).toBe(grok4FastTokens);
      expect(getModelMaxTokens('grok-4-1-fast-reasoning')).toBe(grok41FastTokens);
      expect(getModelMaxTokens('grok-4-1-fast-non-reasoning')).toBe(grok41FastTokens);
    });

    test('should return correct tokens for Grok Code Fast model', () => {
      expect(getModelMaxTokens('grok-code-fast-1')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['grok-code-fast'],
      );
    });

    test('should handle partial matches for Grok models with prefixes', () => {
      const grok2VisionTokens = maxTokensMap[EModelEndpoint.openAI]['grok-2-vision'];
      const grokVisionBetaTokens = maxTokensMap[EModelEndpoint.openAI]['grok-vision-beta'];
      const grokBetaTokens = maxTokensMap[EModelEndpoint.openAI]['grok-beta'];
      const grok2Tokens = maxTokensMap[EModelEndpoint.openAI]['grok-2'];
      const grok3Tokens = maxTokensMap[EModelEndpoint.openAI]['grok-3'];
      const grok4Tokens = maxTokensMap[EModelEndpoint.openAI]['grok-4'];
      const grok4FastTokens = maxTokensMap[EModelEndpoint.openAI]['grok-4-fast'];
      const grok41FastTokens = maxTokensMap[EModelEndpoint.openAI]['grok-4-1-fast'];
      const grokCodeFastTokens = maxTokensMap[EModelEndpoint.openAI]['grok-code-fast'];
      expect(getModelMaxTokens('xai/grok-2-vision-1212')).toBe(grok2VisionTokens);
      expect(getModelMaxTokens('xai/grok-2-vision')).toBe(grok2VisionTokens);
      expect(getModelMaxTokens('xai/grok-2-vision-latest')).toBe(grok2VisionTokens);
      expect(getModelMaxTokens('xai/grok-vision-beta')).toBe(grokVisionBetaTokens);
      expect(getModelMaxTokens('xai/grok-beta')).toBe(grokBetaTokens);
      expect(getModelMaxTokens('xai/grok-2-1212')).toBe(grok2Tokens);
      expect(getModelMaxTokens('xai/grok-2')).toBe(grok2Tokens);
      expect(getModelMaxTokens('xai/grok-2-latest')).toBe(grok2Tokens);
      expect(getModelMaxTokens('xai/grok-3')).toBe(grok3Tokens);
      expect(getModelMaxTokens('xai/grok-3-fast')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['grok-3-fast'],
      );
      expect(getModelMaxTokens('xai/grok-3-mini')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['grok-3-mini'],
      );
      expect(getModelMaxTokens('xai/grok-3-mini-fast')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['grok-3-mini-fast'],
      );
      expect(getModelMaxTokens('xai/grok-4-0709')).toBe(grok4Tokens);
      expect(getModelMaxTokens('xai/grok-4-fast')).toBe(grok4FastTokens);
      expect(getModelMaxTokens('xai/grok-4-1-fast-reasoning')).toBe(grok41FastTokens);
      expect(getModelMaxTokens('xai/grok-4-1-fast-non-reasoning')).toBe(grok41FastTokens);
      expect(getModelMaxTokens('xai/grok-code-fast-1')).toBe(grokCodeFastTokens);
    });
  });

  describe('matchModelName', () => {
    test('should match exact Grok model names', () => {
      // Vision models
      expect(matchModelName('grok-2-vision-1212')).toBe('grok-2-vision-1212');
      expect(matchModelName('grok-2-vision')).toBe('grok-2-vision');
      expect(matchModelName('grok-2-vision-latest')).toBe('grok-2-vision-latest');
      // Beta models
      expect(matchModelName('grok-vision-beta')).toBe('grok-vision-beta');
      expect(matchModelName('grok-beta')).toBe('grok-beta');
      // Text models
      expect(matchModelName('grok-2-1212')).toBe('grok-2-1212');
      expect(matchModelName('grok-2')).toBe('grok-2');
      expect(matchModelName('grok-2-latest')).toBe('grok-2-latest');
      // Grok 3 models
      expect(matchModelName('grok-3')).toBe('grok-3');
      expect(matchModelName('grok-3-fast')).toBe('grok-3-fast');
      expect(matchModelName('grok-3-mini')).toBe('grok-3-mini');
      expect(matchModelName('grok-3-mini-fast')).toBe('grok-3-mini-fast');
      // Grok 4 model
      expect(matchModelName('grok-4-0709')).toBe('grok-4');
      // Grok 4 Fast and 4.1 Fast models
      expect(matchModelName('grok-4-fast')).toBe('grok-4-fast');
      expect(matchModelName('grok-4-1-fast-reasoning')).toBe('grok-4-1-fast');
      expect(matchModelName('grok-4-1-fast-non-reasoning')).toBe('grok-4-1-fast');
      // Grok Code Fast model
      expect(matchModelName('grok-code-fast-1')).toBe('grok-code-fast');
    });

    test('should match Grok model variations with prefixes', () => {
      // Vision models should match before general models
      expect(matchModelName('xai/grok-2-vision-1212')).toBe('grok-2-vision-1212');
      expect(matchModelName('xai/grok-2-vision')).toBe('grok-2-vision');
      expect(matchModelName('xai/grok-2-vision-latest')).toBe('grok-2-vision-latest');
      // Beta models
      expect(matchModelName('xai/grok-vision-beta')).toBe('grok-vision-beta');
      expect(matchModelName('xai/grok-beta')).toBe('grok-beta');
      // Text models
      expect(matchModelName('xai/grok-2-1212')).toBe('grok-2-1212');
      expect(matchModelName('xai/grok-2')).toBe('grok-2');
      expect(matchModelName('xai/grok-2-latest')).toBe('grok-2-latest');
      // Grok 3 models
      expect(matchModelName('xai/grok-3')).toBe('grok-3');
      expect(matchModelName('xai/grok-3-fast')).toBe('grok-3-fast');
      expect(matchModelName('xai/grok-3-mini')).toBe('grok-3-mini');
      expect(matchModelName('xai/grok-3-mini-fast')).toBe('grok-3-mini-fast');
      // Grok 4 model
      expect(matchModelName('xai/grok-4-0709')).toBe('grok-4');
      // Grok 4 Fast and 4.1 Fast models
      expect(matchModelName('xai/grok-4-fast')).toBe('grok-4-fast');
      expect(matchModelName('xai/grok-4-1-fast-reasoning')).toBe('grok-4-1-fast');
      expect(matchModelName('xai/grok-4-1-fast-non-reasoning')).toBe('grok-4-1-fast');
      // Grok Code Fast model
      expect(matchModelName('xai/grok-code-fast-1')).toBe('grok-code-fast');
    });
  });
});

describe('Claude Model Tests', () => {
  it('should return correct context length for Claude 4 models', () => {
    expect(getModelMaxTokens('claude-sonnet-4')).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-4'],
    );
    expect(getModelMaxTokens('claude-opus-4')).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-opus-4'],
    );
  });

  it('should return 200K for Claude Sonnet 4.5', () => {
    expect(getModelMaxTokens('claude-sonnet-4-5', EModelEndpoint.anthropic)).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-sonnet-4-5'],
    );
    expect(getModelMaxTokens('claude-sonnet-4-5-20250929')).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-sonnet-4-5'],
    );
  });

  it('should return correct context length for Claude Haiku 4.5', () => {
    expect(getModelMaxTokens('claude-haiku-4-5', EModelEndpoint.anthropic)).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-haiku-4-5'],
    );
    expect(getModelMaxTokens('claude-haiku-4-5')).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-haiku-4-5'],
    );
  });

  it('should return correct context length for Claude Opus 4.5', () => {
    expect(getModelMaxTokens('claude-opus-4-5', EModelEndpoint.anthropic)).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-opus-4-5'],
    );
    expect(getModelMaxTokens('claude-opus-4-5')).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-opus-4-5'],
    );
  });

  it('should handle Claude Haiku 4.5 model name variations', () => {
    const modelVariations = [
      'claude-haiku-4-5',
      'claude-haiku-4-5-20250420',
      'claude-haiku-4-5-latest',
      'anthropic/claude-haiku-4-5',
      'claude-haiku-4-5/anthropic',
      'claude-haiku-4-5-preview',
    ];

    modelVariations.forEach((model) => {
      const modelKey = findMatchingPattern(model, maxTokensMap[EModelEndpoint.anthropic]);
      expect(modelKey).toBe('claude-haiku-4-5');
      expect(getModelMaxTokens(model, EModelEndpoint.anthropic)).toBe(
        maxTokensMap[EModelEndpoint.anthropic]['claude-haiku-4-5'],
      );
    });
  });

  it('should handle Claude Opus 4.5 model name variations', () => {
    const modelVariations = [
      'claude-opus-4-5',
      'claude-opus-4-5-20250420',
      'claude-opus-4-5-latest',
      'anthropic/claude-opus-4-5',
      'claude-opus-4-5/anthropic',
      'claude-opus-4-5-preview',
    ];

    modelVariations.forEach((model) => {
      const modelKey = findMatchingPattern(model, maxTokensMap[EModelEndpoint.anthropic]);
      expect(modelKey).toBe('claude-opus-4-5');
      expect(getModelMaxTokens(model, EModelEndpoint.anthropic)).toBe(
        maxTokensMap[EModelEndpoint.anthropic]['claude-opus-4-5'],
      );
    });
  });

  it('should match model names correctly for Claude Haiku 4.5', () => {
    const modelVariations = [
      'claude-haiku-4-5',
      'claude-haiku-4-5-20250420',
      'claude-haiku-4-5-latest',
      'anthropic/claude-haiku-4-5',
      'claude-haiku-4-5/anthropic',
      'claude-haiku-4-5-preview',
    ];

    modelVariations.forEach((model) => {
      expect(matchModelName(model, EModelEndpoint.anthropic)).toBe('claude-haiku-4-5');
    });
  });

  it('should match model names correctly for Claude Opus 4.5', () => {
    const modelVariations = [
      'claude-opus-4-5',
      'claude-opus-4-5-20250420',
      'claude-opus-4-5-latest',
      'anthropic/claude-opus-4-5',
      'claude-opus-4-5/anthropic',
      'claude-opus-4-5-preview',
    ];

    modelVariations.forEach((model) => {
      expect(matchModelName(model, EModelEndpoint.anthropic)).toBe('claude-opus-4-5');
    });
  });

  it('should handle Claude 4 model name variations with different prefixes and suffixes', () => {
    const modelVariations = [
      'claude-sonnet-4',
      'claude-sonnet-4-20240229',
      'claude-sonnet-4-latest',
      'anthropic/claude-sonnet-4',
      'claude-sonnet-4/anthropic',
      'claude-sonnet-4-preview',
      'claude-sonnet-4-20240229-preview',
      'claude-opus-4',
      'claude-opus-4-20240229',
      'claude-opus-4-latest',
      'anthropic/claude-opus-4',
      'claude-opus-4/anthropic',
      'claude-opus-4-preview',
      'claude-opus-4-20240229-preview',
    ];

    modelVariations.forEach((model) => {
      const modelKey = findMatchingPattern(model, maxTokensMap[EModelEndpoint.anthropic]);
      expect(getModelMaxTokens(model)).toBe(maxTokensMap[EModelEndpoint.anthropic][modelKey]);
    });
  });

  it('should match model names correctly for Claude 4 models', () => {
    const modelVariations = [
      'claude-sonnet-4',
      'claude-sonnet-4-20240229',
      'claude-sonnet-4-latest',
      'anthropic/claude-sonnet-4',
      'claude-sonnet-4/anthropic',
      'claude-sonnet-4-preview',
      'claude-sonnet-4-20240229-preview',
      'claude-opus-4',
      'claude-opus-4-20240229',
      'claude-opus-4-latest',
      'anthropic/claude-opus-4',
      'claude-opus-4/anthropic',
      'claude-opus-4-preview',
      'claude-opus-4-20240229-preview',
    ];

    modelVariations.forEach((model) => {
      const isSonnet = model.includes('sonnet');
      const expectedModel = isSonnet ? 'claude-sonnet-4' : 'claude-opus-4';
      expect(matchModelName(model, EModelEndpoint.anthropic)).toBe(expectedModel);
    });
  });

  it('should return correct context length for Claude Opus 4.6 (1M)', () => {
    expect(getModelMaxTokens('claude-opus-4-6', EModelEndpoint.anthropic)).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-opus-4-6'],
    );
    expect(getModelMaxTokens('claude-opus-4-6')).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-opus-4-6'],
    );
  });

  it('should return correct max output tokens for Claude Opus 4.6 (128K)', () => {
    const { getModelMaxOutputTokens } = require('@librechat/api');
    expect(getModelMaxOutputTokens('claude-opus-4-6', EModelEndpoint.anthropic)).toBe(
      maxOutputTokensMap[EModelEndpoint.anthropic]['claude-opus-4-6'],
    );
  });

  it('should handle Claude Opus 4.6 model name variations', () => {
    const modelVariations = [
      'claude-opus-4-6',
      'claude-opus-4-6-20250801',
      'claude-opus-4-6-latest',
      'anthropic/claude-opus-4-6',
      'claude-opus-4-6/anthropic',
      'claude-opus-4-6-preview',
    ];

    modelVariations.forEach((model) => {
      const modelKey = findMatchingPattern(model, maxTokensMap[EModelEndpoint.anthropic]);
      expect(modelKey).toBe('claude-opus-4-6');
      expect(getModelMaxTokens(model, EModelEndpoint.anthropic)).toBe(
        maxTokensMap[EModelEndpoint.anthropic]['claude-opus-4-6'],
      );
    });
  });

  it('should match model names correctly for Claude Opus 4.6', () => {
    const modelVariations = [
      'claude-opus-4-6',
      'claude-opus-4-6-20250801',
      'claude-opus-4-6-latest',
      'anthropic/claude-opus-4-6',
      'claude-opus-4-6/anthropic',
      'claude-opus-4-6-preview',
    ];

    modelVariations.forEach((model) => {
      expect(matchModelName(model, EModelEndpoint.anthropic)).toBe('claude-opus-4-6');
    });
  });

  it('should return correct context length for Claude Opus 4.7 (1M)', () => {
    expect(getModelMaxTokens('claude-opus-4-7', EModelEndpoint.anthropic)).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-opus-4-7'],
    );
    expect(getModelMaxTokens('claude-opus-4-7')).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-opus-4-7'],
    );
  });

  it('should return correct max output tokens for Claude Opus 4.7 (128K)', () => {
    const { getModelMaxOutputTokens } = require('@librechat/api');
    expect(getModelMaxOutputTokens('claude-opus-4-7', EModelEndpoint.anthropic)).toBe(
      maxOutputTokensMap[EModelEndpoint.anthropic]['claude-opus-4-7'],
    );
  });

  it('should match model names correctly for Claude Opus 4.7', () => {
    const modelVariations = [
      'claude-opus-4-7',
      'claude-opus-4-7-20260401',
      'claude-opus-4-7-latest',
      'anthropic/claude-opus-4-7',
      'claude-opus-4-7/anthropic',
      'claude-opus-4-7-preview',
    ];

    modelVariations.forEach((model) => {
      expect(matchModelName(model, EModelEndpoint.anthropic)).toBe('claude-opus-4-7');
    });
  });

  it('should return correct context length for Claude Opus 4.8 (1M)', () => {
    expect(getModelMaxTokens('claude-opus-4-8', EModelEndpoint.anthropic)).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-opus-4-8'],
    );
    expect(getModelMaxTokens('claude-opus-4-8')).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-opus-4-8'],
    );
  });

  it('should return correct max output tokens for Claude Opus 4.8 (128K)', () => {
    const { getModelMaxOutputTokens } = require('@librechat/api');
    expect(getModelMaxOutputTokens('claude-opus-4-8', EModelEndpoint.anthropic)).toBe(
      maxOutputTokensMap[EModelEndpoint.anthropic]['claude-opus-4-8'],
    );
  });

  it('should match model names correctly for Claude Opus 4.8', () => {
    const modelVariations = [
      'claude-opus-4-8',
      'claude-opus-4-8-20260528',
      'claude-opus-4-8-latest',
      'anthropic/claude-opus-4-8',
      'claude-opus-4-8/anthropic',
      'claude-opus-4-8-preview',
    ];

    modelVariations.forEach((model) => {
      expect(matchModelName(model, EModelEndpoint.anthropic)).toBe('claude-opus-4-8');
    });
  });

  it('should return correct context length for Claude Opus 5 (1M)', () => {
    expect(getModelMaxTokens('claude-opus-5', EModelEndpoint.anthropic)).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-opus-5'],
    );
    expect(getModelMaxTokens('claude-opus-5')).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-opus-5'],
    );
  });

  it('should return correct max output tokens for Claude Opus 5 (128K)', () => {
    const { getModelMaxOutputTokens } = require('@librechat/api');
    expect(getModelMaxOutputTokens('claude-opus-5', EModelEndpoint.anthropic)).toBe(
      maxOutputTokensMap[EModelEndpoint.anthropic]['claude-opus-5'],
    );
  });

  it('should match model names correctly for Claude Opus 5', () => {
    const modelVariations = [
      'claude-opus-5',
      'claude-opus-5-20260701',
      'claude-opus-5-latest',
      'anthropic/claude-opus-5',
      'claude-opus-5/anthropic',
      'claude-opus-5-preview',
    ];

    modelVariations.forEach((model) => {
      expect(matchModelName(model, EModelEndpoint.anthropic)).toBe('claude-opus-5');
    });
  });

  it('should return correct context length for Claude Fable 5 (1M)', () => {
    expect(getModelMaxTokens('claude-fable-5', EModelEndpoint.anthropic)).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-fable-5'],
    );
    expect(getModelMaxTokens('claude-fable-5')).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-fable-5'],
    );
  });

  it('should return correct max output tokens for Claude Fable 5 (128K)', () => {
    const { getModelMaxOutputTokens } = require('@librechat/api');
    expect(getModelMaxOutputTokens('claude-fable-5', EModelEndpoint.anthropic)).toBe(
      maxOutputTokensMap[EModelEndpoint.anthropic]['claude-fable-5'],
    );
  });

  it('should match model names correctly for Claude Fable 5', () => {
    const modelVariations = [
      'claude-fable-5',
      'claude-fable-5-20260609',
      'claude-fable-5-latest',
      'anthropic/claude-fable-5',
      'claude-fable-5/anthropic',
      'anthropic.claude-fable-5',
    ];

    modelVariations.forEach((model) => {
      expect(matchModelName(model, EModelEndpoint.anthropic)).toBe('claude-fable-5');
    });
  });

  it('should return correct context length for Claude Mythos 5 (1M)', () => {
    expect(getModelMaxTokens('claude-mythos-5', EModelEndpoint.anthropic)).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-mythos-5'],
    );
    expect(getModelMaxTokens('claude-mythos-5')).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-mythos-5'],
    );
  });

  it('should return correct max output tokens for Claude Mythos 5 (128K)', () => {
    const { getModelMaxOutputTokens } = require('@librechat/api');
    expect(getModelMaxOutputTokens('claude-mythos-5', EModelEndpoint.anthropic)).toBe(
      maxOutputTokensMap[EModelEndpoint.anthropic]['claude-mythos-5'],
    );
  });

  it('should match model names correctly for Claude Mythos 5', () => {
    const modelVariations = [
      'claude-mythos-5',
      'claude-mythos-5-20260609',
      'claude-mythos-5-latest',
      'anthropic/claude-mythos-5',
      'claude-mythos-5/anthropic',
      'anthropic.claude-mythos-5',
    ];

    modelVariations.forEach((model) => {
      expect(matchModelName(model, EModelEndpoint.anthropic)).toBe('claude-mythos-5');
    });
  });

  it('should return correct context length for Claude Fable 5.1 (1M)', () => {
    expect(maxTokensMap[EModelEndpoint.anthropic]['claude-fable-5-1']).toBe(1000000);
    expect(maxTokensMap[EModelEndpoint.anthropic]['claude-mythos-5-1']).toBe(1000000);
    expect(getModelMaxTokens('claude-fable-5-1', EModelEndpoint.anthropic)).toBe(1000000);
    expect(getModelMaxTokens('claude-mythos-5-1', EModelEndpoint.anthropic)).toBe(1000000);
  });

  it('should return correct max output tokens for Claude Fable 5.1 (128K)', () => {
    const { getModelMaxOutputTokens } = require('@librechat/api');
    expect(maxOutputTokensMap[EModelEndpoint.anthropic]['claude-fable-5-1']).toBe(128000);
    expect(maxOutputTokensMap[EModelEndpoint.anthropic]['claude-mythos-5-1']).toBe(128000);
    expect(getModelMaxOutputTokens('claude-fable-5-1', EModelEndpoint.anthropic)).toBe(128000);
    expect(getModelMaxOutputTokens('claude-mythos-5-1', EModelEndpoint.anthropic)).toBe(128000);
  });

  it('should match model names correctly for Claude Fable 5.1 without collapsing to Fable 5', () => {
    const modelVariations = [
      'claude-fable-5-1',
      'claude-fable-5-1-20260901',
      'claude-fable-5-1-latest',
      'anthropic/claude-fable-5-1',
      'claude-fable-5-1/anthropic',
      'anthropic.claude-fable-5-1',
    ];

    modelVariations.forEach((model) => {
      expect(matchModelName(model, EModelEndpoint.anthropic)).toBe('claude-fable-5-1');
    });

    expect(matchModelName('claude-fable-5-20260609', EModelEndpoint.anthropic)).toBe(
      'claude-fable-5',
    );
  });

  it('should return correct context length for Claude Sonnet 4.6 (1M)', () => {
    expect(getModelMaxTokens('claude-sonnet-4-6', EModelEndpoint.anthropic)).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-sonnet-4-6'],
    );
    expect(getModelMaxTokens('claude-sonnet-4.6', EModelEndpoint.anthropic)).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-sonnet-4.6'],
    );
    expect(getModelMaxTokens('claude-sonnet-4-6')).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-sonnet-4-6'],
    );
    expect(getModelMaxTokens('claude-sonnet-4-6')).toBeGreaterThan(
      getModelMaxTokens('claude-sonnet-4-5'),
    );
  });

  it('should return correct max output tokens for Claude Sonnet 4.6 (128K)', () => {
    const { getModelMaxOutputTokens } = require('@librechat/api');
    expect(getModelMaxOutputTokens('claude-sonnet-4-6', EModelEndpoint.anthropic)).toBe(
      maxOutputTokensMap[EModelEndpoint.anthropic]['claude-sonnet-4-6'],
    );
    expect(getModelMaxOutputTokens('claude-sonnet-4.6', EModelEndpoint.anthropic)).toBe(
      maxOutputTokensMap[EModelEndpoint.anthropic]['claude-sonnet-4.6'],
    );
  });

  it('should return correct context length for Claude Sonnet 4.7+ aliases (1M)', () => {
    [
      'claude-sonnet-4-7',
      'claude-sonnet-4.7',
      'claude-sonnet-4-8',
      'claude-sonnet-4.8',
      'claude-sonnet-4-9',
      'claude-sonnet-4.9',
      'claude-sonnet-4-10',
      'claude-sonnet-4.10',
      'claude-4-10-sonnet',
      'claude-4.10-sonnet',
      'anthropic.claude-4-10-sonnet',
    ].forEach((model) => {
      expect(getModelMaxTokens(model, EModelEndpoint.anthropic)).toBe(1000000);
    });
    expect(getModelMaxTokens('anthropic.claude-4-10-sonnet', EModelEndpoint.bedrock)).toBe(1000000);
  });

  it('should return correct max output tokens for Claude Sonnet 4.7+ aliases (128K)', () => {
    const { getModelMaxOutputTokens } = require('@librechat/api');
    [
      'claude-sonnet-4-7',
      'claude-sonnet-4.7',
      'claude-sonnet-4-8',
      'claude-sonnet-4.8',
      'claude-sonnet-4-9',
      'claude-sonnet-4.9',
      'claude-sonnet-4-10',
      'claude-sonnet-4.10',
      'claude-4-10-sonnet',
      'claude-4.10-sonnet',
    ].forEach((model) => {
      expect(getModelMaxOutputTokens(model, EModelEndpoint.anthropic)).toBe(128000);
    });
  });

  it('should not treat dated Claude Sonnet 4 IDs as Claude Sonnet 4.6+ aliases', () => {
    const { getModelMaxOutputTokens } = require('@librechat/api');
    expect(getModelMaxTokens('claude-sonnet-4-20250514', EModelEndpoint.anthropic)).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-sonnet-4'],
    );
    expect(getModelMaxOutputTokens('claude-sonnet-4-20250514', EModelEndpoint.anthropic)).toBe(
      maxOutputTokensMap[EModelEndpoint.anthropic]['claude-sonnet-4'],
    );
    expect(getModelMaxTokens('claude-4-20250514-sonnet', EModelEndpoint.bedrock)).toBe(
      maxTokensMap[EModelEndpoint.bedrock]['claude-4'],
    );
  });

  it('should keep double-digit Claude Sonnet 4 minor names when matching models', () => {
    expect(matchModelName('claude-sonnet-4-10', EModelEndpoint.anthropic)).toBe(
      'claude-sonnet-4-10',
    );
    expect(matchModelName('claude-sonnet-4.10-latest', EModelEndpoint.anthropic)).toBe(
      'claude-sonnet-4.10-latest',
    );
    expect(matchModelName('claude-4-10-sonnet', EModelEndpoint.bedrock)).toBe('claude-4-10-sonnet');
    expect(matchModelName('anthropic.claude-4.10-sonnet', EModelEndpoint.bedrock)).toBe(
      'anthropic.claude-4.10-sonnet',
    );
  });

  it('should handle Claude Sonnet 4.6 model name variations', () => {
    const modelVariations = [
      'claude-sonnet-4-6',
      'claude-sonnet-4-6-20260101',
      'claude-sonnet-4-6-latest',
      'anthropic/claude-sonnet-4-6',
      'claude-sonnet-4-6/anthropic',
      'claude-sonnet-4-6-preview',
    ];

    modelVariations.forEach((model) => {
      const modelKey = findMatchingPattern(model, maxTokensMap[EModelEndpoint.anthropic]);
      expect(modelKey).toBe('claude-sonnet-4-6');
      expect(getModelMaxTokens(model, EModelEndpoint.anthropic)).toBe(
        maxTokensMap[EModelEndpoint.anthropic]['claude-sonnet-4-6'],
      );
    });
  });

  it('should match model names correctly for Claude Sonnet 4.6', () => {
    const modelVariations = [
      'claude-sonnet-4-6',
      'claude-sonnet-4-6-20260101',
      'claude-sonnet-4-6-latest',
      'anthropic/claude-sonnet-4-6',
      'claude-sonnet-4-6/anthropic',
      'claude-sonnet-4-6-preview',
    ];

    modelVariations.forEach((model) => {
      expect(matchModelName(model, EModelEndpoint.anthropic)).toBe('claude-sonnet-4-6');
    });
  });

  it('should return correct context length for Claude Sonnet 5 (1M)', () => {
    expect(getModelMaxTokens('claude-sonnet-5', EModelEndpoint.anthropic)).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-sonnet-5'],
    );
    expect(getModelMaxTokens('claude-sonnet-5')).toBe(
      maxTokensMap[EModelEndpoint.anthropic]['claude-sonnet-5'],
    );
  });

  it('should return correct max output tokens for Claude Sonnet 5 (128K)', () => {
    const { getModelMaxOutputTokens } = require('@librechat/api');
    expect(getModelMaxOutputTokens('claude-sonnet-5', EModelEndpoint.anthropic)).toBe(
      maxOutputTokensMap[EModelEndpoint.anthropic]['claude-sonnet-5'],
    );
    expect(getModelMaxOutputTokens('claude-sonnet-5', EModelEndpoint.anthropic)).toBe(
      getModelMaxOutputTokens('claude-sonnet-4-6', EModelEndpoint.anthropic),
    );
  });

  it('should not match Claude Sonnet 5 against Claude Sonnet 4 keys', () => {
    const modelVariations = [
      'claude-sonnet-5',
      'claude-sonnet-5-20260101',
      'claude-sonnet-5-latest',
      'anthropic/claude-sonnet-5',
      'claude-sonnet-5/anthropic',
      'anthropic.claude-sonnet-5',
    ];

    modelVariations.forEach((model) => {
      const modelKey = findMatchingPattern(model, maxTokensMap[EModelEndpoint.anthropic]);
      expect(modelKey).toBe('claude-sonnet-5');
      expect(getModelMaxTokens(model, EModelEndpoint.anthropic)).toBe(
        maxTokensMap[EModelEndpoint.anthropic]['claude-sonnet-5'],
      );
    });
  });

  it('should match model names correctly for Claude Sonnet 5', () => {
    const modelVariations = [
      'claude-sonnet-5',
      'claude-sonnet-5-20260101',
      'claude-sonnet-5-latest',
      'anthropic/claude-sonnet-5',
      'claude-sonnet-5/anthropic',
      'claude-sonnet-5-preview',
    ];

    modelVariations.forEach((model) => {
      expect(matchModelName(model, EModelEndpoint.anthropic)).toBe('claude-sonnet-5');
    });
  });
});

describe('Moonshot/Kimi Model Tests', () => {
  describe('getModelMaxTokens', () => {
    test('should return correct tokens for kimi-k2.5 (multi-modal)', () => {
      expect(getModelMaxTokens('kimi-k2.5')).toBe(maxTokensMap[EModelEndpoint.openAI]['kimi-k2.5']);
      expect(getModelMaxTokens('kimi-k2.5-latest')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['kimi-k2.5'],
      );
    });

    test('should return correct tokens for kimi-k2 series models', () => {
      expect(getModelMaxTokens('kimi')).toBe(maxTokensMap[EModelEndpoint.openAI]['kimi']);
      expect(getModelMaxTokens('kimi-k2')).toBe(maxTokensMap[EModelEndpoint.openAI]['kimi-k2']);
      expect(getModelMaxTokens('kimi-k2-turbo')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['kimi-k2-turbo'],
      );
      expect(getModelMaxTokens('kimi-k2-turbo-preview')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['kimi-k2-turbo-preview'],
      );
      expect(getModelMaxTokens('kimi-k2-0905')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['kimi-k2-0905'],
      );
      expect(getModelMaxTokens('kimi-k2-0905-preview')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['kimi-k2-0905-preview'],
      );
      expect(getModelMaxTokens('kimi-k2-thinking')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['kimi-k2-thinking'],
      );
      expect(getModelMaxTokens('kimi-k2-thinking-turbo')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['kimi-k2-thinking-turbo'],
      );
    });

    test('should return correct tokens for kimi-k2-0711 (smaller context)', () => {
      expect(getModelMaxTokens('kimi-k2-0711')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['kimi-k2-0711'],
      );
      expect(getModelMaxTokens('kimi-k2-0711-preview')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['kimi-k2-0711-preview'],
      );
    });

    test('should return correct tokens for kimi-latest', () => {
      expect(getModelMaxTokens('kimi-latest')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['kimi-latest'],
      );
    });

    test('should return correct tokens for moonshot-v1 series models', () => {
      expect(getModelMaxTokens('moonshot')).toBe(maxTokensMap[EModelEndpoint.openAI]['moonshot']);
      expect(getModelMaxTokens('moonshot-v1')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['moonshot-v1'],
      );
      expect(getModelMaxTokens('moonshot-v1-auto')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['moonshot-v1-auto'],
      );
      expect(getModelMaxTokens('moonshot-v1-8k')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['moonshot-v1-8k'],
      );
      expect(getModelMaxTokens('moonshot-v1-8k-vision')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['moonshot-v1-8k-vision'],
      );
      expect(getModelMaxTokens('moonshot-v1-8k-vision-preview')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['moonshot-v1-8k-vision-preview'],
      );
      expect(getModelMaxTokens('moonshot-v1-32k')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['moonshot-v1-32k'],
      );
      expect(getModelMaxTokens('moonshot-v1-32k-vision')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['moonshot-v1-32k-vision'],
      );
      expect(getModelMaxTokens('moonshot-v1-32k-vision-preview')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['moonshot-v1-32k-vision-preview'],
      );
      expect(getModelMaxTokens('moonshot-v1-128k')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['moonshot-v1-128k'],
      );
      expect(getModelMaxTokens('moonshot-v1-128k-vision')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['moonshot-v1-128k-vision'],
      );
      expect(getModelMaxTokens('moonshot-v1-128k-vision-preview')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['moonshot-v1-128k-vision-preview'],
      );
    });

    test('should return correct tokens for Bedrock moonshot models', () => {
      expect(getModelMaxTokens('moonshot.kimi', EModelEndpoint.bedrock)).toBe(
        maxTokensMap[EModelEndpoint.bedrock]['moonshot.kimi'],
      );
      expect(getModelMaxTokens('moonshot.kimi-k2', EModelEndpoint.bedrock)).toBe(
        maxTokensMap[EModelEndpoint.bedrock]['moonshot.kimi-k2'],
      );
      expect(getModelMaxTokens('moonshot.kimi-k2.5', EModelEndpoint.bedrock)).toBe(
        maxTokensMap[EModelEndpoint.bedrock]['moonshot.kimi-k2.5'],
      );
      expect(getModelMaxTokens('moonshot.kimi-k2-thinking', EModelEndpoint.bedrock)).toBe(
        maxTokensMap[EModelEndpoint.bedrock]['moonshot.kimi-k2-thinking'],
      );
      expect(getModelMaxTokens('moonshot.kimi-k2-0711', EModelEndpoint.bedrock)).toBe(
        maxTokensMap[EModelEndpoint.bedrock]['moonshot.kimi-k2-0711'],
      );
    });

    test('should handle Moonshot/Kimi models with provider prefixes', () => {
      expect(getModelMaxTokens('openrouter/kimi-k2')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['kimi-k2'],
      );
      expect(getModelMaxTokens('openrouter/kimi-k2.5')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['kimi-k2.5'],
      );
      expect(getModelMaxTokens('openrouter/kimi-k2-turbo')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['kimi-k2-turbo'],
      );
      expect(getModelMaxTokens('openrouter/moonshot-v1-128k')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['moonshot-v1-128k'],
      );
    });
  });

  describe('matchModelName', () => {
    test('should match exact Kimi model names', () => {
      expect(matchModelName('kimi')).toBe('kimi');
      expect(matchModelName('kimi-k2')).toBe('kimi-k2');
      expect(matchModelName('kimi-k2.5')).toBe('kimi-k2.5');
      expect(matchModelName('kimi-k2-turbo')).toBe('kimi-k2-turbo');
      expect(matchModelName('kimi-k2-0711')).toBe('kimi-k2-0711');
    });

    test('should match moonshot model names', () => {
      expect(matchModelName('moonshot')).toBe('moonshot');
      expect(matchModelName('moonshot-v1-8k')).toBe('moonshot-v1-8k');
      expect(matchModelName('moonshot-v1-32k')).toBe('moonshot-v1-32k');
      expect(matchModelName('moonshot-v1-128k')).toBe('moonshot-v1-128k');
    });

    test('should match Kimi model variations with provider prefix', () => {
      expect(matchModelName('openrouter/kimi')).toBe('kimi');
      expect(matchModelName('openrouter/kimi-k2')).toBe('kimi-k2');
      expect(matchModelName('openrouter/kimi-k2.5')).toBe('kimi-k2.5');
    });

    test('should match Kimi model variations with suffixes', () => {
      expect(matchModelName('kimi-k2-latest')).toBe('kimi-k2');
      expect(matchModelName('kimi-k2.5-preview')).toBe('kimi-k2.5');
    });
  });
});

describe('Qwen3 Model Tests', () => {
  describe('getModelMaxTokens', () => {
    test('should return correct tokens for Qwen3 base pattern', () => {
      expect(getModelMaxTokens('qwen3')).toBe(maxTokensMap[EModelEndpoint.openAI]['qwen3']);
    });

    test('should return correct tokens for qwen3-4b (falls back to qwen3)', () => {
      expect(getModelMaxTokens('qwen3-4b')).toBe(maxTokensMap[EModelEndpoint.openAI]['qwen3']);
    });

    test('should return correct tokens for Qwen3 base models', () => {
      expect(getModelMaxTokens('qwen3-8b')).toBe(maxTokensMap[EModelEndpoint.openAI]['qwen3-8b']);
      expect(getModelMaxTokens('qwen3-14b')).toBe(maxTokensMap[EModelEndpoint.openAI]['qwen3-14b']);
      expect(getModelMaxTokens('qwen3-32b')).toBe(maxTokensMap[EModelEndpoint.openAI]['qwen3-32b']);
      expect(getModelMaxTokens('qwen3-235b-a22b')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['qwen3-235b-a22b'],
      );
    });

    test('should return correct tokens for Qwen3 VL (Vision-Language) models', () => {
      expect(getModelMaxTokens('qwen3-vl-8b-thinking')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['qwen3-vl-8b-thinking'],
      );
      expect(getModelMaxTokens('qwen3-vl-8b-instruct')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['qwen3-vl-8b-instruct'],
      );
      expect(getModelMaxTokens('qwen3-vl-30b-a3b')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['qwen3-vl-30b-a3b'],
      );
      expect(getModelMaxTokens('qwen3-vl-235b-a22b')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['qwen3-vl-235b-a22b'],
      );
    });

    test('should return correct tokens for Qwen3 specialized models', () => {
      expect(getModelMaxTokens('qwen3-max')).toBe(maxTokensMap[EModelEndpoint.openAI]['qwen3-max']);
      expect(getModelMaxTokens('qwen3-coder')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['qwen3-coder'],
      );
      expect(getModelMaxTokens('qwen3-coder-30b-a3b')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['qwen3-coder-30b-a3b'],
      );
      expect(getModelMaxTokens('qwen3-coder-plus')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['qwen3-coder-plus'],
      );
      expect(getModelMaxTokens('qwen3-coder-flash')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['qwen3-coder-flash'],
      );
      expect(getModelMaxTokens('qwen3-next-80b-a3b')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['qwen3-next-80b-a3b'],
      );
    });

    test('should handle Qwen3 models with provider prefixes', () => {
      expect(getModelMaxTokens('alibaba/qwen3')).toBe(maxTokensMap[EModelEndpoint.openAI]['qwen3']);
      expect(getModelMaxTokens('alibaba/qwen3-4b')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['qwen3'],
      );
      expect(getModelMaxTokens('qwen/qwen3-8b')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['qwen3-8b'],
      );
      expect(getModelMaxTokens('openrouter/qwen3-max')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['qwen3-max'],
      );
      expect(getModelMaxTokens('alibaba/qwen3-vl-8b-instruct')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['qwen3-vl-8b-instruct'],
      );
      expect(getModelMaxTokens('qwen/qwen3-coder')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['qwen3-coder'],
      );
    });

    test('should handle Qwen3 models with suffixes', () => {
      expect(getModelMaxTokens('qwen3-preview')).toBe(maxTokensMap[EModelEndpoint.openAI]['qwen3']);
      expect(getModelMaxTokens('qwen3-4b-preview')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['qwen3'],
      );
      expect(getModelMaxTokens('qwen3-8b-latest')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['qwen3-8b'],
      );
      expect(getModelMaxTokens('qwen3-max-2024')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['qwen3-max'],
      );
    });
  });

  describe('matchModelName', () => {
    test('should match exact Qwen3 model names', () => {
      expect(matchModelName('qwen3')).toBe('qwen3');
      expect(matchModelName('qwen3-4b')).toBe('qwen3');
      expect(matchModelName('qwen3-8b')).toBe('qwen3-8b');
      expect(matchModelName('qwen3-vl-8b-thinking')).toBe('qwen3-vl-8b-thinking');
      expect(matchModelName('qwen3-max')).toBe('qwen3-max');
      expect(matchModelName('qwen3-coder')).toBe('qwen3-coder');
    });

    test('should match Qwen3 model variations with provider prefixes', () => {
      expect(matchModelName('alibaba/qwen3')).toBe('qwen3');
      expect(matchModelName('alibaba/qwen3-4b')).toBe('qwen3');
      expect(matchModelName('qwen/qwen3-8b')).toBe('qwen3-8b');
      expect(matchModelName('openrouter/qwen3-max')).toBe('qwen3-max');
      expect(matchModelName('alibaba/qwen3-vl-8b-instruct')).toBe('qwen3-vl-8b-instruct');
      expect(matchModelName('qwen/qwen3-coder')).toBe('qwen3-coder');
    });

    test('should match Qwen3 model variations with suffixes', () => {
      expect(matchModelName('qwen3-preview')).toBe('qwen3');
      expect(matchModelName('qwen3-4b-preview')).toBe('qwen3');
      expect(matchModelName('qwen3-8b-latest')).toBe('qwen3-8b');
      expect(matchModelName('qwen3-max-2024')).toBe('qwen3-max');
      expect(matchModelName('qwen3-coder-v1')).toBe('qwen3-coder');
    });
  });
});

describe('GLM Model Tests (Zhipu AI)', () => {
  describe('getModelMaxTokens', () => {
    test('should return correct tokens for GLM models', () => {
      expect(getModelMaxTokens('glm-4.6')).toBe(maxTokensMap[EModelEndpoint.openAI]['glm-4.6']);
      expect(getModelMaxTokens('glm-4.5v')).toBe(maxTokensMap[EModelEndpoint.openAI]['glm-4.5v']);
      expect(getModelMaxTokens('glm-4.5-air')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['glm-4.5-air'],
      );
      expect(getModelMaxTokens('glm-4.5')).toBe(maxTokensMap[EModelEndpoint.openAI]['glm-4.5']);
      expect(getModelMaxTokens('glm-4-32b')).toBe(maxTokensMap[EModelEndpoint.openAI]['glm-4-32b']);
      expect(getModelMaxTokens('glm-4')).toBe(maxTokensMap[EModelEndpoint.openAI]['glm-4']);
      expect(getModelMaxTokens('glm4')).toBe(maxTokensMap[EModelEndpoint.openAI]['glm4']);
    });

    test('should handle partial matches for GLM models with provider prefixes', () => {
      expect(getModelMaxTokens('z-ai/glm-4.6')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['glm-4.6'],
      );
      expect(getModelMaxTokens('z-ai/glm-4.5')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['glm-4.5'],
      );
      expect(getModelMaxTokens('z-ai/glm-4.5-air')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['glm-4.5-air'],
      );
      expect(getModelMaxTokens('z-ai/glm-4.5v')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['glm-4.5v'],
      );
      expect(getModelMaxTokens('z-ai/glm-4-32b')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['glm-4-32b'],
      );

      expect(getModelMaxTokens('zai/glm-4.6')).toBe(maxTokensMap[EModelEndpoint.openAI]['glm-4.6']);
      expect(getModelMaxTokens('zai/glm-4.5')).toBe(maxTokensMap[EModelEndpoint.openAI]['glm-4.5']);
      expect(getModelMaxTokens('zai/glm-4.5-air')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['glm-4.5-air'],
      );
      expect(getModelMaxTokens('zai/glm-4.5v')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['glm-4.5v'],
      );

      expect(getModelMaxTokens('zai-org/GLM-4.6')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['glm-4.6'],
      );
      expect(getModelMaxTokens('zai-org/GLM-4.5')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['glm-4.5'],
      );
      expect(getModelMaxTokens('zai-org/GLM-4.5-Air')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['glm-4.5-air'],
      );
      expect(getModelMaxTokens('zai-org/GLM-4.5V')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['glm-4.5v'],
      );
      expect(getModelMaxTokens('zai-org/GLM-4-32B-0414')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['glm-4-32b'],
      );
    });

    test('should handle GLM model variations with suffixes', () => {
      expect(getModelMaxTokens('glm-4.6-fp8')).toBe(maxTokensMap[EModelEndpoint.openAI]['glm-4.6']);
      expect(getModelMaxTokens('zai-org/GLM-4.6-FP8')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['glm-4.6'],
      );
      expect(getModelMaxTokens('zai-org/GLM-4.5-Air-FP8')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['glm-4.5-air'],
      );
    });

    test('should prioritize more specific GLM patterns', () => {
      expect(getModelMaxTokens('glm-4.5-air-custom')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['glm-4.5-air'],
      );
      expect(getModelMaxTokens('glm-4.5-custom')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['glm-4.5'],
      );
      expect(getModelMaxTokens('glm-4.5v-custom')).toBe(
        maxTokensMap[EModelEndpoint.openAI]['glm-4.5v'],
      );
    });
  });

  describe('matchModelName', () => {
    test('should match exact GLM model names', () => {
      expect(matchModelName('glm-4.6')).toBe('glm-4.6');
      expect(matchModelName('glm-4.5v')).toBe('glm-4.5v');
      expect(matchModelName('glm-4.5-air')).toBe('glm-4.5-air');
      expect(matchModelName('glm-4.5')).toBe('glm-4.5');
      expect(matchModelName('glm-4-32b')).toBe('glm-4-32b');
      expect(matchModelName('glm-4')).toBe('glm-4');
      expect(matchModelName('glm4')).toBe('glm4');
    });

    test('should match GLM model variations with provider prefixes', () => {
      expect(matchModelName('z-ai/glm-4.6')).toBe('glm-4.6');
      expect(matchModelName('z-ai/glm-4.5')).toBe('glm-4.5');
      expect(matchModelName('z-ai/glm-4.5-air')).toBe('glm-4.5-air');
      expect(matchModelName('z-ai/glm-4.5v')).toBe('glm-4.5v');
      expect(matchModelName('z-ai/glm-4-32b')).toBe('glm-4-32b');

      expect(matchModelName('zai/glm-4.6')).toBe('glm-4.6');
      expect(matchModelName('zai/glm-4.5')).toBe('glm-4.5');
      expect(matchModelName('zai/glm-4.5-air')).toBe('glm-4.5-air');
      expect(matchModelName('zai/glm-4.5v')).toBe('glm-4.5v');

      expect(matchModelName('zai-org/GLM-4.6')).toBe('glm-4.6');
      expect(matchModelName('zai-org/GLM-4.5')).toBe('glm-4.5');
      expect(matchModelName('zai-org/GLM-4.5-Air')).toBe('glm-4.5-air');
      expect(matchModelName('zai-org/GLM-4.5V')).toBe('glm-4.5v');
      expect(matchModelName('zai-org/GLM-4-32B-0414')).toBe('glm-4-32b');
    });

    test('should match GLM model variations with suffixes', () => {
      expect(matchModelName('glm-4.6-fp8')).toBe('glm-4.6');
      expect(matchModelName('zai-org/GLM-4.6-FP8')).toBe('glm-4.6');
      expect(matchModelName('zai-org/GLM-4.5-Air-FP8')).toBe('glm-4.5-air');
    });

    test('should handle case-insensitive matching for GLM models', () => {
      expect(matchModelName('zai-org/GLM-4.6')).toBe('glm-4.6');
      expect(matchModelName('zai-org/GLM-4.5V')).toBe('glm-4.5v');
      expect(matchModelName('zai-org/GLM-4-32B-0414')).toBe('glm-4-32b');
    });
  });
});

describe('Mistral Model Tests', () => {
  describe('getModelMaxTokens', () => {
    test('should return correct tokens for mistral-large-3 (256k context)', () => {
      expect(getModelMaxTokens('mistral-large-3', EModelEndpoint.custom)).toBe(
        maxTokensMap[EModelEndpoint.custom]['mistral-large-3'],
      );
    });

    test('should match mistral-large-3 for suffixed variants', () => {
      expect(getModelMaxTokens('mistral-large-3-instruct', EModelEndpoint.custom)).toBe(
        maxTokensMap[EModelEndpoint.custom]['mistral-large-3'],
      );
    });

    test('should not match mistral-large-3 for generic mistral-large', () => {
      expect(getModelMaxTokens('mistral-large', EModelEndpoint.custom)).toBe(
        maxTokensMap[EModelEndpoint.custom]['mistral-large'],
      );
      expect(getModelMaxTokens('mistral-large-latest', EModelEndpoint.custom)).toBe(
        maxTokensMap[EModelEndpoint.custom]['mistral-large'],
      );
    });
  });

  describe('matchModelName', () => {
    test('should match mistral-large-3 exactly', () => {
      expect(matchModelName('mistral-large-3', EModelEndpoint.custom)).toBe('mistral-large-3');
    });

    test('should match mistral-large-3 for prefixed/suffixed variants', () => {
      expect(matchModelName('mistral/mistral-large-3', EModelEndpoint.custom)).toBe(
        'mistral-large-3',
      );
      expect(matchModelName('mistral-large-3-instruct', EModelEndpoint.custom)).toBe(
        'mistral-large-3',
      );
    });

    test('should match generic mistral-large for non-3 variants', () => {
      expect(matchModelName('mistral-large-latest', EModelEndpoint.custom)).toBe('mistral-large');
    });
  });

  describe('findMatchingPattern', () => {
    test('should prefer mistral-large-3 over mistral-large for mistral-large-3 variants', () => {
      const result = findMatchingPattern(
        'mistral-large-3-instruct',
        maxTokensMap[EModelEndpoint.custom],
      );
      expect(result).toBe('mistral-large-3');
    });
  });
});
