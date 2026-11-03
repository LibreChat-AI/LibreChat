import { channelStorageConfigSchema, durableStorageConfigSchema } from 'librechat-data-provider';
import type { ChannelStorageConfig, DurableStorageConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { GetAppConfigOptions } from '~/app/service';

/** Config installs its reader during composition, without a models-to-config import cycle. */
export function createStorageConfigReader(): {
  initialize: (reader: (options?: GetAppConfigOptions) => Promise<AppConfig>) => void;
  getChannelConfig: () => Promise<ChannelStorageConfig>;
  getDurableConfig: () => Promise<DurableStorageConfig>;
} {
  let readConfig: ((options?: GetAppConfigOptions) => Promise<AppConfig>) | undefined;
  async function readBaseConfig(): Promise<AppConfig> {
    if (!readConfig) throw new Error('Storage config reader has not been initialized');
    return readConfig({ baseOnly: true });
  }
  return {
    initialize(reader) {
      readConfig = reader;
    },
    async getChannelConfig() {
      const config = await readBaseConfig();
      return channelStorageConfigSchema.parse(config.endpoints?.agents?.channels ?? {});
    },
    async getDurableConfig() {
      const config = await readBaseConfig();
      return durableStorageConfigSchema.parse(config.durableStorage ?? {});
    },
  };
}
