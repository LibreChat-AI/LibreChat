import { z } from 'zod';
import { createHash } from 'node:crypto';
import { validateMediaCapability } from 'librechat-data-provider';
import type {
  MediaCatalog,
  MediaCapability,
  MediaConfig,
  MediaIntegration,
  MediaOffering,
  MediaSubmissionRequest,
  MediaLimits,
  MediaUserKey,
  MediaErrorCode,
} from 'librechat-data-provider';
import type { MediaOwnerScope } from '@librechat/data-schemas';
import type { MediaTransport, MediaTransportRequest } from './transport';
import type { MediaConnection, MediaProviderAdapter } from './provider';
import type { ResolvedMediaOffering } from './discovery';
import type { MediaCatalogCache } from './catalogCache';
import { openAIImageCapabilities, openAIVideoCapabilities } from './adapters/openai';
import { vertexVideoCapabilities, vertexVideoModelName } from './adapters/veo';
import { googleImageCapabilities } from './adapters/google';
import { discoverOpenRouter } from './discovery';
import { MediaServiceError } from './errors';

type ResolvedOffering = ResolvedMediaOffering;
type MediaCatalogSnapshot = { catalog: MediaCatalog; resolved: Map<string, ResolvedOffering> };

function selectedModels(integration: MediaIntegration, available: Iterable<string>): string[] {
  if (integration.catalog.kind === 'configured') return integration.catalog.models;
  const models =
    integration.catalog.allModels && !integration.catalog.allowModels.length
      ? [...available]
      : integration.catalog.allowModels;
  const excluded = new Set(integration.catalog.excludeModels);
  return models.filter((model) => !excluded.has(model));
}

function nativeCapabilities(
  integration: MediaIntegration,
  modelId: string,
  config: MediaConfig,
): MediaCapability[] {
  if (integration.api === 'google.vertex.videos') {
    return vertexVideoCapabilities(modelId, config);
  }
  if (integration.api === 'openai.images') return openAIImageCapabilities(modelId, config);
  if (integration.api === 'openai.videos') return openAIVideoCapabilities(modelId);
  if (integration.api === 'google.generateContent') return googleImageCapabilities(modelId, config);
  return [];
}

