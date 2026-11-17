import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { HostChatModel, HostModelServiceError, toStoredMessage } from '@librechat/agents';
import { AIMessageChunk, isAIMessage, isBaseMessage } from '@librechat/agents/langchain/messages';
import type { HostModelRequest, HostModelService } from '@librechat/agents';
import type {
  RemoteSdkFactoryInput,
  RemoteSdkHostServices,
  RemoteSdkLimits,
  RemoteSdkStart,
} from './types';
import type { HostModelLifecycle, WorkerModelLifecycle } from './admission';
import type { SdkAgentIdentity } from './identity';
import type { SdkRpc } from './peer';
import { createPolicyReceiver, createPolicySender } from './sealed';
import { encodeSdkValue, decodeSdkValue } from './wire';
import { modelAttemptSchema } from './admission';

const operationSchema = z
  .object({
    id: z.string().uuid(),
    publicKey: z.string().length(60),
    request: z.unknown(),
    context: modelAttemptSchema.optional(),
  })
  .strict();
const chunkSchema = z
  .object({ id: z.string().uuid(), index: z.number().int().nonnegative(), message: z.unknown() })
  .strict();
const replySchema = z.discriminatedUnion('ok', [
  z.object({ version: z.literal(1), ok: z.literal(true), message: z.unknown().optional() }),
  z.object({
    version: z.literal(1),
    ok: z.literal(false),
    code: z.enum([
      'incompatible',
      'forbidden',
      'blocked',
      'overflow',
      'timeout',
      'cancelled',
      'unavailable',
    ]),
  }),
]);
function failure(error: unknown) {
  const normalized =
    error instanceof HostModelServiceError ? error : new HostModelServiceError('unavailable');
  return {
    version: 1 as const,
    ok: false as const,
    code: normalized.code,
  };
}
function reply(value: unknown) {
  const result = replySchema.safeParse(value);
  if (!result.success) throw new HostModelServiceError('incompatible');
  if (!result.data.ok) throw new HostModelServiceError(result.data.code);
  return result.data;
}

function sealValue(seal: ReturnType<typeof createPolicySender>, value: unknown, maxBytes: number) {
  const text = JSON.stringify(encodeSdkValue(value));
  if (Buffer.byteLength(text) > maxBytes) throw new HostModelServiceError('overflow');
  return seal(text);
}

