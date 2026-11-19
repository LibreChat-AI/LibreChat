import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { DiscordStorageResult, DiscordInstallationStorage } from './discord';
import { createDiscordApplicationModel, createDiscordGuildModel } from '~/models/discord';
import { createDiscordInstallationStorage, touchDiscordInstallation } from './discord';
import { tenantStorage, runAsSystem, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createDiscordReservationModel } from '~/models/discordReservation';
import { retireDiscordReservation } from './discordReservation';
import { withRequiredTransaction } from '~/utils/transactions';
import { closeResponseScopes } from './responseScope';
import { createUserModel } from '~/models/user';

const db = new mongoose.Mongoose();
let mongo: MongoMemoryReplSet;
let store: DiscordInstallationStorage;
const applicationId = '123456789012345678';
const botUserId = '123456789012345679';
const guildId = '123456789012345680';
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
const connect = async () => {
  const app = await configure();
  return value(
    await store.connectGuild({
      actorId,
      applicationId,
      applicationRevision: app.revision,
      guildId,
      guildName: 'Sandbox',
    }),
  );
};

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
    expect(await store.readGuild('missing')).toBeNull();
  }));

it('rotates credentials with CAS without invalidating guild consent', async () =>
  scoped(async () => {
    const guild = await connect();
    const app = (await store.readApplication(applicationId))!;
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
    expect(await store.readGuild(guild.installationId)).toEqual(guild);
    expect(
      await store.configureApplication({ ...configuration(), expectedRevision: app.revision }),
    ).toMatchObject({ ok: false, error: { code: 'application_changed' } });
    expect(
      await store.connectGuild({
        actorId,
        applicationId,
        applicationRevision: app.revision,
        guildId: '123456789012345681',
        guildName: 'Old flow',
      }),
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

it('supports several guilds per application and rejects stale or retargeted installation writes', async () =>
  scoped(async () => {
    const one = await connect();
    const app = (await store.readApplication(applicationId))!;
    const two = value(
      await store.connectGuild({
        actorId,
        applicationId,
        applicationRevision: app.revision,
        guildId: '123456789012345681',
        guildName: 'Second',
      }),
    );
    expect(two.installationId).not.toBe(one.installationId);
    const input = {
      actorId,
      applicationId,
      applicationRevision: app.revision,
      guildId,
      guildName: 'Reinstall',
    };
    expect(await store.connectGuild(input)).toMatchObject({
      ok: false,
      error: { code: 'installation_changed' },
    });
    expect(
      await store.connectGuild({
        ...input,
        installationId: two.installationId,
        expectedRevision: one.revision,
      }),
    ).toMatchObject({ ok: false, error: { code: 'installation_changed' } });
    const reconnected = value(
      await store.connectGuild({
        ...input,
        installationId: one.installationId,
        expectedRevision: one.revision,
      }),
    );
    expect(reconnected.installationId).toBe(one.installationId);
    expect(reconnected.createdBy).toBe(one.createdBy);
    expect(reconnected.revision).not.toBe(one.revision);
    const firstPage = await store.listGuilds(undefined, 1);
    expect(firstPage.guilds).toHaveLength(1);
    const lastPage = await store.listGuilds(firstPage.next, 1);
    expect(lastPage.guilds).toHaveLength(1);
    expect(firstPage.guilds[0].installationId).not.toBe(lastPage.guilds[0].installationId);
  }));

it('fences disconnect and reconnect with exact installation consent and provider scope', async () =>
  scoped(async () => {
    const guild = await connect();
    const app = (await store.readApplication(applicationId))!;
    const scope = {
      tenantId,
      applicationId,
      guildId,
      installationId: guild.installationId,
      expectedRevision: guild.revision,
      expectedApplicationRevision: app.revision,
    };
    const touch = (overrides = {}) =>
      withRequiredTransaction(db, (session) =>
        touchDiscordInstallation(db, { ...scope, ...overrides }, session),
      );
    expect(await touch()).toBe(true);
    expect(await touch({ expectedApplicationRevision: '' })).toBe(false);
    expect(await touch({ guildId: '999' })).toBe(false);
    expect(await touch({ applicationId: '999' })).toBe(false);
    expect(await touch({ installationId: 'foreign' })).toBe(false);
    await expect(touch({ tenantId: 'foreign' })).rejects.toThrow(TypeError);
    expect(
      await store.disconnectGuild({
        actorId,
        installationId: guild.installationId,
        expectedRevision: 'old',
      }),
    ).toMatchObject({ ok: false, error: { code: 'installation_changed' } });
    const disconnected = value(
      await store.disconnectGuild({
        actorId,
        installationId: guild.installationId,
        expectedRevision: guild.revision,
      }),
    );
    expect(disconnected.status).toBe('disconnected');
    expect(await touch()).toBe(false);
    const reconnected = value(
      await store.connectGuild({
        actorId,
        applicationId,
        applicationRevision: app.revision,
        installationId: guild.installationId,
        expectedRevision: disconnected.revision,
        guildId,
        guildName: 'Sandbox',
      }),
    );
    expect(await touch()).toBe(false);
    expect(await touch({ expectedRevision: reconnected.revision })).toBe(true);
  }));

it.each(['closed', 'deleting', 'deleted'])(
  'blocks %s application owners while allowing another active admin to disconnect',
  async (mode) =>
    scoped(async () => {
      const guild = await connect();
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
      expect(
        await store.connectGuild({
          actorId: adminId,
          applicationId,
          applicationRevision: app.revision,
          guildId: '999',
          guildName: 'Other',
        }),
      ).toMatchObject({ ok: false, error: { code: 'principal_unavailable' } });
      expect(
        await withRequiredTransaction(db, (session) =>
          touchDiscordInstallation(
            db,
            {
              tenantId,
              applicationId,
              guildId,
              installationId: guild.installationId,
              expectedRevision: guild.revision,
              expectedApplicationRevision: app.revision,
            },
            session,
          ),
        ),
      ).toBe(false);
      expect(
        await store.disconnectGuild({
          actorId: adminId,
          installationId: guild.installationId,
          expectedRevision: guild.revision,
        }),
      ).toMatchObject({ ok: true, value: { status: 'disconnected' } });
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
    await expect(store.listGuilds()).rejects.toThrow('tenant scope');
  }, SYSTEM_TENANT_ID);
});

it('keeps application and installation identities immutable at the model boundary', async () =>
  scoped(async () => {
    const guild = await connect();
    await expect(
      createDiscordApplicationModel(db).updateOne(
        { applicationId },
        { $set: { tenantId: 'foreign' } },
      ),
    ).rejects.toThrow('Cross-tenant');
    await expect(
      createDiscordGuildModel(db).updateOne(
        { installationId: guild.installationId },
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
    await createDiscordGuildModel(db).updateOne(
      { installationId: guild.installationId },
      {
        $set: {
          installationId: 'foreign',
          applicationId: '999',
          guildId: '999',
          createdBy: adminId,
        },
      },
    );
    expect(await store.readGuild(guild.installationId)).toEqual(guild);
  }));

it('serializes concurrent installs without duplicate provider ownership', async () =>
  scoped(async () => {
    const app = await configure();
    const input = {
      actorId,
      applicationId,
      applicationRevision: app.revision,
      guildId,
      guildName: 'Sandbox',
    };
    const results = await Promise.all([store.connectGuild(input), store.connectGuild(input)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: { code: 'installation_changed' } },
    ]);
    expect((await store.listGuilds()).guilds).toHaveLength(1);
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

it('fences the guild installer independently from the application owner', async () =>
  scoped(async () => {
    const app = await configure();
    const guild = value(
      await store.connectGuild({
        actorId: adminId,
        applicationId,
        applicationRevision: app.revision,
        guildId,
        guildName: 'Sandbox',
      }),
    );
    await closeResponseScopes(db, { userId: adminId, tenantId });
    expect(
      await withRequiredTransaction(db, (session) =>
        touchDiscordInstallation(
          db,
          {
            tenantId,
            installationId: guild.installationId,
            applicationId,
            guildId,
            expectedRevision: guild.revision,
            expectedApplicationRevision: app.revision,
          },
          session,
        ),
      ),
    ).toBe(false);
  }));

it('rejects foreign installation reads and mutations', async () => {
  const guild = await scoped(connect);
  await scoped(async () => {
    await createUserModel(db).create({
      _id: '000000000000000000000003',
      email: 'foreign@example.test',
      provider: 'local',
      tenantId: 'other-org',
    });
    expect(await store.readGuild(guild.installationId)).toBeNull();
    expect(await store.listGuilds()).toEqual({ guilds: [] });
    expect(
      await store.disconnectGuild({
        actorId: '000000000000000000000003',
        installationId: guild.installationId,
        expectedRevision: guild.revision,
      }),
    ).toMatchObject({ ok: false, error: { code: 'installation_changed' } });
  }, 'other-org');
  expect((await scoped(() => store.readGuild(guild.installationId)))?.status).toBe('active');
});

it.each(['credentials', 'public_key'])(
  'rejects stale application authority after %s rotation without changing guild consent',
  async (rotation) =>
    scoped(async () => {
      const guild = await connect();
      const app = (await store.readApplication(applicationId))!;
      const scope = {
        tenantId,
        installationId: guild.installationId,
        applicationId,
        guildId,
        expectedRevision: guild.revision,
        expectedApplicationRevision: app.revision,
      };
      const rotated = value(
        await store.configureApplication({
          ...configuration(),
          expectedRevision: app.revision,
          ...(rotation === 'credentials'
            ? { encryptedBotToken: 'rotated-token' }
            : { publicKey: 'b'.repeat(64) }),
        }),
      );
      expect(await store.readGuild(guild.installationId)).toEqual(guild);
      expect(
        await withRequiredTransaction(db, (session) =>
          touchDiscordInstallation(db, scope, session),
        ),
      ).toBe(false);
      expect(
        await withRequiredTransaction(db, (session) =>
          touchDiscordInstallation(
            db,
            {
              ...scope,
              expectedApplicationRevision: rotated.revision,
            },
            session,
          ),
        ),
      ).toBe(true);
      expect(await store.readGuild(guild.installationId)).toMatchObject({
        installationId: guild.installationId,
        applicationId,
        guildId,
        createdBy: guild.createdBy,
        status: 'active',
        revision: guild.revision,
      });
    }),
);

it('retains only organization reservation metadata and permits fresh same-tenant recovery', async () => {
  await scoped(async () => {
    const guild = await connect();
    await withRequiredTransaction(db, async (session) => {
      await retireDiscordReservation(db, applicationId, session);
      await createDiscordApplicationModel(db).deleteOne({ applicationId }, { session });
      return true;
    });
    const reservation = await createDiscordReservationModel(db).findOne({ applicationId }).lean();
    expect(reservation).toMatchObject({ tenantId, applicationId, retiring: true });
    expect(reservation).not.toHaveProperty('createdBy');
    expect(JSON.stringify(reservation)).not.toContain('encrypted');
    expect(
      await store.configureApplication({ ...configuration(), actorId: adminId }),
    ).toMatchObject({
      ok: false,
      error: { code: 'application_unavailable' },
    });
    await createDiscordGuildModel(db).deleteOne({ installationId: guild.installationId });
  });
  await scoped(async () => {
    await createUserModel(db).create({
      _id: '000000000000000000000003',
      provider: 'local',
      email: 'foreign@example.test',
      tenantId: 'other-org',
    });
    expect(
      await store.configureApplication({ ...configuration(), actorId: '000000000000000000000003' }),
    ).toMatchObject({ ok: false, error: { code: 'application_in_use' } });
  }, 'other-org');
  await scoped(async () => {
    const recovered = value(
      await store.configureApplication({ ...configuration(), actorId: adminId }),
    );
    expect(recovered.createdBy).toBe(adminId);
    expect(
      (await createDiscordReservationModel(db).findOne({ applicationId }).lean())?.retiring,
    ).toBe(false);
  });
});
