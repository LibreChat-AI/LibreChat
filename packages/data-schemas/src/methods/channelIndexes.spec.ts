import { createChannelIndexGate } from './channelIndexes';

it('serializes required index builds and shares the readiness promise across concurrent admissions', async () => {
  const order: string[] = [];
  const first = {
    modelName: 'First',
    createIndexes: jest.fn(async () => {
      order.push('first');
    }),
  };
  const second = {
    modelName: 'Second',
    createIndexes: jest.fn(async () => {
      order.push('second');
    }),
  };
  const ready = createChannelIndexGate(() => [first, second]);
  await Promise.all([ready(), ready(), ready()]);
  await ready();
  expect(order).toEqual(['first', 'second']);
  expect(first.createIndexes).toHaveBeenCalledTimes(1);
  expect(second.createIndexes).toHaveBeenCalledTimes(1);
});

it('fails closed on index failure and permits a later readiness retry', async () => {
  const model = {
    modelName: 'ChannelRun',
    createIndexes: jest
      .fn()
      .mockRejectedValueOnce(new Error('index rejected'))
      .mockResolvedValue(undefined),
  };
  const ready = createChannelIndexGate(() => [model]);
  await expect(ready()).rejects.toThrow('index rejected');
  await expect(ready()).resolves.toBeUndefined();
  expect(model.createIndexes).toHaveBeenCalledTimes(2);
});
