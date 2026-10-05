import { z } from 'zod';
import type { MediaConfig } from 'librechat-data-provider';
import type { MediaModelProfile, MediaProviderAdapter, MediaProviderResult } from '../provider';
import {
  nativeRequest,
  nativeParameters,
  nativeDownload,
  dataURI,
  providerOptions,
  encodeOperation,
  decodeOperation,
} from './native';
import { frameInputConstraints, maximumInputs } from './constraints';
import { MediaProviderError } from '../errors';

const models = new Map([
  ['minimax/hailuo-3', 'MiniMax-H3'],
  ['minimax/hailuo-3-max', 'MiniMax-H3-Max'],
  ['minimax/hailuo-2.3', 'MiniMax-Hailuo-2.3'],
]);
const legacyOptions = ['prompt_optimizer', 'fast_pretreatment'];
const legacyOptionSchema = z
  .object({ prompt_optimizer: z.boolean().optional(), fast_pretreatment: z.boolean().optional() })
  .strict();
const modernOptionSchema = z
  .object({
    extra: z
      .object({ prompt_expansion_mode: z.enum(['disabled', 'balanced', 'quality']).optional() })
      .strict()
      .optional(),
  })
  .strict();
const taskId = z.union([z.string().min(1), z.number().int().safe()]);
/** Unknown error, timeout and internal error do not prove the paid task was never created. */
const MINIMAX_SERVER_ERRORS = new Set([1000, 1001, 1013]);

