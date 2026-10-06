import mongoose from 'mongoose';
import { logger, createModels } from '..';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { PRAutomationStopCode } from 'librechat-data-provider';
import { createPRAutomationMethods } from './prAutomation';

logger.silent = true;

let PRAutomation: mongoose.Model<unknown>;
let methods: ReturnType<typeof createPRAutomationMethods>;
let mongoServer: MongoMemoryServer;

const userId = new mongoose.Types.ObjectId().toString();
const otherUserId = new mongoose.Types.ObjectId().toString();
const key = { userId, conversationId: 'convo-1' };
const limits = { maxRounds: 3, maxMinutes: 60 };
const maxBots = 3;
const head = (n: number) => String(n).repeat(40).slice(0, 40);
const pullOne = { repository: 'acme/one', pullNumber: 1 };
const pullTwo = { repository: 'acme/one', pullNumber: 2 };
const otherRepository = { repository: 'acme/two', pullNumber: 2 };

const mismatch = { ok: false, error: { code: 'binding_mismatch' } };
const enable = (binding = pullOne) => methods.enablePRAutomation({ ...key, binding });
const claim = (n: number, extra: { now?: Date; binding?: typeof pullOne } = {}) =>
  methods.claimPRAutomationRound({
    ...key,
    ...limits,
    binding: pullOne,
    headSha: head(n),
    ...extra,
  });
/** Claims a round that must succeed and returns the record it started. */
const startRound = async (n: number) => {
  const result = await claim(n);
  if (!result.ok) {
    throw new Error(`claim ${n} failed: ${result.error.code}`);
  }
  return result.value;
};
const settle = (round: number, runId: string, state: 'waiting' | 'needs_user' = 'waiting') =>
  methods.settlePRAutomationRound({ ...key, round, runId, state });
/** Test setup that does not depend on the settle method under test. */
const toWaiting = () =>
  PRAutomation.updateOne(
    { user: userId, conversationId: key.conversationId },
    { $set: { state: 'waiting' } },
  );
const addBot = (id: number, login?: string, limit = maxBots, repository = 'acme/one') =>
  methods.addPRAutomationBot(key, login == null ? { id } : { id, login }, limit, repository);
const seedConversation = (fields: Record<string, unknown> = {}) =>
  mongoose.models.Conversation.create({
    conversationId: key.conversationId,
    user: userId,
    endpoint: 'agents',
    ...fields,
  });

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  PRAutomation = mongoose.models.PRAutomation;
  await PRAutomation.syncIndexes();
  methods = createPRAutomationMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await PRAutomation.deleteMany({});
  await mongoose.models.Conversation.deleteMany({});
  await seedConversation();
});

describe('getPRAutomation', () => {
  test('returns null for a conversation that never enabled it', async () => {
    expect(await methods.getPRAutomation(key)).toBeNull();
  });
});

describe('enablePRAutomation', () => {
  test('creates an idle record on the narrowest trust level', async () => {
    const record = await enable();
    expect(record).toMatchObject({
      conversationId: 'convo-1',
      state: 'idle',
      round: 0,
      trust: 'approvedBots',
      trustedBots: [],
    });
  });

  test('is idempotent and keeps one record per user and conversation', async () => {
    await enable();
    await enable();
    expect(await PRAutomation.countDocuments({ user: userId })).toBe(1);
  });

  test('does not change an active record that is enabled again', async () => {
    await enable();
    await claim(1);
    const again = await enable();
    expect(again).toMatchObject({ state: 'fixing', round: 1 });
  });

  test('restarts a stopped record with a fresh round counter and window', async () => {
    await enable();
    await claim(1);
    await methods.stopPRAutomation(key, 'user_stopped');

    const restarted = await enable();
    expect(restarted).toMatchObject({ state: 'idle', round: 0 });
    expect(restarted.stopCode).toBeUndefined();
    expect(restarted.startedAt).toBeUndefined();
    expect(restarted.lastHeadSha).toBeUndefined();
  });

  test('lets a restarted record claim a head it claimed before the stop', async () => {
    await enable();
    await claim(1);
    await methods.stopPRAutomation(key, 'user_stopped');
    await enable();
    expect((await claim(1)).ok).toBe(true);
  });

  test('keeps records of different users apart', async () => {
    await enable();
    expect(await methods.getPRAutomation({ ...key, userId: otherUserId })).toBeNull();
  });

  test('clears approved bots when the conversation is bound to a different repository', async () => {
    await methods.enablePRAutomation({ ...key, binding: pullOne });
    await addBot(101);
    const rebound = await methods.enablePRAutomation({ ...key, binding: otherRepository });
    expect(rebound).toMatchObject({ ...otherRepository, trustedBots: [] });
  });

  test('refuses a bot approved before any repository was bound', async () => {
    await methods.enablePRAutomation(key);
    expect(await addBot(101)).toEqual({ ok: false, error: { code: 'binding_mismatch' } });
    expect((await methods.getPRAutomation(key))?.trustedBots).toEqual([]);
  });

  test('keeps approved bots when the same repository is bound to another pull request', async () => {
    await methods.enablePRAutomation({ ...key, binding: pullOne });
    await addBot(101);
    const rebound = await methods.enablePRAutomation({ ...key, binding: pullTwo });
    expect(rebound).toMatchObject({ pullNumber: 2, trustedBots: [{ id: 101 }] });
  });
});

