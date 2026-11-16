import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { channelSnowflakeSchema, discordChannelConfigSchema } from 'librechat-data-provider';
import type { SessionInfo } from '@discordjs/ws';
import type {
  DiscordGatewayDriver,
  DiscordGatewayDriverOptions,
  DiscordGatewayDispatch,
} from './socket';
import type { DiscordApplicationObservation } from './observe';
import type { DiscordGatewayStopReason } from './recovery';
import type { Logger } from '../types';
import { DiscordGatewayFailure, DiscordIdentifyRefusal } from './recovery';
import { DISCORD_IDENTIFY_SPACING_MS } from './budget';
import { createDiscordGatewayDriver } from './socket';
import { safeDiscordObserver } from './observe';

export interface DiscordGatewayOwner {
  applicationId: string;
  applicationRevision: string;
  ownerId: string;
}
export interface DiscordGatewayApplication {
  applicationId: string;
  applicationRevision: string;
  botUserId: string;
  botToken: string;
}
/** The host verifies application revision and adapts the existing resource-lock methods.
 * The stable lock key is per application, never per credential revision or tenant. */
export interface DiscordGatewayOwnership {
  acquire(owner: DiscordGatewayOwner, leaseMs: number): Promise<boolean>;
  renew(owner: DiscordGatewayOwner, leaseMs: number): Promise<boolean>;
  release(owner: DiscordGatewayOwner): Promise<void>;
}
export interface DiscordGatewayCheckpoint {
  shardId: number;
  session: SessionInfo | null;
}
/** Reads are application/revision scoped; save must reject a stale ownership fence. */
export interface DiscordGatewayCheckpointBatch {
  applicationId: string;
  applicationRevision: string;
  botUserId: string;
  checkpoints: DiscordGatewayCheckpoint[];
}
export interface DiscordGatewayCheckpoints {
  load(owner: DiscordGatewayOwner): Promise<DiscordGatewayCheckpointBatch | null>;
  /** Merge supplied shards atomically; null clears one shard. Reject a stale owner. */
  save(
    owner: DiscordGatewayOwner,
    batch: DiscordGatewayCheckpointBatch,
    signal: AbortSignal,
  ): Promise<boolean>;
}
export type DiscordGatewayEvent = {
  ownerId: string;
  applicationId: string;
  applicationRevision: string;
  shardId: number;
  sequence: number;
} & (
  | {
      kind: 'message';
      messageId: string;
      channelId: string;
      guildId?: string;
      authorId: string;
      content: string;
      mentionsBot: boolean;
      replyToMessageId?: string;
      channelType?: number;
    }
  | { kind: 'guild'; guildId: string; state: 'available' | 'unavailable' | 'removed' }
);
export interface DiscordGatewayDependencies {
  /** Reuse the application lease held by the host for REST and WebSocket work. */
  ownerId?: string;
  ownership: DiscordGatewayOwnership;
  checkpoints: DiscordGatewayCheckpoints;
  /** Fence by ownerId and resolve after durable admission; deduplicate replayed message IDs. */
  dispatch(event: DiscordGatewayEvent, signal: AbortSignal): Promise<void>;
  log: Logger;
  createDriver?: (options: DiscordGatewayDriverOptions) => DiscordGatewayDriver;
  /** Optional telemetry. It never changes session, checkpoint or ownership behavior. */
  observe?: (observation: DiscordApplicationObservation) => void;
}
const reference = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/);
const applicationSchema = z
  .object({
    applicationId: channelSnowflakeSchema,
    applicationRevision: reference,
    botUserId: channelSnowflakeSchema,
    botToken: z.string().min(1).max(512),
  })
  .strict();
const sessionSchema = z
  .object({
    sessionId: z.string().min(1).max(256),
    sequence: z.number().int().nonnegative(),
    shardId: z.number().int().nonnegative(),
    shardCount: z.number().int().positive(),
    resumeURL: z
      .string()
      .max(2048)
      .refine((raw) => {
        try {
          const url = new URL(raw);
          return (
            url.protocol === 'wss:' &&
            /^gateway(?:-[a-z0-9-]+)?\.discord\.gg$/.test(url.hostname) &&
            !url.port &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            url.pathname === '/'
          );
        } catch {
          return false;
        }
      }),
  })
  .strict();
