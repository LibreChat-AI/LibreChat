import { z } from 'zod';
import type { MediaCapability, MediaConfig } from 'librechat-data-provider';
import type { MediaModelProfile, MediaProviderAdapter, MediaProviderContext } from '../provider';
import {
  decodeOperation,
  encodeOperation,
  nativeDownload,
  nativeRequest,
  providerOptions,
} from './native';
import { frameInputConstraints } from './constraints';
import { MediaProviderError } from '../errors';

const imageModels = new Map([
  ['black-forest-labs/flux.2-max', ['flux-2-max', 'FLUX.2 Max']],
  ['black-forest-labs/flux.2-pro', ['flux-2-pro', 'FLUX.2 Pro']],
  ['black-forest-labs/flux.2-flex', ['flux-2-flex', 'FLUX.2 Flex']],
  ['black-forest-labs/flux.2-klein-4b', ['flux-2-klein-4b', 'FLUX.2 Klein 4B']],
]);
const videoModels = new Map([
  ['black-forest-labs/flux-3-video', ['flux-3-video', 'FLUX 3 Video']],
  ['black-forest-labs/flux-video-edit', ['flux-tools/video-edit-v1', 'FLUX Video Edit']],
  ['black-forest-labs/flux-video-upscale', ['flux-tools/video-upscale-v1', 'FLUX Video Upscale']],
]);
const ratios = ['21:9', '2:1', '16:9', '4:3', '1:1', '3:4', '9:16'];

function imageOptions(model: string): string[] {
  if (model.endsWith('flex')) return ['prompt_upsampling', 'steps', 'safety_tolerance'];
  if (model.includes('klein')) return ['safety_tolerance'];
  return ['disable_pup', 'safety_tolerance'];
}

function imageCatalog(config: MediaConfig): MediaModelProfile[] {
  return [...imageModels].map(([modelId, [, modelName]]) => ({
    modelId,
    modelName,
    capabilities: (['image.generate', 'image.edit'] as const).map((operation) => ({
      operation,
      inputs: {
        roles: ['reference'],
        min: operation === 'image.edit' ? 1 : 0,
        max: Math.min(modelId.includes('klein') ? 4 : 8, config.limits.maxInputs),
      },
      execution: { kind: 'remote-job', cancellation: 'unsupported' },
      controls: {
        count: { min: 1, max: 1 },
        size: { values: ['1024x1024', '1536x1024', '1024x1536', '2048x2048'] },
        format: { values: ['png', 'jpeg'] },
        seed: { min: 0, max: 4_294_967_295 },
        ...(modelId.endsWith('flex') ? { guidance: { min: 1.5, max: 10, default: 5 } } : {}),
        providerOptions: imageOptions(modelId),
      },
    })),
  }));
}

function videoCatalog(config: MediaConfig): MediaModelProfile[] {
  return [...videoModels].map(([modelId, [, modelName]]) => {
    let workflow: 'generate' | 'edit' | 'upscale' = 'generate';
    if (modelId.endsWith('upscale')) workflow = 'upscale';
    else if (modelId.endsWith('edit')) workflow = 'edit';
    const capability: MediaCapability = {
      operation: 'video.generate',
      workflow,
      constraints:
        workflow === 'generate'
          ? [
              ...frameInputConstraints(['video']),
              {
                when: [{ kind: 'input', role: 'video', present: true }],
                anyOf: [
                  { kind: 'parameter', name: 'durationSeconds', present: false },
                  {
                    kind: 'parameter',
                    name: 'durationSeconds',
                    values: Array.from({ length: 11 }, (_, index) => index + 5),
                  },
                ],
              },
            ]
          : undefined,
      inputs: {
        roles: workflow === 'generate' ? ['start_frame', 'end_frame', 'video'] : ['video'],
        mediaTypes: { video: ['video/mp4'] },
        requiredRoles: workflow === 'generate' ? [] : ['video'],
        min: workflow === 'generate' ? 0 : 1,
        max: workflow === 'generate' ? Math.min(2, config.limits.maxInputs) : 1,
      },
      execution: { kind: 'remote-job', cancellation: 'unsupported' },
      controls: {
        count: { min: 1, max: 1 },
        ...(workflow === 'generate'
          ? {
              durationSeconds: {
                min: 5,
                max: 20,
                values: Array.from({ length: 16 }, (_, i) => i + 5),
              },
              aspectRatio: { values: ['auto', ...ratios] },
              resolution: { values: ['720p', '1080p', '2K', '4K'], default: '720p' },
              audio: true,
              providerOptions: ['safety_tolerance', 'version', 'draft'],
            }
          : { providerOptions: ['safety_tolerance'] }),
        ...(workflow === 'upscale'
          ? {
              upscaleFactor: { min: 1.5, max: 3, default: 2 },
              creativity: { min: 0, max: 1, values: [0, 1], default: 1 },
            }
          : {}),
      },
    };
    return { modelId, modelName, capabilities: [capability] };
  });
}