function profiles(config: MediaConfig): MediaModelProfile[] {
  return [...models].map(([modelId, modelName]) => {
    const legacy = modelId.endsWith('2.3');
    const max = modelId.endsWith('-max');
    let resolutions = ['768P', '2K'];
    if (max) resolutions = ['480P', '768P'];
    if (legacy) resolutions = ['768P', '1080P'];
    const modernOptions = max ? ['extra'] : undefined;
    return {
      modelId,
      modelName,
      capabilities: [
        {
          operation: 'video.generate',
          maxPromptChars: legacy ? 2000 : 7000,
          constraints: legacy
            ? [
                {
                  when: [{ kind: 'parameter', name: 'resolution', values: ['1080P'] }],
                  anyOf: [{ kind: 'parameter', name: 'durationSeconds', values: [6] }],
                },
              ]
            : [
                ...frameInputConstraints(['reference', 'video', 'audio'], {
                  lastFrameRequiresFirst: false,
                }),
                maximumInputs('reference', 9),
                maximumInputs('video', 3),
                maximumInputs('audio', 3),
                {
                  when: [{ kind: 'parameter', name: 'aspectRatio', values: ['adaptive'] }],
                  anyOf: (['reference', 'start_frame', 'end_frame', 'video', 'audio'] as const).map(
                    (role) => ({ kind: 'input' as const, role, present: true }),
                  ),
                },
              ],
          inputs: {
            roles: legacy
              ? ['start_frame']
              : ['reference', 'start_frame', 'end_frame', 'video', 'audio'],
            min: 0,
            max: Math.min(legacy ? 1 : 15, config.limits.maxInputs),
            mediaTypes: { video: ['video/mp4'], audio: ['audio/mpeg', 'audio/wav'] },
            maxBytes: legacy
              ? undefined
              : {
                  reference: 30 * 1024 * 1024,
                  start_frame: 30 * 1024 * 1024,
                  end_frame: 30 * 1024 * 1024,
                  video: 50 * 1024 * 1024,
                  audio: 15 * 1024 * 1024,
                },
          },
          execution: { kind: 'remote-job', cancellation: 'unsupported' },
          controls: {
            count: { min: 1, max: 1, default: 1 },
            durationSeconds: legacy
              ? { min: 6, max: 10, values: [6, 10], default: 6 }
              : {
                  min: max ? 5 : 4,
                  max: 15,
                  values: Array.from(
                    { length: max ? 11 : 12 },
                    (_, index) => index + (max ? 5 : 4),
                  ),
                  default: 5,
                },
            resolution: {
              values: resolutions,
              default: '768P',
            },
            ...(legacy
              ? {}
              : {
                  aspectRatio: {
                    values: ['16:9', '21:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
                    default: '16:9',
                  },
                }),
            providerOptions: legacy ? legacyOptions : modernOptions,
          },
        },
      ],
    };
  });
}

export function createMinimaxMediaAdapters(): MediaProviderAdapter[] {
  return [
    {
      api: 'minimax.videos',
      configuration: { baseURL: 'https://api.minimax.io' },
      catalog: profiles,
      operations: ['video.generate'],
      download: nativeDownload,
      async submit(request, inputs, context): Promise<MediaProviderResult> {
        const parameters = nativeParameters(
          request,
          inputs,
          context,
          profiles(context.config)
            .find((profile) => profile.modelId === request.selection.modelId)
            ?.capabilities.find((capability) => capability.operation === request.operation),
        );
        const model = models.get(request.selection.modelId);
        if (!model || request.operation !== 'video.generate')
          throw new MediaProviderError('rejected');
        const legacy = request.selection.modelId.endsWith('2.3');
        const duration = parameters.durationSeconds ?? (legacy ? 6 : 5);
        if (
          !Number.isInteger(duration) ||
          (legacy
            ? ![6, 10].includes(duration)
            : duration < (model === 'MiniMax-H3-Max' ? 5 : 4) || duration > 15)
        )
          throw new MediaProviderError('rejected');
        if (request.prompt.length > (legacy ? 2000 : 7000))
          throw new MediaProviderError('rejected');
        if (legacy) {
          const options = legacyOptionSchema.safeParse(providerOptions(request, legacyOptions));
          if (
            !options.success ||
            inputs.length > 1 ||
            inputs.some((input) => input.role !== 'start_frame')
          )
            throw new MediaProviderError('rejected');
          const result = await context.transport.json(
            nativeRequest(
              context,
              'v1/video_generation',
              JSON.stringify({
                ...options.data,
                model,
                prompt: request.prompt,
                first_frame_image: inputs[0] ? dataURI(inputs[0]) : undefined,
                duration: parameters.durationSeconds ?? 6,
                resolution: parameters.resolution ?? '768P',
              }),
            ),
            z.object({
              task_id: taskId.optional(),
              base_resp: z.object({ status_code: z.number() }),
            }),
          );
          if (result.base_resp.status_code !== 0) {
            const created =
              result.task_id || MINIMAX_SERVER_ERRORS.has(result.base_resp.status_code);
            throw new MediaProviderError(created ? 'uncertain' : 'rejected');
          }
          if (!result.task_id) throw new MediaProviderError('uncertain');
          return {
            status: 'running',
            operationId: encodeOperation(
              { id: String(result.task_id), modelId: request.selection.modelId },
              context,
            ),
          };
        }
        const options = modernOptionSchema.safeParse(
          providerOptions(request, model === 'MiniMax-H3-Max' ? ['extra'] : []),
        );
        const frames = inputs.filter(
          (input) => input.role === 'start_frame' || input.role === 'end_frame',
        );
        if (
          !options.success ||
          inputs.some((input) => input.role === 'mask') ||
          (frames.length > 0 && frames.length !== inputs.length) ||
          new Set(frames.map((input) => input.role)).size !== frames.length ||
          inputs.filter((input) => input.role === 'reference').length > 9 ||
          inputs.filter((input) => input.role === 'video').length > 3 ||
          inputs.filter((input) => input.role === 'audio').length > 3 ||
          inputs.some((input) => input.role === 'video' && input.type !== 'video/mp4') ||
          inputs.some(
            (input) => input.role === 'audio' && !['audio/mpeg', 'audio/wav'].includes(input.type),
          ) ||
          (!inputs.length && parameters.aspectRatio === 'adaptive')
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
        const body = JSON.stringify({
          ...options.data,
          model,
          content: [
            { type: 'text', text: request.prompt },
            ...inputs.map((input) => {
              let type = 'image_url';
              if (input.role === 'video') type = 'video_url';
              else if (input.role === 'audio') type = 'audio_url';
              return { type, [type]: { url: dataURI(input) }, role: roles[input.role] };
            }),
          ],
          resolution: parameters.resolution ?? '768P',
          duration: parameters.durationSeconds ?? 5,
          ratio: frames.length ? 'adaptive' : (parameters.aspectRatio ?? '16:9'),
        });
        if (Buffer.byteLength(body) > 64 * 1024 * 1024) throw new MediaProviderError('rejected');
        const result = await context.transport.json(
          nativeRequest(context, 'v2/video_generation', body),
          z.object({ task_id: taskId }),
        );
        return {
          status: 'running',
          operationId: encodeOperation(
            { id: String(result.task_id), modelId: request.selection.modelId },
            context,
          ),
        };
      },
      async poll(operationId, context): Promise<MediaProviderResult> {
        const operation = decodeOperation(operationId, context);
        if (!models.has(operation.modelId)) throw new MediaProviderError('uncertain');
        if (operation.modelId.endsWith('2.3')) {
          const result = await context.transport.json(
            nativeRequest(
              context,
              `v1/query/video_generation?task_id=${encodeURIComponent(operation.id)}`,
              undefined,
              true,
            ),
            z.object({
              task_id: taskId,
              status: z.string(),
              file_id: taskId.optional(),
              base_resp: z.object({ status_code: z.number() }),
            }),
          );
          if (result.base_resp.status_code !== 0 || String(result.task_id) !== operation.id)
            throw new MediaProviderError('uncertain');
          if (result.status === 'Fail') return { status: 'failed' };
          if (['Preparing', 'Queueing', 'Processing'].includes(result.status))
            return { status: 'running', operationId };
          if (result.status !== 'Success' || !result.file_id)
            throw new MediaProviderError('uncertain');
          const file = await context.transport.json(
            nativeRequest(
              context,
              `v1/files/retrieve?file_id=${encodeURIComponent(result.file_id)}`,
              undefined,
              true,
            ),
            z.object({
              file: z.object({ download_url: z.string().url() }),
              base_resp: z.object({ status_code: z.number() }),
            }),
          );
          if (file.base_resp.status_code !== 0) throw new MediaProviderError('uncertain');
          return {
            status: 'completed',
            parts: [{ kind: 'video', ordinal: 0, type: 'video/mp4', url: file.file.download_url }],
          };
        }
        const response = await context.transport.json(
          nativeRequest(
            context,
            `v2/query/video_generation/${encodeURIComponent(operation.id)}`,
            undefined,
            true,
          ),
          z.object({
            task: z.object({
              id: taskId,
              status: z.string(),
              content: z.object({ url: z.string().url().optional() }).optional(),
              usage: z
                .object({
                  prompt_tokens: z.number().optional(),
                  completion_tokens: z.number().optional(),
                })
                .optional(),
            }),
          }),
        );
        const result = response.task;
        if (String(result.id) !== operation.id) throw new MediaProviderError('uncertain');
        if (result.status === 'failed') return { status: 'failed' };
        if (result.status === 'cancelled') return { status: 'cancelled' };
        if (result.status === 'queued' || result.status === 'running')
          return { status: 'running', operationId };
        if (result.status !== 'succeeded' || !result.content?.url)
          throw new MediaProviderError('uncertain');
        return {
          status: 'completed',
          parts: [{ kind: 'video', ordinal: 0, type: 'video/mp4', url: result.content.url }],
          usage: {
            inputTokens: result.usage?.prompt_tokens,
            outputTokens: result.usage?.completion_tokens,
          },
        };
      },
    },
  ];
}
