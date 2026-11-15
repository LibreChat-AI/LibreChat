import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { DiscordInstallStorage } from './discordInstall';
import { tenantStorage, runAsSystem, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createDiscordInstallModel } from '~/models/discordInstall';
import { eraseChannelPersistenceForUser } from './channelErasure';
import { createDiscordInstallStorage } from './discordInstall';
import { createDiscordInstallationStorage } from './discord';
import { closeResponseScopes } from './responseScope';
import { createUserModel } from '~/models/user';

const db = new mongoose.Mongoose();
const userId = '000000000000000000000001';
const applicationId = '123456789012345678';
const tenantId = 'oauth-org';
const stateHash = 'a'.repeat(64);
const sessionHash = 'b'.repeat(64);
const scope = <T>(work: () => Promise<T>, tenant = tenantId) =>
  tenantStorage.run({ tenantId: tenant }, work);
const value = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
};
let mongo: MongoMemoryReplSet;
let states: DiscordInstallStorage;
let appRevision: string;
const installations = () => createDiscordInstallationStorage(db);
const start = () =>
  states.start({
    stateHash,
    sessionHash,
    userId,
    applicationId,
    applicationRevision: appRevision,
    expiresAt: new Date(Date.now() + 60000),
  });
const consume = (overrides = {}) =>
  states.consume({ stateHash, sessionHash, userId, now: new Date(), ...overrides });
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await db.connect(mongo.getUri(), { autoIndex: false });
  states = createDiscordInstallStorage(db);
}, 60000);
afterAll(async () => {
  await db.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await runAsSystem(async () => {
    for (const model of Object.values(db.models)) await model.deleteMany({});
  });
  await scope(async () => {
    await createUserModel(db).create({
      _id: userId,
      email: 'admin@example.test',
      provider: 'local',
      tenantId,
    });
    appRevision = value(
      await installations().configureApplication({
        actorId: userId,
        applicationId,
        botUserId: '123456789012345679',
        publicKey: 'a'.repeat(64),
        encryptedBotToken: 'encrypted-bot',
        encryptedClientSecret: 'encrypted-secret',
      }),
    ).revision;
  });
});

it('hides session hashes and discovers callback tenant only through a valid state hash', async () =>
  scope(async () => {
    const record = value(await start());
    expect(record).not.toHaveProperty('sessionHash');
    expect(await states.lookup(stateHash, new Date())).toEqual(record);
    expect(await states.lookup('invalid', new Date())).toBeNull();
    expect(await createDiscordInstallModel(db).findOne({ userId }).lean()).not.toHaveProperty(
      'sessionHash',
    );
  }));

it('consumes a flow exactly once under concurrent callbacks', async () =>
  scope(async () => {
    await start();
    const results = await Promise.all([consume(), consume()]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: { code: 'invalid_state' } },
    ]);
    expect(await states.lookup(stateHash, new Date())).toBeNull();
  }));

it('binds the session, user, tenant and expiry without consuming another session flow', async () => {
  await scope(start);
  await scope(async () => {
    expect(await consume({ sessionHash: 'c'.repeat(64) })).toMatchObject({ ok: false });
    expect(await consume({ userId: 'other-user' })).toMatchObject({ ok: false });
    expect(await consume({ now: new Date(Date.now() + 120000) })).toMatchObject({ ok: false });
  });
  await scope(async () => {
    expect(await consume()).toMatchObject({ ok: false });
  }, 'foreign');
  await scope(async () => {
    expect(await consume()).toMatchObject({ ok: true });
  });
});

it('burns a flow when its application generation changes', async () =>
  scope(async () => {
    await start();
    await installations().configureApplication({
      actorId: userId,
      applicationId,
      botUserId: '123456789012345679',
      publicKey: 'b'.repeat(64),
      expectedRevision: appRevision,
    });
    expect(await consume()).toEqual({ ok: false, error: { code: 'application_changed' } });
    expect(await states.lookup(stateHash, new Date())).toBeNull();
  }));

it('captures immutable reconnect scope and burns state after disconnect changes it', async () =>
  scope(async () => {
    const guild = value(
      await installations().connectGuild({
        actorId: userId,
        applicationId,
        applicationRevision: appRevision,
        guildId: '123456789012345680',
        guildName: 'Guild',
      }),
    );
    const record = value(
      await states.start({
        stateHash,
        sessionHash,
        userId,
        applicationId,
        applicationRevision: appRevision,
        expiresAt: new Date(Date.now() + 60000),
        installationId: guild.installationId,
        installationRevision: guild.revision,
      }),
    );
    expect(record.guildId).toBe(guild.guildId);
    await installations().disconnectGuild({
      actorId: userId,
      installationId: guild.installationId,
      expectedRevision: guild.revision,
    });
    expect(await consume()).toEqual({ ok: false, error: { code: 'installation_changed' } });
    expect(await states.lookup(stateHash, new Date())).toBeNull();
  }));

