import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  HostFileAdmission,
  HostFileServiceError,
  createHostFileBindings,
  hostFileDescriptorSchema,
  hostFileServiceDescriptorSchema,
  hostFileReadRequestSchema,
  hostFileStageRequestSchema,
  hostFilePublishRequestSchema,
} from '@librechat/agents';
import type { HostFileService, HostFileDescriptor, HostFileErrorCode } from '@librechat/agents';
import type { RemoteSdkHostServices, RemoteSdkLimits, RemoteSdkStart } from './types';
import type { SdkAgentIdentity } from './identity';
import type { SdkRpc } from './peer';
import { createPolicyReceiver, createPolicySender } from './sealed';
import { encodeSdkValue, decodeSdkValue } from './wire';

export const fileChannelSchema = z
  .object({
    version: z.literal(1),
    publicKey: z.string().length(60),
    descriptor: hostFileServiceDescriptorSchema,
    sources: z.array(hostFileDescriptorSchema),
  })
  .strict();
const envelopeSchema = z
  .object({
    id: z.string().uuid(),
    publicKey: z.string().length(60),
    request: z.unknown(),
  })
  .strict();
const chunkSchema = z
  .object({
    id: z.string().uuid(),
    index: z.number().int().nonnegative(),
  })
  .strict();
const resultSchema = z.discriminatedUnion('ok', [
  z.object({ version: z.literal(1), ok: z.literal(true), value: z.unknown() }).strict(),
  z
    .object({
      version: z.literal(1),
      ok: z.literal(false),
      code: z.enum([
        'incompatible',
        'forbidden',
        'conflict',
        'overflow',
        'cancelled',
        'timeout',
        'unavailable',
      ]),
    })
    .strict(),
]);
const bytesSchema = z.instanceof(Uint8Array);
const uploadSchema = z.discriminatedUnion('done', [
  z.object({ done: z.literal(true) }).strict(),
  z.object({ done: z.literal(false), data: bytesSchema }).strict(),
]);

function failure(error: unknown, signal?: AbortSignal) {
  let code: HostFileErrorCode = 'unavailable';
  if (error instanceof HostFileServiceError) code = error.code;
  if (signal?.aborted) code = 'cancelled';
  return { version: 1 as const, ok: false as const, code };
}

function parseRequest(method: string, request: unknown) {
  if (method === 'files.read') return hostFileReadRequestSchema.parse(request);
  if (method === 'files.stage') return hostFileStageRequestSchema.parse(request);
  if (method === 'files.publish') return hostFilePublishRequestSchema.parse(request);
  throw new HostFileServiceError('incompatible');
}

function reply(value: unknown): unknown {
  const result = resultSchema.safeParse(value);
  if (!result.success) throw new HostFileServiceError('incompatible');
  if (!result.data.ok) throw new HostFileServiceError(result.data.code);
  return result.data.value;
}

/** Leave room for two base64 encodings, metadata, encryption, and the RPC envelope. */
function chunkLimit(limits: RemoteSdkLimits): number {
  const bytes = Math.floor((Math.min(limits.maxFrameBytes, limits.maxBufferedBytes) - 8192) / 4);
  if (bytes < 1) throw new HostFileServiceError('overflow');
  return bytes;
}

function sealValue(
  seal: ReturnType<typeof createPolicySender>,
  value: unknown,
  limits: RemoteSdkLimits,
) {
  const sealed = seal(JSON.stringify(encodeSdkValue(value)));
  // RPC ids/methods are bounded by the peer. Include their envelope budget before sending.
  if (
    Buffer.byteLength(JSON.stringify(sealed)) + 256 >
    Math.min(limits.maxFrameBytes, limits.maxBufferedBytes)
  )
    throw new HostFileServiceError('overflow');
  return sealed;
}

