import { z } from 'zod';
import { Readable } from 'node:stream';
import { validateMediaCapability, resolveMediaParameters } from 'librechat-data-provider';
import type {
  MediaSubmissionRequest,
  MediaCapability,
  MediaImageParameters,
  MediaVideoParameters,
} from 'librechat-data-provider';
import type { MediaProviderContext, MediaProviderInput, MediaProviderPart } from '../provider';
import type { MediaTransportRequest } from '../transport';
import { mediaAPIURL, isMediaConnectionBinding } from '../provider';
import { MediaProviderError } from '../errors';

/** Admission and serialization share the advertised constraints and conditional defaults. */
export function nativeParameters(
  request: MediaSubmissionRequest,
  inputs: MediaProviderInput[],
  context: MediaProviderContext,
  capability?: MediaCapability,
): MediaImageParameters & MediaVideoParameters {
  if (!capability) throw new MediaProviderError('rejected');
  const candidate = {
    ...request,
    inputs: inputs.map(({ role, file_id, sourceURL, type, data }) => ({
      role,
      file_id,
      sourceURL,
      type,
      bytes: data.length,
    })),
  };
  if (validateMediaCapability(candidate, capability, context.config.limits).length) {
    throw new MediaProviderError('rejected');
  }
  return resolveMediaParameters(candidate, capability);
}

export function nativeRequest(
  context: MediaProviderContext,
  path: string,
  body?: string | FormData,
  poll = false,
): MediaTransportRequest {
  let bodyBytes = 0;
  if (typeof body === 'string') bodyBytes = Buffer.byteLength(body);
  else if (body) {
    body.forEach((value) => {
      bodyBytes += typeof value === 'string' ? Buffer.byteLength(value) : value.size;
    });
    /** Allow multipart framing while accounting for every submitted reference file. */
    bodyBytes *= 2;
  }
  return {
    url: mediaAPIURL(context.connection, path),
    method: body === undefined ? 'GET' : 'POST',
    headers:
      typeof body === 'string'
        ? { ...context.connection.headers, 'Content-Type': 'application/json' }
        : context.connection.headers,
    body,
    signal: context.signal,
    timeoutMs: poll ? context.config.timeouts.pollRequestMs : context.config.timeouts.submitMs,
    maxBytes: Math.max(
      context.config.catalog.maxResponseBytes,
      poll ? 0 : context.config.transfers.maxImageBytes * context.config.limits.maxOutputs * 2,
      bodyBytes,
    ),
  };
}

export function nativeImageType(url: string): string {
  const path = new URL(url).pathname;
  if (/\.jpe?g$/i.test(path)) return 'image/jpeg';
  if (/\.webp$/i.test(path)) return 'image/webp';
  return 'image/png';
}

export function dataURI(input: MediaProviderInput): string {
  return `data:${input.type};base64,${input.data.toString('base64')}`;
}

export function providerOptions(
  request: MediaSubmissionRequest,
  names: readonly string[],
): NonNullable<MediaSubmissionRequest['parameters']['providerOptions']> {
  const options = request.parameters.providerOptions ?? {};
  if (Object.keys(options).some((key) => !names.includes(key))) {
    throw new MediaProviderError('rejected');
  }
  return options;
}

export async function nativeDownload(
  part: Extract<MediaProviderPart, { kind: 'image' | 'video' }>,
  context: MediaProviderContext,
): Promise<Readable> {
  const maxBytes =
    part.kind === 'video'
      ? context.config.transfers.maxVideoBytes
      : context.config.transfers.maxImageBytes;
  if (part.data) {
    if (!part.data.length || part.data.length > maxBytes) throw new MediaProviderError('uncertain');
    return Readable.from([part.data]);
  }
  if (!part.url) throw new MediaProviderError('uncertain');
  const url = new URL(part.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new MediaProviderError('uncertain');
  }
  return context.transport.stream({
    url: url.href,
    headers: {},
    signal: context.signal,
    timeoutMs: context.config.timeouts.downloadMs,
    maxBytes,
    maxRedirects: context.config.transfers.maxRedirects,
  });
}

const operationSchema = z
  .object({
    version: z.literal(1),
    api: z.string().min(1),
    binding: z.string().min(1),
    id: z.string().min(1).max(1024),
    modelId: z.string().min(1).max(256),
    pollingURL: z.string().url().max(4096).optional(),
    outputType: z
      .string()
      .regex(/^(image|video)\/[a-z0-9.+-]+$/)
      .optional(),
  })
  .strict();

type NativeOperation = Pick<
  z.infer<typeof operationSchema>,
  'id' | 'modelId' | 'pollingURL' | 'outputType'
>;

export function encodeOperation(operation: NativeOperation, context: MediaProviderContext): string {
  return Buffer.from(
    JSON.stringify(
      operationSchema.parse({
        ...operation,
        version: 1,
        api: context.connection.api,
        binding: context.connection.binding,
      }),
    ),
  ).toString('base64url');
}

export function decodeOperation(token: string, context: MediaProviderContext): NativeOperation {
  try {
    if (token.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(token)) {
      throw new MediaProviderError('uncertain');
    }
    const operation = operationSchema.parse(JSON.parse(Buffer.from(token, 'base64url').toString()));
    if (
      operation.api !== context.connection.api ||
      !isMediaConnectionBinding(context.connection, operation.binding)
    ) {
      throw new MediaProviderError('uncertain');
    }
    return operation;
  } catch {
    throw new MediaProviderError('uncertain');
  }
}

export function imageBytes(encoded: string, context: MediaProviderContext): Buffer {
  if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new MediaProviderError('uncertain');
  }
  const data = Buffer.from(encoded, 'base64');
  if (!data.length || data.length > context.config.transfers.maxImageBytes) {
    throw new MediaProviderError('uncertain');
  }
  return data;
}
