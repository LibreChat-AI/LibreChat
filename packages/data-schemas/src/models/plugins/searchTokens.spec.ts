import mongoose from 'mongoose';
import { PrincipalType } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type * as t from '~/types';
import { createUserGroupMethods } from '~/methods/userGroup';
import { tenantStorage } from '~/config/tenantContext';
import { buildUserSearchFilter } from '~/utils/search';
import { createModels } from '~/models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const TOKENS = '+nameTokens +emailTokens +usernameTokens';

let mongoServer: MongoMemoryServer;
let User: mongoose.Model<t.IUser>;
let Group: mongoose.Model<t.IGroup>;
let methods: ReturnType<typeof createUserGroupMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  const models = createModels(mongoose);
  User = models.User;
  Group = models.Group as mongoose.Model<t.IGroup>;
  methods = createUserGroupMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

const user = (name: string, email: string, username = '', extra: Partial<t.IUser> = {}) => ({
  name,
  email,
  username,
  provider: 'local',
  ...extra,
});

async function tokensOf(id: unknown) {
  return User.findById(id).select(TOKENS).lean<t.IUser>();
}

async function userNames(query: string, limit = 10): Promise<string[]> {
  const results = await methods.searchPrincipals(query, limit, [PrincipalType.USER]);
  return results.map((r) => r.name ?? '').sort();
}

describe('search token write paths', () => {
  it('derives tokens on create and on save of a changed name', async () => {
    const doc = await User.create(user('José Álvarez', 'Jose.Alvarez@Example.org', 'jalvarez'));
    expect(await tokensOf(doc._id)).toMatchObject({
      nameTokens: ['jose', 'alvarez'],
      emailTokens: ['jose.alvarez@example.org', 'jose', 'alvarez', 'example', 'org'],
      usernameTokens: ['jalvarez'],
    });

    doc.name = 'Joe Bloggs';
    await doc.save();
    const saved = await tokensOf(doc._id);
    expect(saved?.nameTokens).toEqual(['joe', 'bloggs']);
    expect(saved?.usernameTokens).toEqual(['jalvarez']);
  });

  it('updates tokens through findOneAndUpdate, findByIdAndUpdate, updateOne and updateMany', async () => {
    const [a, b] = await User.create([user('Ann A', 'a@x.io'), user('Ben B', 'b@x.io')]);

    await User.findOneAndUpdate({ _id: a._id }, { $set: { name: 'Carla Diaz' } });
    expect((await tokensOf(a._id))?.nameTokens).toEqual(['carla', 'diaz']);

    await User.findByIdAndUpdate(a._id, { email: 'carla@new.dev' });
    expect((await tokensOf(a._id))?.emailTokens).toEqual(['carla@new.dev', 'carla', 'new', 'dev']);

    await User.updateOne({ _id: b._id }, { $set: { username: 'ben_b' } });
    expect((await tokensOf(b._id))?.usernameTokens).toEqual(['ben_b', 'ben', 'b']);

    await User.updateMany({}, { $unset: { name: '' } });
    expect((await tokensOf(a._id))?.nameTokens).toEqual([]);
    expect((await tokensOf(b._id))?.nameTokens).toEqual([]);
  });

  it('sets tokens on upsert inserts and insertMany', async () => {
    await User.updateOne(
      { email: 'new@x.io' },
      { $setOnInsert: { name: 'New Person', email: 'new@x.io', provider: 'local' } },
      { upsert: true },
    );
    const upserted = await User.findOne({ email: 'new@x.io' }).select(TOKENS).lean<t.IUser>();
    expect(upserted?.nameTokens).toEqual(['new', 'person']);
    expect(upserted?.usernameTokens).toEqual([]);

    await User.updateOne(
      { email: 'filter@x.io' },
      { $set: { name: 'From Filter', provider: 'local' } },
      { upsert: true },
    );
    const fromFilter = await User.findOne({ email: 'filter@x.io' }).select(TOKENS).lean<t.IUser>();
    expect(fromFilter?.emailTokens).toEqual(['filter@x.io', 'filter', 'x', 'io']);

    await User.insertMany([user('Many One', 'one@x.io', 'm1')]);
    const inserted = await User.findOne({ email: 'one@x.io' }).select(TOKENS).lean<t.IUser>();
    expect(inserted?.nameTokens).toEqual(['many', 'one']);
    expect(inserted?.usernameTokens).toEqual(['m1']);
  });

  it('keeps tokens out of default reads', async () => {
    const doc = await User.create(user('Hidden Tokens', 'h@x.io'));
    const plain = await User.findById(doc._id).lean<t.IUser>();
    expect(plain).not.toHaveProperty('nameTokens');
  });

  it('updates group tokens through create, upsertGroupByExternalId and updateGroupById', async () => {
    const group = await methods.createGroup({ name: 'Core Platform', source: 'local' });
    const read = () =>
      Group.findById(group._id).select('+nameTokens +emailTokens').lean<t.IGroup>();
    expect((await read())?.nameTokens).toEqual(['core', 'platform']);

    await methods.updateGroupById(group._id, { name: 'Data Science', email: 'ds@corp.io' });
    expect(await read()).toMatchObject({
      nameTokens: ['data', 'science'],
      emailTokens: ['ds@corp.io', 'ds', 'corp', 'io'],
    });

    const entra = await methods.upsertGroupByExternalId('ext-1', 'entra', { name: 'Sales EMEA' });
    const entraTokens = await Group.findById(entra?._id).select('+nameTokens').lean<t.IGroup>();
    expect(entraTokens?.nameTokens).toEqual(['sales', 'emea']);
    expect(await Group.countDocuments({ _id: entra?._id, emailTokens: { $exists: true } })).toBe(1);
  });

  it('keeps tokens when an update assigns undefined to a source field', async () => {
    const doc = await User.create(user('Kept Name', 'kept@x.io'));
    await User.findByIdAndUpdate(doc._id, { $set: { name: undefined, role: 'ADMIN' } });
    const stored = await User.findById(doc._id).select(`name ${TOKENS}`).lean<t.IUser>();
    expect(stored?.name).toBe('Kept Name');
    expect(stored?.nameTokens).toEqual(['kept', 'name']);
  });
});