/** File contents are sealed before they reach RPC queues or durable recovery journals. */
export function createHostFileChannel(options: {
  files: NonNullable<RemoteSdkHostServices['files']>;
  identity: Readonly<SdkAgentIdentity>;
  peer: { call: SdkRpc };
  limits: RemoteSdkLimits;
  signal: AbortSignal;
}) {
  const receiver = createPolicyReceiver(options.limits.maxFrameBytes, 'files');
  const descriptor = {
    ...options.files.descriptor,
    maxChunkBytes: Math.min(options.files.descriptor.maxChunkBytes, chunkLimit(options.limits)),
  };
  // Reuse SDK validation, including duplicate operations and inconsistent limits.
  createHostFileBindings({
    identity: options.identity,
    descriptor,
    service: options.files.service,
  });
  const sources = options.files.sources.map((file) => hostFileDescriptorSchema.parse(file));
  const active = new Set<string>();
  return {
    descriptor: { version: 1 as const, publicKey: receiver.publicKey, descriptor, sources },
    dispose: receiver.dispose,
    call: async (method: string, data: unknown, invocationSignal?: AbortSignal) => {
      const signal = invocationSignal
        ? AbortSignal.any([options.signal, invocationSignal])
        : options.signal;
      let id: string | undefined;
      try {
        signal.throwIfAborted();
        const envelope = envelopeSchema.parse(decodeSdkValue(JSON.parse(receiver.open(data))));
        if (active.has(envelope.id)) throw new HostFileServiceError('conflict');
        id = envelope.id;
        active.add(id);
        const seal = createPolicySender(envelope.publicKey, options.limits.maxFrameBytes, 'files');
        const request = parseRequest(method, envelope.request);
        for (const key of [
          'runtimeId',
          'agentId',
          'runId',
          'userId',
          'tenantId',
          'conversationId',
        ] as const)
          if (request.identity[key] !== options.identity[key])
            throw new HostFileServiceError('forbidden');
        let value: unknown;
        if ('offset' in request) {
          if (!descriptor.operations.includes('read')) throw new HostFileServiceError('forbidden');
          if (request.length > descriptor.maxChunkBytes) throw new HostFileServiceError('overflow');
          value = await options.files.service.read(request, signal);
        } else if ('filename' in request) {
          if (!descriptor.operations.includes('stage')) throw new HostFileServiceError('forbidden');
          if (request.bytes > descriptor.maxFileBytes) throw new HostFileServiceError('overflow');
          const content = async function* () {
            for (let index = 0; ; index++) {
              signal.throwIfAborted();
              const packet = reply(
                await options.peer.call(
                  'files.chunk',
                  sealValue(seal, { id: envelope.id, index }, options.limits),
                  options.limits.rpcTimeoutMs,
                  signal,
                ),
              );
              const received = z
                .object({
                  id: z.literal(envelope.id),
                  index: z.literal(index),
                  chunk: uploadSchema,
                })
                .strict()
                .parse(decodeSdkValue(JSON.parse(receiver.open(packet))));
              const chunk = received.chunk;
              if (chunk.done) return;
              if (chunk.data.byteLength > descriptor.maxChunkBytes)
                throw new HostFileServiceError('overflow');
              yield chunk.data;
            }
          };
          value = await options.files.service.stage(request, content(), signal);
        } else {
          if (!descriptor.operations.includes('publish'))
            throw new HostFileServiceError('forbidden');
          value = await options.files.service.publish(request, signal);
        }
        return {
          version: 1 as const,
          ok: true as const,
          value: sealValue(seal, { id, value }, options.limits),
        };
      } catch (error) {
        return failure(error, signal);
      } finally {
        if (id) active.delete(id);
      }
    },
  };
}

