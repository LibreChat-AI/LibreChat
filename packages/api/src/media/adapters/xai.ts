import { z } from 'zod';
import type { MediaConfig, MediaCondition } from 'librechat-data-provider';
import type { MediaModelProfile, MediaProviderAdapter } from '../provider';
import {
  dataURI,
  decodeOperation,
  encodeOperation,
  imageBytes,
  nativeDownload,
  nativeRequest,
  providerOptions,
} from './native';
import { mediaDiagnosticSecrets, sanitizeMediaProviderDiagnostic } from '../diagnostics';
import { MediaProviderError } from '../errors';

const imageModels = new Map([
  ['x-ai/grok-imagine-image-2.0', 'Grok Imagine Image 2.0'],
  ['x-ai/grok-imagine-image-quality', 'Grok Imagine Image Quality'],
]);
const videoModels = new Map([
  ['x-ai/grok-imagine-video', 'Grok Imagine Video'],
  ['x-ai/grok-imagine-video-1.5', 'Grok Imagine Video 1.5'],
]);
const imageRatios = [
  'auto',
  '1:1',
  '3:4',
  '4:3',
  '9:16',
  '16:9',
  '2:3',
  '3:2',
  '9:19.5',
  '19.5:9',
  '9:20',
  '20:9',
  '1:2',
  '2:1',
];
const usage = z
  .object({
    cost_in_usd_ticks: z.number().nonnegative().optional(),
    input_tokens: z.number().optional().nullable(),
    output_tokens: z.number().optional().nullable(),
  })
  .optional()
  .nullable();

function imageCatalog(config: MediaConfig): MediaModelProfile[] {
  return [...imageModels].map(([modelId, modelName]) => ({
    modelId,
    modelName,
    capabilities: (['image.generate', 'image.edit'] as const).map((operation) => ({
      operation,
      inputs: {
        roles: operation === 'image.edit' ? ['reference'] : [],
        min: operation === 'image.edit' ? 1 : 0,
        max:
          operation === 'image.edit'
            ? Math.min(modelId.endsWith('2.0') ? 5 : 3, config.limits.maxInputs)
            : 0,
      },
      execution: { kind: 'direct', previews: false },
      controls: {
        count: { min: 1, max: Math.min(10, config.limits.maxOutputs) },
        aspectRatio: {
          values: modelId.endsWith('2.0') ? [...imageRatios, '21:9', '5:2'] : imageRatios,
        },
        resolution: { values: ['1k', '2k'], default: '1k' },
        ...(modelId.endsWith('2.0')
          ? { quality: { values: ['auto', 'low', 'medium'], default: 'auto' } }
          : {}),
      },
    })),
  }));
}

