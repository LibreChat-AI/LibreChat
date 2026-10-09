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
  await mongoose.models.User.deleteMany({});
  await mongoose.models.User.create({ _id: userId, email: 'owner@example.com', provider: 'local' });
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

describe('claiming while the owner is being deleted', () => {
  const startAccountDeletion = () =>
    mongoose.models.User.updateOne(
      { _id: userId },
      { $set: { agentTriggerDeletionStartedAt: new Date() } },
    );

  test('refuses a claim once account deletion has started', async () => {
    await enable(pullOne);
    await startAccountDeletion();
    expect(await claim(1)).toEqual({ ok: false, error: { code: 'owner_inactive' } });
  });

  test('keeps the record and spends no round, so a cancelled deletion leaves it as it was', async () => {
    await enable(pullOne);
    await startAccountDeletion();
    await claim(1);
    expect(await methods.getPRAutomation(key)).toMatchObject({ state: 'idle', round: 0 });
  });

  test('refuses a claim for an owner that no longer exists', async () => {
    await enable(pullOne);
    await mongoose.models.User.deleteMany({});
    expect(await claim(1)).toEqual({ ok: false, error: { code: 'owner_inactive' } });
  });

  test('claims again once the deletion was cancelled', async () => {
    await enable(pullOne);
    await startAccountDeletion();
    await claim(1);
    await mongoose.models.User.updateOne(
      { _id: userId },
      { $unset: { agentTriggerDeletionStartedAt: 1 } },
    );
    expect((await claim(1)).ok).toBe(true);
  });
});

describe('a deletion that lands while a claim is in flight', () => {
  /** Runs `during` right after the claim's atomic write, before the claim checks again. */
  const interleave = (during: () => Promise<unknown>) => {
    const original = PRAutomation.findOneAndUpdate.bind(PRAutomation);
    return jest.spyOn(PRAutomation, 'findOneAndUpdate').mockImplementationOnce(((
      ...args: Parameters<typeof PRAutomation.findOneAndUpdate>
    ) => {
      const query = original(...args);
      const lean = query.lean.bind(query);
      query.lean = ((...leanArgs: Parameters<typeof query.lean>) => {
        const result = lean(...leanArgs);
        return {
          ...result,
          then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
            result
              .then(async (value: unknown) => {
                await during();
                return value;
              })
              .then(resolve, reject),
        };
      }) as typeof query.lean;
      return query;
    }) as typeof PRAutomation.findOneAndUpdate);
  };

  test('does not hand out a round for a conversation deleted after the first check', async () => {
    await enable(pullOne);
    const spy = interleave(() => mongoose.models.Conversation.deleteMany({}));
    try {
      expect(await claim(1)).toEqual({ ok: false, error: { code: 'conversation_gone' } });
    } finally {
      spy.mockRestore();
    }
  });

  test('does not hand out a round once account deletion started after the first check', async () => {
    await enable(pullOne);
    const spy = interleave(() =>
      mongoose.models.User.updateOne(
        { _id: userId },
        { $set: { agentTriggerDeletionStartedAt: new Date() } },
      ),
    );
    try {
      expect(await claim(1)).toEqual({ ok: false, error: { code: 'owner_inactive' } });
    } finally {
      spy.mockRestore();
    }
  });

  test('leaves no round running when the owner deletion started mid-claim', async () => {
    await enable(pullOne);
    const spy = interleave(() =>
      mongoose.models.User.updateOne(
        { _id: userId },
        { $set: { agentTriggerDeletionStartedAt: new Date() } },
      ),
    );
    try {
      await claim(1);
    } finally {
      spy.mockRestore();
    }
    expect((await methods.getPRAutomation(key))?.state).toBe('waiting');
  });
});

describe('removing records in bulk', () => {
  test('removes every listed conversation, across more than one batch', async () => {
    const ids = Array.from({ length: 2500 }, (_, index) => `convo-${index}`);
    await PRAutomation.insertMany(ids.map((conversationId) => ({ user: userId, conversationId })));
    await methods.deletePRAutomations(userId, ids);
    expect(await PRAutomation.countDocuments({ user: userId })).toBe(0);
  });

  test('bounds each write instead of sending one unbounded list', async () => {
    const ids = Array.from({ length: 2500 }, (_, index) => `convo-${index}`);
    const spy = jest.spyOn(PRAutomation, 'deleteMany');
    try {
      await methods.deletePRAutomations(userId, ids);
      const sizes = spy.mock.calls.map(
        ([filter]) => (filter as { conversationId: { $in: string[] } }).conversationId.$in.length,
      );
      expect(Math.max(...sizes)).toBeLessThanOrEqual(1000);
    } finally {
      spy.mockRestore();
    }
  });

  test('leaves other users alone', async () => {
    await PRAutomation.create({ user: 'someone-else', conversationId: 'convo-1' });
    await methods.deletePRAutomations(userId, ['convo-1']);
    expect(await PRAutomation.countDocuments({ user: 'someone-else' })).toBe(1);
  });
});

