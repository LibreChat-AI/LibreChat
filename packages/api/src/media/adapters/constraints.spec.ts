import { mediaSubmissionRequestSchema, resolveMediaConfig } from 'librechat-data-provider';
import type {
  MediaVideoParameters,
  MediaImageParameters,
  MediaInput,
  MediaOperation,
} from 'librechat-data-provider';
import type { MediaProviderAdapter, MediaProviderInput } from '../provider';
import type { MediaTransportRequest } from '../transport';
import { validateMediaOffering } from '../catalog';
import { openAIImageCapabilities } from './openai';
import { createRESTMediaAdapters } from './rest';

type MediaInputRole = MediaInput['role'];

describe('provider catalog and adapter combination parity', () => {
  const config = resolveMediaConfig({ limits: { maxInputs: 50, maxOutputs: 15 } });
  type Scenario = {
    api: MediaProviderAdapter['api'];
    model: string;
    operation?: MediaOperation;
    roles?: MediaInputRole[];
    types?: string[];
    prompt?: string;
    parameters?: Partial<MediaVideoParameters & MediaImageParameters>;
  };
  const cases: Scenario[] = [
    ...(
      [
        ['minimax.videos', 'minimax/hailuo-3'],
        ['minimax.videos', 'minimax/hailuo-3-max'],
        ['seed.videos', 'bytedance/seedance-2.5'],
        ['seed.videos', 'bytedance/seedance-2.0'],
        ['seed.videos', 'bytedance/seedance-2.0-fast'],
        ['seed.videos', 'bytedance/seedance-2.0-mini'],
        ['bfl.videos', 'black-forest-labs/flux-3-video'],
        ['xai.videos', 'x-ai/grok-imagine-video-1.5'],
        ['runway.videos', 'runway/gen-4.5'],
      ] as const
    ).map(([api, model]) => ({ api, model, parameters: { durationSeconds: 5.5 } })),
    { api: 'runway.videos', model: 'runway/gen-4.5', parameters: { aspectRatio: '1:1' } },
    {
      api: 'minimax.videos',
      model: 'minimax/hailuo-2.3',
      parameters: { durationSeconds: 10, resolution: '1080P' },
    },
    {
      api: 'google.vertex.videos',
      model: 'google/veo-3.1',
      parameters: { durationSeconds: 4 },
      roles: ['reference'],
    },
    { api: 'heygen.videos', model: 'heygen/avatar-iv', roles: ['reference'] },
    {
      api: 'openai.images',
      model: 'openai/dall-e-2',
      operation: 'image.edit',
      roles: ['reference', 'reference'],
    },
    { api: 'atlas.videos', model: 'alibaba/wan-2.7', roles: ['end_frame'] },
    { api: 'atlas.videos', model: 'alibaba/wan-2.7', roles: ['start_frame', 'video'] },
    { api: 'atlas.videos', model: 'alibaba/wan-2.7', roles: ['audio', 'video'] },
    { api: 'atlas.videos', model: 'kwaivgi/kling-v3.0-pro', parameters: { durationSeconds: 30 } },
    { api: 'minimax.videos', model: 'minimax/hailuo-3', roles: ['start_frame', 'reference'] },
    {
      api: 'minimax.videos',
      model: 'minimax/hailuo-3',
      roles: Array<MediaInputRole>(10).fill('reference'),
    },
    { api: 'minimax.videos', model: 'minimax/hailuo-3', roles: ['video'], types: ['video/webm'] },
    { api: 'minimax.videos', model: 'minimax/hailuo-3', parameters: { aspectRatio: 'adaptive' } },
    { api: 'runway.videos', model: 'runway/gen-4.5', prompt: 'x'.repeat(1001) },
    { api: 'runway.videos', model: 'runway/aleph-2', roles: ['video'], types: ['video/webm'] },
    { api: 'runway.videos', model: 'runway/aleph-2', roles: ['video', 'video'] },
    { api: 'bfl.videos', model: 'black-forest-labs/flux-3-video', roles: ['end_frame'] },
    { api: 'bfl.videos', model: 'black-forest-labs/flux-3-video', roles: ['video', 'start_frame'] },
    {
      api: 'bfl.videos',
      model: 'black-forest-labs/flux-3-video',
      roles: ['video'],
      parameters: { durationSeconds: 16 },
    },
    { api: 'xai.videos', model: 'x-ai/grok-imagine-video', roles: ['start_frame', 'reference'] },
    {
      api: 'xai.videos',
      model: 'x-ai/grok-imagine-video-1.5',
      roles: ['reference'],
      parameters: { resolution: '1080p' },
    },
    {
      api: 'xai.videos',
      model: 'x-ai/grok-imagine-video-1.5',
      roles: ['end_frame'],
      parameters: { resolution: '1080p' },
    },
    {
      api: 'xai.videos',
      model: 'x-ai/grok-imagine-video-1.5',
      parameters: {
        resolution: '1080p',
        providerOptions: { reference_audios: [{ voice_id: 'voice' }] },
      },
    },
    {
      api: 'recraft.images',
      model: 'recraft/recraft-v4',
      operation: 'image.generate',
      roles: ['reference'],
      parameters: { providerOptions: { style_id: 'style' } },
    },
    {
      api: 'alibaba.images',
      model: 'qwen/qwen-image-3',
      operation: 'image.generate',
      roles: ['reference'],
      parameters: { providerOptions: { prompt_extend_mode: 'agent' } },
    },
    {
      api: 'alibaba.images',
      model: 'qwen/qwen-image-3',
      operation: 'image.generate',
      parameters: { providerOptions: { enable_thinking: true, prompt_extend: false } },
    },
    { api: 'alibaba.videos', model: 'alibaba/wan-3.0', roles: ['end_frame'] },
    { api: 'alibaba.videos', model: 'alibaba/wan-3.0', roles: ['start_frame', 'reference'] },
    {
      api: 'alibaba.videos',
      model: 'alibaba/wan-3.0',
      roles: Array<MediaInputRole>(11).fill('reference'),
    },
    {
      api: 'alibaba.videos',
      model: 'alibaba/wan-3.0',
      roles: Array<MediaInputRole>(6).fill('video'),
    },
    { api: 'seed.videos', model: 'bytedance/seedance-2.0', roles: ['end_frame'] },
    { api: 'seed.videos', model: 'bytedance/seedance-2.0', roles: ['start_frame', 'reference'] },
    {
      api: 'seed.videos',
      model: 'bytedance/seedance-2.0',
      roles: Array<MediaInputRole>(10).fill('reference'),
    },
    {
      api: 'seed.videos',
      model: 'bytedance/seedance-2.5',
      roles: Array<MediaInputRole>(11).fill('video'),
    },
    {
      api: 'seed.videos',
      model: 'bytedance/seedance-2.5',
      parameters: { providerOptions: { omni_reference_task_type: 'edit' } },
    },
    {
      api: 'seed.images',
      model: 'bytedance-seed/seedream-4.5',
      operation: 'image.generate',
      roles: Array<MediaInputRole>(14).fill('reference'),
      parameters: { count: 2 },
    },
    {
      api: 'seed.images',
      model: 'bytedance-seed/seedream-5-0-pro',
      operation: 'image.generate',
      parameters: { background: 'transparent', format: 'png' },
    },
    {
      api: 'heygen.videos',
      model: 'heygen/avatar-iv',
      roles: ['reference', 'reference'],
      parameters: { providerOptions: { voice_id: 'voice' } },
    },
  ];
  function scenario(item: Scenario) {
    const adapter = createRESTMediaAdapters().find(({ api }) => api === item.api)!;
    const profile =
      adapter.catalog!(config).find(({ modelId }) => modelId === item.model) ??
      (item.api === 'openai.images'
        ? {
            modelId: item.model,
            modelName: item.model,
            capabilities: openAIImageCapabilities(item.model, config),
          }
        : undefined);
    if (!profile) throw new Error(`Missing profile: ${item.model}`);
    const inputs: MediaProviderInput[] = (item.roles ?? []).map((role, index) => ({
      role,
      file_id: `reference-${index}`,
      data: Buffer.from('reference'),
      type: item.types?.[index] ?? (role === 'video' ? 'video/mp4' : 'image/png'),
      ...(role === 'video' ? { sourceURL: 'https://public.example/reference.mp4' } : {}),
    }));
    const request = mediaSubmissionRequestSchema.parse({
      clientRequestId: 'conditional-request',
      operation: item.operation ?? 'video.generate',
      prompt: item.prompt ?? 'A forest',
      parameters: item.parameters ?? {},
      inputs: inputs.map(({ role, file_id, sourceURL }) => ({ role, file_id, sourceURL })),
      selection: { connectionId: 'direct', modelId: item.model, catalogVersion: 'current' },
    });
    return {
      adapter,
      inputs,
      request: {
        ...request,
        inputs: inputs.map(({ data, ...input }) => ({ ...input, bytes: data.length })),
      },
      offering: {
        ...profile,
        api: item.api,
        connectionId: 'direct',
        connectionName: 'Direct',
        available: true,
      },
    };
  }
  it.each(cases)('rejects unsupported $model inputs/settings in shared admission', async (item) => {
    const { adapter, inputs, request, offering } = scenario(item);
    expect(() => validateMediaOffering(request, offering, config.limits)).toThrow();
    const json = jest.fn();
    const stream = jest.fn();
    await expect(
      adapter.submit(request, inputs, {
        config,
        jobId: 'job',
        signal: new AbortController().signal,
        connection: {
          id: 'direct',
          api: item.api,
          binding: 'account',
          baseURL: 'https://provider.example/v1',
          headers: {},
        },
        transport: { json, stream },
      }),
    ).rejects.toMatchObject({ certainty: 'rejected' });
    expect(json).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });
  it.each<Scenario>([
    { api: 'minimax.videos', model: 'minimax/hailuo-3', roles: ['end_frame'] },
    { api: 'atlas.videos', model: 'alibaba/wan-2.7', roles: ['video', 'end_frame'] },
    {
      api: 'bfl.videos',
      model: 'black-forest-labs/flux-3-video',
      roles: ['start_frame', 'end_frame'],
      parameters: { durationSeconds: 20 },
    },
    {
      api: 'bfl.videos',
      model: 'black-forest-labs/flux-3-video',
      roles: ['video'],
      parameters: { durationSeconds: 15 },
    },
    {
      api: 'xai.videos',
      model: 'x-ai/grok-imagine-video-1.5',
      roles: ['start_frame'],
      parameters: { resolution: '1080p' },
    },
    {
      api: 'xai.videos',
      model: 'x-ai/grok-imagine-video-1.5',
      roles: ['reference'],
      parameters: { resolution: '720p' },
    },
    {
      api: 'recraft.images',
      model: 'recraft/recraft-v4',
      operation: 'image.generate',
      parameters: { providerOptions: { style_id: 'style' } },
    },
    { api: 'alibaba.videos', model: 'alibaba/wan-3.0', roles: ['start_frame', 'end_frame'] },
    {
      api: 'seed.videos',
      model: 'bytedance/seedance-2.0',
      roles: Array<MediaInputRole>(9).fill('reference'),
    },
    {
      api: 'seed.images',
      model: 'bytedance-seed/seedream-4.5',
      operation: 'image.generate',
      roles: Array<MediaInputRole>(13).fill('reference'),
      parameters: { count: 2 },
    },
    {
      api: 'heygen.videos',
      model: 'heygen/avatar-iv',
      roles: ['reference'],
      parameters: { providerOptions: { voice_id: 'voice' } },
    },
  ])('preserves supported $model combinations at the boundary', (item) => {
    const { request, offering } = scenario(item);
    expect(() => validateMediaOffering(request, offering, config.limits)).not.toThrow();
  });

  it('applies Atlas catalog defaults when dispatch receives omitted optional controls', async () => {
    const item: Scenario = { api: 'atlas.videos', model: 'kwaivgi/kling-v3.0-pro' };
    const { adapter, request, inputs } = scenario(item);
    const calls: MediaTransportRequest[] = [];
    await adapter.submit(request, inputs, {
      config,
      jobId: 'job',
      signal: new AbortController().signal,
      connection: {
        id: 'direct',
        api: item.api,
        binding: 'account',
        baseURL: 'https://provider.example/v1',
        headers: {},
      },
      transport: {
        async json(input, schema) {
          calls.push(input);
          return schema.parse({ data: { id: 'task', status: 'processing' } });
        },
        stream: jest.fn(),
      },
    });
    expect(JSON.parse(String(calls[0].body))).toMatchObject({ duration: 5, aspect_ratio: '16:9' });
  });

  it.each<NonNullable<MediaImageParameters['providerOptions']>>([
    { cfg_scale: 'high' },
    { multi_shot: 'yes' },
    { elements: 'unsupported' },
  ])(
    'rejects malformed Atlas option types before any upload or generation',
    async (providerOptions) => {
      const item: Scenario = {
        api: 'atlas.videos',
        model: 'kwaivgi/kling-v3.0-pro',
        roles: ['start_frame'],
        parameters: { providerOptions },
      };
      const { adapter, request, inputs } = scenario(item);
      const json = jest.fn();
      await expect(
        adapter.submit(request, inputs, {
          config,
          jobId: 'job',
          signal: new AbortController().signal,
          connection: {
            id: 'direct',
            api: item.api,
            binding: 'account',
            baseURL: 'https://provider.example/v1',
            headers: {},
          },
          transport: { json, stream: jest.fn() },
        }),
      ).rejects.toMatchObject({ certainty: 'rejected' });
      expect(json).not.toHaveBeenCalled();
    },
  );
});
