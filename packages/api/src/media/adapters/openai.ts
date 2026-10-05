import { z } from 'zod';
import { validateMediaCapability } from 'librechat-data-provider';
import type { MediaCapability, MediaConfig, MediaSubmissionRequest } from 'librechat-data-provider';
import type {
  MediaProviderAdapter,
  MediaProviderContext,
  MediaProviderInput,
  MediaProviderResult,
  MediaProviderUsage,
} from '../provider';
import { dataURI, imageBytes, nativeDownload, nativeRequest, providerOptions } from './native';
import { mediaDiagnosticSecrets, sanitizeMediaProviderDiagnostic } from '../diagnostics';
import { MediaProviderError } from '../errors';
import { maximumInputs } from './constraints';
import { mediaAPIURL } from '../provider';

const images = new Map([
  ['gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst'],
  ['gpt-image-2.5-flare', 'GPT Image 2.5 Flare'],
  ['gpt-image-2', 'GPT Image 2'],
  ['gpt-image-1', 'GPT Image 1'],
  ['gpt-image-1-mini', 'GPT Image 1 Mini'],
]);
const wrappers = new Map([
  ['gpt-5.4-image-2', { model: 'gpt-5.4', image: 'gpt-image-2', name: 'GPT-5.4 + GPT Image 2' }],
  ['gpt-5-image', { model: 'gpt-5', image: 'gpt-image-1', name: 'GPT-5 + GPT Image 1' }],
]);
const sizes = ['auto', '1024x1024', '1536x1024', '1024x1536'];
const largeSizes = [
  ...sizes,
  '1536x864',
  '864x1536',
  '2048x2048',
  '2048x1152',
  '3840x2160',
  '2160x3840',
];

