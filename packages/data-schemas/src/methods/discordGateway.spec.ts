import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createDiscordGatewayStorage, touchDiscordGatewayOwner } from './discordGateway';
import { createDiscordGatewayCheckpointModel } from '~/models/discordGateway';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createDiscordApplicationModel } from '~/models/discord';
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
const sequence = () => {
  let value = 0;
  return () => (value += 1);
};
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
const guildId = '345678901234567890';
async function installation(actorId = userId) {
  const result = await installs.connectGuild({
    actorId,
    applicationId,
    applicationRevision: revision,
    guildId,
    guildName: 'Test guild',
  });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
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
it('prepares the exact live installation and disconnects once without a fabricated installer', () =>
  scoped(async () => {
    const guild = await installation();
    const current = owner(revision);
    expect(await storage.prepareGuildRemoval(current, guildId)).toBeNull();
    await storage.acquire(current, 30000);
    const prepared = await storage.prepareGuildRemoval(current, guildId);
    expect(prepared).toEqual({
      target: {
        guildId,
        installationId: guild.installationId,
        installationRevision: guild.revision,
      },
    });
    if (!prepared?.target) throw new Error('Missing fixture target');
    expect(await storage.removeGuild(current, prepared.target)).toBe(true);
    expect(await installs.readGuild(guild.installationId)).toMatchObject({
      status: 'disconnected',
      revision: expect.not.stringMatching(`^${guild.revision}$`),
    });
    expect(await storage.removeGuild(current, prepared.target)).toBe(false);
    expect(await storage.prepareGuildRemoval(current, guildId)).toEqual({ target: null });
    expect(await storage.prepareGuildRemoval(current, '999')).toEqual({ target: null });
  }));
it('fences reconnect between prepare and removal, including a concurrent transaction race', () =>
  scoped(async () => {
    const guild = await installation();
    const current = owner(revision);
    await storage.acquire(current, 30000);
    const prepared = await storage.prepareGuildRemoval(current, guildId);
    if (!prepared?.target) throw new Error('Missing fixture target');
    const reconnect = () =>
      installs.connectGuild({
        actorId: userId,
        applicationId,
        applicationRevision: revision,
        guildId,
        guildName: 'Reinstalled',
        installationId: guild.installationId,
        expectedRevision: guild.revision,
      });
    const changed = await reconnect();
    expect(changed.ok).toBe(true);
    expect(await storage.removeGuild(current, prepared.target)).toBe(false);
    expect(await installs.readGuild(guild.installationId)).toMatchObject({ status: 'active' });
    const next = await storage.prepareGuildRemoval(current, guildId);
    if (!next?.target) throw new Error('Missing fixture target');
    const [removed, reconnected] = await Promise.all([
      storage.removeGuild(current, next.target),
      installs.connectGuild({
        actorId: userId,
        applicationId,
        applicationRevision: revision,
        guildId,
        guildName: 'Concurrent',
        installationId: next.target.installationId,
        expectedRevision: next.target.installationRevision,
      }),
    ]);
    expect(Number(removed) + Number(reconnected.ok)).toBe(1);
  }));
it('rejects foreign scope and stale application, lease, installation and guild tuples', () =>
  scoped(async () => {
    const guild = await installation();
    const current = owner(revision);
    await storage.acquire(current, 30000);
    const prepared = await storage.prepareGuildRemoval(current, guildId);
    if (!prepared?.target) throw new Error('Missing fixture target');
    const target = prepared.target;
    await scoped(async () => {
      expect(await storage.prepareGuildRemoval(current, guildId)).toBeNull();
      expect(await storage.removeGuild(current, target)).toBe(false);
    }, 'foreign');
    for (const change of [
      { installationId: 'wrong' },
      { guildId: '999' },
      { installationRevision: 'wrong' },
    ])
      expect(await storage.removeGuild(current, { ...target, ...change })).toBe(false);
    expect(await storage.removeGuild({ ...current, ownerId: 'b'.repeat(32) }, target)).toBe(false);
    await storage.release(current);
    await storage.acquire(owner(revision, 'b'), 30000);
    expect(await storage.removeGuild(current, target)).toBe(false);
    const rotated = await installs.configureApplication({
      actorId: userId,
      applicationId,
      botUserId,
      publicKey: 'b'.repeat(64),
      expectedRevision: revision,
    });
    expect(rotated.ok).toBe(true);
    expect(await storage.removeGuild(owner(revision, 'b'), target)).toBe(false);
    expect(await installs.readGuild(guild.installationId)).toMatchObject({
      status: 'active',
      revision: guild.revision,
    });
  }));
it.each(['application', 'installer'])(
  'blocks erasure of the %s owner between preparation and removal',
  (which) =>
    scoped(async () => {
      const installer = '000000000000000000000002';
      await createUserModel(db).create({
        _id: installer,
        tenantId,
        role: 'USER',
        email: 'installer@example.test',
        provider: 'local',
      });
      const guild = await installation(installer);
      const current = owner(revision);
      await storage.acquire(current, 30000);
      const prepared = await storage.prepareGuildRemoval(current, guildId);
      if (!prepared?.target) throw new Error('Missing fixture target');
      await createUserModel(db).updateOne(
        { _id: which === 'application' ? userId : installer },
        { $set: { agentTriggerDeletionStartedAt: new Date() } },
      );
      expect(await storage.removeGuild(current, prepared.target)).toBe(false);
      expect(await installs.readGuild(guild.installationId)).toMatchObject({ status: 'active' });
    }),
);
it('rejects expiry between preparation and removal without extending the lease', () =>
  scoped(async () => {
    await installation();
    const current = owner(revision);
    await storage.acquire(current, 30000);
    const prepared = await storage.prepareGuildRemoval(current, guildId);
    if (!prepared?.target) throw new Error('Missing fixture target');
    await createResourceLockModel(db).updateOne(
      { key: `discord:gateway:${applicationId}` },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect(await storage.removeGuild(current, prepared.target)).toBe(false);
    expect(await storage.prepareGuildRemoval(current, guildId)).toBeNull();
  }));
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
it('records credential observations only for the current leased revision and resets them on rotation', () =>
  scoped(async () => {
    const current = owner(revision);
    const next = sequence();
    const initial = await installs.readApplication(applicationId);
    expect(initial?.credentialHealth).toEqual({ state: 'valid', checkedAt: expect.any(Number) });
    expect(await storage.observeCredentials(current, 'invalid', next())).toBe(false);
    await storage.acquire(current, 30000);
    const before = Date.now();
    expect(await storage.observeCredentials(current, 'invalid', next())).toBe(true);
    const invalid = await installs.readApplication(applicationId);
    expect(invalid?.revision).toBe(revision);
    expect(invalid?.credentialHealth?.state).toBe('invalid');
    expect(invalid?.credentialHealth?.checkedAt).toBeGreaterThanOrEqual(before);
    expect(invalid?.credentialHealth?.checkedAt).toBeLessThanOrEqual(Date.now());
    expect(await storage.observeCredentials(owner(revision, 'b'), 'valid', next())).toBe(false);
    await scoped(async () => {
      expect(await storage.observeCredentials(current, 'valid', next())).toBe(false);
    }, 'foreign');
    expect((await installs.readApplication(applicationId))?.credentialHealth).toEqual(
      invalid?.credentialHealth,
    );
    expect(await storage.observeCredentials(current, 'valid', next())).toBe(true);
    expect((await installs.readApplication(applicationId))?.credentialHealth?.state).toBe('valid');
    await storage.observeCredentials(current, 'invalid', next());
    const changed = await installs.configureApplication({
      actorId: userId,
      applicationId,
      botUserId,
      publicKey: 'a'.repeat(64),
      expectedRevision: revision,
      encryptedBotToken: 'rotated-token',
    });
    expect(changed.ok).toBe(true);
    expect(await storage.observeCredentials(current, 'invalid', next())).toBe(false);
    expect((await installs.readApplication(applicationId))?.credentialHealth?.state).toBe('valid');
  }));
it('does not persist credential observations after lease release, expiry, owner deletion or policy disablement', () =>
  scoped(async () => {
    const current = owner(revision);
    const next = sequence();
    await storage.acquire(current, 30000);
    await storage.release(current);
    expect(await storage.observeCredentials(current, 'invalid', next())).toBe(false);
    await storage.acquire(current, 30000);
    await createResourceLockModel(db).updateOne(
      { key: `discord:gateway:${applicationId}` },
      { $set: { expiresAt: new Date(0) } },
    );
    expect(await storage.observeCredentials(current, 'invalid', next())).toBe(false);
    await storage.acquire(current, 30000);
    settings = null;
    expect(await storage.observeCredentials(current, 'invalid', next())).toBe(false);
    settings = { ownershipLeaseMs: 30000, shardCount: 2 };
    await createUserModel(db).deleteOne({ _id: userId });
    expect(await storage.observeCredentials(current, 'invalid', next())).toBe(false);
    expect((await installs.readApplication(applicationId))?.credentialHealth?.state).toBe('valid');
  }));

it('projects legacy and malformed credential metadata as unknown without exposing restored fields', () =>
  scoped(async () => {
    const applications = createDiscordApplicationModel(db);
    for (const health of [
      null,
      { state: 'invalid', checkedAt: -1 },
      { state: 'valid', checkedAt: 1, secret: 'must-not-leak' },
    ]) {
      await applications.collection.updateOne(
        { applicationId },
        { $set: { credentialHealth: health } },
      );
      expect((await installs.readApplication(applicationId))?.credentialHealth).toBeUndefined();
      expect((await installs.listApplications()).applications[0]?.credentialHealth).toBeUndefined();
      expect(JSON.stringify(await installs.lookupApplication(applicationId))).not.toContain(
        'must-not-leak',
      );
    }
    await applications.collection.updateOne(
      { applicationId },
      { $unset: { credentialHealth: '' } },
    );
    expect((await installs.readApplication(applicationId))?.credentialHealth).toBeUndefined();
  }));
it('fences a concurrent old-owner observation against rotation', () =>
  scoped(async () => {
    const current = owner(revision);
    const next = sequence();
    await storage.acquire(current, 30000);
    const [, changed] = await Promise.all([
      storage.observeCredentials(current, 'invalid', next()),
      installs.configureApplication({
        actorId: userId,
        applicationId,
        botUserId,
        publicKey: 'a'.repeat(64),
        expectedRevision: revision,
        encryptedBotToken: 'rotated-token',
      }),
    ]);
    expect(changed.ok).toBe(true);
    expect((await installs.readApplication(applicationId))?.credentialHealth?.state).toBe('valid');
    expect(await storage.observeCredentials(current, 'invalid', next())).toBe(false);
  }));

const recorded = async () => (await installs.readApplication(applicationId))?.credentialHealth;
const gate = () => {
  let open: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => (open = resolve));
  return { open, closed };
};
// A request held before it touches the database, as a stalled server side retry would be.
const held = (closed: Promise<void>) =>
  createDiscordGatewayStorage(db, async () => {
    await closed;
    return settings;
  });

it('keeps the newest observation when an older write reaches the database late', () =>
  scoped(async () => {
    const current = owner(revision);
    await storage.acquire(current, 30000);
    const stalled = gate();
    const older = held(stalled.closed).observeCredentials(current, 'valid', 1);
    expect(await storage.observeCredentials(current, 'invalid', 2)).toBe(true);
    const winner = await recorded();
    expect(winner?.state).toBe('invalid');
    stalled.open();
    expect(await older).toBe(true);
    expect(await recorded()).toEqual(winner);
  }));
it('treats older and repeated observations as successful no-ops that leave the record untouched', () =>
  scoped(async () => {
    const current = owner(revision);
    await storage.acquire(current, 30000);
    expect(await storage.observeCredentials(current, 'invalid', 5)).toBe(true);
    const winner = await recorded();
    expect(winner?.state).toBe('invalid');
    for (const [state, value] of [
      ['valid', 4],
      ['valid', 5],
      ['invalid', 5],
      ['valid', 1],
    ] as const) {
      expect(await storage.observeCredentials(current, state, value)).toBe(true);
      expect(await recorded()).toEqual(winner);
    }
    expect(await storage.observeCredentials(current, 'valid', 6)).toBe(true);
    const next = await recorded();
    expect(next?.state).toBe('valid');
    expect(next?.checkedAt).toBeGreaterThanOrEqual(winner!.checkedAt);
  }));
it.each(['release', 'expiry'] as const)(
  'starts a new owner from its first observation after %s and keeps the old owner forbidden',
  (end) =>
    scoped(async () => {
      const first = owner(revision, 'a');
      const second = owner(revision, 'b');
      await storage.acquire(first, 30000);
      expect(await storage.observeCredentials(first, 'invalid', 7)).toBe(true);
      if (end === 'release') await storage.release(first);
      else
        await createResourceLockModel(db).updateOne(
          { key: `discord:gateway:${applicationId}` },
          { $set: { expiresAt: new Date(0) } },
        );
      expect(await storage.acquire(second, 30000)).toBe(true);
      expect(await storage.observeCredentials(second, 'valid', 1)).toBe(true);
      const current = await recorded();
      expect(current?.state).toBe('valid');
      expect(await storage.observeCredentials(first, 'invalid', 99)).toBe(false);
      expect(await recorded()).toEqual(current);
      expect(await storage.observeCredentials(second, 'invalid', 1)).toBe(true);
      expect(await recorded()).toEqual(current);
      expect(await storage.observeCredentials(second, 'invalid', 2)).toBe(true);
      expect((await recorded())?.state).toBe('invalid');
    }),
);
it('rejects a missing or malformed sequence and never writes without one', () =>
  scoped(async () => {
    const current = owner(revision);
    await storage.acquire(current, 30000);
    const before = await recorded();
    const write = storage.observeCredentials as (...input: unknown[]) => Promise<boolean>;
    for (const bad of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      2 ** 53,
      Number.MAX_SAFE_INTEGER + 2,
      '1',
      null,
      undefined,
      {},
      [1],
      true,
    ])
      await expect(write(current, 'invalid', bad)).rejects.toThrow();
    await expect(write(current, 'invalid')).rejects.toThrow();
    expect(await recorded()).toEqual(before);
    expect(await storage.observeCredentials(current, 'invalid', Number.MAX_SAFE_INTEGER)).toBe(
      true,
    );
    expect((await recorded())?.state).toBe('invalid');
  }));