describe('searchPrincipals word-prefix search', () => {
  beforeEach(async () => {
    await User.create([
      user('John Smith', 'john.smith@acme.com', 'jsmith'),
      user('Johanna Müller', 'jm@globex.io', 'hanna_m'),
      user('Bob Johnson', 'bob@initech.net', 'bobby'),
      user('Zoë Ng', 'zoe@acme.com', 'zng'),
    ]);
  });

  it('matches the prefix of a first name, a last name, an email word, a domain and a username', async () => {
    expect(await userNames('joh')).toEqual(['Bob Johnson', 'Johanna Müller', 'John Smith']);
    expect(await userNames('smi')).toEqual(['John Smith']);
    expect(await userNames('mull')).toEqual(['Johanna Müller']);
    expect(await userNames('acme')).toEqual(['John Smith', 'Zoë Ng']);
    expect(await userNames('hanna')).toEqual(['Johanna Müller']);
    expect(await userNames('john.smith@ac')).toEqual(['John Smith']);
  });

  it('requires every query token, across fields', async () => {
    expect(await userNames('john smi')).toEqual(['John Smith']);
    expect(await userNames('smith john')).toEqual(['John Smith']);
    expect(await userNames('jo acme')).toEqual(['John Smith']);
    expect(await userNames('john globex')).toEqual([]);
  });

  it('is case- and accent-insensitive', async () => {
    expect(await userNames('ZOE')).toEqual(['Zoë Ng']);
    expect(await userNames('MÜLLER')).toEqual(['Johanna Müller']);
  });

  it('does not match inside a word (intended: only word prefixes are index-bound)', async () => {
    expect(await userNames('ohn')).toEqual([]);
    expect(await userNames('mith')).toEqual([]);
  });

  it('respects the limit', async () => {
    expect(await userNames('jo', 2)).toHaveLength(2);
  });

  it('finds documents written before tokens existed through the substring fallback', async () => {
    await User.collection.insertOne({ name: 'Legacy Person', email: 'legacy@old.io' });
    expect(await userNames('gacy')).toEqual(['Legacy Person']);
  });

  it('stays inside the active tenant', async () => {
    await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      User.create(user('John Tenant', 'john@tenant-a.io')),
    );
    await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
      User.create(user('John Other', 'john@tenant-b.io')),
    );
    const names = await tenantStorage.run({ tenantId: 'tenant-a' }, () => userNames('john'));
    expect(names).toEqual(['John Tenant']);
  });

  it('finds groups by name and email word prefix', async () => {
    await Group.create([
      { name: 'Platform Team', source: 'local', email: 'platform@corp.io' },
      { name: 'Design', source: 'local', description: 'Platform design' },
    ]);
    const groups = await methods.searchPrincipals('plat', 10, [PrincipalType.GROUP]);
    expect(groups.map((g) => g.name)).toEqual(['Platform Team']);
  });
});

describe('search query plan', () => {
  const planStages = (plan: unknown): string[] => {
    const stages: string[] = [];
    const visit = (node: unknown) => {
      if (node == null || typeof node !== 'object') {
        return;
      }
      const record = node as Record<string, unknown>;
      if (typeof record.stage === 'string') {
        stages.push(record.stage);
      }
      for (const value of Object.values(record)) {
        visit(value);
      }
    };
    visit(plan);
    return stages;
  };

  beforeEach(async () => {
    await User.createIndexes();
    await User.create([
      user('John Smith', 'john.smith@acme.com', 'jsmith'),
      user('Bob Johnson', 'bob@initech.net', 'bobby'),
    ]);
  });

  it.each(['john', 'john smi', 'john.smith@acme'])(
    'uses index scans, never a collection scan, for "%s"',
    async (query) => {
      const filter = buildUserSearchFilter(query)!;
      const explain = (await User.find(filter).limit(10).explain('queryPlanner')) as unknown as {
        queryPlanner: { winningPlan: unknown };
      };
      const stages = planStages(explain.queryPlanner.winningPlan);
      expect(stages).toContain('IXSCAN');
      expect(stages).not.toContain('COLLSCAN');
    },
  );

  it('uses index scans with the admin search sort by name', async () => {
    const filter = buildUserSearchFilter('jo')!;
    const explain = (await User.find(filter)
      .sort({ name: 1 })
      .limit(20)
      .explain('queryPlanner')) as unknown as { queryPlanner: { winningPlan: unknown } };
    const stages = planStages(explain.queryPlanner.winningPlan);
    expect(stages).toContain('IXSCAN');
    expect(stages).not.toContain('COLLSCAN');
  });

  it('uses index scans under a tenant scope', async () => {
    const filter = buildUserSearchFilter('john')!;
    const explain = (await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      User.find(filter).limit(10).explain('queryPlanner'),
    )) as unknown as { queryPlanner: { winningPlan: unknown } };
    const stages = planStages(explain.queryPlanner.winningPlan);
    expect(stages).toContain('IXSCAN');
    expect(stages).not.toContain('COLLSCAN');
  });
});