describe('a record stopped by a deletion fence', () => {
  const deletionCodes = ['conversation_deleting', 'account_deleting'] as const;

  test.each(deletionCodes)(
    'is not revived by enabling the same pull request (%s)',
    async (code) => {
      await enable(pullOne);
      await methods.stopPRAutomation(key, code);
      expect(await enable(pullOne)).toMatchObject({ state: 'stopped', stopCode: code });
    },
  );

  test.each(deletionCodes)(
    'is not revived by another pull request in the repository (%s)',
    async (code) => {
      await enable(pullOne);
      await methods.stopPRAutomation(key, code);
      expect(await enable(pullTwo)).toMatchObject({
        state: 'stopped',
        stopCode: code,
        pullNumber: 1,
      });
    },
  );

  test.each(deletionCodes)('is not revived or rebound to another repository (%s)', async (code) => {
    await enable(pullOne);
    await methods.stopPRAutomation(key, code);
    expect(await enable(otherRepository)).toMatchObject({
      state: 'stopped',
      stopCode: code,
      repository: 'acme/one',
    });
  });

  test.each(deletionCodes)('is not revived without a binding (%s)', async (code) => {
    await enable(pullOne);
    await methods.stopPRAutomation(key, code);
    expect(await methods.enablePRAutomation(key)).toMatchObject({
      state: 'stopped',
      stopCode: code,
    });
  });

  test.each(deletionCodes)('still refuses a claim (%s)', async (code) => {
    await enable(pullOne);
    await methods.stopPRAutomation(key, code);
    await enable(pullOne);
    expect(await claim(1)).toEqual({ ok: false, error: { code: 'not_active' } });
  });

  test.each(deletionCodes)('replaces a user stop when a deletion begins (%s)', async (code) => {
    await enable(pullOne);
    await methods.stopPRAutomation(key, 'user_stopped');
    await methods.stopPRAutomations(userId, code, [key.conversationId]);
    expect(await methods.getPRAutomation(key)).toMatchObject({ state: 'stopped', stopCode: code });
    expect(await enable(pullOne)).toMatchObject({ state: 'stopped', stopCode: code });
  });

  test('keeps a record of another conversation restartable', async () => {
    await enable(pullOne);
    await methods.stopPRAutomation(key, 'user_stopped');
    await methods.stopPRAutomations(userId, 'conversation_deleting', ['another-convo']);
    expect(await methods.getPRAutomation(key)).toMatchObject({ stopCode: 'user_stopped' });
  });

  test('a user stop is still restartable', async () => {
    await enable(pullOne);
    await methods.stopPRAutomation(key, 'user_stopped');
    expect(await enable(pullOne)).toMatchObject({ state: 'idle' });
  });
});

describe('index guarantees', () => {
  test('builds the unique index before the first write when automatic indexing is off', async () => {
    await PRAutomation.collection.dropIndexes();
    const fresh = createPRAutomationMethods(mongoose);
    await fresh.enablePRAutomation({ ...key, binding: pullOne });
    const indexes = await PRAutomation.collection.indexes();
    expect(
      indexes.some(
        (index) => index.unique === true && index.key.user === 1 && index.key.conversationId === 1,
      ),
    ).toBe(true);
  });
});

