import { request } from 'node:http';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { request as secureRequest } from 'node:https';
import { extractionServiceSchema } from 'librechat-data-provider';
import type { ExtractionServiceConfig } from 'librechat-data-provider';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';

export type ExtractionFormat = 'pdf' | 'docx';
export interface ExtractionSegment {
  readonly kind: 'page' | 'document';
  readonly index: number;
  readonly text: string;
}
export interface ExtractionResult {
  readonly version: 1;
  readonly operation: 'document.extract-text';
  readonly format: ExtractionFormat;
  readonly inputSha256: string;
  readonly textBytes: number;
  readonly segments: readonly ExtractionSegment[];
}
export interface DocumentExtractor {
  readonly maxInputBytes: number;
  readonly deadlineMs?: number;
  extract(bytes: Buffer, format: ExtractionFormat, signal?: AbortSignal): Promise<ExtractionResult>;
}

const statuses: Readonly<Record<string, number>> = {
  INVALID_REQUEST: 400,
  UNAUTHORIZED: 401,
  INPUT_LIMIT: 413,
  OUTPUT_LIMIT: 413,
  DECOMPRESSION_LIMIT: 413,
  STRUCTURE_LIMIT: 413,
  BUSY: 429,
  UNAVAILABLE: 503,
  DEADLINE: 504,
  CANCELLED: 422,
  INVALID_DOCUMENT: 422,
  EMPTY_OUTPUT: 422,
  ENCRYPTED_DOCUMENT: 422,
  UNSUPPORTED_ENCODING: 422,
  UNSUPPORTED_CONTENT: 422,
  RESOURCE_LIMIT: 422,
};

export class ExtractionServiceError extends Error {
  readonly userErrorStatusCode: 503 | undefined;

  constructor(readonly code: string) {
    super(
      code === 'UNAVAILABLE'
        ? 'Document extraction is unavailable. Start the extraction companion and verify the endpoint, processor credential and Landlock ABI 3 support.'
        : `Document extraction failed (${code}).`,
    );
    this.name = 'ExtractionServiceError';
    this.userErrorStatusCode = code === 'UNAVAILABLE' ? 503 : undefined;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => key in value);
}
function fail(code = 'INVALID_RESPONSE'): never {
  throw new ExtractionServiceError(code);
}
function decode(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail();
  }
}
function positive(value: unknown, ceiling: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= ceiling;
}
function wellFormed(text: string): boolean {
  // JSON permits escaped lone surrogates even after strict UTF-8 decoding.
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);
}

/** Only semantic PDF/DOCX extraction is migrated. Preview/HTML producers remain independent. */
export function getExtractionFormat(name: string, mimeType: string): ExtractionFormat | null {
  const mime = mimeType.split(';', 1)[0].trim().toLowerCase();
  if (/\.pdf$/i.test(name) || mime === 'application/pdf') return 'pdf';
  if (
    /\.docx$/i.test(name) ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )
    return 'docx';
  return null;
}

async function readCredential(path: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() =>
    fail('UNAVAILABLE'),
  );
  try {
    signal.throwIfAborted();
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== 64) return fail('UNAVAILABLE');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({
      signal,
      autoClose: false,
      highWaterMark: 65,
      end: 64,
    })) {
      const bytes = chunk as Buffer;
      size += bytes.length;
      if (size > 64) return fail('UNAVAILABLE');
      chunks.push(bytes);
    }
    const token = Buffer.concat(chunks, size).toString('utf8');
    if (!/^[0-9a-f]{64}$/.test(token)) return fail('UNAVAILABLE');
    signal.throwIfAborted();
    return token;
  } finally {
    await handle.close();
  }
}

