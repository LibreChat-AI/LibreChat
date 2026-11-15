import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createDiscordGatewayStorage, touchDiscordGatewayOwner } from './discordGateway';
import { createDiscordGatewayCheckpointModel } from '~/models/discordGateway';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createResourceLockModel } from '~/models/resourceLock';
import { withRequiredTransaction } from '~/utils/transactions';
import { createDiscordInstallationStorage } from './discord';
import { createUserModel } from '~/models/user';

const db = new mongoose.Mongoose();
const tenantId = 'gateway-owner';
const userId = '000000000000000000000001';
const applicationId = '123456789012345678';
const botUserId = '234567890123456789';
const scoped = <T>(work: () => Promise<T>, value = tenantId) =>
  tenantStorage.run({ tenantId: value }, work);
const owner = (applicationRevision: string, id = 'a') => ({
  applicationId,
  applicationRevision,
  ownerId: id.repeat(32),
});
let mongo: MongoMemoryReplSet;
let revision: string;
let settings: { ownershipLeaseMs: number; shardCount: number } | null;
const storage = createDiscordGatewayStorage(db, async () => settings);
const installs = createDiscordInstallationStorage(db);
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await db.connect(mongo.getUri());
});
afterAll(async () => {
  await db.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await runAsSystem(async () => {
    for (const collection of Object.values(db.connection.collections))
      await collection.deleteMany({});
  });
  settings = { ownershipLeaseMs: 30000, shardCount: 2 };
  await scoped(async () => {
    await createUserModel(db).create({
      _id: userId,
      tenantId,
      role: 'USER',
      email: 'owner@example.test',
      provider: 'local',
    });
    const result = await installs.configureApplication({
      actorId: userId,
      applicationId,
      botUserId,
      publicKey: 'a'.repeat(64),
      encryptedBotToken: 'encrypted-token',
      encryptedClientSecret: 'encrypted-client',
    });
    if (!result.ok) throw new Error('Fixture application unavailable');
    revision = result.value.revision;
  });
});
it('elects one application owner under concurrent acquisition and scopes every operation to its tenant', () =>
  scoped(async () => {
    const candidates = [owner(revision, 'a'), owner(revision, 'b'), owner(revision, 'c')];
    const results = await Promise.all(
      candidates.map((candidate) => storage.acquire(candidate, 30000)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = candidates[results.indexOf(true)];
    expect(await storage.acquire(winner, 30000)).toBe(true);
    expect(await storage.load(winner)).toMatchObject({
      applicationId,
      applicationRevision: revision,
      botUserId,
      encryptedBotToken: 'encrypted-token',
      checkpoints: [],
    });
    await scoped(async () => {
      expect(await storage.load(winner)).toBeNull();
      expect(await storage.renew(winner, 30000)).toBe(false);
      expect(await storage.release(winner)).toBe(false);
    }, 'foreign');
    expect(await storage.release(candidates.find((candidate) => candidate !== winner)!)).toBe(
      false,
    );
    expect(await storage.renew(winner, 30000)).toBe(true);
  }));
it('retains the same application lock across credential rotations and permits only old-owner cleanup', () =>
  scoped(async () => {
    const original = owner(revision);
    expect(await storage.acquire(original, 30000)).toBe(true);
    await storage.save(original, botUserId, [{ shardId: 0, encryptedSession: 'old-session' }]);
    const rotated = await installs.configureApplication({
      actorId: userId,
      applicationId,
      botUserId,
      publicKey: 'b'.repeat(64),
      encryptedBotToken: 'rotated',
      expectedRevision: revision,
    });
    if (!rotated.ok) throw new Error('Rotation unavailable');
    const replacement = owner(rotated.value.revision, 'b');
    expect(await storage.acquire(replacement, 30000)).toBe(false);
    expect(await storage.renew(original, 30000)).toBe(false);
    expect(await storage.load(original)).toBeNull();
    expect(await storage.save(original, botUserId, [])).toBe(false);
    expect(await storage.release(original)).toBe(true);
    expect(await storage.acquire(replacement, 30000)).toBe(true);
    expect(await storage.release(original)).toBe(false);
    expect(await storage.load(replacement)).toMatchObject({
      encryptedBotToken: 'rotated',
      checkpoints: [],
    });
  }));
it('rejects expired leases and fences takeover without letting authority touches extend expiry', () =>
  scoped(async () => {
    const first = owner(revision);
    expect(await storage.acquire(first, 30000)).toBe(true);
    const locks = createResourceLockModel(db);
    const before = await locks.findOne({ key: `discord:gateway:${applicationId}` }).lean();
    expect(
      await withRequiredTransaction(db, (session) =>
        touchDiscordGatewayOwner(db, { ...first, tenantId }, session),
      ),
    ).toBe(true);
    const after = await locks.findOne({ key: `discord:gateway:${applicationId}` }).lean();
    expect(after?.expiresAt).toEqual(before?.expiresAt);
    expect(after?.fenceWrites).toBeGreaterThan(before?.fenceWrites ?? -1);
    await locks.updateOne(
      { key: `discord:gateway:${applicationId}` },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect(await storage.renew(first, 30000)).toBe(false);
    expect(await storage.load(first)).toBeNull();
    expect(await storage.save(first, botUserId, [])).toBe(false);
    const second = owner(revision, 'b');
    expect(await storage.acquire(second, 30000)).toBe(true);
    expect(
      await withRequiredTransaction(db, (session) =>
        touchDiscordGatewayOwner(db, { ...first, tenantId }, session),
      ),
    ).toBe(false);
    expect(await storage.release(first)).toBe(false);
    expect(await storage.load(second)).not.toBeNull();
  }));
it('merges simultaneous shard checkpoints atomically, bounds shards and supports null invalidation', () =>
  scoped(async () => {
    const current = owner(revision);
    await storage.acquire(current, 30000);
    expect(
      await Promise.all([
        storage.save(current, botUserId, [{ shardId: 0, encryptedSession: 'encrypted-zero' }]),
        storage.save(current, botUserId, [{ shardId: 1, encryptedSession: 'encrypted-one' }]),
      ]),
    ).toEqual([true, true]);
    expect((await storage.load(current))?.checkpoints).toHaveLength(2);
    expect(await createDiscordGatewayCheckpointModel(db).find({ applicationId }).lean()).toEqual(
      expect.arrayContaining([
        expect.not.objectContaining({ encryptedSession: expect.anything() }),
      ]),
    );
    expect(
      await storage.save(current, '345678901234567890', [
        { shardId: 0, encryptedSession: 'wrong-bot' },
      ]),
    ).toBe(false);
    await expect(
      storage.save(current, botUserId, [{ shardId: 2, encryptedSession: 'invalid' }]),
    ).rejects.toThrow();
    await expect(
      storage.save(current, botUserId, [
        { shardId: 0, encryptedSession: 'one' },
        { shardId: 0, encryptedSession: 'two' },
      ]),
    ).rejects.toThrow();
    await storage.save(current, botUserId, [{ shardId: 0, encryptedSession: null }]);
    expect((await storage.load(current))?.checkpoints).toMatchObject([
      { shardId: 1, encryptedSession: 'encrypted-one' },
    ]);
    settings = { ownershipLeaseMs: 30000, shardCount: 1 };
    expect((await storage.load(current))?.checkpoints).toEqual([]);
    await storage.save(current, botUserId, [{ shardId: 0, encryptedSession: 'new-topology' }]);
    expect(await createDiscordGatewayCheckpointModel(db).countDocuments({ applicationId })).toBe(1);
  }));
it('fails closed when Gateway is disabled or the owning account is being erased', () =>
  scoped(async () => {
    const current = owner(revision);
    await storage.acquire(current, 30000);
    settings = null;
    expect(await storage.renew(current, 30000)).toBe(false);
    expect(await storage.load(current)).toBeNull();
    expect(await storage.save(current, botUserId, [])).toBe(false);
    settings = { ownershipLeaseMs: 30000, shardCount: 2 };
    await createUserModel(db).updateOne(
      { _id: userId },
      { $set: { agentTriggerDeletionStartedAt: new Date() } },
    );
    expect(await storage.renew(current, 30000)).toBe(false);
    expect(await storage.load(current)).toBeNull();
    expect(await storage.acquire(owner(revision, 'b'), 30000)).toBe(false);
  }));
it('grants exactly the requested current duration and refreshes idempotent acquisition before reporting success', () =>
  scoped(async () => {
    const current = owner(revision);
    expect(await storage.acquire(current, 30000)).toBe(true);
    const locks = createResourceLockModel(db);
    const filter = { key: `discord:gateway:${applicationId}` };
    await locks.updateOne(filter, { $set: { expiresAt: new Date(Date.now() + 1000) } });
    const started = Date.now();
    expect(await storage.acquire(current, 30000)).toBe(true);
    expect((await locks.findOne(filter).lean())!.expiresAt.getTime()).toBeGreaterThanOrEqual(
      started + 30000,
    );
    settings = { ownershipLeaseMs: 5000, shardCount: 2 };
    expect(await storage.acquire(current, 30000)).toBe(false);
    expect(await storage.renew(current, 30000)).toBe(false);
    expect(await storage.renew(current, 5000)).toBe(true);
    expect(await storage.acquire(current, 5000)).toBe(true);
  }));
