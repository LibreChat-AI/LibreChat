const path = require('path');
const { readFileSync } = require('fs');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { getTenantId, runAsSystem, tenantStorage } = require('@librechat/data-schemas');
const { PermissionBits, PrincipalType, PrincipalModel } = require('librechat-data-provider');

const mockHasCapability = jest.fn();
jest.mock('~/server/middleware/roles/capabilities', () => ({
  ...jest.requireActual('~/server/middleware/roles/capabilities'),
  hasCapability: (...args) => mockHasCapability(...args),
}));

const { canAccessResource } = require('./canAccessResource');
const { AclEntry, Group } = require('~/db/models');

/**
 * Runs every scenario in formal/authz/vectors/resource.ndjson through the real `canAccessResource`
 * and `PermissionService` on a real (in-memory) MongoDB, and expects the Lean model's outcome.
 * Only `hasCapability` is replaced: the model takes its result as an input.
 *
 * Run once more as a separate process with `TENANT_ISOLATION_STRICT=true` (the flag is
 * memoised). A viewer without a tenant then has no query context: `getUserPrincipals` throws,
 * `PermissionService.checkPermission` swallows it as `false`, and the gate fails closed with 403.
 * Production never reaches that point because `tenantContextMiddleware` rejects such users first.
 */
const STRICT = process.env.TENANT_ISOLATION_STRICT === 'true';

const VECTORS = path.resolve(__dirname, '../../../../formal/authz/vectors/resource.ndjson');
const [headerLine, ...lines] = readFileSync(VECTORS, 'utf8').trimEnd().split('\n');
const header = JSON.parse(headerLine);
const vectors = lines.map((line) => JSON.parse(line));
const RESOURCE_TYPES = [...new Set(vectors.map((vector) => vector.resourceType))];

const enumNumbers = (values) =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => typeof value === 'number'));

const STATUS = { 401: 'unauthenticated', 403: 'forbidden', 404: 'notFound', 500: 'error' };

const untenantedViewer = (vector) => vector.viewer !== null && vector.viewer.tenant === null;

const expectedOutcome = (vector) =>
  STRICT && untenantedViewer(vector) && !vector.capability && vector.resolved
    ? 'forbidden'
    : vector.expected;

/** Fixtures for tenantless rows are written as system so seeding also works in strict mode. */
const seed = (tenantId, fn) => (tenantId ? tenantStorage.run({ tenantId }, fn) : runAsSystem(fn));

const withContext = (tenantId, fn) => (tenantId ? tenantStorage.run({ tenantId }, fn) : fn());

/** `user:<n>` is a user other than the viewer, created on first reference. */
const resolve = (ref, ids) => {
  if (ref.startsWith('user:') && !ids.has(ref)) {
    ids.set(ref, new mongoose.Types.ObjectId());
  }
  const id = ids.get(ref);
  if (!id) {
    throw new Error(`vector references unknown "${ref}"`);
  }
  return id;
};

const principalFields = (principal, ids) => {
  if (principal === 'public') {
    return { principalType: PrincipalType.PUBLIC };
  }
  if (principal.startsWith('role:')) {
    return {
      principalType: PrincipalType.ROLE,
      principalModel: PrincipalModel.ROLE,
      principalId: principal.slice('role:'.length),
    };
  }
  if (principal.startsWith('group:')) {
    return {
      principalType: PrincipalType.GROUP,
      principalModel: PrincipalModel.GROUP,
      principalId: resolve(principal, ids),
    };
  }
  return {
    principalType: PrincipalType.USER,
    principalModel: PrincipalModel.USER,
    principalId: resolve(principal, ids),
  };
};