it('joins account erasure admission and rejects system mutation scope', async () => {
  await scope(async () => {
    await start();
    await closeResponseScopes(db, { userId, tenantId });
    expect(await consume()).toEqual({ ok: false, error: { code: 'principal_unavailable' } });
    expect(await start()).toEqual({ ok: false, error: { code: 'principal_unavailable' } });
  });
  await scope(async () => {
    await expect(consume()).rejects.toThrow('tenant scope');
  }, SYSTEM_TENANT_ID);
});

it('restricts cancellation to the same authenticated session and user', async () =>
  scope(async () => {
    await start();
    await states.cancel({ stateHash, sessionHash: 'c'.repeat(64), userId });
    expect(await states.lookup(stateHash, new Date())).not.toBeNull();
    await states.cancel({ stateHash, sessionHash, userId });
    expect(await states.lookup(stateHash, new Date())).toBeNull();
  }));

it('propagates operational failures and rejects malformed private state', async () =>
  scope(async () => {
    const diagnostic = new Error('private database diagnostic');
    const spy = jest
      .spyOn(createDiscordInstallModel(db).collection, 'findOne')
      .mockRejectedValueOnce(diagnostic);
    await expect(states.lookup(stateHash, new Date())).rejects.toBe(diagnostic);
    spy.mockRestore();
    await expect(
      states.start({
        stateHash: 'bad',
        sessionHash,
        userId,
        applicationId,
        applicationRevision: appRevision,
        expiresAt: new Date(),
      }),
    ).rejects.toThrow(TypeError);
  }));

it('erases only the deleted account OAuth state within its tenant and blocks reinsertion', async () =>
  scope(async () => {
    value(await start());
    const otherUserId = '000000000000000000000002';
    await createUserModel(db).create({
      _id: otherUserId,
      email: 'other@example.test',
      provider: 'local',
      tenantId,
    });
    value(
      await states.start({
        stateHash: 'c'.repeat(64),
        sessionHash,
        userId: otherUserId,
        applicationId,
        applicationRevision: appRevision,
        expiresAt: new Date(Date.now() + 60000),
      }),
    );
    await tenantStorage.run({ tenantId: 'foreign' }, async () => {
      await createDiscordInstallModel(db).create({
        tenantId: 'foreign',
        stateHash: 'd'.repeat(64),
        sessionHash,
        userId,
        applicationId,
        applicationRevision: 'foreign',
        expiresAt: new Date(Date.now() + 60000),
      });
    });
    const owner = { userId, tenantId };
    await closeResponseScopes(db, owner);
    await eraseChannelPersistenceForUser(db, owner);
    expect(await states.lookup(stateHash, new Date())).toBeNull();
    expect(await states.lookup('c'.repeat(64), new Date())).not.toBeNull();
    expect(await states.lookup('d'.repeat(64), new Date())).not.toBeNull();
    expect(await start()).toEqual({ ok: false, error: { code: 'principal_unavailable' } });
    await eraseChannelPersistenceForUser(db, owner);
    expect(await states.lookup('c'.repeat(64), new Date())).not.toBeNull();
  }));

it.each([undefined, ''])(
  'erases tenantless OAuth state persisted with tenantId %s',
  async (legacyTenant) => {
    await scope(start);
    await tenantStorage.run({ tenantId: undefined }, async () => {
      const legacyUserId = '000000000000000000000003';
      await createUserModel(db).create({
        _id: legacyUserId,
        email: 'legacy@example.test',
        provider: 'local',
      });
      const legacyApp = value(
        await installations().configureApplication({
          actorId: legacyUserId,
          applicationId: '998',
          botUserId: '999',
          publicKey: 'a'.repeat(64),
          encryptedBotToken: 'encrypted',
          encryptedClientSecret: 'encrypted',
        }),
      );
      await runAsSystem(async () => {
        await createDiscordInstallModel(db).create({
          tenantId: legacyTenant,
          stateHash: 'e'.repeat(64),
          sessionHash,
          userId: legacyUserId,
          applicationId: legacyApp.applicationId,
          applicationRevision: legacyApp.revision,
          expiresAt: new Date(Date.now() + 60000),
        });
      });
      const owner = { userId: legacyUserId };
      await closeResponseScopes(db, owner);
      await eraseChannelPersistenceForUser(db, owner);
      expect(await states.lookup('e'.repeat(64), new Date())).toBeNull();
      expect(await states.lookup(stateHash, new Date())).not.toBeNull();
    });
  },
);
