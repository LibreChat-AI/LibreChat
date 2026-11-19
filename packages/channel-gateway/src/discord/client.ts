import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  channelSnowflakeSchema,
  discordGuildTextSourceSchema,
  discordGuildTextPermissions,
  discordGuildTextActorSourceSchema,
  discordGuildTextActorUsable,
} from 'librechat-data-provider';
import type {
  DiscordGuildTextSource,
  DiscordGuildThreadSource,
  DiscordGuildTextActorSource,
} from 'librechat-data-provider';
import type { APIActionRowComponent, APIButtonComponent } from 'discord-api-types/v10';
import type { DiscordApplicationObservation } from './observe';
import type { DiscordThreadInspection } from './thread';
import type { DiscordWriteOutcome } from './errors';
import type { DiscordRatePermit } from './rates';
import { DiscordRateCoordinator, DiscordRateQueueError } from './rates';
import { inspectDiscordThread } from './thread';
import { safeDiscordObserver } from './observe';
import { DiscordWriteError } from './errors';

export { DiscordWriteError } from './errors';
export type { DiscordWriteOutcome } from './errors';
export interface DiscordClientOptions {
  botToken: string;
  timeoutMs: number;
  maxResponseBytes: number;
  apiBase?: string;
  /** Optional telemetry for the bot's own channel permissions. Actor and member outcomes are never reported. */
  observe?: (observation: Extract<DiscordApplicationObservation, { type: 'permission' }>) => void;
}
export interface DiscordMessage {
  content: string;
  components?: APIActionRowComponent<APIButtonComponent>[];
}
export interface DiscordMessageReceipt {
  externalMessageKey: string;
  messageId: string;
  channelId: string;
}
const idPattern = /^[0-9]{1,20}$/;
const noMentions = { parse: [], replied_user: false };

/** Stable across retries, within Discord's 25 character nonce bound. */
export function discordNonce(operationId: string): string {
  return createHash('sha256').update(operationId).digest('hex').slice(0, 25);
}

/** The bot's own view of a channel. `outcome` is absent when nothing was learned about permissions. */
interface BotInspection {
  source: DiscordGuildTextSource | null;
  outcome?: 'ok' | 'denied';
}