/** `entries` index into the header's `atoms` table; every vector uses all header `groups`. */
const decide = async (vector) => {
  const viewerId = new mongoose.Types.ObjectId();
  const ownerId = new mongoose.Types.ObjectId();
  const target = new mongoose.Types.ObjectId();
  const ids = new Map([
    ['user', viewerId],
    ['target', target],
    ['other', new mongoose.Types.ObjectId()],
  ]);
  for (const group of header.groups) {
    const memberIds = group.members.map((member) => resolve(member, ids).toString());
    const created = await seed(group.tenant, async () =>
      Group.create({ name: `group-${group.id}-${vector.id}`, memberIds }),
    );
    ids.set(`group:${group.id}`, created._id);
  }
  for (const index of vector.entries) {
    const entry = header.atoms[index];
    await seed(entry.tenant, async () =>
      new AclEntry({
        ...principalFields(entry.principal, ids),
        resourceType: entry.resourceType,
        resourceId: resolve(entry.resource, ids),
        permBits: entry.bits,
        grantedBy: ownerId,
      }).save(),
    );
  }

  if (vector.capability === 'error') {
    mockHasCapability.mockRejectedValue(new Error('capability store unavailable'));
  } else {
    mockHasCapability.mockResolvedValue(vector.capability);
  }
  const req = {
    params: { resourceId: 'raw-id' },
    user: vector.viewer
      ? {
          id: viewerId.toString(),
          role: vector.viewer.role,
          ...(vector.viewer.tenant && { tenantId: vector.viewer.tenant }),
        }
      : undefined,
  };
  let status = 0;
  let allowed = false;
  const res = {
    status(code) {
      status = code;
      return res;
    },
    json() {
      return res;
    },
  };
  const middleware = canAccessResource({
    resourceType: vector.resourceType,
    requiredPermission: vector.required,
    resourceIdParam: 'resourceId',
    idResolver: async () => (vector.resolved ? { _id: target } : null),
  });
  await withContext(vector.viewer?.tenant ?? null, () =>
    middleware(req, res, () => {
      allowed = true;
    }),
  );
  return allowed ? 'allow' : STATUS[status];
};

describe(`canAccessResource matches the Lean model in formal/authz (${STRICT ? 'strict' : 'default'} tenant isolation)`, () => {
  let mongoServer;

  beforeAll(async () => {
    delete process.env.DEFAULT_TENANT_ID;
    if (!STRICT) {
      delete process.env.TENANT_ISOLATION_STRICT;
    }
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  beforeEach(async () => {
    await runAsSystem(async () => {
      await Promise.all([AclEntry.deleteMany({}), Group.deleteMany({})]);
    });
  });

  /** `getTenantId()` falls back to `DEFAULT_TENANT_ID`, which would give the untenanted viewer a
   *  tenant-scoped context; strict mode instead rejects untenanted queries. */
  test('queries without a tenant context are unfiltered, or rejected in strict mode', async () => {
    await seed('tenant-a', async () => Group.create({ name: 'probe' }));
    expect(getTenantId()).toBeUndefined();
    const untenanted = Group.countDocuments({}).exec();
    if (STRICT) {
      await expect(untenanted).rejects.toThrow('without tenant context in strict mode');
    } else {
      await expect(untenanted).resolves.toBe(1);
    }
  });

  test('the vector file is whole, self-consistent and exercises every outcome', () => {
    expect(header).toMatchObject({ schema: 2, kind: 'resource', vectors: vectors.length });
    expect(new Set(vectors.map((vector) => vector.expected))).toEqual(
      new Set(['allow', 'notFound', 'unauthenticated', 'forbidden']),
    );
    expect(RESOURCE_TYPES).toEqual(expect.arrayContaining(['agent', 'sharedLink']));
    expect(header.permissionBits).toEqual(enumNumbers(PermissionBits));
    expect([...header.principalTypes].sort()).toEqual(Object.values(PrincipalType).sort());
    for (const vector of vectors) {
      expect(vector.entries.every((index) => header.atoms[index] !== undefined)).toBe(true);
    }
  });

  test.each(RESOURCE_TYPES)(
    'every %s decision equals the model',
    async (resourceType) => {
      const mismatches = [];
      for (const vector of vectors.filter((candidate) => candidate.resourceType === resourceType)) {
        const expected = expectedOutcome(vector);
        const actual = await decide(vector);
        if (actual !== expected) {
          mismatches.push({ id: vector.id, expected, actual });
        }
      }
      expect(mismatches).toEqual([]);
    },
    120000,
  );
  /** A capability lookup that throws must not grant the bypass; the ACL check still decides. */
  describe('when the capability check fails', () => {
    const viewGrant = header.atoms.findIndex(
      (entry) =>
        entry.principal === 'user' &&
        entry.resourceType === 'agent' &&
        entry.resource === 'target' &&
        entry.bits === PermissionBits.VIEW &&
        entry.tenant === 'tenant-a',
    );

    test.each([
      ['no grant', 'forbidden', []],
      ['a VIEW grant', 'allow', [viewGrant]],
    ])('with %s the gate answers %s', async (_label, expected, entries) => {
      expect(viewGrant).toBeGreaterThanOrEqual(0);
      mockHasCapability.mockClear();
      const actual = await decide({
        id: `capability-error-${expected}`,
        viewer: { tenant: 'tenant-a', role: 'USER' },
        capability: 'error',
        resolved: true,
        resourceType: 'agent',
        required: PermissionBits.VIEW,
        entries,
      });
      expect(mockHasCapability).toHaveBeenCalled();
      expect(actual).toBe(expected);
    });
  });
});
