import { createCheckpointWriteWitness } from './witness';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it('requires durable uncertainty before allowing concurrent commands and settles once', async () => {
  const opened = barrier();
  const storage = { open: jest.fn(() => opened.promise), settle: jest.fn(async () => {}) };
  const witness = createCheckpointWriteWitness(storage);
  const commands = [jest.fn(async () => 'first'), jest.fn(async () => 'second')];
  const writes = commands.map((operation) => witness.track(operation));
  await Promise.resolve();
  expect(storage.open).toHaveBeenCalledTimes(1);
  for (const command of commands) expect(command).not.toHaveBeenCalled();
  opened.release();
  expect(await Promise.all(writes)).toEqual(['first', 'second']);
  expect(await Promise.all([witness.close(), witness.close()])).toEqual(['settled', 'settled']);
  expect(storage.settle).toHaveBeenCalledTimes(1);
});

it('retains uncertainty and waits for a delayed sibling after the first command rejects', async () => {
  const delayed = barrier();
  const storage = { open: jest.fn(async () => {}), settle: jest.fn(async () => {}) };
  const witness = createCheckpointWriteWitness(storage);
  const failed = witness.track(async () => {
    throw new Error('acknowledgment lost');
  });
  const sibling = witness.track(() => delayed.promise);
  await expect(failed).rejects.toThrow('acknowledgment lost');
  let closed = false;
  const closing = witness.close().then((result) => {
    closed = true;
    return result;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(storage.settle).not.toHaveBeenCalled();
  delayed.release();
  await sibling;
  expect(await closing).toBe('unknown');
  expect(await witness.close()).toBe('unknown');
  expect(storage.settle).not.toHaveBeenCalled();
});

it('refuses a late command before any storage work can begin', async () => {
  const storage = { open: jest.fn(async () => {}), settle: jest.fn(async () => {}) };
  const witness = createCheckpointWriteWitness(storage);
  expect(await witness.close()).toBe('settled');
  const command = jest.fn(async () => {});
  await expect(witness.track(command)).rejects.toThrow('Checkpoint writer is closed');
  expect(command).not.toHaveBeenCalled();
  expect(storage.open).not.toHaveBeenCalled();
  expect(storage.settle).not.toHaveBeenCalled();
});

it('never authorizes a command after an ambiguous root-marker acknowledgment', async () => {
  const storage = {
    open: jest.fn(async () => {
      throw new Error('marker acknowledgment lost');
    }),
    settle: jest.fn(async () => {}),
  };
  const witness = createCheckpointWriteWitness(storage);
  const command = jest.fn(async () => {});
  await expect(witness.track(command)).rejects.toThrow('marker acknowledgment lost');
  expect(command).not.toHaveBeenCalled();
  expect(await witness.close()).toBe('unknown');
  expect(storage.settle).not.toHaveBeenCalled();
});

it('propagates a failed settlement without retrying or clearing the durable marker', async () => {
  const storage = {
    open: jest.fn(async () => {}),
    settle: jest.fn(async () => {
      throw new Error('root retired');
    }),
  };
  const witness = createCheckpointWriteWitness(storage);
  await witness.track(async () => {});
  await expect(witness.close()).rejects.toThrow('root retired');
  await expect(witness.close()).rejects.toThrow('root retired');
  expect(storage.settle).toHaveBeenCalledTimes(1);
});
