import { EModelEndpoint } from 'librechat-data-provider';
import { Providers, TitleMethod } from '@librechat/agents';
import { resolveTitleModelConfig } from './title';

it('preserves the provider carrier while removing generation-only caps without mutating their source', () => {
  const carrier = { defaultHeaders: { 'X-User': '{{LIBRECHAT_USER_ID}}' } };
  const modelKwargs = { max_completion_tokens: 1000, max_output_tokens: 2000, temperature: 0.4 };
  const result = resolveTitleModelConfig({
    endpoint: EModelEndpoint.anthropic,
    fallbackProvider: 'anthropic',
    options: {
      llmConfig: { model: 'claude', maxTokens: 2000, modelKwargs, clientOptions: carrier },
    },
  });
  expect(result.clientOptions.clientOptions).toBe(carrier);
  expect(result.clientOptions).not.toHaveProperty('maxTokens');
  expect(result.clientOptions.modelKwargs).toEqual({ temperature: 0.4 });
  expect(modelKwargs).toEqual({
    max_completion_tokens: 1000,
    max_output_tokens: 2000,
    temperature: 0.4,
  });
});

it.each([undefined, 'azure-instance'])(
  'resolves Azure title transport from the effective connection: %s',
  (instance) => {
    const result = resolveTitleModelConfig({
      endpoint: EModelEndpoint.azureOpenAI,
      fallbackProvider: 'azure',
      options: { llmConfig: { azureOpenAIApiInstanceName: instance } },
    });
    expect(result.provider).toBe(instance ? Providers.AZURE : Providers.OPENAI);
  },
);

it('applies the same Google structured-title option for both callers', () => {
  expect(
    resolveTitleModelConfig({
      endpoint: EModelEndpoint.google,
      fallbackProvider: 'google',
      options: { llmConfig: { model: 'gemini' } },
      titleMethod: TitleMethod.STRUCTURED,
    }).clientOptions.json,
  ).toBe(true);
});
