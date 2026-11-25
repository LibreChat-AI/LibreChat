import { Types } from 'mongoose';
import { createSkillDeletionPersistenceAdapter } from './skillDeletionAdapter';

it('projects deletion persistence records into plain string-ID API records', async () => {
  const skillId = new Types.ObjectId();
  const author = new Types.ObjectId();
  const source = {
    hasInFlightSkillUploads: jest.fn(async () => false),
    listExistingSkillFileIds: jest.fn(async () => ['file-1']),
    iterateSkillCleanupFiles: async function* () {
      yield [{ skillId, author, file_id: 'file-1', filepath: '/uploads/file-1', source: 'local' }];
    },
    iterateSkillCleanupIntents: async function* () {
      yield [
        {
          skillId,
          author,
          fileId: 'file-1',
          source: 'local',
          storageKey: '/uploads/file-1',
          state: 'committed' as const,
        },
      ];
    },
    beginSkillDeletion: async () => ({ skillId, author, startedAt: new Date() }),
    getSkillDeletion: async () => ({ skillId, author, startedAt: new Date() }),
    listSkillDeletionTombstones: async () => [{ skillId, author, startedAt: new Date() }],
    listSkillUploadIntents: jest.fn(async () => [
      {
        skillId,
        author,
        fileId: 'file-1',
        source: 'local',
        storageKey: '/uploads/file-1',
        writerId: 'writer',
        state: 'committed' as const,
      },
    ]),
    listAbandonedSkillUploadIntents: async () => [
      {
        skillId,
        author,
        fileId: 'file-2',
        source: 'local',
        storageKey: '/uploads/file-2',
        writerId: 'writer',
        state: 'abandoned' as const,
      },
    ],
    listSkillFiles: async () => [
      {
        skillId,
        author,
        file_id: 'file-1',
        filepath: '/uploads/file-1',
        source: 'local',
      },
    ],
  };
  const adapter = createSkillDeletionPersistenceAdapter(source);

  for await (const batch of adapter.iterateSkillCleanupFiles(skillId.toString(), 2)) {
    expect(batch[0].author).toBe(author.toString());
  }
  for await (const batch of adapter.iterateSkillCleanupIntents(skillId.toString(), 2)) {
    expect(batch[0]).toMatchObject({ skillId: skillId.toString(), author: author.toString() });
  }
  expect(await adapter.hasInFlightSkillUploads(skillId.toString())).toBe(false);
  expect(await adapter.listExistingSkillFileIds(skillId.toString(), ['file-1'])).toEqual([
    'file-1',
  ]);
  expect(source.listExistingSkillFileIds).toHaveBeenCalledWith(skillId.toString(), ['file-1']);

  expect(await adapter.beginSkillDeletion(skillId.toString())).toEqual({
    skillId: skillId.toString(),
    completedAt: undefined,
  });
  expect((await adapter.listSkillDeletionTombstones(1))[0].skillId).toBe(skillId.toString());
  expect((await adapter.listSkillUploadIntents(skillId.toString()))[0]).toMatchObject({
    skillId: skillId.toString(),
    author: author.toString(),
    fileId: 'file-1',
  });
  expect(source.listSkillUploadIntents).toHaveBeenCalledWith(skillId.toString(), {
    cleanupOnly: true,
  });
  expect((await adapter.listAbandonedSkillUploadIntents(1))[0].author).toBe(author.toString());
  expect((await adapter.listSkillFiles(skillId.toString()))[0]).toEqual({
    file_id: 'file-1',
    filepath: '/uploads/file-1',
    source: 'local',
    storageKey: undefined,
    storageRegion: undefined,
    author: author.toString(),
    tenantId: undefined,
  });
});