/** One byte window shared by every model stream on this execution's connection. */
export function createHostModelChannel(options: {
  model: NonNullable<RemoteSdkHostServices['model']>;
  lifecycle?: HostModelLifecycle;
  peer: { call: SdkRpc };
  limits: RemoteSdkLimits;
  signal: AbortSignal;
}) {
  // Reserve the other half for tools, checkpoints and control RPCs on the same peer.
  const windowBytes = Math.max(1, Math.floor(options.limits.maxBufferedBytes / 2));
  const receiver = createPolicyReceiver(options.limits.maxFrameBytes, 'model');
  let bufferedBytes = 0;
  const pending = new Set<Promise<void>>();
  const ids = new Set<string>();
  const call = async (method: string, data: unknown, signal?: AbortSignal) => {
    const controller = new AbortController();
    const boundSignal = AbortSignal.any([
      options.signal,
      controller.signal,
      ...(signal ? [signal] : []),
    ]);
    let id: string | undefined;
    const deliveries = new Set<Promise<void>>();
    let deliveryError: unknown;
    try {
      const parsed = operationSchema.safeParse(decodeSdkValue(JSON.parse(receiver.open(data))));
      if (!parsed.success) throw new HostModelServiceError('incompatible');
      if (ids.has(parsed.data.id)) throw new HostModelServiceError('forbidden');
      id = parsed.data.id;
      ids.add(id);
      const seal = createPolicySender(parsed.data.publicKey, options.limits.maxFrameBytes, 'model');
      // The SDK binding validates identity, reference, messages and allowed tools before admission.
      const request = parsed.data.request as HostModelRequest;
      if (method === 'model.invoke') {
        const invoke = () => options.model.service.invoke(request, boundSignal);
        const message = await (options.lifecycle
          ? options.lifecycle.invoke(parsed.data.context, invoke)
          : invoke());
        return {
          version: 1,
          ok: true,
          message: sealValue(seal, { id, message }, options.limits.maxFrameBytes),
        };
      }
      if (method !== 'model.stream') throw new HostModelServiceError('incompatible');
      let index = 0;
      const stream = () => options.model.service.stream(request, boundSignal);
      const source = options.lifecycle
        ? options.lifecycle.stream(parsed.data.context, stream)
        : stream();
      for await (const chunk of source) {
        boundSignal.throwIfAborted();
        if (deliveryError) throw deliveryError;
        const payload = sealValue(
          seal,
          { id, index: index++, message: toStoredMessage(chunk).data },
          options.limits.maxFrameBytes,
        );
        const bytes = Buffer.byteLength(
          JSON.stringify(
            encodeSdkValue({
              type: 'call',
              id: '00000000-0000-0000-0000-000000000000',
              method: 'model.chunk',
              data: payload,
            }),
          ),
        );
        if (bytes > options.limits.maxFrameBytes || bytes > windowBytes)
          throw new HostModelServiceError('overflow');
        while (bufferedBytes + bytes > windowBytes) {
          await new Promise<void>((resolve, reject) => {
            const abort = () => reject(new HostModelServiceError('cancelled'));
            boundSignal.addEventListener('abort', abort, { once: true });
            void Promise.race(pending).then(() => {
              boundSignal.removeEventListener('abort', abort);
              resolve();
            });
            if (boundSignal.aborted) abort();
          });
          boundSignal.throwIfAborted();
        }
        bufferedBytes += bytes;
        const delivery = options.peer
          .call('model.chunk', payload, options.limits.maxRunMs, boundSignal)
          .then((value) => {
            reply(value);
          })
          .catch((error: unknown) => {
            deliveryError = error;
            controller.abort();
          })
          .finally(() => {
            bufferedBytes -= bytes;
            pending.delete(delivery);
            deliveries.delete(delivery);
          });
        pending.add(delivery);
        deliveries.add(delivery);
      }
      await Promise.all(deliveries);
      if (deliveryError) throw deliveryError;
      boundSignal.throwIfAborted();
      return { version: 1, ok: true };
    } catch (error) {
      return failure(error);
    } finally {
      controller.abort();
      await Promise.all(deliveries);
      if (id) ids.delete(id);
    }
  };
  return {
    call,
    dispose: receiver.dispose,
    descriptor: {
      version: 1 as const,
      publicKey: receiver.publicKey,
      descriptor: options.model.descriptor,
    },
  };
}

interface ChunkDelivery {
  chunk: AIMessageChunk;
  settle: (error?: Error) => void;
}
interface ModelStream {
  queue: Map<number, ChunkDelivery>;
  next: number;
  index: number;
  done: boolean;
  error?: Error;
  wake: () => void;
}

