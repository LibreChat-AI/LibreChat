import { z } from 'zod';
import type { MediaCapability, MediaConfig } from 'librechat-data-provider';
import type {
  MediaModelProfile,
  MediaProviderAdapter,
  MediaProviderResult,
  MediaProviderContext,
  MediaProviderInput,
} from '../provider';
import {
  nativeRequest,
  nativeDownload,
  dataURI,
  providerOptions,
  encodeOperation,
  decodeOperation,
} from './native';
import { frameInputConstraints, maximumInputs } from './constraints';
import { MediaProviderError } from '../errors';

const images = new Map([
  ['qwen/qwen-image-3-pro', 'qwen-image-3.0-pro'],
  ['qwen/qwen-image-3', 'qwen-image-3.0'],
]);
const videos = new Map([
  ['alibaba/wan-3.0-prime', 'wan3.0-video-prime'],
  ['alibaba/wan-3.0', 'wan3.0-video'],
  ['alibaba/happyhorse-1.1', 'happyhorse-1.1'],
  ['alibaba/happyhorse-1.0', 'happyhorse-1.0'],
]);
const imageOptions = ['prompt_extend', 'prompt_extend_mode', 'enable_thinking', 'watermark'];
const videoOptions = ['prompt_extend', 'watermark'];
const sizes = ['auto', '1024x1024', '1536x1024', '1024x1536', '2048x2048'];
const ratios = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'];
const imageOptionsSchema = z
  .object({
    prompt_extend: z.boolean().optional(),
    prompt_extend_mode: z.enum(['direct', 'agent']).optional(),
    enable_thinking: z.boolean().optional(),
    watermark: z.boolean().optional(),
  })
  .strict();
const videoOptionsSchema = z
  .object({
    prompt_extend: z.boolean().optional(),
    watermark: z.boolean().optional(),
  })
  .strict();

/**
 * DashScope media URLs are model/account-bound; only images accept inline data.
 * Temporary OSS uploads require an eligible regional account (documented for Beijing).
 * https://www.alibabacloud.com/help/en/model-studio/get-temporary-file-url
 */
