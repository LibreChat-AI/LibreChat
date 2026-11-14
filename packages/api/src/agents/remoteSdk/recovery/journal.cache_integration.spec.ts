import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { RedisTestClient } from '../../../stream/__tests__/helpers/redis';
import type { RuntimeJournalResult, RuntimeJournalLease } from './journal';
import {
  createRedisTestClient,
  clearRedisTestPrefix,
} from '../../../stream/__tests__/helpers/redis';
import { createRedisRuntimeJournal } from './redis';

function value<T>(result: RuntimeJournalResult<T>): T {
  if (!result.ok) throw new Error(`Unexpected journal result: ${result.error.code}`);
  return result.value;
}
const prefix = `Sdk-Journal-Test-${randomUUID()}`;
const limits = {
  prefix,
  retentionMs: 10000,
  leaseMs: 2000,
  maxFrames: 20,
  maxBytes: 2048,
  maxBatchFrames: 10,
  maxBatchBytes: 1024,
};
const session = () => ({ sessionId: randomUUID(), scope: 'a'.repeat(64) });
let redis: RedisTestClient;
beforeAll(async () => {
  redis = createRedisTestClient('');
  await redis.ping();
});
afterAll(async () => {
  await clearRedisTestPrefix(redis, prefix);
  await redis.quit();
});

