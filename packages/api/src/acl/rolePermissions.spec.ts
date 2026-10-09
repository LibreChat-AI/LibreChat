import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  ResourceType,
  AccessRoleIds,
  PermissionBits,
  PrincipalModel,
  PrincipalType,
} from 'librechat-data-provider';
import {
  RoleBits,
  createModels,
  createMethods,
  tenantStorage,
  permissionBitSupersets,
} from '@librechat/data-schemas';
import type { IAclEntry } from '@librechat/data-schemas';
import type { Model } from 'mongoose';
import { AccessControlService } from './accessControlService';

let mongo: MongoMemoryServer;
let entries: Model<IAclEntry>;
let methods: ReturnType<typeof createMethods>;
let service: AccessControlService;
const resourceId = new Types.ObjectId();
const userId = new Types.ObjectId();
const grantedBy = new Types.ObjectId();
const filter = {
  principalType: PrincipalType.USER,
  principalId: userId,
  resourceType: ResourceType.AGENT,
  resourceId,
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  entries = mongoose.models.AclEntry as Model<IAclEntry>;
  methods = createMethods(mongoose);
  await methods.seedDefaultRoles();
});

beforeEach(async () => {
  await entries.deleteMany({});
  service = new AccessControlService(mongoose, methods);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

async function seed(permBits: number, tenantId?: string): Promise<void> {
  const role = await methods.findRoleByIdentifier(AccessRoleIds.AGENT_VIEWER);
  await entries.create({
    ...filter,
    principalModel: PrincipalModel.USER,
    permBits,
    roleId: role!._id,
    grantedBy,
    ...(tenantId && { tenantId }),
  });
}

function updateRole(accessRoleId = AccessRoleIds.AGENT_EDITOR) {
  return service.bulkUpdateResourcePermissions({
    resourceType: ResourceType.AGENT,
    resourceId,
    updatedPrincipals: [{ type: PrincipalType.USER, id: userId.toString(), accessRoleId }],
    grantedBy,
  });
}

describe('role-only ACL writes', () => {
  test.each([
    [AccessRoleIds.AGENT_VIEWER, RoleBits.VIEWER],
    [AccessRoleIds.AGENT_EDITOR, RoleBits.EDITOR],
    [AccessRoleIds.AGENT_OWNER, RoleBits.OWNER],
  ])('replaces role bits for every valid mask with %s', async (roleId, roleBits) => {
    const masks = permissionBitSupersets(0);
    for (const mask of masks) {
      await seed(mask);
    }
    const before = await entries.find(filter).sort({ _id: 1 }).lean();
    const result = await updateRole(roleId);
    const after = await entries.find(filter).sort({ _id: 1 }).lean();
    expect(after).toHaveLength(before.length);
    expect(after.map((entry) => entry.permBits)).toEqual(
      before.map((entry) => (entry.permBits & ~RoleBits.OWNER) | roleBits),
    );
    const role = await methods.findRoleByIdentifier(roleId);
    expect(after.every((entry) => entry.roleId?.toString() === role!._id.toString())).toBe(true);
    expect(result.insightsChanges).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test.each([
    { type: PrincipalType.USER, id: userId.toString(), model: PrincipalModel.USER },
    { type: PrincipalType.GROUP, id: new Types.ObjectId().toString(), model: PrincipalModel.GROUP },
    { type: PrincipalType.ROLE, id: 'USER', model: PrincipalModel.ROLE },
  ])(
    'initializes and updates a $type principal without granting Insights',
    async ({ type, id, model }) => {
      for (const accessRoleId of [AccessRoleIds.AGENT_OWNER, AccessRoleIds.AGENT_VIEWER]) {
        const result = await service.bulkUpdateResourcePermissions({
          resourceType: ResourceType.AGENT,
          resourceId,
          updatedPrincipals: [{ type, id, accessRoleId }],
          grantedBy,
        });
        expect(result.errors).toEqual([]);
        expect(result.insightsChanges).toEqual([]);
      }
      const after = await entries.find({ resourceId, principalType: type }).lean();
      expect(after).toHaveLength(1);
      expect(after[0].principalId?.toString()).toBe(id);
      expect(after[0].principalModel).toBe(model);
      expect(after[0].permBits).toBe(RoleBits.VIEWER);
    },
  );

  /**
   * Intercept the write where it reaches the driver, not at a package method:
   * the guarded write is issued from inside data-schemas, so a spy on the
   * methods object silently observes nothing and every race test would pass
   * while injecting nothing at all.
   */
  function raceBeforeWrite(between: () => Promise<unknown>, { once = true } = {}) {
    const real = entries.bulkWrite.bind(entries) as (...args: never[]) => Promise<never>;
    const impl = (async (...args: never[]) => {
      await between();
      return real(...args);
    }) as unknown as typeof entries.bulkWrite;
    const spy = jest.spyOn(entries, 'bulkWrite');
    return once ? spy.mockImplementationOnce(impl) : spy.mockImplementation(impl);
  }

  test('emits one guarded $set per entry and an identity-only insert', async () => {
    const spy = jest.spyOn(entries, 'bulkWrite');
    await updateRole();
    const insertOps = spy.mock.calls[spy.mock.calls.length - 1][0];
    await updateRole();
    const guardedOps = spy.mock.calls[spy.mock.calls.length - 1][0];

    expect(await entries.countDocuments(filter)).toBe(1);
    expect((await entries.findOne(filter))!.permBits).toBe(RoleBits.EDITOR);

    /** No entry yet: identity only, so a vanished grant is never inherited. */
    expect(insertOps).toHaveLength(1);
    expect(insertOps[0]).toMatchObject({
      updateOne: {
        filter,
        update: { $setOnInsert: { permBits: RoleBits.EDITOR } },
        upsert: true,
      },
    });

    /** Entry exists: compare-and-set on the observed value, metadata included. */
    expect(guardedOps).toHaveLength(1);
    const op = guardedOps[0] as {
      updateOne: {
        filter: Record<string, unknown>;
        update: { $set?: Record<string, unknown> };
        upsert?: boolean;
      };
    };
    expect(op.updateOne.filter).toHaveProperty('_id');
    expect(op.updateOne.filter.permBits).toBe(RoleBits.EDITOR);
    expect(op.updateOne.upsert).not.toBe(true);
    expect(op.updateOne.update).not.toHaveProperty('$bit');
    expect(Array.isArray(op.updateOne.update)).toBe(false);
    expect(op.updateOne.update.$set).toEqual(
      expect.objectContaining({ permBits: RoleBits.EDITOR, roleId: expect.anything() }),
    );
  });

  test.each([
    { label: 'grant', initial: 1, concurrent: 17, expected: 19 },
    { label: 'revocation', initial: 17, concurrent: 1, expected: 3 },
  ])(
    'preserves a concurrent Insights $label after the snapshot',
    async ({ initial, concurrent, expected }) => {
      await seed(initial);
      raceBeforeWrite(async () => {
        if (concurrent === null) await entries.deleteMany(filter);
        else await entries.updateMany(filter, { $set: { permBits: concurrent } });
      });
      const result = await updateRole();
      expect((await entries.findOne(filter))!.permBits).toBe(expected);
      expect(result.insightsChanges).toEqual([]);
      expect(result.errors).toEqual([]);
    },
  );

  test('never filters a permission write on an enumerated mask list', async () => {
    await seed(PermissionBits.VIEW | PermissionBits.VIEW_INSIGHTS);
    const spy = jest.spyOn(entries, 'bulkWrite');
    await updateRole();
    /**
     * The guard is the observed value, never a list of legal masks, so this
     * write needs no bit-operator or mask-enumeration support from the engine.
     */
    const payload = JSON.stringify(spy.mock.calls.map(([ops]) => ops));
    expect(payload).not.toContain('$in');
    expect(payload).not.toContain('$bit');
    expect((await entries.findOne(filter))!.permBits).toBe(19);
  });

  test('applies the role to an entry created after the read, without duplicating it', async () => {
    raceBeforeWrite(() => seed(PermissionBits.VIEW | PermissionBits.VIEW_INSIGHTS));
    await updateRole();
    /**
     * The identity upsert matched the entry that appeared instead of inserting,
     * so the role had not been applied; that is a miss, and the retry applies it
     * while keeping the Insights grant the other writer just made.
     */
    expect(await entries.countDocuments(filter)).toBe(1);
    expect((await entries.findOne(filter))!.permBits).toBe(19);
  });

  test('keeps explicit Insights upsert indices correct after expanded role-only writes', async () => {
    await seed(17);
    raceBeforeWrite(() => entries.deleteMany(filter));
    const result = await service.bulkUpdateResourcePermissions({
      resourceType: ResourceType.AGENT,
      resourceId,
      updatedPrincipals: [
        {
          type: PrincipalType.USER,
          id: new Types.ObjectId().toString(),
          accessRoleId: AccessRoleIds.AGENT_EDITOR,
        },
        {
          type: PrincipalType.USER,
          id: userId.toString(),
          accessRoleId: AccessRoleIds.AGENT_EDITOR,
          viewInsights: false,
        },
      ],
      grantedBy,
    });
    expect(result.insightsChanges).toEqual([
      expect.objectContaining({ action: 'removed', previousEntry: null }),
    ]);
    await service.restoreInsightsPermissionChanges({
      resourceType: ResourceType.AGENT,
      resourceId,
      changes: result.insightsChanges,
    });
    expect(await entries.findOne(filter)).toBeNull();
    expect(await entries.countDocuments({ resourceId })).toBe(1);
  });

  test('initializes missing legacy permission fields without inheriting Insights', async () => {
    await seed(1);
    await entries.collection.updateMany(filter, { $unset: { permBits: '' } });
    await updateRole();
    const after = await entries.find(filter).lean();
    expect(after).toHaveLength(1);
    expect(after[0].permBits).toBe(RoleBits.EDITOR);
  });

  test('applies the role even when a preserved bit changes mid-write (#16170 review)', async () => {
    await seed(RoleBits.OWNER | PermissionBits.VIEW_INSIGHTS);
    raceBeforeWrite(async () => {
      /** An admin revokes Insights between our read and our write. */
      await entries.updateMany(filter, { $set: { permBits: RoleBits.OWNER } });
    });
    const result = await service.bulkUpdateResourcePermissions({
      resourceType: ResourceType.AGENT,
      resourceId,
      updatedPrincipals: [
        {
          type: PrincipalType.USER,
          id: userId.toString(),
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
        },
      ],
      grantedBy,
    });
    expect(result.errors).toEqual([]);
    const entry = await entries.findOne(filter).lean();
    /** The downgrade lands: no retained owner bits, no resurrected Insights. */
    expect(entry!.permBits).toBe(RoleBits.VIEWER);
    const role = await methods.findRoleByIdentifier(AccessRoleIds.AGENT_VIEWER);
    expect(entry!.roleId?.toString()).toBe(role!._id.toString());
  });

  test('propagates failure before any write and permits an explicit retry', async () => {
    await seed(RoleBits.OWNER);
    await seed(RoleBits.OWNER | PermissionBits.VIEW_INSIGHTS);
    jest
      .spyOn(entries, 'bulkWrite')
      .mockImplementationOnce((() =>
        Promise.reject(
          new Error('injected write failure'),
        )) as unknown as typeof entries.bulkWrite);
    await expect(updateRole()).rejects.toThrow('injected write failure');
    const after = await entries.find(filter).lean();
    /** The whole batch failed, so both rows keep their pre-write state. */
    expect(after.map((entry) => entry.permBits).sort((a, b) => a - b)).toEqual([15, 31]);
    await updateRole();
    const retried = await entries.find(filter).lean();
    expect(retried.map((entry) => entry.permBits).sort((a, b) => a - b)).toEqual([3, 19]);
  });

  test('scopes every partition and the identity upsert to the active tenant', async () => {
    await seed(17, 'tenant-a');
    await seed(1, 'tenant-b');
    const result = await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
      await methods.seedDefaultRoles();
      return updateRole();
    });
    expect(result.errors).toEqual([]);
    const after = await entries.find(filter).sort({ tenantId: 1 }).lean();
    expect(after.map((entry) => [entry.tenantId, entry.permBits])).toEqual([
      ['tenant-a', 19],
      ['tenant-b', 1],
    ]);
  });

  test('does not resurrect an ACL deleted between read and write', async () => {
    await seed(17);
    const spy = raceBeforeWrite(() => entries.deleteMany(filter));
    await expect(updateRole()).rejects.toThrow('ACL deleted');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await entries.countDocuments(filter)).toBe(0);
  });

  test('does not replay completed entries when a later duplicate conflicts', async () => {
    await seed(1);
    await seed(17);
    const before = await entries.find(filter).sort({ _id: 1 }).lean();
    const real = entries.bulkWrite.bind(entries);
    let calls = 0;
    const intercept = (async (...args: Parameters<typeof real>) => {
      calls++;
      if (calls === 2) {
        // Revoke the already-completed row, and make only the second CAS miss.
        await entries.deleteOne({ _id: before[0]._id });
        await entries.updateOne({ _id: before[1]._id }, { $set: { permBits: 1 } });
      }
      return real(...args);
    }) as unknown as typeof entries.bulkWrite;
    const spy = jest.spyOn(entries, 'bulkWrite').mockImplementation(intercept);
    const result = await updateRole();
    expect(result.errors).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(await entries.findById(before[0]._id)).toBeNull();
    expect((await entries.findById(before[1]._id))!.permBits).toBe(3);
    expect(await entries.countDocuments(filter)).toBe(1);
  });

  test('reports completed entries after a real partial failure without replaying them', async () => {
    await seed(15);
    await seed(31);
    const real = entries.bulkWrite.bind(entries);
    let calls = 0;
    const intercept = (async (...args: Parameters<typeof real>) => {
      if (++calls === 2) throw new Error('injected second-write failure');
      return real(...args);
    }) as unknown as typeof entries.bulkWrite;
    jest.spyOn(entries, 'bulkWrite').mockImplementation(intercept);
    await expect(updateRole()).rejects.toMatchObject({ completedEntries: 1 });
    expect(calls).toBe(2);
    const after = await entries.find(filter).sort({ _id: 1 }).lean();
    expect(after.map((entry) => entry.permBits)).toEqual([3, 31]);
    const storedRole = await mongoose.models.AccessRole.findById(after[0].roleId).lean<{
      permBits: number;
    }>();
    expect(storedRole!.permBits).toBe(3);
  });

  test('reads from primary even with a nontransactional secondaryPreferred session', async () => {
    await seed(17);
    const session = await mongoose.startSession();
    const find = jest.spyOn(entries, 'find');
    try {
      await methods.replaceRoleBits(
        [
          {
            filter,
            insert: {},
            roleBits: 3,
            metadata: {},
          },
        ],
        { session },
      );
      expect(session.inTransaction()).toBe(false);
      expect(find.mock.results.length).toBeGreaterThan(0);
      for (const result of find.mock.results) {
        expect(result.value.getOptions().readPreference.mode).toBe('primary');
      }
    } finally {
      await session.endSession();
    }
  });

  test.each([NaN, Infinity, -1, 0, 1.5, 101])(
    'rejects invalid retry budget %s before writing',
    async (maxAttempts) => {
      const spy = jest.spyOn(entries, 'bulkWrite');
      await expect(methods.replaceRoleBits([], { maxAttempts })).rejects.toThrow();
      expect(spy).not.toHaveBeenCalled();
    },
  );

  test('honors a supplied one-attempt budget', async () => {
    await seed(17);
    const spy = raceBeforeWrite(() => entries.updateMany(filter, { $set: { permBits: 1 } }));
    await expect(
      methods.replaceRoleBits([{ filter, insert: {}, roleBits: 3, metadata: {} }], {
        maxAttempts: 1,
      }),
    ).rejects.toThrow('after 1 attempts');
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await entries.findOne(filter))!.permBits).toBe(1);
  });

  test.each([null, -1, 1.5, 4294967297])(
    'rejects malformed stored permissions %s without truncating',
    async (permBits) => {
      await seed(1);
      await entries.collection.updateMany(filter, { $set: { permBits } });
      const spy = jest.spyOn(entries, 'bulkWrite');
      await expect(updateRole()).rejects.toThrow('Invalid permBits');
      expect(spy).not.toHaveBeenCalled();
      expect((await entries.collection.findOne(filter))!.permBits).toBe(permBits);
    },
  );

  test('serializes two overlapping add/remove requests without accumulating both grants', async () => {
    await seed(1);
    const spy = raceBeforeWrite(async () => {
      const b = await methods.modifyPermissionBits(
        PrincipalType.USER,
        userId,
        ResourceType.AGENT,
        resourceId,
        4,
        2,
      );
      expect(b!.permBits).toBe(5);
    });
    const a = await methods.modifyPermissionBits(
      PrincipalType.USER,
      userId,
      ResourceType.AGENT,
      resourceId,
      2,
      4,
    );
    expect(spy).toHaveBeenCalledTimes(3);
    expect(a!.permBits).toBe(3);
    expect((await entries.findOne(filter))!.permBits).toBe(3);
  });

  test('removal wins when add/remove masks overlap', async () => {
    await seed(17);
    const result = await methods.modifyPermissionBits(
      PrincipalType.USER,
      userId,
      ResourceType.AGENT,
      resourceId,
      3,
      2,
    );
    expect(result!.permBits).toBe(17);
  });

  test('keeps all guarded writes inside a caller-owned transaction', async () => {
    const replica = await MongoMemoryReplSet.create({
      replSet: { count: 1 },
      instanceOpts: [{ args: ['--nounixsocket'] }],
    });
    const connection = new mongoose.Mongoose();
    try {
      await connection.connect(replica.getUri());
      createModels(connection);
      const transactionMethods = createMethods(connection);
      await transactionMethods.seedDefaultRoles();
      const transactionService = new AccessControlService(connection, transactionMethods);
      const acl = connection.models.AclEntry as Model<IAclEntry>;
      const role = await transactionMethods.findRoleByIdentifier(AccessRoleIds.AGENT_VIEWER);
      await acl.create({
        ...filter,
        principalModel: PrincipalModel.USER,
        permBits: 17,
        roleId: role!._id,
        grantedBy,
      });
      /**
       * `createModels` schedules autoIndex builds and the insert above creates
       * the collection; both are catalog changes. A transaction that starts
       * while one is still in flight aborts with a transient "Unable to write
       * to collection ... due to catalog changes" error, so let the models this
       * transaction touches finish building before opening the session.
       */
      await Promise.all([acl.init(), connection.models.AccessRole.init()]);
      const session = await connection.startSession();
      try {
        session.startTransaction();
        const result = await transactionService.bulkUpdateResourcePermissions({
          resourceType: ResourceType.AGENT,
          resourceId,
          updatedPrincipals: [
            {
              type: PrincipalType.USER,
              id: userId.toString(),
              accessRoleId: AccessRoleIds.AGENT_EDITOR,
            },
          ],
          grantedBy,
          session,
        });
        expect(result.errors).toEqual([]);
        expect((await acl.findOne(filter).session(session))!.permBits).toBe(19);
        await session.abortTransaction();
        expect((await acl.findOne(filter))!.permBits).toBe(17);
      } finally {
        await session.endSession();
      }
    } finally {
      await connection.disconnect();
      await replica.stop();
    }
  }, 30000);

  test('keeps role bits and metadata consistent under two concurrent role updates', async () => {
    await seed(RoleBits.OWNER | PermissionBits.VIEW_INSIGHTS);
    const viewer = await methods.findRoleByIdentifier(AccessRoleIds.AGENT_VIEWER);
    raceBeforeWrite(() =>
      /** A competing Viewer request lands atomically between our read and write. */
      entries.updateMany(filter, {
        $set: {
          permBits: RoleBits.VIEWER | PermissionBits.VIEW_INSIGHTS,
          roleId: viewer!._id,
        },
      }),
    );

    const result = await updateRole(AccessRoleIds.AGENT_EDITOR);
    expect(result.errors).toEqual([]);

    const entry = (await entries.findOne(filter).lean())!;
    /**
     * One logical winner: the stored role bits and the stored role reference
     * cannot disagree. Resolved through the reference rather than compared to a
     * freshly looked-up role, so repeated seeding cannot mask a divergence.
     */
    expect(entry.permBits & RoleBits.OWNER).toBe(RoleBits.EDITOR);
    const storedRole = await mongoose.models.AccessRole.findById(entry.roleId).lean<{
      accessRoleId: string;
      permBits: number;
    }>();
    expect(storedRole?.accessRoleId).toBe(AccessRoleIds.AGENT_EDITOR);
    expect(entry.permBits & RoleBits.OWNER).toBe(storedRole!.permBits & RoleBits.OWNER);
    expect(entry.permBits & PermissionBits.VIEW_INSIGHTS).toBe(PermissionBits.VIEW_INSIGHTS);
  });

  test('reports failure, not success, when the guard never holds', async () => {
    await seed(RoleBits.OWNER | PermissionBits.VIEW_INSIGHTS);
    const viewer = await methods.findRoleByIdentifier(AccessRoleIds.AGENT_VIEWER);
    let round = 0;
    raceBeforeWrite(
      () =>
        /** A different value every attempt, so no guard can ever match. */
        entries.updateMany(filter, {
          $set: {
            permBits: PermissionBits.VIEW_INSIGHTS | (round++ % 2 === 0 ? 1 : 2),
            roleId: viewer!._id,
          },
        }),
      { once: false },
    );

    await expect(updateRole()).rejects.toThrow(/permBits|attempt/i);
    const entry = (await entries.findOne(filter).lean())!;
    /** Failed loudly and left the competing writer's state intact. */
    expect(entry.roleId?.toString()).toBe(viewer!._id.toString());
    expect([17, 18]).toContain(entry.permBits);
  });

  test('preserves stored bits outside the known permission enum', async () => {
    const role = await methods.findRoleByIdentifier(AccessRoleIds.AGENT_VIEWER);
    /** Written past the schema validator, as a legacy or external writer could. */
    await entries.collection.insertOne({
      ...filter,
      principalModel: PrincipalModel.USER,
      permBits: PermissionBits.VIEW | 64,
      roleId: role!._id,
      grantedBy,
      grantedAt: new Date(),
    });

    await updateRole();

    const entry = (await entries.findOne(filter).lean())!;
    expect(entry.permBits & RoleBits.OWNER).toBe(RoleBits.EDITOR);
    expect(entry.permBits & 64).toBe(64);
  });
});