export function createMediaCatalog({
  transport,
  adapters,
  now,
  cache: sharedCache,
}: {
  transport: MediaTransport;
  adapters: readonly MediaProviderAdapter[];
  now: () => number;
  cache?: MediaCatalogCache;
}) {
  const cache = new Map<string, { expires: number; value: ResolvedOffering[] }>();
  const pending = new Map<string, Promise<ResolvedOffering[]>>();
  const supported = new Set(adapters.map((adapter) => adapter.api));
  let activeRequests = 0;
  const waiting: Array<() => void> = [];

  async function discover<T>(
    request: MediaTransportRequest,
    schema: z.ZodType<T>,
    config: MediaConfig,
  ): Promise<T> {
    while (activeRequests >= config.catalog.maxConcurrentRequests) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    activeRequests++;
    try {
      return await transport.json(request, schema);
    } finally {
      activeRequests--;
      waiting.shift()?.();
    }
  }

  function store(key: string, value: ResolvedOffering[], config: MediaConfig) {
    cache.delete(key);
    for (const [entryKey, entry] of cache) {
      if (entry.expires <= now()) {
        cache.delete(entryKey);
      }
    }
    while (cache.size >= config.catalog.maxCacheEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      cache.delete(oldest);
    }
    cache.set(key, { expires: now() + config.catalog.refreshMs, value });
  }

  async function load(
    integration: MediaIntegration,
    connection: MediaConnection,
    config: MediaConfig,
  ): Promise<ResolvedOffering[]> {
    if (integration.api.startsWith('openrouter.')) {
      return discoverOpenRouter(integration, connection, config, (request, schema, config) =>
        discover(
          { ...request, allowedAddresses: connection.allowedAddresses ?? [] },
          schema,
          config,
        ),
      );
    }
    const profiles = new Map(
      adapters
        .find((adapter) => adapter.api === integration.api)
        ?.catalog?.(config)
        .map((profile) => [profile.modelId, profile]),
    );
    const models = selectedModels(integration, profiles.keys());
    if (models.length > config.catalog.maxModels)
      throw new MediaServiceError(
        'not_ready',
        422,
        'The model catalog exceeds its configured limit.',
      );
    return models.map((modelId) => {
      const profile = profiles.get(modelId);
      const capabilities =
        profile?.capabilities ?? nativeCapabilities(integration, modelId, config);
      const permitted = capabilities.filter((capability) =>
        integration.operations.includes(capability.operation),
      );
      const available = !profile?.unavailableReason && permitted.length > 0;
      return {
        bindingRevision: connection.binding,
        offering: {
          connectionId: integration.id,
          connectionName: integration.label ?? integration.id,
          modelId,
          modelName:
            profile?.modelName ??
            (integration.api === 'google.vertex.videos'
              ? vertexVideoModelName(modelId)
              : undefined) ??
            modelId,
          api: integration.api,
          available,
          capabilities: available ? permitted : [],
          ...(!available
            ? { unavailableReason: profile?.unavailableReason ?? ('unsupported' as const) }
            : {}),
        },
      };
    });
  }

  return {
    async read(
      config: MediaConfig,
      resolve: (integration: MediaIntegration) => Promise<MediaConnection>,
      scope: MediaOwnerScope,
      describeUserKey?: (integration: MediaIntegration) => MediaUserKey | undefined,
    ): Promise<MediaCatalogSnapshot> {
      const configured = config.integrations.filter((integration) => integration.enabled !== false);
      const resolutionErrors = new Map<string, MediaErrorCode>();
      const results = await Promise.all(
        configured.map(async (integration): Promise<ResolvedOffering[]> => {
          const models = selectedModels(
            integration,
            adapters
              .find((adapter) => adapter.api === integration.api)
              ?.catalog?.(config)
              .map((profile) => profile.modelId) ?? [],
          );
          try {
            if (!supported.has(integration.api)) {
              throw new MediaServiceError('unsupported', 422, 'Unsupported media API');
            }
            const connection = await resolve(integration);
            const key = createHash('sha256')
              .update(
                JSON.stringify({
                  // Discovery is per credential, not per user: resolved headers carry any user
                  // templating, and user-owned keys already bind to their owner.
                  tenantId: scope.tenantId ?? null,
                  headers: connection.headers,
                  integration,
                  binding: connection.binding,
                  routing: connection.routing,
                  allowedAddresses: connection.allowedAddresses ?? [],
                  cancellation: config.cancellation,
                  limits: config.limits,
                  catalog: config.catalog,
                }),
              )
              .digest('hex');
            const current = sharedCache ? await sharedCache.get(key) : cache.get(key);
            if (current && current.expires > now()) {
              if (!sharedCache) {
                cache.delete(key);
                cache.set(key, current);
              }
              return current.value;
            }
            let work = pending.get(key);
            if (!work) {
              if (pending.size >= config.catalog.maxCacheEntries) {
                throw new MediaServiceError('not_ready', 503, 'The media catalog is busy.');
              }
              work = load(integration, connection, config)
                .then(async (value) => {
                  if (sharedCache)
                    await sharedCache.set(
                      key,
                      { expires: now() + config.catalog.refreshMs, value },
                      config.catalog.refreshMs,
                    );
                  else store(key, value, config);
                  return value;
                })
                .finally(() => pending.delete(key));
              pending.set(key, work);
            }
            return await work;
          } catch (error) {
            const code =
              error instanceof MediaServiceError &&
              (error.code === 'credentials_required' ||
                error.code === 'gemini_key_required' ||
                error.code === 'credentials_expired' ||
                error.code === 'unsupported')
                ? error.code
                : 'not_ready';
            resolutionErrors.set(integration.id, code);
            return models.map((modelId) => ({
              offering: {
                connectionId: integration.id,
                connectionName: integration.label ?? integration.id,
                modelId,
                modelName: modelId,
                api: integration.api,
                available: false,
                unavailableReason: code,
                capabilities: [],
              },
            }));
          }
        }),
      );
      const entries = results.flat();
      const integrations = configured.map((integration, index) => {
        let userKey: MediaUserKey | undefined;
        try {
          userKey = describeUserKey?.(integration);
        } catch {
          /* Invalid configuration stays unavailable. */
        }
        return {
          connectionId: integration.id,
          connectionName: integration.label ?? integration.id,
          api: integration.api,
          ...(userKey ? { userKey } : {}),
          available: results[index].some((entry) => entry.offering.available),
          ...(!results[index].some((entry) => entry.offering.available)
            ? {
                unavailableReason:
                  resolutionErrors.get(integration.id) ??
                  results[index][0]?.offering.unavailableReason ??
                  ('not_ready' as const),
              }
            : {}),
        };
      });
      const version = createHash('sha256')
        .update(JSON.stringify({ scope, entries, integrations, limits: config.limits }))
        .digest('hex');
      return {
        catalog: {
          schemaVersion: 1,
          version,
          offerings: entries.map((entry) => entry.offering),
          limits: config.limits,
          integrations,
        },
        resolved: new Map(
          entries.map((entry) => [
            `${entry.offering.connectionId}:${entry.offering.modelId}`,
            entry,
          ]),
        ),
      };
    },
  };
}

export function selectMediaRoute(
  selected: ResolvedMediaOffering,
  providerTag?: string,
): ResolvedMediaOffering {
  if (!providerTag) return selected;
  const route = selected.offering.routes?.find((entry) => entry.providerTag === providerTag);
  if (!route)
    throw new MediaServiceError('unsupported', 422, 'This provider route is unavailable.');
  return {
    ...selected,
    providerTag,
    offering: { ...selected.offering, capabilities: route.capabilities },
  };
}

export function validateMediaOffering(
  request: MediaSubmissionRequest,
  offering: MediaOffering,
  limits?: MediaLimits,
): MediaCapability {
  const capability = offering.capabilities.find((entry) => entry.operation === request.operation);
  if (!offering.available || !capability) {
    throw new MediaServiceError('unsupported', 422, 'This operation is not available.');
  }
  const [issue] = validateMediaCapability(request, capability, limits);
  if (issue) throw new MediaServiceError(issue.code, 422, issue.message);
  return capability;
}