describe('binding a pull request', () => {
  test('keeps a stopped record fenced when the new binding is rejected', async () => {
    await enable(pullOne);
    await methods.stopPRAutomation(key, 'user_stopped');

    await expect(enable({ repository: 'acme/one', pullNumber: 0 })).rejects.toThrow();

    expect(await methods.getPRAutomation(key)).toMatchObject({
      state: 'stopped',
      stopCode: 'user_stopped',
      pullNumber: 1,
    });
  });

  test('revives a stopped record onto the pull request it is bound to now', async () => {
    await enable(pullOne);
    await methods.stopPRAutomation(key, 'user_stopped');
    expect(await enable(pullTwo)).toMatchObject({ state: 'idle', pullNumber: 2, round: 0 });
  });

  test('starts a fresh run when bound to another pull request in the same repository', async () => {
    await methods.enablePRAutomation({ ...key, binding: pullOne });
    await startRound(1);
    await toWaiting();
    await startRound(2);

    const rebound = await methods.enablePRAutomation({ ...key, binding: pullTwo });
    expect(rebound).toMatchObject({ pullNumber: 2, state: 'idle', round: 0, claimedHeads: [] });
    expect(rebound.startedAt).toBeUndefined();
    expect(rebound.lastHeadSha).toBeUndefined();
  });

  test('lets the new pull request claim a head the old one claimed', async () => {
    await methods.enablePRAutomation({ ...key, binding: pullOne });
    await startRound(1);
    await methods.enablePRAutomation({ ...key, binding: pullTwo });
    expect((await claim(1, { binding: pullTwo })).ok).toBe(true);
  });

  test('does not carry the old pull request round count into the new one', async () => {
    await methods.enablePRAutomation({ ...key, binding: pullOne });
    for (let round = 1; round <= limits.maxRounds; round++) {
      await startRound(round);
      await toWaiting();
    }
    await methods.enablePRAutomation({ ...key, binding: pullTwo });
    expect((await claim(9, { binding: pullTwo })).ok).toBe(true);
  });

  test('ignores a completion from the round of the pull request it replaced', async () => {
    await methods.enablePRAutomation({ ...key, binding: pullOne });
    const running = await startRound(1);
    await methods.enablePRAutomation({ ...key, binding: pullTwo });

    expect(await settle(1, running.runId)).toBeNull();
    expect((await methods.getPRAutomation(key))?.state).toBe('idle');
  });

  test('leaves a run alone when it is bound to the pair it already has', async () => {
    await methods.enablePRAutomation({ ...key, binding: pullOne });
    await startRound(1);
    const again = await methods.enablePRAutomation({ ...key, binding: pullOne });
    expect(again).toMatchObject({ state: 'fixing', round: 1 });
  });

  /** Guard, not a proven regression: the interleaving it protects against is timing dependent. */
  test('never leaves a repository and pull request pair nobody asked for', async () => {
    await enable();
    const pairs = [pullOne, otherRepository];
    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        methods.enablePRAutomation({ ...key, binding: pairs[index % 2] }),
      ),
    );
    const record = await methods.getPRAutomation(key);
    expect(pairs).toContainEqual({
      repository: record?.repository,
      pullNumber: record?.pullNumber,
    });
  });
});

