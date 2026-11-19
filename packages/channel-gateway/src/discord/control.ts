import { z } from 'zod';
import {
  channelSnowflakeSchema,
  discordInboxClaimSchema,
  discordInboxSubmissionSchema,
  discordInboxFenceSchema,
  discordDmConsumeSchema,
  discordDmAcknowledgementSchema,
} from 'librechat-data-provider';
import type {
  DiscordApplicationSecurity,
  DiscordInboxSubmission,
  DiscordInboxClaim,
  DiscordInboxFence,
  DiscordDmConsume,
} from 'librechat-data-provider';
import type { ServiceConnection } from '../transport';
import { ServiceClient, ServiceError, boundedBody } from '../transport';

const securitySchema: z.ZodType<DiscordApplicationSecurity> = z
  .object({
    applicationId: channelSnowflakeSchema,
    applicationRevision: z.string().min(1).max(128),
    botUserId: channelSnowflakeSchema,
    publicKey: z.string().regex(/^[a-f0-9]{64}$/i),
    tenantId: z.string().min(1).max(128),
  })
  .strict();
const admissionSchema = z.object({
  ok: z.literal(true),
  value: z.object({
    eventId: channelSnowflakeSchema,
    state: z.enum(['queued', 'processing', 'reply', 'done', 'failed']),
    duplicate: z.boolean(),
  }),
});

/** Application discovery deliberately carries no caller-selected tenant header. */
export class DiscordControlClient extends ServiceClient {
  private readonly root = '/api/channels/discord/service';
  constructor(connection: ServiceConnection, transport: typeof fetch = fetch) {
    super({ ...connection, CHANNEL_TENANT_ID: undefined }, transport);
  }
  async security(
    applicationId: string,
    signal?: AbortSignal,
  ): Promise<DiscordApplicationSecurity | null> {
    channelSnowflakeSchema.parse(applicationId);
    const response = await this.raw(
      `${this.root}/security/${encodeURIComponent(applicationId)}`,
      undefined,
      signal,
    );
    if (response.status === 404) {
      await boundedBody(response, 65536);
      return null;
    }
    const result = securitySchema.parse(await this.decode(response));
    if (result.applicationId !== applicationId) throw new Error('Discord application mismatch');
    return result;
  }
  async submit(
    input: DiscordInboxSubmission,
    signal?: AbortSignal,
  ): Promise<'accepted' | 'conflict' | 'capacity'> {
    const parsed = discordInboxSubmissionSchema.parse(input);
    const response = await this.raw(`${this.root}/inbox/submit`, parsed, signal);
    if (response.status === 409 || response.status === 429) {
      await boundedBody(response, 65536);
      return response.status === 429 ? 'capacity' : 'conflict';
    }
    const result = admissionSchema.parse(await this.decode(response));
    if (![200, 201].includes(response.status) || result.value.eventId !== parsed.eventId)
      throw new Error('Discord admission was not confirmed');
    return 'accepted';
  }
  async select(
    input: DiscordDmConsume,
    signal?: AbortSignal,
  ): Promise<'accepted' | 'conflict' | 'capacity'> {
    const parsed = discordDmConsumeSchema.parse(input);
    const response = await this.raw(`${this.root}/dm/select`, parsed, signal);
    if ([404, 409, 429].includes(response.status)) {
      await boundedBody(response, 65536);
      return response.status === 429 ? 'capacity' : 'conflict';
    }
    const decoded = await this.decode(response);
    const result = z
      .object({ ok: z.literal(true), value: discordDmAcknowledgementSchema })
      .strict()
      .parse(decoded).value;
    if (
      response.status !== 200 ||
      result.applicationId !== parsed.applicationId ||
      result.externalUserId !== parsed.externalUserId ||
      result.dmChannelId !== parsed.dmChannelId
    )
      throw new Error('Discord DM selection was not confirmed');
    return 'accepted';
  }
  async claim(
    applicationId: string,
    owner: string,
    signal?: AbortSignal,
  ): Promise<DiscordInboxClaim | null> {
    channelSnowflakeSchema.parse(applicationId);
    if (!/^[\w-]{1,128}$/.test(owner)) throw new TypeError('Invalid Discord inbox owner');
    const response = await this.raw(`${this.root}/inbox/claim`, { applicationId, owner }, signal);
    if (response.status === 204) return null;
    const result = discordInboxClaimSchema.parse(await this.decode(response));
    if (result.fence.applicationId !== applicationId || result.fence.owner !== owner)
      throw new Error('Discord inbox lease mismatch');
    return result;
  }
  private async settle(path: string, body: object, signal?: AbortSignal): Promise<boolean> {
    const response = await this.raw(`${this.root}/inbox/${path}`, body, signal);
    if (response.status === 204) return true;
    if (response.status === 409) {
      await boundedBody(response, 65536);
      return false;
    }
    await this.decode(response);
    throw new ServiceError(response.status);
  }
  async finish(
    fence: DiscordInboxFence,
    result: 'completed' | 'expired' | 'unavailable',
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.settle('finish', { fence: discordInboxFenceSchema.parse(fence), result }, signal);
  }
  async defer(fence: DiscordInboxFence, retryAt: number, signal?: AbortSignal): Promise<boolean> {
    if (!Number.isSafeInteger(retryAt) || retryAt <= 0)
      throw new TypeError('Invalid Discord retry time');
    return this.settle('defer', { fence: discordInboxFenceSchema.parse(fence), retryAt }, signal);
  }
}