const readySchema = z.object({
  user: z.object({ id: channelSnowflakeSchema }),
  application: z.object({ id: channelSnowflakeSchema }),
  session_id: z.string().min(1).max(256),
});
const messageSchema = z.object({
  id: channelSnowflakeSchema,
  channel_id: channelSnowflakeSchema,
  guild_id: channelSnowflakeSchema.optional(),
  author: z.object({
    id: channelSnowflakeSchema,
    bot: z.boolean().optional(),
    system: z.boolean().optional(),
  }),
  content: z.string(),
  type: z.number().int(),
  webhook_id: z.string().optional(),
  mentions: z.array(z.object({ id: channelSnowflakeSchema })),
  channel_type: z.number().int().optional(),
  message_reference: z.object({ message_id: channelSnowflakeSchema.optional() }).optional(),
});
interface HotSession {
  info: SessionInfo;
  processed: number;
  verified: boolean;
  barrier: Promise<void>;
}
interface QueuedEvent {
  shardId: number;
  sequence: number;
  sessionId: string;
  event?: DiscordGatewayEvent;
}

/** SDK heartbeat state stays hot; durable resume checkpoints never pass uncommitted dispatches. */
export class OwnedDiscordGateway {
  private readonly application: DiscordGatewayApplication;
  private readonly policy: DiscordGatewayDriverOptions['policy'];
  private readonly owner: DiscordGatewayOwner;
  private readonly enabled: boolean;
  private readonly maxResponseBytes: number;
  private readonly controller = new AbortController();
  private readonly halted = new Promise<void>((resolve) =>
    this.controller.signal.addEventListener('abort', () => resolve(), { once: true }),
  );
  private readonly sessions = new Map<number, HotSession>();
  /** Shards whose live session became non-resumable and have not been READY since. */
  private readonly gaps = new Set<number>();
  private readonly observe: (observation: DiscordApplicationObservation) => void;
  private readonly queue: QueuedEvent[] = [];
  private driver?: DiscordGatewayDriver;
  private expiresAt = 0;
  private owned = false;
  private started = false;
  private stopped = false;
  private stopReason?: DiscordGatewayStopReason;
  private readyAt?: number;
  private stoppedAt?: number;
  private pumping = false;
  private saves: Promise<void> = Promise.resolve();
  private checkpointRevision = 0;
  private persistedRevision = -1;
  private cleanup?: Promise<void>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private renewalTimer?: ReturnType<typeof setTimeout>;
  private checkpointTimer?: ReturnType<typeof setTimeout>;
  private resolveClosed!: () => void;
  readonly closed = new Promise<void>((resolve) => {
    this.resolveClosed = resolve;
  });

