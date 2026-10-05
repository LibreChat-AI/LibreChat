import { z } from 'zod';
import sharp from 'sharp';
import { Readable } from 'node:stream';
import type { MediaCapability, MediaConfig } from 'librechat-data-provider';
import type { MediaProviderAdapter, MediaProviderContext, MediaProviderResult } from '../provider';
import { mediaDiagnosticSecrets, sanitizeMediaProviderDiagnostic } from '../diagnostics';
import { MediaProviderError } from '../errors';
import { nativeParameters } from './native';
import { mediaAPIURL } from '../provider';

/** Protocol limits for documented Veo 3.1 models, including the Lite preview. */
const models = new Map([
  ['veo-3.1-fast-generate-001', 'Veo 3.1 Fast'],
  ['veo-3.1-lite-generate-001', 'Veo 3.1 Lite'],
  ['veo-3.1-generate-001', 'Veo 3.1'],
]);

const aliases = new Map([
  ['google/veo-3.1-fast', 'veo-3.1-fast-generate-001'],
  ['google/veo-3.1-lite', 'veo-3.1-lite-generate-001'],
  ['google/veo-3.1', 'veo-3.1-generate-001'],
]);

function nativeModel(modelId: string): string {
  return aliases.get(modelId) ?? modelId;
}

export function vertexVideoModelName(modelId: string): string | undefined {
  return models.get(nativeModel(modelId));
}

export function vertexVideoCapabilities(modelId: string, config: MediaConfig): MediaCapability[] {
  if (!vertexVideoModelName(modelId)) return [];
  return [
    {
      operation: 'video.generate',
      constraints: [
        {
          when: [{ kind: 'input', role: 'reference', present: true }],
          anyOf: [{ kind: 'parameter', name: 'durationSeconds', values: [8] }],
        },
        {
          when: [
            { kind: 'parameter', name: 'resolution', values: ['4k'] },
            { kind: 'input', role: 'video', present: false },
          ],
          anyOf: [{ kind: 'parameter', name: 'durationSeconds', values: [8] }],
        },
        {
          when: [{ kind: 'input', role: 'video', present: true }],
          anyOf: [{ kind: 'parameter', name: 'durationSeconds', values: [7] }],
        },
        {
          when: [{ kind: 'input', role: 'video', present: false }],
          anyOf: [{ kind: 'parameter', name: 'durationSeconds', values: [4, 6, 8] }],
        },
        {
          when: [{ kind: 'input', role: 'video', present: true }],
          anyOf: [{ kind: 'input', role: 'video', present: true, max: 1 }],
        },
        ...(['start_frame', 'end_frame', 'reference'] as const).map((role) => ({
          when: [{ kind: 'input' as const, role: 'video' as const, present: true }],
          anyOf: [{ kind: 'input' as const, role, present: false }],
        })),
        {
          when: [{ kind: 'input', role: 'end_frame', present: true }],
          anyOf: [{ kind: 'input', role: 'start_frame', present: true }],
        },
        {
          when: [{ kind: 'input', role: 'reference', present: true }],
          anyOf: [{ kind: 'input', role: 'start_frame', present: false }],
        },
        {
          when: [{ kind: 'input', role: 'reference', present: true }],
          anyOf: [{ kind: 'input', role: 'end_frame', present: false }],
        },
      ],
      inputs: {
        roles: nativeModel(modelId).includes('lite')
          ? ['start_frame', 'end_frame', 'video']
          : ['start_frame', 'end_frame', 'reference', 'video'],
        min: 0,
        mediaTypes: { video: ['video/mp4'] },
        maxBytes: {
          reference: 20 * 1024 * 1024,
          start_frame: 20 * 1024 * 1024,
          end_frame: 20 * 1024 * 1024,
          video: config.transfers.maxVideoBytes,
        },
        max: Math.min(nativeModel(modelId).includes('lite') ? 2 : 3, config.limits.maxInputs),
      },
      execution: { kind: 'remote-job', cancellation: 'unsupported' },
      controls: {
        count: { min: 1, max: Math.min(4, config.limits.maxOutputs) },
        durationSeconds: { min: 4, max: 8, values: [4, 6, 7, 8], default: 4 },
        resolution: {
          values:
            nativeModel(modelId) === 'veo-3.1-generate-001'
              ? ['720p', '1080p', '4k']
              : ['720p', '1080p'],
          default: '720p',
        },
        aspectRatio: { values: ['16:9', '9:16'], default: '16:9' },
        audio: true,
        seed: { min: 0, max: 4_294_967_295 },
        negativePrompt: true,
      },
    },
  ];
}

