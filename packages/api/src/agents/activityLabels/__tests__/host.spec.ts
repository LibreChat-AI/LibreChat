import type { AppConfig } from '@librechat/data-schemas';
import type { EndpointDbMethods, ServerRequest } from '~/types';
import {
  mapCollectedMetadataToUsage,
  resolveActivityConfig,
  resolveActivityPhaseConfig,
  resolveReasoningLabelConfig,
  resolveActivityLabelModel,
} from '../host';

const mockGetOptions = jest.fn(async (_params: unknown) => ({
  llmConfig: { model: 'resolved' },
}));
const mockResolveConfigHeaders = jest.fn();
jest.mock('~/endpoints/config/providers', () => ({
  getProviderConfig: jest.fn(() => ({
    getOptions: (params: unknown) => mockGetOptions(params),
    customEndpointConfig: undefined,
  })),
}));
jest.mock('~/utils/headers', () => ({
  resolveConfigHeaders: (...args: unknown[]) => mockResolveConfigHeaders(...args),
}));

const appConfig = (endpoints: Record<string, unknown>): AppConfig =>
  ({ endpoints }) as unknown as AppConfig;

describe('resolveActivityConfig', () => {
  it('is disabled when nothing is configured', () => {
    expect(resolveActivityConfig(undefined, 'openAI').enabled).toBe(false);
    expect(resolveActivityConfig(appConfig({}), 'openAI').enabled).toBe(false);
  });

  it('reads the named endpoint block', () => {
    const config = resolveActivityConfig(
      appConfig({
        openAI: {
          activityLabel: true,
          activityModel: 'gpt-4o-mini',
          activityPrompt: 'custom',
          activityMaxPerRun: 5,
          activityCharLimit: 200,
        },
      }),
      'openAI',
    );
    expect(config).toMatchObject({
      enabled: true,
      model: 'gpt-4o-mini',
      prompt: 'custom',
      maxPerRun: 5,
      charLimit: 200,
    });
  });

  it('lets endpoints.all win over the named endpoint, like the title options', () => {
    const config = resolveActivityConfig(
      appConfig({
        all: { activityLabel: true, activityModel: 'shared-model' },
        openAI: { activityLabel: false, activityModel: 'ignored' },
      }),
      'openAI',
    );
    expect(config.enabled).toBe(true);
    expect(config.model).toBe('shared-model');
  });

  it('falls back to a custom endpoint config when the name is absent', () => {
    const config = resolveActivityConfig(appConfig({}), 'MyProxy', {
      activityLabel: true,
      activityModel: 'proxy-mini',
    });
    expect(config.enabled).toBe(true);
    expect(config.model).toBe('proxy-mini');
  });

  it('treats a missing activityLabel flag as opt-out even with other fields set', () => {
    const config = resolveActivityConfig(
      appConfig({ openAI: { activityModel: 'gpt-4o-mini' } }),
      'openAI',
    );
    expect(config.enabled).toBe(false);
    expect(config.model).toBe('gpt-4o-mini');
  });

  /** `initializeAgent` rewrites `agent.endpoint` to the backing provider, so
   *  the PUBLIC endpoint's block (`endpoints.agents`) must still be honored
   *  — it inherits every activity field via `agentsEndpointSchema`. */
  it('honors the public agents endpoint when the agent endpoint was rewritten', () => {
    const config = resolveActivityConfig(
      appConfig({ agents: { activityLabel: true, activityModel: 'agents-mini' } }),
      'openAI',
      undefined,
      'agents',
    );
    expect(config.enabled).toBe(true);
    expect(config.model).toBe('agents-mini');
  });

  it('lets the public endpoint win per field over the backing provider', () => {
    const config = resolveActivityConfig(
      appConfig({
        agents: { activityModel: 'agents-mini' },
        openAI: { activityLabel: true, activityModel: 'provider-mini', activityMaxPerRun: 3 },
      }),
      'openAI',
      undefined,
      'agents',
    );
    /** Field-wise: model from `agents`, the rest falls through to `openAI`. */
    expect(config.enabled).toBe(true);
    expect(config.model).toBe('agents-mini');
    expect(config.maxPerRun).toBe(3);
  });

  it('keeps endpoints.all above the public endpoint', () => {
    const config = resolveActivityConfig(
      appConfig({
        all: { activityModel: 'shared-model' },
        agents: { activityLabel: true, activityModel: 'agents-mini' },
      }),
      'openAI',
      undefined,
      'agents',
    );
    expect(config.model).toBe('shared-model');
  });
});

