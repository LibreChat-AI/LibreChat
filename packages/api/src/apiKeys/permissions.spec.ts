import { Types } from 'mongoose';
import {
  ResourceType,
  PrincipalType,
  PermissionBits,
  AccessRoleIds,
} from 'librechat-data-provider';
import { permissionBitSupersets, tenantStorage } from '@librechat/data-schemas';
import { enrichRemoteAgentPrincipals } from './permissions';
import type { EnricherDependencies, Principal } from './permissions';

/**
 * Tests for `enrichRemoteAgentPrincipals`.
 *
 * The function is purely dependency-injected; we stub `aggregateAclEntries`.
 * Two concerns are covered:
 *   (a) Pipeline shape — the `$match` must filter permBits via
 *       `$in: permissionBitSupersets(SHARE)` (not `$bitsAllSet`) so Cosmos DB
 *       for MongoDB can evaluate it.
 *   (b) Enrichment behavior on pre-filtered rows — given the rows the DB
 *       returns, non-null userInfo is mapped into a REMOTE_AGENT_OWNER
 *       principal and duplicates against the caller-supplied list are skipped.
 */
describe('enrichRemoteAgentPrincipals', () => {
  const resourceId = new Types.ObjectId();
  const ownerUserId = new Types.ObjectId();

  function makeUserInfo(id: Types.ObjectId, overrides: Record<string, unknown> = {}) {
    return {
      _id: id,
      name: `user-${id.toString().slice(-4)}`,
      email: `${id.toString().slice(-4)}@test.local`,
      avatar: 'avatar.png',
      idOnTheSource: id.toString(),
      ...overrides,
    };
  }

  function makeDeps(aggregateResult: Record<string, unknown>[]): EnricherDependencies {
    return {
      aggregateAclEntries: jest.fn().mockResolvedValue(aggregateResult),
      bulkWriteAclEntries: jest.fn(),
      findRoleByIdentifier: jest.fn(),
      logger: { error: jest.fn() },
    };
  }

  describe('pipeline shape (Cosmos DB compatibility)', () => {
    test('$match filters permBits via $in of SHARE supersets, not $bitsAllSet', async () => {
      const aggregateAclEntries = jest.fn().mockResolvedValue([]);
      const deps: EnricherDependencies = {
        aggregateAclEntries,
        bulkWriteAclEntries: jest.fn(),
        findRoleByIdentifier: jest.fn(),
        logger: { error: jest.fn() },
      };

      await enrichRemoteAgentPrincipals(deps, resourceId, []);

      const pipeline = aggregateAclEntries.mock.calls[0][0] as Record<string, unknown>[];
      const matchStage = pipeline[0].$match as Record<string, unknown>;
      expect(matchStage.resourceType).toBe(ResourceType.AGENT);
      expect(matchStage.principalType).toBe(PrincipalType.USER);
      expect(matchStage.resourceId).toBeInstanceOf(Types.ObjectId);
      expect((matchStage.resourceId as Types.ObjectId).toString()).toBe(resourceId.toString());

      /** Regression guard: no `$bitsAllSet` — Cosmos DB does not implement it. */
      expect(matchStage.permBits).not.toHaveProperty('$bitsAllSet');

      /** The filter must be the `$in` expansion of SHARE supersets. */
      expect(matchStage.permBits).toEqual({
        $in: permissionBitSupersets(PermissionBits.SHARE),
      });
    });

    test('$in list contains exactly the permBits values whose bits include SHARE', async () => {
      const values = permissionBitSupersets(PermissionBits.SHARE);
      for (const v of values) {
        expect((v & PermissionBits.SHARE) === PermissionBits.SHARE).toBe(true);
      }
      for (let v = 0; v <= 15; v++) {
        const expectedIncluded = (v & PermissionBits.SHARE) === PermissionBits.SHARE;
        expect(values.includes(v)).toBe(expectedIncluded);
      }
    });

    test('accepts resourceId as a 24-char hex string and passes an ObjectId to the aggregation', async () => {
      const hexId = new Types.ObjectId().toString();
      const aggregateAclEntries = jest.fn().mockResolvedValue([]);
      const deps: EnricherDependencies = {
        aggregateAclEntries,
        bulkWriteAclEntries: jest.fn(),
        findRoleByIdentifier: jest.fn(),
        logger: { error: jest.fn() },
      };

      await enrichRemoteAgentPrincipals(deps, hexId, []);

      const matchStage = aggregateAclEntries.mock.calls[0][0][0].$match;
      expect(matchStage.resourceId).toBeInstanceOf(Types.ObjectId);
      expect((matchStage.resourceId as Types.ObjectId).toString()).toBe(hexId);
    });

    test('keeps the user lookup in simple localField/foreignField form', async () => {
      const aggregateAclEntries = jest.fn().mockResolvedValue([]);
      const deps: EnricherDependencies = {
        aggregateAclEntries,
        bulkWriteAclEntries: jest.fn(),
        findRoleByIdentifier: jest.fn(),
        logger: { error: jest.fn() },
      };

      await enrichRemoteAgentPrincipals(deps, resourceId, []);

      const pipeline = aggregateAclEntries.mock.calls[0][0] as Record<string, unknown>[];
      const lookupStage = pipeline.find((stage) => '$lookup' in stage) as
        | { $lookup: Record<string, unknown> }
        | undefined;
      expect(lookupStage).toMatchObject({
        $lookup: {
          from: 'users',
          localField: 'principalId',
          foreignField: '_id',
          as: 'userInfo',
        },
      });
      expect(lookupStage?.$lookup).not.toHaveProperty('let');
      expect(lookupStage?.$lookup).not.toHaveProperty('pipeline');
    });
  });

  describe('enrichment behavior', () => {
    test('enriches a principal for each pre-filtered row with valid userInfo', async () => {
      const deps = makeDeps([
        {
          principalId: ownerUserId,
          userInfo: makeUserInfo(ownerUserId),
        },
      ]);

      const result = await enrichRemoteAgentPrincipals(deps, resourceId, []);

      expect(result.principals).toHaveLength(1);
      expect(result.principals[0].id).toBe(ownerUserId.toString());
      expect(result.principals[0].accessRoleId).toBe(AccessRoleIds.REMOTE_AGENT_OWNER);
      expect(result.principals[0].isImplicit).toBe(true);
      expect(result.principals[0].source).toBe('local');
      expect(result.entriesToBackfill).toHaveLength(1);
      expect(result.entriesToBackfill[0].toString()).toBe(ownerUserId.toString());
    });

    test('skips rows whose userInfo lookup came back null', async () => {
      const deps = makeDeps([
        {
          principalId: ownerUserId,
          userInfo: null,
        },
      ]);

      const result = await enrichRemoteAgentPrincipals(deps, resourceId, []);

      expect(result.principals).toHaveLength(0);
      expect(result.entriesToBackfill).toHaveLength(0);
    });

    test('skips joined userInfo outside the current request context', async () => {
      const deps = makeDeps([
        {
          principalId: ownerUserId,
          userInfo: makeUserInfo(ownerUserId, {
            tenantId: 'tenant-b',
            email: 'outside-user@example.com',
          }),
        },
      ]);

      const result = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        enrichRemoteAgentPrincipals(deps, resourceId, []),
      );

      expect(result.principals).toHaveLength(0);
      expect(result.entriesToBackfill).toHaveLength(0);
    });

    test('does not duplicate a principal already present in the input list', async () => {
      const existing: Principal = {
        type: PrincipalType.USER,
        id: ownerUserId.toString(),
        name: 'already-there',
        accessRoleId: AccessRoleIds.REMOTE_AGENT_OWNER,
      };
      const deps = makeDeps([
        {
          principalId: ownerUserId,
          userInfo: makeUserInfo(ownerUserId),
        },
      ]);

      const result = await enrichRemoteAgentPrincipals(deps, resourceId, [existing]);

      expect(result.principals).toHaveLength(1);
      expect(result.principals[0].name).toBe('already-there');
      expect(result.entriesToBackfill).toHaveLength(0);
    });

    test('prepends newly discovered owners to the supplied principals list', async () => {
      const stranger: Principal = {
        type: PrincipalType.USER,
        id: new Types.ObjectId().toString(),
        name: 'stranger',
        accessRoleId: 'other_role',
      };
      const deps = makeDeps([
        {
          principalId: ownerUserId,
          userInfo: makeUserInfo(ownerUserId),
        },
      ]);

      const result = await enrichRemoteAgentPrincipals(deps, resourceId, [stranger]);

      expect(result.principals).toHaveLength(2);
      expect(result.principals[0].id).toBe(ownerUserId.toString());
      expect(result.principals[1].id).toBe(stranger.id);
    });
  });
});