function modelId(id: string): string {
  return id.replace(/^openai\//, '');
}

function compatibleImageCapabilities(model: string, config: MediaConfig): MediaCapability[] {
  const dalle2 = model === 'dall-e-2';
  const dalle3 = model === 'dall-e-3';
  const operations: Array<'image.generate' | 'image.edit'> = dalle2
    ? ['image.generate', 'image.edit']
    : ['image.generate'];
  const availableSizes = dalle2 ? ['256x256', '512x512', '1024x1024'] : ['1024x1024'];
  if (dalle3) availableSizes.push('1792x1024', '1024x1792');
  return operations.map((operation) => ({
    operation,
    constraints: operation === 'image.edit' ? [maximumInputs('reference', 1)] : undefined,
    inputs: {
      roles: operation === 'image.edit' ? ['reference', 'mask'] : [],
      min: operation === 'image.edit' ? 1 : 0,
      max: operation === 'image.edit' ? Math.min(2, config.limits.maxInputs) : 0,
    },
    execution: { kind: 'direct', previews: false },
    controls: {
      count: { min: 1, max: dalle2 ? Math.min(10, config.limits.maxOutputs) : 1 },
      size: { values: availableSizes },
      ...(dalle3 ? { quality: { values: ['standard', 'hd'] } } : {}),
    },
  }));
}

export function openAIImageCapabilities(id: string, config: MediaConfig): MediaCapability[] {
  const selected = modelId(id);
  const wrapper = wrappers.get(selected);
  const model = wrapper?.image ?? selected;
  if (!/^gpt-image-[A-Za-z0-9._-]+$/.test(model)) {
    return compatibleImageCapabilities(model, config);
  }
  const second = model.startsWith('gpt-image-2');
  return (['image.generate', 'image.edit'] as const).map((operation) => ({
    operation,
    inputs: {
      roles: operation === 'image.edit' ? ['reference', 'mask'] : [],
      min: operation === 'image.edit' ? 1 : 0,
      max: operation === 'image.edit' ? Math.min(16, config.limits.maxInputs) : 0,
    },
    execution: { kind: 'direct', previews: false },
    controls: {
      count: { min: 1, max: wrapper ? 1 : Math.min(10, config.limits.maxOutputs) },
      size: { values: second ? largeSizes : sizes },
      quality: {
        values: [
          'auto',
          'low',
          'medium',
          'high',
          ...(model.startsWith('gpt-image-2.5-') ? ['xhigh', 'max'] : []),
        ],
      },
      format: { values: ['png', 'jpeg', 'webp'] },
      background: {
        values: model === 'gpt-image-2' ? ['auto', 'opaque'] : ['auto', 'opaque', 'transparent'],
      },
      outputCompression: { min: 0, max: 100 },
    },
  }));
}

const usageSchema = z
  .object({
    input_tokens: z.number().nonnegative().optional(),
    output_tokens: z.number().nonnegative().optional(),
    input_tokens_details: z
      .object({
        text_tokens: z.number().nonnegative().optional(),
        image_tokens: z.number().nonnegative().optional(),
        cached_tokens: z.number().nonnegative().optional(),
        cached_tokens_details: z
          .object({
            text_tokens: z.number().nonnegative().optional(),
            image_tokens: z.number().nonnegative().optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .optional();

function imageUsage(usage: z.infer<typeof usageSchema>): MediaProviderUsage | undefined {
  if (!usage) return;
  const details = usage.input_tokens_details;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(details
      ? {
          textInputTokens: details.text_tokens,
          imageInputTokens: details.image_tokens,
          cachedInputTokens: details.cached_tokens,
          cachedTextInputTokens: details.cached_tokens_details?.text_tokens,
          cachedImageInputTokens: details.cached_tokens_details?.image_tokens,
        }
      : {}),
  };
}

async function submitImages(
  request: MediaSubmissionRequest,
  inputs: MediaProviderInput[],
  context: MediaProviderContext,
): Promise<MediaProviderResult> {
  const selected = modelId(request.selection.modelId);
  const wrapper = wrappers.get(selected);
  const gptImage = wrapper !== undefined || /^gpt-image-[A-Za-z0-9._-]+$/.test(selected);
  const capability = openAIImageCapabilities(selected, context.config).find(
    (entry) => entry.operation === request.operation,
  );
  if (
    request.operation === 'video.generate' ||
    !capability ||
    inputs.some((input) => input.role !== 'reference' && input.role !== 'mask') ||
    inputs.filter((input) => input.role === 'mask').length > 1 ||
    (request.operation === 'image.edit' && !inputs.some((input) => input.role === 'reference')) ||
    (request.operation === 'image.generate' && inputs.length) ||
    (selected === 'dall-e-2' && inputs.filter((input) => input.role === 'reference').length > 1) ||
    (!gptImage &&
      (request.parameters.format !== undefined ||
        request.parameters.background !== undefined ||
        request.parameters.outputCompression !== undefined)) ||
    (wrapper && request.parameters.count !== 1)
  ) {
    throw new MediaProviderError('rejected');
  }
  if (!gptImage && validateMediaCapability(request, capability, context.config.limits).length) {
    throw new MediaProviderError('rejected');
  }
  providerOptions(request, []);
  const parameters = request.parameters;
  const fields = {
    model: context.connection.options?.deployments?.[selected] ?? selected,
    prompt: request.prompt,
    n: parameters.count,
    size: parameters.size,
    quality: parameters.quality,
    output_format: parameters.format,
    background: parameters.background,
    output_compression: parameters.outputCompression,
  };
  if (wrapper) {
    const mask = inputs.find((input) => input.role === 'mask');
    const body = JSON.stringify({
      model: context.connection.options?.deployments?.[wrapper.model] ?? wrapper.model,
      store: false,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: request.prompt },
            ...inputs
              .filter((input) => input.role === 'reference')
              .map((input) => ({ type: 'input_image', image_url: dataURI(input) })),
          ],
        },
      ],
      tools: [
        {
          type: 'image_generation',
          model: context.connection.options?.deployments?.[wrapper.image] ?? wrapper.image,
          size: fields.size,
          quality: fields.quality,
          output_format: fields.output_format,
          background: fields.background,
          output_compression: fields.output_compression,
          input_image_mask: mask ? { image_url: dataURI(mask) } : undefined,
        },
      ],
      tool_choice: { type: 'image_generation' },
      max_tool_calls: 1,
    });
    const response = await context.transport.json(
      nativeRequest(context, 'responses', body),
      z.object({
        status: z.string(),
        error: z.object({ code: z.string(), message: z.string() }).nullish(),
        incomplete_details: z.object({ reason: z.string().optional() }).nullish(),
        output: z
          .array(
            z.object({
              type: z.string(),
              result: z.string().nullable().optional(),
              status: z.string().optional(),
            }),
          )
          .max(context.config.limits.maxNativeParts),
        usage: usageSchema,
      }),
    );
    if (response.status === 'failed' || response.status === 'incomplete')
      return {
        status: 'failed',
        diagnostic: sanitizeMediaProviderDiagnostic(
          response.error ?? { code: response.incomplete_details?.reason },
          context.config.recovery.maxDiagnosticMessageChars,
          mediaDiagnosticSecrets(context.connection.headers),
        ),
      };
    if (response.status !== 'completed') throw new MediaProviderError('uncertain');
    const output = response.output.filter(
      (part) => part.type === 'image_generation_call' && part.result,
    );
    if (!output.length) return { status: 'failed' };
    if (output.length > context.config.limits.maxOutputs) throw new MediaProviderError('uncertain');
    return {
      status: 'completed',
      parts: output.map((part, ordinal) => ({
        kind: 'image',
        ordinal,
        type: `image/${parameters.format ?? 'png'}`,
        data: imageBytes(part.result!, context),
      })),
      usage: imageUsage(response.usage),
    };
  }
  let body: string | FormData;
  let path: string;
  if (request.operation === 'image.edit') {
    path = 'images/edits';
    const form = new FormData();
    for (const [key, value] of Object.entries(fields))
      if (value !== undefined) form.set(key, String(value));
    const imageField = selected === 'dall-e-2' ? 'image' : 'image[]';
    for (const input of inputs)
      form.append(
        input.role === 'mask' ? 'mask' : imageField,
        new Blob([new Uint8Array(input.data)], { type: input.type }),
        `${input.file_id}.${input.type.split('/')[1]}`,
      );
    body = form;
  } else {
    path = 'images/generations';
    body = JSON.stringify(fields);
  }
  const response = await context.transport.json(
    nativeRequest(context, path, body),
    z.object({
      data: z
        .array(
          z.object({
            b64_json: z.string().optional(),
            url: z.string().url().optional(),
            media_type: z.string().optional(),
          }),
        )
        .min(1)
        .max(context.config.limits.maxOutputs),
      usage: usageSchema,
    }),
  );
  return {
    status: 'completed',
    parts: response.data.map((part, ordinal) => ({
      kind: 'image',
      ordinal,
      type: part.media_type ?? `image/${parameters.format ?? 'png'}`,
      data: part.b64_json ? imageBytes(part.b64_json, context) : undefined,
      url: part.url,
    })),
    usage: imageUsage(response.usage),
  };
}

const videoSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  progress: z.number().optional(),
  error: z.object({ code: z.string(), message: z.string() }).nullish(),
});

