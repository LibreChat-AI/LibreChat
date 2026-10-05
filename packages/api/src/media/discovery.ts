import { z } from 'zod';
import type {
  MediaCapability,
  MediaConfig,
  MediaIntegration,
  MediaOffering,
  MediaNumberControl,
} from 'librechat-data-provider';
import type { MediaTransportRequest } from './transport';
import type { MediaConnection } from './provider';
import { mediaRouteAllowed, mediaRoutePriority, mediaVideoPolicySupported } from './routing';
import { MediaServiceError } from './errors';
import { mediaAPIURL } from './provider';

export type ResolvedMediaOffering = {
  offering: MediaOffering;
  providerTag?: string;
  bindingRevision?: string;
};
export type MediaCatalogFetch = <T>(
  request: MediaTransportRequest,
  schema: z.ZodType<T>,
  config: MediaConfig,
) => Promise<T>;

const descriptor = z.discriminatedUnion('type', [
  z.object({ type: z.literal('enum'), values: z.array(z.union([z.string(), z.number()])) }),
  z.object({ type: z.literal('range'), min: z.number(), max: z.number() }),
  z.object({ type: z.literal('boolean') }),
]);
const imageParameters = z.object({
  n: descriptor.optional(),
  input_references: descriptor.optional(),
  size: descriptor.optional(),
  aspect_ratio: descriptor.optional(),
  resolution: descriptor.optional(),
  quality: descriptor.optional(),
  output_format: descriptor.optional(),
  output_compression: descriptor.optional(),
  background: descriptor.optional(),
  seed: descriptor.optional(),
});
const imageIndex = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string().optional() })),
});
const imageEndpoints = z.object({
  id: z.string(),
  endpoints: z.array(
    z.object({
      provider_tag: z.string().nullable().optional(),
      provider_name: z.string().nullable().optional(),
      supported_parameters: imageParameters,
      allowed_passthrough_parameters: z.array(z.string()).optional(),
    }),
  ),
});
const videoModel = z.object({
  id: z.string(),
  name: z.string().optional(),
  supported_durations: z.array(z.number()).nullish(),
  supported_resolutions: z.array(z.string()).nullish(),
  supported_aspect_ratios: z.array(z.string()).nullish(),
  supported_sizes: z.array(z.string()).nullish(),
  supported_frame_images: z.array(z.string()).nullish(),
  generate_audio: z.boolean().nullish(),
  seed: z.boolean().nullish(),
  upscale_factor: z.object({ min: z.number(), max: z.number() }).nullish(),
  creativity: z.array(z.number()).nullish(),
  allowed_passthrough_parameters: z.array(z.string()).nullish(),
});
const videoIndex = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string().optional() }).passthrough()),
});
const generalIndex = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      architecture: z.object({ input_modalities: z.array(z.string()) }),
    }),
  ),
  links: z.object({ next: z.string().nullish() }).nullish(),
});
const generalEndpoints = z.object({
  data: z.object({
    endpoints: z.array(
      z.object({
        tag: z.string().optional(),
        provider_name: z.string().optional(),
      }),
    ),
  }),
});

const enumeration = (value?: z.infer<typeof descriptor>) =>
  value?.type === 'enum' && value.values.length ? { values: value.values.map(String) } : undefined;
const choices = (values?: string[] | null) => (values?.length ? { values } : undefined);
function numbers(value?: z.infer<typeof descriptor>): MediaNumberControl | undefined {
  if (value?.type === 'range') return { min: value.min, max: value.max };
  if (
    value?.type !== 'enum' ||
    !value.values.length ||
    value.values.some((v) => typeof v !== 'number')
  )
    return;
  const values = value.values.map(Number);
  return { min: Math.min(...values), max: Math.max(...values), values };
}
const numericChoices = (values?: number[] | null) =>
  values?.length ? { min: Math.min(...values), max: Math.max(...values), values } : undefined;

