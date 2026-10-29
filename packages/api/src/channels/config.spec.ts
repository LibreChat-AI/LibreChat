import type { AppConfig } from '@librechat/data-schemas';
import { createChannelStorageConfigReader } from './config';

it('fails closed until the configuration service installs its reader', async () => {
  await expect(createChannelStorageConfigReader().getConfig()).rejects.toThrow(
    'not been initialized',
  );
});

it('reads live base deployment bounds at each operation boundary', async () => {
  const config = { endpoints: { agents: { channels: { erasureBatchSize: 2 } } } };
  const read = jest.fn(async () => config as AppConfig);
  const effective = createChannelStorageConfigReader();
  effective.initialize(read);
  expect(await effective.getConfig()).toMatchObject({ erasureBatchSize: 2, claimBatchSize: 25 });
  config.endpoints.agents.channels.erasureBatchSize = 3;
  expect((await effective.getConfig()).erasureBatchSize).toBe(3);
  expect(read).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenLastCalledWith({ baseOnly: true });
  effective.initialize(async () => ({}) as AppConfig);
  expect((await effective.getConfig()).erasureBatchSize).toBe(250);
});

it('rejects invalid bounds and propagates config outages', async () => {
  const effective = createChannelStorageConfigReader();
  effective.initialize(
    async () => ({ endpoints: { agents: { channels: { erasureBatchSize: 0 } } } }) as AppConfig,
  );
  await expect(effective.getConfig()).rejects.toThrow();
  const failure = new Error('config unavailable');
  effective.initialize(async () => {
    throw failure;
  });
  await expect(effective.getConfig()).rejects.toBe(failure);
});