export class DiscordClient {
  private readonly base: string;
  private readonly observe: NonNullable<DiscordClientOptions['observe']>;
  constructor(
    private readonly options: DiscordClientOptions,
    private readonly transport: typeof fetch = fetch,
    private readonly rates: DiscordRateCoordinator = new DiscordRateCoordinator(),
  ) {
    const base = new URL(options.apiBase ?? 'https://discord.com/api/v10/');
    if (
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      (base.protocol !== 'https:' &&
        !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))
    )
      throw new TypeError('Invalid Discord API base');
    if (
      !options.botToken ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      !Number.isSafeInteger(options.maxResponseBytes) ||
      options.maxResponseBytes <= 0
    )
      throw new TypeError('Invalid Discord client policy');
    this.base = base.toString().replace(/\/$/, '');
    this.observe = safeDiscordObserver(options.observe);
  }
  private async request(
    method: string,
    path: string,
    payload: object | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const segments = path.split('/');
    const route = {
      route: `${method} ${path.replace(/\/\d+(?=\/|$)/g, '/:id')}`,
      major: `${segments[1]}:${segments[2]}`,
    };
    let permit: DiscordRatePermit;
    try {
      permit = await this.rates.acquire(route, signal);
    } catch (error) {
      if (error instanceof DiscordRateQueueError)
        throw new DiscordWriteError('retryable', error.retryAfterMs);
      throw error;
    }
    try {
      return await this.send(method, path, payload, permit, signal);
    } finally {
      permit.release();
    }
  }
  private async send(
    method: string,
    path: string,
    payload: object | undefined,
    permit: DiscordRatePermit,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.transport(this.base + path, {
        method,
        headers: {
          Authorization: `Bot ${this.options.botToken}`,
          'Content-Type': 'application/json',
        },
        body: payload ? JSON.stringify(payload) : undefined,
        redirect: 'error',
        signal: AbortSignal.any([
          AbortSignal.timeout(this.options.timeoutMs),
          ...(signal ? [signal] : []),
        ]),
      });
    } catch {
      throw new DiscordWriteError('unknown');
    }
    permit.observe(response);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const chunks: Uint8Array[] = [];
    let size = 0;
    let value: unknown;
    try {
      reader = response.body?.getReader();
      while (reader) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > this.options.maxResponseBytes) throw new Error('Response exceeds limit');
        chunks.push(chunk.value);
      }
      if (size) value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      let outcome: DiscordWriteOutcome = 'unknown';
      if ([400, 401, 403, 404].includes(response.status)) outcome = 'permanent';
      else if (response.status === 429)
        throw new DiscordWriteError('retryable', this.rates.retryAfter(response));
      throw new DiscordWriteError(outcome, 0, response.status);
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
    permit.observe(response, value);
    if (response.status === 429)
      throw new DiscordWriteError('retryable', this.rates.retryAfter(response, value));
    if (!response.ok)
      throw new DiscordWriteError(
        [400, 401, 403, 404].includes(response.status) ? 'permanent' : 'unknown',
        0,
        response.status,
      );
    return value;
  }
  private id(value: string): string {
    if (!idPattern.test(value)) throw new TypeError('Invalid Discord address');
    return value;
  }
  private message(message: DiscordMessage): DiscordMessage {
    if (!message.content || message.content.length > 2000 || (message.components?.length ?? 0) > 5)
      throw new TypeError('Invalid Discord message');
    return message;
  }
  private receipt(value: unknown, channelId: string): DiscordMessageReceipt {
    if (
      !value ||
      typeof value !== 'object' ||
      !('id' in value) ||
      typeof value.id !== 'string' ||
      !idPattern.test(value.id) ||
      !('channel_id' in value) ||
      value.channel_id !== channelId
    )
      throw new DiscordWriteError('unknown');
    return { channelId, messageId: value.id, externalMessageKey: `${channelId}:${value.id}` };
  }
  /** Get Guild confirms current bot membership: https://docs.discord.com/developers/resources/guild#get-guild */
  async isGuildMember(guildId: string, signal?: AbortSignal): Promise<boolean> {
    channelSnowflakeSchema.parse(guildId);
    try {
      const value = z
        .object({ id: channelSnowflakeSchema })
        .safeParse(await this.request('GET', `/guilds/${guildId}`, undefined, signal));
      if (!value.success || value.data.id !== guildId) throw new DiscordWriteError('unknown');
      return true;
    } catch (error) {
      if (error instanceof DiscordWriteError && [403, 404].includes(error.status ?? 0))
        return false;
      throw error;
    }
  }
  /** Discord computes roles and overwrites: https://docs.discord.com/developers/resources/channel#get-channel-member-permissions */
  async getChannelMemberPermissions(
    channelId: string,
    userId: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    return (await this.memberPermissions(channelId, userId, signal)).permissions;
  }
  /** `forbidden` tells a refusal (403) from a missing channel or member (404), which says nothing about permissions. */
  private async memberPermissions(
    channelId: string,
    userId: string,
    signal?: AbortSignal,
  ): Promise<{ permissions: string | null; forbidden: boolean }> {
    channelSnowflakeSchema.parse(channelId);
    channelSnowflakeSchema.parse(userId);
    try {
      const result = z
        .object({ permissions: discordGuildTextSourceSchema.shape.permissions })
        .safeParse(
          await this.request(
            'GET',
            `/channels/${channelId}/permissions/member/${userId}`,
            undefined,
            signal,
          ),
        );
      if (!result.success) throw new DiscordWriteError('unknown');
      return { permissions: result.data.permissions, forbidden: false };
    } catch (error) {
      if (error instanceof DiscordWriteError && [403, 404].includes(error.status ?? 0))
        return { permissions: null, forbidden: error.status === 403 };
      throw error;
    }
  }
  /** Reports only what the bot itself can do: another user's access is per user and never lands here. */
  async inspectGuildTextSource(
    input: { applicationId: string; botUserId: string; guildId: string; channelId: string },
    signal?: AbortSignal,
  ): Promise<DiscordGuildTextSource | null> {
    for (const value of Object.values(input)) channelSnowflakeSchema.parse(value);
    const { source, outcome } = await this.inspectBotSource(input, signal);
    if (outcome) this.observe({ type: 'permission', outcome });
    return source;
  }
  private async inspectBotSource(
    input: { applicationId: string; botUserId: string; guildId: string; channelId: string },
    signal?: AbortSignal,
  ): Promise<BotInspection> {
    try {
      const [rawChannel, { permissions, forbidden }] = await Promise.all([
        this.request('GET', `/channels/${input.channelId}`, undefined, signal),
        this.memberPermissions(input.channelId, input.botUserId, signal),
      ]);
      const channel = z
        .object({
          id: channelSnowflakeSchema,
          guild_id: channelSnowflakeSchema,
          type: z.number().int(),
          flags: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
        })
        .safeParse(rawChannel);
      if (permissions === null) return { source: null, outcome: forbidden ? 'denied' : undefined };
      if (!channel.success) throw new DiscordWriteError('unknown');
      if (
        channel.data.id !== input.channelId ||
        channel.data.guild_id !== input.guildId ||
        channel.data.type !== 0 ||
        (BigInt(channel.data.flags ?? 0) & BigInt(1 << 17)) !== BigInt(0)
      )
        return { source: null };
      if (!discordGuildTextPermissions(permissions)) return { source: null, outcome: 'denied' };
      return { source: { kind: 'guild_text', ...input, permissions }, outcome: 'ok' };
    } catch (error) {
      if (error instanceof DiscordWriteError && [403, 404].includes(error.status ?? 0))
        return { source: null, outcome: error.status === 403 ? 'denied' : undefined };
      throw error;
    }
  }
  /** Fresh roles/overwrites and exact private membership, never cached permission grants. */
  async inspectGuildThreadSource(
    input: DiscordThreadInspection,
    signal?: AbortSignal,
  ): Promise<DiscordGuildThreadSource | null> {
    const lifetime = new AbortController();
    const inspectionSignal = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
    try {
      return await inspectDiscordThread(input, (path) =>
        this.request('GET', path, undefined, inspectionSignal),
      );
    } finally {
      // An early failed projection must not leave sibling requests queued behind a rate limit.
      lifetime.abort();
    }
  }
  /** Single-member reads establish membership independently of the effective channel permission result. */
  async inspectGuildTextActorSource(
    input: {
      applicationId: string;
      botUserId: string;
      guildId: string;
      channelId: string;
      authorId: string;
    },
    signal?: AbortSignal,
  ): Promise<DiscordGuildTextActorSource | null> {
    for (const value of Object.values(input)) channelSnowflakeSchema.parse(value);
    if (input.authorId === input.botUserId) return null;
    const inspection = new AbortController();
    const currentSignal = AbortSignal.any([inspection.signal, ...(signal ? [signal] : [])]);
    try {
      const [source, permissions, rawMember] = await Promise.all([
        this.inspectGuildTextSource(
          {
            applicationId: input.applicationId,
            botUserId: input.botUserId,
            guildId: input.guildId,
            channelId: input.channelId,
          },
          currentSignal,
        ),
        this.getChannelMemberPermissions(input.channelId, input.authorId, currentSignal),
        this.request(
          'GET',
          `/guilds/${input.guildId}/members/${input.authorId}`,
          undefined,
          currentSignal,
        ),
      ]);
      if (!source || permissions === null) return null;
      const member = z
        .object({
          user: z.object({
            id: channelSnowflakeSchema,
            bot: z.boolean().optional(),
            system: z.boolean().optional(),
          }),
        })
        .safeParse(rawMember);
      if (!member.success || member.data.user.id !== input.authorId)
        throw new DiscordWriteError('unknown');
      if (member.data.user.bot || member.data.user.system) return null;
      const observed = discordGuildTextActorSourceSchema.parse({
        ...source,
        authorId: input.authorId,
        authorMember: true,
        authorPermissions: permissions,
      });
      return discordGuildTextActorUsable(observed) ? observed : null;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof DiscordWriteError && [403, 404].includes(error.status ?? 0)) return null;
      throw error;
    } finally {
      inspection.abort();
    }
  }

  async createMessage(
    channelId: string,
    message: DiscordMessage,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<DiscordMessageReceipt> {
    if (!operationId) throw new TypeError('Missing Discord operation identity');
    return this.receipt(
      await this.request(
        'POST',
        `/channels/${this.id(channelId)}/messages`,
        {
          ...this.message(message),
          allowed_mentions: noMentions,
          nonce: discordNonce(operationId),
          enforce_nonce: true,
        },
        signal,
      ),
      channelId,
    );
  }
  async editMessage(
    channelId: string,
    messageId: string,
    message: DiscordMessage,
    signal?: AbortSignal,
  ): Promise<DiscordMessageReceipt> {
    return this.receipt(
      await this.request(
        'PATCH',
        `/channels/${this.id(channelId)}/messages/${this.id(messageId)}`,
        { ...this.message(message), allowed_mentions: noMentions },
        signal,
      ),
      channelId,
    );
  }
  async deleteMessage(channelId: string, messageId: string, signal?: AbortSignal): Promise<void> {
    await this.request(
      'DELETE',
      `/channels/${this.id(channelId)}/messages/${this.id(messageId)}`,
      undefined,
      signal,
    );
  }
}
