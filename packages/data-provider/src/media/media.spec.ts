import axios from 'axios';
import {
  resolveMediaConfig,
  mediaConfigSchema,
  mediaSubmissionRequestSchema,
  createMediaSubmissionSchema,
  createMediaImportSchema,
  mediaImportReceiptSchema,
  mediaSubmissionReceiptSchema,
  mediaStartupConfigSchema,
  mediaNumberControlSchema,
  mediaThreadListRequestSchema,
  mediaThreadDetailRequestSchema,
  mediaOptionValueSchema,
  mediaInputSchema,
  mediaURLUploadRequestSchema,
  mediaCatalogSchema,
  mediaUserKeySchema,
  mediaThreadSchema,
  mediaThreadDetailSchema,
  mediaTurnSchema,
  mediaPresetSchema,
  mediaPresetWriteSchema,
  mediaPresetUpdateSchema,
  createMediaPresetSchema,
  mediaErrorSchema,
  mediaProviderDiagnosticSchema,
  mediaJobDiagnosticsResponseSchema,
  mediaAssetSchema,
} from './index';
import { PermissionTypes, Permissions, permissionsSchema } from '../permissions';
import { configSchema, BASE_ONLY_CONFIG_SECTIONS } from '../config';
import { roleDefaults, SystemRoles } from '../roles';
import { TOKEN_CREDITS_PER_USD } from '../balance';
import { getMediaThread } from '../data-service';
import * as endpoints from '../api-endpoints';
import { EModelEndpoint } from '../schemas';

const integration = {
  id: 'router',
  api: 'openrouter.images' as const,
  endpointRef: { kind: 'custom' as const, name: 'OpenRouter' },
  catalog: { kind: 'configured' as const, models: ['publisher/model'] },
  operations: ['image.generate' as const, 'image.edit' as const],
};

test('bounds provider diagnostics independently of the existing public error contract', () => {
  const diagnostic = {
    status: 400,
    code: 'INVALID_ARGUMENT',
    message: 'The reference video must use a supported resolution.',
    requestId: 'provider-request-1',
  };
  expect(mediaJobDiagnosticsResponseSchema.parse({ diagnostic })).toEqual({ diagnostic });
  expect(mediaJobDiagnosticsResponseSchema.parse({})).toEqual({});
  expect(mediaProviderDiagnosticSchema.safeParse({ status: 600 }).success).toBe(false);
  expect(mediaProviderDiagnosticSchema.safeParse({ code: 'x'.repeat(257) }).success).toBe(false);
  expect(mediaProviderDiagnosticSchema.safeParse({ requestId: 'x'.repeat(257) }).success).toBe(
    false,
  );
  expect(mediaProviderDiagnosticSchema.safeParse({ message: 'x'.repeat(8_193) }).success).toBe(
    false,
  );
  expect(mediaProviderDiagnosticSchema.safeParse({ ...diagnostic, headers: {} }).success).toBe(
    false,
  );
  expect(mediaErrorSchema.safeParse({ code: 'provider_rejected', diagnostic }).success).toBe(false);
  expect(endpoints.mediaJobDiagnostics('job/one')).toBe('/api/media/jobs/job%2Fone/diagnostics');
});