  constructor(
    application: DiscordGatewayApplication,
    private readonly deps: DiscordGatewayDependencies,
    config: z.input<typeof discordChannelConfigSchema>,
  ) {
    this.application = applicationSchema.parse(application);
    this.observe = safeDiscordObserver(deps.observe);
    const parsed = discordChannelConfigSchema.parse(config);
    this.policy = parsed.gateway;
    this.enabled = parsed.enabled && parsed.gateway.enabled;
    this.maxResponseBytes = parsed.maxResponseBytes;
    this.owner = {
      applicationId: application.applicationId,
      applicationRevision: application.applicationRevision,
      ownerId: z
        .string()
        .regex(/^[a-f0-9]{32}$/)
        .parse(deps.ownerId ?? randomBytes(16).toString('hex')),
    };
  }
  get failure(): DiscordGatewayFailure | undefined {
    const reason = this.stopReason;
    if (!reason || reason === 'shutdown' || reason === 'lost') return undefined;
    return new DiscordGatewayFailure(
      reason,
      this.readyAt === undefined ? 0 : Math.max(0, (this.stoppedAt ?? Date.now()) - this.readyAt),
    );
  }
  private assertOwned = () => {
    if (this.stopped || !this.owned || Date.now() >= this.expiresAt) {
      void this.stop('lost');
      throw new Error('Discord Gateway ownership unavailable');
    }
  };
  private armExpiry(): void {
    clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(
      () => void this.stop('lost'),
      Math.max(1, this.expiresAt - Date.now()),
    );
  }
  async start(signal: AbortSignal): Promise<boolean> {
    if (this.started) throw new Error('Discord Gateway was already started');
    this.started = true;
    const abort = () => void this.stop();
    signal.addEventListener('abort', abort, { once: true });
    void this.closed.then(() => signal.removeEventListener('abort', abort));
    if (!this.enabled || signal.aborted) {
      await this.stop();
      return false;
    }
    const startedAt = Date.now();
    try {
      const acquiring = this.deps.ownership.acquire(this.owner, this.policy.ownershipLeaseMs);
      const acquisition = await this.stage(acquiring);
      if (!acquisition || this.stopped) {
        void acquiring
          .then(async (held) => {
            if (held) await this.deps.ownership.release(this.owner);
          })
          .catch(() => this.deps.log.warn('discord_gateway_release_unavailable'));
        return false;
      }
      if (!acquisition.value) {
        await this.stop();
        return false;
      }
      this.owned = true;
      this.expiresAt = startedAt + this.policy.ownershipLeaseMs;
      this.assertOwned();
      this.armExpiry();
      this.scheduleRenewal();
      const loading = await this.stage(this.deps.checkpoints.load(this.owner));
      if (!loading) return false;
      const stored = loading.value;
      this.assertOwned();
      if (
        stored &&
        (stored.applicationId !== this.application.applicationId ||
          stored.applicationRevision !== this.application.applicationRevision ||
          stored.botUserId !== this.application.botUserId)
      )
        throw new Error('Discord checkpoint identity mismatch');
      const loaded = stored?.checkpoints ?? [];
      if (loaded.length > this.policy.shardCount)
        throw new Error('Invalid Discord checkpoint count');
      const shardIds = new Set<number>();
      for (const entry of loaded) {
        this.validateShard(entry.shardId);
        if (shardIds.has(entry.shardId)) throw new Error('Duplicate Discord checkpoint');
        shardIds.add(entry.shardId);
        if (!entry.session) continue;
        const info = this.validateSession(entry.shardId, entry.session);
        this.sessions.set(entry.shardId, {
          info,
          processed: info.sequence,
          verified: true,
          barrier: Promise.resolve(),
        });
      }
      const options: DiscordGatewayDriverOptions = {
        token: this.application.botToken,
        policy: this.policy,
        maxResponseBytes: this.maxResponseBytes,
        signal: this.controller.signal,
        assertOwned: this.assertOwned,
        retrieveSessionInfo: (shardId) => {
          this.assertOwned();
          const info = this.sessions.get(shardId)?.info;
          return info ? { ...info } : null;
        },
        updateSessionInfo: async (shardId, session) => {
          if (this.stopped) return;
          this.assertOwned();
          if (!session) {
            if (this.sessions.delete(shardId)) this.gaps.add(shardId);
            this.checkpointRevision++;
            await this.persist([{ shardId, session: null }]);
            return;
          }
          let info: SessionInfo;
          try {
            info = this.validateSession(shardId, session);
          } catch {
            void this.stop('identity');
            throw new Error('Invalid Discord Gateway session');
          }
          const previous = this.sessions.get(shardId);
          if (previous?.info.sessionId === info.sessionId) previous.info = info;
          else
            this.sessions.set(shardId, {
              info,
              processed: info.sequence,
              verified: false,
              barrier: Promise.resolve(),
            });
        },
        ready: ({ data, shardId }) => {
          if (this.stopped) return;
          const session = this.sessions.get(shardId);
          const ready = readySchema.safeParse(data);
          if (
            !ready.success ||
            ready.data.user.id !== this.application.botUserId ||
            ready.data.application.id !== this.application.applicationId ||
            !session ||
            session.info.sessionId !== ready.data.session_id
          ) {
            void this.stop('identity');
            return;
          }
          session.verified = true;
          this.observe({ type: 'session', event: 'ready', shardId });
          if (this.gaps.delete(shardId)) this.observe({ type: 'session', event: 'gap', shardId });
          this.checkpointRevision++;
          session.barrier = this.persist([
            { shardId, session: { ...session.info, sequence: session.processed } },
          ]);
          void session.barrier.catch(() => this.stop('checkpoint'));
        },
        resumed: (shardId) => {
          if (this.stopped) return;
          this.deps.log.info('discord_gateway_resumed');
          this.observe({ type: 'session', event: 'resumed', shardId });
        },
        dispatch: (event) => this.receive(event),
        closed: (code, shardId) => {
          const fatal = code === 4004 || [4010, 4011, 4012, 4013, 4014].includes(code);
          if (!this.stopped)
            this.observe({
              type: 'session',
              event: fatal ? 'closed_fatal' : 'closed_transient',
              shardId,
            });
          if (code === 4004) void this.stop('credentials');
          else if (fatal) void this.stop('configuration');
          else if (!this.stopped) this.deps.log.warn('discord_gateway_reconnecting');
        },
        error: () => {
          if (this.stopped) return;
          this.deps.log.warn('discord_gateway_error');
          this.observe({ type: 'session', event: 'error' });
        },
        heartbeat: (shardId, latencyMs) => {
          if (!this.stopped) this.observe({ type: 'heartbeat', shardId, latencyMs });
        },
        // A refused IDENTIFY is never sent, so the session cannot become READY. It stops now and the
        // owner's retry ladder decides when to start again. A rejected token keeps its own reason.
        identifyRefused: (error) => {
          if (this.stopped) return;
          const reason = error instanceof DiscordIdentifyRefusal ? error.reason : 'unconfirmed';
          this.deps.log.warn(`discord_gateway_identify_refused:${reason}`);
          void this.stop(error instanceof DiscordGatewayFailure ? error.reason : 'failed');
        },
      };
      this.driver = (this.deps.createDriver ?? createDiscordGatewayDriver)(options);
      const connected = this.driver.connect();
      // The SDK retries a Gateway that never answers on its own, spending IDENTIFY budget each time.
      const deadline = setTimeout(() => {
        this.deps.log.warn('discord_gateway_start_timeout');
        void this.stop('failed');
      }, this.startupDeadlineMs());
      const staged = await this.stage(connected).finally(() => clearTimeout(deadline));
      if (!staged) return false;
      this.assertOwned();
      if (
        this.sessions.size !== this.policy.shardCount ||
        [...this.sessions.values()].some((state) => !state.verified)
      )
        throw new Error('Discord Gateway session is not verified');
      if (
        !(await this.stage(Promise.all([...this.sessions.values()].map((state) => state.barrier))))
      )
        return false;
      this.assertOwned();
      this.scheduleCheckpoint();
      this.readyAt = Date.now();
      return true;
    } catch (error) {
      this.deps.log.warn('discord_gateway_start_unavailable');
      await this.stop(error instanceof DiscordGatewayFailure ? error.reason : 'failed');
      throw this.failure ?? new DiscordGatewayFailure('failed');
    }
  }
  /**
   * One startup attempt may take as long as its own stage timeouts allow: the REST read, the socket,
   * HELLO and READY, plus Discord's spacing for every further shard (worst case one identify bucket).
   */
  private startupDeadlineMs(): number {
    const { handshakeTimeoutMs, readyTimeoutMs, shardCount } = this.policy;
    return handshakeTimeoutMs * 3 + readyTimeoutMs + DISCORD_IDENTIFY_SPACING_MS * (shardCount - 1);
  }
  private async stage<T>(work: Promise<T>): Promise<{ value: T } | null> {
    const result = await Promise.race([
      work.then((value) => ({ value })),
      this.halted.then(() => null),
    ]);
    if (!result && this.stopReason !== 'shutdown' && this.stopReason !== 'lost')
      throw new Error('Discord Gateway connection unavailable');
    return result;
  }
  private validateSession(shardId: number, session: SessionInfo): SessionInfo {
    const info = sessionSchema.parse(session);
    this.validateShard(shardId);
    if (info.shardId !== shardId || info.shardCount !== this.policy.shardCount)
      throw new Error('Discord checkpoint shard mismatch');
    return info;
  }
  private validateShard(shardId: number): void {
    if (!Number.isSafeInteger(shardId) || shardId < 0 || shardId >= this.policy.shardCount)
      throw new Error('Discord checkpoint shard mismatch');
  }
  private scheduleRenewal(): void {
    if (this.stopped) return;
    this.renewalTimer = setTimeout(
      () => {
        void (async () => {
          const startedAt = Date.now();
          try {
            this.assertOwned();
            if (!(await this.deps.ownership.renew(this.owner, this.policy.ownershipLeaseMs))) {
              await this.stop('lost');
              return;
            }
            this.assertOwned();
            this.expiresAt = startedAt + this.policy.ownershipLeaseMs;
            this.armExpiry();
            this.scheduleRenewal();
          } catch {
            await this.stop('lost');
          }
        })();
      },
      Math.max(1, Math.floor(this.policy.ownershipLeaseMs / 3)),
    );
  }
  private persist(checkpoints: DiscordGatewayCheckpoint[]): Promise<void> {
    const save = this.saves.then(async () => {
      this.assertOwned();
      if (
        !(await this.deps.checkpoints.save(
          this.owner,
          {
            applicationId: this.application.applicationId,
            applicationRevision: this.application.applicationRevision,
            botUserId: this.application.botUserId,
            checkpoints,
          },
          this.controller.signal,
        ))
      )
        throw new Error('Discord checkpoint ownership changed');
      this.assertOwned();
    });
    this.saves = save;
    void save.catch(() => this.stop('checkpoint'));
    return save;
  }
  private snapshot(): DiscordGatewayCheckpoint[] {
    return [...this.sessions.entries()]
      .filter(([, state]) => state.verified)
      .map(([shardId, state]) => ({
        shardId,
        session: { ...state.info, sequence: state.processed },
      }));
  }
  private scheduleCheckpoint(): void {
    if (this.stopped) return;
    this.checkpointTimer = setTimeout(() => {
      const revision = this.checkpointRevision;
      const save =
        revision === this.persistedRevision
          ? Promise.resolve()
          : this.persist(this.snapshot()).then(() => {
              this.persistedRevision = revision;
            });
      void save.then(() => this.scheduleCheckpoint()).catch(() => this.stop('checkpoint'));
    }, this.policy.checkpointIntervalMs);
  }