function videoResult(
  response: z.infer<typeof videoSchema>,
  context: MediaProviderContext,
): MediaProviderResult {
  if (response.status === 'failed' || response.status === 'expired')
    return {
      status: 'failed',
      diagnostic: sanitizeMediaProviderDiagnostic(
        response.error ?? undefined,
        context.config.recovery.maxDiagnosticMessageChars,
        mediaDiagnosticSecrets(context.connection.headers),
      ),
    };
  if (response.status === 'cancelled') return { status: 'cancelled' };
  if (response.status !== 'completed')
    return { status: 'running', operationId: response.id, progress: response.progress };
  return {
    status: 'completed',
    parts: [
      {
        kind: 'video',
        ordinal: 0,
        type: 'video/mp4',
        url: mediaAPIURL(context.connection, `videos/${encodeURIComponent(response.id)}/content`),
      },
    ],
  };
}

export function openAIVideoCapabilities(id: string): MediaCapability[] {
  const model = modelId(id);
  if (!['sora-2', 'sora-2-pro'].includes(model)) return [];
  return [
    {
      operation: 'video.generate',
      inputs: { roles: ['start_frame'], min: 0, max: 1 },
      execution: { kind: 'remote-job', cancellation: 'unsupported' },
      controls: {
        count: { min: 1, max: 1 },
        durationSeconds: { min: 4, max: 20, values: [4, 8, 12, 16, 20] },
        resolution: {
          values: [
            '720x1280',
            '1280x720',
            ...(model === 'sora-2-pro' ? ['1024x1792', '1792x1024', '1920x1080', '1080x1920'] : []),
          ],
        },
      },
    },
  ];
}

