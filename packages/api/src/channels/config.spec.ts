import { createChannelStorageConfigReader } from './config';

it('reads base deployment bounds at the operation boundary with existing defaults', async () => {
  const config = { endpoints: { agents: { channels: { erasureBatchSize: 2 } } } };
  const read = jest.fn(async () => config);
  const effective = createChannelStorageConfigReader(read);
  expect(await effective()).toMatchObject({ erasureBatchSize: 2, claimBatchSize: 25 });
  config.endpoints.agents.channels.erasureBatchSize = 3;
  expect((await effective()).erasureBatchSize).toBe(3);
  expect(read).toHaveBeenCalledTimes(2);
  expect((await createChannelStorageConfigReader(async () => ({}))()).erasureBatchSize).toBe(250);
});

it('rejects invalid bounds and propagates config outages', async () => {
  await expect(
    createChannelStorageConfigReader(async () => ({
      endpoints: { agents: { channels: { erasureBatchSize: 0 } } },
    }))(),
  ).rejects.toThrow();
  const failure = new Error('config unavailable');
  await expect(
    createChannelStorageConfigReader(async () => {
      throw failure;
    })(),
  ).rejects.toBe(failure);
});
