import { tenantStorage } from '@librechat/data-schemas';
import { discordChannelConfigSchema } from 'librechat-data-provider';
import type {
  DiscordRuntimeApplications,
  DiscordRuntimeChannels,
  DiscordRuntimeBootstrap,
  DiscordChannelConfig,
} from 'librechat-data-provider';
import type { DiscordRuntimeStorage } from '@librechat/data-schemas';

export interface DiscordRuntimeService {
  bootstrap(): Promise<DiscordRuntimeBootstrap>;
  applications(cursor?: string): Promise<DiscordRuntimeApplications>;
  channels(cursor?: string): Promise<DiscordRuntimeChannels>;
}
/** The host merges channels.enabled into policy.enabled; bootstrap never contains credentials. */
export function createDiscordRuntimeService(deps: {
  storage: DiscordRuntimeStorage;
  settings: () => Promise<DiscordChannelConfig>;
}): DiscordRuntimeService {
  const read = async () => discordChannelConfigSchema.parse(await deps.settings());
  async function enabled(tenantId: string): Promise<boolean> {
    return tenantStorage.run(
      { tenantId: tenantId === '_' ? undefined : tenantId },
      async () => (await read()).enabled,
    );
  }
  async function available<T extends { tenantId: string }>(values: T[]): Promise<T[]> {
    const tenants = new Map<string, Promise<boolean>>();
    const checked = await Promise.all(
      values.map(async (value) => {
        let active = tenants.get(value.tenantId);
        if (!active) {
          active = enabled(value.tenantId);
          tenants.set(value.tenantId, active);
        }
        return (await active) ? value : null;
      }),
    );
    return checked.filter((value) => value !== null);
  }
  return {
    bootstrap: async () => ({ discord: await read() }),
    async applications(cursor) {
      const policy = await read();
      if (!policy.enabled) return { applications: [] };
      const page = await deps.storage.applications(cursor, policy.gateway.discoveryBatchSize);
      return {
        applications: await available(page.applications),
        ...(page.next ? { next: page.next } : {}),
      };
    },
    async channels(cursor) {
      const policy = await read();
      if (!policy.enabled) return { channels: [] };
      const page = await deps.storage.channels(cursor, policy.gateway.discoveryBatchSize);
      return {
        channels: await available(page.channels),
        ...(page.next ? { next: page.next } : {}),
      };
    },
  };
}