describe('persistent runtime journal', () => {
  it('replays exact frames through another client instance and retains acknowledged history', async () => {
    const journal = createRedisRuntimeJournal(redis, limits);
    const id = session();
    const lease = value(await journal.create(id, randomUUID()));
    expect(value(await journal.markStarted(id, lease))).toEqual({ first: true });
    const payloads = ['{"large":9007199254740993,"empty":[]}', 'line 1\nline 2 🙂'];
    const batch = randomUUID();
    expect(value(await journal.append(id, lease, batch, payloads))).toEqual({ first: 1, last: 2 });
    const next = createRedisRuntimeJournal(redis, limits);
    expect(value(await next.read(id, 0, 10)).frames).toEqual(
      payloads.map((payload, index) => ({ sequence: index + 1, payload })),
    );
    expect(value(await next.acknowledge(id, lease, 2))).toEqual({ acknowledged: 2 });
    expect(value(await next.acknowledge(id, lease, 1))).toEqual({ acknowledged: 2 });
    expect(value(await next.read(id, 0, 1)).frames).toEqual([
      { sequence: 1, payload: payloads[0] },
    ]);
    expect(value(await next.read(id, 1, 10)).frames).toEqual([
      { sequence: 2, payload: payloads[1] },
    ]);
    expect(value(await next.append(id, lease, batch, payloads))).toEqual({ first: 1, last: 2 });
    expect(value(await next.read(id, 0, 10)).head).toBe(2);
  });
  it('allocates contiguous sequence numbers atomically across competing writers', async () => {
    const a = createRedisRuntimeJournal(redis, limits);
    const b = createRedisRuntimeJournal(redis, limits);
    const id = session();
    const lease = value(await a.create(id, randomUUID()));
    const writes = await Promise.all([
      a.append(id, lease, randomUUID(), ['one']),
      b.append(id, lease, randomUUID(), ['two']),
    ]);
    expect(writes.map((r) => value(r).first).sort()).toEqual([1, 2]);
    expect(value(await a.read(id, 0, 10)).frames.map((f) => f.sequence)).toEqual([1, 2]);
  });
  it('rejects changed payloads under an existing batch identity without modifying history', async () => {
    const journal = createRedisRuntimeJournal(redis, limits);
    const id = session();
    const lease = value(await journal.create(id, randomUUID()));
    const batch = randomUUID();
    value(await journal.append(id, lease, batch, ['one']));
    expect(await journal.append(id, lease, batch, ['different'])).toEqual({
      ok: false,
      error: { code: 'batch_conflict' },
    });
    expect(value(await journal.read(id, 0, 10)).head).toBe(1);
  });
  it('binds reads and writes to identity and fences stale execution owners after takeover', async () => {
    const journal = createRedisRuntimeJournal(redis, { ...limits, leaseMs: 300 });
    const id = session();
    const old = value(await journal.create(id, randomUUID()));
    value(await journal.markStarted(id, old));
    expect(await journal.read({ ...id, scope: 'b'.repeat(64) }, 0, 1)).toEqual({
      ok: false,
      error: { code: 'scope_mismatch' },
    });
    expect(await journal.claim(id, randomUUID())).toEqual({ ok: false, error: { code: 'fenced' } });
    await delay(350);
    const replacement = value(await journal.claim(id, randomUUID()));
    expect(replacement.epoch).toBe(old.epoch + 1);
    expect(replacement.started).toBe(true);
    expect(value(await journal.markStarted(id, replacement))).toEqual({ first: false });
    expect(await journal.append(id, old, randomUUID(), ['stale'])).toEqual({
      ok: false,
      error: { code: 'fenced' },
    });
    value(await journal.append(id, replacement, randomUUID(), ['current']));
  });
  it('refuses overflow and ahead cursors without allocating a gap or losing earlier frames', async () => {
    const journal = createRedisRuntimeJournal(redis, {
      ...limits,
      maxFrames: 2,
      maxBatchFrames: 2,
    });
    const id = session();
    const lease: RuntimeJournalLease = value(await journal.create(id, randomUUID()));
    value(await journal.append(id, lease, randomUUID(), ['one', 'two']));
    expect(await journal.append(id, lease, randomUUID(), ['three'])).toEqual({
      ok: false,
      error: { code: 'limit' },
    });
    expect(await journal.acknowledge(id, lease, 3)).toEqual({
      ok: false,
      error: { code: 'cursor_ahead' },
    });
    expect(await journal.read(id, 3, 1)).toEqual({ ok: false, error: { code: 'cursor_ahead' } });
    expect(value(await journal.read(id, 0, 2)).frames).toHaveLength(2);
  });
  it('expires session metadata, frames, and retry receipts together', async () => {
    const journal = createRedisRuntimeJournal(redis, { ...limits, retentionMs: 150, leaseMs: 100 });
    const id = session();
    const lease = value(await journal.create(id, randomUUID()));
    value(await journal.append(id, lease, randomUUID(), ['expiring']));
    await delay(200);
    expect(await journal.read(id, 0, 1)).toEqual({ ok: false, error: { code: 'missing' } });
    expect(
      await redis.exists(
        ...['meta', 'frames', 'receipts'].map((suffix) => `${prefix}:{${id.sessionId}}:${suffix}`),
      ),
    ).toBe(0);
  });
  it('enforces UTF-8 payload budgets before mutation and renews only live owner leases', async () => {
    const journal = createRedisRuntimeJournal(redis, { ...limits, maxBytes: 4, maxBatchBytes: 4 });
    const id = session();
    const lease = value(await journal.create(id, randomUUID()));
    value(await journal.renew(id, lease));
    value(await journal.append(id, lease, randomUUID(), ['🙂']));
    expect(await journal.append(id, lease, randomUUID(), ['a'])).toEqual({
      ok: false,
      error: { code: 'limit' },
    });
    expect(value(await journal.read(id, 0, 1)).head).toBe(1);
  });
  it('purges an authorized session atomically and prevents an old lease from recreating data', async () => {
    const journal = createRedisRuntimeJournal(redis, limits);
    const id = session();
    const lease = value(await journal.create(id, randomUUID()));
    value(await journal.append(id, lease, randomUUID(), ['private frame']));
    expect(await journal.purge({ ...id, scope: 'b'.repeat(64) })).toEqual({
      ok: false,
      error: { code: 'scope_mismatch' },
    });
    value(await journal.purge(id));
    expect(await journal.read(id, 0, 1)).toEqual({ ok: false, error: { code: 'missing' } });
    expect(await journal.append(id, lease, randomUUID(), ['late private frame'])).toEqual({
      ok: false,
      error: { code: 'missing' },
    });
    expect(
      await redis.exists(
        ...['meta', 'frames', 'receipts'].map((suffix) => `${prefix}:{${id.sessionId}}:${suffix}`),
      ),
    ).toBe(0);
  });
  it('seals the exact committed frontier while leaving terminal output replayable', async () => {
    const journal = createRedisRuntimeJournal(redis, limits);
    const id = session();
    const lease = value(await journal.create(id, randomUUID()));
    value(await journal.append(id, lease, randomUUID(), ['done']));
    expect(await journal.finish(id, lease, 'completed', 0)).toEqual({
      ok: false,
      error: { code: 'cursor_ahead' },
    });
    value(await journal.finish(id, lease, 'completed', 1));
    expect(await journal.append(id, lease, randomUUID(), ['late'])).toEqual({
      ok: false,
      error: { code: 'closed' },
    });
    expect(await journal.claim(id, randomUUID())).toEqual({ ok: false, error: { code: 'closed' } });
    expect(value(await journal.read(id, 0, 10))).toMatchObject({
      state: 'completed',
      head: 1,
      frames: [{ sequence: 1, payload: 'done' }],
    });
  });
});
