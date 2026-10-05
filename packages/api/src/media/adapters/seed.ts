import { z } from 'zod';
import { mediaSourceURLSchema } from 'librechat-data-provider';
import type { MediaConfig } from 'librechat-data-provider';
import type { MediaModelProfile, MediaProviderAdapter, MediaProviderResult } from '../provider';
import {
  nativeRequest,
  nativeDownload,
  dataURI,
  providerOptions,
  encodeOperation,
  decodeOperation,
  imageBytes,
} from './native';
import { frameInputConstraints, maximumInputs } from './constraints';
import { MediaProviderError } from '../errors';

const imageModels = new Map([
  ['bytedance-seed/seedream-5-0-pro', 'dola-seedream-5-0-pro-260628'],
  ['bytedance-seed/seedream-5-0-lite', 'seedream-5-0-260128'],
  ['bytedance-seed/seedream-4.5', 'seedream-4-5-251128'],
]);
const videoModels = new Map([
  ['bytedance/seedance-2.5', 'dreamina-seedance-2-5-260628'],
  ['bytedance/seedance-2.0', 'dreamina-seedance-2-0-260128'],
  ['bytedance/seedance-2.0-fast', 'dreamina-seedance-2-0-fast-260128'],
  ['bytedance/seedance-2.0-mini', 'dreamina-seedance-2-0-mini-260615'],
]);
const imageOptionNames = ['watermark', 'optimize_prompt_options'];
const imageOptionSchema = z
  .object({
    watermark: z.boolean().optional(),
    optimize_prompt_options: z
      .object({ mode: z.enum(['standard', 'fast']) })
      .strict()
      .optional(),
  })
  .strict();
const videoOptionNames = ['watermark', 'omni_reference_task_type'];
const videoOptionSchema = z
  .object({
    watermark: z.boolean().optional(),
    omni_reference_task_type: z.enum(['auto', 'reference', 'edit', 'extend']).optional(),
  })
  .strict();

function images(config: MediaConfig): MediaModelProfile[] {
  return [...imageModels].map(([modelId, modelName]) => {
    const pro = modelId.endsWith('-pro');
    const legacy = modelId.endsWith('4.5');
    let resolutions = ['2K', '3K', '4K'];
    if (pro) resolutions = ['1K', '1.5K', '2K'];
    else if (legacy) resolutions = ['2K', '4K'];
    return {
      modelId,
      modelName,
      capabilities: (['image.generate', 'image.edit'] as const).map((operation) => ({
        operation,
        constraints: pro
          ? [
              {
                when: [{ kind: 'parameter', name: 'background', values: ['transparent'] }],
                anyOf: [{ kind: 'input', role: 'reference', present: true, max: 1 }],
              },
            ]
          : [
              ...Array.from({ length: Math.min(15, config.limits.maxOutputs) }, (_, index) => ({
                ...maximumInputs('reference', 14 - index),
                when: [{ kind: 'parameter' as const, name: 'count' as const, values: [index + 1] }],
              })),
            ],
        inputs: {
          roles: ['reference'],
          min: operation === 'image.edit' ? 1 : 0,
          max: Math.min(pro ? 10 : 14, config.limits.maxInputs),
        },
        execution: { kind: 'direct', previews: false },
        controls: {
          count: { min: 1, max: Math.min(pro ? 1 : 15, config.limits.maxOutputs), default: 1 },
          resolution: {
            values: resolutions,
            default: '2K',
          },
          format: { values: legacy ? ['jpeg'] : ['jpeg', 'png'], default: 'jpeg' },
          ...(pro ? { background: { values: ['opaque', 'transparent'], default: 'opaque' } } : {}),
          providerOptions: imageOptionNames,
        },
      })),
    };
  });
}

