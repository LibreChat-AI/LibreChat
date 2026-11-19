import { createHash } from 'node:crypto';
import type { DiscordRatePermit } from './rates';
import { DiscordRateCoordinator, DiscordRateQueueError } from './rates';

export type DiscordWriteOutcome = 'permanent' | 'retryable' | 'unknown';
export class DiscordWriteError extends Error {
  constructor(
    readonly outcome: DiscordWriteOutcome,
    readonly retryAfterMs = 0,
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
      throw new DiscordWriteError(outcome);
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
