import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { logger, createModels } from '..';
import { MAX_PR_AUTOMATION_BOTS } from '../types/prAutomation';
import { createPRAutomationMethods } from './prAutomation';

logger.silent = true;

let PRAutomation: mongoose.Model<unknown>;
let methods: ReturnType<typeof createPRAutomationMethods>;
let mongoServer: MongoMemoryServer;

const userId = new mongoose.Types.ObjectId().toString();
const otherUserId = new mongoose.Types.ObjectId().toString();
const key = { userId, conversationId: 'convo-1' };
const limits = { maxRounds: 3, maxMinutes: 60 };

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
});

describe('getPRAutomation', () => {
  test('returns null for a conversation that never enabled it', async () => {
    expect(await methods.getPRAutomation(key)).toBeNull();
  });
});

describe('enablePRAutomation', () => {
  test('creates an idle record on the narrowest trust level', async () => {
    const record = await methods.enablePRAutomation(key);
    expect(record).toMatchObject({
      conversationId: 'convo-1',
      state: 'idle',
      round: 0,
      trust: 'approvedBots',
      trustedBots: [],
    });
  });

  test('is idempotent and keeps one record per user and conversation', async () => {
    await methods.enablePRAutomation(key);
    await methods.enablePRAutomation(key);
    expect(await PRAutomation.countDocuments({ user: userId })).toBe(1);
  });

  test('does not change an active record that is enabled again', async () => {
    await methods.enablePRAutomation(key);
    await methods.claimPRAutomationRound({ ...key, ...limits, headSha: 'a'.repeat(40) });
    const again = await methods.enablePRAutomation(key);
    expect(again).toMatchObject({ state: 'fixing', round: 1 });
  });

  test('restarts a stopped record with a fresh round counter and window', async () => {
    await methods.enablePRAutomation(key);
    await methods.claimPRAutomationRound({ ...key, ...limits, headSha: 'a'.repeat(40) });
    await methods.setPRAutomationState(key, { state: 'stopped', stopCode: 'user_stopped' });

    const restarted = await methods.enablePRAutomation(key);
    expect(restarted).toMatchObject({ state: 'idle', round: 0 });
    expect(restarted.stopCode).toBeUndefined();
    expect(restarted.startedAt).toBeUndefined();
    expect(restarted.lastHeadSha).toBeUndefined();
  });

  test('keeps records of different users apart', async () => {
    await methods.enablePRAutomation(key);
    expect(await methods.getPRAutomation({ ...key, userId: otherUserId })).toBeNull();
  });
});

