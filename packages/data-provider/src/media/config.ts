import { z } from 'zod';
import {
  MEDIA_SCHEMA_VERSION,
  mediaApiSchema,
  mediaIdSchema,
  mediaOperationSchema,
} from './requests';
import { MEDIA_PROVIDER_DIAGNOSTIC_MESSAGE_MAX_CHARS } from './responses';
import { mediaLimitsSchema } from './capabilities';
import { TOKEN_CREDITS_PER_USD } from '../balance';
import { fileStorageSchema } from '../storage';
import { EModelEndpoint } from '../schemas';

const milliseconds = z.number().int().positive().max(604_800_000);
const capacity = z.number().int().positive().max(1_000_000);
const configuredString = z.string().trim().min(1);
export const mediaConnectionOptionsSchema = z
  .object({
    deployments: z.record(configuredString, configuredString).optional(),
    brandId: configuredString.optional(),
  })
  .strict();
export type MediaProviderOptions = z.infer<typeof mediaConnectionOptionsSchema>;

/** Provider connection options are validated both before and after environment expansion. */
export function mediaOptionsSchema(api: z.infer<typeof mediaApiSchema>, allowEnvironment = false) {
  return mediaConnectionOptionsSchema.superRefine((options, ctx) => {
    if (
      options.deployments &&
      !['openai.images', 'openai.responses', 'openai.videos', 'microsoft.images'].includes(api)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['deployments'],
        message: 'Deployment mappings require an OpenAI or Microsoft API',
      });
    if (api === 'sourceful.images') {
      const valid =
        z.string().uuid().safeParse(options.brandId).success ||
        (allowEnvironment && /^\$\{[A-Z_][A-Z0-9_]*\}$/.test(options.brandId ?? ''));
      if (!valid)
        ctx.addIssue({
          code: 'custom',
          path: ['brandId'],
          message: 'Sourceful requires a UUID brandId',
        });
    } else if (options.brandId !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['brandId'],
        message: 'brandId is only supported by Sourceful',
      });
  });
}
export const mediaIntegrationSchema = z
  .object({
    id: mediaIdSchema,
    label: z.string().trim().min(1).optional(),
    /** Omission preserves availability; false excludes new work while retaining job recovery. */
    enabled: z.boolean().optional(),
    api: mediaApiSchema,
    endpointRef: z.discriminatedUnion('kind', [
      /** Builtin Google uses GOOGLE_KEY, then GEMINI_API_KEY; user_provided selects the saved Google envelope. Service accounts use kind: vertex. */
      z.object({ kind: z.literal('builtin'), endpoint: z.nativeEnum(EModelEndpoint) }).strict(),
      z.object({ kind: z.literal('custom'), name: z.string().trim().min(1) }).strict(),
      z
        .object({
          kind: z.literal('direct'),
          apiKey: z.string().min(1),
          baseURL: z.string().trim().min(1).optional(),
          credentialName: mediaIdSchema.optional(),
          headers: z.record(z.string(), z.string()).optional(),
          options: mediaConnectionOptionsSchema.optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('vertex'),
          /** Uses the shared file/URL/base64/JSON loader; omitted tries GOOGLE_SERVICE_KEY_FILE, the host auth.json path, then application default credentials. */
          keyFile: z.string().trim().min(1).optional(),
          projectId: z.string().trim().min(1).optional(),
          location: z
            .string()
            .regex(/^[a-z][a-z0-9-]*$/)
            .optional(),
        })
        .strict(),
    ]),
    /** Selection policy, not a network toggle: OpenRouter enriches remotely; native adapters use static profiles. Configured images fetch selected endpoint documents; videos also need provider indexes. */
    catalog: z.discriminatedUnion('kind', [
      z
        .object({ kind: z.literal('configured'), models: z.array(mediaIdSchema).default([]) })
        .strict(),
      z
        .object({
          kind: z.literal('discovered'),
          allowModels: z.array(mediaIdSchema).default([]),
          allModels: z.boolean().default(false),
          excludeModels: z.array(mediaIdSchema).default([]),
        })
        .strict(),
    ]),
    operations: z.array(mediaOperationSchema).min(1),
    billing: z
      .object({
        /** Defaults to the existing balance currency; explicit legacy rates remain supported. */
        creditsPerUSD: z.number().finite().positive().default(TOKEN_CREDITS_PER_USD),
        estimatedCostUSD: z.number().finite().nonnegative().optional(),
        maxCostUSD: z.number().finite().positive().optional(),
      })
      .strict()
      .superRefine((billing, ctx) => {
        if (
          billing.estimatedCostUSD !== undefined &&
          billing.maxCostUSD !== undefined &&
          billing.estimatedCostUSD > billing.maxCostUSD
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['estimatedCostUSD'],
            message: 'Estimated cost cannot exceed the maximum',
          });
        }
        for (const field of ['estimatedCostUSD', 'maxCostUSD'] as const) {
          const cost = billing[field];
          if (cost === undefined) continue;
          const credits = cost * billing.creditsPerUSD;
          if (
            !Number.isFinite(credits) ||
            credits > Number.MAX_SAFE_INTEGER ||
            (cost > 0 && credits === 0)
          ) {
            ctx.addIssue({
              code: 'custom',
              path: [field],
              message: 'Converted cost must fit within the supported token-credit range',
            });
          }
        }
      })
      .optional(),
  })
  .strict()
  .superRefine((integration, ctx) => {
    if (integration.api === 'google.interactions')
      ctx.addIssue({
        code: 'custom',
        path: ['api'],
        message: 'Google Interactions has no media adapter',
      });
    const options =
      integration.endpointRef.kind === 'direct' ? integration.endpointRef.options : undefined;
    const parsedOptions = mediaOptionsSchema(integration.api, true).safeParse(options ?? {});
    if (!parsedOptions.success)
      for (const issue of parsedOptions.error.issues)
        ctx.addIssue({ ...issue, path: ['endpointRef', 'options', ...issue.path] });
    if (integration.endpointRef.kind === 'builtin') {
      const endpoint = integration.endpointRef.endpoint;
      if (endpoint !== EModelEndpoint.openAI && endpoint !== EModelEndpoint.google) {
        ctx.addIssue({
          code: 'custom',
          path: ['endpointRef'],
          message: 'Built-in media credentials support only the OpenAI and Google endpoints',
        });
      }
    }
    if (
      (integration.api === 'google.vertex.videos' && integration.endpointRef.kind !== 'vertex') ||
      (integration.endpointRef.kind === 'vertex' &&
        !['google.generateContent', 'google.vertex.videos'].includes(integration.api))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['endpointRef'],
        message: 'Vertex credentials require a supported native Google API',
      });
    }
    if (integration.endpointRef.kind === 'vertex' && integration.catalog.kind !== 'configured') {
      ctx.addIssue({
        code: 'custom',
        path: ['catalog'],
        message: 'Vertex media requires explicitly configured models',
      });
    }
    const videoOnly = integration.api.endsWith('.videos');
    const imageOnly =
      integration.api.endsWith('.images') || integration.api === 'google.generateContent';
    if (
      integration.operations.some((operation) =>
        videoOnly ? operation !== 'video.generate' : imageOnly && operation === 'video.generate',
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['operations'],
        message: 'Operation is incompatible with the API',
      });
    }
    if (new Set(integration.operations).size !== integration.operations.length) {
      ctx.addIssue({ code: 'custom', path: ['operations'], message: 'Operations must be unique' });
    }
  });