async function uploadMedia(
  input: MediaProviderInput,
  model: string,
  context: MediaProviderContext,
): Promise<string> {
  const maxBytes =
    input.role === 'audio'
      ? Math.min(15 * 1024 * 1024, context.config.transfers.maxAudioBytes)
      : Math.min(100 * 1024 * 1024, context.config.transfers.maxVideoBytes);
  if (input.data.length > maxBytes) throw new MediaProviderError('rejected');
  const response = await context.transport.json(
    nativeRequest(
      context,
      `api/v1/uploads?action=getPolicy&model=${encodeURIComponent(model)}`,
      undefined,
      true,
    ),
    z.object({
      data: z.object({
        upload_host: z.string().url(),
        upload_dir: z.string().min(1),
        policy: z.string().min(1),
        signature: z.string().min(1),
        oss_access_key_id: z.string().min(1),
        x_oss_object_acl: z.string().min(1),
        x_oss_forbid_overwrite: z.string().min(1),
        max_file_size_mb: z.union([z.string().regex(/^\d+$/), z.number().positive()]),
      }),
    }),
  );
  const policy = response.data;
  const host = new URL(policy.upload_host);
  if (
    host.protocol !== 'https:' ||
    host.username ||
    host.password ||
    host.search ||
    host.hash ||
    host.pathname !== '/' ||
    !/^[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/i.test(host.hostname) ||
    !/^[A-Za-z0-9_/-]+$/.test(policy.upload_dir) ||
    policy.upload_dir.split('/').some((part) => part === '..') ||
    input.data.length > Number(policy.max_file_size_mb) * 1024 * 1024
  ) {
    throw new MediaProviderError('uncertain');
  }
  const audioExtension = input.type === 'audio/mpeg' ? 'mp3' : 'wav';
  const filename = `${encodeURIComponent(input.file_id)}.${input.role === 'video' ? 'mp4' : audioExtension}`;
  const key = `${policy.upload_dir}/${filename}`;
  const form = new FormData();
  form.set('OSSAccessKeyId', policy.oss_access_key_id);
  form.set('Signature', policy.signature);
  form.set('policy', policy.policy);
  form.set('x-oss-object-acl', policy.x_oss_object_acl);
  form.set('x-oss-forbid-overwrite', policy.x_oss_forbid_overwrite);
  form.set('key', key);
  form.set('success_action_status', '200');
  form.set('file', new Blob([new Uint8Array(input.data)], { type: input.type }), filename);
  const upload = nativeRequest(context, 'api/v1/uploads', form);
  await context.transport.json(
    {
      ...upload,
      url: host.href,
      headers: {},
      emptyResponse: { status: 200, body: '{}' },
    },
    z.object({}),
  );
  return `oss://${key}`;
}

function imageProfiles(config: MediaConfig): MediaModelProfile[] {
  return [...images].map(([modelId, modelName]) => ({
    modelId,
    modelName,
    capabilities: (['image.generate', 'image.edit'] as const).map((operation) => ({
      operation,
      constraints: [
        {
          when: [{ kind: 'input', role: 'reference', present: true }],
          anyOf: [
            {
              kind: 'parameter',
              name: 'providerOptions',
              option: 'prompt_extend_mode',
              present: false,
            },
            {
              kind: 'parameter',
              name: 'providerOptions',
              option: 'prompt_extend_mode',
              values: ['direct'],
            },
          ],
        },
        {
          when: [
            {
              kind: 'parameter',
              name: 'providerOptions',
              option: 'enable_thinking',
              values: [true],
            },
          ],
          anyOf: [
            { kind: 'parameter', name: 'providerOptions', option: 'prompt_extend', present: false },
            { kind: 'parameter', name: 'providerOptions', option: 'prompt_extend', values: [true] },
          ],
        },
      ],
      inputs: {
        roles: ['reference'],
        min: operation === 'image.edit' ? 1 : 0,
        max: Math.min(3, config.limits.maxInputs),
      },
      execution: { kind: 'direct', previews: false },
      controls: {
        count: { min: 1, max: Math.min(6, config.limits.maxOutputs), default: 1 },
        size: { values: sizes, default: 'auto' },
        format: { values: ['png'], default: 'png' },
        negativePrompt: true,
        seed: { min: 0, max: 2_147_483_647 },
        providerOptions: imageOptions,
      },
    })),
  }));
}

function videoProfiles(config: MediaConfig): MediaModelProfile[] {
  return [...videos].map(([modelId, modelName]) => {
    const happy = modelName.startsWith('happyhorse');
    const capability: MediaCapability = {
      operation: 'video.generate',
      constraints: happy
        ? undefined
        : [
            ...frameInputConstraints(['reference', 'video', 'audio']),
            maximumInputs('reference', 10),
            maximumInputs('video', 5),
            maximumInputs('audio', 5),
          ],
      inputs: {
        roles: happy
          ? ['start_frame']
          : ['reference', 'start_frame', 'end_frame', 'video', 'audio'],
        min: 0,
        max: Math.min(happy ? 1 : 20, config.limits.maxInputs),
        maxBytes: { audio: 15 * 1024 * 1024, video: 100 * 1024 * 1024 },
      },
      execution: { kind: 'remote-job', cancellation: 'unsupported' },
      controls: {
        count: { min: 1, max: 1, default: 1 },
        durationSeconds: { min: happy ? 3 : 2, max: happy ? 15 : 30, default: 5 },
        resolution: { values: ['480P', '720P', '1080P'], default: '720P' },
        aspectRatio: {
          values: happy ? [...ratios, '4:5', '5:4', '9:21'] : ['adaptive', ...ratios],
          default: '16:9',
        },
        ...(happy ? {} : { audio: true }),
        seed: { min: 0, max: 2_147_483_647 },
        providerOptions: happy ? ['watermark'] : videoOptions,
      },
    };
    return { modelId, modelName, capabilities: [capability] };
  });
}

export function createAlibabaMediaAdapters(): MediaProviderAdapter[] {
  return [
    {
      api: 'alibaba.images',
      configuration: { baseURL: 'https://dashscope-intl.aliyuncs.com' },
      catalog: imageProfiles,
      operations: ['image.generate', 'image.edit'],
      download: nativeDownload,
      async submit(request, inputs, context): Promise<MediaProviderResult> {
        const model = images.get(request.selection.modelId);
        if (
          !model ||
          request.operation === 'video.generate' ||
          inputs.length > 3 ||
          inputs.some((input) => input.role !== 'reference')
        ) {
          throw new MediaProviderError('rejected');
        }
        const options = imageOptionsSchema.safeParse(providerOptions(request, imageOptions));
        if (
          !options.success ||
          (inputs.length && options.data.prompt_extend_mode === 'agent') ||
          (options.data.enable_thinking === true && options.data.prompt_extend === false)
        ) {
          throw new MediaProviderError('rejected');
        }
        const result = await context.transport.json(
          nativeRequest(
            context,
            'compatible-mode/v1/images/generations',
            JSON.stringify({
              ...options.data,
              model,
              prompt: request.prompt,
              image: inputs.length ? inputs.map(dataURI) : undefined,
              n: request.parameters.count,
              size: request.parameters.size,
              seed: request.parameters.seed,
              negative_prompt: request.parameters.negativePrompt,
            }),
          ),
          z.object({
            data: z
              .array(z.object({ url: z.string().url() }))
              .min(1)
              .max(context.config.limits.maxOutputs),
          }),
        );
        return {
          status: 'completed',
          parts: result.data.map((item, ordinal) => ({
            kind: 'image',
            ordinal,
            type: 'image/png',
            url: item.url,
          })),
        };
      },
    },
    {
      api: 'alibaba.videos',
      configuration: { baseURL: 'https://dashscope-intl.aliyuncs.com' },
      catalog: videoProfiles,
      operations: ['video.generate'],
      download: nativeDownload,
      async submit(request, inputs, context): Promise<MediaProviderResult> {
        const model = videos.get(request.selection.modelId);
        if (
          !model ||
          request.operation !== 'video.generate' ||
          inputs.some((input) => input.role === 'mask')
        ) {
          throw new MediaProviderError('rejected');
        }
        const happy = model.startsWith('happyhorse');
        const options = videoOptionsSchema.safeParse(
          providerOptions(request, happy ? ['watermark'] : videoOptions),
        );
        const frames = inputs.filter(
          (input) => input.role === 'start_frame' || input.role === 'end_frame',
        );
        if (
          !options.success ||
          (happy && (inputs.length > 1 || inputs.some((input) => input.role !== 'start_frame'))) ||
          (!happy && frames.length > 0 && frames.length !== inputs.length) ||
          new Set(frames.map((input) => input.role)).size !== frames.length ||
          (frames.some((input) => input.role === 'end_frame') &&
            !frames.some((input) => input.role === 'start_frame')) ||
          inputs.filter((input) => input.role === 'reference').length > 10 ||
          inputs.filter((input) => input.role === 'video').length > 5 ||
          inputs.filter((input) => input.role === 'audio').length > 5
        ) {
          throw new MediaProviderError('rejected');
        }
        const roles = {
          reference: 'reference_image',
          start_frame: 'first_frame',
          end_frame: 'last_frame',
          video: 'reference_video',
          audio: 'reference_audio',
          mask: 'mask',
        };
        const media = await Promise.all(
          inputs.map(async (input) => ({
            type: roles[input.role],
            url:
              input.role === 'video' || input.role === 'audio'
                ? await uploadMedia(input, model, context)
                : dataURI(input),
          })),
        );
        const call = nativeRequest(
          context,
          'api/v1/services/aigc/video-generation/video-synthesis',
          JSON.stringify({
            model: happy ? `${model}-${inputs.length ? 'i2v' : 't2v'}` : model,
            input: {
              prompt: request.prompt,
              ...(inputs.length
                ? {
                    media,
                  }
                : {}),
            },
            parameters: {
              ...options.data,
              resolution: request.parameters.resolution,
              ratio: happy && inputs.length ? undefined : request.parameters.aspectRatio,
              duration: request.parameters.durationSeconds,
              audio: happy ? undefined : request.parameters.audio,
              seed: request.parameters.seed,
            },
          }),
        );
        const result = await context.transport.json(
          {
            ...call,
            headers: {
              ...call.headers,
              'X-DashScope-Async': 'enable',
              ...(media.some((item) => item.url.startsWith('oss://'))
                ? { 'X-DashScope-OssResourceResolve': 'enable' }
                : {}),
            },
          },
          z.object({ output: z.object({ task_id: z.string().min(1) }) }),
        );
        return {
          status: 'running',
          operationId: encodeOperation(
            { id: result.output.task_id, modelId: request.selection.modelId },
            context,
          ),
        };
      },
      async poll(operationId, context): Promise<MediaProviderResult> {
        const operation = decodeOperation(operationId, context);
        if (!videos.has(operation.modelId)) throw new MediaProviderError('uncertain');
        const response = await context.transport.json(
          nativeRequest(
            context,
            `api/v1/tasks/${encodeURIComponent(operation.id)}`,
            undefined,
            true,
          ),
          z.object({
            output: z.object({
              task_id: z.string(),
              task_status: z.string(),
              video_url: z.string().url().optional(),
            }),
          }),
        );
        const result = response.output;
        if (result.task_id !== operation.id) throw new MediaProviderError('uncertain');
        if (result.task_status === 'FAILED') return { status: 'failed' };
        if (result.task_status === 'CANCELED') return { status: 'cancelled' };
        if (result.task_status === 'PENDING' || result.task_status === 'RUNNING')
          return { status: 'running', operationId };
        if (result.task_status !== 'SUCCEEDED' || !result.video_url)
          throw new MediaProviderError('uncertain');
        return {
          status: 'completed',
          parts: [{ kind: 'video', ordinal: 0, type: 'video/mp4', url: result.video_url }],
        };
      },
    },
  ];
}