/** Chunk receipts release credits only when consumed, so a slow graph bounds host production. */
export function createWorkerModelChannel(options: {
  peer: { call: SdkRpc };
  limits: RemoteSdkLimits;
  signal: AbortSignal;
}) {
  const streams = new Map<string, ModelStream>();
  let receiver: ReturnType<typeof createPolicyReceiver> | undefined;
  let seal: ReturnType<typeof createPolicySender> | undefined;
  let lifecycle: WorkerModelLifecycle | undefined;
  const encodeRequest = (id: string, request: HostModelRequest, context?: unknown) => {
    if (!receiver || !seal) throw new HostModelServiceError('incompatible');
    return sealValue(
      seal,
      {
        id,
        publicKey: receiver.publicKey,
        request,
        ...(lifecycle && { context: lifecycle.current(context) }),
      },
      options.limits.maxFrameBytes,
    );
  };
  const open = (data: unknown) => {
    if (!receiver) throw new HostModelServiceError('incompatible');
    return decodeSdkValue(JSON.parse(receiver.open(data)));
  };
  const stop = (state: ModelStream, error: Error) => {
    state.error = error;
    state.done = true;
    for (const delivery of state.queue.values()) delivery.settle(error);
    state.queue.clear();
    state.wake();
  };
  const dispose = () => {
    receiver?.dispose();
    for (const state of streams.values()) stop(state, new HostModelServiceError('cancelled'));
  };
  options.signal.addEventListener('abort', dispose, { once: true });
  const service: HostModelService = {
    version: 1,
    invoke: async (request, signal, context?: unknown) => {
      const id = randomUUID();
      const result = reply(
        await options.peer.call(
          'model.invoke',
          encodeRequest(id, request, context),
          options.limits.maxRunMs,
          signal ? AbortSignal.any([options.signal, signal]) : options.signal,
        ),
      );
      const value = z
        .object({ id: z.literal(id), message: z.unknown() })
        .parse(open(result.message));
      if (!isBaseMessage(value.message) || !isAIMessage(value.message))
        throw new HostModelServiceError('incompatible');
      return value.message;
    },
    stream: async function* (request, signal, context?: unknown) {
      const id = randomUUID();
      const payload = encodeRequest(id, request, context);
      const controller = new AbortController();
      const boundSignal = AbortSignal.any([
        options.signal,
        controller.signal,
        ...(signal ? [signal] : []),
      ]);
      boundSignal.throwIfAborted();
      const state: ModelStream = {
        queue: new Map(),
        next: 0,
        index: 0,
        done: false,
        wake: () => {},
      };
      const abort = () => stop(state, new HostModelServiceError('cancelled'));
      boundSignal.addEventListener('abort', abort, { once: true });
      streams.set(id, state);
      const completion = options.peer
        .call('model.stream', payload, options.limits.maxRunMs, boundSignal)
        .then((value) => {
          reply(value);
          state.done = true;
          state.wake();
        })
        .catch((error: unknown) =>
          stop(
            state,
            error instanceof HostModelServiceError
              ? error
              : new HostModelServiceError('unavailable'),
          ),
        );
      try {
        for (;;) {
          if (state.error) throw state.error;
          const delivery = state.queue.get(state.next);
          if (delivery) {
            state.queue.delete(state.next++);
            delivery.settle();
            yield delivery.chunk;
            continue;
          }
          if (state.done) return;
          await new Promise<void>((resolve) => {
            state.wake = resolve;
          });
        }
      } finally {
        controller.abort();
        streams.delete(id);
        boundSignal.removeEventListener('abort', abort);
        await completion;
      }
    },
  };
  return {
    bind: (
      identity: Readonly<SdkAgentIdentity>,
      descriptor: NonNullable<RemoteSdkStart['model']>,
      admission?: WorkerModelLifecycle,
    ): NonNullable<RemoteSdkFactoryInput['hostModel']> => {
      if (receiver || options.signal.aborted || descriptor.version !== 1)
        throw new HostModelServiceError('incompatible');
      lifecycle = admission;
      receiver = createPolicyReceiver(options.limits.maxFrameBytes, 'model');
      seal = createPolicySender(descriptor.publicKey, options.limits.maxFrameBytes, 'model');
      const config = { identity, descriptor: descriptor.descriptor, service };
      return (lifecycle ? lifecycle.model(config) : new HostChatModel(config)).bindTools([
        ...descriptor.descriptor.tools,
      ]);
    },
    accept: async (data: unknown, signal?: AbortSignal) => {
      try {
        const parsed = chunkSchema.safeParse(open(data));
        if (!parsed.success) throw new HostModelServiceError('incompatible');
        const state = streams.get(parsed.data.id);
        if (!state || state.done || state.index !== parsed.data.index)
          throw new HostModelServiceError('incompatible');
        const chunk = new AIMessageChunk(
          parsed.data.message as ConstructorParameters<typeof AIMessageChunk>[0],
        );
        state.index++;
        await new Promise<void>((resolve, reject) => {
          const abort = () => stop(state, new HostModelServiceError('cancelled'));
          state.queue.set(parsed.data.index, {
            chunk,
            settle: (error) => {
              signal?.removeEventListener('abort', abort);
              if (error) reject(error);
              else resolve();
            },
          });
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
          state.wake();
        });
        return { version: 1, ok: true };
      } catch (error) {
        return failure(error);
      }
    },
  };
}
