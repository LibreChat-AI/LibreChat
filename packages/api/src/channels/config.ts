import { channelStorageConfigSchema } from 'librechat-data-provider';
import type { ChannelStorageConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { GetAppConfigOptions } from '~/app/service';

/** Config installs its reader during composition, without a models-to-config import cycle. */
export function createChannelStorageConfigReader(): {
  initialize: (reader: (options?: GetAppConfigOptions) => Promise<AppConfig>) => void;
  getConfig: () => Promise<ChannelStorageConfig>;
} {
  let readConfig: ((options?: GetAppConfigOptions) => Promise<AppConfig>) | undefined;
  return {
    initialize(reader) {
      readConfig = reader;
    },
    async getConfig() {
      if (!readConfig) throw new Error('Channel storage config reader has not been initialized');
      const config = await readConfig({ baseOnly: true });
      return channelStorageConfigSchema.parse(config.endpoints?.agents?.channels ?? {});
    },
  };
}
