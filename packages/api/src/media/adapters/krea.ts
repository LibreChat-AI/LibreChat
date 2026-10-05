import { z } from 'zod';
import type { MediaConfig } from 'librechat-data-provider';
import type {
  MediaModelProfile,
  MediaProviderAdapter,
  MediaProviderContext,
  MediaProviderResult,
} from '../provider';
import {
  decodeOperation,
  encodeOperation,
  nativeDownload,
  nativeImageType,
  nativeRequest,
  providerOptions,
} from './native';
import { MediaProviderError } from '../errors';

const models = new Map([
  ['krea/krea-2-large', 'large'],
  ['krea/krea-2-medium', 'medium'],
  ['krea/krea-2-medium-turbo', 'medium-turbo'],
]);
const options = [
  'styles',
  'image_style_references',
  'moodboards',
  'creativity',
  'intensity',
  'complexity',
  'movement',
];

function catalog(config: MediaConfig): MediaModelProfile[] {
  return [...models].map(([modelId, model]) => ({
    modelId,
    modelName: `Krea 2 ${model.replaceAll('-', ' ')}`,
    capabilities: (['image.generate', 'image.edit'] as const).map((operation) => ({
      operation,
      inputs: {
        roles: ['reference'],
        min: operation === 'image.edit' ? 1 : 0,
        max: Math.min(1, config.limits.maxInputs),
      },
      execution: {
        kind: 'remote-job',
        cancellation: config.cancellation.enabled ? 'best-effort' : 'unsupported',
      },
      controls: {
        count: { min: 1, max: 1 },
        aspectRatio: {
          values: ['1:1', '4:3', '3:2', '16:9', '2.35:1', '4:5', '3:4', '2:3', '9:16'],
          default: '1:1',
        },
        resolution: { values: ['1K'], default: '1K' },
        strength: { min: 0, max: 1, default: 0.99 },
        seed: { min: 0, max: 4_294_967_295 },
        providerOptions: options,
      },
    })),
  }));
}

async function readJob(operationId: string, context: MediaProviderContext) {
  const operation = decodeOperation(operationId, context);
  if (!models.has(operation.modelId)) throw new MediaProviderError('uncertain');
  const response = await context.transport.json(
    nativeRequest(context, `jobs/${encodeURIComponent(operation.id)}`, undefined, true),
    z.object({
      job_id: z.string(),
      status: z.string(),
      result: z
        .object({
          urls: z.array(z.string().url()).max(context.config.limits.maxOutputs).optional(),
        })
        .optional()
        .nullable(),
    }),
  );
  if (response.job_id !== operation.id) throw new MediaProviderError('uncertain');
  return { operation, response };
}

function result(
  response: Awaited<ReturnType<typeof readJob>>['response'],
  operationId: string,
): MediaProviderResult {
  if (
    [
      'backlogged',
      'queued',
      'scheduled',
      'processing',
      'sampling',
      'intermediate-complete',
    ].includes(response.status)
  )
    return { status: 'running', operationId };
  /** Only explicit terminal states establish Krea's published no-charge guarantee.
   * https://www.krea.ai/docs/developers/job-lifecycle */
  if (response.status === 'failed') return { status: 'failed', usage: { costUSD: 0 } };
  if (response.status === 'cancelled') return { status: 'cancelled', usage: { costUSD: 0 } };
  if (response.status !== 'completed' || !response.result?.urls?.length)
    throw new MediaProviderError('uncertain');
  return {
    status: 'completed',
    parts: response.result.urls.map((url, ordinal) => ({
      kind: 'image',
      ordinal,
      type: nativeImageType(url),
      url,
    })),
  };
}

export function createKreaMediaAdapters(): MediaProviderAdapter[] {
  return [
    {
      api: 'krea.images',
      configuration: { baseURL: 'https://api.krea.ai' },
      operations: ['image.generate', 'image.edit'],
      catalog,
      download: nativeDownload,
      cancel: {
        retry: 'never',
        async request(operationId, context, beforeRequest) {
          const { operation, response } = await readJob(operationId, context);
          const current = result(response, operationId);
          if (current.status !== 'running') return current;
          if (!['queued', 'processing'].includes(response.status))
            return { status: 'cancellation_deferred' };
          /** Krea documents cancellation only in queued/processing. After an uncertain DELETE,
           * resume polling; its 404 also means unauthorized and cannot confirm a refund.
           * https://www.krea.ai/docs/api-reference/general/delete-a-job-by-id */
          await beforeRequest();
          await context.transport.json(
            {
              ...nativeRequest(
                context,
                `jobs/${encodeURIComponent(operation.id)}`,
                undefined,
                true,
              ),
              method: 'DELETE',
              successStatus: 200,
              emptyResponse: { status: 200, body: '{}' },
            },
            z.object({}),
          );
          return { status: 'cancellation_requested' };
        },
      },
      async submit(request, inputs, context) {
        const model = models.get(request.selection.modelId);
        if (
          request.operation === 'video.generate' ||
          !model ||
          request.parameters.count !== 1 ||
          inputs.length > 1 ||
          (request.operation === 'image.edit' && !inputs.length) ||
          inputs.some(
            (input) => input.role !== 'reference' || !/^image\/(png|jpeg|webp)$/.test(input.type),
          )
        )
          throw new MediaProviderError('rejected');
        const extra = providerOptions(request, options);
        let imageURL: string | undefined;
        if (inputs[0]) {
          const input = inputs[0];
          const form = new FormData();
          form.set(
            'file',
            new Blob([new Uint8Array(input.data)], { type: input.type }),
            `input.${input.type.split('/')[1]}`,
          );
          const response = await context.transport.json(
            nativeRequest(context, 'assets', form),
            z.object({ image_url: z.string().url() }),
          );
          imageURL = response.image_url;
        }
        const response = await context.transport.json(
          nativeRequest(
            context,
            `generate/image/krea/krea-2/${model}`,
            JSON.stringify({
              ...extra,
              prompt: request.prompt,
              aspect_ratio: request.parameters.aspectRatio ?? '1:1',
              resolution: request.parameters.resolution ?? '1K',
              seed: request.parameters.seed,
              image_url: imageURL,
              strength: request.parameters.strength,
            }),
          ),
          z.object({ job_id: z.string().min(1) }),
        );
        return {
          status: 'running',
          operationId: encodeOperation(
            { id: response.job_id, modelId: request.selection.modelId },
            context,
          ),
        };
      },
      async poll(operationId, context) {
        return result((await readJob(operationId, context)).response, operationId);
      },
    },
  ];
}