describe('resolveActivityPhaseConfig', () => {
  it('is independently opt-in and inherits activity model/endpoint tuning', () => {
    const config = resolveActivityPhaseConfig(
      appConfig({
        openAI: {
          activityLabel: true,
          activityModel: 'batch-model',
          activityEndpoint: 'anthropic',
        },
      }),
      'openAI',
    );
    expect(config).toMatchObject({
      enabled: false,
      model: 'batch-model',
      endpoint: 'anthropic',
    });
  });

  it('prefers dedicated phase settings and reuses activityCharLimit', () => {
    const config = resolveActivityPhaseConfig(
      appConfig({
        openAI: {
          activityPhaseLabel: true,
          activityPhaseModel: 'phase-model',
          activityModel: 'batch-model',
          activityPhaseEndpoint: 'google',
          activityEndpoint: 'anthropic',
          activityPhasePrompt: 'phase prompt',
          activityPhaseMaxPerRun: 3,
          activityCharLimit: 240,
        },
      }),
      'openAI',
    );
    expect(config).toEqual({
      enabled: true,
      model: 'phase-model',
      endpoint: 'google',
      prompt: 'phase prompt',
      maxPerRun: 3,
      charLimit: 240,
    });
  });
});

describe('resolveReasoningLabelConfig', () => {
  it('is independently opt-in and inherits activity model and endpoint settings', () => {
    const config = resolveReasoningLabelConfig(
      appConfig({
        openAI: {
          activityModel: 'activity-model',
          activityEndpoint: 'anthropic',
        },
      }),
      'openAI',
    );
    expect(config).toMatchObject({
      enabled: false,
      model: 'activity-model',
      endpoint: 'anthropic',
    });
  });

  it('resolves dedicated tuning field-by-field through the public endpoint', () => {
    const config = resolveReasoningLabelConfig(
      appConfig({
        all: { reasoningLabelUpdateIntervalMs: 2_000 },
        agents: {
          reasoningLabel: true,
          reasoningLabelModel: 'reasoning-model',
          reasoningLabelPrompt: 'reasoning prompt',
          reasoningLabelMinChars: 600,
        },
        openAI: {
          reasoningLabelEndpoint: 'google',
          reasoningLabelUpdateChars: 450,
          reasoningLabelMaxPerRun: 6,
        },
      }),
      'openAI',
      undefined,
      'agents',
    );
    expect(config).toEqual({
      enabled: true,
      model: 'reasoning-model',
      endpoint: 'google',
      prompt: 'reasoning prompt',
      minChars: 600,
      updateChars: 450,
      updateIntervalMs: 2_000,
      maxPerRun: 6,
    });
  });
});

