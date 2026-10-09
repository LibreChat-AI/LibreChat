import type { IEventTransport } from '../interfaces/IJobStore';

/**
 * Internal publication result used to fence same-replica replay against Redis Pub/Sub.
 * `number` is the zero-based Redis sequence, `false` is an authoritative
 * generation/status fence, and `void` carries no ownership proof (including
 * unsequenced transports and operational publication failure).
 */
export type ChunkPublicationReceipt = number | false | void;

/**
 * Hot-path hints for transports that can batch sequenced publications.
 * `coalesce` marks an event as eligible for windowed batching: the receipt
 * promise then resolves when the batch flushes instead of per event. Only
 * order-insensitive-to-latency streaming deltas should opt in; fenced
 * emissions (durable, steer, created, terminal) must stay per-event.
 */
export interface ChunkPublicationOptions {
  coalesce?: boolean;
}

type ChunkPublicationCapability = (
  streamId: string,
  event: unknown,
  generationId?: number,
  options?: ChunkPublicationOptions,
) => Promise<ChunkPublicationReceipt>;

/**
 * Keep transport-specific sequencing out of the exported IEventTransport contract.
 * The WeakMap also keeps the capability off exported transport class declarations.
 */
const chunkPublicationCapabilities = new WeakMap<IEventTransport, ChunkPublicationCapability>();

export function registerChunkPublicationCapability(
  transport: IEventTransport,
  capability: ChunkPublicationCapability,
): void {
  chunkPublicationCapabilities.set(transport, capability);
}

/**
 * Publish through a transport's internal receipt capability when available.
 * Unsequenced and third-party transports retain the public emitChunk contract.
 */
export function emitChunkWithReceipt(
  transport: IEventTransport,
  streamId: string,
  event: unknown,
  generationId?: number,
  options?: ChunkPublicationOptions,
): Promise<ChunkPublicationReceipt> {
  const capability = chunkPublicationCapabilities.get(transport);
  if (capability) {
    /** Preserve the 3-arg call shape when no hint is given: registered
     * capabilities predate the options parameter and spies assert on it. */
    return options === undefined
      ? capability(streamId, event, generationId)
      : capability(streamId, event, generationId, options);
  }
  return Promise.resolve(transport.emitChunk(streamId, event, generationId));
}

/**
 * Publish an observational chunk while surfacing operational transport failure.
 *
 * The public Redis `emitChunk` contract intentionally preserves legacy best-effort
 * behavior for generation streaming. Detached activity needs the stronger signal so
 * its per-task circuit can stop issuing a failing Redis command for every token.
 */
export async function emitObservedChunk(
  transport: IEventTransport,
  streamId: string,
  event: unknown,
): Promise<void> {
  const capability = chunkPublicationCapabilities.get(transport);
  if (!capability) {
    await transport.emitChunk(streamId, event);
    return;
  }
  const receipt = await capability(streamId, event);
  if (receipt === undefined) {
    throw new Error('Observed chunk publication failed');
  }
}
