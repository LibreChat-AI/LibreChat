import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createModels,
  createMethods,
  createSkillDeletionPersistenceAdapter,
} from '@librechat/data-schemas';
import {
  ResourceType,
  PrincipalType,
  PermissionBits,
  SystemRoles,
  AccessRoleIds,
} from 'librechat-data-provider';
import type { AllMethods } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { GitRepoAdapter } from './adapters/types';
import type { ServerRequest } from '~/types';
import { AccessControlService } from '~/acl/accessControlService';
import { createGitHubSkillSyncRunner } from './github';
import { createSkillsHandlers } from '../handlers';
import { runSkillDeletion } from '../deletion';

let server: MongoMemoryServer;
let db: AllMethods;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  createModels(mongoose);
  db = createMethods(mongoose);
  await db.seedDefaultRoles();
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

it('preserves group sharing across content updates, no-op syncs and revocation', async () => {
  const access = new AccessControlService(mongoose, db);
  const adminId = new Types.ObjectId().toString();
  let sharePublicly = true;
  let body = 'Initial instructions';
  const adapter: GitRepoAdapter = {
    resolveCommit: async () => ({ id: 'commit', treeId: 'tree' }),
    fetchTreeEntries: async () => [
      {
        path: 'skills/research/SKILL.md',
        type: 'blob',
        id: body,
        size: 128,
      },
    ],
    fetchFileContent: async () =>
      Buffer.from(`---\nname: research\ndescription: Research things\n---\n${body}`),
  };
  const deleteSkill = async (id: string) => {
    const progress = await runSkillDeletion(id, {
      ...createSkillDeletionPersistenceAdapter(db),
      deleteSkillFileAfterBlob: db.deleteSkillFileAfterBlob,
      finalizeSkillDeletion: db.finalizeSkillDeletion,
      completeSkillDeletion: async (skillId) => {
        const owner = 'sharing-test-worker';
        if (!(await db.claimSkillDeletion(skillId, owner, 60_000))) return false;
        return db.completeSkillDeletion(skillId, owner);
      },
      reopenSkillDeletion: db.reopenSkillDeletion,
      markSkillUploadIntentCleaned: db.markSkillUploadIntentCleaned,
      deleteBlob: async () => {
        throw new Error('No blobs in this fixture');
      },
      deleteReservedBlob: async () => {
        throw new Error('No blobs in this fixture');
      },
    });
    return {
      deleted: progress.found && progress.cleanupComplete,
      skillAbsent: progress.skillAbsent,
      cleanupComplete: progress.cleanupComplete,
      failedCleanupSteps: progress.failedSteps,
    };
  };
  const runner = createGitHubSkillSyncRunner({
    ...db,
    deleteFile: undefined,
    reserveBlob: async () => {
      throw new Error('No bundled files in this fixture');
    },
    deleteSkill,
    getConfig: () => ({
      github: {
        enabled: true,
        intervalMinutes: 60,
        runOnStartup: false,
        sources: [
          {
            id: 'sharing-test',
            owner: 'example',
            repo: 'skills',
            ref: 'main',
            paths: ['skills'],
            credentialKey: 'test',
            sharePublicly,
          },
        ],
      },
    }),
    getCredentialToken: async () => 'synthetic-token',
    getCredentialSummary: db.getSkillSyncCredentialSummary,
    listCredentials: db.listSkillSyncCredentials,
    listStatuses: db.listSkillSyncStatuses,
    upsertStatus: db.upsertSkillSyncStatus,
    tryAcquireLock: db.tryAcquireSkillSyncLock,
    refreshLock: db.refreshSkillSyncLock,
    releaseLock: db.releaseSkillSyncLock,
    createAdapter: () => adapter,
    saveBuffer: async () => {
      throw new Error('No bundled files in this fixture');
    },
    grantPermission: ({ principalType, principalId, resourceType, resourceId, grantedBy }) =>
      db.grantPermission(
        principalType,
        principalId,
        resourceType,
        resourceId,
        PermissionBits.VIEW,
        grantedBy,
      ),
  });
  const identity = { source: 'github' as const, upstreamId: 'sharing-test:skills/research' };
  expect((await runner.runOnce()).status).toBe('completed');
  const skill = await db.findSkillBySourceIdentity(identity);
  if (!skill) throw new Error('Expected imported skill');
  const publicAccess = () =>
    db.hasPermission(
      [{ principalType: PrincipalType.PUBLIC }],
      ResourceType.SKILL,
      skill._id,
      PermissionBits.VIEW,
    );
  expect(await publicAccess()).toBe(true);

  // Opting out is not an ACL migration: existing PUBLIC access is preserved.
  sharePublicly = false;
  expect((await runner.runOnce()).status).toBe('completed');
  expect(await publicAccess()).toBe(true);
  await access.bulkUpdateResourcePermissions({
    resourceType: ResourceType.SKILL,
    resourceId: skill._id.toString(),
    revokedPrincipals: [{ type: PrincipalType.PUBLIC }],
    grantedBy: adminId,
  });
  const employees = new Types.ObjectId();
  const client = new Types.ObjectId();
  const unrelatedClient = new Types.ObjectId();
  for (const group of [employees, client]) {
    await db.grantPermission(
      PrincipalType.GROUP,
      group,
      ResourceType.SKILL,
      skill._id,
      PermissionBits.VIEW,
    );
  }
  const canView = (group: Types.ObjectId) =>
    db.hasPermission(
      [
        { principalType: PrincipalType.PUBLIC },
        { principalType: PrincipalType.GROUP, principalId: group },
      ],
      ResourceType.SKILL,
      skill._id,
      PermissionBits.VIEW,
    );

  const sharedAcl = await db.findEntriesByResource(ResourceType.SKILL, skill._id);
  body = 'Updated instructions';
  for (let run = 0; run < 2; run++) {
    expect((await runner.runOnce()).status).toBe('completed');
    expect((await db.getSkillById(skill._id))?.body).toContain(body);
    expect(await publicAccess()).toBe(false);
    expect(await db.findEntriesByResource(ResourceType.SKILL, skill._id)).toEqual(sharedAcl);
    expect(await canView(employees)).toBe(true);
    expect(await canView(client)).toBe(true);
    expect(await canView(unrelatedClient)).toBe(false);
  }
  await access.bulkUpdateResourcePermissions({
    resourceType: ResourceType.SKILL,
    resourceId: skill._id.toString(),
    revokedPrincipals: [{ type: PrincipalType.GROUP, id: client.toString() }],
    grantedBy: adminId,
  });
  expect((await runner.runOnce()).status).toBe('completed');
  expect(await canView(client)).toBe(false);
  expect(await canView(employees)).toBe(true);

  // Reimport is a new resource, never an excuse to restore PUBLIC access.
  expect((await deleteSkill(skill._id.toString())).cleanupComplete).toBe(true);
  expect((await runner.runOnce()).status).toBe('completed');
  const reimported = await db.findSkillBySourceIdentity(identity);
  if (!reimported) throw new Error('Expected reimported skill');
  expect(reimported._id.toString()).not.toBe(skill._id.toString());
  expect(
    await db.hasPermission(
      [
        { principalType: PrincipalType.PUBLIC },
        { principalType: PrincipalType.GROUP, principalId: employees },
        { principalType: PrincipalType.GROUP, principalId: client },
      ],
      ResourceType.SKILL,
      reimported._id,
      PermissionBits.VIEW,
    ),
  ).toBe(false);

  // Exercise the catalogue handler and sharing service, not just direct ACL reads.
  const handlers = createSkillsHandlers({
    ...db,
    deleteSkillById: async () => {
      throw new Error('Only catalogue reads in this fixture');
    },
    getStrategyFunctions: () => ({}),
    isValidObjectIdString: (id) => typeof id === 'string' && Types.ObjectId.isValid(id),
    findAccessibleResources: (params) =>
      access.findAccessibleResources({
        ...params,
        role: params.role ?? undefined,
      }),
    findPubliclyAccessibleResources: ({ requiredPermissions }) =>
      access.findPubliclyAccessibleResources({
        resourceType: ResourceType.SKILL,
        requiredPermissions,
      }),
    hasPublicPermission: ({ resourceType, resourceId, requiredPermissions }) =>
      db.hasPermission(
        [{ principalType: PrincipalType.PUBLIC }],
        resourceType,
        resourceId,
        requiredPermissions,
      ),
    grantPermission: ({ principalType, principalId, resourceType, resourceId, grantedBy }) =>
      db.grantPermission(
        principalType,
        principalId,
        resourceType,
        resourceId,
        PermissionBits.VIEW,
        grantedBy,
      ),
  });
  async function catalogue(userId: string, role: SystemRoles): Promise<string[]> {
    const req = { user: { id: userId, role }, query: {} } as ServerRequest;
    const res = {} as Response;
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    await handlers.list(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const payload = jest.mocked(res.json).mock.calls[0][0] as { skills: Array<{ _id: string }> };
    return payload.skills.map((skill) => skill._id);
  }
  const clientId = new Types.ObjectId().toString();
  const outsiderId = new Types.ObjectId().toString();
  const importedId = reimported._id.toString();
  expect(await catalogue(adminId, SystemRoles.ADMIN)).toContain(importedId);
  expect(await catalogue(clientId, SystemRoles.USER)).not.toContain(importedId);
  expect(await catalogue(outsiderId, SystemRoles.USER)).not.toContain(importedId);

  const group = await db.createGroup({
    name: 'client-example',
    source: 'local',
    memberIds: [clientId],
  });
  await access.bulkUpdateResourcePermissions({
    resourceType: ResourceType.SKILL,
    resourceId: importedId,
    updatedPrincipals: [
      {
        type: PrincipalType.GROUP,
        id: group._id.toString(),
        accessRoleId: AccessRoleIds.SKILL_VIEWER,
      },
    ],
    grantedBy: adminId,
  });
  expect((await runner.runOnce()).status).toBe('completed');
  expect(await catalogue(adminId, SystemRoles.ADMIN)).toContain(importedId);
  expect(await catalogue(clientId, SystemRoles.USER)).toContain(importedId);
  expect(await catalogue(outsiderId, SystemRoles.USER)).not.toContain(importedId);

  // Sync must not undo a later deliberate removal of the initial admin grant.
  await access.bulkUpdateResourcePermissions({
    resourceType: ResourceType.SKILL,
    resourceId: importedId,
    revokedPrincipals: [{ type: PrincipalType.ROLE, id: SystemRoles.ADMIN }],
    grantedBy: adminId,
  });
  expect((await runner.runOnce()).status).toBe('completed');
  expect(await catalogue(adminId, SystemRoles.ADMIN)).not.toContain(importedId);
  expect(await catalogue(clientId, SystemRoles.USER)).toContain(importedId);
});
