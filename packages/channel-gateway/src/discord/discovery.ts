import {
  discordRuntimeCursorSchema,
  discordMessageSubmissionSchema,
  discordMessageResultSchema,
  discordRuntimeChannelsSchema,
  discordRuntimeBootstrapSchema,
  discordRuntimeApplicationsSchema,
} from 'librechat-data-provider';
import type {
  DiscordRuntimeApplications,
  DiscordGatewayOwner,
  DiscordGatewayMessage,
  DiscordGuildTextSource,
  DiscordMessageResult,
  DiscordRuntimeChannels,
  DiscordRuntimeBootstrap,
} from 'librechat-data-provider';
import type { ServiceConnection } from '../transport';
import { ServiceClient, boundedBody } from '../transport';

/** Bounded nonsecret discovery, separate from owner-only credentials and session capabilities. */
export class DiscordRuntimeClient extends ServiceClient {
  constructor(connection: ServiceConnection, transport: typeof fetch = fetch) {
    super({ ...connection, CHANNEL_TENANT_ID: undefined }, transport);
  }
  private async read(path: string, cursor?: string, signal?: AbortSignal): Promise<unknown> {
    if (cursor !== undefined) discordRuntimeCursorSchema.parse(cursor);
    const response = await this.raw(
      `/api/channels/discord/service/runtime/${path}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      undefined,
      signal,
    );
    if (!response.ok) return this.decode(response);
    const bytes = await boundedBody(response, 128 * 1024);
    try {
      return JSON.parse(bytes.toString());
    } catch {
      throw new Error('Invalid Discord discovery response');
    }
  }
  async bootstrap(signal?: AbortSignal): Promise<DiscordRuntimeBootstrap> {
    return discordRuntimeBootstrapSchema.parse(await this.read('bootstrap', undefined, signal));
  }
  async applications(cursor?: string, signal?: AbortSignal): Promise<DiscordRuntimeApplications> {
    return discordRuntimeApplicationsSchema.parse(await this.read('applications', cursor, signal));
  }
  async channels(cursor?: string, signal?: AbortSignal): Promise<DiscordRuntimeChannels> {
    return discordRuntimeChannelsSchema.parse(await this.read('channels', cursor, signal));
  }
  async message(
    owner: DiscordGatewayOwner,
    event: DiscordGatewayMessage,
    source: DiscordGuildTextSource | null,
    signal?: AbortSignal,
  ): Promise<DiscordMessageResult> {
    const input = discordMessageSubmissionSchema.parse({ owner, event, source });
    const response = await this.raw('/api/channels/discord/service/messages', input, signal);
    if (!response.ok) return this.decode(response);
    const bytes = await boundedBody(response, 65536);
    try {
      return discordMessageResultSchema.parse(JSON.parse(bytes.toString()));
    } catch {
      throw new Error('Invalid Discord message admission');
    }
  }
}
