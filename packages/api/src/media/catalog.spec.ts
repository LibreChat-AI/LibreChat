import { z } from 'zod';
import {
  FileSources,
  resolveMediaConfig,
  mediaCatalogSchema,
  mediaSubmissionRequestSchema,
} from 'librechat-data-provider';
import type { MediaIntegration } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { MediaCatalogCache, MediaCatalogCacheEntry } from './catalogCache';
import type { MediaTransport, MediaTransportRequest } from './transport';
import type { MediaConnection, MediaProviderContext } from './provider';
import { createMediaCatalog, selectMediaRoute, validateMediaOffering } from './catalog';
import { createMediaCredentialResolver } from './credentials';
import publicCatalog from './__fixtures__/openrouter.json';
import { createRESTMediaAdapters } from './adapters/rest';

const imageIntegration: MediaIntegration = {
  id: 'images',
  api: 'openrouter.images',
  endpointRef: { kind: 'custom', name: 'OpenRouter' },
  catalog: { kind: 'configured', models: ['google/image'] },
  operations: ['image.generate', 'image.edit'],
};
const videoIntegration: MediaIntegration = {
  id: 'videos',
  api: 'openrouter.videos',
  endpointRef: { kind: 'custom', name: 'OpenRouter' },
  catalog: {
    kind: 'configured',
    models: [
      'google/video',
      'black-forest-labs/flux-video-edit',
      'black-forest-labs/flux-video-upscale',
      'heygen/avatar-iv',
    ],
  },
  operations: ['video.generate'],
};
const imageEndpoints = {
  id: 'google/image',
  endpoints: [
    {
      provider_tag: 'google-ai-studio',
      supported_parameters: {
        size: { type: 'enum', values: ['1024x1024'] },
        n: { type: 'range', min: 1, max: 10 },
        quality: { type: 'enum', values: ['high'] },
        input_references: { type: 'range', min: 0, max: 3 },
      },
    },
    {
      provider_tag: 'google-vertex/global',
      supported_parameters: {
        resolution: { type: 'enum', values: ['1K', '2K'] },
        n: { type: 'enum', values: [1, 2, 4] },
        input_references: { type: 'range', min: 0, max: 14 },
        seed: { type: 'boolean' },
        output_format: { type: 'enum', values: ['png', 'webp'] },
      },
    },
  ],
};
const videoModels = {
  data: [
    {
      id: 'google/video',
      supported_durations: [4, 6, 8],
      supported_resolutions: ['720p', '1080p'],
      supported_frame_images: ['first_frame', 'last_frame'],
      generate_audio: true,
    },
    {
      id: 'black-forest-labs/flux-video-edit',
      supported_durations: null,
      supported_resolutions: null,
    },
    {
      id: 'black-forest-labs/flux-video-upscale',
      supported_durations: null,
      upscale_factor: { min: 1.5, max: 3 },
    },
    { id: 'heygen/avatar-iv', supported_durations: null, supported_resolutions: ['720p'] },
  ],
};

function fixtureTransport(response: (request: MediaTransportRequest) => string | Promise<string>) {
  const calls: MediaTransportRequest[] = [];
  const transport: MediaTransport = {
    async json<T>(request: MediaTransportRequest, schema: z.ZodType<T>): Promise<T> {
      calls.push(request);
      return schema.parse(JSON.parse(await response(request)));
    },
    async stream() {
      throw new Error('Unexpected download');
    },
  };
  return { calls, transport };
}

function imageTransport(
  response: (request: MediaTransportRequest) => string | Promise<string>,
  models = ['google/image'],
) {
  return fixtureTransport((request) =>
    new URL(request.url).pathname.endsWith('/images/models')
      ? JSON.stringify({ data: models.map((id) => ({ id, name: id })) })
      : response(request),
  );
}

function videoTransport(response: () => string) {
  return fixtureTransport((request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/videos/models')) return response();
    if (url.searchParams.get('output_modalities') === 'video') {
      const { data } = z
        .object({ data: z.array(z.object({ id: z.string() })) })
        .parse(JSON.parse(response()));
      return JSON.stringify({
        data: data.map(({ id }) => ({ id, architecture: { input_modalities: ['text', 'image'] } })),
      });
    }
    if (url.pathname.endsWith('/endpoints'))
      return JSON.stringify({
        data: { endpoints: [{ tag: 'fixture-provider', provider_name: 'Fixture provider' }] },
      });
    throw new Error(`Unexpected discovery URL: ${request.url}`);
  });
}

function publicTransport(override?: (request: MediaTransportRequest) => string | undefined) {
  return fixtureTransport((request) => {
    const overridden = override?.(request);
    if (overridden !== undefined) return overridden;
    const url = new URL(request.url);
    const path = url.pathname.replace('/api/v1/', '');
    if (path === 'images/models') return JSON.stringify(publicCatalog.images);
    if (path === 'videos/models') return JSON.stringify(publicCatalog.videos);
    if (path === 'models' && url.searchParams.get('output_modalities') === 'video')
      return JSON.stringify(publicCatalog.generalVideos);
    const image = publicCatalog.imageEndpoints.find(
      (entry) => path === `images/models/${entry.id}/endpoints`,
    );
    if (image) return JSON.stringify(image);
    const video = publicCatalog.videoEndpoints.find(
      (entry) => path === `models/${entry.id}/endpoints`,
    );
    if (video) return JSON.stringify({ data: video.data });
    throw new Error(`Unexpected public catalog URL: ${request.url}`);
  });
}

const scope = (ownerId: string, tenantId: string | null = null) => ({ ownerId, tenantId });
function connection(integration: MediaIntegration): MediaConnection {
  return {
    id: integration.id,
    api: integration.api,
    baseURL: 'https://openrouter.example/api/v1',
    headers: { Authorization: 'Bearer fixture' },
    binding: 'revision',
  };
}

