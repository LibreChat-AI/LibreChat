import { ConverseCommand, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import type {
  Message,
  ContentBlock,
  ConverseCommandInput,
  BedrockRuntimeClient,
  ServiceOutputTypes,
} from '@aws-sdk/client-bedrock-runtime';
import type { HttpHandlerOptions, MiddlewareStack } from '@smithy/types';
import type { BedrockDocumentContext } from './context';
import {
  BedrockDocumentError,
  BEDROCK_DOCUMENT_COUNT,
  bedrockRequestLimit,
  clampBedrockLimit,
  assertBedrockSize,
} from './limits';
import {
  CONTENT_TRAVERSAL_MAX_DEPTH,
  CONTENT_TRAVERSAL_MAX_NODES,
} from '~/protection/adapters/nested';
import { runGuardedEncode } from '../encode/memoryGuard';
import { getBedrockDocumentLimit } from '../validation';

/** Counts JSON and base64 without constructing a JSON string or a byte-number array. */
export function bedrockWireSize(value: unknown, cap: number): number {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const add = (size: number): void => {
    bytes += size;
    if (bytes > cap) throw new BedrockDocumentError();
  };
  const string = (text: string): void => {
    add(2 + Buffer.byteLength(text));
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) add(1);
      else if (c < 32) add(5);
      else if (c >= 0xd800 && c <= 0xdbff) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) i++;
        else add(3);
      } else if (c >= 0xdc00 && c <= 0xdfff) add(3);
    }
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > CONTENT_TRAVERSAL_MAX_NODES || depth > CONTENT_TRAVERSAL_MAX_DEPTH)
      throw new BedrockDocumentError();
    if (item === null) return add(4);
    if (typeof item === 'string') return string(item);
    if (typeof item === 'boolean') return add(item ? 4 : 5);
    if (typeof item === 'number' && Number.isFinite(item)) return add(String(item).length);
    if (item instanceof Uint8Array) return add(2 + 4 * Math.ceil(item.byteLength / 3));
    if (typeof item !== 'object' || !item || ancestors.has(item)) throw new BedrockDocumentError();
    ancestors.add(item);
    add(2);
    let count = 0;
    if (Array.isArray(item)) {
      for (const child of item) {
        if (count++) add(1);
        visit(child, depth + 1);
      }
    } else {
      for (const [key, child] of Object.entries(item)) {
        if (child === undefined) continue;
        if (count++) add(1);
        string(key);
        add(1);
        visit(child, depth + 1);
      }
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  return bytes;
}