/** Pull uploads one chunk at a time; no whole-file buffer and no speculative producer reads. */
export function createWorkerFileChannel(options: {
  peer: { call: SdkRpc };
  limits: RemoteSdkLimits;
  signal: AbortSignal;
}) {
  let receiver: ReturnType<typeof createPolicyReceiver> | undefined;
  const uploads = new Map<
    string,
    {
      iterator: AsyncIterator<Uint8Array>;
      signal: AbortSignal;
      index: number;
      pulling: boolean;
    }
  >();
  let bound = false;
  let seal: ReturnType<typeof createPolicySender> | undefined;
  let maxChunkBytes = 0;
  return {
    dispose: () => receiver?.dispose(),
    accept: async (data: unknown, invocationSignal?: AbortSignal) => {
      try {
        if (!seal || !receiver) throw new HostFileServiceError('forbidden');
        const chunk = chunkSchema.parse(decodeSdkValue(JSON.parse(receiver.open(data))));
        const upload = uploads.get(chunk.id);
        if (!upload || upload.pulling || upload.index !== chunk.index)
          throw new HostFileServiceError('conflict');
        upload.signal.throwIfAborted();
        invocationSignal?.throwIfAborted();
        upload.pulling = true;
        try {
          const next = await upload.iterator.next();
          upload.signal.throwIfAborted();
          invocationSignal?.throwIfAborted();
          if (
            !next.done &&
            (!(next.value instanceof Uint8Array) || next.value.byteLength > maxChunkBytes)
          )
            throw new HostFileServiceError('overflow');
          upload.index++;
          return {
            version: 1 as const,
            ok: true as const,
            value: sealValue(
              seal,
              {
                id: chunk.id,
                index: chunk.index,
                chunk: next.done ? { done: true } : { done: false, data: next.value },
              },
              options.limits,
            ),
          };
        } finally {
          upload.pulling = false;
        }
      } catch (error) {
        return failure(error, options.signal);
      }
    },
    bind: (identity: Readonly<SdkAgentIdentity>, input: NonNullable<RemoteSdkStart['files']>) => {
      if (bound) throw new HostFileServiceError('conflict');
      const channel = fileChannelSchema.parse(input);
      if (channel.descriptor.maxChunkBytes > chunkLimit(options.limits))
        throw new HostFileServiceError('overflow');
      maxChunkBytes = channel.descriptor.maxChunkBytes;
      seal = createPolicySender(channel.publicKey, options.limits.maxFrameBytes, 'files');
      const recipient = createPolicyReceiver(options.limits.maxFrameBytes, 'files');
      receiver = recipient;
      bound = true;
      const admission = new HostFileAdmission({
        maxConcurrentOperations: Math.max(
          1,
          Math.floor(options.limits.maxBufferedBytes / (2 * maxChunkBytes)),
        ),
        maxBufferedBytes: options.limits.maxBufferedBytes,
      });
      const invoke = async (
        method: string,
        request: unknown,
        signal: AbortSignal,
        id = randomUUID(),
      ) => {
        signal.throwIfAborted();
        const result = reply(
          await options.peer.call(
            method,
            sealValue(
              seal!,
              {
                id,
                publicKey: recipient.publicKey,
                request,
              },
              options.limits,
            ),
            options.limits.maxRunMs,
            signal,
          ),
        );
        const envelope = z
          .object({ id: z.literal(id), value: z.unknown() })
          .strict()
          .parse(decodeSdkValue(JSON.parse(recipient.open(result))));
        return envelope.value;
      };
      const bindSignal = (signal?: AbortSignal) =>
        signal ? AbortSignal.any([options.signal, signal]) : options.signal;
      const service: HostFileService = {
        version: 1,
        read: async (request, signal) => {
          const release = admission.acquire(2 * maxChunkBytes);
          try {
            return z
              .object({
                reference: z.string(),
                revision: z.string(),
                offset: z.number(),
                data: bytesSchema,
              })
              .strict()
              .parse(await invoke('files.read', request, bindSignal(signal)));
          } finally {
            release();
          }
        },
        stage: async (request, content, signal) => {
          const release = admission.acquire(2 * maxChunkBytes);
          const id = randomUUID();
          let iterator: AsyncIterator<Uint8Array>;
          try {
            iterator = content[Symbol.asyncIterator]();
          } catch (error) {
            release();
            throw error;
          }
          const boundSignal = bindSignal(signal);
          uploads.set(id, { iterator, signal: boundSignal, index: 0, pulling: false });
          try {
            return hostFileDescriptorSchema.parse(
              await invoke('files.stage', request, boundSignal, id),
            );
          } finally {
            // A cancelled generator may still be cleaning up: keep its capacity charged.
            void Promise.resolve()
              .then(() => iterator.return?.())
              .catch(() => undefined)
              .finally(() => {
                uploads.delete(id);
                release();
              });
          }
        },
        publish: async (request, signal) => {
          const release = admission.acquire(2 * maxChunkBytes);
          try {
            return z
              .object({ operationId: z.string(), file: hostFileDescriptorSchema })
              .strict()
              .parse(await invoke('files.publish', request, bindSignal(signal)));
          } finally {
            release();
          }
        },
      };
      const bindings = createHostFileBindings({
        identity,
        descriptor: channel.descriptor,
        service,
      });
      return {
        ...bindings,
        sources: Object.freeze(
          channel.sources.map((file): HostFileDescriptor => Object.freeze(file)),
        ),
      };
    },
  };
}