test('configures bounded provider diagnostic retention and response parsing', () => {
  expect(resolveMediaConfig({}).recovery).toMatchObject({
    maxDiagnosticMessageChars: 2_000,
    maxDiagnosticResponseBytes: 16_384,
  });
  const recovery = { maxDiagnosticMessageChars: 600, maxDiagnosticResponseBytes: 8_192 };
  expect(resolveMediaConfig({ recovery }).recovery).toMatchObject(recovery);
  for (const invalid of [
    { maxDiagnosticMessageChars: 0 },
    { maxDiagnosticMessageChars: 8_193 },
    { maxDiagnosticResponseBytes: 0 },
    { maxDiagnosticResponseBytes: 1_048_577 },
  ]) {
    expect(mediaConfigSchema.safeParse({ recovery: invalid }).success).toBe(false);
  }
});
test('validates provider options and rejects reserved APIs during config loading', () => {
  const direct = {
    ...integration,
    api: 'openai.images' as const,
    endpointRef: {
      kind: 'direct' as const,
      apiKey: 'key',
      options: { deployments: { 'gpt-image-1': 'studio-image' } },
    },
  };
  expect(resolveMediaConfig({ integrations: [direct] }).integrations[0].endpointRef).toMatchObject({
    options: { deployments: { 'gpt-image-1': 'studio-image' } },
  });
  expect(() => resolveMediaConfig({ integrations: [{ ...direct, api: 'bfl.images' }] })).toThrow(
    'Deployment mappings',
  );
  expect(() =>
    resolveMediaConfig({ integrations: [{ ...direct, api: 'google.interactions' }] }),
  ).toThrow('no media adapter');
  expect(() =>
    resolveMediaConfig({
      integrations: [
        { ...direct, api: 'sourceful.images', endpointRef: { kind: 'direct', apiKey: 'key' } },
      ],
    }),
  ).toThrow('UUID brandId');
  expect(
    resolveMediaConfig({
      integrations: [
        {
          ...direct,
          api: 'sourceful.images',
          endpointRef: {
            kind: 'direct',
            apiKey: 'key',
            options: { brandId: '${SOURCEFUL_BRAND_ID}' },
          },
        },
      ],
    }).integrations,
  ).toHaveLength(1);
  expect(() =>
    mediaConfigSchema.parse({
      integrations: [
        {
          ...direct,
          endpointRef: {
            ...direct.endpointRef,
            options: { ...direct.endpointRef.options, typo: 'invalid' },
          },
        },
      ],
    }),
  ).toThrow();
});

const submission = {
  clientRequestId: 'request-1',
  selection: { connectionId: 'router', modelId: 'publisher/model', catalogVersion: 'opaque-token' },
  operation: 'image.generate' as const,
  prompt: 'A lake at dawn',
};