const documentMimeTypes: Record<string, string> = {
  pdf: 'application/pdf',
  csv: 'text/csv',
  txt: 'text/plain',
  html: 'text/html',
  md: 'text/markdown',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

type Target = {
  source: { bytes: Uint8Array };
  id?: string;
  bytes?: Uint8Array;
  cap: number;
};

/** Clone only provider content containers; never put resolved bytes into LangChain messages. */
export async function withBedrockDocuments<T>(
  input: ConverseCommandInput,
  context: BedrockDocumentContext | undefined,
  model: string | undefined,
  signal: AbortSignal | undefined,
  send: (input: ConverseCommandInput) => Promise<T>,
): Promise<T> {
  const targets: Target[] = [];
  let countLimit = BEDROCK_DOCUMENT_COUNT;
  let rawLimit = Infinity;
  let knownRaw = 0;
  let knownWire = 0;
  let visited = 0;
  const clone = (parts: ContentBlock[] | undefined, depth = 0): ContentBlock[] | undefined => {
    if (!parts) return parts;
    if (!Array.isArray(parts)) throw new BedrockDocumentError();
    if (depth > CONTENT_TRAVERSAL_MAX_DEPTH || parts.length > CONTENT_TRAVERSAL_MAX_NODES - visited)
      throw new BedrockDocumentError();
    visited += parts.length;
    return parts.map((part) => {
      if (!part || typeof part !== 'object') throw new BedrockDocumentError();
      if (part.toolResult) {
        return {
          ...part,
          toolResult: {
            ...part.toolResult,
            content: clone(part.toolResult.content as ContentBlock[], depth + 1),
          },
        } as ContentBlock;
      }
      if (!part.document) return part;
      if (targets.length >= countLimit) throw new BedrockDocumentError();
      const document = part.document;
      const mime = document.format && documentMimeTypes[document.format];
      if (!mime || !document.source) throw new BedrockDocumentError();
      const ref: unknown = document.source;
      let id: string | undefined;
      let bytes: Uint8Array | undefined;
      let cap = getBedrockDocumentLimit(mime, undefined, model);
      if (
        typeof ref === 'object' &&
        ref != null &&
        'librechatFile' in ref &&
        typeof ref.librechatFile === 'string'
      ) {
        id = ref.librechatFile;
        const registered = context?.get(id);
        if (!registered || registered.file.type !== mime) throw new BedrockDocumentError();
        cap = clampBedrockLimit(cap, registered.maxBytes);
        rawLimit = clampBedrockLimit(rawLimit, registered.totalBytes);
        countLimit = clampBedrockLimit(countLimit, registered.count);
        if (registered.file.bytes != null) {
          assertBedrockSize(registered.file.bytes, cap);
          knownRaw += registered.file.bytes;
          knownWire += 4 * Math.ceil(registered.file.bytes / 3);
        }
      } else if (document.source.bytes instanceof Uint8Array) {
        bytes = document.source.bytes;
        assertBedrockSize(bytes.byteLength, cap);
        knownRaw += bytes.byteLength;
        knownWire += 4 * Math.ceil(bytes.byteLength / 3);
      } else {
        throw new BedrockDocumentError();
      }
      const source = { bytes: new Uint8Array(0) };
      targets.push({ source, id, bytes, cap });
      if (targets.length > countLimit) throw new BedrockDocumentError();
      return { ...part, document: { ...document, source } };
    });
  };
  if ((input.messages?.length ?? 0) > CONTENT_TRAVERSAL_MAX_NODES) throw new BedrockDocumentError();
  const prepared = {
    ...input,
    messages: input.messages?.map(
      (message): Message => ({ ...message, content: clone(message.content) ?? [] }),
    ),
  };
  if (targets.length === 0) return send(input);
  const wireLimit = bedrockRequestLimit(model);
  let remaining = wireLimit - bedrockWireSize(prepared, wireLimit);
  assertBedrockSize(knownRaw, rawLimit);
  assertBedrockSize(knownWire, remaining);
  // Eight times the hard wire ceiling covers chunks, concatenation, SDK base64, JSON and transport.
  // Share the existing process-wide encoder admission pool, and hold it through serialization/retries/send.
  return runGuardedEncode(
    wireLimit * 8,
    async () => {
      const missing = new Set<object>();
      try {
        for (const target of targets) {
          signal?.throwIfAborted();
          const limit = Math.min(target.cap, rawLimit, Math.floor(remaining / 4) * 3);
          const bytes = target.id ? await context!.read(target.id, limit, signal) : target.bytes;
          if (!bytes) {
            missing.add(target.source);
            continue;
          }
          assertBedrockSize(bytes.byteLength, limit);
          target.source.bytes = bytes;
          rawLimit -= bytes.byteLength;
          remaining -= 4 * Math.ceil(bytes.byteLength / 3);
        }
        signal?.throwIfAborted();
        if (missing.size) {
          const replaceMissing = (parts: ContentBlock[]): void => {
            for (let i = 0; i < parts.length; i++) {
              const part = parts[i];
              if (part.document?.source && missing.has(part.document.source)) {
                parts[i] = { text: 'An attached file is no longer available and was not read.' };
              } else if (part.toolResult) replaceMissing(part.toolResult.content as ContentBlock[]);
            }
          };
          for (const message of prepared.messages ?? []) replaceMissing(message.content ?? []);
        }
        return await send(prepared);
      } finally {
        for (const target of targets) target.source.bytes = new Uint8Array(0);
        targets.length = 0;
      }
    },
    signal,
  );
}

function installWireLimit<I extends object, O extends object>(
  stack: MiddlewareStack<I, O>,
  cap: number,
): void {
  stack.add(
    (next) => async (args) => {
      const body = (args.request as { body?: unknown }).body;
      let size = Infinity;
      if (typeof body === 'string') size = Buffer.byteLength(body);
      else if (body instanceof Uint8Array) size = body.byteLength;
      assertBedrockSize(size, cap);
      return next(args);
    },
    { step: 'build', name: 'librechatDocumentWireLimit', priority: 'high' },
  );
}

type BedrockCommand = Parameters<BedrockRuntimeClient['send']>[0];
type Completion = (error: unknown, output?: ServiceOutputTypes) => void;

/** Preserve SDK overloads while keeping abort-aware materialization outside retry middleware. */
export function guardBedrockDocuments(
  client: BedrockRuntimeClient,
  context?: BedrockDocumentContext,
  model?: string,
): BedrockRuntimeClient {
  const send = client.send.bind(client);
  const execute = async (
    command: BedrockCommand,
    options?: HttpHandlerOptions,
  ): Promise<ServiceOutputTypes> => {
    if (!(command instanceof ConverseCommand) && !(command instanceof ConverseStreamCommand))
      return send(command, options);
    const resolvedModel = command.input.modelId?.startsWith('arn:') ? model : command.input.modelId;
    return withBedrockDocuments(
      command.input,
      context,
      resolvedModel,
      options?.abortSignal as AbortSignal | undefined,
      async (input) => {
        if (command instanceof ConverseStreamCommand) {
          const prepared = new ConverseStreamCommand(input);
          installWireLimit(prepared.middlewareStack, bedrockRequestLimit(resolvedModel));
          return send(prepared, options);
        }
        const prepared = new ConverseCommand(input);
        installWireLimit(prepared.middlewareStack, bedrockRequestLimit(resolvedModel));
        return send(prepared, options);
      },
    );
  };
  client.send = ((
    command: BedrockCommand,
    options?: HttpHandlerOptions | Completion,
    callback?: Completion,
  ) => {
    const done = typeof options === 'function' ? options : callback;
    const result = execute(command, typeof options === 'function' ? undefined : options);
    if (done) {
      void result.then(
        (output) => done(null, output),
        (error: unknown) => done(error),
      );
      return;
    }
    return result;
  }) as BedrockRuntimeClient['send'];
  return client;
}
