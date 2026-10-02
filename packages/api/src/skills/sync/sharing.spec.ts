import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import { ResourceType, PrincipalType, PermissionBits } from 'librechat-data-provider';
import type { AllMethods } from '@librechat/data-schemas';
import type { GitRepoAdapter } from './adapters/types';
import { createGitHubSkillSyncRunner } from './github';

let server: MongoMemoryServer;
let db: AllMethods;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  createModels(mongoose);
  db = createMethods(mongoose);
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

it('preserves group sharing across content updates, no-op syncs and revocation', async () => {
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
  const runner = createGitHubSkillSyncRunner({
    ...db,
    deleteFile: undefined,
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
  await db.revokePermission(PrincipalType.PUBLIC, null, ResourceType.SKILL, skill._id);
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
  await db.revokePermission(PrincipalType.GROUP, client, ResourceType.SKILL, skill._id);
  expect((await runner.runOnce()).status).toBe('completed');
  expect(await canView(client)).toBe(false);
  expect(await canView(employees)).toBe(true);

  // Reimport is a new resource, never an excuse to restore PUBLIC access.
  expect((await db.deleteSkill(skill._id.toString())).cleanupComplete).toBe(true);
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
});