describe('media configuration compatibility', () => {
  it('accepts explicit provider exclusions without changing existing integration defaults', () => {
    const config = resolveMediaConfig({
      enabled: true,
      integrations: [
        integration,
        { ...integration, id: 'visible', enabled: true },
        { ...integration, id: 'hidden', enabled: false },
      ],
    });
    expect(config.integrations.map((entry) => entry.enabled)).toEqual([undefined, true, false]);
    expect(configSchema.parse({ version: '1.3.1', media: config }).media).toEqual(config);
    expect(
      resolveMediaConfig({ enabled: true, integrations: [{ ...integration, enabled: false }] })
        .integrations[0].enabled,
    ).toBe(false);
    expect(
      mediaConfigSchema.safeParse({ integrations: [{ ...integration, enabled: 'false' }] }).success,
    ).toBe(false);
  });

  it('publishes only explicit user-key setup instructions without requiring model discovery', () => {
    const catalog = {
      schemaVersion: 1,
      version: 'catalog-version',
      offerings: [],
      limits: {},
      integrations: [
        {
          connectionId: 'router',
          connectionName: 'OpenRouter',
          api: 'openrouter.images',
          available: false,
          unavailableReason: 'credentials_required',
          userKey: { keyName: 'My OpenRouter', encoding: 'apiKey', userProvideURL: false },
        },
      ],
    };
    expect(mediaCatalogSchema.parse(catalog).integrations?.[0].userKey).toEqual(
      catalog.integrations[0].userKey,
    );
    const { userKey: _userKey, ...managed } = catalog.integrations[0];
    expect(
      mediaCatalogSchema.parse({ ...catalog, integrations: [managed] }).integrations?.[0].userKey,
    ).toBeUndefined();
    for (const secretField of ['apiKey', 'baseURL', 'headers', 'options', 'value']) {
      expect(
        mediaUserKeySchema.safeParse({
          ...catalog.integrations[0].userKey,
          [secretField]: 'private',
        }).success,
      ).toBe(false);
    }
    expect(mediaUserKeySchema.safeParse({ keyName: '', encoding: 'raw' }).success).toBe(false);
  });

  it('keeps personal credentials an explicit YAML choice and lets image/video share a saved key', () => {
    const config = resolveMediaConfig({
      integrations: [
        {
          ...integration,
          endpointRef: {
            kind: 'direct',
            apiKey: 'user_provided',
            baseURL: 'user_provided',
            credentialName: 'router-account',
          },
        },
        {
          ...integration,
          id: 'router-videos',
          api: 'openrouter.videos',
          operations: ['video.generate'],
          endpointRef: {
            kind: 'direct',
            apiKey: 'user_provided',
            credentialName: 'router-account',
          },
        },
      ],
    });
    expect(config.integrations[0].endpointRef).toMatchObject({
      apiKey: 'user_provided',
      baseURL: 'user_provided',
      credentialName: 'router-account',
    });
    expect(config.integrations[1].endpointRef).toMatchObject({ credentialName: 'router-account' });
  });

  it('accepts hosted audio/video sources while rejecting credentials, fragments and non-HTTPS URLs', () => {
    const url = 'https://media.example/reference.mp4?signature=opaque';
    expect(mediaURLUploadRequestSchema.parse({ url, role: 'video' })).toEqual({
      url,
      role: 'video',
    });
    expect(
      mediaInputSchema.parse({ role: 'audio', file_id: 'owned-file', sourceURL: url }).sourceURL,
    ).toBe(url);
    for (const invalid of [
      'not-a-url',
      'http://media.example/video',
      'https://user:secret@media.example/video',
      'https://media.example/video#fragment',
      'data:video/mp4;base64,AA==',
    ]) {
      expect(mediaURLUploadRequestSchema.safeParse({ url: invalid, role: 'video' }).success).toBe(
        false,
      );
    }
    expect(
      mediaInputSchema.safeParse({ role: 'reference', file_id: 'image', sourceURL: url }).success,
    ).toBe(false);
    expect(mediaURLUploadRequestSchema.safeParse({ url, role: 'reference' }).success).toBe(false);
  });

  it('supports opt-in full discovery and direct provider credentials without changing curated defaults', () => {
    const config = resolveMediaConfig({
      enabled: true,
      integrations: [
        {
          ...integration,
          api: 'bfl.images',
          endpointRef: { kind: 'direct', apiKey: '${BFL_API_KEY}' },
          catalog: {
            kind: 'discovered',
            allModels: true,
            excludeModels: ['black-forest-labs/flux.2-max'],
          },
        },
      ],
    });
    expect(config.integrations[0].catalog).toEqual({
      kind: 'discovered',
      allModels: true,
      allowModels: [],
      excludeModels: ['black-forest-labs/flux.2-max'],
    });
    expect(
      resolveMediaConfig({ integrations: [{ ...integration, catalog: { kind: 'discovered' } }] })
        .integrations[0].catalog,
    ).toEqual({ kind: 'discovered', allModels: false, allowModels: [], excludeModels: [] });
  });

  it('validates deep provider JSON without recursive parsing and rejects non-JSON/cyclic values', () => {
    let value: object = {};
    for (let i = 0; i < 10_000; i++) value = { nested: value };
    expect(mediaOptionValueSchema.safeParse(value).success).toBe(true);
    const circular: { self?: object } = {};
    circular.self = circular;
    expect(mediaOptionValueSchema.safeParse(circular).success).toBe(false);
    expect(mediaOptionValueSchema.safeParse({ seed: NaN }).success).toBe(false);
    expect(mediaOptionValueSchema.safeParse({ date: new Date() }).success).toBe(false);
  });
  it('leaves absent YAML disabled and materializes nested defaults only on resolution', () => {
    const before = configSchema.parse({ version: '1.3.1' });
    expect(before.media).toBeUndefined();
    const resolved = resolveMediaConfig(before.media);
    expect(resolved.enabled).toBe(false);
    expect(resolved.integrations).toEqual([]);
    expect(resolved.polling.clientIntervalMs).toBe(5_000);
    expect(resolved.polling.clientCatchUpIntervalMs).toBe(30_000);
    expect(BASE_ONLY_CONFIG_SECTIONS).toContain('media');
  });

  it('parses partial nested config and keeps ordinary defaults', () => {
    const config = mediaConfigSchema.parse({
      enabled: true,
      integrations: [integration],
      worker: { tickMs: 2_000 },
    });
    expect(config.worker.tickMs).toBe(2_000);
    expect(config.worker.leaseMs).toBe(60_000);
    expect(config.assets).toEqual({
      source: null,
      retention: 'inherit',
      orphanRetentionMs: 86_400_000,
      deletedAccountRetentionMs: 604_800_000,
      derivatives: {
        enabled: true,
        maxWidth: 640,
        maxHeight: 640,
        timeoutMs: 120_000,
        ffmpegPath: 'ffmpeg',
        transcodeVideo: false,
      },
    });
    expect(config.integrations[0].billing).toBeUndefined();
  });

  it('uses the existing token-credit currency without changing explicit billing rates', () => {
    const config = configSchema.parse({
      version: '1.3.1',
      media: {
        integrations: [
          { ...integration, billing: { estimatedCostUSD: 0.04, maxCostUSD: 0.25 } },
          { ...integration, id: 'legacy', billing: { creditsPerUSD: 1_000, maxCostUSD: 0.5 } },
          { ...integration, id: 'unconfigured' },
        ],
      },
    });
    expect(config.media?.integrations[0].billing).toEqual({
      creditsPerUSD: TOKEN_CREDITS_PER_USD,
      estimatedCostUSD: 0.04,
      maxCostUSD: 0.25,
    });
    expect(config.media?.integrations[0].billing?.creditsPerUSD).toBe(1_000_000);
    expect(config.media?.integrations[1].billing).toEqual({
      creditsPerUSD: 1_000,
      maxCostUSD: 0.5,
    });
    expect(config.media?.integrations[2].billing).toBeUndefined();
  });

  it('configures derived previews without changing original storage or image format settings', () => {
    const config = configSchema.parse({
      version: '1.3.1',
      imageOutputType: 'webp',
      media: { assets: { derivatives: { maxWidth: 320, transcodeVideo: true } } },
    });
    expect(config.imageOutputType).toBe('webp');
    expect(config.media?.assets.source).toBeNull();
    expect(config.media?.assets.derivatives).toEqual({
      enabled: true,
      maxWidth: 320,
      maxHeight: 640,
      timeoutMs: 120_000,
      ffmpegPath: 'ffmpeg',
      transcodeVideo: true,
    });
    expect(
      resolveMediaConfig({ assets: { derivatives: { enabled: false } } }).assets.derivatives
        .enabled,
    ).toBe(false);
  });

  it.each([
    { estimatedCostUSD: 0.5, maxCostUSD: 0.25 },
    { creditsPerUSD: Number.MAX_VALUE, maxCostUSD: 2 },
    { maxCostUSD: Number.MAX_SAFE_INTEGER },
    { creditsPerUSD: Number.MIN_VALUE, estimatedCostUSD: Number.MIN_VALUE },
  ])('rejects billing amounts that cannot be safely reserved: %j', (billing) => {
    expect(
      mediaConfigSchema.safeParse({ integrations: [{ ...integration, billing }] }).success,
    ).toBe(false);
  });

  it.each([
    { api: 'openai.images', endpoint: EModelEndpoint.openAI, operations: ['image.generate'] },
    { api: 'openai.videos', endpoint: EModelEndpoint.openAI, operations: ['video.generate'] },
    { api: 'google.generateContent', endpoint: EModelEndpoint.google, operations: ['image.edit'] },
  ])('reuses compatible built-in endpoint credentials: %j', ({ api, endpoint, operations }) => {
    expect(
      mediaConfigSchema.safeParse({
        integrations: [
          { ...integration, api, operations, endpointRef: { kind: 'builtin', endpoint } },
        ],
      }).success,
    ).toBe(true);
  });

  it.each([
    { api: 'openai.images', endpoint: EModelEndpoint.azureOpenAI },
    { api: 'openai.images', endpoint: EModelEndpoint.assistants },
    { api: 'openrouter.images', endpoint: EModelEndpoint.custom },
  ])('rejects unsupported built-in endpoint credentials: %j', ({ api, endpoint }) => {
    expect(
      mediaConfigSchema.safeParse({
        integrations: [{ ...integration, api, endpointRef: { kind: 'builtin', endpoint } }],
      }).success,
    ).toBe(false);
  });

  it('preserves the separation between API protocol and reverse-proxied credential endpoints', () => {
    expect(
      mediaConfigSchema.safeParse({
        integrations: [
          { ...integration, endpointRef: { kind: 'builtin', endpoint: EModelEndpoint.openAI } },
        ],
      }).success,
    ).toBe(true);
  });

  it('keeps generated titles on by default while deferring the model choice to configuration', () => {
    expect(resolveMediaConfig().titles).toEqual({
      enabled: true,
      timeoutMs: 45_000,
      maxOutputTokens: 128,
    });
    const config = mediaConfigSchema.parse({
      titles: { endpoint: ' openAI ', model: 'gpt-4o-mini', prompt: 'Name this: {prompt}' },
    });
    expect(config.titles).toEqual({
      enabled: true,
      endpoint: 'openAI',
      model: 'gpt-4o-mini',
      prompt: 'Name this: {prompt}',
      timeoutMs: 45_000,
      maxOutputTokens: 128,
    });
    expect(mediaConfigSchema.parse({ titles: { enabled: false } }).titles.enabled).toBe(false);
  });

  it.each([
    { enabled: true },
    { titles: { arbitrary: 'ignored' } },
    { titles: { endpoint: '' } },
    { titles: { timeoutMs: 0 } },
    { titles: { maxOutputTokens: 0 } },
    { titles: { maxOutputTokens: 1.5 } },
    { titles: { maxOutputTokens: 1_000_001 } },
    { integrations: [integration, integration] },
    { worker: { leaseMs: 1_000, renewEveryMs: 1_000 } },
    { execution: { maxActiveTotal: 1 } },
    { polling: { clientIntervalMs: 60_000, clientCatchUpIntervalMs: 30_000 } },
    { limits: { pageSize: 101, maxPageSize: 100 } },
    { limits: { maxNativeParts: 4_097 } },
    { limits: { maxNativeRecordingBytes: 4_194_305 } },
    { transfers: { arbitrary: 'ignored' } },
    { assets: { derivatives: { maxWidth: 0 } } },
    { assets: { derivatives: { maxHeight: 4_097 } } },
    { assets: { derivatives: { timeoutMs: 3_600_001 } } },
    { assets: { derivatives: { ffmpegPath: '' } } },
    { assets: { derivatives: { format: 'webp' } } },
    { integrations: [{ ...integration, api: 'openrouter.videos' }] },
    { integrations: [{ ...integration, billing: { creditsPerUSD: 0, estimatedCostUSD: 1 } }] },
  ])('fails closed for invalid config %j', (config) => {
    expect(mediaConfigSchema.safeParse(config).success).toBe(false);
  });

  it('defaults new permissions off for users, on for admins, and preserves explicit denial', () => {
    expect(roleDefaults[SystemRoles.USER].permissions[PermissionTypes.MEDIA]).toEqual({
      USE: false,
      CREATE: false,
    });
    expect(roleDefaults[SystemRoles.ADMIN].permissions[PermissionTypes.MEDIA]).toEqual({
      USE: true,
      CREATE: true,
    });
    const parsed = permissionsSchema.parse({
      ...roleDefaults[SystemRoles.USER].permissions,
      [PermissionTypes.MEDIA]: { [Permissions.USE]: true, [Permissions.CREATE]: false },
    });
    expect(parsed[PermissionTypes.MEDIA]).toEqual({ USE: true, CREATE: false });
  });

  it('configures Vertex separately from API-key and OpenRouter credentials', () => {
    const config = mediaConfigSchema.parse({
      integrations: [
        {
          id: 'vertex-video',
          api: 'google.vertex.videos',
          endpointRef: { kind: 'vertex', keyFile: '${GOOGLE_SERVICE_KEY_FILE}' },
          catalog: { kind: 'configured', models: ['veo-3.1-fast-generate-001'] },
          operations: ['video.generate'],
        },
      ],
    });
    expect(config.integrations[0].endpointRef).toEqual({
      kind: 'vertex',
      keyFile: '${GOOGLE_SERVICE_KEY_FILE}',
    });
    expect(configSchema.parse({ version: '1.3.1', media: config }).media).toEqual(config);
  });

  it.each([
    { api: 'google.vertex.videos', endpointRef: { kind: 'custom', name: 'OpenRouter' } },
    { api: 'openrouter.videos', endpointRef: { kind: 'vertex', keyFile: 'auth.json' } },
    { endpointRef: { kind: 'vertex', keyFile: '' } },
    { endpointRef: { kind: 'vertex', keyFile: 'auth.json', location: 'bad/region' } },
    { catalog: { kind: 'discovered', allowModels: ['veo-3.1-fast-generate-001'] } },
    { operations: ['image.generate'] },
  ])('rejects incompatible Vertex configuration %j', (override) => {
    expect(
      mediaConfigSchema.safeParse({
        integrations: [
          {
            id: 'vertex-video',
            api: 'google.vertex.videos',
            endpointRef: { kind: 'vertex', keyFile: 'auth.json' },
            catalog: { kind: 'configured', models: ['veo-3.1-fast-generate-001'] },
            operations: ['video.generate'],
            ...override,
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('media command contracts', () => {
  it('preserves exact custom credential names in lookup and revoke URLs', () => {
    const name = 'Media / Team & Labs?#';
    const lookup = new URL(endpoints.userKeyQuery(name), 'http://localhost');
    expect(lookup.searchParams.get('name')).toBe(name);
    expect(Array.from(lookup.searchParams.keys())).toEqual(['name']);
    const removal = new URL(endpoints.revokeUserKey(name), 'http://localhost');
    expect(decodeURIComponent(removal.pathname.split('/').pop()!)).toBe(name);
    expect(removal.search).toBe('');
    expect(removal.hash).toBe('');
  });

  it('opts into gallery activity over HTTP while leaving legacy requests unchanged', () => {
    const params = {
      include: 'activity' as const,
      filter: 'completed' as const,
      cursor: 'page/next',
    };
    const url = new URL(endpoints.mediaThreads(params), 'http://localhost');
    expect(mediaThreadListRequestSchema.parse(Object.fromEntries(url.searchParams))).toEqual(
      params,
    );
    expect(new URL(endpoints.mediaThreads(), 'http://localhost').searchParams.has('include')).toBe(
      false,
    );
  });

  it('distinguishes unavailable video context from a legacy server without video context', async () => {
    const legacy = {
      thread: {
        schemaVersion: 1,
        threadId: 'thread-1',
        version: 1,
        title: 'Lake',
        createdAt: '2026-09-17T12:00:00.000Z',
        updatedAt: '2026-09-17T12:00:00.000Z',
        pendingJobCount: 0,
        turnCount: 1,
      },
      turns: { items: [] },
    };
    expect(mediaThreadDetailSchema.parse(legacy)).not.toHaveProperty('latestVideoContext');
    expect(
      mediaThreadDetailSchema.parse({ ...legacy, latestVideoContext: null }).latestVideoContext,
    ).toBeNull();
    expect(mediaThreadDetailSchema.safeParse({ ...legacy, latestVideoContext: {} }).success).toBe(
      false,
    );
    expect(
      mediaThreadDetailSchema.omit({ latestVideoContext: true }).safeParse(legacy).success,
    ).toBe(true);
    const params = { include: 'videoContext', videoContextVersion: '2' };
    expect(mediaThreadDetailRequestSchema.parse(params)).toEqual(params);
    expect(
      mediaThreadDetailRequestSchema.omit({ videoContextVersion: true }).parse(params),
    ).toEqual({ include: 'videoContext' });
    expect(mediaThreadDetailRequestSchema.parse({ include: 'videoContext' })).toEqual({
      include: 'videoContext',
    });
    const response = { ...legacy, latestVideoContext: null };
    const read = jest.spyOn(axios, 'get').mockResolvedValue({ data: response });
    const signal = new AbortController().signal;
    expect(await getMediaThread('thread/1', signal)).toEqual(response);
    expect(read).toHaveBeenCalledWith(endpoints.mediaThread('thread/1'), { signal, params });
  });

  it('accepts temporary and comparison markers only where they mean something', () => {
    expect(mediaSubmissionRequestSchema.parse({ ...submission, temporary: true }).temporary).toBe(
      true,
    );
    expect(
      mediaSubmissionRequestSchema.safeParse({
        ...submission,
        temporary: true,
        threadId: 'thread-1',
      }).success,
    ).toBe(false);
    expect(
      mediaSubmissionRequestSchema.parse({ ...submission, comparisonId: 'compare-1' }).comparisonId,
    ).toBe('compare-1');
    const thread = {
      schemaVersion: 1,
      threadId: 'thread-1',
      version: 1,
      title: 'Lake',
      createdAt: '2026-09-17T12:00:00.000Z',
      updatedAt: '2026-09-17T12:00:00.000Z',
      pendingJobCount: 0,
      turnCount: 1,
    };
    expect(mediaThreadSchema.parse(thread).expiresAt).toBeUndefined();
    expect(mediaThreadSchema.parse(thread).temporary).toBeUndefined();
    expect(
      mediaThreadSchema.parse({
        ...thread,
        temporary: false,
        expiresAt: '2026-10-17T12:00:00.000Z',
      }).temporary,
    ).toBe(false);
    expect(
      mediaThreadSchema.parse({ ...thread, expiresAt: '2026-10-17T12:00:00.000Z' }).expiresAt,
    ).toBe('2026-10-17T12:00:00.000Z');
    expect(
      mediaTurnSchema.parse({
        schemaVersion: 1,
        threadId: 'thread-1',
        turnId: 'turn-1',
        version: 1,
        kind: 'generation',
        createdAt: '2026-09-17T12:00:00.000Z',
        prompt: 'A lake',
        inputs: [],
        jobs: [],
        assets: [],
        comparisonId: 'compare-1',
      }).comparisonId,
    ).toBe('compare-1');
  });

  it('defines Studio presets as named, restorable generation settings', () => {
    const settings = {
      operation: 'image.generate' as const,
      connectionId: 'router',
      modelId: 'publisher/model',
      parameters: { count: 2, size: '1024x1024' },
    };
    const write = mediaPresetWriteSchema.parse({ title: ' Studio look ', settings });
    expect(write.title).toBe('Studio look');
    expect(write.isDefault).toBeUndefined();
    expect(mediaPresetWriteSchema.safeParse({ title: '', settings }).success).toBe(false);
    expect(mediaPresetWriteSchema.safeParse({ title: 'x', settings, extra: 1 }).success).toBe(
      false,
    );
    expect(
      createMediaPresetSchema({ maxTitleChars: 3, maxInputs: 1 }).safeParse({
        title: 'Long',
        settings,
      }).success,
    ).toBe(false);
    expect(mediaPresetUpdateSchema.safeParse({}).success).toBe(false);
    expect(mediaPresetUpdateSchema.parse({ isDefault: true })).toEqual({ isDefault: true });
    expect(
      mediaPresetSchema.parse({
        schemaVersion: 1,
        presetId: 'preset-1',
        title: 'Studio look',
        isDefault: false,
        settings,
        createdAt: '2026-09-17T12:00:00.000Z',
        updatedAt: '2026-09-17T12:00:00.000Z',
      }).settings.parameters.count,
    ).toBe(2);
    expect(resolveMediaConfig().limits.maxPresets).toBe(50);
    expect(endpoints.mediaPreset('a b')).toBe('/api/media/presets/a%20b');
  });

  it('stores bounded preset reference IDs without accepting hosted references or client asset descriptors', () => {
    const input = { file_id: 'f17ecafe-0000-4000-8000-000000000001', role: 'reference' };
    const settings = {
      operation: 'image.generate',
      connectionId: 'images',
      modelId: 'gpt-image-1',
      inputs: [input],
    };
    const schema = createMediaPresetSchema({ maxTitleChars: 40, maxInputs: 1 });
    expect(schema.parse({ title: 'Reference', settings }).settings.inputs).toEqual([input]);
    expect(
      schema.safeParse({ title: 'Reference', settings: { ...settings, inputs: [input, input] } })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({
        title: 'Reference',
        settings: {
          ...settings,
          inputs: [{ ...input, sourceURL: 'https://example.com/reference.png' }],
        },
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ title: 'Reference', settings, assets: [] }).success).toBe(false);
  });

  it('canonicalizes omitted version, inputs and parameters', () => {
    expect(mediaSubmissionRequestSchema.parse(submission)).toMatchObject({
      schemaVersion: 1,
      inputs: [],
      parameters: { count: 1 },
    });
  });

  it('keeps provider image resolution distinct from pixel size', () => {
    expect(
      mediaSubmissionRequestSchema.parse({ ...submission, parameters: { resolution: '2K' } })
        .parameters,
    ).toEqual({ count: 1, resolution: '2K' });
  });

  it.each([
    { ...submission, apiKey: 'secret' },
    { ...submission, parameters: { addParams: { model: 'other-model' } } },
    { ...submission, operation: 'image.edit', inputs: [] },
    { ...submission, parentTurnId: 'turn-without-thread' },
    { ...submission, inputs: [{ role: 'video', file_id: 'file-1' }] },
    { ...submission, operation: 'video.generate', parameters: { background: 'transparent' } },
  ])('rejects invalid or untyped input %j', (request) => {
    expect(mediaSubmissionRequestSchema.safeParse(request).success).toBe(false);
  });

  it('enforces configured prompt/input/output/import bounds', () => {
    const limits = { maxPromptChars: 5, maxTitleChars: 5, maxInputs: 1, maxOutputs: 1 };
    const schema = createMediaSubmissionSchema(limits);
    expect(schema.safeParse(submission).success).toBe(false);
    expect(
      schema.safeParse({ ...submission, prompt: 'lake', parameters: { count: 2 } }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...submission,
        prompt: 'lake',
        inputs: [
          { role: 'reference', file_id: 'a' },
          { role: 'reference', file_id: 'b' },
        ],
      }).success,
    ).toBe(false);
    expect(
      createMediaImportSchema(limits).safeParse({
        clientRequestId: 'import-1',
        title: 'too long',
        inputs: [{ role: 'reference', file_id: 'a' }],
      }).success,
    ).toBe(false);
  });

  it('keeps stable preparing identity and distinguishes imports from generation', () => {
    const receipt = {
      schemaVersion: 1,
      clientRequestId: 'request-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      phase: 'preparing',
    };
    expect(mediaImportReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(mediaSubmissionReceiptSchema.safeParse(receipt).success).toBe(false);
    expect(mediaSubmissionReceiptSchema.parse({ ...receipt, jobId: 'job-1' })).toMatchObject({
      jobId: 'job-1',
    });
    expect(mediaImportReceiptSchema.safeParse({ ...receipt, jobId: 'job-1' }).success).toBe(false);
  });

  it('rejects invalid discrete numeric controls', () => {
    expect(
      mediaNumberControlSchema.parse({ min: 4, max: 8, values: [4, 6, 8], default: 6 }).values,
    ).toEqual([4, 6, 8]);
    expect(
      mediaNumberControlSchema.safeParse({ min: 4, max: 8, values: [4, 6, 8], default: 5 }).success,
    ).toBe(false);
  });

  it('keeps startup projection strict and permits only public key descriptors', () => {
    const startup = {
      enabled: false,
      studio: false,
      chat: false,
      canCreate: false,
      clientPollIntervalMs: 5_000,
      clientCatchUpIntervalMs: 30_000,
    };
    expect(mediaStartupConfigSchema.parse(startup)).toEqual(startup);
    const descriptor = {
      connectionId: 'studio',
      connectionName: 'Studio',
      userKey: { keyName: 'google', encoding: 'google', userProvideURL: false },
    };
    expect(
      mediaStartupConfigSchema.safeParse({ ...startup, integrations: [descriptor] }).success,
    ).toBe(true);
    expect(
      mediaStartupConfigSchema.safeParse({
        ...startup,
        integrations: [{ ...descriptor, apiKey: 'secret' }],
      }).success,
    ).toBe(false);
    expect(
      mediaStartupConfigSchema.safeParse({ ...startup, integrations: [integration] }).success,
    ).toBe(false);
    expect(mediaStartupConfigSchema.safeParse({ ...startup, apiKey: 'secret' }).success).toBe(
      false,
    );
  });

  it('accepts only same-origin or HTTP(S) asset paths, including rendition paths', () => {
    const asset = {
      file_id: 'asset',
      filename: 'result.png',
      type: 'image/png',
      bytes: 10,
      filepath: '/api/media/assets/asset/content',
    };
    const rendition = { filepath: '/api/media/assets/asset/content?rendition=thumbnail' };
    for (const filepath of [
      asset.filepath,
      '/images/user/result.png',
      'https://bucket.example/result.png',
    ]) {
      expect(mediaAssetSchema.safeParse({ ...asset, filepath }).success).toBe(true);
    }
    for (const filepath of [
      'javascript:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
    ]) {
      expect(mediaAssetSchema.safeParse({ ...asset, filepath }).success).toBe(false);
      expect(
        mediaAssetSchema.safeParse({
          ...asset,
          renditions: { thumbnail: { ...rendition, filepath, type: 'image/webp', bytes: 1 } },
        }).success,
      ).toBe(false);
    }
    expect(
      mediaAssetSchema.safeParse({
        ...asset,
        renditions: { thumbnail: { ...rendition, type: 'image/webp', bytes: 1 } },
      }).success,
    ).toBe(true);
  });

  it('encodes all dynamic endpoint identities and cursors', () => {
    expect(endpoints.mediaSubmission('a/b?c')).toContain('/submissions/a%2Fb%3Fc');
    expect(endpoints.mediaTurnJobs('a/b', 'c?d', { cursor: 'cursor&next', limit: 2 })).toContain(
      '/threads/a%2Fb/turns/c%3Fd/jobs?cursor=cursor%26next&limit=2',
    );
  });
});
