import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import { ResourceType, AccessRoleIds, PrincipalType } from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  supportsTransactions,
  tenantStorage,
  RoleBits,
} from '@librechat/data-schemas';
import { AccessControlService } from './accessControlService';

const backends = ['standalone', 'replica', ...(process.env.FERRETDB_URI ? ['ferret'] : [])];

describe.each(backends)('ACL updates on %s with secondaryPreferred defaults', (backend) => {
  const db = new mongoose.Mongoose();
  let server: MongoMemoryServer | MongoMemoryReplSet | undefined;
  let service: AccessControlService;
  const roleReads: Array<{ address: string; inTransaction: boolean }> = [];
  const resourceId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const grantedBy = new mongoose.Types.ObjectId();
  const request = {
    resourceType: ResourceType.AGENT,
    resourceId,
    grantedBy,
    updatedPrincipals: [
      {
        type: PrincipalType.USER,
        id: userId.toString(),
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
      },
    ],
  };

  beforeAll(async () => {
    if (backend !== 'ferret') {
      server =
        backend === 'replica'
          ? await MongoMemoryReplSet.create({ replSet: { count: 2 } })
          : await MongoMemoryServer.create();
    }
    await db.connect(server?.getUri() ?? process.env.FERRETDB_URI!, {
      dbName: `acl_transactions_${randomUUID().replaceAll('-', '')}`,
      readPreference: 'secondaryPreferred',
      autoIndex: false,
      monitorCommands: true,
    });
    createModels(db);
    await Promise.all(
      ['AclEntry', 'AccessRole', 'Role', 'ResourceLock'].map((name) =>
        db.model(name).createIndexes(),
      ),
    );
    await createMethods(db).seedDefaultRoles();
    service = new AccessControlService(db);
    db.connection.getClient().on('commandStarted', (event) => {
      if (
        event.commandName === 'find' &&
        event.command.find === db.model('AccessRole').collection.name
      ) {
        roleReads.push({
          address: event.address,
          inTransaction: event.command.autocommit === false,
        });
      }
    });
  }, 60000);

  beforeEach(async () => {
    await db.model('AclEntry').deleteMany({});
    roleReads.length = 0;
  });

  afterAll(async () => {
    if (db.connection.readyState === 1) await db.connection.dropDatabase();
    await db.disconnect();
    await server?.stop();
  });

  it('detects the real capability and commits a permission update', async () => {
    await expect(supportsTransactions(db)).resolves.toBe(backend === 'replica');
    await service.bulkUpdateResourcePermissions(request);
    expect(
      await db
        .model('AclEntry')
        .countDocuments({ resourceId, principalId: userId })
        .read('primary'),
    ).toBe(1);
    if (backend === 'replica') {
      const hello = await db.connection
        .db!.admin()
        .command({ hello: 1 }, { readPreference: 'primary' });
      expect(roleReads).toEqual([{ address: hello.primary, inTransaction: true }]);
    }
  });

  it('keeps the existing permission when the audited write is refused', async () => {
    await service.bulkUpdateResourcePermissions(request);
    await expect(
      service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.AGENT,
        resourceId,
        grantedBy,
        revokedPrincipals: [{ type: PrincipalType.USER, id: userId.toString() }],
        beforeWrite: async () => {
          throw new Error('audit unavailable');
        },
      }),
    ).rejects.toThrow('audit unavailable');
    expect(
      await db
        .model('AclEntry')
        .countDocuments({ resourceId, principalId: userId })
        .read('primary'),
    ).toBe(1);
  });

  if (backend === 'replica') {
    it('leaves a caller-owned transaction open for rollback', async () => {
      const session = await db.startSession();
      session.startTransaction({ readPreference: 'primary' });
      try {
        await service.bulkUpdateResourcePermissions({ ...request, session });
        expect(session.inTransaction()).toBe(true);
        expect(await db.model('AclEntry').countDocuments({ resourceId }).read('primary')).toBe(0);
        await session.abortTransaction();
        expect(await db.model('AclEntry').countDocuments({ resourceId }).read('primary')).toBe(0);
      } finally {
        await session.endSession();
      }
    });
    it('resolves a tenant role override inside the caller-owned transaction', async () => {
      const tenantId = 'role-transaction';
      const session = await db.startSession();
      session.startTransaction({ readPreference: 'primary' });
      try {
        await tenantStorage.run({ tenantId }, async () => {
          await db.model('AccessRole').create(
            [
              {
                accessRoleId: AccessRoleIds.AGENT_VIEWER,
                name: 'Tenant viewer override',
                resourceType: ResourceType.AGENT,
                permBits: RoleBits.EDITOR,
                tenantId,
              },
            ],
            { session },
          );
          await service.bulkUpdateResourcePermissions({ ...request, session });
          const entry = await db
            .model('AclEntry')
            .findOne({ resourceId, principalId: userId })
            .session(session);
          expect(entry?.permBits).toBe(RoleBits.EDITOR);
          expect(session.inTransaction()).toBe(true);
        });
      } finally {
        await session.abortTransaction();
        await session.endSession();
      }
    });
  }
});
