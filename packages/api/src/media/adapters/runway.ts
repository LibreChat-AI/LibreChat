import { z } from 'zod';
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
  dataURI,
  decodeOperation,
  encodeOperation,
  nativeDownload,
  nativeRequest,
  nativeParameters,
  providerOptions,
} from './native';
import { mediaDiagnosticSecrets, sanitizeMediaProviderDiagnostic } from '../diagnostics';
import { MediaProviderError } from '../errors';
import { maximumInputs } from './constraints';

const models = new Map([
  ['runway/gen-4.5', 'gen4.5'],
  ['runway/aleph-2', 'aleph2'],
]);
const ratios: Record<string, string> = {
  '16:9': '1280:720',
  '9:16': '720:1280',
  '4:3': '1104:832',
  '1:1': '960:960',
  '3:4': '832:1104',
  '21:9': '1584:672',
};

function catalog(config: MediaConfig): MediaModelProfile[] {
  return [...models].map(([modelId, model]) => ({
    modelId,
    modelName: model === 'aleph2' ? 'Runway Aleph 2' : 'Runway Gen 4.5',
    capabilities: [
      {
        operation: 'video.generate',
        maxPromptChars: 1000,
        workflow: model === 'aleph2' ? 'edit' : 'generate',
        constraints:
          model === 'aleph2'
            ? [maximumInputs('video', 1)]
            : [
                {
                  when: [{ kind: 'input', role: 'start_frame', present: false }],
                  anyOf: [{ kind: 'parameter', name: 'aspectRatio', values: ['16:9', '9:16'] }],
                },
              ],
        inputs: {
          roles: model === 'aleph2' ? ['video', 'reference'] : ['start_frame'],
          mediaTypes: { video: ['video/mp4'] },
          requiredRoles: model === 'aleph2' ? ['video'] : [],
          min: model === 'aleph2' ? 1 : 0,
          max: Math.min(model === 'aleph2' ? 6 : 1, config.limits.maxInputs),
        },
        execution: {
          kind: 'remote-job',
          cancellation: config.cancellation.enabled ? 'best-effort' : 'unsupported',
        },
        controls: {
          count: { min: 1, max: 1 },
          seed: { min: 0, max: 4_294_967_295 },
          ...(model === 'aleph2'
            ? {
                aspectRatio: {
                  values: ['16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16', '21:9'],
                },
              }
            : {
                durationSeconds: {
                  min: 2,
                  max: 10,
                  default: 5,
                  values: Array.from({ length: 9 }, (_, i) => i + 2),
                },
                aspectRatio: { values: Object.keys(ratios), default: '16:9' },
              }),
          providerOptions: ['contentModeration'],
        },
      },
    ],
  }));
}