export function createOpenAIMediaAdapters(): MediaProviderAdapter[] {
  return [
    {
      api: 'openai.images',
      configuration: { baseURL: 'https://api.openai.com/v1' },
      operations: ['image.generate', 'image.edit'],
      catalog: (config) => [
        ...[...images].map(([id, modelName]) => ({
          modelId: `openai/${id}`,
          modelName,
          capabilities: openAIImageCapabilities(id, config),
        })),
        ...[...wrappers].map(([id, wrapper]) => ({
          modelId: `openai/${id}`,
          modelName: wrapper.name,
          capabilities: openAIImageCapabilities(id, config),
        })),
        {
          modelId: 'openai/gpt-5-image-mini',
          modelName: 'GPT-5 Mini + GPT Image 1 Mini',
          capabilities: [],
          unavailableReason: 'unsupported' as const,
        },
      ],
      submit: submitImages,
      download: nativeDownload,
    },
    {
      api: 'openai.videos',
      configuration: { baseURL: 'https://api.openai.com/v1' },
      operations: ['video.generate'],
      catalog: () => [
        {
          modelId: 'openai/sora-2-pro',
          modelName: 'Sora 2 Pro',
          capabilities: openAIVideoCapabilities('sora-2-pro'),
        },
      ],
      async submit(request, inputs, context) {
        const model = modelId(request.selection.modelId);
        if (
          request.operation !== 'video.generate' ||
          !openAIVideoCapabilities(model).length ||
          inputs.length > 1 ||
          inputs.some((input) => input.role !== 'start_frame') ||
          request.parameters.count !== 1
        )
          throw new MediaProviderError('rejected');
        providerOptions(request, []);
        const body = new FormData();
        body.set('model', context.connection.options?.deployments?.[model] ?? model);
        body.set('prompt', request.prompt);
        if (request.parameters.durationSeconds != null)
          body.set('seconds', String(request.parameters.durationSeconds));
        if (request.parameters.resolution) body.set('size', request.parameters.resolution);
        if (inputs[0])
          body.set(
            'input_reference',
            new Blob([new Uint8Array(inputs[0].data)], { type: inputs[0].type }),
            'reference.png',
          );
        return videoResult(
          await context.transport.json(nativeRequest(context, 'videos', body), videoSchema),
          context,
        );
      },
      async poll(id, context) {
        const result = await context.transport.json(
          nativeRequest(context, `videos/${encodeURIComponent(id)}`, undefined, true),
          videoSchema,
        );
        if (result.id !== id) throw new MediaProviderError('uncertain');
        return videoResult(result, context);
      },
      async download(part, context) {
        if (part.data) return nativeDownload(part, context);
        if (!part.url || new URL(part.url).origin !== new URL(context.connection.baseURL).origin)
          throw new MediaProviderError('uncertain');
        return context.transport.stream({
          url: part.url,
          headers: context.connection.headers,
          signal: context.signal,
          timeoutMs: context.config.timeouts.downloadMs,
          maxBytes: context.config.transfers.maxVideoBytes,
          maxRedirects: context.config.transfers.maxRedirects,
        });
      },
    },
  ];
}
