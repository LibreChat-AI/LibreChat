import { CacheKeys } from 'librechat-data-provider';
import { getMediaConfig } from '@librechat/data-schemas';
import type { AppConfig, MediaConsumerConfig } from '@librechat/data-schemas';
import { BASE_CONFIG_KEY } from '~/app/service';

interface ConfigCache {
  get<T>(key: string): Promise<T | undefined>;
}

/** Reads the already loaded base policy without a model/config-service dependency cycle. */
export function createMediaConsumerConfigProvider(
  getCache: (key: string) => ConfigCache,
): () => Promise<MediaConsumerConfig> {
  let lastConfig: MediaConsumerConfig | undefined;
  return async (): Promise<MediaConsumerConfig> => {
    const appConfig = await getCache(CacheKeys.APP_CONFIG).get<AppConfig>(BASE_CONFIG_KEY);
    if (appConfig) {
      const { maxAssetRetainers, consumerClaimMs, consumerReconcileMs } =
        getMediaConfig(appConfig).limits;
      lastConfig = { maxAssetRetainers, consumerClaimMs, consumerReconcileMs };
    }
    if (!lastConfig) throw new Error('Media consumer policy has not been loaded.');
    return lastConfig;
  };
}
