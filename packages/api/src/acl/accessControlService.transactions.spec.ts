import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import { ResourceType, AccessRoleIds, PrincipalType } from 'librechat-data-provider';
import { createModels, createMethods, supportsTransactions } from '@librechat/data-schemas';
import { AccessControlService } from './accessControlService';

const backends = ['standalone', 'replica', ...(process.env.FERRETDB_URI ? ['ferret'] : [])];

describe.each(backends)('ACL updates on %s with secondaryPreferred defaults', (backend) => {
  const db = new mongoose.Mongoose();
  let server: MongoMemoryServer | MongoMemoryReplSet | undefined;
  let service: AccessControlService;
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
          ? await MongoMemoryReplSet.create({ replSet: { count: 1 } })
          : await MongoMemoryServer.create();
    }
    await db.connect(server?.getUri() ?? process.env.FERRETDB_URI!, {
      dbName: `acl_transactions_${randomUUID().replaceAll('-', '')}`,
      readPreference: 'secondaryPreferred',
      autoIndex: false,
    });
    createModels(db);
    await Promise.all(
      ['AclEntry', 'Role', 'ResourceLock'].map((name) => db.model(name).createIndexes()),
    );
    await createMethods(db).seedDefaultRoles();
    service = new AccessControlService(db);
  }, 60000);

  beforeEach(async () => {
    await db.model('AclEntry').deleteMany({});
  });

  afterAll(async () => {
    if (db.connection.readyState === 1) await db.connection.dropDatabase();
    await db.disconnect();
    await server?.stop();
  });

  it('detects the real capability and commits a permission update', async () => {
    await expect(supportsTransactions(db)).resolves.toBe(backend === 'replica');
    await service.bulkUpdateResourcePermissions(request);
    expect(await db.model('AclEntry').countDocuments({ resourceId, principalId: userId })).toBe(1);
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
    expect(await db.model('AclEntry').countDocuments({ resourceId, principalId: userId })).toBe(1);
  });

  if (backend === 'replica') {
    it('leaves a caller-owned transaction open for rollback', async () => {
      const session = await db.startSession();
      session.startTransaction({ readPreference: 'primary' });
      try {
        await service.bulkUpdateResourcePermissions({ ...request, session });
        expect(session.inTransaction()).toBe(true);
        expect(await db.model('AclEntry').countDocuments({ resourceId })).toBe(0);
        await session.abortTransaction();
        expect(await db.model('AclEntry').countDocuments({ resourceId })).toBe(0);
      } finally {
        await session.endSession();
      }
    });
  }
});