function videos(config: MediaConfig): MediaModelProfile[] {
  const profiles: MediaModelProfile[] = [...videoModels].map(([modelId, modelName]) => {
    const latest = modelId.endsWith('2.5');
    const small = modelId.endsWith('-mini') || modelId.endsWith('-fast');
    let resolutions = ['480p', '720p', '1080p', '4k'];
    if (latest) resolutions = ['480p', '720p', '1080p'];
    if (small) resolutions = ['480p', '720p'];
    return {
      modelId,
      modelName,
      capabilities: [
        {
          operation: 'video.generate',
          constraints: [
            ...frameInputConstraints(['reference', 'video', 'audio']),
            maximumInputs('reference', latest ? 30 : 9),
            maximumInputs('video', latest ? 10 : 3),
            maximumInputs('audio', latest ? 10 : 3),
            {
              when: [
                {
                  kind: 'parameter',
                  name: 'providerOptions',
                  option: 'omni_reference_task_type',
                  values: ['edit', 'extend'],
                },
              ],
              anyOf: [{ kind: 'input', role: 'video', present: true }],
            },
          ],
          inputs: {
            roles: ['reference', 'start_frame', 'end_frame', 'video', 'audio'],
            hostedRoles: ['video'],
            mediaTypes: { audio: ['audio/mpeg', 'audio/wav'] },
            min: 0,
            max: Math.min(latest ? 50 : 15, config.limits.maxInputs),
          },
          execution: { kind: 'remote-job', cancellation: 'unsupported' },
          controls: {
            count: { min: 1, max: 1, default: 1 },
            durationSeconds: {
              min: 4,
              max: latest ? 30 : 15,
              values: Array.from({ length: latest ? 27 : 12 }, (_, index) => index + 4),
              default: 5,
            },
            resolution: {
              values: resolutions,
              default: '720p',
            },
            aspectRatio: {
              values: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
              default: 'adaptive',
            },
            audio: true,
            seed: { min: 0, max: 4_294_967_295 },
            providerOptions: latest
              ? videoOptionNames
              : videoOptionNames.filter((name) => name !== 'omni_reference_task_type'),
          },
        },
      ],
    };
  });
  profiles.push({
    modelId: 'bytedance/seedance-1-5-pro',
    modelName: 'Seedance 1.5 Pro',
    capabilities: [],
    unavailableReason: 'unsupported',
  });
  return profiles;
}

