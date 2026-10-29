import { channelStorageConfigSchema } from 'librechat-data-provider';
import type { ChannelStorageConfig } from 'librechat-data-provider';

/** Resolve deployment storage settings at the operation boundary, never from user overrides. */
export function createChannelStorageConfigReader(
  readBaseConfig: () => Promise<{
    endpoints?: { agents?: { channels?: Partial<ChannelStorageConfig> } };
  }>,
): () => Promise<ChannelStorageConfig> {
  return async () =>
    channelStorageConfigSchema.parse((await readBaseConfig()).endpoints?.agents?.channels ?? {});
}
