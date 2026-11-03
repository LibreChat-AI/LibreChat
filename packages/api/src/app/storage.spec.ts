import type { AppConfig } from '@librechat/data-schemas';
import { createStorageConfigReader } from './storage';

it('fails closed until the configuration service installs its reader', async () => {
  await expect(createStorageConfigReader().getChannelConfig()).rejects.toThrow(
    'not been initialized',
  );
});

it('reads live base deployment bounds at each operation boundary', async () => {
  const config = { endpoints: { agents: { channels: { erasureBatchSize: 2 } } } };
  const read = jest.fn(async () => config as AppConfig);
  const effective = createStorageConfigReader();
  effective.initialize(read);
  expect(await effective.getChannelConfig()).toMatchObject({
    erasureBatchSize: 2,
    claimBatchSize: 25,
  });
  config.endpoints.agents.channels.erasureBatchSize = 3;
  expect((await effective.getChannelConfig()).erasureBatchSize).toBe(3);
  expect(read).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenLastCalledWith({ baseOnly: true });
  effective.initialize(async () => ({}) as AppConfig);
  expect((await effective.getChannelConfig()).erasureBatchSize).toBe(250);
});

it('rejects invalid bounds and propagates config outages', async () => {
  const effective = createStorageConfigReader();
  effective.initialize(
    async () => ({ endpoints: { agents: { channels: { erasureBatchSize: 0 } } } }) as AppConfig,
  );
  await expect(effective.getChannelConfig()).rejects.toThrow();
  const failure = new Error('config unavailable');
  effective.initialize(async () => {
    throw failure;
  });
  await expect(effective.getChannelConfig()).rejects.toBe(failure);
});

it('reads live deployment-wide durable capacity with schema defaults', async () => {
  const config = { durableStorage: { maxPendingTargetsPerScope: 2 } };
  const read = jest.fn(async () => config as AppConfig);
  const effective = createStorageConfigReader();
  await expect(effective.getDurableConfig()).rejects.toThrow('not been initialized');
  effective.initialize(read);
  expect(await effective.getDurableConfig()).toEqual({ maxPendingTargetsPerScope: 2 });
  config.durableStorage.maxPendingTargetsPerScope = 3;
  expect((await effective.getDurableConfig()).maxPendingTargetsPerScope).toBe(3);
  expect(read).toHaveBeenLastCalledWith({ baseOnly: true });
  effective.initialize(async () => ({}) as AppConfig);
  expect(await effective.getDurableConfig()).toEqual({ maxPendingTargetsPerScope: 256 });
});

it('rejects invalid durable bounds and propagates config outages', async () => {
  const effective = createStorageConfigReader();
  effective.initialize(
    async () => ({ durableStorage: { maxPendingTargetsPerScope: 0 } }) as AppConfig,
  );
  await expect(effective.getDurableConfig()).rejects.toThrow();
  const failure = new Error('base config unavailable');
  effective.initialize(async () => {
    throw failure;
  });
  await expect(effective.getDurableConfig()).rejects.toBe(failure);
});