function openRouterImageCapabilities(
  parameters: z.infer<typeof imageParameters>,
  integration: MediaIntegration,
  config: MediaConfig,
  modelId: string,
  providerOptions?: string[],
): MediaCapability[] {
  const reference = numbers(parameters.input_references);
  const format = enumeration(parameters.output_format);
  const resolution = enumeration(parameters.resolution);
  if (modelId === 'bytedance-seed/seedream-4.5' && resolution) {
    /** Seedream 4.5 rejects the 1K tier still advertised in the upstream catalog. */
    resolution.values = resolution.values.filter((value) => value !== '1K');
    if (!resolution.values.length) return [];
  }
  const controls = {
    count: numbers(parameters.n) ?? { min: 1, max: 1 },
    size: enumeration(parameters.size),
    resolution,
    aspectRatio: enumeration(parameters.aspect_ratio),
    quality: enumeration(parameters.quality),
    format,
    background: enumeration(parameters.background),
    outputCompression: parameters.output_compression
      ? (numbers(parameters.output_compression) ?? { min: 0, max: 100 })
      : undefined,
    seed: parameters.seed
      ? (numbers(parameters.seed) ?? { min: 0, max: 2_147_483_647 })
      : undefined,
    providerOptions: providerOptions?.length ? providerOptions : undefined,
  };
  controls.count.max = Math.min(controls.count.max, config.limits.maxOutputs);
  if (controls.count.values)
    controls.count.values = controls.count.values.filter((v) => v <= controls.count.max);
  if (controls.count.min > controls.count.max || controls.count.values?.length === 0) return [];
  return integration.operations.flatMap((operation): MediaCapability[] => {
    if (operation === 'video.generate' || (operation === 'image.edit' && !reference?.max))
      return [];
    const min = Math.max(reference?.min ?? 0, operation === 'image.edit' ? 1 : 0);
    const max = Math.min(reference?.max ?? 0, config.limits.maxInputs);
    if (min > max) return [];
    return [
      {
        operation,
        controls,
        inputs: { roles: max ? ['reference'] : [], min, max },
        execution: { kind: 'direct', previews: false },
      },
    ];
  });
}

function videoCapabilities(
  entry: z.infer<typeof videoModel>,
  modalities: string[],
  config: MediaConfig,
): MediaCapability[] {
  const roles: Array<'reference' | 'start_frame' | 'end_frame' | 'video' | 'audio'> = [];
  if (modalities.includes('image')) roles.push('reference');
  if (entry.supported_frame_images?.includes('first_frame')) roles.push('start_frame');
  if (entry.supported_frame_images?.includes('last_frame')) roles.push('end_frame');
  if (modalities.includes('video')) roles.push('video');
  if (modalities.includes('audio')) roles.push('audio');
  let workflow: MediaCapability['workflow'] = 'generate';
  const requiredRoles: typeof roles = [];
  if (entry.upscale_factor) workflow = 'upscale';
  else if (['black-forest-labs/flux-video-edit', 'runway/aleph-2'].includes(entry.id))
    workflow = 'edit';
  else if (entry.id === 'heygen/avatar-iv') workflow = 'avatar';
  if (workflow === 'upscale' || workflow === 'edit') requiredRoles.push('video');
  else if (workflow === 'avatar') requiredRoles.push('reference', 'audio');
  if (requiredRoles.length > config.limits.maxInputs) return [];
  for (const role of requiredRoles) if (!roles.includes(role)) roles.push(role);
  return [
    {
      operation: 'video.generate',
      workflow,
      inputs: {
        roles,
        requiredRoles,
        hostedRoles: roles.filter(
          (role): role is 'video' | 'audio' => role === 'video' || role === 'audio',
        ),
        min: requiredRoles.length,
        max: roles.length ? config.limits.maxInputs : 0,
      },
      execution: { kind: 'remote-job', cancellation: 'unsupported' },
      controls: {
        count: { min: 1, max: 1 },
        durationSeconds: numericChoices(entry.supported_durations),
        resolution: choices(entry.supported_resolutions),
        aspectRatio: choices(entry.supported_aspect_ratios),
        size: choices(entry.supported_sizes),
        upscaleFactor: entry.upscale_factor ?? undefined,
        creativity: numericChoices(entry.creativity),
        audio: (entry.generate_audio && !entry.id.startsWith('openai/sora-')) || undefined,
        seed: entry.seed ? { min: 0, max: 2_147_483_647 } : undefined,
        providerOptions: entry.allowed_passthrough_parameters?.length
          ? entry.allowed_passthrough_parameters
          : undefined,
      },
    },
  ];
}