describe('claiming for a subagent thread whose root conversation is gone', () => {
  const childKey = { userId, conversationId: 'child-1' };
  const seedChild = () =>
    mongoose.models.Conversation.create({
      conversationId: childKey.conversationId,
      user: userId,
      endpoint: 'agents',
      subagentThread: {
        rootConversationId: key.conversationId,
        parentConversationId: key.conversationId,
        parentMessageId: 'message-1',
        parentToolCallId: 'call-1',
        subagentType: 'agent-child',
        subagentKind: 'agent',
        depth: 1,
      },
    });
  const claimChild = () =>
    methods.claimPRAutomationRound({
      ...childKey,
      ...limits,
      binding: pullOne,
      headSha: head(1),
    });

  test('rejects a claim for a child once its root was deleted', async () => {
    await seedChild();
    await methods.enablePRAutomation({ ...childKey, binding: pullOne });
    await mongoose.models.Conversation.deleteOne({ conversationId: key.conversationId });
    expect(await claimChild()).toEqual({ ok: false, error: { code: 'conversation_gone' } });
  });

  test('removes the child record so nothing is left to claim later', async () => {
    await seedChild();
    await methods.enablePRAutomation({ ...childKey, binding: pullOne });
    await mongoose.models.Conversation.deleteOne({ conversationId: key.conversationId });
    await claimChild();
    expect(await methods.getPRAutomation(childKey)).toBeNull();
  });

  test('rejects a claim for a child whose root passed its retention date', async () => {
    await seedChild();
    await methods.enablePRAutomation({ ...childKey, binding: pullOne });
    await mongoose.models.Conversation.updateOne(
      { conversationId: key.conversationId },
      { $set: { expiredAt: new Date(Date.now() - 60_000) } },
    );
    expect(await claimChild()).toEqual({ ok: false, error: { code: 'conversation_gone' } });
  });

  test('rejects a claim for a grandchild once its parent was deleted but its root remains', async () => {
    await seedChild();
    await mongoose.models.Conversation.create({
      conversationId: 'grandchild-1',
      user: userId,
      endpoint: 'agents',
      subagentThread: {
        rootConversationId: key.conversationId,
        parentConversationId: childKey.conversationId,
        parentMessageId: 'message-2',
        parentToolCallId: 'call-2',
        subagentType: 'agent-child',
        subagentKind: 'agent',
        depth: 2,
      },
    });
    const grandKey = { userId, conversationId: 'grandchild-1' };
    await methods.enablePRAutomation({ ...grandKey, binding: pullOne });
    await mongoose.models.Conversation.deleteOne({ conversationId: childKey.conversationId });
    expect(
      await methods.claimPRAutomationRound({
        ...grandKey,
        ...limits,
        binding: pullOne,
        headSha: head(1),
      }),
    ).toEqual({ ok: false, error: { code: 'conversation_gone' } });
  });

  test('accepts a claim for a child while its root is active', async () => {
    await seedChild();
    await methods.enablePRAutomation({ ...childKey, binding: pullOne });
    expect((await claimChild()).ok).toBe(true);
  });
});