describe('media catalog provider conformance', () => {
  it('makes configured OpenAI-compatible deployments available without remote discovery', async () => {
    const { transport, calls } = fixtureTransport(() => {
      throw new Error('Native profiles do not fetch a remote catalog');
    });
    const config = resolveMediaConfig({
      enabled: true,
      integrations: [
        {
          id: 'compatible',
          api: 'openai.images',
          endpointRef: { kind: 'direct', apiKey: 'fixture' },
          catalog: { kind: 'configured', models: ['dall-e-3', 'FLUX.1-Kontext-pro'] },
          operations: ['image.generate', 'image.edit'],
        },
      ],
    });
    const catalog = createMediaCatalog({
      transport,
      adapters: createRESTMediaAdapters(),
      now: Date.now,
    });
    const snapshot = await catalog.read(
      config,
      async (integration) => connection(integration),
      scope('owner'),
    );
    expect(
      snapshot.catalog.offerings.map(({ available, capabilities }) => ({
        available,
        operations: capabilities.map(({ operation }) => operation),
      })),
    ).toEqual([
      { available: true, operations: ['image.generate'] },
      { available: true, operations: ['image.generate'] },
    ]);
    expect(calls).toHaveLength(0);
  });

  const adapters = createRESTMediaAdapters();
  const config = resolveMediaConfig({
    enabled: true,
    integrations: [imageIntegration],
    limits: { maxOutputs: 3, maxInputs: 5 },
  });
  const request = (parameters = {}) =>
    mediaSubmissionRequestSchema.parse({
      clientRequestId: 'request',
      operation: 'image.generate',
      prompt: 'A forest',
      parameters,
      selection: { connectionId: 'images', modelId: 'google/image', catalogVersion: 'v1' },
    });

  it('isolates catalog discovery and cached results by effective address policy', async () => {
    const fixture = imageTransport(() => JSON.stringify(imageEndpoints));
    const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
    const allowed = async (integration: MediaIntegration) => ({
      ...connection(integration),
      allowedAddresses: ['provider.example:443'],
    });
    await catalog.read(config, allowed, scope('owner-one'));
    const first = fixture.calls.length;
    expect(
      fixture.calls.every((call) => call.allowedAddresses?.includes('provider.example:443')),
    ).toBe(true);
    await catalog.read(
      config,
      async (integration) => ({ ...connection(integration), allowedAddresses: [] }),
      scope('owner-two'),
    );
    expect(fixture.calls.length).toBe(first * 2);
    expect(fixture.calls.slice(first).every((call) => call.allowedAddresses?.length === 0)).toBe(
      true,
    );
    await catalog.read(config, allowed, scope('owner-one'));
    expect(fixture.calls).toHaveLength(first * 2);
  });

  it('shares discovery for a shared credential and separates user-specific connections', async () => {
    const fixture = imageTransport(() => JSON.stringify(imageEndpoints));
    const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
    const shared = async (integration: MediaIntegration) => connection(integration);
    await catalog.read(config, shared, scope('owner-one', 'tenant'));
    const first = fixture.calls.length;
    expect(first).toBeGreaterThan(0);
    await catalog.read(config, shared, scope('owner-two', 'tenant'));
    expect(fixture.calls).toHaveLength(first);
    await catalog.read(
      config,
      async (integration) => ({
        ...connection(integration),
        headers: { Authorization: 'Bearer fixture', 'X-User': 'owner-three' },
      }),
      scope('owner-three', 'tenant'),
    );
    expect(fixture.calls).toHaveLength(first * 2);
  });

  it('uses the official endpoint envelope and one policy-compatible parameter intersection', async () => {
    const fixture = imageTransport(() => JSON.stringify(imageEndpoints));
    const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
    const result = await catalog.read(
      config,
      async (integration) => ({
        ...connection(integration),
        routing: { only: ['google-vertex'], ignore: ['google-ai-studio'], zdr: true },
      }),
      scope('owner'),
    );
    const offering = result.catalog.offerings[0];
    expect(offering.available).toBe(true);
    expect(result.resolved.get('images:google/image')?.providerTag).toBe('google-vertex/global');
    expect(offering.capabilities[0].controls).toMatchObject({
      count: { min: 1, max: 3, values: [1, 2] },
      resolution: { values: ['1K', '2K'] },
      seed: { min: 0 },
    });
    expect(offering.capabilities[0].inputs.max).toBe(5);
    expect(() =>
      validateMediaOffering(request({ resolution: '2K', seed: 0, count: 2 }), offering),
    ).not.toThrow();
    expect(() => validateMediaOffering(request({ quality: 'high' }), offering)).toThrow();
    expect(() => validateMediaOffering(request({ size: '1024x1024' }), offering)).toThrow();
    expect(() => validateMediaOffering(request({ count: 3 }), offering)).toThrow();
    expect(fixture.calls[0].url).toContain('/images/models/google/image/endpoints');
    expect(JSON.stringify(result.catalog)).not.toContain('Bearer');
    expect(offering.routes?.map((route) => route.providerTag)).toEqual(['google-vertex/global']);
    expect(JSON.stringify(result.catalog)).not.toContain('revision');
  });

  it('omits disabled connections and their key setup before resolving credentials or discovering models', async () => {
    const fixture = imageTransport(() => JSON.stringify(imageEndpoints));
    const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
    const resolve = jest.fn(async (integration: MediaIntegration) => connection(integration));
    const describeKey = jest.fn((integration: MediaIntegration) => ({
      keyName: integration.id,
      encoding: 'apiKey' as const,
      userProvideURL: false,
    }));
    const enabled = await catalog.read(config, resolve, scope('owner'), describeKey);
    expect(enabled.catalog.integrations?.[0].userKey).toBeDefined();
    expect(enabled.catalog.offerings).toHaveLength(1);
    resolve.mockClear();
    describeKey.mockClear();
    fixture.calls.length = 0;
    const excluded = await catalog.read(
      { ...config, integrations: [{ ...imageIntegration, enabled: false }] },
      resolve,
      scope('owner'),
      describeKey,
    );
    expect(excluded.catalog.integrations).toEqual([]);
    expect(excluded.catalog.offerings).toEqual([]);
    expect(excluded.resolved.size).toBe(0);
    expect(excluded.catalog.version).not.toBe(enabled.catalog.version);
    expect(resolve).not.toHaveBeenCalled();
    expect(describeKey).not.toHaveBeenCalled();
    expect(fixture.calls).toEqual([]);
    const restored = await catalog.read(
      { ...config, integrations: [{ ...imageIntegration, enabled: true }] },
      resolve,
      scope('owner'),
      describeKey,
    );
    expect(restored.catalog.offerings).toHaveLength(1);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('honors ordering without routing outside a no-fallback policy', async () => {
    const fixture = imageTransport(() => JSON.stringify(imageEndpoints));
    const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
    const result = await catalog.read(
      config,
      async (integration) => ({
        ...connection(integration),
        routing: { order: ['unavailable', 'google-vertex'], allow_fallbacks: false },
      }),
      scope('owner'),
    );
    expect(result.resolved.get('images:google/image')?.providerTag).toBe('google-vertex/global');
    const denied = await catalog.read(
      config,
      async (integration) => ({
        ...connection(integration),
        routing: { only: ['another-provider'] },
      }),
      scope('owner'),
    );
    expect(denied.catalog.offerings[0].available).toBe(false);
  });

  it.each([{ values: ['1K', '2K', '4K'] }, { values: ['1K'] }])(
    'does not advertise Seedream resolutions rejected by the live provider ($values)',
    async ({ values }) => {
      const modelId = 'bytedance-seed/seedream-4.5';
      const fixture = imageTransport(
        () =>
          JSON.stringify({
            id: modelId,
            endpoints: [
              {
                provider_tag: 'seed',
                supported_parameters: {
                  resolution: { type: 'enum', values },
                  input_references: { type: 'range', min: 0, max: 14 },
                },
              },
            ],
          }),
        [modelId],
      );
      const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
      const result = await catalog.read(
        {
          ...config,
          integrations: [
            { ...imageIntegration, catalog: { kind: 'configured', models: [modelId] } },
          ],
        },
        async (integration) => connection(integration),
        scope('owner'),
      );
      const offering = result.catalog.offerings[0];
      expect(offering.available).toBe(values.length > 1);
      for (const capability of offering.capabilities) {
        expect(capability.controls.resolution?.values).toEqual(['2K', '4K']);
      }
      const submission = {
        ...request({ resolution: '1K' }),
        selection: {
          connectionId: 'images',
          modelId,
          catalogVersion: result.catalog.version,
        },
      };
      expect(() => validateMediaOffering(submission, offering)).toThrow();
      if (offering.available)
        expect(() =>
          validateMediaOffering(
            { ...submission, parameters: { ...submission.parameters, resolution: '2K' } },
            offering,
          ),
        ).not.toThrow();
    },
  );

  it.each([
    {
      id: 'google/image',
      endpoints: [
        { provider_tag: null, supported_parameters: {} },
        { provider_tag: null, supported_parameters: {} },
      ],
    },
    { id: 'another-model', endpoints: imageEndpoints.endpoints },
    { data: imageEndpoints.endpoints },
  ])('does not offer ambiguous, mismatched, or malformed discovery', async (payload) => {
    const fixture = imageTransport(() => JSON.stringify(payload));
    const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
    const result = await catalog.read(
      config,
      async (integration) => connection(integration),
      scope('owner'),
    );
    expect(result.catalog.offerings[0].available).toBe(false);
  });

  it('admits video generation, edit, upscale, and avatar workflows with required inputs', async () => {
    const fixture = videoTransport(() => JSON.stringify(videoModels));
    const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
    const videoConfig = resolveMediaConfig({ enabled: true, integrations: [videoIntegration] });
    const result = await catalog.read(
      videoConfig,
      async (integration) => connection(integration),
      scope('owner'),
    );
    expect(result.catalog.offerings.map((offering) => offering.available)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    const videoRequest = mediaSubmissionRequestSchema.parse({
      clientRequestId: 'video',
      operation: 'video.generate',
      prompt: 'A forest',
      selection: { connectionId: 'videos', modelId: 'google/video', catalogVersion: 'v1' },
      parameters: { durationSeconds: 5 },
    });
    expect(() => validateMediaOffering(videoRequest, result.catalog.offerings[0])).toThrow();
    expect(
      result.catalog.offerings.slice(1).map((offering) => offering.capabilities[0].workflow),
    ).toEqual(['edit', 'upscale', 'avatar']);
    expect(result.catalog.offerings[1].capabilities[0].inputs.requiredRoles).toEqual(['video']);
    expect(result.catalog.offerings[3].capabilities[0].inputs.requiredRoles).toEqual([
      'reference',
      'audio',
    ]);
  });

  it('keeps video offerings available when optional capability flags are null', async () => {
    const fixture = videoTransport(() =>
      JSON.stringify({
        data: [
          ...videoModels.data.map((model) => ({ ...model, generate_audio: null, seed: null })),
          { id: 'outside/allowlist', generate_audio: null, seed: null },
        ],
      }),
    );
    const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
    const videoConfig = resolveMediaConfig({ enabled: true, integrations: [videoIntegration] });
    const result = await catalog.read(
      videoConfig,
      async (integration) => connection(integration),
      scope('owner'),
    );

    expect(result.catalog.offerings.map((offering) => offering.available)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    const capability = result.catalog.offerings[0].capabilities[0];
    if (capability.operation !== 'video.generate') {
      throw new Error('Expected video capabilities');
    }
    expect(capability.controls.durationSeconds?.values).toEqual([4, 6, 8]);
    expect(capability.controls.audio).toBeUndefined();
    expect(capability.controls.seed).toBeUndefined();
  });

  it.each(['openai/sora-2', 'openai/sora-2-pro'])(
    'does not expose an audio toggle for %s because its audio is always enabled',
    async (modelId) => {
      const fixture = videoTransport(() =>
        JSON.stringify({ data: [...videoModels.data, { ...videoModels.data[0], id: modelId }] }),
      );
      const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
      const videoConfig = resolveMediaConfig({
        enabled: true,
        integrations: [
          {
            ...videoIntegration,
            catalog: { kind: 'configured', models: [modelId, 'google/video'] },
          },
        ],
      });
      const result = await catalog.read(
        videoConfig,
        async (integration) => connection(integration),
        scope('owner'),
      );
      const offering = result.catalog.offerings[0];
      expect(offering.available).toBe(true);
      expect(offering.capabilities[0].controls).not.toHaveProperty('audio', true);
      expect(result.catalog.offerings[1].capabilities[0]).toMatchObject({
        controls: { audio: true },
      });
      const videoRequest = mediaSubmissionRequestSchema.parse({
        clientRequestId: 'sora-audio',
        operation: 'video.generate',
        prompt: 'A forest',
        selection: { connectionId: 'videos', modelId, catalogVersion: 'v1' },
        parameters: { durationSeconds: 4 },
      });
      expect(() => validateMediaOffering(videoRequest, offering)).not.toThrow();
      const audioRequest = mediaSubmissionRequestSchema.parse({
        ...videoRequest,
        parameters: { ...videoRequest.parameters, audio: false },
      });
      expect(() => validateMediaOffering(audioRequest, offering)).toThrow();
    },
  );

  it.each([
    { zdr: true },
    { data_collection: 'deny' as const },
    { only: ['google'] },
    { allow_fallbacks: false },
  ])('blocks video when required routing/privacy cannot be honored: %j', async (routing) => {
    const fixture = videoTransport(() => JSON.stringify(videoModels));
    const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
    const videoConfig = resolveMediaConfig({ enabled: true, integrations: [videoIntegration] });
    const result = await catalog.read(
      videoConfig,
      async (integration) => ({ ...connection(integration), routing }),
      scope('owner'),
    );
    expect(result.catalog.offerings.every((offering) => !offering.available)).toBe(true);
  });

  it('evicts least recently used credential-bound entries and expires cached capabilities', async () => {
    let time = 0;
    const fixture = imageTransport(() => JSON.stringify(imageEndpoints));
    const catalog = createMediaCatalog({ ...fixture, adapters, now: () => time });
    const bounded = resolveMediaConfig({
      ...config,
      catalog: { ...config.catalog, maxCacheEntries: 2 },
    });
    const read = (binding: string) =>
      catalog.read(
        bounded,
        async (integration) => ({ ...connection(integration), binding }),
        scope('owner'),
      );
    await read('a');
    await read('b');
    await read('a');
    await read('c');
    await read('b');
    expect(fixture.calls).toHaveLength(4);
    time = config.catalog.refreshMs + 1;
    await read('b');
    expect(fixture.calls).toHaveLength(5);
  });

  it('shares cached offerings across catalog instances without crossing bindings or expiry', async () => {
    let time = 0;
    const entries = new Map<string, MediaCatalogCacheEntry>();
    const shared: MediaCatalogCache = {
      get: async (key) => entries.get(key),
      set: jest.fn(async (key, entry) => {
        entries.set(key, entry);
      }),
    };
    const fixture = imageTransport(() => JSON.stringify(imageEndpoints));
    const first = createMediaCatalog({ ...fixture, adapters, cache: shared, now: () => time });
    const second = createMediaCatalog({ ...fixture, adapters, cache: shared, now: () => time });
    await first.read(config, async (integration) => connection(integration), scope('owner'));
    await second.read(config, async (integration) => connection(integration), scope('owner'));
    expect(fixture.calls).toHaveLength(1);
    expect(shared.set).toHaveBeenLastCalledWith(
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.objectContaining({ expires: config.catalog.refreshMs }),
      config.catalog.refreshMs,
    );
    await second.read(
      config,
      async (integration) => ({ ...connection(integration), binding: 'other' }),
      scope('owner'),
    );
    expect(fixture.calls).toHaveLength(2);
    await second.read(
      config,
      async (integration) => connection(integration),
      scope('owner', 'other-tenant'),
    );
    expect(fixture.calls).toHaveLength(3);
    time = config.catalog.refreshMs + 1;
    await second.read(config, async (integration) => connection(integration), scope('owner'));
    expect(fixture.calls).toHaveLength(4);
  });

  it('fetches only listed image endpoint documents and uses the index for discovery', async () => {
    const fixture = imageTransport(() => JSON.stringify(imageEndpoints));
    const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
    await catalog.read(config, async (integration) => connection(integration), scope('owner'));
    expect(fixture.calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/api/v1/images/models/google/image/endpoints',
    ]);
    await catalog.read(
      resolveMediaConfig({
        ...config,
        integrations: [
          {
            ...imageIntegration,
            catalog: { kind: 'discovered', allModels: true, allowModels: [], excludeModels: [] },
          },
        ],
      }),
      async (integration) => connection(integration),
      scope('owner'),
    );
    expect(fixture.calls.map((call) => new URL(call.url).pathname)).toContain(
      '/api/v1/images/models',
    );
  });

  it('shares in-flight reads and bounds discovery concurrency across integrations', async () => {
    let active = 0;
    let peak = 0;
    const fixture = fixtureTransport(async (request) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      return JSON.stringify(
        new URL(request.url).pathname.endsWith('/images/models')
          ? { data: [{ id: 'google/image' }] }
          : imageEndpoints,
      );
    });
    const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
    const bounded = resolveMediaConfig({
      enabled: true,
      catalog: { maxConcurrentRequests: 2 },
      integrations: ['a', 'b', 'c'].map((id) => ({ ...imageIntegration, id })),
    });
    const resolve = async (integration: MediaIntegration) => connection(integration);
    await Promise.all([
      catalog.read(bounded, resolve, scope('owner')),
      catalog.read(bounded, resolve, scope('owner')),
    ]);
    expect(fixture.calls).toHaveLength(3);
    expect(peak).toBe(2);
  });
});

describe('OpenRouter representative public media catalog', () => {
  const adapters = createRESTMediaAdapters();
  const config = resolveMediaConfig({
    enabled: true,
    integrations: [
      { ...imageIntegration, catalog: { kind: 'discovered', allModels: true } },
      { ...videoIntegration, catalog: { kind: 'discovered', allModels: true } },
    ],
  });
  const resolve = async (integration: MediaIntegration) => connection(integration);

  it('discovers the representative image/video catalog and preserves unavailable Muse without exposing credentials', async () => {
    const fixture = publicTransport();
    const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
    const result = await catalog.read(config, resolve, scope('owner'));
    expect(() => mediaCatalogSchema.parse(result.catalog)).not.toThrow();
    expect(result.catalog.offerings.map((offering) => offering.modelId)).toEqual([
      ...publicCatalog.images.data.map((model) => model.id),
      ...publicCatalog.videos.data.map((model) => model.id),
    ]);
    expect(result.catalog.offerings.filter((offering) => offering.available)).toHaveLength(19);
    expect(result.catalog.offerings.filter((offering) => !offering.available)).toEqual([
      expect.objectContaining({
        modelId: 'meta/muse-image',
        unavailableReason: 'unsupported',
        capabilities: [],
      }),
    ]);
    expect(fixture.calls).toHaveLength(23);
    expect(fixture.calls.filter((call) => call.url.endsWith('/endpoints'))).toHaveLength(20);
    expect(fixture.calls.every((call) => !call.method || call.method === 'GET')).toBe(true);
    expect(JSON.stringify(result.catalog)).not.toMatch(
      /Bearer fixture|revision|endpointRef|apiKey/,
    );
    expect(result.catalog.integrations?.every((integration) => integration.available)).toBe(true);
  });

  it('exposes the six SVG models and enforces required Recraft Styles references', async () => {
    const fixture = publicTransport();
    const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
    const result = await catalog.read(config, resolve, scope('owner'));
    const vectors = result.catalog.offerings.filter((offering) =>
      offering.capabilities.some(
        (capability) =>
          'format' in capability.controls && capability.controls.format?.values.includes('svg'),
      ),
    );
    expect(vectors).toHaveLength(6);
    expect(
      vectors.every((offering) => offering.available && offering.modelId.startsWith('recraft/')),
    ).toBe(true);
    const styles = result.catalog.offerings.filter((offering) =>
      offering.modelId.startsWith('recraft/recraft-v4-styles'),
    );
    expect(styles).toHaveLength(4);
    for (const offering of styles) {
      const submission = mediaSubmissionRequestSchema.parse({
        clientRequestId: 'styles',
        operation: 'image.generate',
        prompt: 'A forest in this style',
        selection: {
          connectionId: offering.connectionId,
          modelId: offering.modelId,
          catalogVersion: result.catalog.version,
        },
      });
      expect(() => validateMediaOffering(submission, offering)).toThrow();
      expect(() =>
        validateMediaOffering(
          { ...submission, inputs: [{ role: 'reference', file_id: 'style-reference' }] },
          offering,
        ),
      ).not.toThrow();
    }
  });

  it('keeps image route capabilities separate and rejects values that only a different route supports', async () => {
    const fixture = imageTransport(() => JSON.stringify(imageEndpoints));
    const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
    const limited = resolveMediaConfig({
      enabled: true,
      integrations: [imageIntegration],
      limits: { maxInputs: 5, maxOutputs: 3 },
    });
    const result = await catalog.read(limited, resolve, scope('owner'));
    const selected = result.resolved.get('images:google/image');
    if (!selected) throw new Error('Missing discovered image');
    expect(selected.offering.routes?.map((route) => route.providerTag)).toEqual([
      'google-ai-studio',
      'google-vertex/global',
    ]);
    const vertex = selectMediaRoute(selected, 'google-vertex/global');
    const request = mediaSubmissionRequestSchema.parse({
      clientRequestId: 'route',
      operation: 'image.generate',
      prompt: 'A forest',
      selection: {
        connectionId: 'images',
        modelId: 'google/image',
        catalogVersion: result.catalog.version,
        providerTag: 'google-vertex/global',
      },
      parameters: { count: 2, resolution: '2K' },
    });
    expect(vertex.providerTag).toBe('google-vertex/global');
    expect(() => validateMediaOffering(request, vertex.offering)).not.toThrow();
    expect(() => validateMediaOffering(request, selected.offering)).toThrow();
    expect(() =>
      validateMediaOffering(
        { ...request, operation: 'image.generate', parameters: { count: 2, quality: 'high' } },
        vertex.offering,
      ),
    ).toThrow();
    expect(() => selectMediaRoute(selected, 'unpublished/provider')).toThrow();
  });

  it('pins a selected public image route and scopes its allowed options without relaxing privacy policy', async () => {
    const modelId = 'google/gemini-2.5-flash-image';
    const fixture = publicTransport((request) =>
      request.url.endsWith('/images')
        ? JSON.stringify({ data: [{ b64_json: 'YQ==' }] })
        : undefined,
    );
    const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
    const limited = resolveMediaConfig({
      enabled: true,
      integrations: [{ ...imageIntegration, catalog: { kind: 'configured', models: [modelId] } }],
    });
    const routing = { only: ['google-vertex'], zdr: true, data_collection: 'deny' as const };
    const result = await catalog.read(
      limited,
      async (integration) => ({ ...connection(integration), routing }),
      scope('owner'),
    );
    const discovered = result.resolved.get(`images:${modelId}`);
    if (!discovered) throw new Error('Missing Google offering');
    const selected = selectMediaRoute(discovered, 'google-vertex/global');
    expect(selected.offering.routes?.map((route) => route.providerTag)).toEqual([
      'google-vertex/global',
    ]);
    const submission = mediaSubmissionRequestSchema.parse({
      clientRequestId: 'pinned',
      operation: 'image.generate',
      prompt: 'A forest',
      selection: {
        connectionId: 'images',
        modelId,
        catalogVersion: result.catalog.version,
        providerTag: selected.providerTag,
      },
      parameters: { providerOptions: { cachedContent: 'cachedContents/fixture' } },
    });
    expect(() =>
      validateMediaOffering(submission, selected.offering, limited.limits),
    ).not.toThrow();
    expect(() =>
      validateMediaOffering(
        { ...submission, parameters: { count: 1, providerOptions: { unpublished: true } } },
        selected.offering,
        limited.limits,
      ),
    ).toThrow();
    const adapter = adapters.find((entry) => entry.api === 'openrouter.images');
    if (!adapter) throw new Error('Missing OpenRouter image adapter');
    await adapter.submit(submission, [], {
      transport: fixture.transport,
      config: limited,
      jobId: 'server-job',
      signal: new AbortController().signal,
      connection: { ...connection(imageIntegration), routing },
      providerTag: selected.providerTag,
    });
    expect(JSON.parse(String(fixture.calls[fixture.calls.length - 1]?.body))).toMatchObject({
      provider: {
        only: ['google-vertex/global'],
        allow_fallbacks: false,
        zdr: true,
        data_collection: 'deny',
        options: { 'google-vertex': { cachedContent: 'cachedContents/fixture' } },
      },
    });
  });

  it('derives source video and audio inputs from the generic metadata and marks edit, upscale, and avatar workflows', async () => {
    const fixture = publicTransport();
    const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
    const result = await catalog.read(config, resolve, scope('owner'));
    for (const metadata of publicCatalog.generalVideos.data) {
      const offering = result.resolved.get(`videos:${metadata.id}`)?.offering;
      expect(offering?.available).toBe(true);
      if (metadata.architecture.input_modalities.includes('video'))
        expect(offering?.capabilities[0].inputs.roles).toContain('video');
      if (metadata.architecture.input_modalities.includes('audio'))
        expect(offering?.capabilities[0].inputs.roles).toContain('audio');
      expect(offering?.capabilities[0].inputs.hostedRoles).toEqual(
        offering?.capabilities[0].inputs.roles.filter(
          (role) => role === 'video' || role === 'audio',
        ),
      );
    }
    const workflows = result.catalog.offerings.filter(
      (offering) =>
        offering.api === 'openrouter.videos' && offering.capabilities[0].workflow !== 'generate',
    );
    expect(
      workflows.map((offering) => [offering.modelId, offering.capabilities[0].workflow]),
    ).toEqual([
      ['black-forest-labs/flux-video-edit', 'edit'],
      ['heygen/avatar-iv', 'avatar'],
      ['black-forest-labs/flux-video-upscale', 'upscale'],
      ['runway/aleph-2', 'edit'],
    ]);
    for (const offering of workflows) {
      const submission = mediaSubmissionRequestSchema.parse({
        clientRequestId: 'workflow',
        operation: 'video.generate',
        prompt: 'Improve the scene',
        selection: {
          connectionId: 'videos',
          modelId: offering.modelId,
          catalogVersion: result.catalog.version,
        },
      });
      expect(() => validateMediaOffering(submission, offering)).toThrow();
      const inputs =
        offering.capabilities[0].inputs.requiredRoles?.map((role) => ({
          role,
          file_id: `${role}-input`,
          ...(role === 'audio' || role === 'video'
            ? { sourceURL: `https://media.example/${role}` }
            : {}),
        })) ?? [];
      expect(() => validateMediaOffering({ ...submission, inputs }, offering)).not.toThrow();
      expect(() =>
        validateMediaOffering(
          { ...submission, inputs: inputs.map(({ role, file_id }) => ({ role, file_id })) },
          offering,
        ),
      ).toThrow();
    }
  });

  it('scopes video provider options to the actual serving provider rather than the model author', async () => {
    const modelId = 'kwaivgi/kling-v3.0-pro';
    const fixture = publicTransport((request) =>
      request.url.endsWith('/videos')
        ? JSON.stringify({ id: 'video-job', status: 'queued' })
        : undefined,
    );
    const limited = resolveMediaConfig({
      enabled: true,
      integrations: [{ ...videoIntegration, catalog: { kind: 'configured', models: [modelId] } }],
    });
    const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
    const result = await catalog.read(limited, resolve, scope('owner'));
    const selected = result.resolved.get(`videos:${modelId}`);
    if (!selected) throw new Error('Missing Kling model');
    expect(selected.providerTag).toBe('atlas-cloud');
    const submission = mediaSubmissionRequestSchema.parse({
      clientRequestId: 'kling',
      operation: 'video.generate',
      prompt: 'A forest',
      selection: { connectionId: 'videos', modelId, catalogVersion: result.catalog.version },
      parameters: { providerOptions: { cfg_scale: 0.5 } },
    });
    expect(() =>
      validateMediaOffering(submission, selected.offering, limited.limits),
    ).not.toThrow();
    const adapter = adapters.find((entry) => entry.api === 'openrouter.videos');
    if (!adapter) throw new Error('Missing OpenRouter video adapter');
    await adapter.submit(submission, [], {
      transport: fixture.transport,
      config: limited,
      jobId: 'server-job',
      signal: new AbortController().signal,
      connection: connection(videoIntegration),
      providerTag: selected.providerTag,
    });
    expect(JSON.parse(String(fixture.calls[fixture.calls.length - 1]?.body)).provider).toEqual({
      options: { 'atlas-cloud': { cfg_scale: 0.5 } },
    });
  });

  it('follows same-origin generic metadata pagination and retains input roles from later pages', async () => {
    const fixture = publicTransport((request) => {
      const url = new URL(request.url);
      if (url.searchParams.get('output_modalities') !== 'video') return;
      if (url.searchParams.get('page') === '2')
        return JSON.stringify({
          data: publicCatalog.generalVideos.data.slice(1),
          links: { next: null },
        });
      return JSON.stringify({
        data: publicCatalog.generalVideos.data.slice(0, 1),
        links: { next: '?output_modalities=video&page=2' },
      });
    });
    const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
    const result = await catalog.read(config, resolve, scope('owner'));
    expect(
      result.catalog.offerings.filter(
        (offering) => offering.api === 'openrouter.videos' && offering.available,
      ),
    ).toHaveLength(8);
    expect(
      result.resolved.get('videos:bytedance/seedance-2.0')?.offering.capabilities[0].inputs.roles,
    ).toContain('audio');
    expect(
      fixture.calls.filter(
        (call) => new URL(call.url).searchParams.get('output_modalities') === 'video',
      ),
    ).toHaveLength(2);
  });

  it.each([
    'https://untrusted.example/models?page=2',
    'https://untrusted:password@openrouter.example/api/v1/models?output_modalities=video&page=2',
    '/outside-api/models?page=2',
    '?output_modalities=video',
  ])('rejects unsafe or cyclic pagination before forwarding credentials: %s', async (next) => {
    const fixture = publicTransport((request) =>
      new URL(request.url).searchParams.get('output_modalities') === 'video'
        ? JSON.stringify({ data: publicCatalog.generalVideos.data.slice(0, 1), links: { next } })
        : undefined,
    );
    const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
    const limited = resolveMediaConfig({
      enabled: true,
      integrations: [
        { ...videoIntegration, catalog: { kind: 'configured', models: ['google/veo-3.1'] } },
      ],
    });
    const result = await catalog.read(limited, resolve, scope('owner'));
    expect(result.catalog.offerings[0]).toMatchObject({
      available: false,
      unavailableReason: 'not_ready',
    });
    expect(fixture.calls).toHaveLength(2);
    expect(
      fixture.calls.every((call) => new URL(call.url).origin === 'https://openrouter.example'),
    ).toBe(true);
  });

  it('preserves curated discovery defaults and applies exclusions to all-model discovery', async () => {
    const fixture = publicTransport();
    const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
    const selected = ['google/gemini-2.5-flash-image', 'not-published/image'];
    const curated = resolveMediaConfig({
      enabled: true,
      integrations: [
        { ...imageIntegration, catalog: { kind: 'discovered', allowModels: selected } },
      ],
    });
    const result = await catalog.read(curated, resolve, scope('owner'));
    expect(result.catalog.offerings.map((offering) => offering.modelId)).toEqual(selected);
    expect(result.catalog.offerings.map((offering) => offering.available)).toEqual([true, false]);
    expect(fixture.calls.filter((call) => call.url.endsWith('/endpoints'))).toHaveLength(1);
    const excluded = resolveMediaConfig({
      enabled: true,
      integrations: [
        {
          ...imageIntegration,
          catalog: {
            kind: 'discovered',
            allModels: true,
            excludeModels: ['meta/muse-image', selected[0]],
          },
        },
      ],
    });
    const expanded = await catalog.read(excluded, resolve, scope('owner'));
    expect(expanded.catalog.offerings).toHaveLength(10);
    expect(
      expanded.catalog.offerings.every(
        (offering) =>
          offering.available && !['meta/muse-image', selected[0]].includes(offering.modelId),
      ),
    ).toBe(true);
  });

  it.each(['openrouter.images', 'bfl.images'] as const)(
    'honors allowModels together with allModels and exclusions for %s',
    async (api) => {
      const fixture = publicTransport();
      const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
      const model = 'black-forest-labs/flux.2-pro';
      const excluded = 'black-forest-labs/flux.2-max';
      const limited = resolveMediaConfig({
        enabled: true,
        integrations: [
          {
            ...imageIntegration,
            api,
            catalog: {
              kind: 'discovered',
              allModels: true,
              allowModels: [model, excluded, 'missing/model'],
              excludeModels: [excluded],
            },
          },
        ],
      });
      const result = await catalog.read(limited, resolve, scope('owner'));
      expect(
        result.catalog.offerings.map(({ modelId, available }) => ({ modelId, available })),
      ).toEqual([
        { modelId: model, available: true },
        { modelId: 'missing/model', available: false },
      ]);
      const empty = resolveMediaConfig({
        enabled: false,
        integrations: [
          { ...imageIntegration, api, catalog: { kind: 'discovered', allModels: false } },
        ],
      });
      expect((await catalog.read(empty, resolve, scope('owner'))).catalog.offerings).toEqual([]);
    },
  );

  it('discovers newly published image models without changing an application allowlist', async () => {
    const fixture = publicTransport((request) => {
      if (request.url.endsWith('/images/models'))
        return JSON.stringify({
          data: [...publicCatalog.images.data, { id: 'future/new-image', name: 'New Image' }],
        });
      if (request.url.endsWith('/images/models/future/new-image/endpoints'))
        return JSON.stringify({
          id: 'future/new-image',
          endpoints: [
            {
              provider_tag: 'future-provider',
              supported_parameters: { n: { type: 'range', min: 1, max: 1 } },
            },
          ],
        });
    });
    const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
    const result = await catalog.read(config, resolve, scope('owner'));
    expect(result.catalog.offerings).toHaveLength(21);
    expect(result.resolved.get('images:future/new-image')?.offering).toMatchObject({
      modelName: 'New Image',
      available: true,
    });
  });

  it('isolates malformed endpoint and video model metadata from unrelated offerings', async () => {
    const fixture = publicTransport((request) => {
      if (request.url.endsWith('/images/models/black-forest-labs/flux.2-pro/endpoints'))
        return JSON.stringify({
          id: 'black-forest-labs/flux.2-pro',
          endpoints: [
            {
              provider_tag: 'black-forest-labs',
              supported_parameters: { n: { type: 'range', min: 'invalid', max: 4 } },
            },
          ],
        });
      if (request.url.endsWith('/videos/models'))
        return JSON.stringify({
          data: publicCatalog.videos.data.map((model) =>
            model.id === 'runway/gen-4.5' ? { ...model, supported_durations: ['invalid'] } : model,
          ),
        });
    });
    const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
    const result = await catalog.read(config, resolve, scope('owner'));
    expect(result.catalog.offerings).toHaveLength(20);
    expect(result.catalog.offerings.filter((offering) => offering.available)).toHaveLength(17);
    expect(result.resolved.get('images:black-forest-labs/flux.2-pro')?.offering).toMatchObject({
      available: false,
      unavailableReason: 'not_ready',
    });
    expect(result.resolved.get('videos:runway/gen-4.5')?.offering).toMatchObject({
      available: false,
      unavailableReason: 'not_ready',
    });
    expect(result.resolved.get('videos:google/veo-3.1')?.offering.available).toBe(true);
  });

  it('bounds all-model discovery and reports an unavailable integration when the configured limit is exceeded', async () => {
    const fixture = publicTransport();
    const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
    const limited = resolveMediaConfig({
      enabled: true,
      catalog: { maxModels: 10 },
      integrations: [config.integrations[0]],
    });
    const result = await catalog.read(limited, resolve, scope('owner'));
    expect(result.catalog.offerings).toHaveLength(0);
    expect(result.catalog.integrations).toEqual([
      expect.objectContaining({
        connectionId: 'images',
        available: false,
        unavailableReason: 'not_ready',
      }),
    ]);
    expect(fixture.calls).toHaveLength(1);
  });

  it('does not advertise a required-input workflow that exceeds the configured input limit', async () => {
    const fixture = publicTransport();
    const catalog = createMediaCatalog({ ...fixture, adapters, now: () => 0 });
    const limited = resolveMediaConfig({
      enabled: true,
      limits: { maxInputs: 1 },
      integrations: [config.integrations[1]],
    });
    const result = await catalog.read(limited, resolve, scope('owner'));
    expect(() => mediaCatalogSchema.parse(result.catalog)).not.toThrow();
    expect(result.resolved.get('videos:heygen/avatar-iv')?.offering).toMatchObject({
      available: false,
      capabilities: [],
    });
    expect(result.resolved.get('videos:google/veo-3.1')?.offering.available).toBe(true);
  });
});

describe('media provider routing and continuation', () => {
  const config = resolveMediaConfig({
    enabled: true,
    integrations: [imageIntegration, videoIntegration],
  });
  const adapters = createRESTMediaAdapters();
  const appConfig: AppConfig = {
    config: {},
    fileStrategy: FileSources.local,
    imageOutputType: 'png',
    endpoints: {
      custom: [
        {
          name: 'OpenRouter',
          baseURL: 'https://openrouter.example/api/v1',
          apiKey: '${ROUTER_KEY}',
          addParams: {
            temperature: 0.2,
            provider: { only: ['google-vertex'], zdr: true, data_collection: 'deny' },
          },
        },
      ],
    },
  };

  it.each([
    { maxNativeParts: 1, maxOutputs: 2 },
    { maxNativeParts: 4, maxOutputs: 1 },
  ])('bounds Gemini parts after the final image is appended: %j', async (limits) => {
    const fixture = fixtureTransport(() =>
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: 'Two images', inlineData: { mimeType: 'image/png', data: 'YQ==' } },
                { inlineData: { mimeType: 'image/png', data: 'Yg==' } },
              ],
            },
          },
        ],
      }),
    );
    const adapter = adapters.find((entry) => entry.api === 'google.generateContent');
    if (!adapter) {
      throw new Error('Missing adapter');
    }
    await expect(
      adapter.submit(
        mediaSubmissionRequestSchema.parse({
          clientRequestId: 'bounded',
          operation: 'image.generate',
          prompt: 'A forest',
          selection: { connectionId: 'google', modelId: 'gemini-image', catalogVersion: 'v1' },
        }),
        [],
        {
          ...fixture,
          config: resolveMediaConfig({ ...config, limits: { ...config.limits, ...limits } }),
          jobId: 'server-job',
          signal: new AbortController().signal,
          connection: { ...connection(imageIntegration), api: 'google.generateContent' },
        },
      ),
    ).rejects.toMatchObject({ certainty: 'uncertain' });
  });

  it('extracts only validated policy and invalidates binding when policy changes', async () => {
    const resolver = createMediaCredentialResolver({
      environment: { ROUTER_KEY: 'test-key' },
      repository: { getUserKeySnapshot: async () => null },
      decrypt: async (value) => value,
      now: () => 0,
    });
    const args = {
      scope: { ownerId: 'owner', tenantId: null },
      integration: imageIntegration,
      appConfig,
      minValidityMs: 0,
    };
    const resolved = await resolver(args);
    expect(resolved.routing).toEqual({
      only: ['google-vertex'],
      zdr: true,
      data_collection: 'deny',
    });
    expect(resolved.headers).toEqual({ Authorization: 'Bearer test-key' });
    const endpoint = appConfig.endpoints?.custom?.[0];
    const changed: AppConfig = {
      ...appConfig,
      endpoints: { custom: [{ ...endpoint, addParams: { provider: { zdr: false } } }] },
    };
    expect((await resolver({ ...args, appConfig: changed })).binding).not.toBe(resolved.binding);
    const unsupported: AppConfig = {
      ...appConfig,
      endpoints: {
        custom: [{ ...endpoint, addParams: { provider: { max_price: { image: 0.1 } } } }],
      },
    };
    await expect(resolver({ ...args, appConfig: unsupported })).rejects.toMatchObject({
      code: 'not_ready',
    });
  });

  it('preserves image privacy policy while narrowing the endpoint and maps resolution correctly', async () => {
    const fixture = fixtureTransport(() => JSON.stringify({ data: [{ b64_json: 'YQ==' }] }));
    const context: MediaProviderContext = {
      ...fixture,
      config,
      jobId: 'server-job',
      signal: new AbortController().signal,
      connection: {
        ...connection(imageIntegration),
        routing: {
          only: ['google-vertex'],
          ignore: ['google-ai-studio'],
          zdr: true,
          data_collection: 'deny',
          allow_fallbacks: true,
        },
      },
      providerTag: 'google-vertex/global',
    };
    const adapter = adapters.find((entry) => entry.api === 'openrouter.images');
    if (!adapter) {
      throw new Error('Missing adapter');
    }
    await adapter.submit(
      mediaSubmissionRequestSchema.parse({
        clientRequestId: 'image',
        operation: 'image.generate',
        prompt: 'A forest',
        selection: { connectionId: 'images', modelId: 'google/image', catalogVersion: 'v1' },
        parameters: { resolution: '2K' },
      }),
      [],
      context,
    );
    expect(JSON.parse(String(fixture.calls[0].body))).toMatchObject({
      resolution: '2K',
      provider: {
        only: ['google-vertex/global'],
        ignore: ['google-ai-studio'],
        zdr: true,
        data_collection: 'deny',
        allow_fallbacks: false,
      },
    });
    expect(JSON.parse(String(fixture.calls[0].body)).size).toBeUndefined();
  });

  it('refuses video transport before a paid call when ZDR is required', async () => {
    const fixture = fixtureTransport(() => JSON.stringify({ id: 'job', status: 'queued' }));
    const adapter = adapters.find((entry) => entry.api === 'openrouter.videos');
    if (!adapter) {
      throw new Error('Missing adapter');
    }
    await expect(
      adapter.submit(
        mediaSubmissionRequestSchema.parse({
          clientRequestId: 'video',
          operation: 'video.generate',
          prompt: 'A forest',
          selection: { connectionId: 'videos', modelId: 'google/video', catalogVersion: 'v1' },
        }),
        [],
        {
          ...fixture,
          config,
          jobId: 'server-job',
          signal: new AbortController().signal,
          connection: { ...connection(videoIntegration), routing: { zdr: true } },
        },
      ),
    ).rejects.toMatchObject({ certainty: 'rejected' });
    expect(fixture.calls).toHaveLength(0);
  });

  it('replays ordered Gemini text and images with signatures and preserves returned signatures privately', async () => {
    const fixture = fixtureTransport(() =>
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: 'Here is the revision', thoughtSignature: 'text-signature' },
                {
                  inlineData: { mimeType: 'image/png', data: 'Yg==' },
                  thoughtSignature: 'image-signature',
                },
              ],
            },
          },
        ],
      }),
    );
    const adapter = adapters.find((entry) => entry.api === 'google.generateContent');
    if (!adapter) {
      throw new Error('Missing adapter');
    }
    const result = await adapter.submit(
      mediaSubmissionRequestSchema.parse({
        clientRequestId: 'revision',
        operation: 'image.generate',
        prompt: 'Make it blue',
        selection: { connectionId: 'google', modelId: 'gemini-image', catalogVersion: 'v1' },
      }),
      [],
      {
        ...fixture,
        config,
        jobId: 'server-job',
        signal: new AbortController().signal,
        connection: { ...connection(imageIntegration), api: 'google.generateContent' },
        continuation: {
          prompt: 'Draw a red cube',
          inputs: [],
          parts: [
            { kind: 'text', ordinal: 0, text: 'A red cube', thoughtSignature: 'previous-text' },
            {
              kind: 'image',
              ordinal: 1,
              type: 'image/png',
              data: Buffer.from('a'),
              thoughtSignature: 'previous-image',
            },
          ],
        },
      },
    );
    const sent = JSON.parse(String(fixture.calls[0].body));
    expect(sent.contents.map((item: { role: string }) => item.role)).toEqual([
      'user',
      'model',
      'user',
    ]);
    expect(sent.contents[1].parts).toEqual([
      { text: 'A red cube', thoughtSignature: 'previous-text' },
      { inlineData: { mimeType: 'image/png', data: 'YQ==' }, thoughtSignature: 'previous-image' },
    ]);
    expect(result).toMatchObject({
      status: 'completed',
      parts: [
        { kind: 'text', ordinal: 0, thoughtSignature: 'text-signature' },
        { kind: 'image', ordinal: 1, thoughtSignature: 'image-signature' },
      ],
    });
  });
});
