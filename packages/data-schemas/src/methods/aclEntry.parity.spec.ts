import mongoose from 'mongoose';
import { performance } from 'node:perf_hooks';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  ResourceType,
  PrincipalType,
  PrincipalModel,
  PermissionBits,
} from 'librechat-data-provider';
import type * as t from '~/types';
import { createAclEntryMethods } from './aclEntry';
import aclEntrySchema from '~/schema/aclEntry';

/**
 * Parity spec — verifies the `$in`-based queries added in #12729 are behaviorally
 * equivalent to the legacy `$bitsAllSet` queries on MongoDB, and measures whether
 * the new path is competitive on wall-clock time.
 *
 * Uses `mongodb-memory-server`, which supports both `$bitsAllSet` (legacy) and
 * `$in` (new). Cosmos DB for MongoDB supports only the latter — this spec proves
 * the rewrite produces identical results on the backend we can actually run in
 * CI, then leaves the Cosmos-only behavior to manual smoke testing against a
 * real Cosmos instance.
 */

let mongoServer: MongoMemoryServer;
let AclEntry: mongoose.Model<t.IAclEntry>;
let methods: ReturnType<typeof createAclEntryMethods>;

/** Enough entries to exercise real query planning without bloating CI runtime. */
const FIXTURE_SIZE = 800;
/** Enough iterations for a reasonably stable median; still finishes in <2s total. */
const PERF_ITERATIONS = 20;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  AclEntry = mongoose.models.AclEntry || mongoose.model('AclEntry', aclEntrySchema);
  methods = createAclEntryMethods(mongoose);
  await mongoose.connect(mongoUri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

function idsToSortedStrings(ids: mongoose.Types.ObjectId[]): string[] {
  return ids.map((id) => id.toString()).sort();
}

function buildPrincipalsQuery(
  principals: Array<{ principalType: string; principalId?: mongoose.Types.ObjectId }>,
) {
  return principals.map((p) => ({
    principalType: p.principalType,
    ...(p.principalType !== PrincipalType.PUBLIC && { principalId: p.principalId }),
  }));
}

async function seedVariedPermissions(
  userId: mongoose.Types.ObjectId,
  grantedBy: mongoose.Types.ObjectId,
  count: number,
): Promise<void> {
  /** Every permBits value from 0..31 appears roughly `count/32` times, giving
   *  a uniform distribution for parity + perf assertions. */
  const docs: Partial<t.IAclEntry>[] = [];
  for (let i = 0; i < count; i++) {
    docs.push({
      principalType: PrincipalType.USER,
      principalId: userId,
      principalModel: PrincipalModel.USER,
      resourceType: ResourceType.AGENT,
      resourceId: new mongoose.Types.ObjectId(),
      permBits: i % 32,
      grantedBy,
    });
  }
  await AclEntry.insertMany(docs);
}

async function median<T>(fn: () => Promise<T>, iterations: number): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

describe('ACL $bitsAllSet vs $in parity (issue #12729)', () => {
  const userId = new mongoose.Types.ObjectId();
  const grantedById = new mongoose.Types.ObjectId();
  const principalsList = [{ principalType: PrincipalType.USER, principalId: userId }];

  describe('correctness', () => {
    test.each([
      PermissionBits.VIEW,
      PermissionBits.EDIT,
      PermissionBits.DELETE,
      PermissionBits.SHARE,
      PermissionBits.VIEW_INSIGHTS,
      PermissionBits.VIEW | PermissionBits.VIEW_INSIGHTS,
      PermissionBits.VIEW | PermissionBits.EDIT,
      PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE,
      PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE,
    ])(
      'findAccessibleResources returns the same set as `$bitsAllSet` for bits=%i',
      async (bits) => {
        await seedVariedPermissions(userId, grantedById, FIXTURE_SIZE);

        const legacy = await AclEntry.find({
          $or: buildPrincipalsQuery(principalsList),
          resourceType: ResourceType.AGENT,
          permBits: { $bitsAllSet: bits },
        }).distinct('resourceId');

        const current = await methods.findAccessibleResources(
          principalsList,
          ResourceType.AGENT,
          bits,
        );

        expect(idsToSortedStrings(current)).toEqual(idsToSortedStrings(legacy));
      },
    );

    test.each([
      PermissionBits.VIEW,
      PermissionBits.EDIT | PermissionBits.DELETE,
      PermissionBits.SHARE,
    ])('findPublicResourceIds returns the same set as `$bitsAllSet` for bits=%i', async (bits) => {
      /** Public entries have no principalId — seed those separately. */
      const docs: Partial<t.IAclEntry>[] = [];
      for (let i = 0; i < FIXTURE_SIZE; i++) {
        docs.push({
          principalType: PrincipalType.PUBLIC,
          resourceType: ResourceType.AGENT,
          resourceId: new mongoose.Types.ObjectId(),
          permBits: i % 32,
          grantedBy: grantedById,
        });
      }
      await AclEntry.insertMany(docs);

      const legacy = await AclEntry.find({
        principalType: PrincipalType.PUBLIC,
        resourceType: ResourceType.AGENT,
        permBits: { $bitsAllSet: bits },
      }).distinct('resourceId');

      const current = await methods.findPublicResourceIds(ResourceType.AGENT, bits);

      expect(idsToSortedStrings(current)).toEqual(idsToSortedStrings(legacy));
    });

    test('hasPermission returns the same boolean as `$bitsAllSet` across all permBits patterns', async () => {
      const sharedResourceId = new mongoose.Types.ObjectId();
      /** One entry per permBits value (0..31) on the same resource. */
      for (let permBits = 0; permBits <= 31; permBits++) {
        await AclEntry.create({
          principalType: PrincipalType.USER,
          principalId: new mongoose.Types.ObjectId(),
          principalModel: PrincipalModel.USER,
          resourceType: ResourceType.AGENT,
          resourceId: sharedResourceId,
          permBits,
          grantedBy: grantedById,
        });
      }

      /** For each required bit, enumerate which principalIds satisfy the mask
       *  via legacy and current and verify they match. */
      for (const required of [
        PermissionBits.VIEW,
        PermissionBits.EDIT,
        PermissionBits.DELETE,
        PermissionBits.SHARE,
        PermissionBits.VIEW | PermissionBits.VIEW_INSIGHTS,
        PermissionBits.VIEW | PermissionBits.EDIT,
        PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE,
      ]) {
        const legacyMatches = await AclEntry.find({
          resourceType: ResourceType.AGENT,
          resourceId: sharedResourceId,
          permBits: { $bitsAllSet: required },
        })
          .select('principalId')
          .lean();

        for (const entry of legacyMatches) {
          const pid = entry.principalId as mongoose.Types.ObjectId;
          const current = await methods.hasPermission(
            [{ principalType: PrincipalType.USER, principalId: pid }],
            ResourceType.AGENT,
            sharedResourceId,
            required,
          );
          expect(current).toBe(true);
        }

        const allEntries = await AclEntry.find({
          resourceType: ResourceType.AGENT,
          resourceId: sharedResourceId,
        })
          .select('principalId permBits')
          .lean();
        const matchingIds = new Set(
          legacyMatches.map((e) => (e.principalId as mongoose.Types.ObjectId).toString()),
        );
        for (const entry of allEntries) {
          if (matchingIds.has((entry.principalId as mongoose.Types.ObjectId).toString())) continue;
          const current = await methods.hasPermission(
            [
              {
                principalType: PrincipalType.USER,
                principalId: entry.principalId as mongoose.Types.ObjectId,
              },
            ],
            ResourceType.AGENT,
            sharedResourceId,
            required,
          );
          expect(current).toBe(false);
        }
      }
    });

    test('getSoleOwnedResourceIds returns the same set as the legacy aggregation', async () => {
      /** Seed a mixed fixture where `userId` owns (has DELETE on) some resources
       *  solely, shares ownership of others, and lacks DELETE on a third group. */
      const soleOwnedA = new mongoose.Types.ObjectId();
      const soleOwnedB = new mongoose.Types.ObjectId();
      const sharedOwned = new mongoose.Types.ObjectId();
      const nonOwnedView = new mongoose.Types.ObjectId();

      const otherUserId = new mongoose.Types.ObjectId();

      await AclEntry.insertMany([
        {
          principalType: PrincipalType.USER,
          principalId: userId,
          principalModel: PrincipalModel.USER,
          resourceType: ResourceType.AGENT,
          resourceId: soleOwnedA,
          permBits: PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE,
          grantedBy: grantedById,
        },
        {
          principalType: PrincipalType.USER,
          principalId: userId,
          principalModel: PrincipalModel.USER,
          resourceType: ResourceType.AGENT,
          resourceId: soleOwnedB,
          permBits: PermissionBits.DELETE | PermissionBits.SHARE,
          grantedBy: grantedById,
        },
        {
          principalType: PrincipalType.USER,
          principalId: userId,
          principalModel: PrincipalModel.USER,
          resourceType: ResourceType.AGENT,
          resourceId: sharedOwned,
          permBits: PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE,
          grantedBy: grantedById,
        },
        {
          principalType: PrincipalType.USER,
          principalId: otherUserId,
          principalModel: PrincipalModel.USER,
          resourceType: ResourceType.AGENT,
          resourceId: sharedOwned,
          permBits: PermissionBits.VIEW | PermissionBits.DELETE,
          grantedBy: grantedById,
        },
        {
          principalType: PrincipalType.USER,
          principalId: userId,
          principalModel: PrincipalModel.USER,
          resourceType: ResourceType.AGENT,
          resourceId: nonOwnedView,
          permBits: PermissionBits.VIEW | PermissionBits.EDIT,
          grantedBy: grantedById,
        },
      ]);

      /** Legacy reference: the original two-pass algorithm from #11830. */
      const legacyOwned = await AclEntry.find({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: { $in: [ResourceType.AGENT] },
        permBits: { $bitsAllSet: PermissionBits.DELETE },
      })
        .select('resourceId')
        .lean();
      const legacyIds = legacyOwned.map((e) => e.resourceId);
      const legacyOthers = await AclEntry.aggregate([
        {
          $match: {
            resourceType: { $in: [ResourceType.AGENT] },
            resourceId: { $in: legacyIds },
            permBits: { $bitsAllSet: PermissionBits.DELETE },
            $or: [{ principalId: { $ne: userId } }, { principalType: { $ne: PrincipalType.USER } }],
          },
        },
        { $group: { _id: '$resourceId' } },
      ]);
      const legacyMultiOwner = new Set(
        legacyOthers.map((doc: { _id: mongoose.Types.ObjectId }) => doc._id.toString()),
      );
      const legacyResult = legacyIds.filter((id) => !legacyMultiOwner.has(id.toString()));

      const current = await methods.getSoleOwnedResourceIds(userId, ResourceType.AGENT);

      expect(idsToSortedStrings(current)).toEqual(idsToSortedStrings(legacyResult));
      expect(idsToSortedStrings(current)).toEqual(
        [soleOwnedA.toString(), soleOwnedB.toString()].sort(),
      );
    });
  });

  describe('performance (wall-clock, median over 20 runs)', () => {
    /**
     * These tests don't assert on absolute timings (CI variance) — they log
     * numbers so reviewers can verify no gross regression and, if curious,
     * see the `$in` path is typically at least as fast as `$bitsAllSet`
     * because `$in` is indexable while `$bitsAllSet` is not.
     *
     * The `expect` guard is `Math.max(legacyMs * 5, 50)` — a multiplicative
     * ceiling of 5× with an absolute floor of 50ms. The earlier
     * `legacyMs * 3 + 50` form was dominated by the `+ 50` additive term at
     * sub-ms latencies and would have let a 50× regression pass silently.
     */
    test('findAccessibleResources: $bitsAllSet vs $in', async () => {
      await seedVariedPermissions(userId, grantedById, FIXTURE_SIZE);
      const requiredBits = PermissionBits.VIEW | PermissionBits.EDIT;

      const legacyMs = await median(
        () =>
          AclEntry.find({
            $or: buildPrincipalsQuery(principalsList),
            resourceType: ResourceType.AGENT,
            permBits: { $bitsAllSet: requiredBits },
          })
            .distinct('resourceId')
            .then(() => void 0),
        PERF_ITERATIONS,
      );
      const currentMs = await median(
        () =>
          methods
            .findAccessibleResources(principalsList, ResourceType.AGENT, requiredBits)
            .then(() => void 0),
        PERF_ITERATIONS,
      );

      console.log(
        `[perf] findAccessibleResources — legacy $bitsAllSet: ${legacyMs.toFixed(2)}ms, ` +
          `current $in: ${currentMs.toFixed(2)}ms (median of ${PERF_ITERATIONS} runs, ${FIXTURE_SIZE} entries)`,
      );
      expect(currentMs).toBeLessThan(Math.max(legacyMs * 5, 50));
    });

    test('findPublicResourceIds: $bitsAllSet vs $in', async () => {
      const docs: Partial<t.IAclEntry>[] = [];
      for (let i = 0; i < FIXTURE_SIZE; i++) {
        docs.push({
          principalType: PrincipalType.PUBLIC,
          resourceType: ResourceType.AGENT,
          resourceId: new mongoose.Types.ObjectId(),
          permBits: i % 16,
          grantedBy: grantedById,
        });
      }
      await AclEntry.insertMany(docs);

      const requiredBits = PermissionBits.VIEW;

      const legacyMs = await median(
        () =>
          AclEntry.find({
            principalType: PrincipalType.PUBLIC,
            resourceType: ResourceType.AGENT,
            permBits: { $bitsAllSet: requiredBits },
          })
            .distinct('resourceId')
            .then(() => void 0),
        PERF_ITERATIONS,
      );
      const currentMs = await median(
        () => methods.findPublicResourceIds(ResourceType.AGENT, requiredBits).then(() => void 0),
        PERF_ITERATIONS,
      );

      console.log(
        `[perf] findPublicResourceIds — legacy $bitsAllSet: ${legacyMs.toFixed(2)}ms, ` +
          `current $in: ${currentMs.toFixed(2)}ms (median of ${PERF_ITERATIONS} runs, ${FIXTURE_SIZE} entries)`,
      );
      expect(currentMs).toBeLessThan(Math.max(legacyMs * 5, 50));
    });
  });
});