export const mediaConfigSchema = z
  .object({
    schemaVersion: z.literal(MEDIA_SCHEMA_VERSION).default(MEDIA_SCHEMA_VERSION),
    enabled: z.boolean().default(false),
    surfaces: z
      .object({
        studio: z.boolean().default(true),
        chat: z.boolean().default(true),
        tools: z.boolean().default(false),
      })
      .strict()
      .default({}),
    integrations: z.array(mediaIntegrationSchema).default([]),
    tools: z
      .object({
        imageTimeoutMs: milliseconds.max(3_600_000).default(120_000),
        pollIntervalMs: milliseconds.min(100).max(60_000).default(1_000),
      })
      .strict()
      .default({}),
    cancellation: z
      .object({ enabled: z.boolean().default(true) })
      .strict()
      .default({}),
    limits: mediaLimitsSchema.default({}),
    accounting: z
      .object({
        shortfall: z.enum(['debt', 'absorb']).default('debt'),
        maxHoldsPerUser: z.number().int().positive().max(10_000).default(128),
        maxAttempts: z.number().int().positive().max(1_000).default(20),
      })
      .strict()
      .default({}),
    catalog: z
      .object({
        refreshMs: milliseconds.default(900_000),
        requestTimeoutMs: milliseconds.default(10_000),
        maxResponseBytes: z.number().int().positive().max(104_857_600).default(10_485_760),
        maxConcurrentRequests: z.number().int().positive().max(100).default(4),
        maxModels: z.number().int().positive().max(10_000).default(256),
        maxCacheEntries: z.number().int().positive().max(10_000).default(256),
      })
      .strict()
      .default({}),
    queue: z
      .object({
        maxPendingPerUser: capacity.default(20),
        maxPendingTotal: capacity.default(200),
        maxQueueAgeMs: milliseconds.default(3_600_000),
        deniedRequeueMs: milliseconds.default(5_000),
      })
      .strict()
      .default({}),
    execution: z
      .object({
        maxActivePerUser: capacity.default(2),
        maxActivePerIntegration: capacity.default(4),
        maxActiveTotal: capacity.default(8),
      })
      .strict()
      .default({}),
    worker: z
      .object({
        tickMs: milliseconds.default(1_000),
        scanFailureThreshold: z.number().int().positive().max(1000).default(3),
        maintenanceIntervalMs: milliseconds.default(30_000),
        maintenanceJitterMs: z.number().int().nonnegative().max(60_000).default(2_000),
        leaseMs: milliseconds.default(60_000),
        takeoverSkewMs: z.number().int().nonnegative().max(60_000).default(30_000),
        renewEveryMs: milliseconds.default(20_000),
        shutdownTimeoutMs: milliseconds.default(10_000),
        shutdownCleanupMs: milliseconds.default(1_000),
      })
      .strict()
      .default({}),
    events: z
      .object({
        enabled: z.boolean().default(true),
        heartbeatMs: milliseconds.default(15_000),
        demandTtlMs: milliseconds.default(45_000),
        demandCacheMs: milliseconds.default(250),
      })
      .strict()
      .refine((value) => value.demandTtlMs > value.heartbeatMs, 'Demand must outlive its heartbeat')
      .default({}),
    polling: z
      .object({
        providerIntervalMs: milliseconds.default(30_000),
        clientIntervalMs: milliseconds.default(5_000),
        clientCatchUpIntervalMs: milliseconds.default(30_000),
      })
      .strict()
      .default({}),
    timeouts: z
      .object({
        submitMs: milliseconds.default(300_000),
        pollRequestMs: milliseconds.default(10_000),
        downloadMs: milliseconds.default(120_000),
      })
      .strict()
      .default({}),
    recovery: z
      .object({
        attentionAfterMs: milliseconds.default(86_400_000),
        maxAttempts: z.number().int().positive().max(10_000).default(24),
        maxRetryMs: milliseconds.default(1_800_000),
        maxEvidenceChars: z.number().int().positive().max(65_536).default(2_000),
        /** Bounds the provider message retained for owner-scoped failure diagnostics. */
        maxDiagnosticMessageChars: z
          .number()
          .int()
          .positive()
          .max(MEDIA_PROVIDER_DIAGNOSTIC_MESSAGE_MAX_CHARS)
          .default(2_000),
        /** Bounds HTTP error bodies inspected for diagnostics, independently of media output size. */
        maxDiagnosticResponseBytes: z.number().int().positive().max(1_048_576).default(16_384),
        maxDecisionsPerJob: z.number().int().positive().max(1_000).default(32),
      })
      .strict()
      .default({}),
    credentials: z
      .object({ minValidityAtDispatchMs: milliseconds.default(60_000) })
      .strict()
      .default({}),
    transfers: z
      .object({
        maxImageBytes: z.number().int().positive().max(1_073_741_824).default(20_971_520),
        maxVideoBytes: z.number().int().positive().max(10_737_418_240).default(536_870_912),
        maxAudioBytes: z.number().int().positive().max(1_073_741_824).default(20_971_520),
        maxRedirects: z.number().int().nonnegative().max(10).default(3),
      })
      .strict()
      .default({}),
    assets: z
      .object({
        source: fileStorageSchema.nullable().default(null),
        retention: z.literal('inherit').default('inherit'),
        orphanRetentionMs: milliseconds.default(86_400_000),
        /** Retain a deleted owner fence after its live metadata is gone. Minimal object-write cleanup receipts remain durable. */
        deletedAccountRetentionMs: milliseconds.default(604_800_000),
        derivatives: z
          .object({
            enabled: z.boolean().default(true),
            maxWidth: z.number().int().min(2).max(4_096).default(640),
            maxHeight: z.number().int().min(2).max(4_096).default(640),
            timeoutMs: milliseconds.max(3_600_000).default(120_000),
            ffmpegPath: z.string().trim().min(1).default('ffmpeg'),
            transcodeVideo: z.boolean().default(false),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    /**
     * LLM-generated Studio thread titles. A new thread first receives the prompt bounded to
     * `limits.maxTitleChars`; when a text model is configured, the server then asks it for a short
     * title in the background and replaces the prompt-derived one unless the user renamed the
     * thread first. `endpoint` falls back to `endpoints.all.titleEndpoint`, and `model` to
     * `endpoints.all.titleModel`, then the resolved endpoint's own `titleModel`. Without an
     * endpoint or model the prompt-derived title stands, so an unconfigured deployment keeps
     * today's behavior even though `enabled` defaults on.
     */
    titles: z
      .object({
        enabled: z.boolean().default(true),
        endpoint: z.string().trim().min(1).optional(),
        model: z.string().trim().min(1).optional(),
        prompt: z.string().trim().min(1).optional(),
        timeoutMs: milliseconds.default(45_000),
        /** Estimates title output for the shared balance reservation; does not cap model output. */
        maxOutputTokens: capacity.default(128),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    const fail = (path: string[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (
      config.enabled &&
      !config.integrations.some((integration) =>
        integration.catalog.kind === 'configured'
          ? integration.catalog.models.length > 0
          : integration.catalog.allModels || integration.catalog.allowModels.length > 0,
      )
    ) {
      fail(
        ['integrations'],
        'Enabled media requires configured models, an allowlist, or explicit all-model discovery',
      );
    }
    if (
      new Set(config.integrations.map((integration) => integration.id)).size !==
      config.integrations.length
    ) {
      fail(['integrations'], 'Integration IDs must be unique');
    }
    const modelCount = config.integrations.reduce(
      (count, integration) =>
        count +
        (integration.catalog.kind === 'configured'
          ? integration.catalog.models.length
          : integration.catalog.allowModels.length),
      0,
    );
    if (modelCount > config.catalog.maxModels) {
      fail(['integrations'], 'Configured model offerings exceed the catalog limit');
    }
    if (config.worker.renewEveryMs >= config.worker.leaseMs) {
      fail(['worker', 'renewEveryMs'], 'Lease renewal must precede expiry');
    }
    if (
      config.execution.maxActivePerUser > config.execution.maxActiveTotal ||
      config.execution.maxActivePerIntegration > config.execution.maxActiveTotal
    ) {
      fail(['execution'], 'Scoped concurrency cannot exceed total concurrency');
    }
    if (config.queue.maxPendingPerUser > config.queue.maxPendingTotal) {
      fail(['queue'], 'Per-user backlog cannot exceed total backlog');
    }
    if (config.polling.clientIntervalMs > config.polling.clientCatchUpIntervalMs) {
      fail(['polling'], 'Catch-up polling cannot be faster than active polling');
    }
  });

export type MediaIntegration = z.infer<typeof mediaIntegrationSchema>;
export type MediaConfig = z.infer<typeof mediaConfigSchema>;
export type MediaConfigInput = z.input<typeof mediaConfigSchema>;

/** Parse once after effective configuration assembly; absence preserves disabled behavior. */
export function resolveMediaConfig(config?: MediaConfigInput): MediaConfig {
  return mediaConfigSchema.parse(config ?? {});
}
