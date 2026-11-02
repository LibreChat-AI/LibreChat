import { Providers } from '@librechat/agents';
import { AuthKeys, EModelEndpoint } from 'librechat-data-provider';
import type { Agent } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import { getOpenAILLMConfig } from '~/endpoints/openai/llm';
import { getGoogleConfig } from '~/endpoints/google/llm';
import { validateAgentModel } from './validation';
import { pinAgentModel } from './pin';

describe('pinAgentModel', () => {
  it.each([undefined, null, []])('removes modelName without object kwargs (%p)', (modelKwargs) => {
    expect(
      pinAgentModel(
        {
          modelName: 'gpt-4o',
          temperature: 0.2,
          fallbacks: [{ provider: Providers.OPENAI, clientOptions: { model: 'gpt-4o' } }],
          modelKwargs,
        },
        'gpt-4o-mini',
      ),
    ).toEqual({ model: 'gpt-4o-mini', temperature: 0.2, modelKwargs });
  });

  it('copies routing kwargs without mutating saved parameters', () => {
    const modelOptions = Object.freeze({
      model: 'gpt-4o',
      modelName: 'gpt-4o',
      temperature: 0.2,
      fallbacks: [{ provider: Providers.OPENAI, clientOptions: { model: 'gpt-4o' } }],
      modelKwargs: Object.freeze({
        model: 'gpt-4o',
        models: ['gpt-4o'],
        route: 'fallback',
        fallbacks: ['gpt-4o'],
        service_tier: 'flex',
      }),
    });

    const pinned = pinAgentModel(modelOptions, 'gpt-4o-mini');

    expect(pinned).toEqual({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      modelKwargs: { service_tier: 'flex' },
    });
    expect(pinned.modelKwargs).not.toBe(modelOptions.modelKwargs);
    expect(modelOptions).toHaveProperty('modelName', 'gpt-4o');
    expect(modelOptions).toHaveProperty('fallbacks', [
      { provider: Providers.OPENAI, clientOptions: { model: 'gpt-4o' } },
    ]);
    expect(modelOptions.modelKwargs).toEqual({
      model: 'gpt-4o',
      models: ['gpt-4o'],
      route: 'fallback',
      fallbacks: ['gpt-4o'],
      service_tier: 'flex',
    });
  });
});

describe('pinned provider configuration', () => {
  it.each([false, true])('pins OpenAI-compatible options (OpenRouter: %s)', (useOpenRouter) => {
    const modelOptions = pinAgentModel(
      {
        model: 'gpt-4o',
        modelName: 'gpt-4o',
        temperature: 0.2,
        fallbacks: [
          {
            provider: Providers.OPENAI,
            clientOptions: {
              model: 'gpt-4o',
              configuration: { baseURL: 'https://unchecked.invalid' },
            },
          },
        ],
        modelKwargs: {
          model: 'gpt-4o',
          models: ['gpt-4o'],
          route: 'fallback',
          fallbacks: ['gpt-4o'],
          service_tier: 'flex',
        },
      },
      'gpt-4o-mini',
    );

    const { llmConfig } = getOpenAILLMConfig({
      apiKey: 'test-api-key',
      streaming: true,
      endpoint: EModelEndpoint.openAI,
      useOpenRouter,
      modelOptions,
    });

    expect(llmConfig).toMatchObject({ model: 'gpt-4o-mini', temperature: 0.2 });
    expect(llmConfig).not.toHaveProperty('modelName');
    expect(llmConfig).not.toHaveProperty('fallbacks');
    expect(llmConfig.modelKwargs ?? {}).not.toHaveProperty('service_tier');
  });

  it('pins Google options while preserving server-configured transport', () => {
    const modelOptions = pinAgentModel(
      {
        model: 'gemini-2.5-pro',
        modelName: 'gemini-2.5-pro',
        temperature: 0.2,
        maxOutputTokens: 1024,
        apiKey: 'untrusted-api-key',
        apiVersion: 'v1alpha',
        baseUrl: 'https://unchecked.invalid',
        customHeaders: { Authorization: 'untrusted-authorization' },
        fallbacks: [{ provider: Providers.OPENAI, clientOptions: { model: 'gpt-4o' } }],
      },
      'gemini-2.5-flash',
    );

    const { provider, llmConfig } = getGoogleConfig(
      { [AuthKeys.GOOGLE_API_KEY]: 'server-api-key' },
      {
        modelOptions,
        reverseProxyUrl: 'https://configured.invalid/google',
        authHeader: true,
        headers: { 'X-Gateway': 'configured' },
      },
    );

    expect(provider).toBe(Providers.GOOGLE);
    expect(llmConfig).toMatchObject({
      model: 'gemini-2.5-flash',
      temperature: 0.2,
      maxOutputTokens: 1024,
      apiKey: 'server-api-key',
      baseUrl: 'https://configured.invalid/google',
      customHeaders: { 'X-Gateway': 'configured', Authorization: 'Bearer server-api-key' },
    });
    expect(llmConfig).not.toHaveProperty('modelName');
    expect(llmConfig).not.toHaveProperty('fallbacks');
    expect(llmConfig).not.toHaveProperty('apiVersion');
  });

  it('pins Vertex options without replacing the configured project', () => {
    const modelOptions = pinAgentModel(
      {
        modelName: 'gemini-2.5-pro',
        temperature: 0.2,
        apiVersion: 'v1alpha',
        authOptions: { projectId: 'unchecked-project' },
      },
      'gemini-2.5-flash',
    );

    const { provider, llmConfig } = getGoogleConfig(
      { [AuthKeys.GOOGLE_SERVICE_KEY]: { project_id: 'configured-project' } },
      { modelOptions, forceVertex: true, projectId: 'configured-project' },
    );

    expect(provider).toBe(Providers.VERTEXAI);
    expect(llmConfig).toMatchObject({
      model: 'gemini-2.5-flash',
      temperature: 0.2,
      authOptions: { projectId: 'configured-project' },
    });
    expect(llmConfig).not.toHaveProperty('modelName');
    expect(llmConfig).not.toHaveProperty('apiVersion');
  });

  it('still rejects a disallowed declared model when aliases name an allowed model', async () => {
    const logViolation = jest.fn().mockResolvedValue(undefined);
    const modelParameters = {
      temperature: 0.2,
      maxContextTokens: null,
      max_context_tokens: null,
      max_output_tokens: null,
      top_p: null,
      frequency_penalty: null,
      presence_penalty: null,
      modelName: 'gpt-4o-mini',
      modelKwargs: { model: 'gpt-4o-mini' },
    };
    const agent: Agent = {
      id: 'restricted-agent',
      name: 'Restricted agent',
      description: null,
      created_at: 0,
      avatar: null,
      provider: Providers.OPENAI,
      model: 'gpt-4o',
      model_parameters: modelParameters,
    };

    const validation = await validateAgentModel({
      req: {} as Request<unknown, unknown, unknown>,
      res: {} as Response,
      agent,
      modelsConfig: { [EModelEndpoint.openAI]: ['gpt-4o-mini'] },
      logViolation,
    });

    expect(validation.isValid).toBe(false);
    expect(validation.error?.message).toContain('illegal_model_request');
    expect(logViolation).toHaveBeenCalledTimes(1);
  });
});