it('keeps the highest sequence whatever order the writes commit in', () =>
  scoped(async () => {
    const current = owner(revision);
    await storage.acquire(current, 30000);
    const writes = Array.from({ length: 5 }, (_, index) => ({
      state: index % 2 ? ('invalid' as const) : ('valid' as const),
      value: index + 1,
    }));
    const gates = writes.map(gate);
    const pending = writes.map(({ state, value }, index) =>
      held(gates[index].closed).observeCredentials(current, state, value),
    );
    const order = [4, 2, 0, 3, 1];
    gates[order[0]].open();
    expect(await pending[order[0]]).toBe(true);
    const winner = await recorded();
    expect(winner?.state).toBe(writes[4].state);
    for (const index of order.slice(1)) {
      gates[index].open();
      expect(await pending[index]).toBe(true);
      expect(await recorded()).toEqual(winner);
    }
    const raw = await createDiscordApplicationModel(db).collection.findOne({ applicationId });
    expect(raw?.credentialFence?.sequence).toBe(5);
  }));
it('converges on the highest sequence when the writes race inside transactions', () =>
  scoped(async () => {
    const current = owner(revision);
    await storage.acquire(current, 30000);
    const writes = Array.from({ length: 8 }, (_, index) => ({
      state: index % 2 ? ('invalid' as const) : ('valid' as const),
      value: index + 1,
    }));
    const arrival = [5, 1, 7, 0, 3, 6, 2, 4];
    await Promise.all(
      arrival.map((index) =>
        storage.observeCredentials(current, writes[index].state, writes[index].value),
      ),
    );
    expect((await recorded())?.state).toBe(writes[7].state);
    const raw = await createDiscordApplicationModel(db).collection.findOne({ applicationId });
    expect(raw?.credentialFence?.sequence).toBe(8);
  }));