  private receive({ data, shardId }: DiscordGatewayDispatch): void {
    if (this.stopped) return;
    try {
      this.assertOwned();
      const state = this.sessions.get(shardId);
      if (!state?.verified || !Number.isSafeInteger(data.s) || data.s < 0) return;
      if (this.queue.length >= this.policy.maxQueuedEvents) {
        void this.stop('backpressure');
        return;
      }
      const scope = {
        ownerId: this.owner.ownerId,
        applicationId: this.application.applicationId,
        applicationRevision: this.application.applicationRevision,
        shardId,
        sequence: data.s,
      };
      let event: DiscordGatewayEvent | undefined;
      if (data.t === 'MESSAGE_CREATE') {
        const parsed = messageSchema.safeParse(data.d);
        if (parsed.success) {
          const message = parsed.data;
          if (
            !message.author.bot &&
            !message.author.system &&
            message.author.id !== this.application.botUserId &&
            !message.webhook_id &&
            [0, 19].includes(message.type) &&
            message.content.length <= this.policy.maxMessageCharacters
          )
            event = {
              ...scope,
              kind: 'message',
              messageId: message.id,
              channelId: message.channel_id,
              guildId: message.guild_id,
              authorId: message.author.id,
              content: message.content,
              mentionsBot: message.mentions.some((user) => user.id === this.application.botUserId),
              replyToMessageId: message.message_reference?.message_id,
              channelType: message.channel_type,
            };
        }
      } else if (data.t === 'GUILD_CREATE' || data.t === 'GUILD_DELETE') {
        const parsed = z
          .object({ id: channelSnowflakeSchema, unavailable: z.boolean().optional() })
          .safeParse(data.d);
        if (parsed.success) {
          let state: 'available' | 'unavailable' | 'removed' = 'available';
          if (parsed.data.unavailable) state = 'unavailable';
          else if (data.t === 'GUILD_DELETE') state = 'removed';
          event = { ...scope, kind: 'guild', guildId: parsed.data.id, state };
        }
      }
      this.queue.push({ shardId, sequence: data.s, sessionId: state.info.sessionId, event });
      this.pump();
    } catch {
      void this.stop('failed');
    }
  }
  private pump(): void {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    void (async () => {
      try {
        while (this.queue.length && !this.stopped) {
          const entry = this.queue.shift();
          if (!entry) break;
          const state = this.sessions.get(entry.shardId);
          if (state) await state.barrier;
          this.assertOwned();
          if (entry.event) await this.deps.dispatch(entry.event, this.controller.signal);
          this.assertOwned();
          const current = this.sessions.get(entry.shardId);
          if (current?.info.sessionId === entry.sessionId && entry.sequence > current.processed) {
            current.processed = entry.sequence;
            this.checkpointRevision++;
          }
        }
      } catch {
        if (!this.stopped) await this.stop('dispatch');
      } finally {
        this.pumping = false;
      }
    })();
  }
  stop(reason: DiscordGatewayStopReason = 'shutdown'): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.stopped = true;
    this.stopReason = reason;
    this.stoppedAt = Date.now();
    this.observe({ type: 'stop', reason });
    this.controller.abort();
    clearTimeout(this.expiryTimer);
    clearTimeout(this.renewalTimer);
    clearTimeout(this.checkpointTimer);
    this.queue.length = 0;
    this.deps.log.info(`discord_gateway_stopped:${reason}`);
    this.cleanup = (async () => {
      try {
        await this.driver?.destroy();
      } catch {
        this.deps.log.warn('discord_gateway_destroy_unavailable');
      }
      try {
        if (this.owned) await this.deps.ownership.release(this.owner);
      } catch {
        this.deps.log.warn('discord_gateway_release_unavailable');
      } finally {
        this.owned = false;
        this.resolveClosed();
      }
    })();
    return this.cleanup;
  }
}