function pollingURL(value: string, id: string, context: MediaProviderContext): string {
  const url = new URL(value);
  const root = new URL(context.connection.baseURL);
  const bflHost = (host: string) =>
    host === 'api.bfl.ai' || /^api\.[a-z0-9-]+\.bfl\.ai$/.test(host);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== '/v1/get_result' ||
    url.searchParams.get('id') !== id ||
    (url.origin !== root.origin && !(bflHost(root.hostname) && bflHost(url.hostname) && !url.port))
  )
    throw new MediaProviderError('uncertain');
  return url.href;
}

export function createBFLMediaAdapters(): MediaProviderAdapter[] {
  return (['bfl.images', 'bfl.videos'] as const).map((api) => ({
    api,
    configuration: { baseURL: 'https://api.bfl.ai/v1', keyHeader: 'x-key', keyPrefix: '' },
    operations: api === 'bfl.images' ? ['image.generate', 'image.edit'] : ['video.generate'],
    catalog: api === 'bfl.images' ? imageCatalog : videoCatalog,
    download: nativeDownload,
    async submit(request, inputs, context) {
      const modelId = request.selection.modelId;
      const model = (api === 'bfl.images' ? imageModels : videoModels).get(modelId);
      if (!model || request.parameters.count !== 1) throw new MediaProviderError('rejected');
      let body: string;
      if (api === 'bfl.images') {
        if (
          request.operation === 'video.generate' ||
          (request.operation === 'image.edit' && !inputs.length) ||
          inputs.length > (modelId.includes('klein') ? 4 : 8) ||
          inputs.some(
            (input) => input.role !== 'reference' || !/^image\/(png|jpeg|webp)$/.test(input.type),
          )
        ) {
          throw new MediaProviderError('rejected');
        }
        const [width, height] = request.parameters.size?.split('x').map(Number) ?? [];
        if (request.parameters.size && (!Number.isInteger(width) || !Number.isInteger(height))) {
          throw new MediaProviderError('rejected');
        }
        body = JSON.stringify({
          ...providerOptions(request, imageOptions(modelId)),
          prompt: request.prompt,
          width,
          height,
          output_format: request.parameters.format,
          seed: request.parameters.seed,
          guidance: request.parameters.guidance,
          ...Object.fromEntries(
            inputs.map((input, index) => [
              index ? `input_image_${index + 1}` : 'input_image',
              input.data.toString('base64'),
            ]),
          ),
        });
      } else {
        if (request.operation !== 'video.generate') throw new MediaProviderError('rejected');
        if (
          modelId.endsWith('video') &&
          request.parameters.durationSeconds !== undefined &&
          (!Number.isInteger(request.parameters.durationSeconds) ||
            request.parameters.durationSeconds < 5 ||
            request.parameters.durationSeconds > 20)
        )
          throw new MediaProviderError('rejected');
        const source = inputs.find((input) => input.role === 'video');
        const options = providerOptions(
          request,
          modelId.endsWith('video')
            ? ['safety_tolerance', 'version', 'draft']
            : ['safety_tolerance'],
        );
        if (modelId.endsWith('edit') || modelId.endsWith('upscale')) {
          if (inputs.length !== 1 || !source || source.type !== 'video/mp4')
            throw new MediaProviderError('rejected');
          body = JSON.stringify(
            modelId.endsWith('edit')
              ? { ...options, video: source.data.toString('base64'), prompt: request.prompt }
              : {
                  ...options,
                  input_video: source.data.toString('base64'),
                  prompt: request.prompt,
                  upscale_factor: request.parameters.upscaleFactor,
                  creativity: request.parameters.creativity,
                },
          );
        } else {
          if (
            inputs.some((input) => !['video', 'start_frame', 'end_frame'].includes(input.role)) ||
            (source && (inputs.length !== 1 || source.type !== 'video/mp4')) ||
            (!source && inputs.some((input) => !/^image\/(png|jpeg|webp)$/.test(input.type))) ||
            inputs.filter((input) => input.role === 'start_frame').length > 1 ||
            inputs.filter((input) => input.role === 'end_frame').length > 1 ||
            (inputs.some((input) => input.role === 'end_frame') &&
              !inputs.some((input) => input.role === 'start_frame')) ||
            (source && (request.parameters.durationSeconds ?? 5) > 15)
          )
            throw new MediaProviderError('rejected');
          const frames = [
            ...inputs.filter((input) => input.role === 'start_frame'),
            ...inputs.filter((input) => input.role === 'end_frame'),
          ];
          const resolutions: Record<string, string> = {
            '720p': 'hd',
            '1080p': 'fhd',
            '2K': 'qhd',
            '4K': 'uhd',
          };
          const imageMode = inputs.length ? 'i2v' : 't2v';
          body = JSON.stringify({
            ...options,
            mode: source ? 'v2v' : imageMode,
            prompt: request.prompt,
            start_video: source?.data.toString('base64'),
            keyframes:
              !source && frames.length
                ? frames.map((input) => input.data.toString('base64'))
                : undefined,
            aspect_ratio: request.parameters.aspectRatio,
            duration: request.parameters.durationSeconds,
            resolution: request.parameters.resolution
              ? resolutions[request.parameters.resolution]
              : undefined,
            generate_audio: request.parameters.audio,
          });
        }
      }
      const response = await context.transport.json(
        nativeRequest(context, model[0], body),
        z.object({ id: z.string().min(1), polling_url: z.string().url() }),
      );
      return {
        status: 'running',
        operationId: encodeOperation(
          {
            id: response.id,
            modelId,
            pollingURL: pollingURL(response.polling_url, response.id, context),
            outputType:
              request.operation === 'video.generate'
                ? 'video/mp4'
                : `image/${request.parameters.format ?? 'jpeg'}`,
          },
          context,
        ),
      };
    },
    async poll(operationId, context) {
      const operation = decodeOperation(operationId, context);
      const models = api === 'bfl.images' ? imageModels : videoModels;
      if (!models.has(operation.modelId) || !operation.pollingURL)
        throw new MediaProviderError('uncertain');
      const response = await context.transport.json(
        {
          ...nativeRequest(context, '', undefined, true),
          url: pollingURL(operation.pollingURL, operation.id, context),
        },
        z.object({
          id: z.string(),
          status: z.string(),
          progress: z.number().optional().nullable(),
          result: z.object({ sample: z.string().url().optional() }).optional().nullable(),
        }),
      );
      if (response.id !== operation.id) throw new MediaProviderError('uncertain');
      if (['Pending', 'Reasoning', 'Generating'].includes(response.status))
        return { status: 'running', operationId, progress: response.progress ?? undefined };
      if (
        ['Error', 'Failed', 'Request Moderated', 'Content Moderated', 'Task not found'].includes(
          response.status,
        )
      )
        return { status: 'failed' };
      if (response.status !== 'Ready' || !response.result?.sample)
        throw new MediaProviderError('uncertain');
      const video = api === 'bfl.videos';
      return {
        status: 'completed',
        parts: [
          {
            kind: video ? 'video' : 'image',
            ordinal: 0,
            type: operation.outputType ?? (video ? 'video/mp4' : 'image/jpeg'),
            url: response.result.sample,
          },
        ],
      };
    },
  }));
}
