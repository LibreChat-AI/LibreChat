jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import path from 'path';
import { readFileSync } from 'fs';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PermissionBits, PrincipalType, PrincipalModel } from 'librechat-data-provider';
import { createModels, getTenantId, runAsSystem, tenantStorage } from '@librechat/data-schemas';
import type { Request, Response, NextFunction } from 'express';
import { AccessControlService } from '~/acl/accessControlService';
import { createSharedLinkAccessMiddleware } from './access';

type Outcome = 'allow' | 'notFound' | 'unauthenticated' | 'forbidden' | 'error';

interface VectorEntry {
  principal: string;
  resourceType: string;
  resource: string;
  bits: number;
  tenant: string | null;
}

interface VectorGroup {
  id: string;
  tenant: string | null;
  members: string[];
}

interface VectorRequest {
  context: string | null;
  viewer: { tenant: string | null; role: string } | null;
}

interface ShareHeader {
  schema: number;
  kind: string;
  vectors: number;
  permissionBits: Record<string, number>;
  principalTypes: string[];
  requests: Record<string, VectorRequest>;
  groups: VectorGroup[];
  atoms: VectorEntry[];
}

/** `groups` and `entries` index into the header's `groups` and `atoms` tables. */
interface ShareVector {
  id: number;
  shareTenant: string | null;
  shareState: 'active' | 'expired' | 'missing';
  allowAnonymous: boolean;
  request: string;
  groups: number[];
  entries: number[];
  expected: Outcome;
}

/**
 * Runs every scenario in formal/authz/vectors/shared-link.ndjson against the real shared-link
 * middleware on a real (in-memory) MongoDB, and expects the outcome the Lean model computed.
 *
 * The strict run (`TENANT_ISOLATION_STRICT=true`, a separate process because the flag is
 * memoised) must reach the same decision on every vector: the middleware always queries inside
 * either the request tenant, the share's tenant, or `runAsSystem`.
 */
const STRICT = process.env.TENANT_ISOLATION_STRICT === 'true';

const VECTORS = path.resolve(__dirname, '../../../../formal/authz/vectors/shared-link.ndjson');
const [headerLine, ...lines] = readFileSync(VECTORS, 'utf8').trimEnd().split('\n');
const header = JSON.parse(headerLine) as ShareHeader;
const vectors = lines.map((line) => JSON.parse(line) as ShareVector);

const STATUS: Record<number, Outcome> = {
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'notFound',
  500: 'error',
};

const REQUESTS = Object.keys(header.requests);

const enumNumbers = (values: object): Record<string, number> =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => typeof value === 'number'));

let mongoServer: MongoMemoryServer;
let canAccessSharedLink: ReturnType<typeof createSharedLinkAccessMiddleware>;

/** Fixtures for tenantless rows are written as system so seeding also works in strict mode. */
const seed = <T>(tenantId: string | null, fn: () => Promise<T>): Promise<T> =>
  tenantId ? tenantStorage.run({ tenantId }, fn) : runAsSystem(fn);

/** The request itself runs with no context at all when the vector has none. */
const withContext = <T>(tenantId: string | null, fn: () => Promise<T>): Promise<T> =>
  tenantId ? tenantStorage.run({ tenantId }, fn) : fn();

/** `user:<n>` is a user other than the viewer, created on first reference. */
const resolve = (ref: string, ids: Map<string, Types.ObjectId>): Types.ObjectId => {
  if (ref.startsWith('user:') && !ids.has(ref)) {
    ids.set(ref, new Types.ObjectId());
  }
  const id = ids.get(ref);
  if (!id) {
    throw new Error(`vector references unknown "${ref}"`);
  }
  return id;
};

function principalFields(principal: string, ids: Map<string, Types.ObjectId>) {
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
}

async function decide(vector: ShareVector): Promise<Outcome | undefined> {
  const { AclEntry, SharedLink, Group } = mongoose.models;
  const request = header.requests[vector.request];
  const viewerId = new Types.ObjectId();
  const ownerId = new Types.ObjectId();
  const ids = new Map<string, Types.ObjectId>([['user', viewerId]]);
  for (const index of vector.groups) {
    const group = header.groups[index];
    const memberIds = group.members.map((member) => resolve(member, ids).toString());
    const created = await seed(group.tenant, async () =>
      Group.create({ name: `group-${group.id}-${vector.id}`, memberIds }),
    );
    ids.set(`group:${group.id}`, created._id);
  }

  const shareId = `share-${vector.id}-${viewerId.toString()}`;
  ids.set('target', new Types.ObjectId());
  ids.set('other', new Types.ObjectId());
  if (vector.shareState !== 'missing') {
    const share = await seed(vector.shareTenant, async () =>
      SharedLink.create({
        shareId,
        conversationId: 'convo',
        user: ownerId.toString(),
        messages: [],
        ...(vector.shareState === 'expired' && {
          expiredAt: new Date('2020-01-01T00:00:00.000Z'),
        }),
      }),
    );
    ids.set('target', share._id);
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

  process.env.ALLOW_SHARED_LINKS_PUBLIC = String(vector.allowAnonymous);
  const user = request.viewer
    ? {
        id: viewerId.toString(),
        _id: viewerId,
        role: request.viewer.role,
        ...(request.viewer.tenant && { tenantId: request.viewer.tenant }),
      }
    : undefined;

  let status = 0;
  let allowed = false;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json() {
      return res;
    },
    end() {
      return res;
    },
  };
  await withContext(request.context, () =>
    canAccessSharedLink(
      { params: { shareId }, user } as unknown as Request,
      res as unknown as Response,
      (() => {
        allowed = true;
      }) as NextFunction,
    ),
  );
  return allowed ? 'allow' : STATUS[status];
}

