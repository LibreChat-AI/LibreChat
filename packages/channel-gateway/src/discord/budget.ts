import { z } from 'zod';
import type { WebSocketManager } from '@discordjs/ws';
import { DiscordIdentifyRefusal } from './recovery';

/** Discord allows one IDENTIFY per concurrency bucket every 5 seconds, and the SDK throttle adds up to 1.5 seconds of jitter. */
export const DISCORD_IDENTIFY_SPACING_MS = 6500;

/** What Discord reports for the bot. A budget that cannot be read exactly proves nothing, so it is refused. */
const gatewayInformationSchema = z.object({
  url: z.string().min(1),
  shards: z.number().int().min(1),
  session_start_limit: z
    .object({
      total: z.number().int().min(1),
      remaining: z.number().int().min(0),
      reset_after: z.number().int().min(0),
      max_concurrency: z.number().int().min(1),
    })
    .refine((limit) => limit.remaining <= limit.total),
});
export type DiscordGatewayInformation = z.infer<typeof gatewayInformationSchema>;

/** The SDK compares `remaining` only when it connects, and treats an unreadable value as no limit. */
export function readDiscordGatewayInformation(value: unknown): DiscordGatewayInformation {
  const parsed = gatewayInformationSchema.safeParse(value);
  if (!parsed.success) throw new DiscordIdentifyRefusal('invalid');
  return parsed.data;
}

/** Throws before the SDK sees metadata it would read as unlimited. The body is never echoed. */
export function assertDiscordGatewayInformation(bytes: Buffer): void {
  try {
    readDiscordGatewayInformation(JSON.parse(bytes.toString()));
  } catch {
    throw new Error('Invalid Discord gateway metadata');
  }
}

/** Counts every IDENTIFY against the budget Discord last reported, before it can be sent. */
export interface DiscordIdentifyBudget {
  /** Resolves when one more IDENTIFY for this shard is allowed, and refuses otherwise. */
  reserve(
    manager: Pick<WebSocketManager, 'fetchGatewayInformation'>,
    shardId: number,
  ): Promise<void>;
  /** Gives a reservation back when its IDENTIFY was never sent. */
  release(shardId: number): void;
  /** The shard reached READY or RESUMED, so its next IDENTIFY starts a new session. */
  reached(shardId: number): void;
}

/**
 * One budget per SDK manager. Reservations are serialized, so concurrent shards cannot both take
 * the last start. A shard never sends a second IDENTIFY before it has reached READY or RESUMED, so a
 * Gateway that never answers costs one start per shard, and the owner decides when to try again.
 * Spending is counted against one authoritative read; the SDK keeps that read until Discord's own
 * `reset_after`, so a new read is a new window and the count starts again. A reservation made in an
 * earlier window cannot give a start back to a later one.
 */
export function createDiscordIdentifyBudget(): DiscordIdentifyBudget {
  const unconfirmed = new Map<number, object>();
  let tail: Promise<unknown> = Promise.resolve();
  let window: object | undefined;
  let spent = 0;
  return {
    reserve(manager, shardId) {
      const turn = tail.then(async () => {
        if (unconfirmed.has(shardId)) throw new DiscordIdentifyRefusal('retry');
        const information = await manager.fetchGatewayInformation();
        const { session_start_limit: limit } = readDiscordGatewayInformation(information);
        if (information !== window) {
          window = information;
          spent = 0;
        }
        if (spent >= limit.remaining) throw new DiscordIdentifyRefusal('exhausted');
        spent++;
        unconfirmed.set(shardId, information);
      });
      tail = turn.catch(() => undefined);
      return turn;
    },
    release(shardId) {
      const reservedIn = unconfirmed.get(shardId);
      unconfirmed.delete(shardId);
      if (reservedIn !== undefined && reservedIn === window) spent = Math.max(0, spent - 1);
    },
    reached(shardId) {
      unconfirmed.delete(shardId);
    },
  };
}