function operationModel(operation: string, context: MediaProviderContext): string {
  const root = new URL(mediaAPIURL(context.connection, 'models/')).pathname;
  if (!root.startsWith('/v1/projects/')) throw new MediaProviderError('uncertain');
  const prefix = root.slice('/v1/'.length);
  const [model, id, extra] = operation.slice(prefix.length).split('/operations/');
  if (
    !operation.startsWith(prefix) ||
    extra !== undefined ||
    !vertexVideoModelName(model) ||
    !id ||
    !/^[A-Za-z0-9_-]+$/.test(id)
  ) {
    throw new MediaProviderError('uncertain');
  }
  return model;
}

function options(context: MediaProviderContext, path: string) {
  return {
    url: mediaAPIURL(context.connection, path),
    method: 'POST' as const,
    headers: { ...context.connection.headers, 'Content-Type': 'application/json' },
    signal: context.signal,
    timeoutMs: context.config.timeouts.submitMs,
    maxBytes: context.config.catalog.maxResponseBytes,
  };
}

export function createVertexVideoAdapter(): MediaProviderAdapter {
  return {
    api: 'google.vertex.videos',
    operations: ['video.generate'],
    catalog: (config) =>
      [...aliases].map(([modelId, id]) => ({
        modelId,
        modelName: models.get(id)!,
        capabilities: vertexVideoCapabilities(modelId, config),
      })),
    async submit(request, inputs, context): Promise<MediaProviderResult> {
      const model = nativeModel(request.selection.modelId);
      if (request.operation !== 'video.generate' || !vertexVideoModelName(model)) {
        throw new MediaProviderError('rejected');
      }
      const references = inputs.filter((input) => input.role === 'reference');
      const first = inputs.filter((input) => input.role === 'start_frame');
      const last = inputs.filter((input) => input.role === 'end_frame');
      const video = inputs.find((input) => input.role === 'video');
      const parameters = nativeParameters(
        request,
        inputs,
        context,
        vertexVideoCapabilities(request.selection.modelId, context.config)[0],
      );
      const duration = parameters.durationSeconds ?? 4;
      const resolution = parameters.resolution ?? '720p';
      if (
        inputs.length > Math.min(3, context.config.limits.maxInputs) ||
        inputs.some((input) =>
          input.role === 'video'
            ? input.type !== 'video/mp4' ||
              input.data.length > context.config.transfers.maxVideoBytes
            : !['reference', 'start_frame', 'end_frame'].includes(input.role) ||
              !['image/png', 'image/jpeg', 'image/webp'].includes(input.type) ||
              input.data.length > 20 * 1024 * 1024,
        ) ||
        first.length > 1 ||
        last.length > 1 ||
        (references.length && model.includes('lite')) ||
        !(video ? [7] : [4, 6, 8]).includes(duration) ||
        !['720p', '1080p', ...(model === 'veo-3.1-generate-001' ? ['4k'] : [])].includes(
          resolution,
        ) ||
        Object.keys(parameters.providerOptions ?? {}).length
      )
        throw new MediaProviderError('rejected');
      const image = async (input: (typeof inputs)[number] | undefined) => {
        if (!input) return undefined;
        const convert = input.type === 'image/webp';
        const data = convert ? await sharp(input.data).png().toBuffer() : input.data;
        if (data.length > Math.min(20 * 1024 * 1024, context.config.transfers.maxImageBytes)) {
          throw new MediaProviderError('rejected');
        }
        return {
          bytesBase64Encoded: data.toString('base64'),
          mimeType: convert ? 'image/png' : input.type,
        };
      };
      const [firstImage, lastImage, referenceImages] = await Promise.all([
        image(first[0]),
        image(last[0]),
        Promise.all(
          references.map(async (input) => ({ image: await image(input), referenceType: 'asset' })),
        ),
      ]);
      const body = JSON.stringify({
        instances: [
          {
            prompt: request.prompt,
            image: firstImage,
            lastFrame: lastImage,
            referenceImages: references.length ? referenceImages : undefined,
            video: video
              ? { bytesBase64Encoded: video.data.toString('base64'), mimeType: video.type }
              : undefined,
          },
        ],
        parameters: {
          sampleCount: parameters.count,
          // Veo extension always adds seven seconds; omitting duration uses that native contract.
          durationSeconds: video ? undefined : duration,
          aspectRatio: parameters.aspectRatio ?? '16:9',
          resolution,
          generateAudio: parameters.audio ?? false,
          seed: parameters.seed,
          negativePrompt: parameters.negativePrompt,
        },
      });
      const response = await context.transport.json(
        {
          ...options(context, `models/${encodeURIComponent(model)}:predictLongRunning`),
          body,
          maxBytes: Math.max(context.config.catalog.maxResponseBytes, Buffer.byteLength(body)),
        },
        z.object({ name: z.string().min(1) }),
      );
      if (operationModel(response.name, context) !== model) {
        throw new MediaProviderError('uncertain');
      }
      /** Persist the operation before fetching bytes, even if generation already finished. */
      return { status: 'running', operationId: response.name };
    },
    async poll(operationId, context): Promise<MediaProviderResult> {
      const model = operationModel(operationId, context);
      const maxVideoBytes = context.config.transfers.maxVideoBytes;
      const maxEncodedBytes = Math.ceil(maxVideoBytes / 3) * 4;
      const maxOutputs = Math.min(4, context.config.limits.maxOutputs);
      const response = await context.transport.json(
        {
          ...options(context, `models/${encodeURIComponent(model)}:fetchPredictOperation`),
          body: JSON.stringify({ operationName: operationId }),
          timeoutMs: context.config.timeouts.pollRequestMs,
          maxBytes: maxEncodedBytes * maxOutputs + context.config.catalog.maxResponseBytes,
        },
        z.object({
          name: z.string().min(1),
          done: z.boolean().optional(),
          error: z.object({ code: z.number(), message: z.string().optional() }).optional(),
          response: z
            .object({
              raiMediaFilteredCount: z.number().int().nonnegative().optional(),
              raiMediaFilteredReasons: z.array(z.string()).optional(),
              videos: z
                .array(
                  z.object({
                    mimeType: z.literal('video/mp4'),
                    bytesBase64Encoded: z.string().min(1).max(maxEncodedBytes),
                  }),
                )
                .max(maxOutputs)
                .optional(),
            })
            .optional(),
        }),
      );
      if (response.name !== operationId) throw new MediaProviderError('uncertain');
      if (!response.done) return { status: 'running', operationId };
      const failure = (code: string, message?: string): MediaProviderResult => ({
        status: 'failed',
        diagnostic: sanitizeMediaProviderDiagnostic(
          { code, message },
          context.config.recovery.maxDiagnosticMessageChars,
          mediaDiagnosticSecrets(context.connection.headers),
        ),
      });
      if (response.error) return failure(String(response.error.code), response.error.message);
      if (!response.response) throw new MediaProviderError('uncertain');
      const videos = response.response.videos ?? [];
      if (!videos.length) {
        if (response.response.raiMediaFilteredCount)
          return failure('CONTENT_FILTERED', response.response.raiMediaFilteredReasons?.join(' '));
        throw new MediaProviderError('uncertain');
      }
      return {
        status: 'completed',
        parts: videos.map((video, ordinal) => {
          const encoded = video.bytesBase64Encoded;
          if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
            throw new MediaProviderError('uncertain');
          }
          const data = Buffer.from(encoded, 'base64');
          if (!data.length || data.length > maxVideoBytes)
            throw new MediaProviderError('uncertain');
          return { kind: 'video', ordinal, type: video.mimeType, data };
        }),
      };
    },
    async download(part) {
      if (!part.data) throw new MediaProviderError('uncertain');
      return Readable.from([part.data]);
    },
  };
}