function videoCatalog(config: MediaConfig): MediaModelProfile[] {
  return [...videoModels].map(([modelId, modelName]) => ({
    modelId,
    modelName,
    capabilities: [
      {
        operation: 'video.generate',
        constraints: modelId.endsWith('1.5')
          ? (
              [
                { kind: 'input', role: 'end_frame', present: true },
                { kind: 'input', role: 'reference', present: true },
                {
                  kind: 'parameter',
                  name: 'providerOptions',
                  option: 'reference_audios',
                  present: true,
                },
              ] satisfies MediaCondition[]
            ).map((condition) => ({
              when: [condition],
              anyOf: [
                { kind: 'parameter', name: 'resolution', present: false },
                { kind: 'parameter', name: 'resolution', values: ['480p', '720p'] },
              ],
            }))
          : [
              {
                when: [{ kind: 'input', role: 'start_frame', present: true }],
                anyOf: [{ kind: 'input', role: 'reference', present: false }],
              },
            ],
        inputs: {
          roles: modelId.endsWith('1.5')
            ? ['start_frame', 'end_frame', 'reference']
            : ['start_frame', 'reference'],
          min: 0,
          max: config.limits.maxInputs,
        },
        execution: { kind: 'remote-job', cancellation: 'unsupported' },
        controls: {
          count: { min: 1, max: 1 },
          durationSeconds: {
            min: 1,
            max: 15,
            default: 8,
            values: Array.from({ length: 15 }, (_, i) => i + 1),
          },
          aspectRatio: { values: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'] },
          resolution: {
            values: modelId.endsWith('1.5') ? ['480p', '720p', '1080p'] : ['480p', '720p'],
          },
          ...(modelId.endsWith('1.5') ? { providerOptions: ['reference_audios'] } : {}),
        },
      },
    ],
  }));
}

export function createXAIMediaAdapters(): MediaProviderAdapter[] {
  return [
    {
      api: 'xai.images',
      configuration: { baseURL: 'https://api.x.ai/v1' },
      operations: ['image.generate', 'image.edit'],
      catalog: imageCatalog,
      download: nativeDownload,
      async submit(request, inputs, context) {
        const id = request.selection.modelId;
        if (
          request.operation === 'video.generate' ||
          !imageModels.has(id) ||
          inputs.some(
            (input) => input.role !== 'reference' || !/^image\/(png|jpeg|webp)$/.test(input.type),
          ) ||
          (request.operation === 'image.generate' && inputs.length) ||
          (request.operation === 'image.edit' &&
            (!inputs.length || inputs.length > (id.endsWith('2.0') ? 5 : 3)))
        )
          throw new MediaProviderError('rejected');
        providerOptions(request, []);
        const parameters = request.parameters;
        const references = inputs.map((input) => ({ url: dataURI(input) }));
        const response = await context.transport.json(
          nativeRequest(
            context,
            request.operation === 'image.edit' ? 'images/edits' : 'images/generations',
            JSON.stringify({
              model: id.slice('x-ai/'.length),
              prompt: request.prompt,
              n: parameters.count,
              resolution: parameters.resolution,
              quality: parameters.quality,
              aspect_ratio: references.length === 1 ? undefined : parameters.aspectRatio,
              response_format: 'b64_json',
              image: references.length === 1 ? references[0] : undefined,
              images: references.length > 1 ? references : undefined,
            }),
          ),
          z.object({
            data: z
              .array(
                z.object({
                  b64_json: z.string().optional().nullable(),
                  url: z.string().url().optional().nullable(),
                  mime_type: z.string().optional().nullable(),
                }),
              )
              .min(1)
              .max(context.config.limits.maxOutputs),
            usage,
          }),
        );
        return {
          status: 'completed',
          usage: response.usage
            ? {
                costUSD:
                  response.usage.cost_in_usd_ticks === undefined
                    ? undefined
                    : response.usage.cost_in_usd_ticks / 10_000_000_000,
                inputTokens: response.usage.input_tokens ?? undefined,
                outputTokens: response.usage.output_tokens ?? undefined,
              }
            : undefined,
          parts: response.data.map((item, ordinal) => {
            if (!item.b64_json && !item.url) throw new MediaProviderError('uncertain');
            return {
              kind: 'image',
              ordinal,
              type: item.mime_type ?? 'image/jpeg',
              data: item.b64_json ? imageBytes(item.b64_json, context) : undefined,
              url: item.url ?? undefined,
            };
          }),
        };
      },
    },
    {
      api: 'xai.videos',
      configuration: { baseURL: 'https://api.x.ai/v1' },
      operations: ['video.generate'],
      catalog: videoCatalog,
      download: nativeDownload,
      async submit(request, inputs, context) {
        const id = request.selection.modelId;
        if (
          request.operation !== 'video.generate' ||
          !videoModels.has(id) ||
          request.parameters.count !== 1 ||
          (request.parameters.durationSeconds !== undefined &&
            (!Number.isInteger(request.parameters.durationSeconds) ||
              request.parameters.durationSeconds < 1 ||
              request.parameters.durationSeconds > 15)) ||
          inputs.some(
            (input) =>
              !['reference', 'start_frame', 'end_frame'].includes(input.role) ||
              !/^image\/(png|jpeg|webp)$/.test(input.type),
          )
        )
          throw new MediaProviderError('rejected');
        const current = id.endsWith('1.5');
        const first = inputs.filter((input) => input.role === 'start_frame');
        const last = inputs.filter((input) => input.role === 'end_frame');
        const references = inputs.filter((input) => input.role === 'reference');
        const extra = providerOptions(request, current ? ['reference_audios'] : []);
        if (
          first.length > 1 ||
          last.length > 1 ||
          (!current && (last.length || (first.length && references.length))) ||
          ((last.length || references.length || extra.reference_audios) &&
            request.parameters.resolution === '1080p')
        )
          throw new MediaProviderError('rejected');
        if (
          extra.reference_audios !== undefined &&
          !z
            .array(z.object({ voice_id: z.string().min(1) }).strict())
            .max(3)
            .safeParse(extra.reference_audios).success
        )
          throw new MediaProviderError('rejected');
        const response = await context.transport.json(
          nativeRequest(
            context,
            'videos/generations',
            JSON.stringify({
              ...extra,
              model: id.slice('x-ai/'.length),
              prompt: request.prompt,
              duration: request.parameters.durationSeconds,
              resolution: request.parameters.resolution,
              aspect_ratio: first.length ? undefined : request.parameters.aspectRatio,
              image: first[0] ? { url: dataURI(first[0]) } : undefined,
              last_frame: last[0] ? { url: dataURI(last[0]) } : undefined,
              reference_images: references.length
                ? references.map((input) => ({ url: dataURI(input) }))
                : undefined,
            }),
          ),
          z.object({ request_id: z.string().min(1) }),
        );
        return {
          status: 'running',
          operationId: encodeOperation({ id: response.request_id, modelId: id }, context),
        };
      },
      async poll(operationId, context) {
        const operation = decodeOperation(operationId, context);
        if (!videoModels.has(operation.modelId)) throw new MediaProviderError('uncertain');
        const response = await context.transport.json(
          {
            ...nativeRequest(
              context,
              `videos/${encodeURIComponent(operation.id)}`,
              undefined,
              true,
            ),
            emptyResponse: { status: 202, body: '{"status":"pending"}' },
          },
          z.object({
            status: z.string(),
            progress: z.number().optional().nullable(),
            video: z
              .object({
                url: z.string().url().optional().nullable(),
                respect_moderation: z.boolean(),
              })
              .optional()
              .nullable(),
            error: z.object({ code: z.string(), message: z.string() }).optional().nullable(),
          }),
        );
        if (response.status === 'pending')
          return {
            status: 'running',
            operationId,
            progress:
              response.progress === undefined || response.progress === null
                ? undefined
                : response.progress / 100,
          };
        if (
          ['failed', 'expired'].includes(response.status) ||
          response.error ||
          response.video?.respect_moderation === false
        )
          return {
            status: 'failed',
            diagnostic: sanitizeMediaProviderDiagnostic(
              response.error ?? undefined,
              context.config.recovery.maxDiagnosticMessageChars,
              mediaDiagnosticSecrets(context.connection.headers),
            ),
          };
        if (response.status !== 'done' || !response.video?.url)
          throw new MediaProviderError('uncertain');
        return {
          status: 'completed',
          parts: [{ kind: 'video', ordinal: 0, type: 'video/mp4', url: response.video.url }],
        };
      },
    },
  ];
}