describe('pull request numbers', () => {
  test.each([1.5, 0.5, 2.0000001])('rejects %s as a pull request number', async (pullNumber) => {
    await expect(enable({ repository: 'acme/one', pullNumber })).rejects.toThrow();
    expect(await methods.getPRAutomation(key)).toBeNull();
  });

  test('still accepts a whole pull request number', async () => {
    expect(await enable({ repository: 'acme/one', pullNumber: 42 })).toMatchObject({
      pullNumber: 42,
    });
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

  test('does not open the time window when the claim is refused', async () => {
    await enable(pullOne);
    const refused = await methods.claimPRAutomationRound({
      ...key,
      binding: pullOne,
      maxRounds: 0,
      maxMinutes: limits.maxMinutes,
      headSha: head(1),
    });
    expect(refused).toEqual({ ok: false, error: { code: 'round_cap' } });
    expect((await methods.getPRAutomation(key))?.startedAt).toBeUndefined();
  });

  test('opens the time window with the first round that is claimed', async () => {
    await enable(pullOne);
    const start = new Date('2026-01-01T00:00:00Z');
    await claim(1, { now: start });
    expect((await methods.getPRAutomation(key))?.startedAt).toEqual(start);
  });

  test('keeps the first start when a later round is claimed', async () => {
    await enable(pullOne);
    const start = new Date('2026-01-01T00:00:00Z');
    await claim(1, { now: start });
    await toWaiting();
    await claim(2, { now: new Date(start.getTime() + 10 * 60_000) });
    expect((await methods.getPRAutomation(key))?.startedAt).toEqual(start);
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
    expect(await methods.stopPRAutomation(key, 'round_cap', pullOne)).toMatchObject({
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
    await methods.stopPRAutomation(key, 'round_cap', pullOne);
    expect(await methods.stopPRAutomation(key, 'user_stopped')).toBeNull();
    expect((await methods.getPRAutomation(key))?.stopCode).toBe('round_cap');
  });

  test('rejects a code outside the stop code list', async () => {
    await enable();
    await expect(
      methods.stopPRAutomation(key, 'because' as unknown as PRAutomationStopCode, pullOne),
    ).rejects.toThrow();
  });

  test('returns null for a conversation with no record', async () => {
    expect(await methods.stopPRAutomation(key, 'user_stopped')).toBeNull();
  });

  test('ignores an event-driven stop for a pull request the record was rebound away from', async () => {
    await enable(pullOne);
    await enable(pullTwo);
    expect(await methods.stopPRAutomation(key, 'pull_request_closed', pullOne)).toBeNull();
    expect(await methods.getPRAutomation(key)).toMatchObject({ state: 'idle', pullNumber: 2 });
  });

  test('ignores an event-driven stop for another repository', async () => {
    await enable(pullOne);
    expect(await methods.stopPRAutomation(key, 'pull_request_closed', otherRepository)).toBeNull();
    expect((await methods.getPRAutomation(key))?.state).toBe('idle');
  });

  test('applies an event-driven stop for the pull request the record is bound to', async () => {
    await enable(pullOne);
    expect(await methods.stopPRAutomation(key, 'pull_request_closed', pullOne)).toMatchObject({
      state: 'stopped',
      stopCode: 'pull_request_closed',
    });
  });

  test('refuses an event-driven stop that names no pull request', async () => {
    await enable(pullOne);
    await expect(
      (
        methods.stopPRAutomation as (
          target: typeof key,
          code: PRAutomationStopCode,
        ) => Promise<unknown>
      )(key, 'pull_request_closed'),
    ).rejects.toThrow(RangeError);
    expect((await methods.getPRAutomation(key))?.state).toBe('idle');
  });

  test('lets a user stop win even after the record was rebound', async () => {
    await enable(pullOne);
    await enable(pullTwo);
    expect(await methods.stopPRAutomation(key, 'user_stopped')).toMatchObject({
      state: 'stopped',
      stopCode: 'user_stopped',
    });
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
    const record = await methods.removePRAutomationBot(key, 1, 'acme/one');
    expect(record?.trustedBots).toEqual([{ id: 2 }]);
  });

  test('keeps an approval made for another repository when a removal is delayed', async () => {
    await enable(pullOne);
    await addBot(7);
    await enable(otherRepository);
    await addBot(7, undefined, maxBots, 'acme/two');
    const record = await methods.removePRAutomationBot(key, 7, 'acme/one');
    expect(record).toBeNull();
    expect((await methods.getPRAutomation(key))?.trustedBots).toEqual([{ id: 7 }]);
  });

  test('removes an approval for the repository the record is bound to', async () => {
    await enable(pullOne);
    await addBot(7);
    const record = await methods.removePRAutomationBot(key, 7, 'acme/one');
    expect(record?.trustedBots).toEqual([]);
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

  test('still removes a record a user stopped', async () => {
    await enable(pullOne);
    await methods.stopPRAutomation(key, 'user_stopped');
    expect(await methods.disablePRAutomation(key)).toEqual({ removed: true });
  });
});
