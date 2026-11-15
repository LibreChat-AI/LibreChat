import {
  discordGatewayOwnerSchema,
  discordGatewayBatchSchema,
  discordGatewayBootstrapSchema,
} from 'librechat-data-provider';
import type {
  DiscordGatewayOwner,
  DiscordGatewayBatch,
  DiscordGatewayBootstrap,
} from 'librechat-data-provider';
import type { ServiceConnection } from '../transport';
import { ServiceClient, ServiceError, boundedBody } from '../transport';

/** Private Gateway control plane; tenant authority is resolved on the server from application ID. */
export class DiscordGatewayControlClient extends ServiceClient {
  constructor(connection: ServiceConnection, transport: typeof fetch = fetch) {
    super({ ...connection, CHANNEL_TENANT_ID: undefined }, transport);
  }
  private async call(
    path: string,
    owner: DiscordGatewayOwner,
    batch?: DiscordGatewayBatch,
    signal?: AbortSignal,
  ): Promise<Response> {
    const parsed = discordGatewayOwnerSchema.parse(owner);
    return this.raw(
      `/api/channels/discord/service/gateway/${path}`,
      { owner: parsed, ...(batch ? { batch: discordGatewayBatchSchema.parse(batch) } : {}) },
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
  ): Promise<boolean> {
    const response = await this.call(path, owner, batch, signal);
    if (response.status === 204) return true;
    if (response.status === 409) {
      await boundedBody(response, 65536);
      return false;
    }
    await this.decode(response);
    throw new ServiceError(response.status);
  }
  acquire(owner: DiscordGatewayOwner, signal?: AbortSignal): Promise<boolean> {
    return this.effect('acquire', owner, undefined, signal);
  }
  renew(owner: DiscordGatewayOwner, signal?: AbortSignal): Promise<boolean> {
    return this.effect('renew', owner, undefined, signal);
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
