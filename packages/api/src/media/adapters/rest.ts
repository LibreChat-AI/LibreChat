import { z } from 'zod';
import { Readable } from 'node:stream';
import { mediaSourceURLSchema } from 'librechat-data-provider';
import type { MediaSubmissionRequest } from 'librechat-data-provider';
import type {
  MediaProviderContext,
  MediaProviderAdapter,
  MediaProviderInput,
  MediaProviderPart,
  MediaProviderResult,
} from '../provider';
import { mediaImageRouting, mediaVideoPolicySupported } from '../routing';
import { createSourcefulMediaAdapters } from './sourceful';
import { createMicrosoftImageAdapter } from './microsoft';
import { createRecraftMediaAdapters } from './recraft';
import { createAlibabaMediaAdapters } from './alibaba';
import { createMinimaxMediaAdapters } from './minimax';
import { createRunwayMediaAdapters } from './runway';
import { createHeygenMediaAdapters } from './heygen';
import { createOpenAIMediaAdapters } from './openai';
import { createGoogleMediaAdapters } from './google';
import { createAtlasMediaAdapters } from './atlas';
import { createVertexVideoAdapter } from './veo';
import { createKreaMediaAdapters } from './krea';
import { createSeedMediaAdapters } from './seed';
import { createBFLMediaAdapters } from './bfl';
import { createXAIMediaAdapters } from './xai';
import { MediaProviderError } from '../errors';
import { mediaAPIURL } from '../provider';

const usageSchema = z
  .object({
    cost: z.number().nonnegative().optional(),
    is_byok: z.boolean().optional(),
    cost_details: z
      .object({ upstream_inference_cost: z.number().nonnegative().nullish() })
      .passthrough()
      .nullish(),
    prompt_tokens: z.number().nonnegative().optional(),
    completion_tokens: z.number().nonnegative().optional(),
    input_tokens: z.number().nonnegative().optional(),
    output_tokens: z.number().nonnegative().optional(),
  })
  .optional();

function requestOptions(context: MediaProviderContext, path: string, body?: string) {
  return {
    url: mediaAPIURL(context.connection, path),
    headers: context.connection.headers,
    signal: context.signal,
    timeoutMs: context.config.timeouts.submitMs,
    maxBytes: Math.max(
      context.config.transfers.maxImageBytes * context.config.limits.maxOutputs * 2,
      Buffer.byteLength(body ?? ''),
    ),
  };
}

function asReference(input: MediaProviderInput) {
  const hosted = input.type.startsWith('video/') || input.type.startsWith('audio/');
  if (hosted && !mediaSourceURLSchema.safeParse(input.sourceURL).success) {
    throw new MediaProviderError('rejected');
  }
  const url = hosted
    ? input.sourceURL!
    : `data:${input.type};base64,${input.data.toString('base64')}`;
  if (input.type.startsWith('video/')) return { type: 'video_url', video_url: { url } };
  if (input.type.startsWith('audio/')) return { type: 'audio_url', audio_url: { url } };
  return {
    type: 'image_url',
    image_url: { url },
  };
}

function providerUsage(usage: z.infer<typeof usageSchema>) {
  if (!usage) {
    return undefined;
  }
  /** With a bring-your-own key, `cost` is only OpenRouter's fee; the provider bills the rest. */
  const upstream = usage.is_byok ? (usage.cost_details?.upstream_inference_cost ?? 0) : 0;
  return {
    costUSD: usage.cost === undefined ? undefined : usage.cost + upstream,
    inputTokens: usage.prompt_tokens ?? usage.input_tokens,
    outputTokens: usage.completion_tokens ?? usage.output_tokens,
  };
}

async function download(
  part: Extract<MediaProviderPart, { kind: 'image' | 'video' }>,
  context: MediaProviderContext,
): Promise<Readable> {
  if (part.data) {
    return Readable.from([part.data]);
  }
  if (!part.url) {
    throw new MediaProviderError('uncertain');
  }
  const url = new URL(part.url);
  const sameOrigin = url.origin === new URL(context.connection.baseURL).origin;
  return context.transport.stream({
    url: url.href,
    headers: sameOrigin ? context.connection.headers : {},
    signal: context.signal,
    timeoutMs: context.config.timeouts.downloadMs,
    maxBytes:
      part.kind === 'video'
        ? context.config.transfers.maxVideoBytes
        : context.config.transfers.maxImageBytes,
    maxRedirects: context.config.transfers.maxRedirects,
  });
}

async function submitImages(
  request: MediaSubmissionRequest,
  inputs: MediaProviderInput[],
  context: MediaProviderContext,
): Promise<MediaProviderResult> {
  if (request.operation === 'video.generate') {
    throw new MediaProviderError('rejected');
  }
  const parameters = request.parameters;
  if (parameters.providerOptions && !context.providerTag) throw new MediaProviderError('rejected');
  const body = JSON.stringify({
    model: request.selection.modelId,
    prompt: request.prompt,
    n: parameters.count,
    size: parameters.size,
    quality: parameters.quality,
    output_format: parameters.format,
    output_compression: parameters.outputCompression,
    background: parameters.background,
    aspect_ratio: parameters.aspectRatio,
    resolution: parameters.resolution,
    seed: parameters.seed,
    input_references: inputs.map(asReference),
    provider: {
      ...mediaImageRouting(context.connection.routing, context.providerTag),
      ...(parameters.providerOptions && context.providerTag
        ? { options: { [context.providerTag.split('/')[0]]: parameters.providerOptions } }
        : {}),
    },
  });
  const result = await context.transport.json(
    {
      ...requestOptions(context, 'images', body),
      method: 'POST',
      headers: { ...context.connection.headers, 'Content-Type': 'application/json' },
      body,
    },
    z.object({
      data: z
        .array(
          z.object({
            b64_json: z.string().optional(),
            url: z.string().url().optional(),
            media_type: z.string().optional(),
            revised_prompt: z.string().optional(),
          }),
        )
        .min(1)
        .max(context.config.limits.maxOutputs),
      usage: usageSchema,
    }),
  );
  return {
    status: 'completed',
    usage: providerUsage(result.usage),
    parts: result.data.map((part, ordinal) => ({
      kind: 'image',
      ordinal,
      type:
        part.media_type ??
        (parameters.format === 'svg' ? 'image/svg+xml' : `image/${parameters.format ?? 'png'}`),
      data: part.b64_json ? Buffer.from(part.b64_json, 'base64') : undefined,
      url: part.url,
    })),
  };
}

const videoResponseSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  progress: z.number().optional(),
  unsigned_urls: z.array(z.string().url()).optional(),
  usage: usageSchema,
});

function videoResult(
  response: z.infer<typeof videoResponseSchema>,
  context: MediaProviderContext,
): MediaProviderResult {
  if (response.status === 'failed' || response.status === 'expired') {
    return { status: 'failed', usage: providerUsage(response.usage) };
  }
  if (response.status === 'cancelled') {
    return { status: 'cancelled', usage: providerUsage(response.usage) };
  }
  if (response.status !== 'completed') {
    return { status: 'running', operationId: response.id, progress: response.progress };
  }
  const outputs = response.unsigned_urls?.length ?? 1;
  if (outputs > context.config.limits.maxOutputs) {
    throw new MediaProviderError('uncertain');
  }
  return {
    status: 'completed',
    usage: providerUsage(response.usage),
    parts: Array.from({ length: outputs }, (_, ordinal) => ({
      kind: 'video',
      ordinal,
      type: 'video/mp4',
      url: mediaAPIURL(
        context.connection,
        `videos/${encodeURIComponent(response.id)}/content${`?index=${ordinal}`}`,
      ),
    })),
  };
}

async function submitVideo(
  request: MediaSubmissionRequest,
  inputs: MediaProviderInput[],
  context: MediaProviderContext,
): Promise<MediaProviderResult> {
  if (request.operation !== 'video.generate') {
    throw new MediaProviderError('rejected');
  }
  if (!mediaVideoPolicySupported(context.connection.routing)) {
    throw new MediaProviderError('rejected');
  }
  if (request.parameters.providerOptions && !context.providerTag)
    throw new MediaProviderError('rejected');
  const body = JSON.stringify({
    model: request.selection.modelId,
    prompt: request.prompt,
    duration: request.parameters.durationSeconds,
    aspect_ratio: request.parameters.aspectRatio,
    resolution: request.parameters.resolution,
    size: request.parameters.size,
    upscale_factor: request.parameters.upscaleFactor,
    creativity: request.parameters.creativity,
    generate_audio: request.parameters.audio,
    seed: request.parameters.seed,
    input_references: inputs
      .filter((input) => ['reference', 'video', 'audio'].includes(input.role))
      .map(asReference),
    provider:
      request.parameters.providerOptions && context.providerTag
        ? { options: { [context.providerTag.split('/')[0]]: request.parameters.providerOptions } }
        : undefined,
    frame_images: inputs
      .filter((input) => input.role === 'start_frame' || input.role === 'end_frame')
      .map((input) => ({
        ...asReference(input),
        frame_type: input.role === 'start_frame' ? 'first_frame' : 'last_frame',
      })),
  });
  const result = await context.transport.json(
    {
      ...requestOptions(context, 'videos', body),
      method: 'POST',
      headers: { ...context.connection.headers, 'Content-Type': 'application/json' },
      body,
    },
    videoResponseSchema,
  );
  return videoResult(result, context);
}

async function poll(
  operationId: string,
  context: MediaProviderContext,
): Promise<MediaProviderResult> {
  const result = await context.transport.json(
    {
      ...requestOptions(context, `videos/${encodeURIComponent(operationId)}`),
      timeoutMs: context.config.timeouts.pollRequestMs,
      maxBytes: context.config.catalog.maxResponseBytes,
    },
    videoResponseSchema,
  );
  if (result.id !== operationId) throw new MediaProviderError('uncertain');
  return videoResult(result, context);
}

export function createRESTMediaAdapters(): MediaProviderAdapter[] {
  return [
    createVertexVideoAdapter(),
    createMicrosoftImageAdapter(),
    ...createBFLMediaAdapters(),
    ...createRecraftMediaAdapters(),
    ...createXAIMediaAdapters(),
    ...createRunwayMediaAdapters(),
    ...createKreaMediaAdapters(),
    ...createSourcefulMediaAdapters(),
    ...createAlibabaMediaAdapters(),
    ...createAtlasMediaAdapters(),
    ...createSeedMediaAdapters(),
    ...createMinimaxMediaAdapters(),
    ...createHeygenMediaAdapters(),
    ...createOpenAIMediaAdapters(),
    ...createGoogleMediaAdapters(),

    {
      api: 'openrouter.images',
      operations: ['image.generate', 'image.edit'],
      submit: submitImages,
      download,
    },
    {
      api: 'openrouter.videos',
      operations: ['video.generate'],
      submit: submitVideo,
      poll,
      download,
    },
  ];
}