export async function discoverOpenRouter(
  integration: MediaIntegration,
  connection: MediaConnection,
  config: MediaConfig,
  fetch: MediaCatalogFetch,
): Promise<ResolvedMediaOffering[]> {
  const request = (path: string) => ({
    url: mediaAPIURL(connection, path),
    headers: connection.headers,
    timeoutMs: config.catalog.requestTimeoutMs,
    maxBytes: config.catalog.maxResponseBytes,
  });
  const images = integration.api === 'openrouter.images';
  let index: z.infer<typeof videoIndex>;
  if (images && integration.catalog.kind === 'configured') {
    index = { data: integration.catalog.models.map((id) => ({ id })) };
  } else if (images) {
    index = await fetch(request('images/models'), imageIndex, config);
  } else {
    index = await fetch(request('videos/models'), videoIndex, config);
  }
  const byId = new Map(index.data.map((model) => [model.id, model]));
  const configured =
    integration.catalog.kind === 'configured'
      ? integration.catalog.models
      : integration.catalog.allowModels;
  const all = integration.catalog.kind === 'discovered' && integration.catalog.allModels;
  const excluded = new Set(
    integration.catalog.kind === 'discovered' ? integration.catalog.excludeModels : [],
  );
  const selected = (all && !configured.length ? [...byId.keys()] : configured).filter(
    (id) => !excluded.has(id),
  );
  if (selected.length > config.catalog.maxModels)
    throw new MediaServiceError(
      'not_ready',
      422,
      'The discovered model catalog exceeds its configured limit.',
    );
  const modalities = new Map<string, string[]>();
  if (!images) {
    let url: string | undefined = request('models?output_modalities=video').url;
    const visited = new Set<string>();
    while (url) {
      const target = new URL(url),
        root = new URL(connection.baseURL);
      if (
        target.origin !== root.origin ||
        target.username ||
        target.password ||
        target.hash ||
        !target.pathname.startsWith(root.pathname.replace(/\/$/, '') + '/') ||
        visited.has(url)
      ) {
        throw new MediaServiceError('not_ready', 422, 'Invalid catalog pagination.');
      }
      visited.add(url);
      const page: z.infer<typeof generalIndex> = await fetch(
        { ...request('models'), url },
        generalIndex,
        config,
      );
      for (const model of page.data)
        if (byId.has(model.id)) modalities.set(model.id, model.architecture.input_modalities);
      if (visited.size > config.catalog.maxModels)
        throw new MediaServiceError(
          'not_ready',
          422,
          'Catalog pagination exceeds its configured limit.',
        );
      url = page.links?.next ? new URL(page.links.next, url).href : undefined;
    }
  }
  const results: ResolvedMediaOffering[] = [];
  for (let offset = 0; offset < selected.length; offset += config.catalog.maxConcurrentRequests) {
    const batch = await Promise.all(
      selected.slice(offset, offset + config.catalog.maxConcurrentRequests).map(async (modelId) => {
        const model = byId.get(modelId);
        const offering: MediaOffering = {
          connectionId: integration.id,
          connectionName: integration.label ?? integration.id,
          modelId,
          modelName: model?.name ?? modelId,
          api: integration.api,
          available: false,
          capabilities: [],
          unavailableReason: 'unsupported',
        };
        let providerTag: string | undefined;
        try {
          if (!model) return { offering, bindingRevision: connection.binding };
          const encoded = modelId.split('/').map(encodeURIComponent).join('/');
          if (images) {
            const endpoints = await fetch(
              request(`images/models/${encoded}/endpoints`),
              imageEndpoints,
              config,
            );
            if (endpoints.id !== modelId)
              throw new MediaServiceError('not_ready', 422, 'Catalog model mismatch.');
            const routes = endpoints.endpoints
              .filter(
                (endpoint) =>
                  (endpoint.provider_tag != null || endpoints.endpoints.length === 1) &&
                  mediaRouteAllowed(endpoint.provider_tag ?? undefined, connection.routing),
              )
              .sort(
                (left, right) =>
                  mediaRoutePriority(left.provider_tag ?? undefined, connection.routing) -
                  mediaRoutePriority(right.provider_tag ?? undefined, connection.routing),
              );
            offering.routes = routes.flatMap((endpoint) => {
              if (!endpoint.provider_tag) return [];
              const capabilities = openRouterImageCapabilities(
                endpoint.supported_parameters,
                integration,
                config,
                modelId,
                endpoint.allowed_passthrough_parameters,
              );
              return capabilities.length
                ? [
                    {
                      providerTag: endpoint.provider_tag,
                      providerName: endpoint.provider_name ?? endpoint.provider_tag,
                      capabilities,
                    },
                  ]
                : [];
            });
            const first = offering.routes[0];
            providerTag = first?.providerTag;
            offering.defaultProviderTag = providerTag;
            offering.capabilities =
              first?.capabilities ??
              (routes[0]
                ? openRouterImageCapabilities(
                    routes[0].supported_parameters,
                    integration,
                    config,
                    modelId,
                  )
                : []);
          } else if (mediaVideoPolicySupported(connection.routing)) {
            const video = videoModel.parse(model);
            const endpoints = await fetch(
              request(`models/${encoded}/endpoints`),
              generalEndpoints,
              config,
            );
            /** Video routing isn't part of the documented API. These tags scope provider options only. */
            const tags = [
              ...new Set(
                endpoints.data.endpoints
                  .map((endpoint) => endpoint.tag?.split('/')[0])
                  .filter((tag): tag is string => !!tag),
              ),
            ];
            providerTag = tags.length === 1 ? tags[0] : undefined;
            offering.capabilities = videoCapabilities(video, modalities.get(modelId) ?? [], config);
            if (!providerTag)
              offering.capabilities = offering.capabilities.map((capability) => ({
                ...capability,
                controls: { ...capability.controls, providerOptions: undefined },
              }));
          }
          offering.available = offering.capabilities.length > 0;
          if (offering.available) delete offering.unavailableReason;
        } catch {
          offering.available = false;
          offering.capabilities = [];
          offering.routes = [];
          offering.unavailableReason = 'not_ready';
        }
        return { offering, providerTag, bindingRevision: connection.binding };
      }),
    );
    results.push(...batch);
  }
  return results;
}