describe('claimPRAutomationRound', () => {
  const head = (n: number) => String(n).repeat(40).slice(0, 40);

  test('starts a round, counts it and records the head', async () => {
    await methods.enablePRAutomation(key);
    const result = await methods.claimPRAutomationRound({ ...key, ...limits, headSha: head(1) });
    expect(result).toMatchObject({
      ok: true,
      value: { state: 'fixing', round: 1, lastHeadSha: head(1) },
    });
  });

  test('rejects a second delivery for a head that was already claimed', async () => {
    await methods.enablePRAutomation(key);
    await methods.claimPRAutomationRound({ ...key, ...limits, headSha: head(1) });
    await methods.setPRAutomationState(key, { state: 'waiting' });
    const duplicate = await methods.claimPRAutomationRound({
      ...key,
      ...limits,
      headSha: head(1),
    });
    expect(duplicate).toEqual({ ok: false, error: { code: 'stale_head' } });
    expect((await methods.getPRAutomation(key))?.round).toBe(1);
  });

  test('rejects a claim while a round is already running', async () => {
    await methods.enablePRAutomation(key);
    await methods.claimPRAutomationRound({ ...key, ...limits, headSha: head(1) });
    const overlapping = await methods.claimPRAutomationRound({
      ...key,
      ...limits,
      headSha: head(2),
    });
    expect(overlapping).toEqual({ ok: false, error: { code: 'not_active' } });
  });

  test('stops at the round cap and never goes past it', async () => {
    await methods.enablePRAutomation(key);
    for (let round = 1; round <= limits.maxRounds; round++) {
      const claimed = await methods.claimPRAutomationRound({
        ...key,
        ...limits,
        headSha: head(round),
      });
      expect(claimed.ok).toBe(true);
      await methods.setPRAutomationState(key, { state: 'waiting' });
    }
    const over = await methods.claimPRAutomationRound({ ...key, ...limits, headSha: head(9) });
    expect(over).toEqual({ ok: false, error: { code: 'round_cap' } });
    expect((await methods.getPRAutomation(key))?.round).toBe(limits.maxRounds);
  });

  test('lets exactly one of several concurrent deliveries claim the same head', async () => {
    await methods.enablePRAutomation(key);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        methods.claimPRAutomationRound({ ...key, ...limits, headSha: head(1) }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect((await methods.getPRAutomation(key))?.round).toBe(1);
  });

  test('never exceeds the cap under concurrent deliveries for different heads', async () => {
    await methods.enablePRAutomation(key);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        methods.claimPRAutomationRound({ ...key, ...limits, headSha: head(index + 1) }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect((await methods.getPRAutomation(key))?.round).toBeLessThanOrEqual(limits.maxRounds);
  });

  test('stops once the wall-clock window has passed', async () => {
    await methods.enablePRAutomation(key);
    const start = new Date('2026-01-01T00:00:00Z');
    await methods.claimPRAutomationRound({ ...key, ...limits, headSha: head(1), now: start });
    await methods.setPRAutomationState(key, { state: 'waiting' });

    const later = new Date(start.getTime() + (limits.maxMinutes + 1) * 60_000);
    const expired = await methods.claimPRAutomationRound({
      ...key,
      ...limits,
      headSha: head(2),
      now: later,
    });
    expect(expired).toEqual({ ok: false, error: { code: 'time_cap' } });
  });

  test('reports not_found for a conversation with no record', async () => {
    const result = await methods.claimPRAutomationRound({ ...key, ...limits, headSha: head(1) });
    expect(result).toEqual({ ok: false, error: { code: 'not_found' } });
  });

  test('rejects a claim on a stopped record', async () => {
    await methods.enablePRAutomation(key);
    await methods.setPRAutomationState(key, { state: 'stopped', stopCode: 'user_stopped' });
    const result = await methods.claimPRAutomationRound({ ...key, ...limits, headSha: head(1) });
    expect(result).toEqual({ ok: false, error: { code: 'not_active' } });
  });
});

describe('setPRAutomationState', () => {
  test('records a stop code only with the stopped state', async () => {
    await methods.enablePRAutomation(key);
    const stopped = await methods.setPRAutomationState(key, {
      state: 'stopped',
      stopCode: 'round_cap',
    });
    expect(stopped).toMatchObject({ state: 'stopped', stopCode: 'round_cap' });
  });

  test('does not revive a stopped record', async () => {
    await methods.enablePRAutomation(key);
    await methods.setPRAutomationState(key, { state: 'stopped', stopCode: 'user_stopped' });
    const revived = await methods.setPRAutomationState(key, { state: 'waiting' });
    expect(revived).toBeNull();
    expect((await methods.getPRAutomation(key))?.state).toBe('stopped');
  });

  test('clears a stale stop code when the state moves on', async () => {
    await methods.enablePRAutomation(key);
    await methods.setPRAutomationState(key, { state: 'needs_user' });
    const next = await methods.setPRAutomationState(key, { state: 'waiting' });
    expect(next?.stopCode).toBeUndefined();
  });

  test('returns null for a conversation with no record', async () => {
    expect(await methods.setPRAutomationState(key, { state: 'waiting' })).toBeNull();
  });
});

describe('setPRAutomationTrust', () => {
  test('changes the trust level', async () => {
    await methods.enablePRAutomation(key);
    const updated = await methods.setPRAutomationTrust(key, 'collaborators');
    expect(updated?.trust).toBe('collaborators');
  });

  test('rejects a level outside the enum', async () => {
    await methods.enablePRAutomation(key);
    await expect(
      methods.setPRAutomationTrust(key, 'everyone' as unknown as 'anyone'),
    ).rejects.toThrow();
  });
});

describe('approved bots', () => {
  test('adds a bot by numeric id', async () => {
    await methods.enablePRAutomation(key);
    const result = await methods.addPRAutomationBot(key, { id: 101, login: 'review-bot[bot]' });
    expect(result).toMatchObject({
      ok: true,
      value: { trustedBots: [{ id: 101, login: 'review-bot[bot]' }] },
    });
  });

  test('is idempotent by id even when the login was renamed', async () => {
    await methods.enablePRAutomation(key);
    await methods.addPRAutomationBot(key, { id: 101, login: 'old-name[bot]' });
    const again = await methods.addPRAutomationBot(key, { id: 101, login: 'new-name[bot]' });
    expect(again.ok).toBe(true);
    const record = await methods.getPRAutomation(key);
    expect(record?.trustedBots).toEqual([{ id: 101, login: 'old-name[bot]' }]);
  });

  test('refuses a bot beyond the cap with a stable code', async () => {
    await methods.enablePRAutomation(key);
    for (let id = 1; id <= MAX_PR_AUTOMATION_BOTS; id++) {
      const added = await methods.addPRAutomationBot(key, { id });
      expect({ id, ok: added.ok }).toEqual({ id, ok: true });
    }
    const over = await methods.addPRAutomationBot(key, { id: 9999 });
    expect(over).toEqual({ ok: false, error: { code: 'bot_limit' } });
  });

  test('reports not_found when the conversation has no record', async () => {
    const result = await methods.addPRAutomationBot(key, { id: 101 });
    expect(result).toEqual({ ok: false, error: { code: 'not_found' } });
  });

  test('removes a bot by id and leaves the others', async () => {
    await methods.enablePRAutomation(key);
    await methods.addPRAutomationBot(key, { id: 1 });
    await methods.addPRAutomationBot(key, { id: 2 });
    const record = await methods.removePRAutomationBot(key, 1);
    expect(record?.trustedBots).toEqual([{ id: 2 }]);
  });

  test('keeps each conversation allowlist separate', async () => {
    await methods.enablePRAutomation(key);
    await methods.enablePRAutomation({ userId, conversationId: 'convo-2' });
    await methods.addPRAutomationBot(key, { id: 101 });
    const other = await methods.getPRAutomation({ userId, conversationId: 'convo-2' });
    expect(other?.trustedBots).toEqual([]);
  });
});

describe('disablePRAutomation', () => {
  test('removes the record and reports it', async () => {
    await methods.enablePRAutomation(key);
    expect(await methods.disablePRAutomation(key)).toEqual({ removed: true });
    expect(await methods.getPRAutomation(key)).toBeNull();
  });

  test('reports nothing removed when there was no record', async () => {
    expect(await methods.disablePRAutomation(key)).toEqual({ removed: false });
  });
});