async function upload(input: MediaProviderInput, context: MediaProviderContext): Promise<string> {
  const uri = dataURI(input);
  if (uri.length <= 5_242_880) return uri;
  const extension = input.type === 'video/mp4' ? 'mp4' : input.type.split('/')[1];
  const filename = `input.${extension}`;
  const receipt = await context.transport.json(
    nativeRequest(context, 'uploads', JSON.stringify({ filename, type: 'ephemeral' })),
    z.object({
      uploadUrl: z.string().url(),
      fields: z.record(z.string()),
      runwayUri: z.string().regex(/^runway:\/\//),
    }),
  );
  const url = new URL(receipt.uploadUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new MediaProviderError('rejected');
  const form = new FormData();
  for (const [name, value] of Object.entries(receipt.fields)) form.set(name, value);
  form.set('file', new Blob([new Uint8Array(input.data)], { type: input.type }), filename);
  const response = await context.transport.stream({
    ...nativeRequest(context, '', form),
    url: url.href,
    headers: {},
  });
  await finished(response.resume());
  return receipt.runwayUri;
}

async function poll(
  operationId: string,
  context: MediaProviderContext,
): Promise<MediaProviderResult> {
  const operation = decodeOperation(operationId, context);
  if (!models.has(operation.modelId)) throw new MediaProviderError('uncertain');
  const response = await context.transport.json(
    nativeRequest(context, `tasks/${encodeURIComponent(operation.id)}`, undefined, true),
    z.object({
      id: z.string(),
      status: z.string(),
      failure: z.string().nullish(),
      failureCode: z.string().nullish(),
      progress: z.number().optional(),
      output: z.array(z.string().url()).max(context.config.limits.maxOutputs).optional(),
      cost: z.object({ credits: z.number().finite().nonnegative() }).optional(),
    }),
  );
  if (response.id !== operation.id) throw new MediaProviderError('uncertain');
  if (['PENDING', 'THROTTLED', 'RUNNING'].includes(response.status))
    return { status: 'running', operationId, progress: response.progress };
  /** Runway's published currency is $0.01 per credit: https://docs.dev.runwayml.com/guides/pricing */
  const usage = response.cost ? { costUSD: response.cost.credits / 100 } : undefined;
  if (response.status === 'FAILED')
    return {
      status: 'failed',
      usage,
      diagnostic: sanitizeMediaProviderDiagnostic(
        { code: response.failureCode ?? undefined, message: response.failure ?? undefined },
        context.config.recovery.maxDiagnosticMessageChars,
        mediaDiagnosticSecrets(context.connection.headers),
      ),
    };
  if (response.status === 'CANCELLED') return { status: 'cancelled', usage };
  if (response.status !== 'SUCCEEDED' || !response.output?.length)
    throw new MediaProviderError('uncertain');
  return {
    status: 'completed',
    usage,
    parts: response.output.map((url, ordinal) => ({
      kind: 'video',
      ordinal,
      type: 'video/mp4',
      url,
    })),
  };
}

export function createRunwayMediaAdapters(): MediaProviderAdapter[] {
  return [
    {
      api: 'runway.videos',
      configuration: {
        baseURL: 'https://api.dev.runwayml.com/v1',
        headers: { 'X-Runway-Version': '2024-11-06' },
      },
      operations: ['video.generate'],
      catalog,
      download: nativeDownload,
      poll,
      cancel: {
        retry: 'idempotent',
        async request(operationId, context, beforeRequest) {
          const operation = decodeOperation(operationId, context);
          try {
            const current = await poll(operationId, context);
            if (current.status !== 'running') return current;
          } catch (error) {
            if (!(error instanceof MediaProviderError && error.status === 404)) throw error;
          }
          /** DELETE cancels active tasks, deletes terminal tasks, and documents repeat 404 as idempotent.
           * https://docs.dev.runwayml.com/openapi.json — DELETE /v1/tasks/{id}. No refund is implied. */
          await beforeRequest();
          try {
            await context.transport.json(
              {
                ...nativeRequest(
                  context,
                  `tasks/${encodeURIComponent(operation.id)}`,
                  undefined,
                  true,
                ),
                method: 'DELETE',
                successStatus: 204,
                emptyResponse: { status: 204, body: '{}' },
              },
              z.object({}),
            );
          } catch (error) {
            if (!(error instanceof MediaProviderError && error.status === 404)) throw error;
          }
          return { status: 'cancelled' };
        },
      },
      async submit(request, inputs, context) {
        const parameters = nativeParameters(
          request,
          inputs,
          context,
          catalog(context.config)
            .find((profile) => profile.modelId === request.selection.modelId)
            ?.capabilities.find((capability) => capability.operation === request.operation),
        );
        const model = models.get(request.selection.modelId);
        if (
          request.operation !== 'video.generate' ||
          !model ||
          parameters.count !== 1 ||
          request.prompt.length > 1000
        )
          throw new MediaProviderError('rejected');
        const options = providerOptions(request, ['contentModeration']);
        const video = inputs.filter((input) => input.role === 'video');
        const references = inputs.filter((input) => input.role === 'reference');
        if (model === 'aleph2') {
          if (
            video.length !== 1 ||
            video[0].type !== 'video/mp4' ||
            references.length > 5 ||
            inputs.length !== video.length + references.length ||
            references.some((input) => !/^image\/(png|jpeg|webp)$/.test(input.type))
          )
            throw new MediaProviderError('rejected');
        } else if (
          inputs.length > 1 ||
          inputs.some(
            (input) => input.role !== 'start_frame' || !/^image\/(png|jpeg|webp)$/.test(input.type),
          ) ||
          (parameters.durationSeconds !== undefined &&
            (!Number.isInteger(parameters.durationSeconds) ||
              parameters.durationSeconds < 2 ||
              parameters.durationSeconds > 10))
        )
          throw new MediaProviderError('rejected');
        const prepared = await Promise.all(
          inputs.map(async (input) => ({ role: input.role, uri: await upload(input, context) })),
        );
        const body =
          model === 'aleph2'
            ? {
                ...options,
                model,
                promptText: request.prompt,
                videoUri: prepared.find((input) => input.role === 'video')?.uri,
                keyframes: references.length
                  ? prepared
                      .filter((input) => input.role === 'reference')
                      .map((input, index) => ({
                        uri: input.uri,
                        at: references.length === 1 ? 0 : index / (references.length - 1),
                      }))
                  : undefined,
                targetAspectRatio: parameters.aspectRatio,
                seed: parameters.seed,
              }
            : {
                ...options,
                model,
                promptText: request.prompt,
                promptImage: prepared[0]?.uri,
                ratio: ratios[parameters.aspectRatio ?? '16:9'],
                duration: parameters.durationSeconds ?? 5,
                seed: parameters.seed,
              };
        const generatePath = inputs.length ? 'image_to_video' : 'text_to_video';
        const path = model === 'aleph2' ? 'video_to_video' : generatePath;
        const response = await context.transport.json(
          nativeRequest(context, path, JSON.stringify(body)),
          z.object({ id: z.string().min(1) }),
        );
        return {
          status: 'running',
          operationId: encodeOperation(
            { id: response.id, modelId: request.selection.modelId },
            context,
          ),
        };
      },
    },
  ];
}
