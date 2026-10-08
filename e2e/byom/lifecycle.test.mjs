import assert from 'node:assert/strict';
import test from 'node:test';
import { createLifecycle } from './lifecycle.mjs';

test('shutdown drains acquisition paused before spawn or Mongo startup completes', async () => {
  const lifecycle = createLifecycle();
  const gate = Promise.withResolvers();
  const released = [];
  const acquisition = lifecycle.acquire(
    () => gate.promise,
    (value) => released.push(value),
  );
  const stopped = lifecycle.stop();
  let finished = false;
  void stopped.then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  gate.resolve('late resource');
  await acquisition;
  await stopped;
  assert.deepEqual(released, ['late resource']);
  assert.equal(lifecycle.stop(), stopped);
});

test('shutdown rejects later launches without invoking their factory', async () => {
  const lifecycle = createLifecycle();
  await lifecycle.stop();
  await assert.rejects(
    lifecycle.acquire(
      () => assert.fail('must not spawn'),
      () => {},
    ),
    /shutdown/,
  );
});

test('failed acquisition and cleanup do not skip remaining resources', async () => {
  const lifecycle = createLifecycle();
  const released = [];
  await lifecycle.acquire(
    () => 'first',
    (value) => released.push(value),
  );
  await lifecycle.acquire(
    () => 'second',
    () => {
      throw new Error('cleanup');
    },
  );
  await assert.rejects(
    lifecycle.acquire(
      () => {
        throw new Error('startup');
      },
      () => {},
    ),
  );
  await assert.rejects(lifecycle.stop(), AggregateError);
  assert.deepEqual(released, ['first']);
});
