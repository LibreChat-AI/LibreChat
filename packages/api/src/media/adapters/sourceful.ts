import { z } from 'zod';
import { createHash } from 'node:crypto';
import { finished } from 'node:stream/promises';
import type { MediaConfig } from 'librechat-data-provider';
import type {
  MediaModelProfile,
  MediaProviderAdapter,
  MediaProviderContext,
  MediaProviderInput,
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
  ['sourceful/riverflow-v2-pro', 'riverflow-2-pro'],
  ['sourceful/riverflow-v2.5-pro', 'riverflow-2.5-pro'],
]);
const qualities = ['low', 'medium', 'high', 'xhigh'];
const imageResult = z.object({ status: z.string(), image_url: z.string().url().nullable() });
const freestyleResult = imageResult.extend({
  freestyle_image_id: z.string().uuid(),
  brand_id: z.string().uuid(),
});

function catalog(config: MediaConfig): MediaModelProfile[] {
  return [...models]
    .map(
      ([modelId]): MediaModelProfile => ({
        modelId,
        modelName: modelId.endsWith('v2-pro') ? 'Riverflow V2 Pro' : 'Riverflow V2.5 Pro',
        capabilities: (['image.generate', 'image.edit'] as const).map((operation) => ({
          operation,
          inputs: {
            roles: ['reference'],
            min: operation === 'image.edit' ? 1 : 0,
            max: Math.min(10, config.limits.maxInputs),
          },
          execution: { kind: 'remote-job' as const, cancellation: 'unsupported' as const },
          controls: {
            count: { min: 1, max: 1 },
            aspectRatio: {
              values: [
                'auto',
                '21:9',
                '16:9',
                '3:2',
                '4:3',
                '5:4',
                '1:1',
                '4:5',
                '3:4',
                '2:3',
                '9:16',
              ],
            },
            resolution: { values: ['1K', '2K', '4K'] },
            ...(modelId.endsWith('v2.5-pro')
              ? { quality: { values: qualities, required: true } }
              : {}),
          },
        })),
      }),
    )
    .concat(
      ['sourceful/riverflow-v2-fast', 'sourceful/riverflow-v2.5-fast'].map(
        (modelId): MediaModelProfile => ({
          modelId,
          modelName: modelId.endsWith('v2-fast') ? 'Riverflow V2 Fast' : 'Riverflow V2.5 Fast',
          capabilities: [],
          unavailableReason: 'unsupported',
        }),
      ),
    );
}

function brand(context: MediaProviderContext): string {
  const value = z.string().uuid().safeParse(context.connection.options?.brandId);
  if (!value.success) throw new MediaProviderError('rejected');
  return value.data;
}