describe('claimPRAutomationRound', () => {
  test('starts a round, counts it and records the head', async () => {
    await enable();
    expect(await claim(1)).toMatchObject({
      ok: true,
      value: { state: 'fixing', round: 1, lastHeadSha: head(1) },
    });
  });

  test('rejects a second delivery for a head that was already claimed', async () => {
    await enable();
    await claim(1);
    await toWaiting();
    expect(await claim(1)).toEqual({ ok: false, error: { code: 'stale_head' } });
    expect((await methods.getPRAutomation(key))?.round).toBe(1);
  });

  test('rejects a delayed delivery of an earlier head after a later head was claimed', async () => {
    await enable();
    await claim(1);
    await toWaiting();
    await claim(2);
    await toWaiting();
    expect(await claim(1)).toEqual({ ok: false, error: { code: 'stale_head' } });
    expect((await methods.getPRAutomation(key))?.round).toBe(2);
  });

  test('rejects a claim while a round is already running', async () => {
    await enable();
    await claim(1);
    expect(await claim(2)).toEqual({ ok: false, error: { code: 'not_active' } });
  });

  test('stops at the round cap and never goes past it', async () => {
    await enable();
    for (let round = 1; round <= limits.maxRounds; round++) {
      expect((await claim(round)).ok).toBe(true);
      await toWaiting();
    }
    expect(await claim(9)).toEqual({ ok: false, error: { code: 'round_cap' } });
    expect((await methods.getPRAutomation(key))?.round).toBe(limits.maxRounds);
  });

  test('lets exactly one of several concurrent deliveries claim the same head', async () => {
    await enable();
    const results = await Promise.all(Array.from({ length: 8 }, () => claim(1)));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect((await methods.getPRAutomation(key))?.round).toBe(1);
  });

  test('never exceeds the cap under concurrent deliveries for different heads', async () => {
    await enable();
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => claim(index + 1)));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect((await methods.getPRAutomation(key))?.round).toBeLessThanOrEqual(limits.maxRounds);
  });

  test('stops once the wall-clock window has passed', async () => {
    await enable();
    const start = new Date('2026-01-01T00:00:00Z');
    await claim(1, { now: start });
    await toWaiting();

    const later = new Date(start.getTime() + (limits.maxMinutes + 1) * 60_000);
    expect(await claim(2, { now: later })).toEqual({ ok: false, error: { code: 'time_cap' } });
  });

  test('reports not_found for a conversation with no record', async () => {
    expect(await claim(1)).toEqual({ ok: false, error: { code: 'not_found' } });
  });

  test('rejects a claim on a stopped record', async () => {
    await enable();
    await methods.stopPRAutomation(key, 'user_stopped');
    expect(await claim(1)).toEqual({ ok: false, error: { code: 'not_active' } });
  });

  test('rejects a delivery for the pull request the record was rebound away from', async () => {
    await enable(pullOne);
    await enable(pullTwo);
    expect(await claim(1, { binding: pullOne })).toEqual(mismatch);
    expect((await methods.getPRAutomation(key))?.round).toBe(0);
  });

  test('rejects a delivery for a repository the record is not bound to', async () => {
    await enable(pullOne);
    expect(await claim(1, { binding: otherRepository })).toEqual(mismatch);
  });

  test('rejects a claim on a record that is bound to no pull request', async () => {
    await methods.enablePRAutomation(key);
    expect(await claim(1)).toEqual(mismatch);
  });

  test('does not open the time window for a delivery it rejected', async () => {
    await enable(pullOne);
    await enable(pullTwo);
    await claim(1, { binding: pullOne });
    expect((await methods.getPRAutomation(key))?.startedAt).toBeUndefined();
  });
});

describe('claiming for a conversation that no longer exists', () => {
  const gone = { ok: false, error: { code: 'conversation_gone' } };

  test('rejects a claim once the conversation was removed by the retention index', async () => {
    await enable();
    await mongoose.models.Conversation.deleteMany({});
    expect(await claim(1)).toEqual(gone);
  });

  test('removes the record so nothing is left to claim later', async () => {
    await enable();
    await mongoose.models.Conversation.deleteMany({});
    await claim(1);
    expect(await methods.getPRAutomation(key)).toBeNull();
  });

  test('rejects a claim for a conversation that expired but is not yet purged', async () => {
    await enable();
    await mongoose.models.Conversation.deleteMany({});
    await seedConversation({ expiredAt: new Date(Date.now() - 60_000) });
    expect(await claim(1)).toEqual(gone);
  });

  test('accepts a claim while the conversation retention date is still ahead', async () => {
    await enable();
    await mongoose.models.Conversation.deleteMany({});
    await seedConversation({ expiredAt: new Date(Date.now() + 3_600_000) });
    expect((await claim(1)).ok).toBe(true);
  });

  test('does not spend a round for a conversation that is gone', async () => {
    await enable();
    await mongoose.models.Conversation.deleteMany({});
    await claim(1);
    await enable();
    await seedConversation();
    expect(await startRound(1)).toMatchObject({ round: 1 });
  });

  test('keeps reporting not_found when there is no record at all', async () => {
    await mongoose.models.Conversation.deleteMany({});
    expect(await claim(1)).toEqual({ ok: false, error: { code: 'not_found' } });
  });

  test('only looks at the conversation of the same owner', async () => {
    await enable();
    await mongoose.models.Conversation.deleteMany({});
    await seedConversation({ user: otherUserId });
    expect(await claim(1)).toEqual(gone);
  });
});

