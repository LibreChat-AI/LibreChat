import { waitForPause } from './test-helpers';

it('reaches a pause without waiting for the blocked operation', async () => {
  await expect(
    waitForPause(Promise.resolve(), new Promise<void>(() => undefined)),
  ).resolves.toBeUndefined();
});

it('rejects an operation that completes without reaching its pause', async () => {
  await expect(
    waitForPause(new Promise<void>(() => undefined), Promise.resolve('finished')),
  ).rejects.toThrow('Operation completed before reaching its pause');
});

it('preserves an operation failure before its pause', async () => {
  const failure = new Error('write failed');
  await expect(
    waitForPause(new Promise<void>(() => undefined), Promise.reject(failure)),
  ).rejects.toBe(failure);
});

it('observes a late operation failure after its pause was reached', async () => {
  let fail!: (reason: Error) => void;
  const operation = new Promise<void>((_resolve, reject) => {
    fail = reject;
  });
  await expect(waitForPause(Promise.resolve(), operation)).resolves.toBeUndefined();
  fail(new Error('late write failure'));
  await new Promise<void>((resolve) => setImmediate(resolve));
});
