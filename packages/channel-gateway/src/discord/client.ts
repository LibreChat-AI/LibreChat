import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  channelSnowflakeSchema,
  discordGuildTextSourceSchema,
  discordGuildTextPermissions,
} from 'librechat-data-provider';
import type { DiscordGuildTextSource } from 'librechat-data-provider';
import type { DiscordRatePermit } from './rates';
import { DiscordRateCoordinator, DiscordRateQueueError } from './rates';

export type DiscordWriteOutcome = 'permanent' | 'retryable' | 'unknown';
export class DiscordWriteError extends Error {
  constructor(
    readonly outcome: DiscordWriteOutcome,
    readonly retryAfterMs = 0,
    readonly status?: number,
  ) {
    super('Discord operation was not confirmed');
  }
}
export interface DiscordClientOptions {
  botToken: string;
  timeoutMs: number;
  maxResponseBytes: number;
  apiBase?: string;
}
export interface DiscordMessage {
  content: string;
  components?: object[];
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

export class DiscordClient {
  private readonly base: string;
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
  async inspectGuildTextSource(
    input: { applicationId: string; botUserId: string; guildId: string; channelId: string },
    signal?: AbortSignal,
  ): Promise<DiscordGuildTextSource | null> {
    for (const value of Object.values(input)) channelSnowflakeSchema.parse(value);
    try {
      const [rawChannel, rawPermissions] = await Promise.all([
        this.request('GET', `/channels/${input.channelId}`, undefined, signal),
        this.request(
          'GET',
          `/channels/${input.channelId}/permissions/member/${input.botUserId}`,
          undefined,
          signal,
        ),
      ]);
      const channel = z
        .object({
          id: channelSnowflakeSchema,
          guild_id: channelSnowflakeSchema,
          type: z.number().int(),
          flags: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
        })
        .safeParse(rawChannel);
      const permissions = z
        .object({ permissions: discordGuildTextSourceSchema.shape.permissions })
        .safeParse(rawPermissions);
      if (!channel.success || !permissions.success) throw new DiscordWriteError('unknown');
      if (
        channel.data.id !== input.channelId ||
        channel.data.guild_id !== input.guildId ||
        channel.data.type !== 0 ||
        (BigInt(channel.data.flags ?? 0) & BigInt(1 << 17)) !== BigInt(0) ||
        !discordGuildTextPermissions(permissions.data.permissions)
      )
        return null;
      return { kind: 'guild_text', ...input, permissions: permissions.data.permissions };
    } catch (error) {
      if (error instanceof DiscordWriteError && [403, 404].includes(error.status ?? 0)) return null;
      throw error;
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