describe('settlePRAutomationRound', () => {
  test('settles the round that owns it, including from needs_user', async () => {
    await enable();
    const { runId } = await startRound(1);
    expect(await settle(1, runId, 'needs_user')).toMatchObject({ state: 'needs_user', round: 1 });
    expect(await settle(1, runId, 'waiting')).toMatchObject({ state: 'waiting', round: 1 });
  });

  test('ignores a completion that belongs to an earlier round', async () => {
    await enable();
    const { runId } = await startRound(1);
    await settle(1, runId);
    await claim(2);

    expect(await settle(1, runId, 'needs_user')).toBeNull();
    expect(await methods.getPRAutomation(key)).toMatchObject({ state: 'fixing', round: 2 });
  });

  test('does not let a stale completion open the way for an overlapping claim', async () => {
    await enable();
    const { runId } = await startRound(1);
    await settle(1, runId);
    await claim(2);
    await settle(1, runId);
    expect(await claim(3)).toEqual({ ok: false, error: { code: 'not_active' } });
  });

  test('ignores a completion from a run that was stopped and restarted', async () => {
    await enable();
    const previous = await startRound(1);
    await methods.stopPRAutomation(key, 'user_stopped');
    await enable();
    await startRound(1);

    expect(await settle(1, previous.runId, 'needs_user')).toBeNull();
    expect(await methods.getPRAutomation(key)).toMatchObject({ state: 'fixing', round: 1 });
  });

  test('ignores a completion from a record that was disabled and enabled again', async () => {
    await enable();
    const previous = await startRound(1);
    await methods.disablePRAutomation(key);
    await enable();
    await startRound(1);

    expect(await settle(1, previous.runId, 'needs_user')).toBeNull();
    expect(await methods.getPRAutomation(key)).toMatchObject({ state: 'fixing', round: 1 });
  });

  test('does not settle a record that never started a round', async () => {
    await enable();
    expect(await settle(0, 'no-run')).toBeNull();
    expect((await methods.getPRAutomation(key))?.state).toBe('idle');
  });

  test('does not revive a stopped record', async () => {
    await enable();
    const { runId } = await startRound(1);
    await methods.stopPRAutomation(key, 'user_stopped');
    expect(await settle(1, runId)).toBeNull();
    expect((await methods.getPRAutomation(key))?.state).toBe('stopped');
  });

  test('returns null for a conversation with no record', async () => {
    expect(await settle(1, 'missing-run')).toBeNull();
  });
});

describe('stopPRAutomation', () => {
  test('records the stop code', async () => {
    await enable();
    expect(await methods.stopPRAutomation(key, 'round_cap')).toMatchObject({
      state: 'stopped',
      stopCode: 'round_cap',
    });
  });

  test('stops a running round without waiting for it to settle', async () => {
    await enable();
    await claim(1);
    expect(await methods.stopPRAutomation(key, 'user_stopped')).toMatchObject({
      state: 'stopped',
      stopCode: 'user_stopped',
    });
  });

  test('keeps the first stop code when it is stopped again', async () => {
    await enable();
    await methods.stopPRAutomation(key, 'round_cap');
    expect(await methods.stopPRAutomation(key, 'user_stopped')).toBeNull();
    expect((await methods.getPRAutomation(key))?.stopCode).toBe('round_cap');
  });

  test('rejects a code outside the stop code list', async () => {
    await enable();
    await expect(
      methods.stopPRAutomation(key, 'because' as unknown as PRAutomationStopCode),
    ).rejects.toThrow();
  });

  test('returns null for a conversation with no record', async () => {
    expect(await methods.stopPRAutomation(key, 'user_stopped')).toBeNull();
  });
});