beforeAll(async () => {
  delete process.env.DEFAULT_TENANT_ID;
  if (!STRICT) {
    delete process.env.TENANT_ISOLATION_STRICT;
  }
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  canAccessSharedLink = createSharedLinkAccessMiddleware({
    mongoose,
    aclService: new AccessControlService(mongoose),
  });
});

afterAll(async () => {
  delete process.env.ALLOW_SHARED_LINKS_PUBLIC;
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  delete process.env.SHARED_LINKS_AUTO_MIGRATE;
  const { AclEntry, SharedLink, Group } = mongoose.models;
  await runAsSystem(async () => {
    await Promise.all([AclEntry.deleteMany({}), SharedLink.deleteMany({}), Group.deleteMany({})]);
  });
});

describe(`shared-link access matches the Lean model in formal/authz (${STRICT ? 'strict' : 'default'} tenant isolation)`, () => {
  /** `getTenantId()` falls back to `DEFAULT_TENANT_ID`, which would turn every no-context vector
   *  into a tenant-scoped request; strict mode instead rejects untenanted queries. */
  test('queries without a tenant context are unfiltered, or rejected in strict mode', async () => {
    const { Group } = mongoose.models;
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
    expect(header).toMatchObject({ schema: 2, kind: 'shared-link', vectors: vectors.length });
    expect(new Set(vectors.map((vector) => vector.expected))).toEqual(
      new Set<Outcome>(['allow', 'notFound', 'unauthenticated', 'forbidden']),
    );
    expect(new Set(vectors.map((vector) => vector.request))).toEqual(new Set(REQUESTS));
    expect(header.permissionBits).toEqual(enumNumbers(PermissionBits));
    expect([...header.principalTypes].sort()).toEqual(Object.values(PrincipalType).sort());
    for (const vector of vectors) {
      expect(vector.groups.every((index) => header.groups[index] !== undefined)).toBe(true);
      expect(vector.entries.every((index) => header.atoms[index] !== undefined)).toBe(true);
    }
  });

  const isTarget = (index: number, principal: (name: string) => boolean): boolean => {
    const entry = header.atoms[index];
    return (
      entry.resource === 'target' &&
      entry.resourceType === 'sharedLink' &&
      principal(entry.principal)
    );
  };

  /** `public_grant_admits_signed_in_viewer`: a public link opens for a signed-in viewer of any
   *  tenant ("Share with everyone"), on every signed-in request path. */
  test('covers public links opened from another tenant on every signed-in request path', () => {
    const crossTenantPublic = vectors.filter((vector) => {
      const viewer = header.requests[vector.request].viewer;
      return (
        vector.shareState === 'active' &&
        viewer !== null &&
        viewer.tenant !== vector.shareTenant &&
        vector.entries.some((index) => isTarget(index, (name) => name === 'public'))
      );
    });
    const signedIn = REQUESTS.filter((label) => header.requests[label].viewer !== null);
    expect(new Set(crossTenantPublic.map((vector) => vector.request))).toEqual(new Set(signedIn));
    expect(crossTenantPublic.every((vector) => vector.expected === 'allow')).toBe(true);
  });

  /** `cross_tenant_role_irrelevant`: a role grant never admits a viewer from another tenant. */
  test('covers role grants seen by a viewer from another tenant', () => {
    const crossTenantRole = vectors.filter((vector) => {
      const viewer = header.requests[vector.request].viewer;
      return (
        vector.shareState === 'active' &&
        viewer !== null &&
        viewer.tenant !== vector.shareTenant &&
        vector.entries.length === 1 &&
        isTarget(vector.entries[0], (name) => name === 'role:USER')
      );
    });
    expect(crossTenantRole.length).toBeGreaterThan(0);
    expect(crossTenantRole.every((vector) => vector.expected === 'forbidden')).toBe(true);
  });

  test.each(REQUESTS)(
    'every %s request decision equals the model',
    async (label) => {
      const mismatches: { id: number; expected: Outcome; actual: Outcome | undefined }[] = [];
      for (const vector of vectors.filter((candidate) => candidate.request === label)) {
        const actual = await decide(vector);
        if (actual !== vector.expected) {
          mismatches.push({ id: vector.id, expected: vector.expected, actual });
        }
      }
      expect(mismatches).toEqual([]);
    },
    120_000,
  );
});
