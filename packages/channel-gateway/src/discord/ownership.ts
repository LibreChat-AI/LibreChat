import {
  discordGatewayOwnerSchema,
  discordCredentialStateSchema,
  discordGatewayBatchSchema,
  discordGatewayBootstrapSchema,
  discordGuildRemovalTargetSchema,
  discordGuildRemovalPreparationSchema,
  channelSnowflakeSchema,
} from 'librechat-data-provider';
import type {
  DiscordGatewayOwner,
  DiscordCredentialState,
  DiscordGatewayBatch,
  DiscordGatewayBootstrap,
  DiscordGuildRemovalTarget,
  DiscordGuildRemovalPreparation,
} from 'librechat-data-provider';
import type { ServiceConnection } from '../transport';
import { ServiceClient, ServiceError, boundedBody } from '../transport';

/** Private Gateway control plane; tenant authority is resolved on the server from application ID. */
export class DiscordGatewayControlClient extends ServiceClient {
  constructor(connection: ServiceConnection, transport: typeof fetch = fetch) {
    super({ ...connection, CHANNEL_TENANT_ID: undefined }, transport);
  }
  async observeCredentials(
    owner: DiscordGatewayOwner,
    state: DiscordCredentialState,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const response = await this.raw(
      '/api/channels/discord/service/gateway/observeCredentials',
      {
        owner: discordGatewayOwnerSchema.parse(owner),
        state: discordCredentialStateSchema.parse(state),
      },
      signal,
    );
    return this.confirmed(response);
  }
  async prepareGuildRemoval(
    owner: DiscordGatewayOwner,
    guildId: string,
    signal?: AbortSignal,
  ): Promise<DiscordGuildRemovalPreparation> {
    const response = await this.raw(
      '/api/channels/discord/service/gateway/prepareGuildRemoval',
      {
        owner: discordGatewayOwnerSchema.parse(owner),
        guildId: channelSnowflakeSchema.parse(guildId),
      },
      signal,
    );
    const result = discordGuildRemovalPreparationSchema.parse(await this.read(response));
    if (result.target && result.target.guildId !== guildId)
      throw new Error('Discord guild removal mismatch');
    return result;
  }
  async removeGuild(
    owner: DiscordGatewayOwner,
    target: DiscordGuildRemovalTarget,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.raw(
      '/api/channels/discord/service/gateway/removeGuild',
      {
        owner: discordGatewayOwnerSchema.parse(owner),
        target: discordGuildRemovalTargetSchema.parse(target),
      },
      signal,
    );
    if (response.status !== 204) {
      if (!response.ok) await this.decode(response);
      throw new Error('Discord guild removal was not confirmed');
    }
  }
  private async call(
    path: string,
    owner: DiscordGatewayOwner,
    batch?: DiscordGatewayBatch,
    signal?: AbortSignal,
    leaseMs?: number,
  ): Promise<Response> {
    const parsed = discordGatewayOwnerSchema.parse(owner);
    return this.raw(
      `/api/channels/discord/service/gateway/${path}`,
      {
        owner: parsed,
        ...(batch ? { batch: discordGatewayBatchSchema.parse(batch) } : {}),
        ...(leaseMs === undefined ? {} : { leaseMs }),
      },
      signal,
    );
  }
  private async read(response: Response): Promise<unknown> {
    if (!response.ok) return this.decode(response);
    // Protocol maximum: 128 shards with at most 8192 bytes per encrypted checkpoint.
    const bytes = await boundedBody(response, 128 * 8192);
    try {
      return JSON.parse(bytes.toString());
    } catch {
      throw new Error('Invalid Discord Gateway response');
    }
  }
  private async effect(
    path: string,
    owner: DiscordGatewayOwner,
    batch?: DiscordGatewayBatch,
    signal?: AbortSignal,
    leaseMs?: number,
  ): Promise<boolean> {
    const response = await this.call(path, owner, batch, signal, leaseMs);
    return this.confirmed(response);
  }
  private async confirmed(response: Response): Promise<boolean> {
    if (response.status === 204) return true;
    if (response.status === 409) {
      await boundedBody(response, 65536);
      return false;
    }
    await this.decode(response);
    throw new ServiceError(response.status);
  }
  acquire(owner: DiscordGatewayOwner, leaseMs: number, signal?: AbortSignal): Promise<boolean> {
    return this.effect('acquire', owner, undefined, signal, leaseMs);
  }
  renew(owner: DiscordGatewayOwner, leaseMs: number, signal?: AbortSignal): Promise<boolean> {
    return this.effect('renew', owner, undefined, signal, leaseMs);
  }
  release(owner: DiscordGatewayOwner, signal?: AbortSignal): Promise<boolean> {
    return this.effect('release', owner, undefined, signal);
  }
  save(
    owner: DiscordGatewayOwner,
    batch: DiscordGatewayBatch,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.effect('save', owner, batch, signal);
  }
  async bootstrap(
    owner: DiscordGatewayOwner,
    signal?: AbortSignal,
  ): Promise<DiscordGatewayBootstrap | null> {
    const response = await this.call('bootstrap', owner, undefined, signal);
    if (response.status === 409) {
      await boundedBody(response, 65536);
      return null;
    }
    const result = discordGatewayBootstrapSchema.parse(await this.read(response));
    if (
      result.applicationId !== owner.applicationId ||
      result.applicationRevision !== owner.applicationRevision
    )
      throw new Error('Discord Gateway bootstrap mismatch');
    return result;
  }
  async load(
    owner: DiscordGatewayOwner,
    signal?: AbortSignal,
  ): Promise<DiscordGatewayBatch | null> {
    const response = await this.call('load', owner, undefined, signal);
    if (response.status === 409) {
      await boundedBody(response, 65536);
      return null;
    }
    const result = discordGatewayBatchSchema.parse(await this.read(response));
    if (
      result.applicationId !== owner.applicationId ||
      result.applicationRevision !== owner.applicationRevision
    )
      throw new Error('Discord Gateway checkpoint mismatch');
    return result;
  }
}