describe('setPRAutomationTrust', () => {
  test('changes the trust level', async () => {
    await enable();
    const updated = await methods.setPRAutomationTrust(key, 'collaborators');
    expect(updated?.trust).toBe('collaborators');
  });

  test('rejects a level outside the enum', async () => {
    await enable();
    await expect(
      methods.setPRAutomationTrust(key, 'everyone' as unknown as 'anyone'),
    ).rejects.toThrow();
  });
});

describe('approved bots', () => {
  test('adds a bot by numeric id', async () => {
    await enable();
    expect(await addBot(101, 'review-bot[bot]')).toMatchObject({
      ok: true,
      value: { trustedBots: [{ id: 101, login: 'review-bot[bot]' }] },
    });
  });

  test('is idempotent by id even when the login was renamed', async () => {
    await enable();
    await addBot(101, 'old-name[bot]');
    expect((await addBot(101, 'new-name[bot]')).ok).toBe(true);
    const record = await methods.getPRAutomation(key);
    expect(record?.trustedBots).toEqual([{ id: 101, login: 'old-name[bot]' }]);
  });

  test('refuses a bot beyond the limit it is given, with a stable code', async () => {
    await enable();
    for (let id = 1; id <= maxBots; id++) {
      expect({ id, ok: (await addBot(id)).ok }).toEqual({ id, ok: true });
    }
    expect(await addBot(9999)).toEqual({ ok: false, error: { code: 'bot_limit' } });
  });

  test('accepts a bot that is already approved when the list is full', async () => {
    await enable();
    for (let id = 1; id <= maxBots; id++) {
      await addBot(id);
    }
    expect((await addBot(1)).ok).toBe(true);
  });

  test('admits more bots once a higher limit is passed', async () => {
    await enable();
    for (let id = 1; id <= maxBots; id++) {
      await addBot(id);
    }
    expect((await addBot(maxBots + 1, undefined, maxBots + 2)).ok).toBe(true);
  });

  test('rejects a limit below one instead of storing without a cap', async () => {
    await enable();
    await expect(addBot(1, undefined, 0)).rejects.toThrow(RangeError);
  });

  test('reports not_found when the conversation has no record', async () => {
    expect(await addBot(101)).toEqual({ ok: false, error: { code: 'not_found' } });
  });

  test('refuses a bot approved for a repository the record is not bound to', async () => {
    await enable(pullOne);
    expect(await addBot(101, undefined, maxBots, 'acme/two')).toEqual({
      ok: false,
      error: { code: 'binding_mismatch' },
    });
    expect((await methods.getPRAutomation(key))?.trustedBots).toEqual([]);
  });

  test('refuses an approval that was authorized before the record was rebound', async () => {
    await enable(pullOne);
    await enable(otherRepository);
    expect(await addBot(101, undefined, maxBots, 'acme/one')).toEqual({
      ok: false,
      error: { code: 'binding_mismatch' },
    });
    expect((await methods.getPRAutomation(key))?.trustedBots).toEqual([]);
  });

  test('still treats an already approved bot as success for the bound repository', async () => {
    await enable(pullOne);
    await addBot(101);
    expect((await addBot(101)).ok).toBe(true);
  });

  test('removes a bot by id and leaves the others', async () => {
    await enable();
    await addBot(1);
    await addBot(2);
    const record = await methods.removePRAutomationBot(key, 1);
    expect(record?.trustedBots).toEqual([{ id: 2 }]);
  });

  test('keeps each conversation allowlist separate', async () => {
    await enable();
    await methods.enablePRAutomation({ userId, conversationId: 'convo-2' });
    await addBot(101);
    const other = await methods.getPRAutomation({ userId, conversationId: 'convo-2' });
    expect(other?.trustedBots).toEqual([]);
  });
});

describe('disablePRAutomation', () => {
  test('removes the record and reports it', async () => {
    await enable();
    expect(await methods.disablePRAutomation(key)).toEqual({ removed: true });
    expect(await methods.getPRAutomation(key)).toBeNull();
  });

  test('reports nothing removed when there was no record', async () => {
    expect(await methods.disablePRAutomation(key)).toEqual({ removed: false });
  });
});
