import { z } from 'zod';
import type { MediaConfig } from 'librechat-data-provider';
import type { MediaModelProfile, MediaProviderAdapter, MediaProviderResult } from '../provider';
import {
  nativeRequest,
  nativeParameters,
  nativeDownload,
  providerOptions,
  encodeOperation,
  decodeOperation,
} from './native';
import { MediaProviderError } from '../errors';
import { maximumInputs } from './constraints';

const modelId = 'heygen/avatar-iv';
const optionNames = [
  'voice_id',
  'voice_settings',
  'motion_prompt',
  'expressiveness',
  'fit',
  'remove_background',
  'background',
  'caption',
  'title',
];
const optionSchema = z
  .object({
    voice_id: z.string().trim().min(1).optional(),
    voice_settings: z
      .object({
        speed: z.number().min(0.5).max(1.5).optional(),
        pitch: z.number().min(-50).max(50).optional(),
        volume: z.number().min(0).max(1).optional(),
        locale: z.string().optional(),
      })
      .strict()
      .optional(),
    motion_prompt: z.string().optional(),
    expressiveness: z.enum(['high', 'medium', 'low']).optional(),
    fit: z.enum(['contain', 'cover']).optional(),
    remove_background: z.boolean().optional(),
    background: z
      .object({
        type: z.enum(['color', 'image']),
        value: z.string().optional(),
        url: z.string().url().optional(),
        asset_id: z.string().optional(),
      })
      .strict()
      .optional(),
    caption: z
      .object({ file_format: z.enum(['srt', 'vtt']).optional() })
      .strict()
      .optional(),
    title: z.string().optional(),
  })
  .strict();

function profiles(config: MediaConfig): MediaModelProfile[] {
  return [
    {
      modelId,
      modelName: 'Avatar IV',
      capabilities: [
        {
          operation: 'video.generate',
          workflow: 'avatar',
          constraints: [
            maximumInputs('reference', 1),
            {
              anyOf: [
                { kind: 'input', role: 'audio', present: true },
                { kind: 'parameter', name: 'providerOptions', option: 'voice_id', present: true },
              ],
            },
            {
              when: [{ kind: 'input', role: 'audio', present: true }],
              anyOf: [
                { kind: 'parameter', name: 'providerOptions', option: 'voice_id', present: false },
              ],
            },
            {
              when: [{ kind: 'input', role: 'audio', present: true }],
              anyOf: [
                {
                  kind: 'parameter',
                  name: 'providerOptions',
                  option: 'voice_settings',
                  present: false,
                },
              ],
            },
          ],
          inputs: {
            roles: ['reference', 'audio'],
            mediaTypes: { audio: ['audio/mpeg', 'audio/wav'] },
            maxBytes: { audio: 32 * 1024 * 1024 },
            min: 1,
            max: Math.min(2, config.limits.maxInputs),
            requiredRoles: ['reference'],
          },
          execution: { kind: 'remote-job', cancellation: 'unsupported' },
          controls: {
            count: { min: 1, max: 1, default: 1 },
            resolution: { values: ['720p', '1080p', '4k'], default: '720p' },
            aspectRatio: { values: ['16:9', '9:16', '4:5', '5:4', '1:1', 'auto'], default: 'auto' },
            providerOptions: optionNames,
          },
        },
      ],
    },
  ];
}

export function createHeygenMediaAdapters(): MediaProviderAdapter[] {
  return [
    {
      api: 'heygen.videos',
      configuration: { baseURL: 'https://api.heygen.com', keyHeader: 'x-api-key', keyPrefix: '' },
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
        const image = inputs.find((input) => input.role === 'reference');
        const audio = inputs.find((input) => input.role === 'audio');
        const options = optionSchema.safeParse(providerOptions(request, optionNames));
        if (
          request.selection.modelId !== modelId ||
          request.operation !== 'video.generate' ||
          !image ||
          inputs.filter((input) => input.role === 'reference').length !== 1 ||
          inputs.filter((input) => input.role === 'audio').length > 1 ||
          inputs.some((input) => input.role !== 'reference' && input.role !== 'audio') ||
          !options.success
        ) {
          throw new MediaProviderError('rejected');
        }
        let audioAsset: string | undefined;
        if (audio) {
          if (
            !['audio/mpeg', 'audio/wav'].includes(audio.type) ||
            audio.data.length > 32 * 1024 * 1024
          )
            throw new MediaProviderError('rejected');
          const body = new FormData();
          body.set(
            'file',
            new Blob([new Uint8Array(audio.data)], { type: audio.type }),
            `${audio.file_id}.${audio.type === 'audio/mpeg' ? 'mp3' : 'wav'}`,
          );
          const result = await context.transport.json(
            nativeRequest(context, 'v3/assets', body),
            z.object({ data: z.object({ asset_id: z.string().min(1) }) }),
          );
          audioAsset = result.data.asset_id;
        }
        const result = await context.transport.json(
          nativeRequest(
            context,
            'v3/videos',
            JSON.stringify({
              ...options.data,
              type: 'image',
              image: {
                type: 'base64',
                media_type: image.type,
                data: image.data.toString('base64'),
              },
              ...(audioAsset
                ? {
                    audio_asset_id: audioAsset,
                    motion_prompt: options.data.motion_prompt ?? request.prompt,
                  }
                : { script: request.prompt }),
              resolution: parameters.resolution,
              aspect_ratio: parameters.aspectRatio,
            }),
          ),
          z.object({
            data: z.object({ video_id: z.string().min(1), status: z.string().optional() }),
          }),
        );
        return {
          status: 'running',
          operationId: encodeOperation({ id: result.data.video_id, modelId }, context),
        };
      },
      async poll(operationId, context): Promise<MediaProviderResult> {
        const operation = decodeOperation(operationId, context);
        if (operation.modelId !== modelId) throw new MediaProviderError('uncertain');
        const response = await context.transport.json(
          nativeRequest(context, `v3/videos/${encodeURIComponent(operation.id)}`, undefined, true),
          z.object({
            data: z.object({
              id: z.string(),
              status: z.string(),
              video_url: z.string().url().nullable().optional(),
            }),
          }),
        );
        const result = response.data;
        if (result.id !== operation.id) throw new MediaProviderError('uncertain');
        if (result.status === 'failed') return { status: 'failed' };
        if (['pending', 'processing', 'waiting'].includes(result.status))
          return { status: 'running', operationId };
        if (result.status !== 'completed' || !result.video_url)
          throw new MediaProviderError('uncertain');
        return {
          status: 'completed',
          parts: [{ kind: 'video', ordinal: 0, type: 'video/mp4', url: result.video_url }],
        };
      },
    },
  ];
}
