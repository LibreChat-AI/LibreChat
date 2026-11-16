import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { DiscordStorageResult, DiscordInstallationStorage } from './discord';
import { tenantStorage, runAsSystem, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createDiscordApplicationModel } from '~/models/discord';
import { createDiscordInstallationStorage } from './discord';
import { closeResponseScopes } from './responseScope';
import { createUserModel } from '~/models/user';

const db = new mongoose.Mongoose();
let mongo: MongoMemoryReplSet;
let store: DiscordInstallationStorage;
const applicationId = '123456789012345678';
const botUserId = '123456789012345679';
const actorId = '000000000000000000000001';
const adminId = '000000000000000000000002';
const tenantId = 'discord-org';
const scoped = <T>(work: () => Promise<T>, tenant = tenantId) =>
  tenantStorage.run({ tenantId: tenant }, work);
const value = <T>(result: DiscordStorageResult<T>): T => {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
};
const configuration = () => ({
  actorId,
  applicationId,
  botUserId,
  publicKey: 'a'.repeat(64),
  name: 'Bot',
  encryptedBotToken: 'encrypted-bot-token',
  encryptedClientSecret: 'encrypted-client-secret',
});
const configure = async () => value(await store.configureApplication(configuration()));

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await db.connect(mongo.getUri(), { autoIndex: false, readPreference: 'secondaryPreferred' });
  store = createDiscordInstallationStorage(db);
}, 60000);
afterAll(async () => {
  await db.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await runAsSystem(async () => {
    for (const model of Object.values(db.models)) await model.deleteMany({});
  });
  await scoped(async () => {
    await createUserModel(db).create([
      { _id: actorId, email: 'installer@example.test', provider: 'local', tenantId },
      { _id: adminId, email: 'admin@example.test', provider: 'local', tenantId },
    ]);
  });
});

it('separates encrypted credentials from safe mutation, read and page metadata', async () =>
  scoped(async () => {
    const app = await configure();
    expect(app).not.toHaveProperty('encryptedBotToken');
    expect(app).not.toHaveProperty('encryptedClientSecret');
    expect(app).not.toHaveProperty('_id');
    expect(await store.readApplication(applicationId)).toEqual(app);
    expect(await store.listApplications()).toEqual({ applications: [app] });
    expect(
      await createDiscordApplicationModel(db).findOne({ applicationId }).lean(),
    ).not.toHaveProperty('encryptedBotToken');
    expect(await store.readApplicationCredentials(applicationId)).toEqual({
      ...app,
      encryptedBotToken: 'encrypted-bot-token',
      encryptedClientSecret: 'encrypted-client-secret',
    });
    expect(await store.readApplication('999')).toBeNull();
    expect(await store.readApplicationCredentials('999')).toBeNull();
  }));

it('rotates credentials with CAS', async () =>
  scoped(async () => {
    const app = await configure();
    const rotated = value(
      await store.configureApplication({
        ...configuration(),
        expectedRevision: app.revision,
        encryptedBotToken: 'rotated',
        encryptedClientSecret: undefined,
      }),
    );
    expect(rotated.revision).not.toBe(app.revision);
    expect((await store.readApplicationCredentials(applicationId))?.encryptedClientSecret).toBe(
      'encrypted-client-secret',
    );
    expect(
      await store.configureApplication({ ...configuration(), expectedRevision: app.revision }),
    ).toMatchObject({ ok: false, error: { code: 'application_changed' } });
  }));

it('enforces a global application tenant owner without exposing its metadata', async () => {
  await scoped(configure);
  await scoped(async () => {
    await createUserModel(db).create({
      _id: '000000000000000000000003',
      email: 'foreign@example.test',
      provider: 'local',
      tenantId: 'other-org',
    });
  }, 'other-org');
  await scoped(async () => {
    expect(await store.readApplication(applicationId)).toBeNull();
    expect(await store.readApplicationCredentials(applicationId)).toBeNull();
    expect(await store.listApplications()).toEqual({ applications: [] });
    expect(
      await store.configureApplication({ ...configuration(), actorId: '000000000000000000000003' }),
    ).toMatchObject({ ok: false, error: { code: 'application_in_use' } });
  }, 'other-org');
});

it.each(['closed', 'deleting', 'deleted'])(
  'blocks %s application owners from being reconfigured by another active admin',
  async (mode) =>
    scoped(async () => {
      await configure();
      if (mode === 'closed') await closeResponseScopes(db, { userId: actorId, tenantId });
      if (mode === 'deleting')
        await createUserModel(db).updateOne(
          { _id: actorId },
          { $set: { agentTriggerDeletionStartedAt: new Date() } },
        );
      if (mode === 'deleted') await createUserModel(db).deleteOne({ _id: actorId });
      const app = (await store.readApplication(applicationId))!;
      expect(
        await store.configureApplication({
          ...configuration(),
          actorId: adminId,
          expectedRevision: app.revision,
        }),
      ).toMatchObject({ ok: false, error: { code: 'principal_unavailable' } });
    }),
);

it('rejects foreign and missing actors and system mutations', async () => {
  await scoped(async () => {
    expect(
      await store.configureApplication({ ...configuration(), actorId: 'missing' }),
    ).toMatchObject({ ok: false, error: { code: 'principal_unavailable' } });
    expect(
      await store.configureApplication({ ...configuration(), actorId: '000000000000000000000003' }),
    ).toMatchObject({ ok: false, error: { code: 'principal_unavailable' } });
  }, 'other-org');
  await scoped(async () => {
    await expect(configure()).rejects.toThrow('tenant scope');
  }, SYSTEM_TENANT_ID);
});

it('keeps application identities immutable at the model boundary', async () =>
  scoped(async () => {
    await configure();
    await expect(
      createDiscordApplicationModel(db).updateOne(
        { applicationId },
        { $set: { tenantId: 'foreign' } },
      ),
    ).rejects.toThrow('Cross-tenant');
    await createDiscordApplicationModel(db).updateOne(
      { applicationId },
      {
        $set: {
          applicationId: '999',
          botUserId: '999',
          createdBy: adminId,
        },
      },
    );
    expect(await store.readApplication(applicationId)).toMatchObject({
      applicationId,
      tenantId,
      botUserId,
      createdBy: actorId,
    });
  }));

it('propagates database failures instead of reporting absence or expected conflicts', async () =>
  scoped(async () => {
    const unavailable = new Error('private database diagnostic');
    const spy = jest
      .spyOn(createDiscordApplicationModel(db).collection, 'findOne')
      .mockRejectedValueOnce(unavailable);
    await expect(store.readApplication(applicationId)).rejects.toBe(unavailable);
    spy.mockRestore();
    expect(await store.readApplication(applicationId)).toBeNull();
  }));
