import { tenantStorage } from '@librechat/data-schemas';
import {
  discordGatewayOwnerSchema,
  discordGatewayBatchSchema,
  discordGatewaySessionSchema,
  discordGatewayBootstrapSchema,
  discordChannelConfigSchema,
} from 'librechat-data-provider';
import type {
  DiscordGatewayBatch,
  DiscordGatewayBootstrap,
  DiscordGatewayOwner,
  DiscordChannelConfig,
} from 'librechat-data-provider';
import type { DiscordGatewayStorage, DiscordInstallationStorage } from '@librechat/data-schemas';

export interface DiscordGatewayService {
  acquire(owner: DiscordGatewayOwner): Promise<boolean>;
  renew(owner: DiscordGatewayOwner): Promise<boolean>;
  release(owner: DiscordGatewayOwner): Promise<boolean>;
  bootstrap(owner: DiscordGatewayOwner): Promise<DiscordGatewayBootstrap | null>;
  load(owner: DiscordGatewayOwner): Promise<DiscordGatewayBatch | null>;
  save(owner: DiscordGatewayOwner, batch: DiscordGatewayBatch): Promise<boolean>;
}
/** Settings return null when either the channel host, Discord, or Gateway is disabled. */
export function createDiscordGatewayService(deps: {
  storage: DiscordGatewayStorage;
  installations: Pick<DiscordInstallationStorage, 'lookupApplication'>;
  settings: () => Promise<DiscordChannelConfig | null>;
  encrypt: (value: string) => Promise<string>;
  decrypt: (value: string) => Promise<string>;
}): DiscordGatewayService {
  async function settings() {
    const value = await deps.settings();
    if (!value) return null;
    const parsed = discordChannelConfigSchema.parse(value);
    return parsed.enabled && parsed.gateway.enabled ? parsed : null;
  }
  async function scoped<T>(
    owner: DiscordGatewayOwner,
    denied: T,
    work: (policy: DiscordChannelConfig) => Promise<T>,
    cleanup = false,
  ): Promise<T> {
    discordGatewayOwnerSchema.parse(owner);
    const app = await deps.installations.lookupApplication(owner.applicationId);
    if (!app || (!cleanup && app.revision !== owner.applicationRevision)) return denied;
    return tenantStorage.run({ tenantId: app.tenantId || undefined }, async () => {
      const policy = await settings();
      if (!policy && !cleanup) return denied;
      return work(policy ?? discordChannelConfigSchema.parse({}));
    });
  }
  const current = async (policy: DiscordChannelConfig) => {
    const next = await settings();
    return next && JSON.stringify(next.gateway) === JSON.stringify(policy.gateway);
  };
  return {
    acquire: (owner: DiscordGatewayOwner) =>
      scoped(owner, false, () => deps.storage.acquire(owner)),
    renew: (owner: DiscordGatewayOwner) => scoped(owner, false, () => deps.storage.renew(owner)),
    release: (owner: DiscordGatewayOwner) =>
      scoped(owner, false, () => deps.storage.release(owner), true),
    bootstrap: (owner: DiscordGatewayOwner) =>
      scoped(owner, null, async (policy) => {
        const state = await deps.storage.load(owner);
        if (!state) return null;
        const botToken = await deps.decrypt(state.encryptedBotToken);
        if (!(await current(policy)) || !(await deps.storage.load(owner))) return null;
        return discordGatewayBootstrapSchema.parse({
          applicationId: state.applicationId,
          applicationRevision: state.applicationRevision,
          botUserId: state.botUserId,
          botToken,
          policy: policy.gateway,
        });
      }),
    load: (owner: DiscordGatewayOwner) =>
      scoped<DiscordGatewayBatch | null>(owner, null, async (policy) => {
        const state = await deps.storage.load(owner);
        if (!state) return null;
        const checkpoints = await Promise.all(
          state.checkpoints.map(async (row) => {
            const session = discordGatewaySessionSchema.parse(
              JSON.parse(await deps.decrypt(row.encryptedSession)),
            );
            if (session.shardId !== row.shardId || session.shardCount !== policy.gateway.shardCount)
              throw new Error('Invalid Discord Gateway checkpoint');
            return { shardId: row.shardId, session };
          }),
        );
        if (!(await current(policy)) || !(await deps.storage.load(owner))) return null;
        return discordGatewayBatchSchema.parse({
          applicationId: state.applicationId,
          applicationRevision: state.applicationRevision,
          botUserId: state.botUserId,
          checkpoints,
        });
      }),
    save: (owner: DiscordGatewayOwner, batch: DiscordGatewayBatch) =>
      scoped(owner, false, async (policy) => {
        const parsed = discordGatewayBatchSchema.parse(batch);
        if (
          parsed.applicationId !== owner.applicationId ||
          parsed.applicationRevision !== owner.applicationRevision ||
          parsed.checkpoints.some(
            (row) =>
              row.shardId >= policy.gateway.shardCount ||
              (row.session && row.session.shardCount !== policy.gateway.shardCount),
          )
        )
          return false;
        const rows = await Promise.all(
          parsed.checkpoints.map(async (row) => ({
            shardId: row.shardId,
            encryptedSession: row.session ? await deps.encrypt(JSON.stringify(row.session)) : null,
          })),
        );
        if (!(await current(policy))) return false;
        return deps.storage.save(owner, parsed.botUserId, rows);
      }),
  };
}