it('keeps ordering metadata private while persisting it beside the health record', () =>
  scoped(async () => {
    const current = owner(revision, 'c');
    await storage.acquire(current, 30000);
    expect(await storage.observeCredentials(current, 'invalid', 3)).toBe(true);
    const raw = await createDiscordApplicationModel(db).collection.findOne({ applicationId });
    expect(raw?.credentialFence).toEqual({ holder: `${revision}:${current.ownerId}`, sequence: 3 });
    const publicViews = JSON.stringify([
      await installs.readApplication(applicationId),
      await installs.listApplications(),
      await installs.lookupApplication(applicationId),
    ]);
    for (const hidden of ['credentialFence', 'sequence', current.ownerId, `${revision}:`])
      expect(publicViews).not.toContain(hidden);
    expect(publicViews).toContain('"credentialHealth"');
  }));
it('does not let ordering metadata of a rotated revision block the next owner', () =>
  scoped(async () => {
    const current = owner(revision);
    await storage.acquire(current, 30000);
    expect(await storage.observeCredentials(current, 'invalid', 41)).toBe(true);
    const changed = await installs.configureApplication({
      actorId: userId,
      applicationId,
      botUserId,
      publicKey: 'a'.repeat(64),
      expectedRevision: revision,
      encryptedBotToken: 'rotated-token',
    });
    if (!changed.ok) throw new Error('Rotation unavailable');
    await storage.release(current);
    const rotated = owner(changed.value.revision, 'c');
    expect(await storage.acquire(rotated, 30000)).toBe(true);
    expect(await storage.observeCredentials(rotated, 'invalid', 1)).toBe(true);
    expect((await recorded())?.state).toBe('invalid');
  }));