export function createSeedMediaAdapters(): MediaProviderAdapter[] {
  const configuration = { baseURL: 'https://ark.ap-southeast.bytepluses.com/api/v3' };
  return [
    {
      api: 'seed.images',
      configuration,
      catalog: images,
      operations: ['image.generate', 'image.edit'],
      download: nativeDownload,
      async submit(request, inputs, context): Promise<MediaProviderResult> {
        const model = imageModels.get(request.selection.modelId);
        if (
          !model ||
          request.operation === 'video.generate' ||
          inputs.some((input) => input.role !== 'reference')
        )
          throw new MediaProviderError('rejected');
        const pro = request.selection.modelId.endsWith('-pro');
        const legacy = request.selection.modelId.endsWith('4.5');
        const options = imageOptionSchema.safeParse(providerOptions(request, imageOptionNames));
        if (
          !options.success ||
          (pro
            ? inputs.length > 10 || request.parameters.count !== 1
            : inputs.length + request.parameters.count > 15) ||
          (!pro && options.data.optimize_prompt_options?.mode === 'fast') ||
          (request.parameters.background === 'transparent' &&
            (!pro ||
              inputs.length !== 1 ||
              inputs[0].type === 'image/jpeg' ||
              request.parameters.format === 'jpeg'))
        ) {
          throw new MediaProviderError('rejected');
        }
        const result = await context.transport.json(
          nativeRequest(
            context,
            'images/generations',
            JSON.stringify({
              ...options.data,
              model,
              prompt: request.prompt,
              image: inputs.length ? inputs.map(dataURI) : undefined,
              size: request.parameters.resolution ?? request.parameters.size,
              response_format: 'b64_json',
              output_format: legacy ? undefined : request.parameters.format,
              background:
                pro && request.parameters.background === 'transparent' ? 'transparent' : undefined,
              ...(pro
                ? {}
                : {
                    sequential_image_generation: request.parameters.count > 1 ? 'auto' : 'disabled',
                    sequential_image_generation_options:
                      request.parameters.count > 1
                        ? { max_images: request.parameters.count }
                        : undefined,
                  }),
            }),
          ),
          z.object({
            data: z
              .array(
                z.object({
                  b64_json: z.string().optional(),
                  url: z.string().url().optional(),
                  output_format: z.enum(['png', 'jpeg']).optional(),
                  error: z.object({ code: z.string().optional() }).optional(),
                }),
              )
              .min(1)
              .max(context.config.limits.maxOutputs),
            usage: z
              .object({ output_tokens: z.number().optional(), total_tokens: z.number().optional() })
              .optional(),
          }),
        );
        const parts = result.data.flatMap((item, ordinal) =>
          item.error
            ? []
            : [
                {
                  kind: 'image' as const,
                  ordinal,
                  type: `image/${item.output_format ?? (legacy ? 'jpeg' : (request.parameters.format ?? 'jpeg'))}`,
                  data: item.b64_json ? imageBytes(item.b64_json, context) : undefined,
                  url: item.url,
                },
              ],
        );
        if (parts.some((part) => !part.data && !part.url))
          throw new MediaProviderError('uncertain');
        if (!parts.length) return { status: 'failed' };
        return { status: 'completed', parts, usage: { outputTokens: result.usage?.output_tokens } };
      },
    },
    {
      api: 'seed.videos',
      configuration,
      catalog: videos,
      operations: ['video.generate'],
      download: nativeDownload,
      async submit(request, inputs, context): Promise<MediaProviderResult> {
        const model = videoModels.get(request.selection.modelId);
        if (
          !model ||
          request.operation !== 'video.generate' ||
          inputs.some(
            (input) =>
              input.role === 'mask' ||
              (input.role === 'video' && !mediaSourceURLSchema.safeParse(input.sourceURL).success),
          )
        )
          throw new MediaProviderError('rejected');
        const latest = request.selection.modelId.endsWith('2.5');
        const duration = request.parameters.durationSeconds;
        if (
          duration !== undefined &&
          (!Number.isInteger(duration) || duration < 4 || duration > (latest ? 30 : 15))
        )
          throw new MediaProviderError('rejected');
        const options = videoOptionSchema.safeParse(
          providerOptions(
            request,
            latest
              ? videoOptionNames
              : videoOptionNames.filter((name) => name !== 'omni_reference_task_type'),
          ),
        );
        const frames = inputs.filter(
          (input) => input.role === 'start_frame' || input.role === 'end_frame',
        );
        if (
          !options.success ||
          (frames.length > 0 && frames.length !== inputs.length) ||
          new Set(frames.map((input) => input.role)).size !== frames.length ||
          (frames.some((input) => input.role === 'end_frame') &&
            !frames.some((input) => input.role === 'start_frame')) ||
          inputs.filter((input) => input.role === 'reference').length > (latest ? 30 : 9) ||
          inputs.filter((input) => input.role === 'video').length > (latest ? 10 : 3) ||
          inputs.filter((input) => input.role === 'audio').length > (latest ? 10 : 3) ||
          inputs.some(
            (input) => input.role === 'audio' && !['audio/mpeg', 'audio/wav'].includes(input.type),
          ) ||
          (['edit', 'extend'].includes(options.data.omni_reference_task_type ?? '') &&
            !inputs.some((input) => input.role === 'video'))
        )
          throw new MediaProviderError('rejected');
        const roles = {
          reference: 'reference_image',
          start_frame: 'first_frame',
          end_frame: 'last_frame',
          video: 'reference_video',
          audio: 'reference_audio',
          mask: 'mask',
        };
        const editing = options.data.omni_reference_task_type === 'edit';
        const extending = options.data.omni_reference_task_type === 'extend';
        const body = JSON.stringify({
          ...options.data,
          model,
          content: [
            { type: 'text', text: request.prompt },
            ...inputs.map((input) => {
              let type = 'image_url';
              if (input.role === 'video') type = 'video_url';
              else if (input.role === 'audio') type = 'audio_url';
              return {
                type,
                [type]: { url: input.role === 'video' ? input.sourceURL : dataURI(input) },
                role: roles[input.role],
              };
            }),
          ],
          duration: editing ? -1 : request.parameters.durationSeconds,
          resolution: request.parameters.resolution,
          ratio:
            editing || extending || (latest && frames.length)
              ? 'adaptive'
              : request.parameters.aspectRatio,
          generate_audio: request.parameters.audio,
          seed: request.parameters.seed,
        });
        if (Buffer.byteLength(body) > 64 * 1024 * 1024) throw new MediaProviderError('rejected');
        const result = await context.transport.json(
          nativeRequest(context, 'contents/generations/tasks', body),
          z.object({ id: z.string().min(1) }),
        );
        return {
          status: 'running',
          operationId: encodeOperation(
            { id: result.id, modelId: request.selection.modelId },
            context,
          ),
        };
      },
      async poll(operationId, context): Promise<MediaProviderResult> {
        const operation = decodeOperation(operationId, context);
        if (!videoModels.has(operation.modelId)) throw new MediaProviderError('uncertain');
        const result = await context.transport.json(
          nativeRequest(
            context,
            `contents/generations/tasks/${encodeURIComponent(operation.id)}`,
            undefined,
            true,
          ),
          z.object({
            id: z.string(),
            status: z.string(),
            content: z
              .object({
                video_url: z.string().url().optional(),
                last_frame_url: z.string().url().optional(),
              })
              .optional(),
            usage: z
              .object({
                completion_tokens: z.number().optional(),
                total_tokens: z.number().optional(),
              })
              .optional(),
          }),
        );
        if (result.id !== operation.id) throw new MediaProviderError('uncertain');
        if (result.status === 'failed' || result.status === 'expired') return { status: 'failed' };
        if (result.status === 'cancelled') return { status: 'cancelled' };
        if (result.status === 'queued' || result.status === 'running')
          return { status: 'running', operationId };
        if (result.status !== 'succeeded' || !result.content?.video_url)
          throw new MediaProviderError('uncertain');
        return {
          status: 'completed',
          parts: [{ kind: 'video', ordinal: 0, type: 'video/mp4', url: result.content.video_url }],
          usage: { outputTokens: result.usage?.completion_tokens },
        };
      },
    },
  ];
}
