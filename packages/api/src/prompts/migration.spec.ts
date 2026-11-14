import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import {
  AccessRoleIds,
  PrincipalType,
  PrincipalModel,
  ResourceType,
} from 'librechat-data-provider';
import type { IPromptGroupDocument } from '@librechat/data-schemas';
import type { Model } from 'mongoose';
import { checkPromptPermissionsMigration } from './migration';

let mongo: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;
let PromptGroupModel: Model<IPromptGroupDocument>;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
  await methods.seedDefaultRoles();
  PromptGroupModel = mongoose.models.PromptGroup as Model<IPromptGroupDocument>;
});

afterEach(async () => {
  await mongoose.models.PromptGroup.deleteMany({});
  await mongoose.models.AclEntry.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

function runCheck() {
  return checkPromptPermissionsMigration({ methods, mongoose, PromptGroupModel });
}

describe('checkPromptPermissionsMigration', () => {
  it('counts a native group without a USER ACL entry', async () => {
    const group = await PromptGroupModel.create({
      name: 'Native group',
      author: new Types.ObjectId(),
      authorName: 'Author',
      productionId: new Types.ObjectId(),
    });

    const result = await runCheck();

    expect(result.totalToMigrate).toBe(1);
    expect(result.privateGroups).toBe(1);
    expect(result.details?.privateGroups).toEqual([
      { name: 'Native group', _id: group._id.toString(), category: 'uncategorized' },
    ]);
  });

  it('does not count a Langfuse-source group', async () => {
    await PromptGroupModel.create({
      name: 'Langfuse group',
      author: new Types.ObjectId(),
      authorName: 'Langfuse Sync',
      source: 'langfuse',
      sourcePromptName: 'langfuse-prompt',
      sourceProjectId: 'project-1',
      sourceDestination: 'destination-1',
    });

    const result = await runCheck();

    expect(result.totalToMigrate).toBe(0);
    expect(result.details).toBeUndefined();
  });

  it('counts a legacy group with no source field, inserted without the schema default', async () => {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('No database connection');
    }
    const inserted = await db.collection('promptgroups').insertOne({
      name: 'Legacy group',
      author: new Types.ObjectId(),
      authorName: 'Legacy author',
    });
    const stored = await db
      .collection('promptgroups')
      .findOne({ _id: inserted.insertedId }, { projection: { source: 1 } });
    expect(stored).not.toHaveProperty('source');

    const result = await runCheck();

    expect(result.totalToMigrate).toBe(1);
    expect(result.details?.privateGroups).toEqual([
      { name: 'Legacy group', _id: inserted.insertedId.toString(), category: 'uncategorized' },
    ]);
  });

  it('excludes a native group that already has a USER ACL entry', async () => {
    const author = new Types.ObjectId();
    const group = await PromptGroupModel.create({
      name: 'Migrated group',
      author,
      authorName: 'Author',
      productionId: new Types.ObjectId(),
    });
    const ownerRole = await methods.findRoleByIdentifier(AccessRoleIds.PROMPTGROUP_OWNER);
    await mongoose.models.AclEntry.create({
      principalType: PrincipalType.USER,
      principalId: author,
      principalModel: PrincipalModel.USER,
      resourceType: ResourceType.PROMPTGROUP,
      resourceId: group._id,
      roleId: ownerRole?._id,
      grantedBy: author,
    });

    const result = await runCheck();

    expect(result.totalToMigrate).toBe(0);
  });
});