describe('resolveActivityLabelModel model precedence', () => {
  const db = {} as EndpointDbMethods;
  const resolve = (endpointConfig: Record<string, unknown>) =>
    resolveActivityLabelModel({
      req: { config: appConfig({ openAI: endpointConfig }) } as unknown as ServerRequest,
      agent: { endpoint: 'openAI', model_parameters: { model: 'run-model' } },
      ids: {},
      db,
    });

  beforeEach(() => {
    mockGetOptions.mockClear();
    mockResolveConfigHeaders.mockClear();
  });

  it('uses the request tenant when resolving activity model headers', async () => {
    await resolveActivityLabelModel({
      req: {
        tenantId: 'request-tenant',
        user: { tenantId: 'stale-user-tenant' },
        config: appConfig({ openAI: { activityLabel: true } }),
      } as unknown as ServerRequest,
      agent: { endpoint: 'openAI', model_parameters: { model: 'run-model' } },
      ids: { conversationId: 'conversation-1' },
      db,
    });

    expect(mockResolveConfigHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'request-tenant' }),
    );
  });

  /** An EXPLICIT `activityModel: current_model` names the run model — a
   *  configured `titleModel` must not shadow it via the fallback chain. */
  it('resolves an explicit current_model sentinel to the run model over titleModel', async () => {
    await resolve({ activityLabel: true, activityModel: 'current_model', titleModel: 'haiku' });
    expect(mockGetOptions).toHaveBeenCalledWith(
      expect.objectContaining({ model_parameters: { model: 'run-model' } }),
    );
  });

  it('falls back to titleModel only when activityModel is absent', async () => {
    await resolve({ activityLabel: true, titleModel: 'haiku' });
    expect(mockGetOptions).toHaveBeenCalledWith(
      expect.objectContaining({ model_parameters: { model: 'haiku' } }),
    );
  });

  it('prefers an explicit activityModel over everything', async () => {
    await resolve({ activityLabel: true, activityModel: 'label-model', titleModel: 'haiku' });
    expect(mockGetOptions).toHaveBeenCalledWith(
      expect.objectContaining({ model_parameters: { model: 'label-model' } }),
    );
  });

  /** The label often runs a cheaper model than the primary generation, so
   *  primary-only options (thinking, output caps) must be stripped exactly
   *  like the title path — while proxy headers survive. */
  it('strips primary-generation options but keeps the Anthropic header carrier', async () => {
    mockGetOptions.mockResolvedValueOnce({
      llmConfig: {
        model: 'resolved',
        thinking: { type: 'enabled', budget_tokens: 4096 },
        maxOutputTokens: 8192,
        streaming: true,
        modelKwargs: { max_output_tokens: 8192, service_tier: 'flex' },
        clientOptions: { defaultHeaders: { 'x-proxy-key': 'abc' } },
      },
    } as never);
    const resolved = await resolve({ activityLabel: true, activityModel: 'label-model' });
    const clientOptions = resolved.clientOptions as Record<string, unknown>;
    expect(clientOptions.thinking).toBeUndefined();
    expect(clientOptions.maxOutputTokens).toBeUndefined();
    expect(clientOptions.streaming).toBeUndefined();
    expect(clientOptions.modelKwargs).toEqual({ service_tier: 'flex' });
    expect(clientOptions.clientOptions).toEqual({
      defaultHeaders: { 'x-proxy-key': 'abc' },
    });
  });

  /** The primary cap is not merely stripped — it is REPLACED with a small
   *  label-specific one, so a model ignoring the 4–9-word instruction (or
   *  steered by injected tool output) cannot generate and bill its
   *  provider-default output for a header. */
  it('replaces the primary maxTokens with the small label cap', async () => {
    mockGetOptions.mockResolvedValueOnce({
      llmConfig: { model: 'resolved', maxTokens: 64_000 },
    } as never);
    const resolved = await resolve({ activityLabel: true, activityModel: 'label-model' });
    expect((resolved.clientOptions as Record<string, unknown>).maxTokens).toBe(256);
  });

  /** GPT-5+ rejects `max_tokens`: the label cap must ride in modelKwargs
   *  exactly as the OpenAI builder routes primary caps. */
  it('routes the label cap into modelKwargs for GPT-5-family models', async () => {
    mockGetOptions.mockResolvedValueOnce({
      llmConfig: { model: 'gpt-5.2' },
    } as never);
    const resolved = await resolve({ activityLabel: true, activityModel: 'gpt-5.2' });
    const clientOptions = resolved.clientOptions as Record<string, unknown>;
    expect(clientOptions.maxTokens).toBeUndefined();
    expect(clientOptions.modelKwargs).toEqual({ max_completion_tokens: 256 });
  });

  /** o-series models reject `max_tokens` and get NO cap — title parity;
   *  the 200-char persistence bound still applies. */
  it('sets no cap at all for o-series reasoning models', async () => {
    mockGetOptions.mockResolvedValueOnce({
      llmConfig: { model: 'o3-mini' },
    } as never);
    const resolved = await resolve({ activityLabel: true, activityModel: 'o3-mini' });
    const clientOptions = resolved.clientOptions as Record<string, unknown>;
    expect(clientOptions.maxTokens).toBeUndefined();
    expect(clientOptions.modelKwargs).toBeUndefined();
    expect(clientOptions.maxOutputTokens).toBeUndefined();
  });

  /** The Anthropic carrier holds client CONSTRUCTION options — for
   *  user-provided base URLs that includes the SSRF-safe fetch dispatcher —
   *  so it must survive the strip even with no custom headers, and by the
   *  SAME reference. */
  it('preserves the SSRF-safe carrier even without defaultHeaders', async () => {
    const carrier = { fetchOptions: { dispatcher: { kind: 'guarded' }, redirect: 'error' } };
    mockGetOptions.mockResolvedValueOnce({
      llmConfig: { model: 'resolved', thinking: { type: 'enabled' }, clientOptions: carrier },
    } as never);
    const resolved = await resolve({ activityLabel: true, activityModel: 'label-model' });
    expect((resolved.clientOptions as Record<string, unknown>).clientOptions).toBe(carrier);
  });
});

describe('mapCollectedMetadataToUsage cache tokens', () => {
  it('carries Anthropic raw cache fields as normalized details', () => {
    const [usage] = mapCollectedMetadataToUsage([
      {
        usage: {
          input_tokens: 100,
          output_tokens: 9,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 10,
        },
      },
    ]);
    expect(usage).toEqual({
      input_tokens: 100,
      output_tokens: 9,
      input_token_details: { cache_read: 80, cache_creation: 10 },
    });
  });

  it('maps OpenAI cached_tokens to cache_read', () => {
    const [usage] = mapCollectedMetadataToUsage([
      {
        usage: {
          prompt_tokens: 50,
          completion_tokens: 7,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      },
    ]);
    expect(usage.input_token_details).toEqual({ cache_read: 40, cache_creation: undefined });
  });

  it('passes through LangChain-standard input_token_details', () => {
    const [usage] = mapCollectedMetadataToUsage([
      {
        usage_metadata: {
          input_tokens: 30,
          output_tokens: 5,
          input_token_details: { cache_read: 20, cache_creation: 4 },
        },
      },
    ]);
    expect(usage.input_token_details).toEqual({ cache_read: 20, cache_creation: 4 });
  });

  it('omits the details object entirely when no cache tokens are reported', () => {
    const [usage] = mapCollectedMetadataToUsage([
      { usage: { input_tokens: 10, output_tokens: 2 } },
    ]);
    expect(usage).toEqual({ input_tokens: 10, output_tokens: 2 });
    expect('input_token_details' in usage).toBe(false);
  });
});
