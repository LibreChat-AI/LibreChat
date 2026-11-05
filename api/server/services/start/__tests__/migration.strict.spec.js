const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  logger,
  createModels,
  createMethods,
  runAsSystem,
  tenantStorage,
  getTenantId,
} = require('@librechat/data-schemas');
const { PrincipalType, ResourceType } = require('librechat-data-provider');

jest.mock('../../../../../config/connect', () => jest.fn().mockResolvedValue(true));

const { checkMigrations } = require('../migration');
const {
  migrateAgentPermissionsEnhanced,
} = require('../../../../../config/migrate-agent-permissions');
const {
  migrateToPromptGroupPermissions,
} = require('../../../../../config/migrate-prompt-permissions');

let mongo;
let methods;
let resources;
const originalStrict = process.env.TENANT_ISOLATION_STRICT;

beforeAll(async () => {
  process.env.TENANT_ISOLATION_STRICT = 'true';
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
  await runAsSystem(async () => methods.seedDefaultRoles());
});

beforeEach(async () => {
  await runAsSystem(async () => {
    await Promise.all([
      mongoose.models.Agent.deleteMany({}),
      mongoose.models.PromptGroup.deleteMany({}),
      mongoose.models.AclEntry.deleteMany({}),
      mongoose.connection.db.collection('projects').deleteMany({}),
    ]);
  });
  resources = [];
  for (const tenantId of [undefined, 'tenant-a', 'tenant-b']) {
    const create = async () => {
      const author = new mongoose.Types.ObjectId();
      const agent = await mongoose.models.Agent.create({
        id: `agent-${tenantId ?? 'platform'}`,
        name: 'Legacy agent',
        author,
        provider: 'openAI',
        model: 'gpt-4',
        isCollaborative: true,
      });
      const group = await mongoose.models.PromptGroup.create({
        name: 'Legacy prompt group',
        author,
        authorName: 'Author',
        productionId: new mongoose.Types.ObjectId(),
      });
      resources.push({ agent, group, tenantId, author });
    };
    if (tenantId) {
      await tenantStorage.run({ tenantId }, create);
    } else {
      await runAsSystem(create);
    }
  }
  await mongoose.connection.db.collection('projects').insertOne({
    name: 'instance',
    agentIds: resources.map(({ agent }) => agent.id),
    promptGroupIds: resources.map(({ group }) => group._id),
  });
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  if (originalStrict === undefined) {
    delete process.env.TENANT_ISOLATION_STRICT;
  } else {
    process.env.TENANT_ISOLATION_STRICT = originalStrict;
  }
});

it.each([undefined, 'tenant-a'])(
  'checks every tenant under strict isolation (caller: %s)',
  async (tenantId) => {
    const warn = jest.spyOn(logger, 'warn');
    const error = jest.spyOn(logger, 'error');
    await tenantStorage.run({ tenantId }, async () => {
      await checkMigrations();
      expect(getTenantId()).toBe(tenantId);
    });

    expect(warn).toHaveBeenCalledWith(
      'Agent permissions migration required',
      expect.objectContaining({ totalToMigrate: 3, globalViewAccess: 3 }),
    );
    expect(warn).toHaveBeenCalledWith(
      'Prompt permissions migration required',
      expect.objectContaining({ totalToMigrate: 3, globalViewAccess: 3 }),
    );
    expect(error).not.toHaveBeenCalled();
  },
);

it.each([
  ['agents', migrateAgentPermissionsEnhanced, ResourceType.AGENT, 'agent'],
  ['prompt groups', migrateToPromptGroupPermissions, ResourceType.PROMPTGROUP, 'group'],
])(
  'migrates %s into each resource tenant, not the system partition',
  async (_name, migrate, resourceType, resourceKey) => {
    const preview = await migrate({ dryRun: true });
    expect(preview.summary.total).toBe(3);
    expect(await runAsSystem(async () => mongoose.models.AclEntry.countDocuments({}))).toBe(0);

    const result = await migrate({ dryRun: false });
    expect(result).toMatchObject({ migrated: 3, errors: 0, ownerGrants: 3 });
    for (const resource of resources) {
      const entries = await runAsSystem(async () =>
        mongoose.models.AclEntry.find({
          resourceType,
          resourceId: resource[resourceKey]._id,
        }).lean(),
      );
      expect(entries).toHaveLength(2);
      for (const entry of entries) {
        expect(entry.tenantId).toBe(resource.tenantId);
      }
      expect(
        entries.find((entry) => entry.principalType === PrincipalType.USER).principalId,
      ).toEqual(resource.author);
      expect(entries.some((entry) => entry.principalType === PrincipalType.PUBLIC)).toBe(true);
    }
    const rerun = await migrate({ dryRun: false });
    expect(rerun).toMatchObject({ migrated: 0, errors: 0 });
  },
);
