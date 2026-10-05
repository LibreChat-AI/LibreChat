import { z } from 'zod';
import type { MediaCapability, MediaConfig, MediaSubmissionRequest } from 'librechat-data-provider';
import type {
  MediaProviderAdapter,
  MediaProviderContext,
  MediaProviderInput,
  MediaProviderPart,
  MediaProviderUsage,
  MediaProviderResult,
} from '../provider';
import { nativeDownload, nativeRequest, imageBytes, providerOptions } from './native';
import { MediaProviderError } from '../errors';

const models = new Map([
  ['gemini-3.1-flash-lite-image', 'Nano Banana 2 Lite'],
  ['gemini-3.1-flash-image', 'Nano Banana 2'],
  ['gemini-3-pro-image', 'Nano Banana Pro'],
  ['gemini-3.1-flash-image-preview', 'Nano Banana 2 Preview'],
  ['gemini-3-pro-image-preview', 'Nano Banana Pro Preview'],
  ['gemini-2.5-flash-image', 'Nano Banana'],
]);
const ratios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

export function googleImageModelId(id: string): string | undefined {
  const model = id.replace(/^google\//, '');
  return /^gemini-[A-Za-z0-9._-]*image[A-Za-z0-9._-]*$/.test(model) ? model : undefined;
}

export function googleImageCapabilities(id: string, config: MediaConfig): MediaCapability[] {
  const model = googleImageModelId(id);
  if (!model) return [];
  const legacy = !model.startsWith('gemini-3');
  const lite = model.includes('lite');
  const flash = model.startsWith('gemini-3.1-flash');
  return (['image.generate', 'image.edit'] as const).map((operation) => ({
    operation,
    inputs: {
      roles: ['reference'],
      min: operation === 'image.edit' ? 1 : 0,
      max: Math.min(legacy ? 3 : 14, config.limits.maxInputs),
    },
    execution: { kind: 'conversation', continuation: 'replay' },
    controls: {
      count: { min: 1, max: 1 },
      aspectRatio: { values: flash ? [...ratios, '1:4', '4:1', '1:8', '8:1'] : ratios },
      ...(!legacy
        ? {
            resolution: {
              values: lite ? ['1K'] : [...(flash ? ['512'] : []), '1K', '2K', '4K'],
              default: '1K',
            },
          }
        : {}),
    },
  }));
}

async function submitGoogle(
  request: MediaSubmissionRequest,
  inputs: MediaProviderInput[],
  context: MediaProviderContext,
): Promise<MediaProviderResult> {
  if (request.operation === 'video.generate') {
    throw new MediaProviderError('rejected');
  }
  const model = googleImageModelId(request.selection.modelId);
  if (
    !model ||
    request.parameters.count !== 1 ||
    inputs.some((input) => input.role !== 'reference')
  )
    throw new MediaProviderError('rejected');
  providerOptions(request, []);
  const userParts = (prompt: string, references: MediaProviderInput[]) => [
    { text: prompt },
    ...references.map((input) => ({
      inlineData: { mimeType: input.type, data: input.data.toString('base64') },
    })),
  ];
  const previous = context.continuation;
  if (previous && previous.parts.length > context.config.limits.maxNativeParts) {
    throw new MediaProviderError('rejected');
  }
  const history = previous
    ? [
        { role: 'user', parts: userParts(previous.prompt, previous.inputs) },
        {
          role: 'model',
          parts: previous.parts.map((part) => {
            if (part.kind === 'text') {
              return { text: part.text, thoughtSignature: part.thoughtSignature };
            }
            if (part.kind !== 'image' || !part.data) {
              throw new MediaProviderError('rejected');
            }
            return {
              inlineData: { mimeType: part.type, data: part.data.toString('base64') },
              thoughtSignature: part.thoughtSignature,
            };
          }),
        },
      ]
    : [];
  const body = JSON.stringify({
    contents: [...history, { role: 'user', parts: userParts(request.prompt, inputs) }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        aspectRatio: request.parameters.aspectRatio,
        imageSize: request.parameters.resolution,
      },
    },
  });
  const result = await context.transport.json(
    nativeRequest(context, `models/${encodeURIComponent(model)}:generateContent`, body),
    z.object({
      candidates: z
        .array(
          z.object({
            content: z
              .object({
                parts: z.array(
                  z.object({
                    text: z.string().optional(),
                    inlineData: z.object({ data: z.string(), mimeType: z.string() }).optional(),
                    thoughtSignature: z.string().optional(),
                    thought: z.boolean().optional(),
                  }),
                ),
              })
              .optional(),
          }),
        )
        .optional(),
      usageMetadata: z
        .object({
          promptTokenCount: z.number().optional(),
          candidatesTokenCount: z.number().optional(),
          thoughtsTokenCount: z.number().optional(),
        })
        .optional(),
    }),
  );
  const parts: MediaProviderPart[] = [];
  let descriptorBytes = 0;
  let imageCount = 0;
  for (const candidate of result.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.thought) {
        continue;
      }
      const bytes =
        Buffer.byteLength(part.text ?? '') + Buffer.byteLength(part.thoughtSignature ?? '');
      descriptorBytes += bytes;
      if (
        bytes > context.config.limits.maxNativePartBytes ||
        descriptorBytes > context.config.limits.maxNativeRecordingBytes
      ) {
        throw new MediaProviderError('uncertain');
      }
      if (part.text !== undefined) {
        parts.push({
          kind: 'text',
          ordinal: parts.length,
          text: part.text,
          thoughtSignature: part.thoughtSignature,
        });
      }
      if (part.inlineData) {
        imageCount++;
        parts.push({
          kind: 'image',
          ordinal: parts.length,
          type: part.inlineData.mimeType,
          data: imageBytes(part.inlineData.data, context),
          thoughtSignature: part.thoughtSignature,
        });
      }
      if (
        parts.length > context.config.limits.maxNativeParts ||
        imageCount > context.config.limits.maxOutputs
      ) {
        throw new MediaProviderError('uncertain');
      }
    }
  }
  if (parts.length === 0) {
    return {
      status: 'failed',
      ...(result.usageMetadata ? { usage: geminiUsage(result.usageMetadata) } : {}),
    };
  }
  return { status: 'completed', parts, usage: geminiUsage(result.usageMetadata) };
}

/** Gemini bills thinking as output but reports it outside `candidatesTokenCount`. */
function geminiUsage(metadata?: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
}): MediaProviderUsage {
  const candidates = metadata?.candidatesTokenCount;
  const thinking = metadata?.thoughtsTokenCount;
  return {
    inputTokens: metadata?.promptTokenCount,
    outputTokens:
      candidates === undefined && thinking === undefined
        ? undefined
        : (candidates ?? 0) + (thinking ?? 0),
  };
}

export function createGoogleMediaAdapters(): MediaProviderAdapter[] {
  return [
    {
      api: 'google.generateContent',
      configuration: {
        baseURL: 'https://generativelanguage.googleapis.com/v1beta',
        keyHeader: 'x-goog-api-key',
        keyPrefix: '',
      },
      operations: ['image.generate', 'image.edit'],
      catalog: (config) =>
        [...models].map(([id, modelName]) => ({
          modelId: `google/${id}`,
          modelName,
          capabilities: googleImageCapabilities(id, config),
        })),
      submit: submitGoogle,
      download: nativeDownload,
    },
  ];
}
