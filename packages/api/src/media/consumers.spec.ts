import Keyv from 'keyv';
import { FileSources, resolveMediaConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { createMediaConsumerConfigProvider } from './consumers';
import { BASE_CONFIG_KEY } from '~/app/service';

test('consumer policy follows the loaded config and survives the refresh gap without database reads', async () => {
  const cache = new Keyv();
  const getConfig = createMediaConsumerConfigProvider(() => cache);
  await expect(getConfig()).rejects.toThrow('has not been loaded');
  const config: AppConfig = {
    config: {},
    fileStrategy: FileSources.local,
    imageOutputType: 'png',
    media: resolveMediaConfig({ limits: { maxAssetRetainers: 8, consumerClaimMs: 120_000 } }),
  };
  await cache.set(BASE_CONFIG_KEY, config);
  await expect(getConfig()).resolves.toMatchObject({
    maxAssetRetainers: 8,
    consumerClaimMs: 120_000,
  });
  await cache.delete(BASE_CONFIG_KEY);
  await expect(getConfig()).resolves.toMatchObject({ maxAssetRetainers: 8 });
  await cache.set(BASE_CONFIG_KEY, {
    ...config,
    media: resolveMediaConfig({ limits: { maxAssetRetainers: 12 } }),
  });
  await expect(getConfig()).resolves.toMatchObject({ maxAssetRetainers: 12 });
});