/** No retries, alternate endpoints or local fallback. Credentials rotate on the next extraction. */
export function createDocumentExtractor(
  config?: ExtractionServiceConfig,
  transport?: (
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => ClientRequest,
): DocumentExtractor {
  const parsed = extractionServiceSchema.safeParse(config ?? {});
  if (!parsed.success) return fail('INVALID_CONFIG');
  const options = parsed.data;
  const endpoint = new URL(options.url);
  const send = transport ?? (endpoint.protocol === 'https:' ? secureRequest : request);

  const exchange = async (
    path: '/v1/capabilities' | '/v1/extract-text',
    token: string,
    signal: AbortSignal,
    limit: number,
    body?: Buffer,
    format?: ExtractionFormat,
  ): Promise<unknown> => {
    let drained = Promise.resolve();
    try {
      return await new Promise((resolve, reject) => {
        let responseEnded = false;
        const req = send(
          {
            protocol: endpoint.protocol,
            ...(endpoint.protocol === 'https:' ? { rejectUnauthorized: true } : {}),
            hostname: endpoint.hostname.replace(/^\[|\]$/g, ''),
            port: endpoint.port,
            path,
            method: body ? 'POST' : 'GET',
            agent: false,
            maxHeaderSize: 4096,
            signal,
            headers: {
              Authorization: `Bearer ${token}`,
              Connection: 'close',
              ...(body
                ? {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': body.length,
                    'X-Extraction-Version': '1',
                    'X-Extraction-Format': format,
                  }
                : {}),
            },
          },
          (res) => {
            const length = res.headers['content-length'];
            if (
              res.headers['transfer-encoding'] ||
              res.headers['content-encoding'] ||
              res.headers['content-type'] !== 'application/json; charset=utf-8' ||
              typeof length !== 'string' ||
              !/^[1-9]\d*$/.test(length) ||
              !positive(Number(length), limit)
            ) {
              reject(new ExtractionServiceError('INVALID_RESPONSE'));
              res.destroy();
              req.destroy();
              return;
            }
            let size = 0;
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > limit || size > Number(length)) {
                reject(new ExtractionServiceError('RESPONSE_LIMIT'));
                res.destroy();
                req.destroy();
                return;
              }
              chunks.push(chunk);
            });
            res.once('error', () => {
              reject(new ExtractionServiceError('INVALID_RESPONSE'));
              req.destroy();
            });
            res.once('end', () => {
              responseEnded = true;
              try {
                if (size !== Number(length)) return fail();
                const value = decode(Buffer.concat(chunks, size));
                if (res.statusCode !== 200) {
                  if (path === '/v1/capabilities' && res.statusCode === 503)
                    return fail('UNAVAILABLE');
                  if (
                    !record(value) ||
                    !keys(value, ['error']) ||
                    !record(value.error) ||
                    !keys(value.error, ['code']) ||
                    typeof value.error.code !== 'string' ||
                    statuses[value.error.code] !== res.statusCode
                  )
                    return fail();
                  return fail(
                    value.error.code === 'UNAUTHORIZED' ? 'UNAVAILABLE' : value.error.code,
                  );
                }
                resolve(value);
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        drained = new Promise<void>((done) =>
          req.once('close', () => {
            if (!responseEnded) reject(new ExtractionServiceError('UNAVAILABLE'));
            done();
          }),
        );
        req.once('error', () => reject(new ExtractionServiceError('UNAVAILABLE')));
        req.end(body);
      });
    } finally {
      await drained;
    }
  };

  return {
    maxInputBytes: options.maxInputBytes,
    deadlineMs: options.deadlineMs,
    async extract(input, format, signal) {
      if (format !== 'pdf' && format !== 'docx') return fail('UNSUPPORTED_FORMAT');
      if (!input.length || input.length > options.maxInputBytes) return fail('INPUT_LIMIT');
      // Snapshot before awaiting capabilities so the digest always describes the bytes sent.
      const bytes = Buffer.from(input);
      const digest = createHash('sha256').update(bytes).digest('hex');
      const controller = new AbortController();
      const cancel = () => controller.abort(new ExtractionServiceError('CANCELLED'));
      const timeout = setTimeout(
        () => controller.abort(new ExtractionServiceError('DEADLINE')),
        options.deadlineMs,
      );
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      try {
        controller.signal.throwIfAborted();
        const token = await readCredential(options.tokenFile, controller.signal);
        const caps = await exchange('/v1/capabilities', token, controller.signal, 16384);
        if (
          !record(caps) ||
          caps.version !== 1 ||
          caps.operation !== 'document.extract-text' ||
          !Array.isArray(caps.formats) ||
          caps.formats.length !== 2 ||
          !caps.formats.includes('pdf') ||
          !caps.formats.includes('docx') ||
          !record(caps.structure) ||
          !record(caps.limitations) ||
          !record(caps.limits)
        ) {
          return fail('INCOMPATIBLE_SERVICE');
        }
        for (const type of ['pdf', 'docx']) {
          if (
            typeof caps.structure[type] !== 'string' ||
            !caps.structure[type] ||
            typeof caps.limitations[type] !== 'string' ||
            !caps.limitations[type]
          )
            return fail('INCOMPATIBLE_SERVICE');
        }
        const limits = caps.limits;
        const ceilings: Record<string, number> = {
          inputBytes: 10 * 1024 * 1024,
          textBytes: 1024 * 1024,
          resultBytes: 3 * 1024 * 1024,
          deadlineMs: 10000,
          maxSegments: 128,
          concurrency: 2,
          expandedBytes: 32 * 1024 * 1024,
          archiveEntries: 512,
          tableColumns: 512,
        };
        for (const [key, ceiling] of Object.entries(ceilings)) {
          if (!positive(limits[key], ceiling)) return fail('INCOMPATIBLE_SERVICE');
        }
        if (bytes.length > (limits.inputBytes as number)) return fail('INPUT_LIMIT');
        const value = await exchange(
          '/v1/extract-text',
          token,
          controller.signal,
          Math.min(options.maxResponseBytes, limits.resultBytes as number),
          bytes,
          format,
        );
        if (
          !record(value) ||
          !keys(value, [
            'version',
            'operation',
            'format',
            'inputSha256',
            'textBytes',
            'segments',
          ]) ||
          value.version !== 1 ||
          value.operation !== 'document.extract-text' ||
          value.format !== format ||
          value.inputSha256 !== digest ||
          !Array.isArray(value.segments) ||
          !value.segments.length ||
          value.segments.length >
            Math.min(options.maxSegments, limits.maxSegments as number, format === 'pdf' ? 128 : 1)
        )
          return fail();
        let textBytes = 0;
        let nonempty = false;
        for (const [index, segment] of value.segments.entries()) {
          if (
            !record(segment) ||
            !keys(segment, ['kind', 'index', 'text']) ||
            segment.kind !== (format === 'pdf' ? 'page' : 'document') ||
            segment.index !== index + 1 ||
            typeof segment.text !== 'string' ||
            !wellFormed(segment.text)
          )
            return fail();
          textBytes += Buffer.byteLength(segment.text, 'utf8');
          nonempty ||= Boolean(segment.text.trim());
        }
        if (
          !nonempty ||
          textBytes !== value.textBytes ||
          textBytes > Math.min(options.maxTextBytes, limits.textBytes as number)
        )
          return fail();
        controller.signal.throwIfAborted();
        return value as unknown as ExtractionResult;
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (error instanceof ExtractionServiceError) throw error;
        return fail('UNAVAILABLE');
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', cancel);
      }
    },
  };
}

export async function readExtractionInput(
  file: Express.Multer.File,
  extractor: DocumentExtractor,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  if (file.buffer) {
    if (!file.buffer.length || file.buffer.length > extractor.maxInputBytes)
      return fail('INPUT_LIMIT');
    return file.buffer;
  }
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() =>
    fail('INPUT_UNAVAILABLE'),
  );
  try {
    signal?.throwIfAborted();
    const stat = await handle.stat();
    if (!stat.isFile()) return fail('INPUT_UNAVAILABLE');
    if (!stat.size || stat.size > extractor.maxInputBytes) return fail('INPUT_LIMIT');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ signal, autoClose: false })) {
      const bytes = chunk as Buffer;
      size += bytes.length;
      if (size > extractor.maxInputBytes) return fail('INPUT_LIMIT');
      chunks.push(bytes);
    }
    if (!size) return fail('INPUT_LIMIT');
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof ExtractionServiceError) throw error;
    return fail(signal?.aborted ? 'CANCELLED' : 'INPUT_UNAVAILABLE');
  } finally {
    await handle.close();
  }
}

/** Flatten only at an existing plain-text consumer boundary, never an HTML preview boundary. */
export function extractionText(result: ExtractionResult): string {
  return result.segments.map((segment) => segment.text).join('\n');
}