async function upload(
  input: MediaProviderInput,
  brandId: string,
  context: MediaProviderContext,
): Promise<string> {
  const path = `api/brands/${encodeURIComponent(brandId)}/user-uploads`;
  const filename = `input.${input.type.split('/')[1]}`;
  const receipt = await context.transport.json(
    nativeRequest(
      context,
      `${path}/upload-session`,
      JSON.stringify({
        original_file_name: filename,
        mime_type: input.type,
        file_size_bytes: input.data.length,
        source_type: 'USER_UPLOAD',
        asset_source: 'user_uploaded',
      }),
    ),
    z.object({
      data: z.object({
        upload_url: z.string().url(),
        upload_fields: z.record(z.string()),
        storage_path: z.string().min(1),
        upload_session_id: z.string().uuid(),
      }),
      error: z.null(),
    }),
  );
  const url = new URL(receipt.data.upload_url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new MediaProviderError('rejected');
  const form = new FormData();
  for (const [name, value] of Object.entries(receipt.data.upload_fields)) form.set(name, value);
  form.set('file', new Blob([new Uint8Array(input.data)], { type: input.type }), filename);
  const response = await context.transport.stream({
    ...nativeRequest(context, '', form),
    url: url.href,
    headers: {},
  });
  await finished(response.resume());
  const finalized = await context.transport.json(
    nativeRequest(
      context,
      `${path}/finalize`,
      JSON.stringify({
        storage_path: receipt.data.storage_path,
        upload_session_id: receipt.data.upload_session_id,
      }),
    ),
    z.object({
      data: z.object({
        item: z.object({
          asset_id: z.string().uuid(),
          asset_type: z.literal('image'),
          source_type: z.literal('USER_UPLOAD'),
        }),
      }),
      error: z.null(),
    }),
  );
  return finalized.data.item.asset_id;
}

function result(response: z.infer<typeof imageResult>, operationId: string): MediaProviderResult {
  if (['queued', 'thinking', 'processing'].includes(response.status))
    return { status: 'running', operationId };
  if (response.status === 'failed') return { status: 'failed' };
  if (response.status !== 'completed' || !response.image_url)
    throw new MediaProviderError('uncertain');
  const url = response.image_url;
  const type = nativeImageType(url);
  return { status: 'completed', parts: [{ kind: 'image', ordinal: 0, type, url }] };
}

export function createSourcefulMediaAdapters(): MediaProviderAdapter[] {
  return [
    {
      api: 'sourceful.images',
      configuration: {
        baseURL: 'https://www.riverflow.ai',
        keyPrefix: 'Riverflow-Key ',
      },
      operations: ['image.generate', 'image.edit'],
      catalog,
      download: nativeDownload,
      async submit(request, inputs, context) {
        const brandId = brand(context);
        const model = models.get(request.selection.modelId);
        if (
          request.operation === 'video.generate' ||
          !model ||
          request.parameters.count !== 1 ||
          inputs.length > 10 ||
          (request.operation === 'image.edit' && !inputs.length) ||
          inputs.some(
            (input) => input.role !== 'reference' || !/^image\/(png|jpeg|webp)$/.test(input.type),
          )
        )
          throw new MediaProviderError('rejected');
        providerOptions(request, []);
        const quality = request.parameters.quality;
        if (model === 'riverflow-2.5-pro' && (!quality || !qualities.includes(quality)))
          throw new MediaProviderError('rejected');
        const assets = await Promise.all(inputs.map((input) => upload(input, brandId, context)));
        const edit = request.operation === 'image.edit';
        const body = {
          brand_id: brandId,
          instruction: request.prompt,
          model_key: model === 'riverflow-2.5-pro' ? `${model}-${quality}` : model,
          aspect_ratio: request.parameters.aspectRatio,
          resolution: request.parameters.resolution,
          source_asset_id: edit ? assets[0] : undefined,
          reference_asset_ids: edit ? assets.slice(1) : assets,
        };
        const transportRequest = nativeRequest(
          context,
          edit ? 'api/images/edit/uploaded-asset' : 'api/photoshoot/freestyle/generate',
          JSON.stringify(body),
        );
        transportRequest.headers = {
          ...transportRequest.headers,
          'Idempotency-Key': createHash('sha256').update(context.jobId).digest('hex'),
        };
        if (edit) {
          const response = await context.transport.json(
            transportRequest,
            z.object({ data: imageResult.extend({ edit_id: z.string().uuid() }), error: z.null() }),
          );
          return result(
            response.data,
            encodeOperation(
              { id: `edit/${response.data.edit_id}`, modelId: request.selection.modelId },
              context,
            ),
          );
        }
        const response = await context.transport.json(
          transportRequest,
          z.object({ data: z.object({ freestyle_image: freestyleResult }), error: z.null() }),
        );
        if (response.data.freestyle_image.brand_id !== brandId)
          throw new MediaProviderError('uncertain');
        return result(
          response.data.freestyle_image,
          encodeOperation(
            {
              id: `freestyle/${response.data.freestyle_image.freestyle_image_id}`,
              modelId: request.selection.modelId,
            },
            context,
          ),
        );
      },
      async poll(operationId, context) {
        const operation = decodeOperation(operationId, context);
        const brandId = brand(context);
        const [kind, id, remainder] = operation.id.split('/');
        if (
          !models.has(operation.modelId) ||
          remainder ||
          !['edit', 'freestyle'].includes(kind) ||
          !z.string().uuid().safeParse(id).success
        )
          throw new MediaProviderError('uncertain');
        if (kind === 'edit') {
          const response = await context.transport.json(
            nativeRequest(
              context,
              `api/brands/${encodeURIComponent(brandId)}/assets/edit/${encodeURIComponent(id)}`,
              undefined,
              true,
            ),
            z.object({
              data: imageResult.extend({
                id: z.string().uuid(),
                brand_id: z.string().uuid(),
                asset_type: z.literal('edit'),
              }),
              error: z.null(),
            }),
          );
          if (response.data.id !== id || response.data.brand_id !== brandId)
            throw new MediaProviderError('uncertain');
          return result(response.data, operationId);
        }
        const response = await context.transport.json(
          nativeRequest(
            context,
            `api/photoshoot/freestyle/generate/${encodeURIComponent(id)}`,
            undefined,
            true,
          ),
          z.object({ data: z.object({ freestyle_image: freestyleResult }), error: z.null() }),
        );
        if (
          response.data.freestyle_image.freestyle_image_id !== id ||
          response.data.freestyle_image.brand_id !== brandId
        )
          throw new MediaProviderError('uncertain');
        return result(response.data.freestyle_image, operationId);
      },
    },
  ];
}
